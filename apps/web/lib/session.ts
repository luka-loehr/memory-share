import { timingSafeEqual } from './password';

/**
 * Share sessions are a signed cookie, not a server-side record: there is no
 * session table to grow and no state to replicate. The signature binds the
 * cookie to one slug, so unlocking "beach-week" is worth nothing on any other
 * memory — invariant 4 in the contract.
 */

const encoder = new TextEncoder();

export function cookieName(slug: string): string {
  return `ms_${slug}`;
}

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function sign(secret: string, payload: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload));
  return b64url(new Uint8Array(sig));
}

/** `<b64url payload>.<b64url hmac>`; the payload is slug + expiry, nothing secret. */
export async function mintSession(
  secret: string,
  slug: string,
  ttlSeconds: number,
): Promise<{ value: string; expires: number }> {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = b64url(encoder.encode(JSON.stringify({ s: slug, e: expires })));
  return { value: `${payload}.${await sign(secret, payload)}`, expires };
}

export async function verifySession(
  secret: string,
  slug: string,
  cookie: string | undefined,
): Promise<boolean> {
  if (!cookie) return false;
  const dot = cookie.lastIndexOf('.');
  if (dot <= 0) return false;

  const payload = cookie.slice(0, dot);
  const provided = cookie.slice(dot + 1);

  const expected = await sign(secret, payload);
  if (!timingSafeEqual(encoder.encode(provided), encoder.encode(expected))) return false;

  try {
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as {
      s?: unknown;
      e?: unknown;
    };
    if (claims.s !== slug) return false;
    if (typeof claims.e !== 'number' || claims.e < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}

export function sessionCookieHeader(slug: string, value: string, maxAge: number): string {
  // Path-scoped so the browser only ever sends this memory's cookie to this
  // memory's routes, and Lax so a link from a chat app still arrives unlocked.
  const attrs = [
    `${cookieName(slug)}=${value}`,
    `Path=/`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ];
  return attrs.join('; ');
}

export function clearCookieHeader(slug: string): string {
  return `${cookieName(slug)}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
