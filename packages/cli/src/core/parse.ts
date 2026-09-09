import { UsageError } from './errors.ts';

/**
 * Duration shorthand for `--expires`. Accepts a bare count of days ("30"),
 * a suffixed count ("30d", "12h", "8w"), or an ISO date/datetime. Returns
 * epoch *seconds*, matching `memories.expires_at` in the schema.
 */
const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
  w: 604_800,
  y: 31_536_000,
};

export function parseExpiry(input: string, now: number = Date.now()): number {
  const raw = input.trim();
  if (raw === '') throw new UsageError('--expires needs a value, e.g. 30d or 2026-12-24.');
  if (/^(never|none|0)$/i.test(raw)) {
    throw new UsageError('--expires never is the default; omit the flag instead.');
  }

  const relative = /^(\d+(?:\.\d+)?)\s*([smhdwy])?$/i.exec(raw);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = (relative[2] ?? 'd').toLowerCase();
    const seconds = UNIT_SECONDS[unit];
    if (seconds === undefined || !Number.isFinite(amount) || amount <= 0) {
      throw new UsageError(`Cannot read --expires ${raw}.`, 'Try 30d, 12h, 8w, or 2026-12-24.');
    }
    return Math.floor(now / 1000) + Math.round(amount * seconds);
  }

  const absolute = Date.parse(raw);
  if (Number.isNaN(absolute)) {
    throw new UsageError(`Cannot read --expires ${raw}.`, 'Try 30d, 12h, 8w, or 2026-12-24.');
  }
  if (absolute <= now) {
    throw new UsageError(`--expires ${raw} is in the past.`);
  }
  return Math.floor(absolute / 1000);
}

/** Tag names are lowercase slugs (schema comment on `tags.name`). */
export function normalizeTag(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  if (slug === '') throw new UsageError(`"${input}" does not reduce to a usable tag slug.`);
  return slug;
}

export function normalizeTags(inputs: readonly string[]): string[] {
  return dedupe(inputs.map(normalizeTag));
}

/**
 * `--pick a,b,c` and `--pick a --pick b` both land here, as does a bare list of
 * asset ids. Ids are sha256 hex; we accept a unique prefix and let the caller
 * resolve it against the pool.
 */
export function parseIdList(inputs: readonly string[]): string[] {
  const parts = inputs.flatMap((value) => value.split(','));
  const ids: string[] = [];
  for (const part of parts) {
    const id = part.trim().toLowerCase();
    if (id === '') continue;
    if (!/^[0-9a-f]{4,64}$/.test(id)) {
      throw new UsageError(
        `"${part.trim()}" is not an asset id.`,
        'Ids are sha256 hex; a prefix of 4 or more characters is enough.',
      );
    }
    ids.push(id);
  }
  if (ids.length === 0) throw new UsageError('No asset ids given.');
  return dedupe(ids);
}

/**
 * Resolves possibly-abbreviated ids against the pool. Ambiguity is an error
 * rather than a guess — picking the wrong photo for an album is not recoverable
 * by the recipient.
 */
export function resolveIds(
  requested: readonly string[],
  pool: readonly string[],
): { resolved: string[]; missing: string[]; ambiguous: string[] } {
  const resolved: string[] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];
  for (const want of requested) {
    if (pool.includes(want)) {
      resolved.push(want);
      continue;
    }
    const hits = pool.filter((id) => id.startsWith(want));
    if (hits.length === 1 && hits[0] !== undefined) resolved.push(hits[0]);
    else if (hits.length === 0) missing.push(want);
    else ambiguous.push(want);
  }
  return { resolved: dedupe(resolved), missing, ambiguous };
}

export function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** A slug as it appears in a share URL. */
export function assertSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(slug)) {
    throw new UsageError(`"${value}" is not a memory slug.`);
  }
  return slug;
}

/** Trailing slashes on a worker URL produce `//api/...`, which 404s. */
export function normalizeBaseUrl(input: string): string {
  const raw = input.trim();
  if (raw === '') throw new UsageError('The worker URL is empty.');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UsageError(`"${input}" is not a URL.`);
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}
