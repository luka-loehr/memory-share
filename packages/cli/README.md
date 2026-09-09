# `ms` — the memory-share CLI

Bun + TypeScript. Talks to the owner API in `docs/CONTRACT.md`, and does the
video transcoding locally with an ffmpeg it ships itself.

```
bun install
bun run src/index.ts --help
bun link            # then `ms` is on PATH
```

## Getting started

```bash
ms deploy      # provision R2 + D1 + the worker into your own Cloudflare account
ms login       # or, against an instance that already exists
ms status      # pool, memories, and which ffmpeg it found
```

`ms deploy` is idempotent: it looks resources up before creating them, only
generates secrets that are absent, and writes the D1 id into `wrangler.jsonc`
textually so your comments survive. It prints a checklist of what it created
versus reused.

## Everyday use

```bash
ms upload ~/Pictures/croatia --tag croatia --tag with-mom
ms ls --tag croatia
ms tag a1b2c3d4 --add favourites
ms memory create "Croatia 2019" --tag croatia --expires 30d
ms memory set croatia-2019 --expires 90d
ms download croatia-2019 ./backup
ms download --tag croatia --variant view ./proxies   # the 1080p renditions
```

Interrupt any upload, encode or download and re-run the same command — finished
files are skipped, partial transfers resume, and a proxy that finished encoding
before the interruption is reused rather than encoded again. A re-run over a
library that is already complete encodes nothing and sends nothing; one that is
partly done sends only the pieces that are missing.

## What happens to your files

Per file: hash it, work out what it needs, produce any derivatives locally,
upload the original, then upload its derivatives. Re-running an import that
already finished costs one API call and re-encodes nothing.

### Photos

Almost always uploaded untouched — the edge transforms them at read time, so
storing a copy would multiply your bill for no benefit.

The one exception is a photo **larger than 20 MB**, which the Cloudflare Images
binding refuses as input. Those get a bounded `view/<sha>.jpg` produced locally:
longest edge 2560, EXIF orientation applied, metadata stripped. Rare files —
panoramas, ProRAW, stitched images — so the added storage is negligible.

If ffmpeg cannot decode such a photo (ProRAW DNG is the realistic case), the
upload still succeeds: the original goes up, the asset simply has no view, and
the share page shows a placeholder rather than serving the full-resolution file.
Those are listed by name at the end of the run.

### Video

Transcoded **locally**, because the machine holding the footage is the one that
should pay for it:

- A clip **already H.264 in a real `.mp4` within 1080p**, with its `moov` atom
  up front, is uploaded as-is and marked `view_is_original`. Nothing is encoded.
- A clip whose *picture* already qualifies but whose wrapper does not — a
  `.mov`, an `.mkv`, or an MP4 with a trailing `moov` — is **remuxed**: the
  H.264 stream is copied through untouched and only the container is rebuilt,
  with faststart. Lossless and near-instant; no frame is re-encoded.
- Anything else — HEVC, 4K, an unusual codec — gets a real `view/<sha>.mp4`
  proxy: H.264, scaled to fit 1080p, AAC audio, and `-movflags +faststart` so a
  browser can play and seek without fetching the whole file first.
- Every video also gets a poster frame, taken ~1.5 s in rather than at frame 0,
  which on phone footage is usually a motion-blurred mid-lift.

Derivatives are named after their parent and never become assets of their own —
`ms ls` shows your photographs, not the machinery behind them.

Hardware encoding is used when the ffmpeg build actually reports it —
`h264_videotoolbox` on macOS, `h264_nvenc` on Linux with NVIDIA — falling back
to `libx264`. `ms status` shows which was chosen.

Encodes run `cores - 2` at a time by default (`--jobs` to change), so the
machine stays usable. **One video failing to encode never aborts the batch**:
it is recorded, the rest proceed, and the summary prints a command that retries
just the failures.

`ms upload --dry-run` prints what each video would do and why, without encoding
or uploading anything.

