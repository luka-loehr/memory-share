import { constants } from 'node:fs';
import { access, copyFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Config } from './config.ts';
import { CliError, EXIT } from './errors.ts';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WranglerOptions {
  configPath: string;
  cwd: string;
  credentials: Pick<Config, 'cloudflareApiToken' | 'accountId'>;
  /** Echoes the wrangler invocation and its output; secrets are never arguments. */
  verbose?: boolean;
}

/**
 * `ms deploy` provisions into the user's own Cloudflare account, and the only
 * supported way to do that is wrangler itself — reimplementing the REST calls
 * would drift the moment Cloudflare changes a default.
 */
export class Wrangler {
  private readonly options: WranglerOptions;

  constructor(options: WranglerOptions) {
    this.options = options;
  }

  private env(): Record<string, string> {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    const { cloudflareApiToken, accountId } = this.options.credentials;
    if (cloudflareApiToken) env.CLOUDFLARE_API_TOKEN = cloudflareApiToken;
    if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
    // Keeps wrangler from opening a browser or asking a question mid-deploy.
    env.CI = env.CI ?? '1';
    env.WRANGLER_SEND_METRICS = 'false';
    return env;
  }

  /** `stdin` is how secret values reach wrangler — never as an argv element. */
  async run(args: readonly string[], stdin?: string): Promise<RunResult> {
    const command = ['wrangler', ...args, '--config', this.options.configPath];
    if (this.options.verbose === true) {
      process.stderr.write(`  $ ${command.join(' ')}\n`);
    }
    const spawn = () =>
      Bun.spawn(command, {
        cwd: this.options.cwd,
        env: this.env(),
        stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
        stdout: 'pipe',
        stderr: 'pipe',
      });

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn();
    } catch {
      throw new CliError('wrangler is not installed or not on PATH.', {
        code: EXIT.external,
        hint: 'Install it with `bun add -g wrangler`, then re-run `ms deploy`.',
      });
    }
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  /** Same as `run`, but a non-zero exit is fatal and quotes what wrangler said. */
  async require(args: readonly string[], what: string, stdin?: string): Promise<RunResult> {
    const result = await this.run(args, stdin);
    if (result.code !== 0) {
      const detail = (result.stderr.trim() || result.stdout.trim())
        .split('\n')
        .slice(-8)
        .join('\n');
      throw new CliError(`${what} failed (wrangler exited ${result.code}).\n${detail}`, {
        code: EXIT.external,
      });
    }
    return result;
  }
}

// ------------------------------------------------------------------ config --

const CONFIG_NAMES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

/**
 * The repo ships `wrangler.example.jsonc`; the real `wrangler.jsonc` is gitignored
 * because `ms deploy` writes the account's D1 id into it.
 */
const EXAMPLE_NAME = 'wrangler.example.jsonc';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walks up from `start` looking for the worker config the deploy belongs to.
 * A directory holding only the example gets a `wrangler.jsonc` copied from it.
 */
export async function findWranglerConfig(start: string): Promise<string> {
  let dir = resolve(start);
  for (let depth = 0; depth < 8; depth++) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(dir, name);
      if (await exists(candidate)) return candidate;
    }
    const example = join(dir, EXAMPLE_NAME);
    if (await exists(example)) {
      const target = join(dir, 'wrangler.jsonc');
      await copyFile(example, target, constants.COPYFILE_EXCL);
      return target;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CliError('No wrangler config found above the current directory.', {
    code: EXIT.config,
    hint: 'Run `ms deploy` from inside the repo, or pass --config path/to/wrangler.jsonc.',
  });
}

/** Comments and trailing commas are legal in wrangler.jsonc; JSON.parse hates both. */
export function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';
    if (inLine) {
      if (char === '\n') {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        index++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next;
        index++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLine = true;
      index++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlock = true;
      index++;
      continue;
    }
    out += char;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export interface WorkerConfig {
  name?: string;
  main?: string;
  migrations_dir?: string;
  d1_databases?: { binding?: string; database_name?: string; database_id?: string }[];
  r2_buckets?: { binding?: string; bucket_name?: string }[];
}

export async function readWorkerConfig(path: string): Promise<WorkerConfig> {
  const text = await readFile(path, 'utf8');
  if (path.endsWith('.toml')) {
    throw new CliError('wrangler.toml is not supported by `ms deploy`.', {
      code: EXIT.config,
      hint: 'memory-share ships a wrangler.jsonc; convert the config or pass --config.',
    });
  }
  try {
    return JSON.parse(stripJsonc(text)) as WorkerConfig;
  } catch (error) {
    throw new CliError(`${path} is not parseable: ${(error as Error).message}`, {
      code: EXIT.config,
    });
  }
}

/**
 * Writes a D1 id back into wrangler.jsonc *textually*, so comments, key order
 * and formatting survive. Re-serialising the parsed object would silently strip
 * every comment out of a file the user maintains by hand.
 */
export function setDatabaseId(text: string, databaseName: string, databaseId: string): string {
  const block = new RegExp(
    `("database_name"\\s*:\\s*"${escapeRegExp(databaseName)}"[\\s\\S]{0,400}?)"database_id"\\s*:\\s*"[^"]*"`,
  );
  if (block.test(text)) return text.replace(block, `$1"database_id": "${databaseId}"`);

  const reversed = new RegExp(
    `"database_id"\\s*:\\s*"[^"]*"([\\s\\S]{0,400}?"database_name"\\s*:\\s*"${escapeRegExp(databaseName)}")`,
  );
  if (reversed.test(text)) return text.replace(reversed, `"database_id": "${databaseId}"$1`);

  const insert = new RegExp(`("database_name"\\s*:\\s*"${escapeRegExp(databaseName)}")`);
  if (insert.test(text)) {
    return text.replace(insert, `$1,\n      "database_id": "${databaseId}"`);
  }
  throw new CliError(
    `Could not find the "${databaseName}" D1 binding in the wrangler config to write its id into.`,
    { code: EXIT.config, hint: `Add "database_id": "${databaseId}" by hand and re-run.` },
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Wrangler prints the deployed URL in its own prose; this fishes it out. */
export function extractWorkerUrl(output: string): string | null {
  const matches = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/gi);
  if (matches !== null && matches.length > 0) return matches[matches.length - 1] ?? null;
  const custom = output.match(/https:\/\/[a-z0-9.-]+\/?\s*$/im);
  return custom === null ? null : (custom[0] ?? '').trim().replace(/\/$/, '');
}
