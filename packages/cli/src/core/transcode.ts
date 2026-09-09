import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from './config.ts';
import { CliError, EXIT } from './errors.ts';
import { type H264Encoder, isHardware, listEncoders, pickEncoder, requireTool } from './ffmpeg.ts';

/**
 * Local video transcoding.
 *
 * The contract puts the heavy work here rather than on the worker: the machine
 * that already holds the footage encodes a browser-playable proxy once, and the
 * deployed side stays pure storage. Everything in this module is therefore
 * about being a good citizen on someone's laptop — bounded parallelism, honest
 * progress, resumable output, and a failure that costs one video rather than a
 * whole evening's import.
 */

/** The proxy ceiling. 1080p is what the share page plays; more is wasted bytes. */
export const MAX_VIEW_WIDTH = 1920;
export const MAX_VIEW_HEIGHT = 1080;

/** Frame 0 of phone video is usually motion-blurred mid-lift. */
export const POSTER_OFFSET_SECONDS = 1.5;

/**
 * The Cloudflare Images binding refuses inputs above 20 MB, so a photo larger
 * than this cannot be transformed at read time and the share page would have
 * nothing to show for it.
 *
 * Deliberately the decimal 20 MB rather than 20 MiB. Erring small means a file
 * in the 20.0–20.97 MB band gets a view rendition it might not have needed,
 * which costs a few hundred kilobytes. Erring large would mean a file the edge
 * actually rejects has no view at all — and the server's only safe response to
 * that is 415, because serving the original instead would hand a full-quality
 * download to a memory whose whole point is `allow_download = 0`.
 */
export const IMAGES_MAX_BYTES = 20_000_000;

/** The longest edge of a view rendition, matching what the edge would produce. */
export const MAX_PHOTO_VIEW_EDGE = 2560;

/** Only oversize photos get a stored view; the common case stays derivative-free. */
export function photoNeedsView(bytes: number): boolean {
  return bytes > IMAGES_MAX_BYTES;
}

export interface VideoStreamInfo {
  codec: string;
  width: number;
  height: number;
  duration: number;
  /** ffprobe's `format_name`, which is a comma-separated family, not one format. */
  container: string;
  /** The source file's extension, lowercased and without the dot. */
  extension?: string;
  /** True when the moov atom already precedes the media data. */
  faststart?: boolean;
}

export interface ViewDecision {
  action: 'reuse-original' | 'encode';
  reason: string;
}

/**
 * Whether the source can be served as-is.
 *
 * `view_is_original` exists so a phone video that is already H.264-in-MP4 at
 * 1080p or below is never re-encoded — re-encoding it would cost minutes and
 * lose quality to produce a file the browser could already play. Anything else
 * (HEVC from a modern iPhone, a .mov container, 4K, ProRes) gets a proxy.
 */
export function decideView(info: VideoStreamInfo): ViewDecision {
  const codec = info.codec.toLowerCase();
  const container = info.container.toLowerCase();

  if (codec !== 'h264') {
    return { action: 'encode', reason: `${info.codec} is not H.264` };
  }
  // ffprobe reports the identical `mov,mp4,m4a,3gp,3g2,mj2` family for a .mov
  // and a .mp4, so format_name alone cannot tell them apart. The extension is
  // the only cheap signal that distinguishes them, and a QuickTime container is
  // not something to hand a browser and hope.
  if (!container.split(',').includes('mp4')) {
    return { action: 'encode', reason: `${info.container} is not an MP4 container` };
  }
  if (info.extension !== undefined && !['mp4', 'm4v'].includes(info.extension)) {
    return { action: 'encode', reason: `.${info.extension} is not an MP4 container` };
  }
  if (info.width > MAX_VIEW_WIDTH || info.height > MAX_VIEW_HEIGHT) {
    return { action: 'encode', reason: `${info.width}×${info.height} is above 1080p` };
  }
  if (info.faststart === false) {
    return { action: 'encode', reason: 'the moov atom is at the end of the file' };
  }
  return { action: 'reuse-original', reason: 'already H.264 MP4 within 1080p' };
}

/**
 * Fits inside 1080p while preserving aspect, and rounds to even numbers because
 * yuv420p cannot represent odd dimensions. Portrait video is handled by fitting
 * both axes rather than assuming landscape — phone footage is usually vertical.
 */
