# `ms` — the memory-share CLI

Bun + TypeScript. Talks to the owner API in `docs/CONTRACT.md`.

```
bun install
bun run src/index.ts --help
bun link            # then `ms` is on PATH
```

## Getting started

```bash
ms deploy      # provision R2 + D1 + the worker into your own Cloudflare account
ms login       # or, against an instance that already exists
ms status
```

`ms deploy` is idempotent: it looks resources up before creating them, only
generates secrets that are absent, and writes the D1 id into `wrangler.jsonc`
textually so your comments survive. It prints a checklist of what it created
versus reused. Re-run it as often as you like.

## Everyday use

```bash
ms upload ~/Pictures/croatia --tag croatia --tag with-mom
ms ls --tag croatia
ms tag a1b2c3d4 --add favourites
ms memory create "Croatia 2019" --tag croatia --expires 30d
ms memory ls
ms download croatia-2019 ./backup
```

Interrupt any upload or download and re-run the same command — finished files
are skipped and partial ones resume.

## Conventions

- `--json` on every read command; under `--json`, stdout is *only* JSON and all
  prose moves to stderr, so `ms ls --json | jq` always works.
- Every destructive command confirms, and refuses outright without a terminal
  unless `--yes` is passed.
- Asset ids may be abbreviated to any unique prefix. Ambiguity is an error, never
  a guess.
- Exit codes: `0` ok, `2` usage, `3` config, `4` network, `5` API, `6` checksum
  mismatch, `7` external tool (wrangler), `130` cancelled.
- `NO_COLOR`, `MS_WORKER_URL`, `MS_ADMIN_TOKEN`, `MS_CONFIG_PATH`, `MS_DEBUG`.

Credentials live in `~/.config/memory-share/config.json` at mode 0600. Secret
values are never echoed, logged, or printed back — confirmations show a
fingerprint (`ms_l****…mnop`) instead.

## Layout

```
src/cli/        argument parsing and help rendering
src/core/       config, API client, hashing, resume, probing, wrangler
src/ui/         colour, formatting, tables, the progress renderer, prompts
src/commands/   one file per command
test/           bun test, over the pure logic
```

## Development

```bash
bun test          # 92 tests
bun run typecheck # tsc --noEmit, strict
bun run lint      # biome
bun run fix       # biome --write
```

See `NOTES.md` for the places where the contract and this CLI disagree.
