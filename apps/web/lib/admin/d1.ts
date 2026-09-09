/**
 * D1 limits every statement to 100 bound parameters, and a batch to a bounded
 * number of statements. Both ceilings are invisible against small fixtures and
 * fatal on a first real import: a 284-item library produced a bare 500 from
 * three separate call sites — listing assets, tagging them, and creating a
 * memory from a tag.
 *
 * Anything that binds one parameter per asset, or queues one statement per
 * asset, goes through these helpers rather than discovering the limit again.
 */

/** Comfortably under D1's 100-parameter ceiling. */
export const D1_MAX_BOUND_PARAMS = 90;

/** Statements per batch. */
export const D1_MAX_BATCH = 100;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

/**
 * Runs a batch in bounded groups. NOTE: this is no longer one atomic
 * transaction — a failure partway leaves earlier groups applied. Every current
 * caller is idempotent (INSERT … ON CONFLICT DO NOTHING, or DELETE), so a retry
 * converges; do not use this for a sequence that is not.
 */
export async function batchInChunks(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<void> {
  for (const group of chunk(statements, D1_MAX_BATCH)) {
    await db.batch(group);
  }
}
