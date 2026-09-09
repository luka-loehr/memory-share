import { requireAdmin } from '@/lib/admin/auth';
import { findAdminMemory, memoryItems, nextPosition, unknownAssets } from '@/lib/admin/memories';
import { bool, idList, int, readJson, str } from '@/lib/admin/parse';
import { json } from '@/lib/http';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ slug: string }> };

/** Full membership, which the list endpoint deliberately does not carry. */
export async function GET(request: Request, ctx: Ctx) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const { slug } = await ctx.params;
  const memory = await findAdminMemory(auth.env, slug);
  if (!memory) return json({ error: 'not_found' }, { status: 404 });

  return json({ memory, items: await memoryItems(auth.env, memory.id) });
}

/**
 * Edit an album: its title, its note, its cover, its membership.
 *
 * `add` and `remove` are set operations rather than a replacement list, so two
 * `ms memory add` runs against the same album cannot lose each other's work.
 */
export async function PATCH(request: Request, ctx: Ctx) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const env = auth.env;

  const { slug } = await ctx.params;
  const memory = await findAdminMemory(env, slug);
  if (!memory) return json({ error: 'not_found' }, { status: 404 });

  const body = await readJson(request);
  if (!body) return json({ error: 'bad_request' }, { status: 400 });

  const add = body.add === undefined ? [] : idList(body.add);
  const remove = body.remove === undefined ? [] : idList(body.remove);
  if (!add || !remove) return json({ error: 'bad_asset_ids' }, { status: 400 });

  const missing = await unknownAssets(env, add);
  if (missing.length > 0) {
    return json({ error: 'unknown_assets', assets: missing }, { status: 400 });
  }

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];

  if (body.title !== undefined) {
    const title = str(body.title, 200);
    if (!title) return json({ error: 'bad_title' }, { status: 400 });
    binds.push(title);
    sets.push(`title = ?${binds.length}`);
    // The slug is NOT re-derived. It is the link people already hold, and a
    // rename must not quietly break every message it was pasted into.
  }
  if (body.note !== undefined) {
    binds.push(body.note === null ? null : str(body.note, 2000));
    sets.push(`note = ?${binds.length}`);
  }
  if (body.allowDownload !== undefined) {
    const allow = bool(body.allowDownload);
    if (allow === null) return json({ error: 'bad_request' }, { status: 400 });
    binds.push(allow ? 1 : 0);
    sets.push(`allow_download = ?${binds.length}`);
  }
  if (body.expiresAt !== undefined) {
    const expires = body.expiresAt === null ? null : int(body.expiresAt, 0);
    if (body.expiresAt !== null && expires === null) {
      return json({ error: 'bad_expiry' }, { status: 400 });
    }
    binds.push(expires);
    sets.push(`expires_at = ?${binds.length}`);
  }
  if (body.cover !== undefined) {
    const cover = body.cover === null ? null : str(body.cover, 64);
    if (cover !== null) {
      // A cover the album does not contain would render as a broken gate.
      const member = await env.DB.prepare(
        `SELECT 1 AS hit FROM memory_assets WHERE memory_id = ?1 AND asset_id = ?2`,
      )
        .bind(memory.id, cover)
        .first<{ hit: number }>();
      const incoming = add.includes(cover);
      if (!member && !incoming) return json({ error: 'cover_not_in_memory' }, { status: 400 });
    }
    binds.push(cover);
    sets.push(`cover_asset_id = ?${binds.length}`);
  }

  const now = Math.floor(Date.now() / 1000);
  binds.push(now);
  sets.push(`updated_at = ?${binds.length}`);
  binds.push(memory.id);

  const statements = [
    env.DB.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?${binds.length}`).bind(
      ...binds,
    ),
  ];

  let position = await nextPosition(env, memory.id);
  for (const assetId of add) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO memory_assets (memory_id, asset_id, position) VALUES (?1, ?2, ?3)
         ON CONFLICT (memory_id, asset_id) DO NOTHING`,
      ).bind(memory.id, assetId, position++),
    );
  }
  for (const assetId of remove) {
    statements.push(
      env.DB.prepare(`DELETE FROM memory_assets WHERE memory_id = ?1 AND asset_id = ?2`).bind(
        memory.id,
        assetId,
      ),
    );
    // Removing the cover leaves the gate without one rather than dangling.
    statements.push(
      env.DB.prepare(
        `UPDATE memories SET cover_asset_id = NULL WHERE id = ?1 AND cover_asset_id = ?2`,
      ).bind(memory.id, assetId),
    );
  }

  await env.DB.batch(statements);

  const updated = await findAdminMemory(env, slug);
  if (!updated) return json({ error: 'not_found' }, { status: 404 });
  return json({ memory: updated });
}

/**
 * Delete an album — and ONLY the album.
 *
 * Every statement below names `memory_id`. Nothing here reaches `assets` and
 * nothing here touches R2, because a memory is a view over bytes that go on
 * existing in the pool and in every other album that references them. The one
 * call that does destroy bytes is `DELETE /api/admin/assets/:id`, and it is a
 * different route on purpose.
 */
export async function DELETE(request: Request, ctx: Ctx) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const env = auth.env;

  const { slug } = await ctx.params;
  const memory = await findAdminMemory(env, slug);
  if (!memory) return json({ error: 'not_found' }, { status: 404 });

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM memory_assets WHERE memory_id = ?1`).bind(memory.id),
    env.DB.prepare(`DELETE FROM access_log WHERE memory_id = ?1`).bind(memory.id),
    env.DB.prepare(`DELETE FROM memories WHERE id = ?1`).bind(memory.id),
  ]);

  return json({ deleted: true, assetsDeleted: 0 });
}
