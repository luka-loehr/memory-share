import { describe, expect, test } from 'bun:test';
import { bool, idList, int, MAX_JSON_BYTES, num, readJson, str } from '../lib/admin/parse';

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request('https://ms.test/api/admin/x', { method: 'POST', body, headers });

describe('owner API body parsing', () => {
  test('readJson returns objects only', async () => {
    expect(await readJson(post('{"a":1}'))).toEqual({ a: 1 });
    for (const body of ['', 'null', '[1,2]', '"text"', '7', '{broken']) {
      expect(await readJson(post(body))).toBeNull();
    }
    expect(await readJson(post(null))).toBeNull();
  });

  test('readJson refuses a body over the limit, declared or not', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(2000) });
    expect(await readJson(post(big), 1000)).toBeNull();
    expect(await readJson(post('{}', { 'content-length': String(MAX_JSON_BYTES + 1) }))).toBeNull();
    expect(await readJson(post(big), 4000)).toEqual({ pad: 'x'.repeat(2000) });
  });

  test('str trims and rejects empty, long and non-string values', () => {
    expect(str('  beach ')).toBe('beach');
    expect(str('   ')).toBeNull();
    expect(str('x'.repeat(513))).toBeNull();
    expect(str('abcd', 3)).toBeNull();
    for (const value of [null, undefined, 5, {}, ['a']]) expect(str(value)).toBeNull();
  });

  test('int accepts whole numbers in range, as numbers or digit strings', () => {
    expect(int(42)).toBe(42);
    expect(int('42')).toBe(42);
    expect(int(0)).toBe(0);
    expect(int(5, 1, 10)).toBe(5);
  });

  test('int rejects everything else, including the empty string', () => {
    // Number('') is 0: an empty expiresAt must not become "expired in 1970".
    for (const value of [
      '',
      '   ',
      'abc',
      '1.5',
      1.5,
      -1,
      NaN,
      Infinity,
      null,
      undefined,
      true,
      [],
      {},
    ]) {
      expect(int(value)).toBeNull();
    }
    expect(int(0, 1, 10_000)).toBeNull();
    expect(int(10_001, 1, 10_000)).toBeNull();
    expect(int(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
  });

  test('num accepts finite numbers only', () => {
    expect(num(1.5)).toBe(1.5);
    expect(num('2.25')).toBe(2.25);
    for (const value of ['', ' ', 'x', NaN, Infinity, null, undefined, {}])
      expect(num(value)).toBeNull();
  });

  test('bool accepts the spellings the CLI sends', () => {
    expect(bool(true)).toBe(true);
    expect(bool('false')).toBe(false);
    expect(bool(1)).toBe(true);
    for (const value of ['yes', 2, null, undefined, {}]) expect(bool(value)).toBeNull();
  });

  test('idList wants sha256 ids, drops duplicates and caps the count', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    expect(idList([a, b, a])).toEqual([a, b]);
    expect(idList([])).toEqual([]);
    expect(idList([a, 'A'.repeat(64)])).toBeNull();
    expect(idList([a.slice(1)])).toBeNull();
    expect(idList([a, 5])).toBeNull();
    expect(idList('nope')).toBeNull();
    expect(idList([a, b], 1)).toBeNull();
  });
});
