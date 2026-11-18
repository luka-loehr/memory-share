import { describe, expect, test } from 'bun:test';
import { BodyTooLarge, etagMatches, parseRange, readBodyText } from '../lib/http';
import { isSlug } from '../lib/memory';

describe('Range parsing', () => {
  test('closed, open-ended and suffix ranges', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({
      type: 'range',
      offset: 0,
      length: 100,
      end: 99,
    });
    expect(parseRange('bytes=900-', 1000)).toEqual({
      type: 'range',
      offset: 900,
      length: 100,
      end: 999,
    });
    expect(parseRange('bytes=-100', 1000)).toEqual({
      type: 'range',
      offset: 900,
      length: 100,
      end: 999,
    });
  });

  test('an end past the object is clamped, a suffix longer than it is the whole object', () => {
    expect(parseRange('bytes=500-99999', 1000)).toEqual({
      type: 'range',
      offset: 500,
      length: 500,
      end: 999,
    });
    expect(parseRange('bytes=-5000', 1000)).toEqual({
      type: 'range',
      offset: 0,
      length: 1000,
      end: 999,
    });
  });

  test('ranges that cannot be satisfied', () => {
    for (const header of ['bytes=1000-', 'bytes=2000-3000', 'bytes=10-5', 'bytes=-0']) {
      expect(parseRange(header, 1000)).toEqual({ type: 'unsatisfiable' });
    }
    expect(parseRange('bytes=0-', 0)).toEqual({ type: 'unsatisfiable' });
  });

  test('malformed, multi-range and foreign units count as no Range at all', () => {
    for (const header of [
      null,
      '',
      'bytes=-',
      'bytes=a-b',
      'bytes=0-1,5-6',
      'items=0-1',
      'bytes=1.5-2',
      'bytes=-1-2',
    ]) {
      expect(parseRange(header, 1000)).toEqual({ type: 'none' });
    }
  });
});

describe('ETag matching', () => {
  test('strong, weak, list and wildcard', () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"x", "abc"', '"abc"')).toBe(true);
    expect(etagMatches('*', '"abc"')).toBe(true);
    expect(etagMatches('"abd"', '"abc"')).toBe(false);
    expect(etagMatches(null, '"abc"')).toBe(false);
  });
});

describe('capped body read', () => {
  const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
    new Request('https://ms.test/api/m/x/unlock', { method: 'POST', body, headers });

  test('reads a body within the limit', async () => {
    expect(await readBodyText(post('{"password":"grüße"}'), 4096)).toBe('{"password":"grüße"}');
    expect(await readBodyText(post(null), 4096)).toBe('');
  });

  test('throws once the limit is passed', async () => {
    expect(readBodyText(post('x'.repeat(5000)), 4096)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(readBodyText(post('{}', { 'content-length': '99999' }), 4096)).rejects.toBeInstanceOf(
      BodyTooLarge,
    );
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent++;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const request = new Request('https://ms.test/api/m/x/unlock', {
      method: 'POST',
      body: endless,
      duplex: 'half',
    } as RequestInit);
    await expect(readBodyText(request, 4096)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(sent).toBeLessThan(50);
  });
});

describe('slug shape', () => {
  test('what slugify and its collision suffix produce', () => {
    for (const slug of [
      'memory',
      'summer-2024',
      'kroatien-24',
      'christmas-2',
      'a',
      `${'x'.repeat(60)}-deadbeef`,
    ]) {
      expect(isSlug(slug)).toBe(true);
    }
  });

  test('anything else is not a memory', () => {
    for (const slug of [
      '',
      'Summer',
      'a--b',
      '-a',
      'a-',
      'a b',
      'a/b',
      '../x',
      'a;b=c',
      'ä',
      'x'.repeat(81),
      'a%20b',
    ]) {
      expect(isSlug(slug)).toBe(false);
    }
  });
});
