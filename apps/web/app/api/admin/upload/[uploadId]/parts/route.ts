import { requireAdmin } from '@/lib/admin/auth';
import { listReceipts, readUploadId } from '@/lib/admin/upload';
import { json } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * What the Worker already holds for this multipart session.
 *
 * This is what makes resume a property of the system rather than of one
 * laptop's journal: a re-run from another machine, or after the local state
 * directory is gone, still skips the parts that already landed.
 */
export async function GET(request: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const { uploadId } = await ctx.params;
  const token = decodeURIComponent(uploadId);

  const session = await readUploadId(auth.env, token);
  if (!session) return json({ error: 'unknown_upload' }, { status: 404 });

  return json({ parts: await listReceipts(auth.env, token) });
}
