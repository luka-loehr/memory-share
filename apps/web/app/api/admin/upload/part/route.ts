import { requireAdmin } from '@/lib/admin/auth';
import { readUploadId, writeReceipt } from '@/lib/admin/upload';
import { json } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** R2's own ceiling on a multipart upload. */
const MAX_PART = 10_000;

/**
 * One part of a multipart upload.
 *
 * The body is buffered rather than streamed into R2: `uploadPart` needs a known
 * length for every part but the last, and the CLI sends 64 MB parts by default,
 * which fits a Worker's memory with room to spare. The cap below is what stops
 * a mistaken part size from taking the isolate down instead of returning an
 * error.
 */
const MAX_PART_BYTES = 96 * 1024 * 1024;

export async function PUT(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const env = auth.env;

  const url = new URL(request.url);
  const token = url.searchParams.get('uploadId');
  const part = Number(url.searchParams.get('part'));

  if (!token || !Number.isInteger(part) || part < 1 || part > MAX_PART) {
    return json({ error: 'bad_request' }, { status: 400 });
  }

  const session = await readUploadId(env, token);
  // A token this Worker did not mint names no key here. Indistinguishable from
  // one that has expired, which is what a resume after R2 drops the session hits.
  if (!session) return json({ error: 'unknown_upload' }, { status: 404 });

  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_PART_BYTES) {
    return json({ error: 'part_too_large' }, { status: 413 });
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return json({ error: 'empty_part' }, { status: 400 });
  if (bytes.byteLength > MAX_PART_BYTES) {
    return json({ error: 'part_too_large' }, { status: 413 });
  }

  const upload = env.MEDIA.resumeMultipartUpload(session.key, session.r2);
  let uploaded: R2UploadedPart;
  try {
    uploaded = await upload.uploadPart(part, bytes);
  } catch {
    // R2 expires an abandoned multipart session; the CLI must start it over
    // rather than retry this part forever.
    return json({ error: 'unknown_upload' }, { status: 404 });
  }

  // Recorded so `GET /upload/:uploadId/parts` can answer, which is what lets a
  // resume work from a machine that never held the local journal.
  await writeReceipt(env, token, {
    part,
    etag: uploaded.etag,
    size: bytes.byteLength,
  });

  return json({ etag: uploaded.etag });
}
