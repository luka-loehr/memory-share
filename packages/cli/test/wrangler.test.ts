import { describe, expect, test } from 'bun:test';
import { backoffDelay, isRetryableStatus } from '../src/core/api.ts';
import { CliError } from '../src/core/errors.ts';
import { parseExifDate } from '../src/core/probe.ts';
import { extractWorkerUrl, setDatabaseId, stripJsonc } from '../src/core/wrangler.ts';

const CONFIG = `{
  // the worker itself
  "name": "memory-share",
  "main": "src/worker.ts",
  /* storage */
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "memory-share-assets" }],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "memory-share",
      "database_id": "" // filled in by ms deploy
    }
  ],
}`;

describe('stripJsonc', () => {
  test('parses a config with comments and a trailing comma', () => {
    const parsed = JSON.parse(stripJsonc(CONFIG)) as { name: string };
    expect(parsed.name).toBe('memory-share');
  });

  test('does not mangle comment-like text inside strings', () => {
    const text = '{ "url": "https://example.com/a//b", "note": "/* not a comment */" }';
    const parsed = JSON.parse(stripJsonc(text)) as { url: string; note: string };
    expect(parsed.url).toBe('https://example.com/a//b');
    expect(parsed.note).toBe('/* not a comment */');
  });
});

describe('setDatabaseId', () => {
  const ID = '1b0f5a3c-1111-2222-3333-444455556666';

  test('writes the id and leaves the comments in place', () => {
    const updated = setDatabaseId(CONFIG, 'memory-share', ID);
    expect(updated).toContain(`"database_id": "${ID}"`);
    expect(updated).toContain('// the worker itself');
    expect(updated).toContain('/* storage */');
    expect(JSON.parse(stripJsonc(updated))).toMatchObject({ name: 'memory-share' });
  });

  test('is idempotent — writing the same id twice changes nothing further', () => {
    const once = setDatabaseId(CONFIG, 'memory-share', ID);
    expect(setDatabaseId(once, 'memory-share', ID)).toBe(once);
  });

  test('inserts the key when the binding has no database_id at all', () => {
    const without = '{ "d1_databases": [{ "binding": "DB", "database_name": "memory-share" }] }';
    const updated = setDatabaseId(without, 'memory-share', ID);
    const parsed = JSON.parse(stripJsonc(updated)) as {
      d1_databases: { database_id: string }[];
    };
    expect(parsed.d1_databases[0]?.database_id).toBe(ID);
  });

  test('refuses to guess when the named binding is absent', () => {
    expect(() => setDatabaseId(CONFIG, 'some-other-db', ID)).toThrow(CliError);
  });
});

describe('extractWorkerUrl', () => {
  test('finds the deployed workers.dev URL in wrangler prose', () => {
    const output = [
      'Total Upload: 42.11 KiB / gzip: 9.80 KiB',
      'Uploaded memory-share (2.31 sec)',
      'Deployed memory-share triggers (0.72 sec)',
      '  https://memory-share.<your-subdomain>.workers.dev',
      'Current Version ID: abc-123',
    ].join('\n');
    expect(extractWorkerUrl(output)).toBe('https://memory-share.<your-subdomain>.workers.dev');
  });

  test('returns null rather than a wrong guess when there is no URL', () => {
    expect(extractWorkerUrl('Total Upload: 42 KiB')).toBeNull();
  });
});

describe('retry policy', () => {
  test('retries transient statuses only', () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });

  test('backoff grows but stays inside the ceiling, and is jittered', () => {
    const policy = { attempts: 5, baseDelayMs: 400, maxDelayMs: 15_000 };
    const first = Array.from({ length: 50 }, () => backoffDelay(0, policy));
    const later = Array.from({ length: 50 }, () => backoffDelay(6, policy));
    for (const delay of first) expect(delay).toBeGreaterThanOrEqual(200);
    for (const delay of first) expect(delay).toBeLessThanOrEqual(400);
    for (const delay of later) expect(delay).toBeLessThanOrEqual(15_000);
    expect(new Set(first).size).toBeGreaterThan(1);
  });
});

describe('parseExifDate', () => {
  test('reads the colon-separated EXIF stamp as local time', () => {
    const parsed = parseExifDate('2019:07:14 18:12:03');
    expect(parsed).toBe(Math.floor(new Date(2019, 6, 14, 18, 12, 3).getTime() / 1000));
  });

  test('falls back to Date.parse for ISO stamps, and gives up cleanly', () => {
    expect(parseExifDate('2019-07-14T18:12:03Z')).toBe(
      Math.floor(Date.parse('2019-07-14T18:12:03Z') / 1000),
    );
    expect(parseExifDate('not a date')).toBeNull();
    expect(parseExifDate(undefined)).toBeNull();
  });
});
