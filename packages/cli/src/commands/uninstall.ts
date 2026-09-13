import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FlagSpecs, ParsedArgs } from '../cli/args.ts';
import { getBool } from '../cli/args.ts';
import { configDir, configPath, stateDir } from '../core/config.ts';
import { bundledDirectory, platformKey } from '../core/ffmpeg.ts';
import { transcodeDir } from '../core/transcode.ts';
import { bold, dim } from '../ui/color.ts';
import { formatBytes } from '../ui/format.ts';
import * as out from '../ui/out.ts';
import { confirm } from '../ui/prompt.ts';

export const uninstallFlags: FlagSpecs = {
  yes: { type: 'boolean', short: 'y', describe: 'Skip the confirmation' },
  json: { type: 'boolean', describe: 'Emit what was removed as JSON' },
};

interface Target {
  what: string;
  path: string;
  bytes: number;
  exists: boolean;
}

/**
 * Removes everything this CLI has written outside its own install directory.
 *
 * The bundled ffmpeg deliberately lives in `node_modules`, so the package
 * manager takes it away with the CLI. What a package manager will *not* remove
 * is `~/.config/memory-share` — the credentials, the upload journals, the hash
 * cache and any cached video proxies. This command exists so that "uninstall
 * and nothing is left" is actually true, and so the user is told precisely what
 * is going away before it does.
 */
export async function uninstall(args: ParsedArgs): Promise<number> {
  const targets = await gather();
  const present = targets.filter((target) => target.exists);
  const json = getBool(args, 'json');
  out.setJsonMode(json);

  if (present.length === 0) {
    if (json) out.json({ removed: [], bytes: 0 });
    else out.note('Nothing to remove — no memory-share state on this machine.');
    return 0;
  }

  const total = present.reduce((sum, target) => sum + target.bytes, 0);

  if (!json) {
    out.line();
    out.line(bold('This will delete:'));
    for (const target of present) {
      out.line(`  ${target.path}  ${dim(`${target.what}, ${formatBytes(target.bytes)}`)}`);
    }
    out.line();
    out.note('Nothing is deleted from Cloudflare. Your assets, memories and worker stay exactly');
    out.note('as they are — this only clears local credentials and caches.');
    out.line();
  }

  await confirm(`Delete ${formatBytes(total)} of local memory-share state?`, {
    yes: getBool(args, 'yes'),
  });

  const removed: string[] = [];
  for (const target of present) {
    await rm(target.path, { recursive: true, force: true });
    removed.push(target.path);
  }

  if (json) {
    out.json({ removed, bytes: total });
    return 0;
  }

  out.ok(`Removed ${formatBytes(total)}.`);
  out.line();
  out.note('The CLI itself and its bundled ffmpeg live in node_modules; remove them with your');
  out.note(
    'package manager, e.g. `bun unlink` in packages/cli (source install) or `bun remove -g @memory-share/cli`.',
  );
  return 0;
}

async function gather(): Promise<Target[]> {
  const targets: Target[] = [
    { what: 'credentials', path: configPath(), bytes: 0, exists: false },
    { what: 'upload journals and hash cache', path: stateDir(), bytes: 0, exists: false },
    { what: 'cached video proxies', path: transcodeDir(), bytes: 0, exists: false },
    { what: 'config directory', path: configDir(), bytes: 0, exists: false },
  ];
  for (const target of targets) {
    const size = await sizeOf(target.path);
    target.exists = size !== null;
    target.bytes = size ?? 0;
  }
  // The config dir contains the other three; listing them all would double-count,
  // so only the directory is actually removed and it carries the full size.
  const dir = targets[targets.length - 1];
  if (dir?.exists === true) return [dir];
  return targets;
}

async function sizeOf(path: string): Promise<number | null> {
  const info = await stat(path).catch(() => null);
  if (info === null) return null;
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;

  let total = 0;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (entries === null) return 0;
  for (const entry of entries) {
    total += (await sizeOf(join(path, entry.name))) ?? 0;
  }
  return total;
}

/** Where the bundled ffmpeg actually sits, for `ms status` and the README. */
export function bundledLocation(): string | null {
  const key = platformKey();
  return key === null ? null : bundledDirectory(key);
}
