# Internal contract

The single source of truth every part of the system builds against. Schema
lives in `db/migrations/`. If something here disagrees with the code, this file
is wrong and should be fixed — do not silently diverge.

## Vocabulary

- **asset** — bytes in R2, identified by the sha256 of the original. Uploaded
  once, referenced many times.
- **tag** — a lowercase slug on an asset. An asset has any number of tags.
- **memory** — a shareable album: a title, a password, and an ordered list of
  assets. Deleting a memory never deletes assets.

## R2 layout

```
orig/<sha256>            byte-identical original. never rewritten.
view/<sha256>.mp4        ~1080p H.264 + faststart, for a video.
view/<sha256>.jpg        bounded rendition of a photo above the 20 MB
                         Images-binding input cap.
thumb/<sha256>.jpg       poster frame. VIDEO ONLY.
```

`<sha256>` is always the ORIGINAL's hash, including for derivatives. A
derivative is named after its parent, never after its own content — that is
what makes `view/` and `thumb/` addressable from an asset row without storing
a second identifier.

Keys are content-addressed, so two identical uploads collide onto one object
instead of duplicating a terabyte.

**Photos store no derivatives at all.** Thumbnails and view-size renders are
produced on the fly by the Cloudflare Images binding, reading the original's
bytes straight from the R2 binding — the bucket stays private, nothing is
pre-generated, and the transformed result is edge-cached and billed once per
month per unique size. HEIC is a supported input; the output is WebP/JPEG.

**Video proxies are encoded locally by the CLI** using an ffmpeg it ships
itself, then uploaded alongside the original. There is no server-side
transcoding: no Containers, no queue, no Stream. The deployed Worker is pure
storage-and-serving, which keeps the hosted side cheap, stateless and trivial
to self-deploy.

This asymmetry is deliberate. Images caps binding input at 20 MB and cannot
touch video at all, so photos are transformed at read time by the edge, and
video — the genuinely heavy work — is transcoded once on the machine that
already holds the footage.

## Derivative URLs

The share API keeps one URL shape regardless of where the bytes come from:

| url | photo | video |
|---|---|---|
| `…/media/thumb/<sha>` | Images transform of `orig/`, 480px WebP | stored poster frame |
| `…/media/view/<sha>` | Images transform of `orig/`, 2560px | `view/<sha>.mp4`, Range-streamed |
| `…/media/orig/<sha>?dl=1` | the untouched original | the untouched original |

Clients never learn which path served them. A photo is always "ready"; only
videos can be mid-derivation.

## Owner API (`/api/admin/*`)

Authenticated by `Authorization: Bearer <ADMIN_TOKEN>` (a Worker secret). Used
exclusively by the CLI. Never reachable from a share page.

| method | path | body / query | returns |
|---|---|---|---|
| `POST` | `/api/admin/upload/begin` | `{sha256, filename, bytes, mime, role?, ofAsset?, viewIsOriginal?}` + optional `{width, height, duration, takenAt, kind}` | `{assetId, exists, uploadId?, asset?}` — `exists:true` short-circuits a duplicate and returns the existing row |
| `PUT` | `/api/admin/upload/part` | `?uploadId=&part=` + body | `{etag}` |
| `GET` | `/api/admin/upload/:uploadId/parts` | | `{parts:[{part, etag, size}]}` — lets an interrupted multipart resume |
| `POST` | `/api/admin/upload/complete` | `{uploadId, parts[]}` | `{asset}` for an original, `{ok}` for a derivative |
| `GET` | `/api/admin/assets` | `?tag=&kind=&limit=&cursor=` | `{assets[], cursor?}` |
| `GET` | `/api/admin/assets/:id/bytes` | `?variant=orig\|view` | the bytes. Range-aware. **The owner's read path** — never goes through a memory |
| `POST` | `/api/admin/assets/tag` | `{assetIds[], add[], remove[]}` | `{updated}` |
| `DELETE` | `/api/admin/assets/:id` | | `{deleted}` — removes bytes AND rows; the only destructive call |
| `GET` | `/api/admin/memories` | | `{memories[]}` |
| `GET` | `/api/admin/memories/:slug` | | `{memory, items[]}` — full membership |
| `POST` | `/api/admin/memories` | `{title, note?, assetIds[], password?, allowDownload?, expiresAt?}` | `{memory, password}` — password generated if omitted |
| `PATCH` | `/api/admin/memories/:slug` | `{title?, note?, add[]?, remove[]?, cover?, allowDownload?, expiresAt?}` | `{memory}` |
| `POST` | `/api/admin/memories/:slug/rotate` | | `{password}` |
| `DELETE` | `/api/admin/memories/:slug` | | `{deleted}` — assets untouched, by design |
| `GET` | `/api/admin/status` | | `{assets, memories, bytes, derive:{pending,running,failed}}` |

