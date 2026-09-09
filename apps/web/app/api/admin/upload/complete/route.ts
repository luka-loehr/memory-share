import { getAsset } from '@/lib/admin/assets';
import { requireAdmin } from '@/lib/admin/auth';
import { int, readJson, str } from '@/lib/admin/parse';
import { clearReceipts, columnFor, listReceipts, readUploadId } from '@/lib/admin/upload';
import { json } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** `{partNumber, etag}` is what the CLI sends; `{part, etag}` is tolerated. */
function readParts(value: unknown): R2UploadedPart[] | null {
  if (!Array.isArray(value)) return null;
  const parts: R2UploadedPart[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') return null;
    const record = entry as Record<string, unknown>;
    const partNumber = int(record.partNumber ?? record.part, 1, 10_000);
    const etag = str(record.etag, 256);
    if (partNumber === null || !etag) return null;
    parts.push({ partNumber, etag });
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const env = auth.env;

  const body = await readJson(request);
  if (!body) return json({ error: 'bad_request' }, { status: 400 });

  const token = str(body.uploadId, 4096);
  if (!token) return json({ error: 'bad_request' }, { status: 400 });

  const session = await readUploadId(env, token);
  if (!session) return json({ error: 'unknown_upload' }, { status: 404 });

  // The client's own view of what it sent wins, because it is the side that saw
  // every etag. When it sends nothing, the receipts stand in — that is how a
  // resume from a machine without the journal can still finish the upload.
  const supplied = body.parts === undefined ? null : readParts(body.parts);
  if (body.parts !== undefined && supplied === null) {
    return json({ error: 'bad_parts' }, { status: 400 });
  }
  const parts =
    supplied && supplied.length > 0
      ? supplied
      : (await listReceipts(env, token)).map((r) => ({ partNumber: r.part, etag: r.etag }));
  if (parts.length === 0) return json({ error: 'no_parts' }, { status: 400 });

  // The CLI echoes the id `begin` gave it. For a derivative that is the PARENT's
  // id, because a derivative never has one of its own.
  const expectedId = session.role === 'orig' ? session.sha256 : (session.ofAsset ?? '');
  const claimedId = str(body.assetId, 64);
  if (claimedId && claimedId !== expectedId) {
    return json({ error: 'asset_mismatch' }, { status: 400 });
  }

  const upload = env.MEDIA.resumeMultipartUpload(session.key, session.r2);

  // ------------------------------------------------------------ derivative --
  if (session.role !== 'orig') {
    const parentId = session.ofAsset ?? '';
    // Re-checked here and not only at `begin`: the asset may have been deleted
    // while the proxy was uploading, and a derivative must never outlive the
    // row that is the only thing able to reference it.
    const parent = await env.DB.prepare(`SELECT id FROM assets WHERE id = ?1`)
      .bind(parentId)
      .first<{ id: string }>();
    if (!parent) {
      await upload.abort().catch(() => undefined);
      await clearReceipts(env, token).catch(() => undefined);
      return json({ error: 'no_such_parent' }, { status: 409 });
    }

    let object: R2Object;
    try {
      object = await upload.complete(parts);
    } catch {
      return json({ error: 'complete_failed' }, { status: 409 });
    }

    if (session.bytes > 0 && object.size !== session.bytes) {
      await env.MEDIA.delete(session.key);
      await clearReceipts(env, token).catch(() => undefined);
      return json({ error: 'size_mismatch' }, { status: 400 });
    }

    const column = columnFor(session.role);
    const updated = await env.DB.prepare(
      `UPDATE assets SET ${column} = ?1, derive_state = 'ready', derive_error = NULL
        WHERE id = ?2`,
    )
      .bind(session.key, parentId)
      .run();

    // Lost a race with a delete between the check above and here: take the
    // orphaned bytes back out rather than leaving them unreferenced in R2.
    if ((updated.meta?.changes ?? 0) === 0) {
      await env.MEDIA.delete(session.key);
      await clearReceipts(env, token).catch(() => undefined);
      return json({ error: 'no_such_parent' }, { status: 409 });
    }

    await clearReceipts(env, token).catch(() => undefined);
    return json({ ok: true });
  }

  // -------------------------------------------------------------- original --
  let object: R2Object;
  try {
    object = await upload.complete(parts);
  } catch {
    return json({ error: 'complete_failed' }, { status: 409 });
  }

  if (session.bytes > 0 && object.size !== session.bytes) {
    // The key is the content hash, so bytes of the wrong length at it are worse
    // than no bytes at all: every later reader would trust the name.
    await env.MEDIA.delete(session.key);
    await clearReceipts(env, token).catch(() => undefined);
    return json({ error: 'size_mismatch' }, { status: 400 });
  }

  const meta = session.meta;
  if (!meta) return json({ error: 'bad_request' }, { status: 400 });

  // Photos never derive: the Images binding renders them at read time.
  // A video is pending until its locally-encoded proxy follows.
  const deriveState = meta.kind === 'video' ? 'pending' : 'skipped';

  await env.DB.prepare(
    `INSERT INTO assets (id, filename, kind, mime, bytes, width, height, duration,
                         taken_at, orig_key, derive_state, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     ON CONFLICT (id) DO NOTHING`,
  )
    .bind(
      session.sha256,
      meta.filename,
      meta.kind,
      meta.mime,
      object.size,
      meta.width,
      meta.height,
      meta.duration,
      meta.takenAt,
      session.key,
      deriveState,
      Math.floor(Date.now() / 1000),
    )
    .run();

  await clearReceipts(env, token).catch(() => undefined);

  const asset = await getAsset(env, session.sha256);
  if (!asset) return json({ error: 'complete_failed' }, { status: 500 });
  return json({ asset });
}
