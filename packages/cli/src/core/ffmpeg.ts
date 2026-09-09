import { access, constants } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { CliError, EXIT } from './errors.ts';

/**
 * ffmpeg resolution.
 *
 * The requirement is that the CLI is the only thing the user installs, and that
 * uninstalling it leaves nothing behind. That rules out downloading a binary
 * into ~/.cache, ~/.local or /tmp at first run: those survive `npm rm -g` and
 * the user has no idea they are there. So the binaries ship as *optional
 * dependencies*, one package per platform — the pattern esbuild and sharp use —
 * and live inside node_modules, which the package manager removes with the CLI.
 *
 * Order: an explicit override, then the bundled package for this platform, then
 * whatever is on PATH. Never a silent skip.
 */

export type ToolName = 'ffmpeg' | 'ffprobe';

export const PLATFORM_KEYS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
] as const;

export type PlatformKey = (typeof PLATFORM_KEYS)[number];

export type ToolSource = 'override' | 'bundled' | 'system';

export interface ResolvedTool {
  name: ToolName;
  path: string;
  source: ToolSource;
  /** The package the binary came from, when it was bundled. */
  packageName?: string;
}

/** Node's `arch` for 64-bit Intel is `x64`; everything else maps straight over. */
export function platformKey(
  platform: string = process.platform,
  arch: string = process.arch,
): PlatformKey | null {
  const key = `${platform}-${arch}`;
  return (PLATFORM_KEYS as readonly string[]).includes(key) ? (key as PlatformKey) : null;
}

export function packageNameFor(key: PlatformKey): string {
  return `@memory-share/ffmpeg-${key}`;
}

export function binaryName(name: ToolName, platform: string = process.platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

function overrideFor(name: ToolName): string | undefined {
  const value = name === 'ffmpeg' ? process.env.MS_FFMPEG_PATH : process.env.MS_FFPROBE_PATH;
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locates the platform package without importing it. `resolve` is used on the
 * package's own package.json rather than a bin path, because the bin is not an
 * export and Node would refuse to resolve it.
 */
export function bundledDirectory(key: PlatformKey): string | null {
  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve(`${packageNameFor(key)}/package.json`));
  } catch {
    return null;
  }
}

export async function bundledPath(name: ToolName, key: PlatformKey): Promise<string | null> {
  const dir = bundledDirectory(key);
  if (dir === null) return null;
  const path = join(dir, 'bin', binaryName(name, key.split('-')[0]));
  return (await isExecutable(path)) ? path : null;
}

/** `which`, without shelling out to `which`. */
export async function systemPath(name: ToolName): Promise<string | null> {
  const binary = binaryName(name);
  const entries = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  for (const entry of entries) {
    if (entry === '') continue;
    const candidate = join(entry, binary);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

const cache = new Map<ToolName, ResolvedTool>();

export async function findTool(name: ToolName): Promise<ResolvedTool | null> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const override = overrideFor(name);
  if (override !== undefined && (await isExecutable(override))) {
    const tool: ResolvedTool = { name, path: override, source: 'override' };
    cache.set(name, tool);
    return tool;
  }

  const key = platformKey();
  if (key !== null) {
    const path = await bundledPath(name, key);
    if (path !== null) {
      const tool: ResolvedTool = {
        name,
        path,
        source: 'bundled',
        packageName: packageNameFor(key),
      };
      cache.set(name, tool);
      return tool;
    }
  }

  const system = await systemPath(name);
  if (system !== null) {
    const tool: ResolvedTool = { name, path: system, source: 'system' };
    cache.set(name, tool);
    return tool;
  }
  return null;
}

/**
 * Same as `findTool`, but a miss is fatal and says exactly why — naming the
 * platform, because "ffmpeg not found" on an unsupported architecture sends
 * people hunting for a PATH problem that does not exist.
 */
export async function requireTool(name: ToolName): Promise<ResolvedTool> {
  const tool = await findTool(name);
  if (tool !== null) return tool;

  const key = platformKey();
  const platform = `${process.platform}-${process.arch}`;
  if (key === null) {
    throw new CliError(`No bundled ${name} for ${platform}, and none on PATH.`, {
      code: EXIT.external,
      hint: `memory-share ships binaries for ${PLATFORM_KEYS.join(', ')}. On ${platform}, install ffmpeg yourself (it needs ffmpeg and ffprobe on PATH) and re-run.`,
    });
  }
  throw new CliError(`The bundled ${name} for ${platform} is missing, and there is none on PATH.`, {
    code: EXIT.external,
    hint: `Reinstall the CLI so ${packageNameFor(key)} is fetched, or install ffmpeg system-wide. Optional dependencies are skipped entirely when a package manager runs with --no-optional.`,
  });
}

/** For `ms status` and the upload preamble, so the source is never a mystery. */
export async function describeTools(): Promise<
  { name: ToolName; path: string | null; source: ToolSource | null }[]
> {
  const out: { name: ToolName; path: string | null; source: ToolSource | null }[] = [];
  for (const name of ['ffmpeg', 'ffprobe'] as const) {
    const tool = await findTool(name);
    out.push({ name, path: tool?.path ?? null, source: tool?.source ?? null });
  }
  return out;
}

export function clearToolCache(): void {
  cache.clear();
}

// -------------------------------------------------------------- encoders ----

export type H264Encoder = 'h264_videotoolbox' | 'h264_nvenc' | 'libx264';

/**
 * Reads `ffmpeg -encoders` rather than assuming. A Mac without VideoToolbox and
 * a Linux box whose ffmpeg was built without nvenc both exist, and guessing
 * wrong means every encode fails with an unhelpful ffmpeg error.
 */
export async function listEncoders(ffmpegPath: string): Promise<Set<string>> {
  try {
    const proc = Bun.spawn([ffmpegPath, '-hide_banner', '-encoders'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return new Set();
    return parseEncoders(text);
  } catch {
    return new Set();
  }
}

/** Lines look like " V....D h264_videotoolbox     VideoToolbox H.264 Encoder". */
export function parseEncoders(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split('\n')) {
    const match = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return names;
}

/**
 * Hardware where it exists, libx264 otherwise. VideoToolbox and NVENC are far
 * faster and produce a proxy that is perfectly good for streaming; libx264 is
 * the correctness floor that exists everywhere.
 */
export function pickEncoder(
  available: ReadonlySet<string>,
  platform: string = process.platform,
): H264Encoder {
  if (platform === 'darwin' && available.has('h264_videotoolbox')) return 'h264_videotoolbox';
  if (platform !== 'darwin' && available.has('h264_nvenc')) return 'h264_nvenc';
  return 'libx264';
}

export function isHardware(encoder: H264Encoder): boolean {
  return encoder !== 'libx264';
}
