import type { Env } from './env';

/** Derivative pipeline states, mirroring the CHECK constraint in 0001_init.sql. */
export type DeriveState = 'pending' | 'running' | 'ready' | 'failed' | 'skipped';

export type MemoryRow = {
  id: string;
  slug: string;
  title: string;
  note: string | null;
  password_hash: string;
  cover_asset_id: string | null;
  allow_download: number;
  expires_at: number | null;
};

export type AssetRow = {
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
  position: number;
};

/** One entry of the manifest, as the browser sees it. */
export type ManifestItem = {
  id: string;
  kind: 'photo' | 'video';
  filename: string;
  bytes: number;
  width: number;
  height: number;
  duration: number | null;
  takenAt: number | null;
  state: DeriveState;
};

export type Manifest = {
  title: string;
  note: string | null;
  allowDownload: boolean;
  items: ManifestItem[];
};

export async function findMemory(env: Env, slug: string): Promise<MemoryRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, slug, title, note, password_hash, cover_asset_id, allow_download, expires_at
       FROM memories WHERE slug = ?1`,
  )
    .bind(slug)
    .first<MemoryRow>();
  return row ?? null;
}

/** A memory past its expiry is gone as far as every share route is concerned. */
export function isExpired(memory: MemoryRow): boolean {
  return memory.expires_at !== null && memory.expires_at < Math.floor(Date.now() / 1000);
}

export async function listAssets(env: Env, memoryId: string): Promise<AssetRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.filename, a.kind, a.mime, a.bytes, a.width, a.height, a.duration,
            a.taken_at, a.orig_key, a.view_key, a.thumb_key, a.view_is_original,
            a.derive_state, ma.position
       FROM memory_assets ma
       JOIN assets a ON a.id = ma.asset_id
      WHERE ma.memory_id = ?1
      ORDER BY ma.position ASC, a.taken_at ASC, a.id ASC`,
  )
    .bind(memoryId)
    .all<AssetRow>();
  return results ?? [];
}

export function toManifest(memory: MemoryRow, assets: AssetRow[]): Manifest {
  return {
    title: memory.title,
    note: memory.note,
    allowDownload: memory.allow_download === 1,
    items: assets.map((a) => ({
      id: a.id,
      kind: a.kind,
      filename: a.filename,
      bytes: a.bytes,
      width: a.width,
      height: a.height,
      duration: a.duration,
      takenAt: a.taken_at,
      state: a.derive_state,
    })),
  };
}

/** The three URL shapes a share page may ask for. */
export type Variant = 'thumb' | 'view' | 'orig';

export function isVariant(value: string): value is Variant {
  return value === 'thumb' || value === 'view' || value === 'orig';
}

export type ResolvedAsset = Pick<
  AssetRow,
  | 'id'
  | 'filename'
  | 'mime'
  | 'kind'
  | 'bytes'
  | 'width'
  | 'height'
  | 'orig_key'
  | 'view_key'
  | 'thumb_key'
  | 'view_is_original'
  | 'derive_state'
>;

/**
 * Resolve a content hash against *this* memory.
 *
 * The whole point is the WHERE clause: knowing a sha256 from one album grants
 * nothing in another, because the asset must be reachable through this memory's
 * join rows. A miss is a 404, not a 403 — a share link should not confirm that
 * some other album holds that photograph.
 */
export async function resolveAssetInMemory(
  env: Env,
  memoryId: string,
  assetId: string,
): Promise<ResolvedAsset | null> {
  const row = await env.DB.prepare(
    `SELECT a.id, a.filename, a.mime, a.kind, a.bytes, a.width, a.height,
            a.orig_key, a.view_key, a.thumb_key, a.view_is_original, a.derive_state
       FROM memory_assets ma
       JOIN assets a ON a.id = ma.asset_id
      WHERE ma.memory_id = ?1 AND a.id = ?2
      LIMIT 1`,
  )
    .bind(memoryId, assetId)
    .first<ResolvedAsset>();
  return row ?? null;
}

export async function logAccess(
  env: Env,
  memoryId: string,
  outcome: 'unlocked' | 'rejected',
): Promise<void> {
  await env.DB.prepare(`INSERT INTO access_log (memory_id, at, outcome) VALUES (?1, ?2, ?3)`)
    .bind(memoryId, Math.floor(Date.now() / 1000), outcome)
    .run();
}

/** Rejected attempts inside the window, used to throttle guessing at the gate. */
export async function recentRejections(
  env: Env,
  memoryId: string,
  windowSeconds: number,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM access_log
      WHERE memory_id = ?1 AND outcome = 'rejected' AND at > ?2`,
  )
    .bind(memoryId, Math.floor(Date.now() / 1000) - windowSeconds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
