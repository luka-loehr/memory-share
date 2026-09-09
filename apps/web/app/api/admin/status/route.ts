import { requireAdmin } from '@/lib/admin/auth';
import { json } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * What the pool holds, in one round trip.
 *
 * `derive` counts upload completeness, not a job queue — there is no
 * server-side derivation anywhere in this system. `pending` is the window
 * between a video's original landing and its locally-encoded proxy following;
 * `running` and `failed` exist because the schema allows them, and a non-zero
 * count is a real signal that some CLI run died mid-flight.
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const env = auth.env;

  const [pool, memories, states] = await env.DB.batch<Record<string, number | string>>([
    env.DB.prepare(`SELECT COUNT(*) AS assets, COALESCE(SUM(bytes), 0) AS bytes FROM assets`),
    env.DB.prepare(`SELECT COUNT(*) AS memories FROM memories`),
    env.DB.prepare(`SELECT derive_state, COUNT(*) AS n FROM assets GROUP BY derive_state`),
  ]);

  const derive = { pending: 0, running: 0, failed: 0 };
  for (const row of states.results ?? []) {
    const state = String(row.derive_state);
    if (state === 'pending' || state === 'running' || state === 'failed') {
      derive[state] = Number(row.n) || 0;
    }
  }

  return json({
    assets: Number(pool.results?.[0]?.assets ?? 0),
    memories: Number(memories.results?.[0]?.memories ?? 0),
    bytes: Number(pool.results?.[0]?.bytes ?? 0),
    derive,
  });
}
