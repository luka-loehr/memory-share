import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FlagSpecs, ParsedArgs } from '../cli/args.ts';
import { getBool, getList, getNumber, getString } from '../cli/args.ts';
import { ApiClient } from '../core/api.ts';
import { loadConfig } from '../core/config.ts';
import { CliError, EXIT, UsageError } from '../core/errors.ts';
import { hashFile } from '../core/hash.ts';
import { assertSlug, normalizeTag } from '../core/parse.ts';
import type { Asset } from '../core/types.ts';
import { mapPool } from '../core/walk.ts';
import { bold, dim } from '../ui/color.ts';
import { countAndSize, formatBytes, formatDuration, formatRate } from '../ui/format.ts';
import * as out from '../ui/out.ts';
import { Progress } from '../ui/progress.ts';

export const downloadFlags: FlagSpecs = {
  tag: { type: 'list', short: 't', describe: 'Download every asset carrying this tag' },
  variant: { type: 'string', describe: 'orig (default) or view, the 1080p proxy' },
  concurrency: { type: 'number', short: 'c', describe: 'Parallel downloads (default 4)' },
  verify: { type: 'boolean', describe: 'Re-hash each original after writing (default on)' },
  json: { type: 'boolean', describe: 'Emit a machine-readable summary' },
};

interface Result {
  id: string;
  filename: string;
  path: string;
  bytes: number;
  status: 'downloaded' | 'skipped' | 'failed' | 'corrupt';
  error?: string;
}

/**
 * Pulls bytes back out through the owner API.
 *
 * The owner reads via `/api/admin/assets/:id/bytes`, never through a share:
 * unlocking one's own album with its own password, or minting a throwaway
 * memory to read a tag, would write `access_log` rows for what is conceptually
 * a read and confuse "was this link ever opened".
 */
export async function download(args: ParsedArgs): Promise<number> {
  const json = getBool(args, 'json');
  out.setJsonMode(json);

  const variant = assertVariant(getString(args, 'variant'));
  const tags = getList(args, 'tag').map(normalizeTag);
  const positionals = [...args.positionals];
  const dir = positionals.pop();
  if (dir === undefined) {
    throw new UsageError('ms download <slug|--tag x> <dir> — no directory given.');
  }
  const slugArg = positionals.pop();

  if (tags.length === 0 && slugArg === undefined) {
    throw new UsageError('Give a memory slug or at least one --tag.');
  }
  if (tags.length > 0 && slugArg !== undefined) {
    throw new UsageError('Give a slug or --tag, not both.');
  }

  const target = resolve(dir);
  await mkdir(target, { recursive: true });
  const client = new ApiClient(await loadConfig());

  let assets: Asset[];
  let label: string;
  if (slugArg !== undefined) {
    const slug = assertSlug(slugArg);
    const detail = await client.getMemory(slug);
    assets = detail.items ?? [];
    label = detail.memory?.title ?? slug;
  } else {
    const seen = new Map<string, Asset>();
    for (const name of tags) {
      for (const asset of await client.listAllAssets({ tag: name })) seen.set(asset.id, asset);
    }
    assets = [...seen.values()];
    label = `tag ${tags.join(' + ')}`;
  }

  if (assets.length === 0) {
    out.note(`${label} has nothing to download.`);
    return 0;
  }

  if (variant === 'view') {
    // Most photos store no view at all — the edge renders those on the fly —
    // so membership here follows view_key rather than kind.
    const before = assets.length;
    assets = assets.filter((asset) => hasStoredView(asset));
    if (assets.length === 0) {
      out.note('None of those assets has a stored view; photos are rendered by the edge.');
      return 0;
    }
    if (assets.length < before) {
      out.note(`${before - assets.length} without a stored view skipped.`);
    }
  }

  const verify = variant === 'orig' && getBool(args, 'verify', true);
  const concurrency = Math.max(1, Math.min(16, getNumber(args, 'concurrency', 4)));
  const totalBytes = assets.reduce((sum, asset) => sum + (asset.bytes ?? 0), 0);

  if (!json) {
    out.line();
    out.note(`${bold(label)} — ${countAndSize(assets.length, totalBytes)} into ${target}`);
    if (!verify && variant === 'view') {
      out.note('Proxies are not hash-verified: a derivative does not hash to the asset id.');
    }
  }

  const progress = new Progress({
    verb: 'Downloading',
    totalFiles: assets.length,
    totalBytes,
    tty: json ? false : undefined,
  });

  const results: Result[] = [];
  try {
    await mapPool(assets, concurrency, async (asset) => {
      results.push(await downloadOne(client, asset, variant, target, progress, verify));
    });
  } finally {
    progress.stop();
  }

  const downloaded = results.filter((result) => result.status === 'downloaded');
  const skipped = results.filter((result) => result.status === 'skipped');
  const failed = results.filter((result) => result.status === 'failed');
  const corrupt = results.filter((result) => result.status === 'corrupt');
  const summary = progress.summary();

  if (json) {
    out.json({
      source: label,
      variant,
      dir: target,
      downloaded: downloaded.length,
      skipped: skipped.length,
      failed: failed.length,
      corrupt: corrupt.length,
      files: results,
    });
    return corrupt.length > 0 ? EXIT.integrity : failed.length > 0 ? EXIT.api : 0;
  }

  out.line();
  if (downloaded.length > 0) {
    const bytes = downloaded.reduce((sum, result) => sum + result.bytes, 0);
    out.ok(
      `${countAndSize(downloaded.length, bytes)} in ${formatDuration(summary.seconds)} ${dim(
        `(${formatRate(summary.rate)})`,
      )}`,
    );
  }
  if (skipped.length > 0) out.line(dim(`${skipped.length} already on disk and verified, skipped`));

  for (const result of corrupt) {
    out.fail(`CHECKSUM MISMATCH — ${result.filename} does not hash to ${result.id.slice(0, 12)}.`);
  }
  if (corrupt.length > 0) {
    out.hint('The bad files were left in place with a .corrupt suffix so you can inspect them.');
  }
  for (const result of failed) out.fail(`${result.filename}: ${result.error ?? 'unknown error'}`);
  if (failed.length > 0) {
    out.hint('Re-run the command; finished files are skipped and partials resume.');
  }

  if (corrupt.length > 0) return EXIT.integrity;
  return failed.length > 0 ? EXIT.api : 0;
}

