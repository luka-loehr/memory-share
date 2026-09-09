import { stat } from 'node:fs/promises';
import { findTool } from './ffmpeg.ts';

export interface Probed {
  width?: number;
  height?: number;
  duration?: number;
  takenAt?: number;
}

/**
 * Local metadata extraction is a courtesy, never a requirement: derivation is
 * server-side and the worker recomputes everything it needs. So every probe
 * here is best-effort — a missing binary, an unreadable header or a weird
 * container degrades to "we did not learn anything", not to a failed upload.
 */
const available = new Map<string, boolean>();

/**
 * Version flags are not uniform: `exiftool -version` exits 1 ("No file
 * specified") and would look like a missing binary, so each tool is asked in
 * the dialect it actually answers.
 */
const VERSION_FLAG: Record<string, string> = { exiftool: '-ver' };

async function hasBinary(name: string): Promise<boolean> {
  const cached = available.get(name);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const proc = Bun.spawn([name, VERSION_FLAG[name] ?? '--version'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    ok = (await proc.exited) === 0;
  } catch {
    ok = false;
  }
  available.set(name, ok);
  return ok;
}

export async function probeTools(): Promise<{ ffprobe: boolean; exiftool: boolean }> {
  return { ffprobe: (await findTool('ffprobe')) !== null, exiftool: await hasBinary('exiftool') };
}

async function run(command: string[], timeoutMs = 20_000): Promise<string | null> {
  try {
    const proc = Bun.spawn(command, { stdout: 'pipe', stderr: 'ignore' });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return code === 0 ? text : null;
  } catch {
    return null;
  }
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  tags?: Record<string, string>;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; tags?: Record<string, string> };
}

async function probeWithFfprobe(path: string): Promise<Probed> {
  // The bundled ffprobe when there is one, PATH otherwise; never a bare name,
  // so a user with no system ffmpeg still gets dimensions and duration.
  const ffprobe = await findTool('ffprobe');
  if (ffprobe === null) return {};
  const text = await run([
    ffprobe.path,
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    path,
  ]);
  if (text === null) return {};
  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(text) as FfprobeOutput;
  } catch {
    return {};
  }

  const visual = (parsed.streams ?? []).find(
    (stream) => stream.codec_type === 'video' && stream.width && stream.height,
  );
  const out: Probed = {};
  if (visual?.width) out.width = visual.width;
  if (visual?.height) out.height = visual.height;

  const duration = Number(parsed.format?.duration ?? visual?.duration ?? Number.NaN);
  // Stills report a nominal one-frame duration; only real timelines are kept.
  if (Number.isFinite(duration) && duration > 0.05) out.duration = Number(duration.toFixed(3));

  const created = parsed.format?.tags?.creation_time ?? visual?.tags?.creation_time;
  const takenAt = created === undefined ? Number.NaN : Date.parse(created);
  if (Number.isFinite(takenAt)) out.takenAt = Math.floor(takenAt / 1000);
  return out;
}

interface ExifRecord {
  DateTimeOriginal?: string;
  CreateDate?: string;
  ImageWidth?: number;
  ImageHeight?: number;
}

async function probeWithExiftool(path: string): Promise<Probed> {
  if (!(await hasBinary('exiftool'))) return {};
  const text = await run([
    'exiftool',
    '-json',
    '-n',
    '-DateTimeOriginal',
    '-CreateDate',
    '-ImageWidth',
    '-ImageHeight',
    path,
  ]);
  if (text === null) return {};
  let records: ExifRecord[];
  try {
    const parsed: unknown = JSON.parse(text);
    records = Array.isArray(parsed) ? (parsed as ExifRecord[]) : [];
  } catch {
    return {};
  }
  const record = records[0];
  if (record === undefined) return {};

  const out: Probed = {};
  if (record.ImageWidth) out.width = record.ImageWidth;
  if (record.ImageHeight) out.height = record.ImageHeight;
  const stamp = parseExifDate(record.DateTimeOriginal ?? record.CreateDate);
  if (stamp !== null) out.takenAt = stamp;
  return out;
}

/** EXIF writes local time as "2024:07:19 18:04:12" — not ISO, not UTC. */
export function parseExifDate(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (match === null) {
    const fallback = Date.parse(value);
    return Number.isFinite(fallback) ? Math.floor(fallback / 1000) : null;
  }
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const time = date.getTime();
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
}

/**
 * exiftool wins on `takenAt` for photos (it reads the EXIF the camera wrote),
 * ffprobe wins on dimensions and duration for video. Whatever is left over
 * falls back to the file's mtime, which is at least monotonic with reality.
 */
export async function probeFile(path: string, kind: 'photo' | 'video'): Promise<Probed> {
  const [ff, exif] = await Promise.all([
    probeWithFfprobe(path),
    kind === 'photo' ? probeWithExiftool(path) : Promise.resolve<Probed>({}),
  ]);

  const out: Probed = {
    width: exif.width ?? ff.width,
    height: exif.height ?? ff.height,
    duration: kind === 'video' ? ff.duration : undefined,
    takenAt: exif.takenAt ?? ff.takenAt,
  };

  if (out.takenAt === undefined) {
    try {
      const info = await stat(path);
      out.takenAt = Math.floor(info.mtimeMs / 1000);
    } catch {
      // leave it unset; the worker will decide
    }
  }

  for (const key of Object.keys(out) as (keyof Probed)[]) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}
