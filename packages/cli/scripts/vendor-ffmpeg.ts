#!/usr/bin/env bun
/**
 * Populates `packages/ffmpeg-<platform>/bin` with static ffmpeg + ffprobe.
 *
 * Run at release time, not at install time and never at first run: the binaries
 * have to end up inside the package directory so that uninstalling the CLI
 * removes them. Downloading into a cache under $HOME would leave hundreds of
 * megabytes behind after `npm rm -g`, which is precisely what this design is
 * avoiding.
 *
 *   bun run scripts/vendor-ffmpeg.ts --platform darwin-arm64
 *   bun run scripts/vendor-ffmpeg.ts --all
 *   bun run scripts/vendor-ffmpeg.ts --platform darwin-arm64 --from-path
 *
 * `--from-path` copies the host's own ffmpeg instead of downloading one. It is
 * for development and for verifying that runtime resolution works; the result
 * is host-linked and must not be published.
 */
import { chmod, copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PLATFORM_KEYS, type PlatformKey, binaryName, systemPath } from '../src/core/ffmpeg.ts';

interface Source {
  url: string;
  /** How the archive is laid out, so the two binaries can be found inside it. */
  archive: 'tar.xz' | 'zip';
  /** Separate archives per binary (evermeet), or one containing both. */
  ffprobeUrl?: string;
  note: string;
}

/**
 * Upstream static builds. Deliberately a plain table: when a URL rots, this is
 * the only thing that needs editing, and the failure is a loud 404 at release
 * time rather than a broken install for a user.
 */
const SOURCES: Record<PlatformKey, Source> = {
  'linux-x64': {
    url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
    archive: 'tar.xz',
    note: 'John Van Sickle static build, glibc, includes ffprobe',
  },
  'linux-arm64': {
    url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz',
    archive: 'tar.xz',
    note: 'John Van Sickle static build, glibc, includes ffprobe',
  },
  'darwin-x64': {
    url: 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip',
    ffprobeUrl: 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip',
    archive: 'zip',
    note: 'evermeet.cx static build; ffmpeg and ffprobe ship separately',
  },
  'darwin-arm64': {
    url: 'https://www.osxexperts.net/ffmpeg711arm.zip',
    ffprobeUrl: 'https://www.osxexperts.net/ffprobe711arm.zip',
    archive: 'zip',
    note: 'OSXExperts arm64 static build; ffmpeg and ffprobe ship separately',
  },
  'win32-x64': {
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    archive: 'zip',
    note: 'gyan.dev release-essentials, includes ffprobe.exe under bin/',
  },
};

const ROOT = resolve(dirname(Bun.fileURLToPath(import.meta.url)), '../../..');

function packageBin(key: PlatformKey): string {
  return join(ROOT, 'packages', `ffmpeg-${key}`, 'bin');
}

async function run(command: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(command, { cwd, stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${command[0]} exited ${code}`);
}

/** Finds a named binary anywhere inside an extracted archive tree. */
async function findIn(dir: string, name: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return null;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findIn(path, name);
      if (found !== null) return found;
    } else if (entry.name === name) {
      return path;
    }
  }
  return null;
}

async function download(url: string, into: string): Promise<string> {
  process.stderr.write(`  fetching ${url}\n`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  const file = join(into, url.endsWith('.tar.xz') ? 'archive.tar.xz' : 'archive.zip');
  await Bun.write(file, await response.arrayBuffer());
  return file;
}

async function extract(archive: string, into: string, kind: Source['archive']): Promise<void> {
  if (kind === 'tar.xz') await run(['tar', '-xJf', archive, '-C', into], into);
  else await run(['unzip', '-oq', archive, '-d', into], into);
}

async function vendorFromPath(key: PlatformKey): Promise<void> {
  const bin = packageBin(key);
  await mkdir(bin, { recursive: true });
  for (const name of ['ffmpeg', 'ffprobe'] as const) {
    const source = await systemPath(name);
    if (source === null) throw new Error(`no ${name} on PATH to copy`);
    const target = join(bin, binaryName(name, key.split('-')[0]));
    await copyFile(source, target);
    await chmod(target, 0o755);
    process.stderr.write(`  ${name} ← ${source}\n`);
  }
  await writeProvenance(key, { from: 'host PATH', publishable: false });
}

async function vendorFromUpstream(key: PlatformKey): Promise<void> {
  const source = SOURCES[key];
  const bin = packageBin(key);
  const scratch = join(bin, '.staging');
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });

  try {
    const os = key.split('-')[0] as string;
    const wanted = [
      { name: 'ffmpeg' as const, url: source.url },
      { name: 'ffprobe' as const, url: source.ffprobeUrl ?? source.url },
    ];
    const extracted = new Map<string, string>();

    for (const { name, url } of wanted) {
      if (!extracted.has(url)) {
        const dir = join(scratch, `a${extracted.size}`);
        await mkdir(dir, { recursive: true });
        await extract(await download(url, dir), dir, source.archive);
        extracted.set(url, dir);
      }
      const dir = extracted.get(url) as string;
      const found = await findIn(dir, binaryName(name, os));
      if (found === null) throw new Error(`${binaryName(name, os)} not found inside ${url}`);
      const target = join(bin, binaryName(name, os));
      await copyFile(found, target);
      await chmod(target, 0o755);
      const size = (await stat(target)).size;
      process.stderr.write(`  ${name} ${(size / 1024 / 1024).toFixed(1)} MB\n`);
    }
    await writeProvenance(key, { from: source.url, note: source.note, publishable: true });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function writeProvenance(key: PlatformKey, extra: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(packageBin(key), 'PROVENANCE.json'),
    `${JSON.stringify({ platform: key, vendoredAt: new Date().toISOString(), ...extra }, null, 2)}\n`,
    'utf8',
  );
}

const argv = process.argv.slice(2);
const fromPath = argv.includes('--from-path');
const all = argv.includes('--all');
const requested = argv.includes('--platform') ? argv[argv.indexOf('--platform') + 1] : undefined;

const targets: PlatformKey[] = all
  ? [...PLATFORM_KEYS]
  : requested !== undefined && (PLATFORM_KEYS as readonly string[]).includes(requested)
    ? [requested as PlatformKey]
    : [];

if (targets.length === 0) {
  process.stderr.write(
    `usage: vendor-ffmpeg.ts --platform <${PLATFORM_KEYS.join('|')}> | --all [--from-path]\n`,
  );
  process.exit(2);
}

let failed = 0;
for (const key of targets) {
  process.stderr.write(`${key}\n`);
  try {
    if (fromPath) await vendorFromPath(key);
    else await vendorFromUpstream(key);
  } catch (error) {
    failed++;
    process.stderr.write(`  FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
process.exit(failed > 0 ? 1 : 0);
