/**
 * Password minting for the owner API.
 *
 * `lib/password.ts` only verifies — the share side never creates one. This is
 * the other half: generate a plaintext, derive the stored digest in exactly the
 * format `0001_init.sql` documents (`pbkdf2$<iters>$<salt_b64>$<hash_b64>`),
 * and hand the plaintext back to the caller once and only once.
 */

/** Matches the CLI's own guessing budget and OWASP's PBKDF2-SHA256 guidance. */
export const PBKDF2_ITERATIONS = 100_000;

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(new Uint8Array(bits))}`;
}

// ------------------------------------------------------------ generation ----

const CONSONANTS = 'bdfgklmnprstvz';
const VOWELS = 'aeiou';

/**
 * Uniform random index. `%` on a raw byte would bias toward low indices, so
 * values in the ragged top of the byte range are rejected and redrawn.
 */
function pick(alphabet: string): string {
  const limit = 256 - (256 % alphabet.length);
  const buffer = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    if (buffer[0] < limit) return alphabet[buffer[0] % alphabet.length];
  }
}

/** cvcvc: pronounceable, unambiguous to type, 14·5·14·5·14 ≈ 2^15.9 each. */
function word(): string {
  return pick(CONSONANTS) + pick(VOWELS) + pick(CONSONANTS) + pick(VOWELS) + pick(CONSONANTS);
}

/**
 * A generated share password: five words, ~79 bits.
 *
 * Deliberately NOT a three-token memorable phrase — a share link is public and
 * its password is the only thing between a stranger and the album, so this is
 * sized to be unguessable rather than memorable. The words are synthesised
 * syllables rather than dictionary entries because a real wordlist large enough
 * to reach this strength in five tokens (~2^16 words) would be a megabyte of
 * data in the Worker; five cvcvc words carry ~15.9 bits each and stay
 * pronounceable and dictatable over a phone.
 */
export function generatePassword(words = 5): string {
  return Array.from({ length: words }, word).join('-');
}
