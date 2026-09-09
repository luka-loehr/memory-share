import type { Env } from '../env';
import type { DeriveState } from '../memory';

/**
 * The owner's view of an asset. Unlike the share manifest this DOES carry the
 * R2 keys and the derivation state: the owner is the one person entitled to
 * know where the bytes live, and the CLI prints exactly these columns.
 */
export type AdminAsset = {
  id: string;
  filename: string;
  kind: 'photo' | 'video';
  mime: string;
  bytes: number;
  width: number;
  height: number;
  duration: number | null;
  taken_at: number | null;
  orig_key: string;
  view_key: string | null;
  thumb_key: string | null;
  view_is_original: number;
  derive_state: DeriveState;
  derive_error: string | null;
  derive_attempts: number;
  created_at: number;
  tags: string[];
};

const COLUMNS = `a.id, a.filename, a.kind, a.mime, a.bytes, a.width, a.height, a.duration,
       a.taken_at, a.orig_key, a.view_key, a.thumb_key, a.view_is_original,
       a.derive_state, a.derive_error, a.derive_attempts, a.created_at`;

export type Row = Omit<AdminAsset, 'tags'>;

/**
 * Tags in one extra query rather than a GROUP_CONCAT join, so a page of assets
 * costs two statements regardless of how many tags each carries.
 */
/**
 * D1 refuses a statement with more than 100 bound parameters, and this binds
 * one per asset id. A page of 200 (the route's default) therefore failed with a
 * bare 500 as soon as a real library grew past 100 assets — invisible against
 * small fixtures, fatal on the first genuine import. Chunked well under the
 * limit instead.
 */
const D1_MAX_BOUND_PARAMS = 90;

export async function withTags(env: Env, rows: Row[]): Promise<AdminAsset[]> {
  if (rows.length === 0) return [];

  const byAsset = new Map<string, string[]>();

  for (let start = 0; start < rows.length; start += D1_MAX_BOUND_PARAMS) {
    const ids = rows.slice(start, start + D1_MAX_BOUND_PARAMS).map((row) => row.id);
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ');
    const { results } = await env.DB.prepare(
      `SELECT at.asset_id, t.name
         FROM asset_tags at JOIN tags t ON t.id = at.tag_id
        WHERE at.asset_id IN (${placeholders})
        ORDER BY t.name ASC`,
    )
      .bind(...ids)
      .all<{ asset_id: string; name: string }>();

    for (const row of results ?? []) {
      const list = byAsset.get(row.asset_id);
      if (list) list.push(row.name);
      else byAsset.set(row.asset_id, [row.name]);
    }
  }

  return rows.map((row) => ({ ...row, tags: byAsset.get(row.id) ?? [] }));
}

export async function getAsset(env: Env, id: string): Promise<AdminAsset | null> {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM assets a WHERE a.id = ?1`)
    .bind(id)
    .first<Row>();
  if (!row) return null;
  return (await withTags(env, [row]))[0] ?? null;
}

export type AssetPage = { assets: AdminAsset[]; cursor?: string };

/**
 * Keyset pagination on `(created_at, id)`, not OFFSET.
 *
 * A library grows at the front, so an offset-based page 2 would skip or repeat
 * rows as uploads land mid-walk. The cursor is the last row's sort key, which
 * is stable whatever else arrives.
 */
export async function listAssetsPage(
  env: Env,
  query: { tag?: string; kind?: string; limit: number; cursor?: string },
): Promise<AssetPage> {
  const binds: (string | number)[] = [];
  const where: string[] = [];

  if (query.kind) {
    binds.push(query.kind);
    where.push(`a.kind = ?${binds.length}`);
  }
  if (query.tag) {
    binds.push(query.tag);
    where.push(
      `EXISTS (SELECT 1 FROM asset_tags at JOIN tags t ON t.id = at.tag_id
                WHERE at.asset_id = a.id AND t.name = ?${binds.length})`,
    );
  }

  const after = decodeCursor(query.cursor);
  if (after) {
    binds.push(after.createdAt, after.createdAt, after.id);
    where.push(
      `(a.created_at < ?${binds.length - 2}
        OR (a.created_at = ?${binds.length - 1} AND a.id > ?${binds.length}))`,
    );
  }

  binds.push(query.limit + 1);
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM assets a
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.created_at DESC, a.id ASC
      LIMIT ?${binds.length}`,
  )
    .bind(...binds)
    .all<Row>();

  const rows = results ?? [];
  // One row over the limit is how we know another page exists without counting.
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    assets: await withTags(env, page),
    cursor: rows.length > query.limit && last ? encodeCursor(last.created_at, last.id) : undefined,
  };
}

function encodeCursor(createdAt: number, id: string): string {
  return btoa(`${createdAt}:${id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(value?: string): { createdAt: number; id: string } | null {
  if (!value) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const colon = raw.indexOf(':');
    if (colon <= 0) return null;
    const createdAt = Number(raw.slice(0, colon));
    if (!Number.isFinite(createdAt)) return null;
    return { createdAt, id: raw.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ tags ----

/** Tag names are lowercase slugs; anything else is not a tag. */
export function normalizeTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name === '' || name.length > 64 ? null : name;
}

/**
 * Add and remove tags across a set of assets.
 *
 * Returns the number of assets that *exist*, which is what the CLI reports —
 * not the number of join rows touched, since re-adding a tag an asset already
 * carries is a legitimate no-op rather than a failure.
 */
export async function applyTags(
  env: Env,
  assetIds: string[],
  add: string[],
  remove: string[],
): Promise<number> {
  // Same D1 bound-parameter ceiling as withTags: one `?` per id, so tagging a
  // real import in one call (the CLI tags the whole batch at the end of a run)
  // failed with a bare 500 the moment it exceeded 100 assets.
  const known: string[] = [];
  for (let start = 0; start < assetIds.length; start += D1_MAX_BOUND_PARAMS) {
    const slice = assetIds.slice(start, start + D1_MAX_BOUND_PARAMS);
    const placeholders = slice.map((_, i) => `?${i + 1}`).join(', ');
    const { results } = await env.DB.prepare(`SELECT id FROM assets WHERE id IN (${placeholders})`)
      .bind(...slice)
      .all<{ id: string }>();
    for (const row of results ?? []) known.push(row.id);
  }
  if (known.length === 0) return 0;

  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = [];

  for (const name of add) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO tags (name, created_at) VALUES (?1, ?2) ON CONFLICT (name) DO NOTHING`,
      ).bind(name, now),
    );
  }
  for (const id of known) {
    for (const name of add) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO asset_tags (asset_id, tag_id)
                SELECT ?1, id FROM tags WHERE name = ?2
           ON CONFLICT (asset_id, tag_id) DO NOTHING`,
        ).bind(id, name),
      );
    }
    for (const name of remove) {
      statements.push(
        env.DB.prepare(
          `DELETE FROM asset_tags
             WHERE asset_id = ?1 AND tag_id = (SELECT id FROM tags WHERE name = ?2)`,
        ).bind(id, name),
      );
    }
  }

  // A batch is one statement per (asset, tag) pair, so a few hundred assets
  // produces well over a thousand. Send them in bounded groups rather than
  // discovering D1's batch ceiling on the user's first real import.
  const BATCH = 100;
  for (let start = 0; start < statements.length; start += BATCH) {
    await env.DB.batch(statements.slice(start, start + BATCH));
  }
  return known.length;
}
