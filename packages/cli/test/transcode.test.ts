import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultJobs } from '../src/commands/upload.ts';
import { findTool } from '../src/core/ffmpeg.ts';
import {
  bitrateFor,
  decideView,
  deriveStateFor,
  encodeArgs,
  hasFaststart,
  IMAGES_MAX_BYTES,
  MAX_PHOTO_VIEW_EDGE,
  MAX_VIEW_HEIGHT,
  MAX_VIEW_WIDTH,
  parseProgress,
  photoNeedsView,
  photoViewArgs,
  posterArgs,
  scaleToFit,
  type VideoStreamInfo,
} from '../src/core/transcode.ts';

function info(overrides: Partial<VideoStreamInfo> = {}): VideoStreamInfo {
  return {
    codec: 'h264',
    width: 1920,
    height: 1080,
    duration: 12,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    faststart: true,
    ...overrides,
  };
}

describe('decideView', () => {
  test('H.264 MP4 within 1080p is served as-is', () => {
    const decision = decideView(info());
    expect(decision.action).toBe('reuse-original');
  });

  test('HEVC from a modern iPhone gets a proxy', () => {
    const decision = decideView(info({ codec: 'hevc' }));
    expect(decision.action).toBe('encode');
    expect(decision.reason).toContain('not H.264');
  });

  test('4K gets a proxy even when it is already H.264', () => {
    expect(decideView(info({ width: 3840, height: 2160 })).action).toBe('encode');
  });

  test('portrait video above 1080 on its long edge gets a proxy', () => {
    expect(decideView(info({ width: 1080, height: 1920 })).action).toBe('encode');
  });

  test('a non-MP4 container gets a proxy', () => {
    const decision = decideView(info({ container: 'matroska,webm' }));
    expect(decision.action).toBe('encode');
    expect(decision.reason).toContain('not an MP4 container');
  });

  test('a .mov is re-encoded even though ffprobe reports the mp4 family for it', () => {
    // ffprobe gives .mov and .mp4 the identical format_name, so only the
    // extension distinguishes a QuickTime container from a real MP4.
    const decision = decideView(info({ extension: 'mov' }));
    expect(decision.action).toBe('encode');
    expect(decision.reason).toContain('.mov is not an MP4 container');
  });

  test('.mp4 and .m4v are both accepted as MP4', () => {
    expect(decideView(info({ extension: 'mp4' })).action).toBe('reuse-original');
    expect(decideView(info({ extension: 'm4v' })).action).toBe('reuse-original');
  });

  test('an MP4 whose moov atom trails the media is re-encoded for faststart', () => {
    const decision = decideView(info({ faststart: false }));
    expect(decision.action).toBe('encode');
    expect(decision.reason).toContain('moov');
  });

  test('an unknowable faststart flag does not force a needless re-encode', () => {
    expect(decideView(info({ faststart: undefined })).action).toBe('reuse-original');
  });

  test('exactly 1080p is inside the ceiling, not outside it', () => {
    expect(decideView(info({ width: MAX_VIEW_WIDTH, height: MAX_VIEW_HEIGHT })).action).toBe(
      'reuse-original',
    );
    expect(decideView(info({ width: MAX_VIEW_WIDTH + 2, height: 1080 })).action).toBe('encode');
  });
});

describe('scaleToFit', () => {
  test('leaves anything already inside the box alone', () => {
    expect(scaleToFit(1280, 720)).toEqual({ width: 1280, height: 720 });
  });

  test('fits 4K landscape to 1080p', () => {
    expect(scaleToFit(3840, 2160)).toEqual({ width: 1920, height: 1080 });
  });

  test('fits portrait phone video by its long edge', () => {
    const scaled = scaleToFit(2160, 3840);
    expect(scaled.height).toBe(1080);
    expect(scaled.width).toBe(608);
  });

  test('always returns even dimensions, because yuv420p cannot do odd', () => {
    for (const [w, h] of [
      [1999, 1131],
      [1081, 1921],
      [3, 7],
      [4097, 2161],
    ] as const) {
      const scaled = scaleToFit(w, h);
      expect(scaled.width % 2).toBe(0);
      expect(scaled.height % 2).toBe(0);
    }
  });

  test('preserves aspect ratio within rounding', () => {
    const scaled = scaleToFit(4000, 3000);
    expect(scaled.width / scaled.height).toBeCloseTo(4 / 3, 2);
  });

  test('degenerate input falls back to the full box instead of dividing by zero', () => {
    expect(scaleToFit(0, 0)).toEqual({ width: 1920, height: 1080 });
  });
});

