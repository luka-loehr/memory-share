import { env as bindings, type Env } from '../env';
import { json } from '../http';
import { timingSafeEqual } from '../password';

/**
 * `ADMIN_TOKEN` is a Worker *secret*, never a var — it must not appear in
 * wrangler.jsonc. Locally it comes from `.dev.vars`.
 */
declare global {
  interface CloudflareEnv {
    /** Bearer token for every `/api/admin/*` route. `wrangler secret put ADMIN_TOKEN`. */
    ADMIN_TOKEN?: string;
  }
}

const encoder = new TextEncoder();

export type Admin = { ok: true; env: Env } | { ok: false; response: Response };

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/**
 * Compare two bearer tokens without leaking their length or their contents
 * through timing.
 *
 * Both sides are hashed first, so the comparison always runs over 32 bytes
 * whatever the inputs were: a raw `===` on the strings would short-circuit at
 * the first differing byte, and even a byte-wise loop over the raw values
 * would reveal the secret's length. `timingSafeEqual` is then length-safe by
 * construction, and the digests make it length-*independent* as well.
 */
async function tokenMatches(provided: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  return timingSafeEqual(a, b);
}

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * The single gate in front of the owner API.
 *
 * Every admin route funnels through here so the check cannot be forgotten on
 * one endpoint. A missing token, a malformed header and a wrong token are all
 * an undetailed 401 — the CLI already knows what it sent, and nobody else is
 * entitled to know which part was wrong.
 *
 * Note what this deliberately does NOT do: it never reads and never sets a
 * share cookie. Owner authority comes from the bearer token alone, so no share
 * session can reach these routes and no admin call can mint one.
 */
export async function requireAdmin(request: Request): Promise<Admin> {
  const env = await bindings();

  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    // Fail closed. An unset secret must never mean "everyone is the owner".
    return { ok: false, response: json({ error: 'server_misconfigured' }, { status: 500 }) };
  }

  const provided = bearer(request);
  if (!provided || !(await tokenMatches(provided, expected))) {
    return {
      ok: false,
      response: json(
        { error: 'unauthorized' },
        { status: 401, headers: { 'www-authenticate': 'Bearer' } },
      ),
    };
  }

  return { ok: true, env };
}

/** HMAC key for opaque upload tokens, derived from the same secret. */
export async function tokenKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(`upload:${env.ADMIN_TOKEN ?? ''}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}
