import type { Config } from './config.ts';
import { ApiError, CliError, EXIT } from './errors.ts';
import type {
  Asset,
  AssetsResponse,
  BeginBody,
  BeginResponse,
  CompleteBody,
  CompleteResponse,
  CreateMemoryBody,
  CreateMemoryResponse,
  DeletedResponse,
  MemoriesResponse,
  Memory,
  MemoryDetailResponse,
  MemoryResponse,
  PartResponse,
  PatchMemoryBody,
  RotateResponse,
  StatusResponse,
  TagResponse,
  UploadPartsResponse,
} from './types.ts';

/** What this CLI ever sends as a request body. Avoids depending on DOM lib types. */
export type RequestBody = string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseDelayMs: 400, maxDelayMs: 15_000 };

/** Full jitter: retries from a hundred parallel parts must not land together. */
export function backoffDelay(attempt: number, policy: RetryPolicy = DEFAULT_RETRY): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableTransportError(error: unknown): boolean {
  if (error instanceof CliError) return false;
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  return error instanceof Error;
}

interface RequestOptions {
  method: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  raw?: RequestBody;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Streaming download; the caller reads the body itself. */
  stream?: boolean;
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly retry: RetryPolicy;

  constructor(
    config: Pick<Config, 'workerUrl' | 'adminToken'>,
    retry: RetryPolicy = DEFAULT_RETRY,
  ) {
    this.baseUrl = config.workerUrl;
    this.token = config.adminToken;
    this.retry = retry;
  }

