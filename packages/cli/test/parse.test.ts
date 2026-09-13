import { describe, expect, test } from 'bun:test';
import { UsageError } from '../src/core/errors.ts';
import {
  assertSlug,
  dedupe,
  normalizeBaseUrl,
  normalizeTag,
  normalizeTags,
  parseExpiry,
  parseIdList,
  resolveIds,
} from '../src/core/parse.ts';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW / 1000);

describe('parseExpiry', () => {
  test('a bare number means days', () => {
    expect(parseExpiry('30', NOW)).toBe(NOW_SECONDS + 30 * 86_400);
  });

  test('understands every suffix', () => {
    expect(parseExpiry('45s', NOW)).toBe(NOW_SECONDS + 45);
    expect(parseExpiry('90m', NOW)).toBe(NOW_SECONDS + 5_400);
    expect(parseExpiry('12h', NOW)).toBe(NOW_SECONDS + 43_200);
    expect(parseExpiry('30d', NOW)).toBe(NOW_SECONDS + 2_592_000);
    expect(parseExpiry('8w', NOW)).toBe(NOW_SECONDS + 8 * 604_800);
    expect(parseExpiry('1y', NOW)).toBe(NOW_SECONDS + 31_536_000);
  });

  test('is tolerant of spacing and case', () => {
    expect(parseExpiry('  30 D ', NOW)).toBe(NOW_SECONDS + 2_592_000);
  });

  test('accepts an absolute date and returns epoch seconds', () => {
    expect(parseExpiry('2026-12-24', NOW)).toBe(Math.floor(Date.parse('2026-12-24') / 1000));
  });

  test('refuses a date in the past', () => {
    expect(() => parseExpiry('2020-01-01', NOW)).toThrow(UsageError);
  });

  test('refuses nonsense rather than defaulting to something', () => {
    expect(() => parseExpiry('soon', NOW)).toThrow(UsageError);
    expect(() => parseExpiry('', NOW)).toThrow(UsageError);
    expect(() => parseExpiry('0d', NOW)).toThrow(UsageError);
  });

  test('"never" is refused, because omitting the flag already means that', () => {
    expect(() => parseExpiry('never', NOW)).toThrow(UsageError);
  });
});

describe('normalizeTag', () => {
  test('lowercases and slugifies', () => {
    expect(normalizeTag('Beach')).toBe('beach');
    expect(normalizeTag('With Family')).toBe('with-family');
    expect(normalizeTag('with_family')).toBe('with-family');
    expect(normalizeTag('  Summer   2019!  ')).toBe('summer-2019');
    expect(normalizeTag('a--b')).toBe('a-b');
    expect(normalizeTag('-edges-')).toBe('edges');
  });

  test('refuses input that slugifies to nothing', () => {
    expect(() => normalizeTag('!!!')).toThrow(UsageError);
  });

  test('normalizes and de-duplicates a list', () => {
    expect(normalizeTags(['Beach', 'beach', 'With Family'])).toEqual(['beach', 'with-family']);
  });
});

describe('parseIdList', () => {
  test('splits on commas and across repeated flags', () => {
    expect(parseIdList(['ab12,cd34', 'ef56'])).toEqual(['ab12', 'cd34', 'ef56']);
  });

  test('lowercases, trims and de-duplicates', () => {
    expect(parseIdList([' AB12 ', 'ab12'])).toEqual(['ab12']);
  });

  test('rejects things that are not hex ids', () => {
    expect(() => parseIdList(['not-an-id'])).toThrow(UsageError);
    expect(() => parseIdList(['abc'])).toThrow(UsageError); // shorter than 4
    expect(() => parseIdList([',,'])).toThrow(UsageError);
  });
});

describe('resolveIds', () => {
  const pool = ['aabbccdd11', 'aabbeeff22', 'ffee001122'];

  test('an exact id resolves to itself', () => {
    expect(resolveIds(['aabbccdd11'], pool).resolved).toEqual(['aabbccdd11']);
  });

  test('a unique prefix resolves', () => {
    expect(resolveIds(['aabbcc'], pool).resolved).toEqual(['aabbccdd11']);
  });

  test('an ambiguous prefix is reported, never guessed', () => {
    const result = resolveIds(['aabb'], pool);
    expect(result.resolved).toEqual([]);
    expect(result.ambiguous).toEqual(['aabb']);
  });

  test('an unknown prefix is reported as missing', () => {
    expect(resolveIds(['9999'], pool).missing).toEqual(['9999']);
  });
});

describe('normalizeBaseUrl', () => {
  test('strips trailing slashes so paths do not double up', () => {
    expect(normalizeBaseUrl('https://ms.example.com/')).toBe('https://ms.example.com');
    expect(normalizeBaseUrl('https://ms.example.com///')).toBe('https://ms.example.com');
  });

  test('assumes https when no scheme is given', () => {
    expect(normalizeBaseUrl('ms.example.com')).toBe('https://ms.example.com');
  });

  test('keeps a path prefix', () => {
    expect(normalizeBaseUrl('https://example.com/ms/')).toBe('https://example.com/ms');
  });

  test('refuses empty input', () => {
    expect(() => normalizeBaseUrl('   ')).toThrow(UsageError);
  });
});

describe('assertSlug and dedupe', () => {
  test('accepts share slugs and refuses paths', () => {
    expect(assertSlug('beach-2019')).toBe('beach-2019');
    expect(assertSlug(' Beach-2019 ')).toBe('beach-2019');
    expect(() => assertSlug('../etc/passwd')).toThrow(UsageError);
    expect(() => assertSlug('-leading')).toThrow(UsageError);
  });

  test('dedupe keeps first-seen order', () => {
    expect(dedupe(['b', 'a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
  });
});
