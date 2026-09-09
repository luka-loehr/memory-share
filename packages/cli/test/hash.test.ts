import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PART_BYTES,
  guessMedia,
  hashFile,
  isMediaFile,
  MAX_PARTS,
  MIB,
  MIN_PART_BYTES,
  planParts,
  verifyFile,
} from '../src/core/hash.ts';

describe('planParts', () => {
  test('a small file is a single part covering everything', () => {
    const plan = planParts(1234);
    expect(plan.parts).toHaveLength(1);
    expect(plan.parts[0]).toEqual({ partNumber: 1, start: 0, end: 1234 });
  });

  test('an empty file still gets one part', () => {
    const plan = planParts(0);
    expect(plan.parts).toEqual([{ partNumber: 1, start: 0, end: 0 }]);
  });

  test('parts tile the file exactly, with no gap and no overlap', () => {
    const total = 3.5 * 1024 * MIB; // a 3.5 GB video
    const plan = planParts(total, 64 * MIB);
    expect(plan.parts).toHaveLength(56);
    expect(plan.parts[0]?.start).toBe(0);
    expect(plan.parts.at(-1)?.end).toBe(total);
    for (let index = 1; index < plan.parts.length; index++) {
      expect(plan.parts[index]?.start).toBe(plan.parts[index - 1]?.end ?? -1);
    }
    const covered = plan.parts.reduce((sum, part) => sum + (part.end - part.start), 0);
    expect(covered).toBe(total);
  });

  test('every part but the last clears R2 minimum size', () => {
    const plan = planParts(200 * MIB, 64 * MIB);
    for (const part of plan.parts.slice(0, -1)) {
      expect(part.end - part.start).toBeGreaterThanOrEqual(MIN_PART_BYTES);
    }
  });

  test('a part size below the R2 floor is raised, not accepted', () => {
    expect(planParts(50 * MIB, 1 * MIB).partSize).toBe(MIN_PART_BYTES);
  });

  test('part size grows so a huge file stays under the 10 000 part ceiling', () => {
    const total = 5 * 1024 * 1024 * MIB; // 5 PB, comfortably absurd
    const plan = planParts(total, DEFAULT_PART_BYTES);
    expect(plan.parts.length).toBeLessThanOrEqual(MAX_PARTS);
    expect(plan.partSize).toBeGreaterThan(DEFAULT_PART_BYTES);
    expect(plan.parts.at(-1)?.end).toBe(total);
  });

  test('part numbers are 1-based and contiguous', () => {
    const plan = planParts(300 * MIB, 64 * MIB);
    expect(plan.parts.map((part) => part.partNumber)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('hashFile', () => {
  test('matches the known sha256 of its contents and reports the byte count', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-hash-'));
    try {
      const path = join(dir, 'abc.txt');
      await writeFile(path, 'abc');
      const result = await hashFile(path);
      expect(result.sha256).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
      expect(result.bytes).toBe(3);
      expect(await verifyFile(path, result.sha256)).toBe(true);
      expect(await verifyFile(path, 'f'.repeat(64))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('streams in chunks rather than one buffer, and the chunks sum to the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-hash-'));
    try {
      const path = join(dir, 'big.bin');
      await writeFile(path, Buffer.alloc(1_500_000, 7));
      const chunks: number[] = [];
      const result = await hashFile(path, (bytes) => chunks.push(bytes));
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.reduce((sum, n) => sum + n, 0)).toBe(1_500_000);
      expect(result.bytes).toBe(1_500_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('guessMedia', () => {
  test('classifies by extension, case-insensitively', () => {
    expect(guessMedia('IMG_0001.JPG')).toEqual({ kind: 'photo', mime: 'image/jpeg' });
    expect(guessMedia('clip.mov')).toEqual({ kind: 'video', mime: 'video/quicktime' });
    expect(guessMedia('holiday.heic')?.kind).toBe('photo');
    expect(guessMedia('notes.txt')).toBeNull();
    expect(isMediaFile('a.mp4')).toBe(true);
    expect(isMediaFile('a.pages')).toBe(false);
  });
});