describe('encodeArgs', () => {
  const base = { input: 'in.mov', output: 'out.mp4', width: 1920, height: 1080 };

  test('faststart is always present — a browser must not have to fetch the whole file', () => {
    for (const encoder of ['libx264', 'h264_videotoolbox', 'h264_nvenc'] as const) {
      const args = encodeArgs({ ...base, encoder });
      const index = args.indexOf('-movflags');
      expect(index).toBeGreaterThan(-1);
      expect(args[index + 1]).toBe('+faststart');
    }
  });

  test('encodes H.264 with the chosen encoder, AAC audio and yuv420p', () => {
    const args = encodeArgs({ ...base, encoder: 'libx264' });
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264');
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
    expect(args.at(-1)).toBe('out.mp4');
  });

  test('software encoding uses CRF; hardware uses a bitrate target', () => {
    const software = encodeArgs({ ...base, encoder: 'libx264' });
    expect(software).toContain('-crf');
    expect(software).not.toContain('-b:v');

    const hardware = encodeArgs({ ...base, encoder: 'h264_videotoolbox' });
    expect(hardware).toContain('-b:v');
    expect(hardware).not.toContain('-crf');
  });

  test('scales to the dimensions it was given', () => {
    const args = encodeArgs({ ...base, encoder: 'libx264', width: 608, height: 1080 });
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=608:1080:flags=bicubic');
  });

  test('audio is optional, so a silent clip does not fail the map', () => {
    expect(encodeArgs({ ...base, encoder: 'libx264' })).toContain('0:a:0?');
  });
});

describe('bitrateFor', () => {
  test('scales with pixel count inside sane bounds', () => {
    const low = Number.parseFloat(bitrateFor(640, 360));
    const high = Number.parseFloat(bitrateFor(1920, 1080));
    expect(low).toBeGreaterThanOrEqual(1.5);
    expect(high).toBeLessThanOrEqual(8);
    expect(high).toBeGreaterThan(low);
  });
});

describe('posterArgs', () => {
  test('seeks past the blurry first frame', () => {
    const args = posterArgs('in.mp4', 'out.jpg', 1.5);
    expect(args[args.indexOf('-ss') + 1]).toBe('1.50');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
    expect(args.at(-1)).toBe('out.jpg');
  });

  test('seeks before the input, so ffmpeg does not decode the whole clip', () => {
    const args = posterArgs('in.mp4', 'out.jpg', 1.5);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
  });
});

describe('parseProgress', () => {
  test('reads position and speed from a -progress block', () => {
    const block = [
      'frame=120',
      'fps=60.0',
      'out_time_us=4000000',
      'speed=2.5x',
      'progress=continue',
    ].join('\n');
    expect(parseProgress(block)).toEqual({ seconds: 4, speed: 2.5 });
  });

  test('handles the misnamed out_time_ms, which is also microseconds', () => {
    expect(parseProgress('out_time_ms=2000000\nprogress=continue')?.seconds).toBe(2);
  });

  test('a block with no timestamp yields null rather than a bogus zero', () => {
    expect(parseProgress('frame=1\nprogress=continue')).toBeNull();
    expect(parseProgress('')).toBeNull();
  });

  test('a missing speed is null, not NaN', () => {
    expect(parseProgress('out_time_us=1000000')?.speed).toBeNull();
  });
});

describe('photoNeedsView', () => {
  test('only photos above the 20 MB Images cap get a stored view', () => {
    expect(photoNeedsView(5_000_000)).toBe(false);
    expect(photoNeedsView(IMAGES_MAX_BYTES)).toBe(false);
    expect(photoNeedsView(IMAGES_MAX_BYTES + 1)).toBe(true);
    expect(photoNeedsView(60_000_000)).toBe(true);
  });

  test('the threshold is the decimal 20 MB, which errs small on purpose', () => {
    // A file the edge would reject must never be left without a view; a file it
    // would have accepted merely gains one it did not need.
    expect(IMAGES_MAX_BYTES).toBe(20_000_000);
    expect(photoNeedsView(20 * 1024 * 1024)).toBe(true);
  });
});

