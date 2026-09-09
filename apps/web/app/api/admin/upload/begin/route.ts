import { requireAdmin } from '@/lib/admin/auth';
import { int, num, readJson, str } from '@/lib/admin/parse';
import {
  keyFor,
  mintUploadId,
  SHA256,
  type UploadRole,
  type UploadSession,
} from '@/lib/admin/upload';
import { json } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * Open an upload.
 *
 * Two things happen here and nowhere else: the decision of what an upload IS
 * (`role`), and the decision of the R2 key it lands at. Everything downstream
 * carries that decision inside the signed upload token, so no later request can
 * revisit either.
 *
 * There is no presigned-URL branch. Uploads are always multipart whatever the
 * size — one code path, and a one-part upload costs nothing extra — which is
 * what lets the bucket keep no public or presigned surface at all.
 */
export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const env = auth.env;

  const body = await readJson(request);
  if (!body) return json({ error: 'bad_request' }, { status: 400 });

  const sha256 = str(body.sha256, 64);
  if (!sha256 || !SHA256.test(sha256)) {
    return json({ error: 'bad_sha256' }, { status: 400 });
  }

  const filename = str(body.filename, 255);
  const mime = str(body.mime, 255);
  const bytes = int(body.bytes, 0);
  if (!filename || !mime || bytes === null) {
    return json({ error: 'bad_request' }, { status: 400 });
  }

  const rawRole = body.role === undefined || body.role === null ? 'orig' : body.role;
  if (rawRole !== 'orig' && rawRole !== 'view' && rawRole !== 'thumb') {
    return json({ error: 'bad_role' }, { status: 400 });
  }
  const role: UploadRole = rawRole;

  // ------------------------------------------------------------ derivative --
  if (role !== 'orig') {
    const ofAsset = str(body.ofAsset, 64);
    if (!ofAsset || !SHA256.test(ofAsset)) {
      return json({ error: 'bad_of_asset' }, { status: 400 });
    }

    // Order matters: the original goes first. A derivative whose parent has no
    // row is refused rather than orphaned at a key nothing will ever read.
    const parent = await env.DB.prepare(`SELECT id FROM assets WHERE id = ?1`)
      .bind(ofAsset)
      .first<{ id: string }>();
    if (!parent) return json({ error: 'no_such_parent' }, { status: 409 });

    const key = keyFor(role, sha256, ofAsset);
    const multipart = await env.MEDIA.createMultipartUpload(key, {
      httpMetadata: { contentType: role === 'view' ? 'video/mp4' : 'image/jpeg' },
    });

    const session: UploadSession = {
      key,
      r2: multipart.uploadId,
      role,
      sha256,
      ofAsset,
      bytes,
    };
    // `assetId` is the PARENT's id: a derivative is not an asset and gets no id
    // of its own. `exists` is always false — a stored proxy cannot be compared
    // against an incoming one, because a derivative's hash is never persisted,
    // so re-uploading is the only way to be sure the bytes are the current ones.
    return json({ assetId: ofAsset, exists: false, uploadId: await mintUploadId(env, session) });
  }

  // -------------------------------------------------------------- original --
  // Content addressed: the same photograph from a different folder, a different
  // phone, or a re-run of an interrupted import is a no-op, not a duplicate.
  const existing = await env.DB.prepare(`SELECT id FROM assets WHERE id = ?1`)
    .bind(sha256)
    .first<{ id: string }>();
  if (existing) return json({ assetId: sha256, exists: true });

  const kindHint = body.kind === 'photo' || body.kind === 'video' ? body.kind : null;
  const kind = kindHint ?? (mime.startsWith('video/') ? 'video' : 'photo');

  const key = keyFor('orig', sha256);
  const multipart = await env.MEDIA.createMultipartUpload(key, {
    httpMetadata: { contentType: mime },
  });

  const session: UploadSession = {
    key,
    r2: multipart.uploadId,
    role: 'orig',
    sha256,
    bytes,
    meta: {
      filename,
      kind,
      mime,
      width: int(body.width, 0) ?? 0,
      height: int(body.height, 0) ?? 0,
      duration: num(body.duration),
      takenAt: int(body.takenAt, 0),
    },
  };

  return json({ assetId: sha256, exists: false, uploadId: await mintUploadId(env, session) });
}
