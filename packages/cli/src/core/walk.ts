import { readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { CliError, EXIT } from './errors.ts';
import { isMediaFile } from './hash.ts';

export interface WalkedFile {
  path: string;
  name: string;
  bytes: number;
  mtimeMs: number;
}

export interface WalkOptions {
  /** Non-media extensions are skipped by default; --all keeps everything. */
  all?: boolean;
  followSymlinks?: boolean;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.Trash', '.DS_Store', '@eaDir']);

/**
 * Expands the paths given on the command line into a stable, de-duplicated file
 * list. Directories recurse; a file named explicitly is always taken, even if
 * its extension is not a recognised media type, because naming it is intent.
 */
export async function walkPaths(
  inputs: readonly string[],
  options: WalkOptions = {},
): Promise<WalkedFile[]> {
  const seen = new Map<string, WalkedFile>();

  for (const input of inputs) {
    const path = resolve(input);
    const info = await stat(path).catch(() => null);
    if (info === null) {
      throw new CliError(`No such file or directory: ${input}`, { code: EXIT.usage });
    }
    if (info.isDirectory()) {
      await walkDirectory(path, seen, options);
    } else if (info.isFile()) {
      seen.set(path, { path, name: basename(path), bytes: info.size, mtimeMs: info.mtimeMs });
    }
  }

  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function walkDirectory(
  dir: string,
  seen: Map<string, WalkedFile>,
  options: WalkOptions,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return;

  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);

    if (entry.isDirectory()) {
      await walkDirectory(path, seen, options);
      continue;
    }
    if (entry.isSymbolicLink() && options.followSymlinks !== true) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (options.all !== true && !isMediaFile(name)) continue;

    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      seen.set(path, { path, name, bytes: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // unreadable entry; nothing to upload
    }
  }
}

/**
 * Runs `worker` over `items` with at most `limit` in flight. Order of
 * completion is not preserved; results come back in input order.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let cursor = 0;
  let firstError: unknown = null;

  const runners = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length || firstError !== null) return;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = await worker(item, index);
      } catch (error) {
        firstError ??= error;
        return;
      }
    }
  });

  await Promise.all(runners);
  if (firstError !== null) throw firstError;
  return results;
}
