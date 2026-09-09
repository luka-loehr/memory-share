import { getAsset } from '@/lib/admin/assets';
import { requireAdmin } from '@/lib/admin/auth';
import { SHA256 } from '@/lib/admin/upload';
import type { Env } from '@/lib/env';
import { etagMatches, json, PRIVATE_MEDIA_CACHE, parseRange } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * The owner's read path.
 *
 * This exists so `ms download` never has to unlock one of its own albums with
 * its own password, mint a throwaway memory, or write an `access_log` row for
 * what is conceptually a read. Owner reads and recipient reads are different
 * operations and stay on different paths — nothing here consults a memory, and
 * nothing here touches a cookie.
 *
 * Range handling is the share media route's, deliberately: the CLI resumes a
 * partial download with `Range: bytes=N-`, so a 206 with a correct
 * `Content-Range` is load-bearing rather than decorative.
 */
async function serve(
  env: Env,
  request: Request,
  key: string,
  fallbackType: string,
  bodyless: boolean,
): Promise<Response> {
  // HEAD first, always. It yields the size the Range arithmetic needs and the
  // ETag that answers a conditional request — and it is why `onlyIf` is never
  // passed to `get()`, which throws when combined with `range` and would turn
  // every conditional ranged request into a 500.
  const head = await env.MEDIA.head(key);
  if (!head) return json({ error: 'not_found' }, { status: 404 });

  const headers = new Headers({
    'content-type': head.httpMetadata?.contentType ?? fallbackType,
    etag: head.httpEtag,
    'cache-control': PRIVATE_MEDIA_CACHE,
    'accept-ranges': 'bytes',
    vary: 'Range',
    'x-content-type-options': 'nosniff',
    'last-modified': head.uploaded.toUTCString(),
  });

  // Answered before Range, per RFC 9110: an unchanged entity means the client
  // already holds these bytes, ranged or not.
  if (etagMatches(request.headers.get('if-none-match'), head.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }

  if (bodyless) {
    headers.set('content-length', String(head.size));
    return new Response(null, { status: 200, headers });
  }

  const range = parseRange(request.headers.get('range'), head.size);

  if (range.type === 'unsatisfiable') {
    headers.set('content-range', `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  }

  if (range.type === 'range') {
    const object = await env.MEDIA.get(key, {
      range: { offset: range.offset, length: range.length },
    });
    if (!object || !('body' in object) || !object.body) {
      return json({ error: 'not_found' }, { status: 404 });
    }
    headers.set('content-range', `bytes ${range.offset}-${range.end}/${head.size}`);
    headers.set('content-length', String(range.length));
    return new Response(object.body, { status: 206, headers });
  }

  const object = await env.MEDIA.get(key);
  if (!object || !('body' in object) || !object.body) {
    return json({ error: 'not_found' }, { status: 404 });
  }
  headers.set('content-length', String(head.size));
  return new Response(object.body, { status: 200, headers });
}

async function handle(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
  bodyless: boolean,
): Promise<Response> {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const env = auth.env;

  const { id } = await ctx.params;
  const assetId = decodeURIComponent(id).replace(/\.[a-z0-9]+$/i, '');
  if (!SHA256.test(assetId)) return json({ error: 'not_found' }, { status: 404 });

  const variant = new URL(request.url).searchParams.get('variant') ?? 'orig';
  if (variant !== 'orig' && variant !== 'view') {
    return json({ error: 'bad_variant' }, { status: 400 });
  }

  const asset = await getAsset(env, assetId);
  if (!asset) return json({ error: 'not_found' }, { status: 404 });

  if (variant === 'orig') return serve(env, request, asset.orig_key, asset.mime, bodyless);

  // A video whose original is already browser-safe has no proxy and does not
  // need one; anything else without a `view_key` is still mid-upload.
  const key = asset.view_is_original === 1 ? asset.orig_key : asset.view_key;
  if (!key) return json({ error: 'developing' }, { status: 404 });
  return serve(env, request, key, asset.kind === 'video' ? 'video/mp4' : asset.mime, bodyless);
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(request, ctx, false);
}

export async function HEAD(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const response = await handle(request, ctx, true);
  return new Response(null, { status: response.status, headers: response.headers });
}
