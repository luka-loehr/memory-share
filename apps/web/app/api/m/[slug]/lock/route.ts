import { json } from '@/lib/http';
import { clearCookieHeader } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Clearing the cookie needs no proof of anything — it only ever removes access. */
export async function POST(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  return json({ ok: true }, { status: 200, headers: { 'set-cookie': clearCookieHeader(slug) } });
}
