import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { Gallery } from '@/app/components/gallery';
import { Gate } from '@/app/components/gate';
import { env as bindings } from '@/lib/env';
import { findMemory, isExpired, listAssets, toManifest } from '@/lib/memory';
import { cookieName, verifySession } from '@/lib/session';

// Every render depends on a cookie and on D1; nothing here may be prerendered.
export const dynamic = 'force-dynamic';

export default async function MemoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const env = await bindings();

  const memory = await findMemory(env, slug);
  if (!memory || isExpired(memory)) notFound();

  const cookie = (await cookies()).get(cookieName(slug))?.value;
  const unlocked = env.SESSION_SECRET
    ? await verifySession(env.SESSION_SECRET, slug, cookie)
    : false;

  if (!unlocked) {
    // The gate gets the title and note and nothing else — no manifest, no keys,
    // no dimensions. Only the deliberately degraded cover crosses the wire.
    return <Gate slug={slug} title={memory.title} note={memory.note} />;
  }

  // Read straight from D1 rather than round-tripping our own manifest endpoint;
  // the endpoint exists for the client and is the same projection.
  const assets = await listAssets(env, memory.id);
  return <Gallery slug={slug} manifest={toManifest(memory, assets)} />;
}
