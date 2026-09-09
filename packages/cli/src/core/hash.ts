import { CliError, EXIT } from './errors.ts';

export const MIB = 1024 * 1024;

/** R2 multipart limits. Every part but the last must clear the floor. */
export const MIN_PART_BYTES = 5 * MIB;
export const MAX_PARTS = 10_000;
export const DEFAULT_PART_BYTES = 64 * MIB;

export interface PartPlan {
  partNumber: number;
  start: number;
  /** Exclusive, so `end - start` is the part length. */
  end: number;
}

export interface Plan {
  partSize: number;
  parts: PartPlan[];
}

/**
 * Splits a file into multipart ranges. The requested part size only ever grows:
 * a 3.5 GB video at 64 MB is 55 parts, but a hypothetical multi-terabyte file
 * would blow past R2's 10 000-part ceiling, so the size is raised until it fits
 * rather than failing late on part 10 001.
 */
export function planParts(totalBytes: number, requested: number = DEFAULT_PART_BYTES): Plan {
  if (!Number.isFinite(totalBytes) || totalBytes < 0) {
    throw new CliError(`Cannot plan an upload of ${totalBytes} bytes.`, { code: EXIT.usage });
  }
  let partSize = Math.max(Math.floor(requested), MIN_PART_BYTES);
  if (totalBytes > partSize * MAX_PARTS) {
    partSize = Math.ceil(totalBytes / MAX_PARTS / MIB) * MIB;
  }

  const parts: PartPlan[] = [];
  if (totalBytes === 0) {
    parts.push({ partNumber: 1, start: 0, end: 0 });
    return { partSize, parts };
  }
  for (let start = 0, n = 1; start < totalBytes; start += partSize, n++) {
    parts.push({ partNumber: n, start, end: Math.min(start + partSize, totalBytes) });
  }
  return { partSize, parts };
}

/**
 * sha256 of a file, read as a stream. A 3.5 GB video must never be resident,
 * so nothing here ever holds more than one chunk at a time.
 */
export async function hashFile(
  path: string,
  onChunk?: (bytes: number) => void,
): Promise<{ sha256: string; bytes: number }> {
  const hasher = new Bun.CryptoHasher('sha256');
  let bytes = 0;
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) {
    hasher.update(chunk);
    bytes += chunk.byteLength;
    onChunk?.(chunk.byteLength);
  }
  return { sha256: hasher.digest('hex'), bytes };
}

/** Same digest, for verifying a download we just wrote to disk. */
export async function verifyFile(path: string, expected: string): Promise<boolean> {
  const { sha256 } = await hashFile(path);
  return sha256 === expected.toLowerCase();
}

const PHOTO_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  dng: 'image/x-adobe-dng',
  bmp: 'image/bmp',
};

const VIDEO_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
};

export interface MediaGuess {
  kind: 'photo' | 'video';
  mime: string;
}

/** Extension-driven; the worker is the authority on `kind`, this is a hint. */
export function guessMedia(filename: string): MediaGuess | null {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const photo = PHOTO_EXT[ext];
  if (photo) return { kind: 'photo', mime: photo };
  const video = VIDEO_EXT[ext];
  if (video) return { kind: 'video', mime: video };
  return null;
}

export function isMediaFile(filename: string): boolean {
  return guessMedia(filename) !== null;
}