/**
 * A stored view exists for a transcoded video and for a photo too large for the
 * Images binding. A video marked view_is_original has one too — it is the
 * original itself.
 */
export function hasStoredView(asset: Asset): boolean {
  if (typeof asset.view_key === 'string' && asset.view_key !== '') return true;
  return asset.kind === 'video' && asset.derive_state !== 'failed';
}

function assertVariant(value: string | undefined): 'orig' | 'view' {
  if (value === undefined) return 'orig';
  const variant = value.trim().toLowerCase();
  if (variant === 'orig' || variant === 'view') return variant;
  throw new UsageError(`--variant takes orig or view, not "${value}".`);
}

/**
 * One file, resumable and verified.
 *
 * Bytes land in a `.part` file that is renamed into place only once the digest
 * matches the asset id — the id *is* the sha256 of the original, so a truncated
 * or corrupted transfer can never masquerade as a finished download.
 */
async function downloadOne(
  client: ApiClient,
  asset: Asset,
  variant: 'orig' | 'view',
  target: string,
  progress: Progress,
  verify: boolean,
): Promise<Result> {
  const filename = safeFilename(asset, variant);
  const finalPath = join(target, filename);
  const partPath = `${finalPath}.part`;
  const expected = variant === 'orig' ? (asset.bytes ?? 0) : 0;
  const base: Omit<Result, 'status'> = {
    id: asset.id,
    filename,
    path: finalPath,
    bytes: expected,
  };

  try {
    progress.start(asset.id, filename, expected);

    const existing = await sizeOf(finalPath);
    if (existing !== null && (expected === 0 || existing === expected)) {
      if (!verify || (await hashFile(finalPath)).sha256 === asset.id) {
        progress.advance(asset.id, existing);
        progress.finish(asset.id, 'skipped', filename, 'already here');
        return { ...base, bytes: existing, status: 'skipped' };
      }
      await rm(finalPath, { force: true });
    }

    const resumeFrom = (await sizeOf(partPath)) ?? 0;
    if (resumeFrom > 0) {
      progress.advance(asset.id, resumeFrom);
      progress.log(dim(`  resuming ${filename} from ${resumeFrom} bytes`));
    }

    const response = await client.assetBytes(asset.id, variant, resumeFrom);
    const append = resumeFrom > 0 && response.status === 206;
    if (resumeFrom > 0 && !append) progress.advance(asset.id, -resumeFrom);

    const body = response.body;
    if (body === null) throw new CliError('The worker sent an empty body.', { code: EXIT.api });

    const sink = createWriteStream(partPath, { flags: append ? 'a' : 'w' });
    const counted = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        progress.advance(asset.id, chunk.byteLength);
        controller.enqueue(chunk);
      },
    });
    await pipeline(streamToNode(body.pipeThrough(counted)), sink);

    if (verify) {
      const { sha256 } = await hashFile(partPath);
      if (sha256 !== asset.id) {
        await rename(partPath, `${finalPath}.corrupt`).catch(() => undefined);
        progress.finish(asset.id, 'failed', filename, 'checksum mismatch');
        return { ...base, status: 'corrupt', error: `expected ${asset.id}, got ${sha256}` };
      }
    }

    await rename(partPath, finalPath);
    // A proxy's size is not the asset's size, so the summary reports what was
    // actually written rather than what the row claimed.
    const written = (await sizeOf(finalPath)) ?? expected;
    progress.finish(asset.id, 'downloaded', filename, formatBytes(written));
    return { ...base, bytes: written, status: 'downloaded' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    progress.finish(asset.id, 'failed', filename, message);
    return { ...base, status: 'failed', error: message };
  }
}

/**
 * Filenames come off other people's devices, so they are treated as hostile:
 * no separators, no traversal, and a hash suffix so two assets that share a
 * name cannot overwrite one another.
 */
function safeFilename(asset: Asset, variant: 'orig' | 'view'): string {
  const raw = (asset.filename ?? asset.id).replace(/[/\\]/g, '_').replace(/^\.+/, '');
  const cleaned = raw.trim() === '' ? asset.id : raw;
  const short = asset.id.slice(0, 8);
  if (variant === 'view') {
    const stored = typeof asset.view_key === 'string' ? extname(asset.view_key) : '';
    const ext = stored !== '' ? stored : asset.kind === 'video' ? '.mp4' : '.jpg';
    return `${basename(cleaned, extname(cleaned))}-${short}.view${ext}`;
  }
  const ext = extname(cleaned);
  return `${basename(cleaned, ext)}-${short}${ext}`;
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

function streamToNode(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value !== undefined) yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
