import { listAssetsPage, normalizeTag } from '@/lib/admin/assets';
import { requireAdmin } from '@/lib/admin/auth';
import { json } from '@/lib/http';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** The pool, newest first, paged by an opaque keyset cursor. */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const rawTag = url.searchParams.get('tag');
  const rawKind = url.searchParams.get('kind');
  const rawLimit = url.searchParams.get('limit');

  if (rawKind !== null && rawKind !== 'photo' && rawKind !== 'video') {
    return json({ error: 'bad_kind' }, { status: 400 });
  }

  let tag: string | undefined;
  if (rawTag !== null) {
    const normalized = normalizeTag(rawTag);
    // An unusable tag matches nothing; it is not a server error.
    if (!normalized) return json({ assets: [] });
    tag = normalized;
  }

  const parsed = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  const limit =
    Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_LIMIT) : DEFAULT_LIMIT;

  const page = await listAssetsPage(auth.env, {
    tag,
    kind: rawKind ?? undefined,
    limit,
    cursor: url.searchParams.get('cursor') ?? undefined,
  });

  return json(page.cursor ? { assets: page.assets, cursor: page.cursor } : { assets: page.assets });
}