export function scaleToFit(
  width: number,
  height: number,
  maxWidth = MAX_VIEW_WIDTH,
  maxHeight = MAX_VIEW_HEIGHT,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: maxWidth, height: maxHeight };
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

export interface EncodeOptions {
  input: string;
  output: string;
  encoder: H264Encoder;
  width: number;
  height: number;
}

/**
 * The proxy encode. `-movflags +faststart` is the non-negotiable part: without
 * it the moov atom is written after the media data and a browser must fetch the
 * entire file before it can show a single frame or seek at all.
 */
export function encodeArgs(options: EncodeOptions): string[] {
  const { encoder, width, height } = options;
  const quality = isHardware(encoder)
    ? // Hardware encoders ignore CRF; they take a bitrate target instead.
      ['-b:v', bitrateFor(width, height), '-maxrate', bitrateFor(width, height), '-bufsize', '12M']
    : ['-crf', '21', '-preset', 'veryfast'];

  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-i',
    options.input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    encoder,
    ...quality,
    '-pix_fmt',
    'yuv420p',
    '-vf',
    `scale=${width}:${height}:flags=bicubic`,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    '-progress',
    'pipe:1',
    '-nostats',
    options.output,
  ];
}

/** Roughly 0.1 bits per pixel per frame at 30fps, clamped to something sane. */
export function bitrateFor(width: number, height: number): string {
  const pixels = width * height;
  const mbps = Math.min(8, Math.max(1.5, (pixels / (1920 * 1080)) * 6));
  return `${mbps.toFixed(1)}M`;
}

/**
 * A bounded JPEG for a photo too large for the Images binding.
 *
 * Fits inside 2560 on the longest edge without ever upscaling, applies EXIF
 * orientation, and strips metadata — a view rendition served to a recipient
 * should not carry the GPS coordinates of someone's house.
 */
export function photoViewArgs(input: string, output: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-map_metadata',
    '-1',
    '-vf',
    // min() on both axes means a smaller source is left alone rather than blown up.
    `scale=w='min(${MAX_PHOTO_VIEW_EDGE},iw)':h='min(${MAX_PHOTO_VIEW_EDGE},ih)':force_original_aspect_ratio=decrease:flags=lanczos`,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    '-f',
    'image2',
    output,
  ];
}

/** A single JPEG frame, used as the video's thumbnail. */
export function posterArgs(input: string, output: string, atSeconds: number): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    atSeconds.toFixed(2),
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    `scale='min(${MAX_VIEW_WIDTH},iw)':-2`,
    '-q:v',
    '3',
    '-f',
    'image2',
    output,
  ];
}

/**
 * ffmpeg's `-progress pipe:1` emits `key=value` lines in blocks terminated by
 * `progress=continue`. `out_time_us` is the encoded position, which against a
 * known duration gives a real fraction rather than a spinner.
 */
export function parseProgress(chunk: string): { seconds: number; speed: number | null } | null {
  let microseconds: number | null = null;
  let speed: number | null = null;
  for (const line of chunk.split('\n')) {
    const [key, value] = line.split('=', 2);
    if (key === undefined || value === undefined) continue;
    if (key === 'out_time_us' || key === 'out_time_ms') {
      const parsed = Number(value);
      // out_time_ms is misnamed upstream: it is microseconds, like out_time_us.
      if (Number.isFinite(parsed)) microseconds = parsed;
    } else if (key === 'speed') {
      const parsed = Number.parseFloat(value.replace('x', ''));
      if (Number.isFinite(parsed)) speed = parsed;
    }
  }
  return microseconds === null ? null : { seconds: microseconds / 1_000_000, speed };
}

// ----------------------------------------------------------------- probing --

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeFormat {
  format_name?: string;
  duration?: string;
}

