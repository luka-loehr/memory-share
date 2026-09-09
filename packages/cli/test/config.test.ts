import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, maskSecret, readConfigFile, redact, saveConfig } from '../src/core/config.ts';
import { ConfigError } from '../src/core/errors.ts';

const created: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ms-config-'));
  created.push(dir);
  process.env.MS_CONFIG_PATH = join(dir, 'config.json');
  return dir;
}

afterEach(async () => {
  process.env.MS_CONFIG_PATH = undefined;
  process.env.MS_WORKER_URL = undefined;
  process.env.MS_ADMIN_TOKEN = undefined;
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('maskSecret', () => {
  test('keeps a short fingerprint, never the value', () => {
    const token = 'ms_live_1234567890abcdefghijklmnop';
    const masked = maskSecret(token) ?? '';
    expect(masked.startsWith('ms_l')).toBe(true);
    expect(masked.endsWith('mnop')).toBe(true);
    expect(masked).not.toContain('567890abcdefghij');
    expect(masked.length).toBeLessThanOrEqual(32);
  });

  test('a short secret is fully starred, so its length is all that leaks', () => {
    expect(maskSecret('abcd')).toBe('****');
  });

  test('absent values stay absent rather than becoming "****"', () => {
    expect(maskSecret(undefined)).toBeNull();
    expect(maskSecret(null)).toBeNull();
    expect(maskSecret('')).toBeNull();
  });
});

describe('redact', () => {
  test('masks every known secret key and leaves the rest alone', () => {
    const redacted = redact({
      workerUrl: 'https://ms.example.com',
      adminToken: 'super-secret-admin-token-value',
      cloudflareApiToken: 'cf-secret-token-value-here',
      accountId: 'abc123',
    });
    expect(redacted.workerUrl).toBe('https://ms.example.com');
    expect(redacted.accountId).toBe('abc123');
    expect(redacted.adminToken).not.toContain('secret-admin-token');
    expect(redacted.cloudflareApiToken).not.toContain('secret-token-value');
  });

  test('reaches secrets nested in objects and arrays', () => {
    const redacted = redact({
      memories: [{ slug: 'croatia', password: 'correct-horse-battery-staple' }],
      nested: { deep: { adminToken: 'another-secret-token-here' } },
    });
    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain('correct-horse-battery-staple');
    expect(serialised).not.toContain('another-secret-token-here');
    expect(serialised).toContain('croatia');
  });

  test('non-objects pass through untouched', () => {
    expect(redact('plain')).toBe('plain');
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
  });
});

describe('saveConfig', () => {
  test('writes 0600 and round-trips', async () => {
    await scratch();
    const path = await saveConfig({ workerUrl: 'https://ms.example.com', adminToken: 'tok' });
    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
    const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(written.workerUrl).toBe('https://ms.example.com');
    expect(typeof written.updatedAt).toBe('string');
    expect((await readConfigFile()).adminToken).toBe('tok');
  });
});

describe('loadConfig', () => {
  test('names exactly what is missing', async () => {
    await scratch();
    await expect(loadConfig()).rejects.toThrow(ConfigError);
    await expect(loadConfig()).rejects.toThrow(/worker URL and admin token/);
  });

  test('the environment overrides the file', async () => {
    await scratch();
    await saveConfig({ workerUrl: 'https://stored.example.com', adminToken: 'stored' });
    process.env.MS_WORKER_URL = 'https://env.example.com/';
    process.env.MS_ADMIN_TOKEN = 'from-env';
    const config = await loadConfig();
    expect(config.workerUrl).toBe('https://env.example.com');
    expect(config.adminToken).toBe('from-env');
  });

  test('a corrupt config file says so instead of pretending it is empty', async () => {
    const dir = await scratch();
    await writeFile(join(dir, 'config.json'), '{ not json');
    await expect(readConfigFile()).rejects.toThrow(ConfigError);
  });

  test('a missing config file is simply empty', async () => {
    await scratch();
    expect(await readConfigFile()).toEqual({});
  });
});
