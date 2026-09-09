import type { Env } from '../env';
import { timingSafeEqual } from '../password';
import { tokenKey } from './auth';

/**
 * Multipart session state.
 *
 * R2's binding gives no way to look a multipart upload back up from its id
 * alone — `resumeMultipartUpload` needs the KEY as well — and the schema has no
 * table for in-flight uploads. So the `uploadId` handed to the CLI is not R2's
 * id: it is a signed, opaque envelope carrying everything `part` and `complete`
 * need. Nothing is stored server-side, so a session survives a Worker restart,
 * a redeploy and a resume from a different machine.
 *
 * It is signed because a token also names an R2 key. Auth already stops
 * strangers, but a signature means not even an authenticated client can steer
 * bytes at a key of its choosing — the key is decided here, at `begin`, from
 * the content hash.
 */

const encoder = new TextEncoder();

export type UploadRole = 'orig' | 'view' | 'thumb';

export type UploadSession = {
  /** R2 key the parts are being assembled into. */
  key: string;
  /** R2's own multipart upload id. */
  r2: string;
  role: UploadRole;
  /** sha256 of the bytes being uploaded; the asset id for an original. */
  sha256: string;
  /** Parent asset id — derivatives only. */
  ofAsset?: string;
  /** Declared size, verified against the assembled object at `complete`. */
  bytes: number;
  /** Everything needed to write the assets row, for an original. */
  meta?: {
    filename: string;
    kind: 'photo' | 'video';
    mime: string;
    width: number;
    height: number;
    duration: number | null;
    takenAt: number | null;
  };
};

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function sign(env: Env, payload: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await tokenKey(env), encoder.encode(payload));
  return b64url(new Uint8Array(sig));
}

export async function mintUploadId(env: Env, session: UploadSession): Promise<string> {
  const payload = b64url(encoder.encode(JSON.stringify(session)));
  return `${payload}.${await sign(env, payload)}`;
}

/** `null` for anything not minted by this Worker with this secret. */
export async function readUploadId(env: Env, token: string): Promise<UploadSession | null> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = await sign(env, payload);
  if (!timingSafeEqual(encoder.encode(provided), encoder.encode(expected))) return null;

  try {
    const session = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as UploadSession;
    if (typeof session.key !== 'string' || typeof session.r2 !== 'string') return null;
    return session;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ keys ----

export const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Where an upload lands, decided entirely by its role.
 *
 * A derivative is named after its PARENT, never after its own hash — that is
 * what makes `view/` and `thumb/` reachable from an asset row without storing a
 * second identifier, and it is why a derivative's own sha256 appears nowhere in
 * a key.
 */
export function keyFor(role: UploadRole, sha256: string, ofAsset?: string): string {
  if (role === 'orig') return `orig/${sha256}`;
  const parent = ofAsset ?? '';
  return role === 'view' ? `view/${parent}.mp4` : `thumb/${parent}.jpg`;
}

/** The column a completed derivative writes into. */
export function columnFor(role: 'view' | 'thumb'): 'view_key' | 'thumb_key' {
  return role === 'view' ? 'view_key' : 'thumb_key';
}

// -------------------------------------------------------------- receipts ----

/**
 * Part receipts.
 *
 * R2 has no "list the parts of this multipart upload", so the contract's resume
 * endpoint needs its own record. Each completed part writes one empty object
 * under `tmp/parts/<scope>/`, carrying the etag and size in custom metadata.
 * Empty objects rather than one mutable manifest, because the CLI sends parts
 * in parallel and a read-modify-write JSON blob would lose etags to races.
 *
 * The prefix is outside `orig/`, `view/` and `thumb/`, so nothing here is
 * reachable from any serving path, and `complete` sweeps it.
 */
export type PartReceipt = { part: number; etag: string; size: number };

async function scopeOf(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function receiptPrefix(token: string): Promise<string> {
  return `tmp/parts/${await scopeOf(token)}/`;
}

export async function writeReceipt(env: Env, token: string, receipt: PartReceipt): Promise<void> {
  const prefix = await receiptPrefix(token);
  await env.MEDIA.put(`${prefix}${String(receipt.part).padStart(5, '0')}`, new Uint8Array(0), {
    customMetadata: { etag: receipt.etag, size: String(receipt.size) },
  });
}

export async function listReceipts(env: Env, token: string): Promise<PartReceipt[]> {
  const prefix = await receiptPrefix(token);
  const receipts: PartReceipt[] = [];
  let cursor: string | undefined;

  // R2 pages at 1000; a multipart upload may hold up to 10,000 parts.
  do {
    const page = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
    for (const object of page.objects) {
      const part = Number(object.key.slice(prefix.length));
      const etag = object.customMetadata?.etag;
      if (!Number.isInteger(part) || !etag) continue;
      receipts.push({ part, etag, size: Number(object.customMetadata?.size ?? 0) });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return receipts.sort((a, b) => a.part - b.part);
}

/** Best-effort sweep once the upload is finished or abandoned. */
export async function clearReceipts(env: Env, token: string): Promise<void> {
  const receipts = await listReceipts(env, token);
  if (receipts.length === 0) return;
  const prefix = await receiptPrefix(token);
  const keys = receipts.map((r) => `${prefix}${String(r.part).padStart(5, '0')}`);
  for (let i = 0; i < keys.length; i += 100) await env.MEDIA.delete(keys.slice(i, i + 100));
}
