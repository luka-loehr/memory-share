# Architecture

## Assets and memories

Most photo sharing conflates two things this system keeps apart:

- an **asset** is bytes in R2, addressed by the sha256 of the original,
- a **memory** is a curated, password-protected album that *references* assets.

Deleting a memory deletes the album, never the bytes. So you can upload a
terabyte once, and cut any number of shares out of it:

```
                         ┌─────────────────────────────┐
  ms upload ~/beach      │  asset pool  (R2 + D1)      │
  ms upload ~/mountains ▶│  content-addressed, tagged  │
                         └───────┬─────────────┬───────┘
                                 │             │
              ┌──────────────────┘             └───────────────┐
              ▼                                                ▼
   "Summer 2024"                                   "Best of both"
   everything tagged #beach                        5 from #beach
                                                 + 5 from #mountains
              │                                                │
              ▼                                                ▼
     /m/summer-2024                                /m/best-of-both
     link + password                               link + password
```

The same photograph appears in both albums and is stored exactly once. Deleting
either album touches nothing but a join table. Tags, not folders, are what make
the second album a query rather than a copy.

## Originals and renditions

`orig/` objects are written once and never modified, and the download button
serves them unaltered.

Browsers cannot render HEIC and mostly cannot play HEVC, which covers most of an
iPhone library. So every asset also has a browser-renderable rendition, and the
two are kept separate:

| | viewing | downloading |
|---|---|---|
| photo | Cloudflare Images transform of the original, at read time | the original |
| video | locally encoded 1080p H.264 proxy | the original |

The recipient watches a proxy and can download the original file.

## Where the work happens

| stage | runs | why |
|---|---|---|
| hashing, video transcode, oversize-photo renditions | **your machine**, via the CLI's bundled ffmpeg | the heavy work, where the footage already is |
| photo thumbnails and view renditions | **the edge**, Cloudflare Images binding | stores nothing, reads a private bucket |
| storage and serving | **your Worker** | no queue, no containers, no transcoding |

The deployed side only stores and serves. There is no background job to fail, no
queue to drain, nothing to keep warm. It costs R2 storage and very little else.

## Security summary

- One password per memory, PBKDF2-hashed; generated passwords are five random
  words (~79 bits), because rate limiting on Cloudflare's binding is eventually
  consistent and cannot be relied on to stop guessing.
- Session cookies are HMAC-signed and **scoped to a single memory**: unlocking
  one album grants nothing on another, and a media key from one is a 404 in the
  other.
- The R2 bucket has no public URL and no presigned surface. Every byte is
  served through the Worker, behind the cookie for that exact memory.
- `allow_download = 0` is a control, not a hint: no failure path may fall back
  to serving original bytes on a memory that withholds them.
- Media responses are `private, no-cache` so a locked session cannot replay
  from browser cache.

Full detail, including what is *not* protected, in [SECURITY.md](SECURITY.md).

## Repository layout

| path | what it is |
|---|---|
| [docs/CONTRACT.md](CONTRACT.md) | the API and storage contract every part builds against |
| [db/migrations/](../db/migrations/) | schema, heavily commented |
| [packages/cli/](../packages/cli/) | the `ms` CLI |
| [apps/web/](../apps/web/) | Worker: share pages, share API, owner API |
| [docs/SECURITY.md](SECURITY.md) | what is protected, and what is not |
