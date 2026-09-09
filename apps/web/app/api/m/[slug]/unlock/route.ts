import { env as bindings } from '@/lib/env';
import { sessionSecret } from '@/lib/guard';
import { json } from '@/lib/http';
import { findMemory, isExpired, logAccess, recentRejections } from '@/lib/memory';
import { verifyPassword } from '@/lib/password';
import { mintSession, sessionCookieHeader } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Guessing budget: 10 wrong passwords per memory per 15 minutes. */
const RATE_WINDOW_SECONDS = 900;
const RATE_LIMIT = 10;

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const env = await bindings();

  const secret = sessionSecret(env);
  if (!secret) return json({ error: 'server_misconfigured' }, { status: 500 });

  const memory = await findMemory(env, slug);
  // A wrong slug and a wrong password look alike from outside; neither confirms
  // that a memory with this name exists.
  if (!memory || isExpired(memory)) return json({ error: 'rejected' }, { status: 401 });

  if ((await recentRejections(env, memory.id, RATE_WINDOW_SECONDS)) >= RATE_LIMIT) {
    return json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'retry-after': String(RATE_WINDOW_SECONDS) } },
    );
  }

  let password = '';
  try {
    const body = (await request.json()) as { password?: unknown };
    if (typeof body.password === 'string') password = body.password;
  } catch {
    return json({ error: 'bad_request' }, { status: 400 });
  }

  if (!password || !(await verifyPassword(password, memory.password_hash))) {
    await logAccess(env, memory.id, 'rejected');
    return json({ error: 'rejected' }, { status: 401 });
  }

  const ttl = Number(env.SESSION_TTL_SECONDS ?? '43200') || 43200;
  const { value } = await mintSession(secret, slug, ttl);
  await logAccess(env, memory.id, 'unlocked');

  return json(
    { ok: true, title: memory.title },
    { status: 200, headers: { 'set-cookie': sessionCookieHeader(slug, value, ttl) } },
  );
}
