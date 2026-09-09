# Security

What this system protects, how, and — more usefully — what it does not.

## Threat model

memory-share is built for one situation: you have media you want a specific
person to see, and you do not want it public, indexed, or recompressed. The
adversary is a link that leaks — forwarded, pasted into a group chat, sitting in
someone's browser history, or guessed by a crawler.

It is **not** built to withstand a determined attacker who has your Cloudflare
credentials, nor to keep a recipient from re-sharing what you deliberately gave
them. Anyone who can open a memory can screenshot it.

## What holds

**One password per memory, PBKDF2-hashed.** Plaintext never reaches the
database. A generated password is five random dictionary words (~79 bits) —
long enough that guessing is not a threat worth modelling.

**Session cookies are HMAC-signed and scoped to a single memory.** Unlocking
"Croatia" grants nothing on "Family dinner". The signature is verified
*before* the expiry it protects is trusted, so a token cannot be extended by
editing it. Media keys are checked against membership in *that* memory, so
knowing a sha256 from one album is a 404 in another.

**The R2 bucket has no public URL and no presigned surface.** Every byte —
uploads included — passes through the Worker behind the admin token or the
memory's cookie. This costs upload throughput (see below) and is worth it: there
is no URL anywhere that serves an object without an authorisation check.

**The owner API is a separate surface.** `/api/admin/*` requires a bearer token
compared in constant time over SHA-256 digests, is unreachable from a share
page, and never sets or honours a share cookie.

**`allow_download = 0` is a control, not a hint.** No failure path may fall
back to serving original bytes on a memory that withholds them — when a
rendition cannot be produced, the request fails with 415 rather than degrading
to the full-resolution file. This was a real bug once; it is now a rule.

**Media responses are `private, no-cache`.** A locked session cannot replay a
media URL from browser cache. An earlier version used a year-long `immutable`
cache, which made "Lock" cosmetic.

**Renditions carry no metadata.** A bounded view generated for an oversized
photo is written with `-map_metadata -1`; GPS coordinates and camera details do
not reach a viewer. The *original* keeps its EXIF — that is the point of a
byte-exact download — so anyone you let download is getting your metadata too.

**Nothing is indexed.** Every page is `noindex, nofollow, nocache`, and the gate
never renders a legible frame: the cover is a 64px blurred thumbnail, so what
crosses the wire before unlock cannot be un-blurred into a photograph.

## What does not hold

**Login rate limiting is soft.** Cloudflare's rate-limit binding caches its
counter per isolate and updates asynchronously — their documentation calls it
"permissive, eventually consistent, intentionally not an accurate accounting
system". Measured on a deployment: fourteen sequential attempts, none blocked.
It is a speed bump. The real control is password entropy, which is why generated
passwords are five words and why you should not replace one with something
memorable.

**Logout does not revoke a token.** `POST /api/m/:slug/lock` clears the cookie,
but a token already issued stays valid until it expires. If one is ever captured
— a shared machine, a screenshot of devtools — rotate `SESSION_SECRET`:

```bash
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put SESSION_SECRET
```

That invalidates every session on every memory at once. There is no per-session
revocation list.

**A recipient can keep what you shared.** `allow_download = 0` withholds the
original file; it does not prevent screenshots, screen recording, or saving the
rendition. Treat it as "don't hand over the master", not as DRM.

**The admin token is total access.** Anyone holding it can read, delete, or
re-share everything. It lives in `~/.config/memory-share/config.json` at mode
0600. `ms uninstall` removes it.

**Uploads are size-verified, not hash-verified server-side.** The Worker checks
that the assembled object matches the declared byte count; it does not re-hash
it. The CLI verifies sha256 on download, so corruption is caught on the way out
rather than on the way in.

## Reporting

Open an issue, or for anything you would rather not post publicly, contact the
repository owner directly.
