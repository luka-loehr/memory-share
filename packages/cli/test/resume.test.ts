import { describe, expect, test } from 'bun:test';
import { MIB, planParts } from '../src/core/hash.ts';
import { decideUpload, hashCacheKey, type Journal } from '../src/core/resume.ts';

const SHA = 'a'.repeat(64);
const PLAN = planParts(200 * MIB, 64 * MIB); // four parts

function journal(overrides: Partial<Journal> = {}): Journal {
  return {
    sha256: SHA,
    path: '/photos/clip.mov',
    bytes: 200 * MIB,
    mtimeMs: 1_700_000_000_000,
    assetId: SHA,
    uploadId: 'upload-1',
    partSize: PLAN.partSize,
    parts: [
      { partNumber: 1, etag: 'e1' },
      { partNumber: 2, etag: 'e2' },
    ],
    updatedAt: Date.now(),
    ...overrides,
  };
}

function decide(
  overrides: Parameters<typeof decideUpload>[0] extends infer T ? Partial<T> : never,
) {
  return decideUpload({
    remoteExists: false,
    uploadId: 'upload-1',
    journal: journal(),
    plan: PLAN,
    sha256: SHA,
    bytes: 200 * MIB,
    mtimeMs: 1_700_000_000_000,
    ...overrides,
  });
}

describe('decideUpload', () => {
  test('an asset already in the pool is skipped, whatever the journal says', () => {
    expect(decide({ remoteExists: true })).toEqual({ action: 'skip', reason: 'already-in-pool' });
    expect(decide({ remoteExists: true, journal: null })).toEqual({
      action: 'skip',
      reason: 'already-in-pool',
    });
  });

  test('with no journal, the whole file is uploaded', () => {
    expect(decide({ journal: null })).toEqual({ action: 'upload' });
  });

  test('a matching journal resumes, sending only the missing parts', () => {
    const decision = decide({});
    expect(decision).toEqual({
      action: 'resume',
      uploadId: 'upload-1',
      done: [
        { partNumber: 1, etag: 'e1' },
        { partNumber: 2, etag: 'e2' },
      ],
      remaining: [3, 4],
    });
  });

  test('a journal from a different multipart session is discarded', () => {
    expect(decide({ uploadId: 'upload-2' })).toEqual({ action: 'upload' });
  });

  test('a journal for different bytes is discarded', () => {
    expect(decide({ journal: journal({ sha256: 'b'.repeat(64) }) })).toEqual({ action: 'upload' });
    expect(decide({ journal: journal({ bytes: 1 }) })).toEqual({ action: 'upload' });
  });

  test('an edited file (new mtime) is re-uploaded rather than stitched', () => {
    expect(decide({ journal: journal({ mtimeMs: 1_700_000_999_999 }) })).toEqual({
      action: 'upload',
    });
  });

  test('changing the part size invalidates every recorded etag', () => {
    expect(decide({ journal: journal({ partSize: 8 * MIB }) })).toEqual({ action: 'upload' });
  });

  test('parts outside the plan and blank etags are ignored', () => {
    const decision = decide({
      journal: journal({
        parts: [
          { partNumber: 1, etag: 'e1' },
          { partNumber: 99, etag: 'stale' },
          { partNumber: 2, etag: '' },
        ],
      }),
    });
    expect(decision).toEqual({
      action: 'resume',
      uploadId: 'upload-1',
      done: [{ partNumber: 1, etag: 'e1' }],
      remaining: [2, 3, 4],
    });
  });

  test('a journal with nothing usable falls back to a fresh upload', () => {
    expect(decide({ journal: journal({ parts: [] }) })).toEqual({ action: 'upload' });
  });

  test('a journal recording every part leaves nothing to send', () => {
    const decision = decide({
      journal: journal({
        parts: PLAN.parts.map((part) => ({
          partNumber: part.partNumber,
          etag: `e${part.partNumber}`,
        })),
      }),
    });
    expect(decision.action).toBe('resume');
    if (decision.action === 'resume') expect(decision.remaining).toEqual([]);
  });

  test('resumed parts come back in order even when the journal is shuffled', () => {
    const decision = decide({
      journal: journal({
        parts: [
          { partNumber: 3, etag: 'e3' },
          { partNumber: 1, etag: 'e1' },
        ],
      }),
    });
    if (decision.action !== 'resume') throw new Error('expected a resume');
    expect(decision.done.map((part) => part.partNumber)).toEqual([1, 3]);
    expect(decision.remaining).toEqual([2, 4]);
  });
});

describe('hashCacheKey', () => {
  test('changes when the file changes, so an edit is rehashed', () => {
    const base = hashCacheKey('/a/b.jpg', 100, 5);
    expect(hashCacheKey('/a/b.jpg', 100, 5)).toBe(base);
    expect(hashCacheKey('/a/b.jpg', 101, 5)).not.toBe(base);
    expect(hashCacheKey('/a/b.jpg', 100, 6)).not.toBe(base);
    expect(hashCacheKey('/a/c.jpg', 100, 5)).not.toBe(base);
  });

  test('sub-millisecond mtime jitter does not invalidate the cache', () => {
    expect(hashCacheKey('/a/b.jpg', 100, 5.4)).toBe(hashCacheKey('/a/b.jpg', 100, 5.9));
  });
});
