// Declaration merging onto the wrangler-generated CloudflareEnv, for values that
// are Worker *secrets* rather than vars — they must never appear in wrangler.jsonc.
interface CloudflareEnv {
  /** HMAC key for share-session cookies. `wrangler secret put SESSION_SECRET`. */
  SESSION_SECRET?: string;
}
