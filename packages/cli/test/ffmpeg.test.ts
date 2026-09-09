import { describe, expect, test } from 'bun:test';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hasStoredView } from '../src/commands/download.ts';
import {
  binaryName,
  bundledDirectory,
  bundledPath,
  clearToolCache,
  findTool,
  isHardware,
  PLATFORM_KEYS,
  packageNameFor,
  parseEncoders,
  pickEncoder,
  platformKey,
  systemPath,
} from '../src/core/ffmpeg.ts';
import type { Asset } from '../src/core/types.ts';

describe('platformKey', () => {
  test('maps the five supported hosts', () => {
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64');
    expect(platformKey('darwin', 'x64')).toBe('darwin-x64');
    expect(platformKey('linux', 'x64')).toBe('linux-x64');
    expect(platformKey('linux', 'arm64')).toBe('linux-arm64');
    expect(platformKey('win32', 'x64')).toBe('win32-x64');
  });

  test('returns null for anything else rather than guessing', () => {
    expect(platformKey('freebsd', 'x64')).toBeNull();
    expect(platformKey('linux', 'arm')).toBeNull();
    expect(platformKey('win32', 'arm64')).toBeNull();
  });
});

describe('package naming', () => {
  test('matches the published optional dependency names', () => {
    expect(packageNameFor('darwin-arm64')).toBe('@memory-share/ffmpeg-darwin-arm64');
    for (const key of PLATFORM_KEYS) {
      expect(packageNameFor(key)).toBe(`@memory-share/ffmpeg-${key}`);
    }
  });

  test('windows binaries carry .exe', () => {
    expect(binaryName('ffmpeg', 'win32')).toBe('ffmpeg.exe');
    expect(binaryName('ffprobe', 'win32')).toBe('ffprobe.exe');
    expect(binaryName('ffmpeg', 'linux')).toBe('ffmpeg');
    expect(binaryName('ffprobe', 'darwin')).toBe('ffprobe');
  });
});

describe('parseEncoders', () => {
  test('pulls encoder names out of ffmpeg -encoders', () => {
    const output = [
      'Encoders:',
      ' V..... = Video',
      ' ------',
      ' V....D libx264              libx264 H.264 / AVC',
      ' V....D h264_videotoolbox    VideoToolbox H.264 Encoder',
      ' A....D aac                  AAC (Advanced Audio Coding)',
    ].join('\n');
    const encoders = parseEncoders(output);
    expect(encoders.has('libx264')).toBe(true);
    expect(encoders.has('h264_videotoolbox')).toBe(true);
    expect(encoders.has('aac')).toBe(true);
    expect(encoders.has('Encoders:')).toBe(false);
  });

  test('empty output yields no encoders rather than throwing', () => {
    expect(parseEncoders('').size).toBe(0);
  });
});

describe('pickEncoder', () => {
  test('prefers VideoToolbox on macOS when it is actually present', () => {
    expect(pickEncoder(new Set(['libx264', 'h264_videotoolbox']), 'darwin')).toBe(
      'h264_videotoolbox',
    );
  });

  test('prefers NVENC off macOS when it is actually present', () => {
    expect(pickEncoder(new Set(['libx264', 'h264_nvenc']), 'linux')).toBe('h264_nvenc');
  });

  test('never picks the other platform hardware encoder', () => {
    expect(pickEncoder(new Set(['libx264', 'h264_nvenc']), 'darwin')).toBe('libx264');
    expect(pickEncoder(new Set(['libx264', 'h264_videotoolbox']), 'linux')).toBe('libx264');
  });

  test('falls back to libx264 when a build has no hardware encoder', () => {
    expect(pickEncoder(new Set(['libx264']), 'darwin')).toBe('libx264');
    expect(pickEncoder(new Set(), 'linux')).toBe('libx264');
  });

  test('only libx264 counts as software', () => {
    expect(isHardware('libx264')).toBe(false);
    expect(isHardware('h264_videotoolbox')).toBe(true);
    expect(isHardware('h264_nvenc')).toBe(true);
  });
});

