import { guard } from '@/lib/guard';
import { json } from '@/lib/http';
import { listAssets, toManifest } from '@/lib/memory';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await guard(request, slug);
  if (!gate.ok) return gate.response;

  const assets = await listAssets(gate.env, gate.memory.id);
  return json(toManifest(gate.memory, assets));
}
