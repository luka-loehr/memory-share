/**
 * Request-body coercion for the owner API.
 *
 * The CLI is the only client, but "the only client" is exactly the assumption
 * that turns a typo into a corrupt row, so every field is checked here rather
 * than trusted at the call site.
 */

export type Body = Record<string, unknown>;

/** `null` for anything that is not a JSON object — including an empty body. */
export async function readJson(request: Request): Promise<Body | null> {
  try {
    const parsed: unknown = await request.json();
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

export function int(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

export function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
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