**Uploads are always multipart**, whatever the size — one code path, and a
one-part upload costs nothing extra. `begin` therefore always returns an
`uploadId` and never a presigned `uploadUrl`; bytes go through
`/api/admin/upload/part`, so the R2 bucket needs no public or presigned surface
at all.

**The owner never reads through a share.** `/api/admin/assets/:id/bytes` exists
precisely so `ms download` does not have to unlock an album with its own
password, mint a throwaway memory, or write an `access_log` row for what is
conceptually a read. Owner reads and recipient reads are different operations
and stay on different paths.

**Share page URL** is `{workerUrl}/m/{slug}`. The CLI prints exactly that.

## Share API (public, per memory)

| method | path | notes |
|---|---|---|
| `POST` | `/api/m/:slug/unlock` | `{password}` → sets `ms_<slug>` HMAC cookie. Rate limited. |
| `POST` | `/api/m/:slug/lock` | clears it |
| `GET` | `/api/m/:slug/manifest` | requires cookie → `{title, note, allowDownload, items[]}` |
| `GET` | `/api/m/:slug/media/<key>` | requires cookie; Range-aware; `?dl=1` for the original |
| `GET` | `/api/m/:slug/cover` | **no cookie** — heavily dithered cover for the gate |

A session cookie is scoped to one memory: unlocking "Beach week" grants nothing on
"Family dinner". Media keys are validated against membership in *that*
memory, so knowing a sha256 from one album does not grant it in another.

## Uploading a derivative

`role` decides what an upload IS. Omitted or `'orig'` means a new asset: the
object lands at `orig/<sha256>` and an `assets` row is created. `role:'view'`
or `role:'thumb'` means a derivative, and then `ofAsset` MUST carry the
ORIGINAL's sha256.

A derivative:
- is written to `thumb/<ofAsset>.jpg`, or to `view/<ofAsset>.<ext>` where the
  extension follows the DECLARED MIME, never the role — a `view` is not always
  a video, and naming a photo's rendition `.mp4` would hand a browser an image
  labeled as video. `view` accepts `video/mp4` and `image/jpeg`; any other
  mime is refused 400 rather than guessed,
- creates **no** `assets` row — it is not an asset and must never appear in
  `ms ls`,
- on `complete`, updates its parent row's `view_key` / `thumb_key` and sets
  `derive_state='ready'`.

The `sha256` sent for a derivative is the derivative's own hash, used only to
verify the bytes arrived intact. It never appears in a key.

**Order matters: upload the original first.** A derivative whose `ofAsset` has
no row is rejected with 409 rather than orphaned.

This is why `complete` no longer carries a `viewKey` — the derivative's own
completion writes it. `complete` is exactly `{uploadId, parts[]}`. There is one
way for bytes to reach a derivative key, and no path by which a proxy can
accidentally become a standalone asset.

**Only `role:'view'` on a VIDEO parent moves `derive_state` to `'ready'`.** A
poster landing first sets `thumb_key` and nothing else — otherwise an asset
would read as ready with `view_key` still NULL, which is precisely the state
the field exists to distinguish. An oversize photo's view sets `view_key` and
leaves the row `'skipped'`: a photo is never observably mid-derivation.

**Derivatives never short-circuit**, because a derivative's own hash is not
persisted and the server therefore cannot tell a current encode from a stale
one. `begin` always returns `exists:false` for `role:'view'|'thumb'`.

Re-encoding on every re-run would still be intolerable on a large library, so
the skip decision belongs to the client, where the encode cost is paid: when
`begin` for an ORIGINAL returns `exists:true`, it also returns the existing
`asset` row. If that row already has the `view_key` / `thumb_key` the CLI was
about to produce, the CLI skips both the encode and the upload. The server stays
stateless about encoder versions; the client stays cheap to re-run.

**`view_is_original` is declared on the ORIGINAL's `begin`**, via
`viewIsOriginal: true` — not implied by a derivative, since in that case no
derivative is ever uploaded. The server then sets `view_key = orig_key`,
`view_is_original = 1`, and `derive_state = 'skipped'` in the same write that
creates the row. This is the only path that sets the flag.

## No server-side derivation

There is no queue and no worker that produces derivatives. Photos are
transformed at read time by the Images binding; video proxies are encoded
locally by the CLI and uploaded as derivatives per the section above.

`derive_state` therefore describes upload completeness, not a job:
`'skipped'` for every photo and for a video whose original is already
browser-safe (H.264 in MP4, within 1080p — in which case `view_is_original` is
set and no proxy is uploaded), `'ready'` once a video's proxy lands, and
`'pending'` only in the window between an original landing and its proxy
following.

## Invariants

1. `orig/` objects are written once and never modified.
2. Deleting a memory touches `memory_assets` only.
3. An asset with `derive_state != 'ready'` must still render *something* — the
   UI shows a developing state, never a broken tile.
4. Every share response is gated on the cookie for that exact slug.
5. No secret, token, or password ever reaches the client bundle.