## Where ffmpeg comes from

The CLI is the only thing you install. `ffmpeg` and `ffprobe` ship as **optional
dependencies**, one package per platform:

```
@memory-share/ffmpeg-darwin-arm64   @memory-share/ffmpeg-linux-x64
@memory-share/ffmpeg-darwin-x64     @memory-share/ffmpeg-linux-arm64
@memory-share/ffmpeg-win32-x64
```

Your package manager fetches only the one matching your platform and installs it
into `node_modules`, **inside the package directory** — so removing the CLI
removes the binaries with it. Nothing is ever downloaded into `~/.cache`,
`~/.local` or `/tmp`, because those would survive an uninstall.

If no prebuilt binary exists for your platform, the CLI falls back to a system
ffmpeg on `PATH`. If that is missing too it stops with an error naming your
platform — it never silently skips transcoding. `MS_FFMPEG_PATH` and
`MS_FFPROBE_PATH` override everything.

`exiftool` is *not* bundled (it is a Perl distribution, not a static binary). It
is used if present, to read photo EXIF dates; without it `taken_at` falls back
to file mtime.

## Uninstalling

Two things exist on your machine, and they come off separately.

```bash
ms uninstall                       # local credentials and caches
bun remove -g @memory-share/cli    # the CLI and its bundled ffmpeg
# or: npm rm -g @memory-share/cli
```

**A plain package-manager uninstall leaves one thing behind:**
`~/.config/memory-share` — your worker URL, admin token, upload journals, hash
cache and any cached video proxies. A package manager will not remove a
directory it did not create. `ms uninstall` removes exactly that directory, and
lists what it is deleting first. Run it *before* removing the package, or delete
the directory by hand afterwards:

```bash
rm -rf ~/.config/memory-share
```

Neither command touches Cloudflare. Your assets, memories and deployed worker
are untouched by both; to remove those, delete the R2 bucket, D1 database and
Worker from the Cloudflare dashboard.

## Conventions

- `--json` on every read command; under `--json`, stdout is *only* JSON and all
  prose moves to stderr, so `ms ls --json | jq` always works.
- Every destructive command confirms, and refuses outright without a terminal
  unless `--yes` is passed.
- Asset ids may be abbreviated to any unique prefix. Ambiguity is an error,
  never a guess.
- Exit codes: `0` ok, `2` usage, `3` config, `4` network, `5` API, `6` checksum
  mismatch, `7` external tool (wrangler or ffmpeg), `130` cancelled.
- `NO_COLOR`, `MS_WORKER_URL`, `MS_ADMIN_TOKEN`, `MS_CONFIG_PATH`,
  `MS_FFMPEG_PATH`, `MS_FFPROBE_PATH`, `MS_DEBUG`.

Credentials live in `~/.config/memory-share/config.json` at mode 0600. Secret
values are never echoed, logged, or printed back — confirmations show a
fingerprint (`ms_l****…mnop`) instead. `MS_CONFIG_PATH` relocates the whole
directory, not just the file.

## Layout

```
src/cli/        argument parsing and help rendering
src/core/       config, API client, hashing, resume, ffmpeg resolution,
                transcoding, probing, wrangler
src/ui/         colour, formatting, tables, the progress renderer, prompts
src/commands/   one file per command
scripts/        vendor-ffmpeg.ts — populates the platform packages at release
test/           bun test, over the pure logic
```

## Development

```bash
bun test          # 171 tests
bun run typecheck # tsc --noEmit, strict
bun run lint      # biome
bun run fix       # biome --write

# populate a platform package's bin/ (release step; ~50 MB per binary)
bun run scripts/vendor-ffmpeg.ts --platform darwin-arm64
bun run scripts/vendor-ffmpeg.ts --all
```

See `NOTES.md` for the places where the contract and this CLI disagree, and for
why the ffmpeg bundling is built the way it is.
