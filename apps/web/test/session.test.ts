import { describe, expect, test } from 'bun:test';
import { mintSession, verifySession } from '../lib/session';

const SECRET = 'test-session-secret-not-a-real-one';
const HASH = 'pbkdf2$100000$c2FsdA==$aGFzaA==';
const ROTATED = 'pbkdf2$100000$bmV3c2FsdA==$bmV3aGFzaA==';

describe('share sessions', () => {
  test('a freshly minted session verifies for its own memory', async () => {
    const { value } = await mintSession(SECRET, 'beach-week', 60, HASH);
    expect(await verifySession(SECRET, 'beach-week', value, HASH)).toBe(true);
  });

  test('a session for one memory is worth nothing on another', async () => {
    const { value } = await mintSession(SECRET, 'beach-week', 60, HASH);
    expect(await verifySession(SECRET, 'family-dinner', value, HASH)).toBe(false);
  });

  test('rotating the password ends a session unlocked with the old one', async () => {
    const { value } = await mintSession(SECRET, 'beach-week', 60, HASH);
    expect(await verifySession(SECRET, 'beach-week', value, ROTATED)).toBe(false);
  });

  test('a session unlocked after rotation works with the new digest only', async () => {
    const { value } = await mintSession(SECRET, 'beach-week', 60, ROTATED);
    expect(await verifySession(SECRET, 'beach-week', value, ROTATED)).toBe(true);
    expect(await verifySession(SECRET, 'beach-week', value, HASH)).toBe(false);
  });

  test('the password digest never appears in the cookie', async () => {
    const { value } = await mintSession(SECRET, 'beach-week', 60, HASH);
    const payload = atob(value.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'));
    expect(payload).not.toContain('pbkdf2');
    expect(value).not.toContain('pbkdf2');
  });

  test('an expired session is refused', async () => {
    const { value } = await mintSession(SECRET, 'beach-week', -1, HASH);
    expect(await verifySession(SECRET, 'beach-week', value, HASH)).toBe(false);
  });

  test('a different SESSION_SECRET invalidates every session', async () => {
    const { value } = await mintSession(SECRET, 'beach-week', 60, HASH);
    expect(await verifySession('another-secret', 'beach-week', value, HASH)).toBe(false);
  });

  test('an edited payload cannot extend its own expiry', async () => {
    const { value } = await mintSession(SECRET, 'beach-week', 60, HASH);
    const [, sig] = value.split('.');
    const forged = btoa(JSON.stringify({ s: 'beach-week', e: 4102444800 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(await verifySession(SECRET, 'beach-week', `${forged}.${sig}`, HASH)).toBe(false);
  });

  test('missing or malformed cookies are refused', async () => {
    expect(await verifySession(SECRET, 'beach-week', undefined, HASH)).toBe(false);
    expect(await verifySession(SECRET, 'beach-week', '', HASH)).toBe(false);
    expect(await verifySession(SECRET, 'beach-week', 'no-dot-here', HASH)).toBe(false);
    expect(await verifySession(SECRET, 'beach-week', '.onlysig', HASH)).toBe(false);
  });
});
