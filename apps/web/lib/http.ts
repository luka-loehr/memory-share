/**
 * Range parsing for the media route.
 *
 * We deliberately handle this by hand rather than leaning on R2's `onlyIf`:
 * passing `onlyIf` together with `range` to `R2Bucket.get()` throws, and the
 * media route has to answer both conditional and ranged requests.
 */

export type RangeResult =
  | { type: 'none' }
  | { type: 'unsatisfiable' }
  /** offset/length are absolute and already clamped to `size`. */
  | { type: 'range'; offset: number; length: number; end: number };

/**
 * Parse a `Range` header against a known object size.
 *
 * Supports `bytes=a-b`, the open-ended `bytes=a-`, and the suffix form
 * `bytes=-n` ("the last n bytes"). Anything malformed, multi-range, or in a
 * unit other than bytes is treated as absent, which RFC 9110 permits and which
 * degrades to a plain 200 rather than an error.
 */
export function parseRange(header: string | null, size: number): RangeResult {
  if (!header) return { type: 'none' };

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { type: 'none' };

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return { type: 'none' };

  let offset: number;
  let end: number;

  if (rawStart === '') {
    // Suffix range: the final `rawEnd` bytes. `bytes=-0` is unsatisfiable.
    const suffix = Number(rawEnd);
    if (suffix === 0) return { type: 'unsatisfiable' };
    offset = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    offset = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }

  // A zero-length object can satisfy no range at all.
  if (size === 0 || offset >= size || offset > end) return { type: 'unsatisfiable' };

  return { type: 'range', offset, length: end - offset + 1, end };
}

/**
 * Media must never be replayable from the browser cache: a recipient who locks
 * the memory again, or whose cookie expires, would otherwise still see the
 * photos by pressing Back. `no-cache` still permits revalidation via ETag, so
 * repeat views stay cheap without going unauthenticated.
 */
export const PRIVATE_MEDIA_CACHE = 'private, no-cache, max-age=0, must-revalidate';

/** Does an `If-None-Match` header match this entity tag? */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  const normalise = (t: string) => t.trim().replace(/^W\//, '');
  const want = normalise(etag);
  return ifNoneMatch.split(',').some((candidate) => normalise(candidate) === want);
}

export function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      ...init?.headers,
    },
  });
}
