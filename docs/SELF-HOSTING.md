# Self-hosting

memory-share runs entirely in your own Cloudflare account: a Worker (the Next.js
app in `apps/web`, built with OpenNext), an R2 bucket for media and a D1
database for metadata. You drive it with the `ms` CLI.

## Requirements

- [Bun](https://bun.sh) 1.4 or newer (the CLI)
- Node.js and npm (building the Worker)
- A Cloudflare account with Workers, R2, D1 and Images enabled, and an API token
  that can manage them

## Install the CLI

The CLI is not published to npm. Install it from a clone:

```bash
git clone https://github.com/luka-loehr/memory-share.git
cd memory-share/packages/cli
bun install
bun link        # puts `ms` on PATH (~/.bun/bin)
ms --help
```

## Deploy

```bash
cd memory-share/apps/web
npm install
npx opennextjs-cloudflare build
ms deploy
```

`ms deploy` runs from `apps/web` (or pass `--config path/to/wrangler.jsonc`) and:

1. copies `wrangler.example.jsonc` to `wrangler.jsonc` if that file does not exist yet,
2. creates the R2 bucket and D1 database, or reuses them if they exist,
3. writes your D1 `database_id` into `wrangler.jsonc`,
4. runs `wrangler d1 migrations apply` (skip with `--skip-migrations`),
5. generates `SESSION_SECRET` and `ADMIN_TOKEN` if absent,
6. deploys the Worker and saves the worker URL and admin token for the CLI.

The schema lives in `db/migrations/`, which the example config does not point
wrangler at. On a new database, apply it once from `apps/web`:

```bash
npx wrangler d1 execute memory-share --remote --file ../../db/migrations/0001_init.sql
```

It is safe to re-run `ms deploy`. `wrangler.jsonc` is gitignored because it holds your
account's database id; edit it there (not in the example) if you want different
bucket or database names.

The Worker is served at `https://memory-share-web.<your-subdomain>.workers.dev`
unless you add a custom domain in the Cloudflare dashboard.

To use an instance that already exists, run `ms login` instead and enter the
worker URL and admin token.

## Configuration

The CLI stores its settings in `~/.config/memory-share/config.json` (mode 0600).
Environment variables override the file:

| variable | purpose |
|---|---|
| `MS_WORKER_URL` | worker origin |
| `MS_ADMIN_TOKEN` | owner API token (`ADMIN_TOKEN` secret) |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | used by `ms deploy` |
| `MS_CONFIG_PATH` | relocates the config directory |
| `MS_FFMPEG_PATH`, `MS_FFPROBE_PATH` | use a specific ffmpeg build |

## Everyday use

```bash
ms upload ~/Pictures/beach --tag beach
ms upload ~/Pictures/mountains --tag mountains

ms memory create "Summer 2024" --tag beach
ms memory create "Best of both" --pick a1b2c3,d4e5f6
```

See the [CLI reference](../packages/cli/README.md) for every command.

## What to expect on a large import

Measured on a 284-item, 12.2 GB iPhone library (239 photos, 45 videos, mostly
4K HEVC), from a Mac with an 84 Mbps uplink:

| | |
|---|---|
| video transcode | 45 proxies, hardware-encoded, ~12 min |
| upload | 12.3 GB in 51 min at ~4 MB/s |
| stored | originals + 1.0 GB of proxies; no photo derivatives |

Uploads ran at roughly a third of the line rate. Every byte passes through the
Worker, because presigned URLs would mean a URL that serves an object without an
authorization check (see [SECURITY.md](SECURITY.md)). At that rate a terabyte
takes days rather than hours. `--concurrency` raises parallelism; the default is
conservative.

Interrupted imports resume. Re-running over an unchanged library encodes
nothing and sends nothing.

## Uninstall

```bash
ms uninstall                  # removes ~/.config/memory-share
cd memory-share/packages/cli
bun unlink                    # removes `ms` from PATH
```

ffmpeg ships as platform-specific optional dependencies inside
`node_modules`, so deleting the clone removes the binaries with it. Neither
command touches Cloudflare; delete the Worker, R2 bucket and D1 database from
the dashboard to remove the deployment.
