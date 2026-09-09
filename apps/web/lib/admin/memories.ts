import type { Env } from '../env';
import { type AdminAsset, withTags } from './assets';

/** A memory as the owner sees it. `password_hash` is never in this shape. */
export type AdminMemory = {
  id: string;
  slug: string;
  title: string;
  note: string | null;
  cover_asset_id: string | null;
  allow_download: number;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  count: number;
};

const COLUMNS = `m.id, m.slug, m.title, m.note, m.cover_asset_id, m.allow_download,
       m.expires_at, m.created_at, m.updated_at,
       (SELECT COUNT(*) FROM memory_assets ma WHERE ma.memory_id = m.id) AS count`;

export async function listMemories(env: Env): Promise<AdminMemory[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM memories m ORDER BY m.created_at DESC`,
  ).all<AdminMemory>();
  return results ?? [];
}

export async function findAdminMemory(env: Env, slug: string): Promise<AdminMemory | null> {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM memories m WHERE m.slug = ?1`)
    .bind(slug)
    .first<AdminMemory>();
  return row ?? null;
}

/** Full membership, in the order the share page will render it. */
export async function memoryItems(
  env: Env,
  memoryId: string,
): Promise<(AdminAsset & { position: number })[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.filename, a.kind, a.mime, a.bytes, a.width, a.height, a.duration,
            a.taken_at, a.orig_key, a.view_key, a.thumb_key, a.view_is_original,
            a.derive_state, a.derive_error, a.derive_attempts, a.created_at, ma.position
       FROM memory_assets ma
       JOIN assets a ON a.id = ma.asset_id
      WHERE ma.memory_id = ?1
      ORDER BY ma.position ASC, a.taken_at ASC, a.id ASC`,
  )
    .bind(memoryId)
    .all<AdminAsset & { position: number }>();
  const rows = results ?? [];
  const tagged = await withTags(env, rows);
  // Positions come off the join, not the asset row, so they are stitched back on.
  return tagged.map((asset, index) => ({ ...asset, position: rows[index].position }));
}

// ------------------------------------------------------------------ slug ----

/**
 * A slug is derived from the title, never from the id: the link a person is
 * sent should say what it is. Non-ASCII is transliterated away rather than
 * percent-encoded, so "Kroatien '24" becomes "kroatien-24".
 */
export function slugify(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base === '' ? 'memory' : base;
}

/**
 * Collision suffix. Two albums called "Christmas" are entirely reasonable, so
 * the second becomes `christmas-2` rather than an error.
 */
export async function uniqueSlug(env: Env, title: string): Promise<string> {
  const base = slugify(title);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const row = await env.DB.prepare(`SELECT 1 AS hit FROM memories WHERE slug = ?1`)
      .bind(candidate)
      .first<{ hit: number }>();
    if (!row) return candidate;
  }
  // Exhausted a thousand namesakes: fall back to something certainly free.
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Where the next added asset sits, so `memory add` appends rather than shuffles. */
export async function nextPosition(env: Env, memoryId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(MAX(position), -1) AS top FROM memory_assets WHERE memory_id = ?1`,
  )
    .bind(memoryId)
    .first<{ top: number }>();
  return (row?.top ?? -1) + 1;
}

/**
 * Which of these ids are not in the pool. Used to refuse a bad membership edit.
 *
 * Chunked because D1 refuses a statement carrying more than 100 bound
 * parameters, and this binds one per id. Creating a memory from a tag that
 * matches a real library — the ordinary case, and the entire point of the
 * product — sends hundreds at once.
 */
const D1_MAX_BOUND_PARAMS = 90;

export async function unknownAssets(env: Env, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const known = new Set<string>();

  for (let start = 0; start < ids.length; start += D1_MAX_BOUND_PARAMS) {
    const slice = ids.slice(start, start + D1_MAX_BOUND_PARAMS);
    const placeholders = slice.map((_, i) => `?${i + 1}`).join(', ');
    const { results } = await env.DB.prepare(`SELECT id FROM assets WHERE id IN (${placeholders})`)
      .bind(...slice)
      .all<{ id: string }>();
    for (const row of results ?? []) known.add(row.id);
  }

  return ids.filter((id) => !known.has(id));
}