/** Everything the view decision needs, in one ffprobe call. */
export async function probeVideo(path: string): Promise<VideoStreamInfo | null> {
  const ffprobe = await requireTool('ffprobe');
  const proc = Bun.spawn(
    [ffprobe.path, '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', path],
    { stdout: 'pipe', stderr: 'ignore' },
  );
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return null;

  let parsed: { streams?: FfprobeStream[]; format?: FfprobeFormat };
  try {
    parsed = JSON.parse(text) as { streams?: FfprobeStream[]; format?: FfprobeFormat };
  } catch {
    return null;
  }
  const video = (parsed.streams ?? []).find((stream) => stream.codec_type === 'video');
  if (video === undefined) return null;

  return {
    extension: path.toLowerCase().split('.').pop(),
    codec: video.codec_name ?? 'unknown',
    width: video.width ?? 0,
    height: video.height ?? 0,
    duration: Number(parsed.format?.duration ?? video.duration ?? 0) || 0,
    container: parsed.format?.format_name ?? 'unknown',
    faststart: await hasFaststart(path),
  };
}

/**
 * Reads the top-level MP4 boxes and reports whether `moov` comes before `mdat`.
 * Cheap — it only ever touches the box headers, never the media — and it is the
 * difference between a video that starts playing immediately and one that makes
 * the browser download 3 GB first.
 */
export async function hasFaststart(path: string): Promise<boolean | undefined> {
  const file = Bun.file(path);
  const size = file.size;
  if (size < 16) return undefined;

  let offset = 0;
  for (let box = 0; box < 64 && offset + 16 <= size; box++) {
    const header = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
    let boxSize = header.getUint32(0);
    const type = String.fromCharCode(
      header.getUint8(4),
      header.getUint8(5),
      header.getUint8(6),
      header.getUint8(7),
    );
    if (type === 'moov') return true;
    if (type === 'mdat') return false;
    // A size of 1 means the real 64-bit size follows the type field.
    if (boxSize === 1) boxSize = Number(header.getBigUint64(8));
    if (boxSize === 0) return undefined;
    if (!Number.isFinite(boxSize) || boxSize < 8) return undefined;
    offset += boxSize;
  }
  return undefined;
}

// ------------------------------------------------------------------ encode --

export interface EncodeResult {
  path: string;
  bytes: number;
  encoder: H264Encoder;
  width: number;
  height: number;
  seconds: number;
}

let encoderChoice: H264Encoder | null = null;

/** Probed once per process, not once per file. */
export async function chooseEncoder(): Promise<H264Encoder> {
  if (encoderChoice !== null) return encoderChoice;
  const ffmpeg = await requireTool('ffmpeg');
  encoderChoice = pickEncoder(await listEncoders(ffmpeg.path));
  return encoderChoice;
}

export function resetEncoderChoice(): void {
  encoderChoice = null;
}

/**
 * Where finished proxies wait between an interrupted run and the next one.
 * Under the config directory, so `ms uninstall` removes it along with
 * everything else this CLI has ever written outside its own node_modules.
 */
export function transcodeDir(): string {
  return join(configDir(), 'transcode');
}

export function proxyPath(sha256: string): string {
  return join(transcodeDir(), `${sha256}.view.mp4`);
}

export function posterPath(sha256: string): string {
  return join(transcodeDir(), `${sha256}.poster.jpg`);
}

export function photoViewPath(sha256: string): string {
  return join(transcodeDir(), `${sha256}.view.jpg`);
}

/**
 * Renders the bounded view for an oversize photo, or null if ffmpeg cannot
 * decode it — ProRAW DNG and other exotic formats are a real possibility.
 *
 * A null is not a failure of the upload. The original still goes up; the asset
 * simply has no stored view and the edge answers 415, which shows a placeholder.
 * Withholding beats leaking.
 */