describe('photoViewArgs', () => {
  test('bounds the longest edge without upscaling a smaller photo', () => {
    const args = photoViewArgs('in.jpg', 'out.jpg');
    const filter = args[args.indexOf('-vf') + 1] ?? '';
    expect(filter).toContain(`min(${MAX_PHOTO_VIEW_EDGE},iw)`);
    expect(filter).toContain(`min(${MAX_PHOTO_VIEW_EDGE},ih)`);
    expect(filter).toContain('force_original_aspect_ratio=decrease');
  });

  test('strips metadata, so a view rendition carries no GPS coordinates', () => {
    const args = photoViewArgs('in.jpg', 'out.jpg');
    expect(args[args.indexOf('-map_metadata') + 1]).toBe('-1');
  });

  test('writes a single high-quality JPEG frame', () => {
    const args = photoViewArgs('in.jpg', 'out.jpg');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
    expect(args[args.indexOf('-f') + 1]).toBe('image2');
    expect(args.at(-1)).toBe('out.jpg');
  });
});

describe('defaultJobs', () => {
  test('leaves two cores for the rest of the machine', () => {
    expect(defaultJobs(10)).toBe(8);
    expect(defaultJobs(4)).toBe(2);
  });

  test('never drops below one, however small the machine', () => {
    expect(defaultJobs(2)).toBe(1);
    expect(defaultJobs(1)).toBe(1);
  });
});

/**
 * Real MP4s, produced by the bundled ffmpeg. The faststart check is the one
 * piece of this module that reads a binary format by hand, so it is tested
 * against files that actually have the moov atom in each position rather than
 * against a fixture someone wrote down.
 */
describe('hasFaststart', () => {
  test('distinguishes a faststart MP4 from a trailing-moov one', async () => {
    const ffmpeg = await findTool('ffmpeg');
    if (ffmpeg === null) return;

    const dir = await mkdtemp(join(tmpdir(), 'ms-faststart-'));
    try {
      const source = ['-f', 'lavfi', '-i', 'testsrc=size=64x64:duration=1', '-pix_fmt', 'yuv420p'];
      const plain = join(dir, 'plain.mp4');
      const fast = join(dir, 'fast.mp4');

      await Bun.spawn([ffmpeg.path, '-loglevel', 'error', '-y', ...source, plain], {
        stdout: 'ignore',
        stderr: 'ignore',
      }).exited;
      await Bun.spawn(
        [ffmpeg.path, '-loglevel', 'error', '-y', ...source, '-movflags', '+faststart', fast],
        { stdout: 'ignore', stderr: 'ignore' },
      ).exited;

      expect(await hasFaststart(fast)).toBe(true);
      expect(await hasFaststart(plain)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a file that is not an MP4 at all is undefined, not a crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-faststart-'));
    try {
      const path = join(dir, 'not.mp4');
      await Bun.write(path, 'this is not an mp4 but it is long enough to read a header from');
      expect(await hasFaststart(path)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a truncated file is undefined rather than throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-faststart-'));
    try {
      const path = join(dir, 'tiny.mp4');
      await Bun.write(path, 'abc');
      expect(await hasFaststart(path)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('deriveStateFor', () => {
  test('a photo is always skipped, even an oversize one with a view rendition', () => {
    // Invariant 3: a photo must never render as mid-derivation.
    expect(deriveStateFor({ kind: 'photo', viewIsOriginal: false, hasProxy: false })).toBe(
      'skipped',
    );
    expect(deriveStateFor({ kind: 'photo', viewIsOriginal: false, hasProxy: true })).toBe(
      'skipped',
    );
  });

  test('a browser-safe video is settled, not pending — no proxy is coming', () => {
    expect(deriveStateFor({ kind: 'video', viewIsOriginal: true, hasProxy: false })).toBe(
      'skipped',
    );
  });

  test('a video with a proxy is ready', () => {
    expect(deriveStateFor({ kind: 'video', viewIsOriginal: false, hasProxy: true })).toBe('ready');
  });

  test('a video with neither is pending — the only case that legitimately is', () => {
    expect(deriveStateFor({ kind: 'video', viewIsOriginal: false, hasProxy: false })).toBe(
      'pending',
    );
  });
});
