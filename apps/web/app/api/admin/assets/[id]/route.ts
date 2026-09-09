import { getAsset } from '@/lib/admin/assets';
import { requireAdmin } from '@/lib/admin/auth';
import { SHA256 } from '@/lib/admin/upload';
import { json } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * The only call in the system that destroys bytes.
 *
 * Contrast `DELETE /api/admin/memories/:slug`, which touches `memory_assets`
 * and nothing else. That asymmetry is the product: an album is a view, and
 * throwing away the view must never throw away the photographs. Here the
 * opposite is true and deliberate — the asset leaves the pool, its objects
 * leave R2, and it disappears from every memory that referenced it.
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const env = auth.env;

  const { id } = await ctx.params;
  const assetId = decodeURIComponent(id);
  if (!SHA256.test(assetId)) return json({ error: 'not_found' }, { status: 404 });

  const asset = await getAsset(env, assetId);
  if (!asset) return json({ error: 'not_found' }, { status: 404 });

  // Bytes first. A row without objects is a visible, fixable inconsistency; an
  // object without a row is unreachable garbage nothing will ever collect.
  const keys = [asset.orig_key, asset.view_key, asset.thumb_key].filter(
    (key): key is string => typeof key === 'string' && key !== '',
  );
  if (keys.length > 0) await env.MEDIA.delete(keys);

  // Explicit rather than left to ON DELETE CASCADE: the join rows going away is
  // the whole meaning of this call, so it is written down rather than inferred
  // from a pragma that may or may not be on.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM asset_tags WHERE asset_id = ?1`).bind(assetId),
    env.DB.prepare(`DELETE FROM memory_assets WHERE asset_id = ?1`).bind(assetId),
    env.DB.prepare(`UPDATE memories SET cover_asset_id = NULL WHERE cover_asset_id = ?1`).bind(
      assetId,
    ),
    env.DB.prepare(`DELETE FROM assets WHERE id = ?1`).bind(assetId),
  ]);

  return json({ deleted: true });
}