export async function renderPhotoView(input: string, sha256: string): Promise<string | null> {
  const ffmpeg = await requireTool('ffmpeg');
  const output = photoViewPath(sha256);
  await mkdir(transcodeDir(), { recursive: true, mode: 0o700 });

  const existing = await stat(output).catch(() => null);
  if (existing !== null && existing.size > 0) return output;

  const partial = `${output}.partial`;
  await rm(partial, { force: true });
  const proc = Bun.spawn([ffmpeg.path, ...photoViewArgs(input, partial)], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  if ((await proc.exited) !== 0) {
    await rm(partial, { force: true });
    return null;
  }
  const info = await stat(partial).catch(() => null);
  if (info === null || info.size === 0) {
    await rm(partial, { force: true });
    return null;
  }
  await Bun.write(output, Bun.file(partial));
  await rm(partial, { force: true });
  return output;
}

/**
 * Encodes a proxy, resuming by reuse: a completed proxy from an earlier
 * interrupted run is kept and returned rather than re-encoded, since encoding
 * is by far the most expensive thing this CLI does. Partial output is written
 * to `.partial` and only moved into place on a clean exit, so an interrupted
 * encode can never be mistaken for a finished one.
 */
export async function encodeProxy(
  input: string,
  sha256: string,
  info: VideoStreamInfo,
  onProgress?: (fraction: number, speed: number | null) => void,
  signal?: AbortSignal,
): Promise<EncodeResult> {
  const encoder = await chooseEncoder();
  const { width, height } = scaleToFit(info.width, info.height);
  const output = proxyPath(sha256);
  await mkdir(transcodeDir(), { recursive: true, mode: 0o700 });

  const existing = await stat(output).catch(() => null);
  if (existing !== null && existing.size > 0) {
    return {
      path: output,
      bytes: existing.size,
      encoder,
      width,
      height,
      seconds: 0,
    };
  }

  const partial = `${output}.partial`;
  await rm(partial, { force: true });
  const started = Date.now();
  const ffmpeg = await requireTool('ffmpeg');

  const proc = Bun.spawn(
    [ffmpeg.path, ...encodeArgs({ input, output: partial, encoder, width, height })],
    { stdout: 'pipe', stderr: 'pipe', signal },
  );

  const readProgress = (async () => {
    if (onProgress === undefined || info.duration <= 0) return;
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      const update = parseProgress(decoder.decode(chunk));
      if (update !== null) {
        onProgress(Math.min(1, update.seconds / info.duration), update.speed);
      }
    }
  })();

  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
    readProgress.catch(() => undefined),
  ]);

  if (code !== 0) {
    await rm(partial, { force: true });
    const detail = stderr.trim().split('\n').slice(-3).join('; ');
    throw new CliError(`ffmpeg could not encode a proxy${detail === '' ? '' : `: ${detail}`}`, {
      code: EXIT.external,
    });
  }

  await Bun.write(output, Bun.file(partial));
  await rm(partial, { force: true });
  const bytes = (await stat(output)).size;
  return { path: output, bytes, encoder, width, height, seconds: (Date.now() - started) / 1000 };
}

/** A poster frame, or null — a video with no readable frame is not fatal. */
export async function extractPoster(
  input: string,
  sha256: string,
  duration: number,
): Promise<string | null> {
  const ffmpeg = await requireTool('ffmpeg');
  const output = posterPath(sha256);
  await mkdir(transcodeDir(), { recursive: true, mode: 0o700 });

  const existing = await stat(output).catch(() => null);
  if (existing !== null && existing.size > 0) return output;

  // Clamp into the clip: a 0.8 s video has no frame at 1.5 s.
  const at = duration > 0 ? Math.min(POSTER_OFFSET_SECONDS, Math.max(0, duration / 2)) : 0;
  const proc = Bun.spawn([ffmpeg.path, ...posterArgs(input, output, at)], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  if ((await proc.exited) !== 0) return null;
  const info = await stat(output).catch(() => null);
  return info !== null && info.size > 0 ? output : null;
}

/** Drops the cached proxy and poster once both have been uploaded. */
export async function clearTranscodeArtifacts(sha256: string): Promise<void> {
  for (const path of [proxyPath(sha256), posterPath(sha256), photoViewPath(sha256)]) {
    await rm(path, { force: true });
    await rm(`${path}.partial`, { force: true });
  }
}

/**
 * What `derive_state` an asset should end up at.
 *
 * A photo is always `'skipped'`, even an oversize one whose view rendition is
 * still in flight: invariant 3 says a photo must never render as developing.
 * A video whose original is already browser-safe is settled too — no proxy is
 * coming. Everything else is `'ready'` once its proxy lands, and `'pending'`
 * only in the window before that.
 */
export function deriveStateFor(input: {
  kind: 'photo' | 'video';
  viewIsOriginal: boolean;
  hasProxy: boolean;
}): 'ready' | 'skipped' | 'pending' {
  if (input.kind === 'photo') return 'skipped';
  if (input.viewIsOriginal) return 'skipped';
  return input.hasProxy ? 'ready' : 'pending';
}
