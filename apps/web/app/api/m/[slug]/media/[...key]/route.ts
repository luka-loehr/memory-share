import type { Env } from '@/lib/env';
import { guard } from '@/lib/guard';
import { etagMatches, json, PRIVATE_MEDIA_CACHE, parseRange } from '@/lib/http';
import { isVariant, type ResolvedAsset, resolveAssetInMemory, type Variant } from '@/lib/memory';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ slug: string; key: string[] }> };

/*
 * One URL shape, three very different sources.
 *
 *   thumb/<sha>   photo: an Images transform of orig/, 480px
 *                 video: the stored poster frame
 *   view/<sha>    photo: an Images transform of orig/, 2560px
 *                 video: view/<sha>.mp4, Range-streamed
 *   orig/<sha>    the untouched original, Range-streamed, gated on allow_download
 *
 * The client is never told which of these it got, which is why the manifest
 * carries only content hashes.
 */

/** Photos are transformed at read time; the sizes come from the contract. */
const TRANSFORM = {
  thumb: { width: 480, format: 'image/webp' as const },
  view: { width: 2560, format: 'image/jpeg' as const },
};

/**
 * Derivatives are named after their PARENT's hash, so a poster frame is
 * addressable from the asset row alone. `thumb_key` is authoritative; the
 * convention is the fallback for a row written before the column was filled.
 */
function posterKey(asset: ResolvedAsset): string {
  return asset.thumb_key ?? `thumb/${asset.id}.jpg`;
}

