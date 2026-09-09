import { env as bindings, type Env } from './env';
import { json } from './http';
import { findMemory, isExpired, type MemoryRow } from './memory';
import { cookieName, verifySession } from './session';

export type Guarded = { ok: true; env: Env; memory: MemoryRow } | { ok: false; response: Response };

function secretOf(env: Env): string | null {
  return env.SESSION_SECRET ?? null;
}

/**
 * Every gated share route funnels through here, so the cookie check cannot be
 * forgotten on one endpoint. A missing memory, an expired memory and a bad
 * cookie all resolve to the same shapes on purpose.
 */
export async function guard(request: Request, slug: string): Promise<Guarded> {
  const env = await bindings();

  const secret = secretOf(env);
  if (!secret) {
    return {
      ok: false,
      response: json({ error: 'server_misconfigured' }, { status: 500 }),
    };
  }

  const memory = await findMemory(env, slug);
  if (!memory || isExpired(memory)) {
    return { ok: false, response: json({ error: 'not_found' }, { status: 404 }) };
  }

  const cookie = readCookie(request, cookieName(slug));
  if (!(await verifySession(secret, slug, cookie))) {
    return { ok: false, response: json({ error: 'locked' }, { status: 401 }) };
  }

  return { ok: true, env, memory };
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function sessionSecret(env: Env): string | null {
  return secretOf(env);
}