  private url(path: string, query?: RequestOptions['query']): string {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async fetch(options: RequestOptions): Promise<Response> {
    const target = this.url(options.path, options.query);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
      ...options.headers,
    };
    let body: RequestBody | undefined = options.raw;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < this.retry.attempts; attempt++) {
      if (attempt > 0) await sleep(this.delayFor(attempt - 1, lastError));
      try {
        const response = await fetch(target, {
          method: options.method,
          headers,
          body,
          signal: options.signal,
        });
        if (response.ok) return response;
        if (isRetryableStatus(response.status) && attempt < this.retry.attempts - 1) {
          lastError = response;
          // Drain, or the connection is held open until GC.
          await response.arrayBuffer().catch(() => undefined);
          continue;
        }
        throw new ApiError(options.method, options.path, response.status, await detail(response));
      } catch (error) {
        if (error instanceof CliError) throw error;
        if (!isRetryableTransportError(error) || attempt === this.retry.attempts - 1) {
          throw asNetworkError(error, options.method, options.path);
        }
        lastError = error;
      }
    }
    throw asNetworkError(lastError, options.method, options.path);
  }

  /** Honours Retry-After when the worker sends one, else exponential backoff. */
  private delayFor(attempt: number, lastError: unknown): number {
    if (lastError instanceof Response) {
      const header = lastError.headers.get('retry-after');
      const seconds = header === null ? Number.NaN : Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, this.retry.maxDelayMs);
      }
    }
    return backoffDelay(attempt, this.retry);
  }

  private async json<T>(options: RequestOptions): Promise<T> {
    const response = await this.fetch(options);
    const text = await response.text();
    if (text.trim() === '') return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(
        options.method,
        options.path,
        response.status,
        'response was not JSON (is the worker URL right?)',
      );
    }
  }

  // ------------------------------------------------------------- upload ----

  beginUpload(body: BeginBody): Promise<BeginResponse> {
    return this.json<BeginResponse>({ method: 'POST', path: '/api/admin/upload/begin', body });
  }

  uploadPart(
    uploadId: string,
    part: number,
    bytes: RequestBody,
    signal?: AbortSignal,
  ): Promise<PartResponse> {
    return this.json<PartResponse>({
      method: 'PUT',
      path: '/api/admin/upload/part',
      query: { uploadId, part },
      raw: bytes,
      headers: { 'content-type': 'application/octet-stream' },
      signal,
    });
  }

  /**
   * What the worker already has for this multipart session. Makes resume a
   * property of the system rather than of one laptop's journal: a re-run from
   * another machine, or after the local state is gone, still skips sent parts.
   */
  listUploadParts(uploadId: string): Promise<UploadPartsResponse> {
    return this.json<UploadPartsResponse>({
      method: 'GET',
      path: `/api/admin/upload/${encodeURIComponent(uploadId)}/parts`,
    });
  }

  completeUpload(body: CompleteBody): Promise<CompleteResponse> {
    return this.json<CompleteResponse>({
      method: 'POST',
      path: '/api/admin/upload/complete',
      body,
    });
  }

  // ------------------------------------------------------------- assets ----

  listAssets(query: {
    tag?: string;
    kind?: string;
    limit?: number;
    cursor?: string;
  }): Promise<AssetsResponse> {
    return this.json<AssetsResponse>({ method: 'GET', path: '/api/admin/assets', query });
  }

  /** Walks `cursor` to exhaustion; every read command wants the whole page set. */
  async listAllAssets(
    query: { tag?: string; kind?: string; limit?: number } = {},
    onPage?: (total: number) => void,
  ): Promise<Asset[]> {
    const all: Asset[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10_000; guard++) {
      const page = await this.listAssets({ ...query, cursor });
      all.push(...(page.assets ?? []));
      onPage?.(all.length);
      cursor = page.cursor;
      if (!cursor) break;
    }
    return all;
  }

  /**
   * The owner's read path. Range-aware, so `ms download` resumes from the bytes
   * already on disk without unlocking a memory or minting a throwaway one.
   */
  async assetBytes(
    id: string,
    variant: 'orig' | 'view',
    from = 0,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (from > 0) headers.range = `bytes=${from}-`;
    return await this.fetch({
      method: 'GET',
      path: `/api/admin/assets/${encodeURIComponent(id)}/bytes`,
      query: { variant },
      headers,
      signal,
      stream: true,
    });
  }

  tagAssets(assetIds: string[], add: string[], remove: string[]): Promise<TagResponse> {
    return this.json<TagResponse>({
      method: 'POST',
      path: '/api/admin/assets/tag',
      body: { assetIds, add, remove },
    });
  }

  deleteAsset(id: string): Promise<DeletedResponse> {
    return this.json<DeletedResponse>({
      method: 'DELETE',
      path: `/api/admin/assets/${encodeURIComponent(id)}`,
    });
  }

  // ----------------------------------------------------------- memories ----

  async listMemories(): Promise<Memory[]> {
    const response = await this.json<MemoriesResponse>({
      method: 'GET',
      path: '/api/admin/memories',
    });
    return response.memories ?? [];
  }

  /** Full membership for one memory, which the list endpoint does not carry. */
  getMemory(slug: string): Promise<MemoryDetailResponse> {
    return this.json<MemoryDetailResponse>({
      method: 'GET',
      path: `/api/admin/memories/${encodeURIComponent(slug)}`,
    });
  }

  createMemory(body: CreateMemoryBody): Promise<CreateMemoryResponse> {
    return this.json<CreateMemoryResponse>({ method: 'POST', path: '/api/admin/memories', body });
  }

  patchMemory(slug: string, body: PatchMemoryBody): Promise<MemoryResponse> {
    return this.json<MemoryResponse>({
      method: 'PATCH',
      path: `/api/admin/memories/${encodeURIComponent(slug)}`,
      body,
    });
  }

  rotateMemory(slug: string): Promise<RotateResponse> {
    return this.json<RotateResponse>({
      method: 'POST',
      path: `/api/admin/memories/${encodeURIComponent(slug)}/rotate`,
    });
  }

  deleteMemory(slug: string): Promise<DeletedResponse> {
    return this.json<DeletedResponse>({
      method: 'DELETE',
      path: `/api/admin/memories/${encodeURIComponent(slug)}`,
    });
  }

  status(): Promise<StatusResponse> {
    return this.json<StatusResponse>({ method: 'GET', path: '/api/admin/status' });
  }
}

async function detail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (text === '') return '';
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && 'error' in parsed) {
        return String((parsed as { error: unknown }).error);
      }
    } catch {
      // fall through to the raw body
    }
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return '';
  }
}

function asNetworkError(error: unknown, method: string, path: string): CliError {
  const reason = error instanceof Error ? error.message : String(error);
  return new CliError(`${method} ${path} could not reach the worker: ${reason}`, {
    code: EXIT.network,
    hint: 'Check your connection and that the worker URL in `ms login` is current.',
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
