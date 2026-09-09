import { requireAdmin } from '@/lib/admin/auth';
import { findAdminMemory, listMemories, uniqueSlug, unknownAssets } from '@/lib/admin/memories';
import { bool, idList, int, readJson, str } from '@/lib/admin/parse';
import { generatePassword, hashPassword } from '@/lib/admin/secrets';
import { batchInChunks } from '@/lib/admin/d1';
import { json } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  return json({ memories: await listMemories(auth.env) });
}

/**
 * Create an album.
 *
 * The password is the only thing in this system that exists in plaintext for a
 * moment and then never again: it goes back in this response and is stored as a
 * PBKDF2 digest. There is no endpoint that can read it back, which is why
 * `rotate` replaces rather than reveals.
 */
export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const env = auth.env;

  const body = await readJson(request);
  if (!body) return json({ error: 'bad_request' }, { status: 400 });

  const title = str(body.title, 200);
  if (!title) return json({ error: 'bad_title' }, { status: 400 });

  const assetIds = idList(body.assetIds ?? []);
  if (!assetIds) return json({ error: 'bad_asset_ids' }, { status: 400 });

  const note = body.note === undefined || body.note === null ? null : str(body.note, 2000);
  const allowDownload = body.allowDownload === undefined ? true : bool(body.allowDownload);
  if (allowDownload === null) return json({ error: 'bad_request' }, { status: 400 });

  const expiresAt =
    body.expiresAt === undefined || body.expiresAt === null ? null : int(body.expiresAt, 0);
  if (body.expiresAt !== undefined && body.expiresAt !== null && expiresAt === null) {
    return json({ error: 'bad_expiry' }, { status: 400 });
  }

  // A memory that names a photograph the pool does not hold is a typo, not an
  // album: refuse it rather than silently create an emptier one than asked for.
  const missing = await unknownAssets(env, assetIds);
  if (missing.length > 0) {
    return json({ error: 'unknown_assets', assets: missing }, { status: 400 });
  }

  const supplied = body.password === undefined || body.password === null ? null : body.password;
  if (supplied !== null && (typeof supplied !== 'string' || supplied.length < 1)) {
    return json({ error: 'bad_password' }, { status: 400 });
  }
  const password = supplied === null ? generatePassword() : supplied;

  const id = crypto.randomUUID();
  const slug = await uniqueSlug(env, title);
  const now = Math.floor(Date.now() / 1000);

  const statements = [
    env.DB.prepare(
      `INSERT INTO memories (id, slug, title, note, password_hash, cover_asset_id,
                             allow_download, expires_at, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
    ).bind(
      id,
      slug,
      title,
      note,
      await hashPassword(password),
      assetIds[0] ?? null,
      allowDownload ? 1 : 0,
      expiresAt,
      now,
    ),
    ...assetIds.map((assetId, index) =>
      env.DB.prepare(
        `INSERT INTO memory_assets (memory_id, asset_id, position) VALUES (?1, ?2, ?3)`,
      ).bind(id, assetId, index),
    ),
  ];
  await batchInChunks(env.DB, statements);

  const memory = await findAdminMemory(env, slug);
  if (!memory) return json({ error: 'create_failed' }, { status: 500 });

  // Shown exactly once. Nothing logs it and nothing can retrieve it again.
  return json({ memory, password }, { status: 201 });
}
