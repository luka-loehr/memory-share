/**
 * Wire types, transcribed from docs/CONTRACT.md and db/migrations/0001_init.sql.
 * Anything the contract does not promise is optional here, so a worker that
 * omits a field degrades the display rather than crashing the CLI.
 */

export type AssetKind = 'photo' | 'video';

export type DeriveState = 'pending' | 'running' | 'ready' | 'failed' | 'skipped';

export interface Asset {
  id: string;
  filename: string;
  kind: AssetKind;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  duration?: number | null;
  taken_at?: number | null;
  orig_key?: string;
  thumb_key?: string | null;
  view_key?: string | null;
  view_is_original?: number;
  derive_state?: DeriveState;
  derive_error?: string | null;
  derive_attempts?: number;
  created_at?: number;
  tags?: string[];
}

export interface Memory {
  id: string;
  slug: string;
  title: string;
  note?: string | null;
  cover_asset_id?: string | null;
  allow_download?: number | boolean;
  expires_at?: number | null;
  created_at?: number;
  updated_at?: number;
  /** Not promised by the contract; used when a worker volunteers it. */
  count?: number;
  assetIds?: string[];
  assets?: Asset[];
}

/**
 * What an upload IS. Omitted or 'orig' creates an asset row at orig/<sha256>;
 * 'view' or 'thumb' writes a derivative named after its PARENT and creates no
 * row at all, which is what keeps a proxy from ever appearing in `ms ls`.
 */
export type UploadRole = 'orig' | 'view' | 'thumb';

/** POST /api/admin/upload/begin */
export interface BeginBody {
  /** For a derivative this is the derivative's own hash — an integrity check only. */
  sha256: string;
  filename: string;
  bytes: number;
  mime: string;
  role?: UploadRole;
  /** REQUIRED when role is 'view' or 'thumb': the ORIGINAL's sha256. */
  ofAsset?: string;
  /** Locally probed, and contracted as optional on `begin`. */
  width?: number;
  height?: number;
  duration?: number;
  takenAt?: number;
  kind?: AssetKind;
  /**
   * Set for a video whose original is already browser-safe, so no view
   * derivative follows. NOT in the contract — see NOTES.md. Without it the
   * worker cannot distinguish "no proxy is coming" from "the proxy has not
   * arrived yet", and such a video stays `derive_state='pending'` forever.
   * Inert for a worker that ignores it.
   */
  viewIsOriginal?: boolean;
}

export interface BeginResponse {
  assetId: string;
  exists: boolean;
  /**
   * Always present for a new asset: the contract states uploads are multipart
   * whatever the size, so there is no presigned single-shot URL to fall back to.
   */
  uploadId?: string;
}

/** GET /api/admin/upload/:uploadId/parts — server-side resume. */
export interface UploadPartsResponse {
  parts: { part: number; etag: string; size?: number }[];
}

export interface PartResponse {
  etag: string;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface CompleteBody {
  uploadId: string;
  parts: UploadedPart[];
}

/** `{asset}` for an original, `{ok}` for a derivative. */
export interface CompleteResponse {
  asset?: Asset;
  ok?: boolean;
}

export interface AssetsResponse {
  assets: Asset[];
  cursor?: string;
}

export interface TagResponse {
  updated: number;
}

export interface MemoriesResponse {
  memories: Memory[];
}

export interface CreateMemoryBody {
  title: string;
  note?: string;
  assetIds: string[];
  password?: string;
  allowDownload?: boolean;
  expiresAt?: number;
}

export interface CreateMemoryResponse {
  memory: Memory;
  password: string;
}

export interface PatchMemoryBody {
  title?: string;
  note?: string;
  add?: string[];
  remove?: string[];
  cover?: string;
  allowDownload?: boolean;
  expiresAt?: number;
}

/** GET /api/admin/memories/:slug */
export interface MemoryDetailResponse {
  memory: Memory;
  items: Asset[];
}

export interface MemoryResponse {
  memory: Memory;
}

export interface RotateResponse {
  password: string;
}

export interface DeletedResponse {
  deleted: boolean | number;
}

export interface StatusResponse {
  assets: number;
  memories: number;
  bytes: number;
  derive: { pending: number; running: number; failed: number };
}
