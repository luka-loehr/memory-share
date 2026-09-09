import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissingFile, stateDir } from './config.ts';
import type { Plan } from './hash.ts';
import type { UploadedPart } from './types.ts';

/**
 * What survives an interrupted `ms upload`. Written after every completed part,
 * so killing the process mid-3.5 GB video costs at most one part on the retry.
 */
export interface Journal {
  sha256: string;
  path: string;
  bytes: number;
  mtimeMs: number;
  assetId: string;
  uploadId: string;
  partSize: number;
  parts: UploadedPart[];
  updatedAt: number;
}

export type Decision =
  | { action: 'skip'; reason: 'already-in-pool' }
  | { action: 'resume'; uploadId: string; done: UploadedPart[]; remaining: number[] }
  | { action: 'upload' };

export interface DecisionInput {
  /** `exists:true` from upload/begin — the bytes are already in R2. */
  remoteExists: boolean;
  uploadId: string | undefined;
  journal: Journal | null;
  plan: Plan;
  sha256: string;
  bytes: number;
  mtimeMs: number;
}

/**
 * The whole resume policy, as one pure function.
 *
 * The remote `exists` flag always wins: content-addressed storage means a file
 * already in the pool is a no-op no matter what our local journal thinks. A
 * journal is only trusted when it describes *this* file (same hash, size and
 * mtime), the same upload session, and the same part geometry — a different
 * `--part-size` invalidates every recorded etag, so those parts are re-sent
 * rather than stitched into a mismatched object.
 */
export function decideUpload(input: DecisionInput): Decision {
  if (input.remoteExists) return { action: 'skip', reason: 'already-in-pool' };

  const journal = input.journal;
  const all = input.plan.parts.map((part) => part.partNumber);
  if (
    journal === null ||
    input.uploadId === undefined ||
    journal.uploadId !== input.uploadId ||
    journal.sha256 !== input.sha256 ||
    journal.bytes !== input.bytes ||
    journal.mtimeMs !== input.mtimeMs ||
    journal.partSize !== input.plan.partSize
  ) {
    return { action: 'upload' };
  }

  const valid = journal.parts.filter(
    (part) => all.includes(part.partNumber) && typeof part.etag === 'string' && part.etag !== '',
  );
  if (valid.length === 0) return { action: 'upload' };

  const doneNumbers = new Set(valid.map((part) => part.partNumber));
  return {
    action: 'resume',
    uploadId: journal.uploadId,
    done: [...valid].sort((a, b) => a.partNumber - b.partNumber),
    remaining: all.filter((number) => !doneNumbers.has(number)),
  };
}

// --------------------------------------------------------------- storage ----

function journalPath(sha256: string): string {
  return join(stateDir(), `${sha256}.json`);
}

export async function readJournal(sha256: string): Promise<Journal | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(journalPath(sha256), 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const journal = parsed as Journal;
    return Array.isArray(journal.parts) ? journal : null;
  } catch (error) {
    if (isMissingFile(error)) return null;
    return null;
  }
}

export async function writeJournal(journal: Journal): Promise<void> {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify({ ...journal, updatedAt: Date.now() })}\n`;
  await writeFile(journalPath(journal.sha256), body, { mode: 0o600, encoding: 'utf8' });
}

export async function clearJournal(sha256: string): Promise<void> {
  await rm(journalPath(sha256), { force: true });
}

/** Journals older than a fortnight describe multipart sessions R2 has expired. */
export async function pruneJournals(maxAgeMs = 14 * 86_400_000): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(stateDir());
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'hashes.json') continue;
    const journal = await readJournal(name.slice(0, -5));
    if (journal === null || journal.updatedAt < cutoff) {
      await rm(join(stateDir(), name), { force: true });
      removed++;
    }
  }
  return removed;
}

// ------------------------------------------------------------ hash cache ----

type HashCache = Record<string, { sha256: string; at: number }>;

function cachePath(): string {
  return join(stateDir(), 'hashes.json');
}

/** Keyed on identity *and* mutation: an edited file rehashes. */
export function hashCacheKey(path: string, bytes: number, mtimeMs: number): string {
  return `${path} ${bytes} ${Math.floor(mtimeMs)}`;
}

export async function loadHashCache(): Promise<Map<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(cachePath(), 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return new Map();
    return new Map(Object.entries(parsed as HashCache).map(([key, value]) => [key, value.sha256]));
  } catch {
    return new Map();
  }
}

export async function saveHashCache(cache: Map<string, string>): Promise<void> {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  const now = Date.now();
  const out: HashCache = {};
  // Bounded, so the cache cannot grow without limit across years of use.
  for (const [key, sha256] of [...cache].slice(-20_000)) out[key] = { sha256, at: now };
  await writeFile(cachePath(), `${JSON.stringify(out)}\n`, { mode: 0o600, encoding: 'utf8' });
}
