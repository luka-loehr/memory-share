import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigError } from './errors.ts';
import { normalizeBaseUrl } from './parse.ts';

export interface Config {
  /** Deployed worker origin, e.g. https://memory-share.<your-subdomain>.workers.dev */
  workerUrl: string;
  /** Worker secret ADMIN_TOKEN — bearer for every /api/admin/* call. */
  adminToken: string;
  /** Only used by `ms deploy`, to drive wrangler against the right account. */
  cloudflareApiToken?: string;
  accountId?: string;
  updatedAt?: string;
}

/** Field names whose values must never reach a log, a --json dump or an error. */
const SECRET_KEYS = new Set(['adminToken', 'cloudflareApiToken', 'password', 'sessionSecret']);

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== '' ? xdg : join(homedir(), '.config');
  return join(base, 'memory-share');
}

export function configPath(): string {
  return process.env.MS_CONFIG_PATH ?? join(configDir(), 'config.json');
}

/** Per-upload resume journals live beside the config, never in the media tree. */
export function stateDir(): string {
  return join(configDir(), 'uploads');
}

/**
 * Replaces every secret value with a fingerprint: enough to tell two tokens
 * apart when debugging, useless to anyone who reads the terminal over a
 * shoulder or scrapes a pasted issue.
 */
export function redact<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.has(key) ? maskSecret(inner) : redactValue(inner);
    }
    return out;
  }
  return value;
}

export function maskSecret(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text === '') return null;
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}${'*'.repeat(Math.min(text.length - 8, 24))}${text.slice(-4)}`;
}

/** Environment wins over the file, so CI can run without writing a config. */
export function envOverrides(): Partial<Config> {
  const out: Partial<Config> = {};
  const url = process.env.MS_WORKER_URL;
  const token = process.env.MS_ADMIN_TOKEN;
  const cf = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (url) out.workerUrl = normalizeBaseUrl(url);
  if (token) out.adminToken = token;
  if (cf) out.cloudflareApiToken = cf;
  if (account) out.accountId = account;
  return out;
}

export async function readConfigFile(): Promise<Partial<Config>> {
  try {
    const text = await readFile(configPath(), 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return {};
    return parsed as Partial<Config>;
  } catch (error) {
    if (isMissingFile(error)) return {};
    if (error instanceof SyntaxError) {
      throw new ConfigError(
        `${configPath()} is not valid JSON.`,
        'Delete the file and run `ms login` again.',
      );
    }
    throw error;
  }
}

/** The whole config, file plus environment. May be incomplete. */
export async function loadPartialConfig(): Promise<Partial<Config>> {
  return { ...(await readConfigFile()), ...envOverrides() };
}

/** The config, or a pointed error naming exactly what is missing. */
export async function loadConfig(): Promise<Config> {
  const partial = await loadPartialConfig();
  const missing: string[] = [];
  if (!partial.workerUrl) missing.push('worker URL');
  if (!partial.adminToken) missing.push('admin token');
  if (missing.length > 0) {
    throw new ConfigError(`No ${missing.join(' and ')} configured.`);
  }
  return {
    ...partial,
    workerUrl: normalizeBaseUrl(partial.workerUrl as string),
    adminToken: partial.adminToken as string,
  };
}

/** Writes 0600 before the bytes land, so the token is never briefly world-readable. */
export async function saveConfig(config: Config): Promise<string> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify({ ...config, updatedAt: new Date().toISOString() }, null, 2)}\n`;
  await writeFile(path, body, { mode: 0o600, encoding: 'utf8' });
  await chmod(path, 0o600);
  return path;
}

export function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
