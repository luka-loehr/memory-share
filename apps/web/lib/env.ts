import { getCloudflareContext } from '@opennextjs/cloudflare';

export type Env = CloudflareEnv;

/** The Worker bindings for the current request. */
export async function env(): Promise<Env> {
  const { env } = await getCloudflareContext({ async: true });
  return env;
}