/**
 * These exercise the real installed optional dependency rather than a mock —
 * the whole point of the bundling design is that resolution works against a
 * genuine node_modules layout, and a mocked `require.resolve` would prove
 * nothing about that.
 */
describe('bundled resolution', () => {
  const host = platformKey();

  test('resolves the platform package for this host', () => {
    if (host === null) return;
    const dir = bundledDirectory(host);
    expect(dir).not.toBeNull();
    // A published install puts the package under node_modules; a workspace
    // checkout symlinks it, and require.resolve reports the real path. Either
    // way the directory is the platform package itself.
    expect(dir).toContain(`ffmpeg-${host}`);
  });

  test('the package is installed under the CLI node_modules, where uninstall reaches it', async () => {
    if (host === null) return;
    const link = join(
      dirname(dirname(Bun.fileURLToPath(import.meta.url))),
      'node_modules',
      packageNameFor(host),
    );
    expect(
      await stat(link)
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
  });

  test('an unsupported-for-this-host package resolves to a directory or null, never throws', () => {
    for (const key of PLATFORM_KEYS) {
      expect(() => bundledDirectory(key)).not.toThrow();
    }
  });

  test('the bundled binary lives inside the package directory, not under $HOME', async () => {
    if (host === null) return;
    const path = await bundledPath('ffmpeg', host);
    if (path === null) return; // not vendored in this checkout
    const dir = bundledDirectory(host) as string;
    expect(path.startsWith(join(dir, 'bin'))).toBe(true);
    expect(path).not.toContain('/.cache/');
    expect(path).not.toContain('/.local/');
    expect(path.startsWith('/tmp')).toBe(false);
  });

  test('resolution prefers the bundled binary over PATH', async () => {
    if (host === null) return;
    const bundled = await bundledPath('ffmpeg', host);
    if (bundled === null) return;
    clearToolCache();
    const tool = await findTool('ffmpeg');
    expect(tool?.source).toBe('bundled');
    expect(tool?.path).toBe(bundled);
    expect(tool?.packageName).toBe(packageNameFor(host));
  });

  test('an explicit override beats both', async () => {
    const system = await systemPath('ffprobe');
    if (system === null) return;
    clearToolCache();
    process.env.MS_FFPROBE_PATH = system;
    try {
      const tool = await findTool('ffprobe');
      expect(tool?.source).toBe('override');
      expect(tool?.path).toBe(system);
    } finally {
      process.env.MS_FFPROBE_PATH = undefined;
      clearToolCache();
    }
  });

  test('a non-existent override is ignored rather than fatal', async () => {
    clearToolCache();
    process.env.MS_FFMPEG_PATH = '/nonexistent/ffmpeg';
    try {
      const tool = await findTool('ffmpeg');
      expect(tool?.source).not.toBe('override');
    } finally {
      process.env.MS_FFMPEG_PATH = undefined;
      clearToolCache();
    }
  });
});

describe('hasStoredView', () => {
  const base: Omit<Asset, 'kind'> = {
    id: 'a'.repeat(64),
    filename: 'x.jpg',
    mime: 'image/jpeg',
    bytes: 1,
  };

  test('follows view_key, so an oversize photo counts', () => {
    expect(hasStoredView({ ...base, kind: 'photo', view_key: `view/${base.id}.jpg` })).toBe(true);
  });

  test('an ordinary photo has none — the edge renders it on the fly', () => {
    expect(hasStoredView({ ...base, kind: 'photo' })).toBe(false);
    expect(hasStoredView({ ...base, kind: 'photo', view_key: null })).toBe(false);
  });

  test('a video counts even before its row reports a key', () => {
    expect(hasStoredView({ ...base, kind: 'video', filename: 'x.mp4' })).toBe(true);
  });
});
