import { env as bindings } from '@/lib/env';
import { findMemory, isExpired } from '@/lib/memory';
import { developingPlate } from '@/lib/plate';

export const dynamic = 'force-dynamic';

/**
 * The one share route that answers without a cookie.
 *
 * It must therefore never emit a legible photograph. The bytes leaving here are
 * a 64px-wide, heavily blurred rendering of the cover — enough colour for the
 * gate's shader to breathe with, far too little to recognise a face. Degrading
 * server-side rather than in the browser is the point: a client-side dither
 * would still have shipped the real frame to anyone reading the network tab.
 */

const COVER_WIDTH = 64;

function plateResponse(seed: string): Response {
  const png = developingPlate(seed);
  return new Response(png as unknown as BodyInit, {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=600',
      'x-cover-source': 'plate',
    },
  });
}

export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const env = await bindings();

  const memory = await findMemory(env, slug);
  // A missing or expired memory still gets a plate: the gate should look the
  // same whether the link is wrong or merely locked.
  if (!memory || isExpired(memory)) return plateResponse(slug);

  // Photos keep no derivatives, so the cover is transformed from the original.
  // Any asset in the album will do if the chosen cover is unusable.
  const row = await env.DB.prepare(
    `SELECT a.orig_key
       FROM memory_assets ma
       JOIN assets a ON a.id = ma.asset_id
      WHERE ma.memory_id = ?1 AND a.kind = 'photo' AND (?2 IS NULL OR a.id = ?2)
      ORDER BY ma.position ASC
      LIMIT 1`,
  )
    .bind(memory.id, memory.cover_asset_id)
    .first<{ orig_key: string }>();

  const key =
    row?.orig_key ??
    (
      await env.DB.prepare(
        `SELECT a.orig_key FROM memory_assets ma
           JOIN assets a ON a.id = ma.asset_id
          WHERE ma.memory_id = ?1 AND a.kind = 'photo'
          ORDER BY ma.position ASC LIMIT 1`,
      )
        .bind(memory.id)
        .first<{ orig_key: string }>()
    )?.orig_key;

  if (!key) return plateResponse(slug);

  const object = await env.MEDIA.get(key);
  if (!object || !('body' in object) || !object.body) return plateResponse(slug);

  // The Images binding is optional: without it the plate is the answer, which
  // is why the plate had to look deliberate rather than like a fallback.
  const images = env.IMAGES;
  if (!images) return plateResponse(slug);

  try {
    const result = await images
      .input(object.body)
      .transform({ width: COVER_WIDTH, blur: 40 })
      .output({ format: 'image/jpeg', quality: 60 });

    const response = result.response();
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'public, max-age=600');
    headers.set('x-cover-source', 'derived');
    return new Response(response.body, { status: 200, headers });
  } catch {
    // No Images binding, or a frame it cannot decode. The plate is a complete
    // answer, not an error state — the gate is designed around it looking good.
    return plateResponse(slug);
  }
}
