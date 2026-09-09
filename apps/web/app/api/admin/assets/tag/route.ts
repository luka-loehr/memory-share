import { applyTags, normalizeTag } from '@/lib/admin/assets';
import { requireAdmin } from '@/lib/admin/auth';
import { idList, readJson } from '@/lib/admin/parse';
import { json } from '@/lib/http';

export const dynamic = 'force-dynamic';

function tagList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 64) return null;
  const names: string[] = [];
  for (const entry of value) {
    const name = normalizeTag(entry);
    if (!name) return null;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Add and remove tags across a set of assets in one round trip. */
export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body) return json({ error: 'bad_request' }, { status: 400 });

  const assetIds = idList(body.assetIds);
  const add = tagList(body.add);
  const remove = tagList(body.remove);
  if (!assetIds || !add || !remove) return json({ error: 'bad_request' }, { status: 400 });
  if (assetIds.length === 0) return json({ updated: 0 });

  const overlap = add.filter((name) => remove.includes(name));
  if (overlap.length > 0) return json({ error: 'conflicting_tags' }, { status: 400 });
  if (add.length === 0 && remove.length === 0) return json({ updated: 0 });

  return json({ updated: await applyTags(auth.env, assetIds, add, remove) });
}