function baseHeaders(etag: string, contentType: string, seekable: boolean): Headers {
  const headers = new Headers({
    'content-type': contentType,
    etag,
    // Media is per-session: a locked session must not be able to replay the
    // album out of the browser cache. `no-cache` still allows revalidation, so
    // the 304 path below keeps repeat views cheap.
    'cache-control': PRIVATE_MEDIA_CACHE,
    vary: 'Cookie, Range',
    'x-content-type-options': 'nosniff',
  });
  // Only claim Range support where we can actually honour it. A transformed
  // photo is produced per request and has no stable byte offsets.
  if (seekable) headers.set('accept-ranges', 'bytes');
  return headers;
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Stream an R2 object, honouring Range and If-None-Match.
 *
 * HEAD first, always: it yields the size that Range arithmetic needs and the
 * ETag that answers a conditional request — and it is why `onlyIf` is never
 * passed to `get()`, which would throw when combined with `range`.
 */
async function serveObject(
  env: Env,
  request: Request,
  key: string,
  fallbackType: string,
  extra?: (headers: Headers) => void,
  bodyless = false,
): Promise<Response> {
  const head = await env.MEDIA.head(key);
  if (!head) return json({ error: 'not_found' }, { status: 404 });

  const contentType = head.httpMetadata?.contentType ?? fallbackType;
  const headers = baseHeaders(head.httpEtag, contentType, true);
  headers.set('last-modified', head.uploaded.toUTCString());
  extra?.(headers);

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

/**
 * A photo rendition, transformed from the original on the way out.
 *
 * The entity tag is synthesised rather than taken from R2: the output is a pure
 * function of (original bytes, variant), and the original is immutable by
 * invariant 1, so the hash and the variant name identify it exactly. That is
 * what lets a conditional request still short-circuit even though nothing was
 * stored.
 */
async function serveTransform(
  env: Env,
  request: Request,
  asset: ResolvedAsset,
  variant: 'thumb' | 'view',
  bodyless: boolean,
  /** Whether this memory permits the untouched original to leave at all. */
  mayServeOriginal: boolean,
): Promise<Response> {
  // Transform from the stored bounded rendition when one exists. It only exists
  // for a source too large for the Images binding to accept, which is exactly
  // the case where transforming from the original would fail — so this is what
  // keeps an oversized photo's THUMBNAIL working, not just its view.
  const source = asset.view_key ?? asset.orig_key;
  const etag = `W/"${asset.id}-${variant}"`;
  const spec = TRANSFORM[variant];

  const headers = baseHeaders(etag, spec.format, false);
  if (etagMatches(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }
  if (bodyless) return new Response(null, { status: 200, headers });

  const images = env.IMAGES;
  const object = await env.MEDIA.get(source);
  if (!object || !('body' in object) || !object.body) {
    return json({ error: 'not_found' }, { status: 404 });
  }

  if (images) {
    try {
      const result = await images
        .input(object.body)
        .transform({ width: spec.width })
        .output({ format: spec.format });

      const response = result.response();
      const out = new Headers(headers);
      const type = response.headers.get('content-type');
      if (type) out.set('content-type', type);
      return new Response(response.body, { status: 200, headers: out });
    } catch {
      // Images caps its input at 20 MB and cannot decode every format. Rather
      // than fail the tile, fall through and hand over the original bytes when
      // a browser can render them itself.
    }
  }

  // ...but only where the original was allowed to leave in the first place.
  // allow_download = 0 means "seen, not copied", and a transform that could not
  // run is not a licence to hand over the full-resolution file instead.
  if (mayServeOriginal && /^image\/(jpeg|png|gif|webp|avif)$/.test(asset.mime)) {
    return serveObject(env, request, asset.orig_key, asset.mime);
  }
  return json({ error: 'not_renderable' }, { status: 415 });
}

async function handle(request: Request, ctx: Ctx, bodyless: boolean): Promise<Response> {
  const { slug, key: segments } = await ctx.params;

  const gate = await guard(request, slug);
  if (!gate.ok) return gate.response;

  const [rawVariant, rawId] = segments.map((segment) => decodeURIComponent(segment));
  if (!rawVariant || !rawId || !isVariant(rawVariant)) {
    return json({ error: 'not_found' }, { status: 404 });
  }
  const variant: Variant = rawVariant;

  // Tolerate a trailing extension so the URL can look like a file if a client
  // insists; identity is the hash in front of it.
  const assetId = rawId.replace(/\.[a-z0-9]+$/i, '');

  const asset = await resolveAssetInMemory(gate.env, gate.memory.id, assetId);
  // Not in THIS memory — indistinguishable from not existing at all.
  if (!asset) return json({ error: 'not_found' }, { status: 404 });

  const url = new URL(request.url);
  const download = url.searchParams.get('dl') === '1';

  if (variant === 'orig') {
    // Originals are the one thing a memory can withhold: allow_download = 0
    // means "seen, not copied", and the renditions stay available.
    if (gate.memory.allow_download !== 1) {
      return json({ error: 'download_disabled' }, { status: 403 });
    }
    return serveObject(
      gate.env,
      request,
      asset.orig_key,
      asset.mime,
      (headers) => {
        if (download) headers.set('content-disposition', contentDisposition(asset.filename));
      },
      bodyless,
    );
  }

  if (asset.kind === 'photo') {
    // A photo normally keeps no derivative and is transformed on the way out.
    // The exception is a source too large for the Images binding to accept, for
    // which the CLI stores a bounded rendition at upload time; when that exists
    // it is a stored object like any other, and it wins.
    if (variant === 'view' && asset.view_key) {
      return serveObject(gate.env, request, asset.view_key, asset.mime, undefined, bodyless);
    }
    return serveTransform(
      gate.env,
      request,
      asset,
      variant,
      bodyless,
      gate.memory.allow_download === 1,
    );
  }

  // Video. The poster frame is a stored object; the proxy is the one thing in
  // the system that genuinely needs Range.
  if (variant === 'thumb') {
    return serveObject(gate.env, request, posterKey(asset), 'image/jpeg', undefined, bodyless);
  }

  const key = asset.view_is_original === 1 ? asset.orig_key : asset.view_key;
  // No proxy yet: the upload is still in flight. The UI shows this as
  // developing rather than broken (invariant 3).
  if (!key) return json({ error: 'developing' }, { status: 404 });

  return serveObject(gate.env, request, key, asset.mime, undefined, bodyless);
}

export async function GET(request: Request, ctx: Ctx) {
  return handle(request, ctx, false);
}

export async function HEAD(request: Request, ctx: Ctx) {
  const response = await handle(request, ctx, true);
  // Never a body on a HEAD, whatever the branch above decided to build.
  return new Response(null, { status: response.status, headers: response.headers });
}
