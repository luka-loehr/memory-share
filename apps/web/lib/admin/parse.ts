/**
 * Request-body coercion for the owner API.
 *
 * The CLI is the only client, but "the only client" is exactly the assumption
 * that turns a typo into a corrupt row, so every field is checked here rather
 * than trusted at the call site.
 */

import { readBodyText } from '../http';

export type Body = Record<string, unknown>;

/**
 * The largest JSON body the owner API reads. The biggest legitimate one is a
 * membership change of 5000 ids (~340 kB); file bytes never travel as JSON.
 */
export const MAX_JSON_BYTES = 1024 * 1024;

/**
 * `null` for anything that is not a JSON object — including an empty body and
 * one larger than `maxBytes`.
 */
export async function readJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<Body | null> {
  try {
    const parsed: unknown = JSON.parse(await readBodyText(request, maxBytes));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Body;
  } catch {
    return null;
  }
}

export function str(value: unknown, max = 512): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed.length > max ? null : trimmed;
}

/** Digits only: `Number('')` and `Number('  ')` are 0, which is not what an empty field means. */
function numeric(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

export function int(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  const n = numeric(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

export function num(value: unknown): number | null {
  const n = numeric(value);
  return Number.isFinite(n) ? n : null;
}

export function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return null;
}

/** A list of distinct sha256 ids, or `null` if any entry is not one. */
export function idList(value: unknown, max = 5000): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !/^[0-9a-f]{64}$/.test(entry)) return null;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}
