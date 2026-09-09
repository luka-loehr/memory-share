import { requireAdmin } from '@/lib/admin/auth';
import { findAdminMemory } from '@/lib/admin/memories';
import { readJson } from '@/lib/admin/parse';
import { generatePassword, hashPassword } from '@/lib/admin/secrets';
import { json } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * Replace an album's password.
 *
 * The old digest is overwritten, so every link already shared stops working the
 * moment this returns — which is the point: rotation is what you reach for when
 * a link went somewhere it should not have.
 */
export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const env = auth.env;

  const { slug } = await ctx.params;
  const memory = await findAdminMemory(env, slug);
  if (!memory) return json({ error: 'not_found' }, { status: 404 });

  // A body is optional; an explicit password is honoured when one is sent.
  const body = await readJson(request);
  const supplied = body?.password;
  if (supplied !== undefined && supplied !== null && typeof supplied !== 'string') {
    return json({ error: 'bad_password' }, { status: 400 });
  }
  const password =
    typeof supplied === 'string' && supplied.length > 0 ? supplied : generatePassword();

  await env.DB.prepare(`UPDATE memories SET password_hash = ?1, updated_at = ?2 WHERE id = ?3`)
    .bind(await hashPassword(password), Math.floor(Date.now() / 1000), memory.id)
    .run();

  return json({ password });
}
