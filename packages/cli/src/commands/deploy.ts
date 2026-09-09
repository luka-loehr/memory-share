import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { FlagSpecs, ParsedArgs } from '../cli/args.ts';
import { getBool, getString } from '../cli/args.ts';
import { ApiClient } from '../core/api.ts';
import { type Config, loadPartialConfig, saveConfig } from '../core/config.ts';
import { CliError, EXIT } from '../core/errors.ts';
import { normalizeBaseUrl } from '../core/parse.ts';
import {
  extractWorkerUrl,
  findWranglerConfig,
  readWorkerConfig,
  setDatabaseId,
  Wrangler,
} from '../core/wrangler.ts';
import { bold, cyan, dim, green, yellow } from '../ui/color.ts';
import * as out from '../ui/out.ts';
import { askSecret, confirm } from '../ui/prompt.ts';

export const deployFlags: FlagSpecs = {
  config: { type: 'string', describe: 'Path to wrangler.jsonc (found automatically otherwise)' },
  account: { type: 'string', describe: 'Cloudflare account id' },
  'rotate-secrets': { type: 'boolean', describe: 'Replace SESSION_SECRET and ADMIN_TOKEN' },
  'skip-migrations': { type: 'boolean', describe: 'Do not run `d1 migrations apply`' },
  yes: { type: 'boolean', short: 'y', describe: 'Do not ask before rotating secrets' },
  verbose: { type: 'boolean', short: 'v', describe: 'Echo every wrangler invocation' },
  json: { type: 'boolean', describe: 'Emit the provisioning report as JSON' },
};

type Disposition = 'created' | 'reused' | 'updated' | 'skipped';

interface Step {
  what: string;
  detail: string;
  disposition: Disposition;
}

/**
 * Provisions memory-share into the caller's own Cloudflare account.
 *
 * Every step is idempotent by construction: resources are looked up before they
 * are created, secrets are only generated when absent, and the D1 id is written
 * into wrangler.jsonc only when it differs. Running `ms deploy` twice in a row
 * must be indistinguishable from running it once, because in practice people
 * run it again the moment anything looks wrong.
 */
export async function deploy(args: ParsedArgs): Promise<number> {
  const json = getBool(args, 'json');
  out.setJsonMode(json);

  const stored = await loadPartialConfig();
  const configPath = resolve(
    getString(args, 'config') ?? (await findWranglerConfig(process.cwd())),
  );
  const root = dirname(configPath);
  const worker = await readWorkerConfig(configPath);

  const workerName = worker.name;
  const bucketName = worker.r2_buckets?.[0]?.bucket_name;
  const database = worker.d1_databases?.[0];
  if (
    workerName === undefined ||
    bucketName === undefined ||
    database?.database_name === undefined
  ) {
    throw new CliError(`${configPath} is missing a worker name, an R2 bucket or a D1 binding.`, {
      code: EXIT.config,
      hint: 'The worker package owns that file; it must declare all three.',
    });
  }
  const databaseName = database.database_name;

  const apiToken =
    getString(args, 'account') === undefined
      ? (stored.cloudflareApiToken ?? process.env.CLOUDFLARE_API_TOKEN)
      : stored.cloudflareApiToken;
  const credentials = {
    cloudflareApiToken: apiToken ?? (await askForToken()),
    accountId: getString(args, 'account') ?? stored.accountId,
  };

  const wrangler = new Wrangler({
    configPath,
    cwd: root,
    credentials,
    verbose: getBool(args, 'verbose'),
  });

  const steps: Step[] = [];
  out.heading(`Deploying ${bold(workerName)}`);
  out.note(`config  ${configPath}`);

  // ------------------------------------------------------------- R2 bucket --
  const buckets = await wrangler.require(['r2', 'bucket', 'list'], 'listing R2 buckets');
  if (mentions(buckets.stdout, bucketName)) {
    steps.push({ what: 'R2 bucket', detail: bucketName, disposition: 'reused' });
  } else {
    await wrangler.require(
      ['r2', 'bucket', 'create', bucketName],
      `creating the bucket ${bucketName}`,
    );
    steps.push({ what: 'R2 bucket', detail: bucketName, disposition: 'created' });
  }

  // ------------------------------------------------------------ D1 database --
  const listed = await wrangler.require(['d1', 'list', '--json'], 'listing D1 databases');
  let databaseId = findDatabaseId(listed.stdout, databaseName);
  if (databaseId === null) {
    const created = await wrangler.require(
      ['d1', 'create', databaseName],
      `creating the database ${databaseName}`,
    );
    databaseId = findDatabaseId(created.stdout, databaseName) ?? extractUuid(created.stdout);
    if (databaseId === null) {
      throw new CliError('D1 was created but wrangler printed no database id.', {
        code: EXIT.external,
        hint: 'Run `wrangler d1 list` and paste the id into wrangler.jsonc by hand.',
      });
    }
    steps.push({
      what: 'D1 database',
      detail: `${databaseName} ${dim(databaseId)}`,
      disposition: 'created',
    });
  } else {
    steps.push({
      what: 'D1 database',
      detail: `${databaseName} ${dim(databaseId)}`,
      disposition: 'reused',
    });
  }

  // ------------------------------------------------------- wrangler.jsonc ---
  const original = await readFile(configPath, 'utf8');
  if (database.database_id === databaseId) {
    steps.push({
      what: 'wrangler.jsonc',
      detail: 'database_id already correct',
      disposition: 'reused',
    });
  } else {
    await writeFile(configPath, setDatabaseId(original, databaseName, databaseId), 'utf8');
    steps.push({ what: 'wrangler.jsonc', detail: 'database_id written', disposition: 'updated' });
  }

  // ----------------------------------------------------------- migrations ---
  if (getBool(args, 'skip-migrations')) {
    steps.push({ what: 'migrations', detail: '--skip-migrations', disposition: 'skipped' });
  } else {
    const applied = await wrangler.require(
      ['d1', 'migrations', 'apply', databaseName, '--remote'],
      'applying migrations',
    );
    const already = /no migrations to apply/i.test(applied.stdout + applied.stderr);
    steps.push({
      what: 'migrations',
      detail: already ? 'already up to date' : 'applied',
      disposition: already ? 'reused' : 'updated',
    });
  }

  // --------------------------------------------------------------- secrets --
  const existingSecrets = await listSecrets(wrangler);
  const rotate = getBool(args, 'rotate-secrets');
  if (rotate) {
    await confirm(
      'Rotating ADMIN_TOKEN and SESSION_SECRET invalidates every stored CLI login and every unlocked share session.',
      { yes: getBool(args, 'yes') },
    );
  }

  let adminToken: string | null = null;
  for (const name of ['SESSION_SECRET', 'ADMIN_TOKEN'] as const) {
    const present = existingSecrets.includes(name);
    if (present && !rotate) {
      steps.push({ what: `secret ${name}`, detail: 'already set', disposition: 'reused' });
      continue;
    }
    const value = randomBytes(32).toString('base64url');
    await wrangler.require(['secret', 'put', name], `setting ${name}`, `${value}\n`);
    if (name === 'ADMIN_TOKEN') adminToken = value;
    steps.push({
      what: `secret ${name}`,
      detail: present ? 'rotated' : 'generated',
      disposition: present ? 'updated' : 'created',
    });
  }

  // ---------------------------------------------------------------- deploy --
  const deployed = await wrangler.require(['deploy'], 'deploying the worker');
  const url = extractWorkerUrl(deployed.stdout + deployed.stderr);
  steps.push({
    what: 'worker',
    detail: url ?? 'deployed (URL not printed by wrangler)',
    disposition: 'updated',
  });

  // --------------------------------------------------------- save the login -
  let savedConfig = false;
  if (url !== null && adminToken !== null) {
    const config: Config = {
      workerUrl: normalizeBaseUrl(url),
      adminToken,
      ...(credentials.cloudflareApiToken
        ? { cloudflareApiToken: credentials.cloudflareApiToken }
        : {}),
      ...(credentials.accountId ? { accountId: credentials.accountId } : {}),
    };
    await saveConfig(config);
    savedConfig = true;
    steps.push({ what: 'local config', detail: 'admin token saved', disposition: 'updated' });
    await new ApiClient(config)
      .status()
      .then(() =>
        steps.push({ what: 'health check', detail: 'admin API answered', disposition: 'reused' }),
      )
      .catch(() =>
        steps.push({ what: 'health check', detail: 'not reachable yet', disposition: 'skipped' }),
      );
  }

  if (json) {
    out.json({
      worker: workerName,
      url,
      bucket: bucketName,
      database: databaseName,
      databaseId,
      steps,
      savedConfig,
    });
    return 0;
  }

  out.heading('What happened');
  for (const step of steps)
    out.line(`  ${badge(step.disposition)}  ${step.what}  ${dim(step.detail)}`);
  out.line();
  if (url !== null) {
    out.ok(`Live at ${cyan(url)}`);
    if (savedConfig) out.note('Credentials saved; `ms status` works now.');
    else
      out.note('ADMIN_TOKEN was already set, so it was left alone — run `ms login` to store it.');
  } else {
    out.warn('Deployed, but wrangler did not print a URL. Run `wrangler deployments list`.');
  }
  return 0;
}

async function listSecrets(wrangler: Wrangler): Promise<string[]> {
  const result = await wrangler.run(['secret', 'list', '--format', 'json']);
  if (result.code !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(result.stdout.slice(result.stdout.indexOf('[')));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) =>
        typeof entry === 'object' && entry !== null ? (entry as { name?: string }).name : undefined,
      )
      .filter((name): name is string => typeof name === 'string');
  } catch {
    return [];
  }
}

function findDatabaseId(output: string, name: string): string | null {
  try {
    const start = output.indexOf('[');
    if (start !== -1) {
      const parsed: unknown = JSON.parse(output.slice(start));
      if (Array.isArray(parsed)) {
        for (const entry of parsed as { name?: string; uuid?: string; database_id?: string }[]) {
          if (entry.name === name) return entry.uuid ?? entry.database_id ?? null;
        }
        return null;
      }
    }
  } catch {
    // wrangler was not speaking JSON; fall through to the text scan
  }
  return output.includes(name) ? extractUuid(output) : null;
}

function extractUuid(output: string): string | null {
  const match = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match === null ? null : match[0];
}

function mentions(output: string, name: string): boolean {
  return new RegExp(
    `(^|[^a-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_-]|$)`,
    'im',
  ).test(output);
}

function badge(disposition: Disposition): string {
  switch (disposition) {
    case 'created':
      return green('created');
    case 'updated':
      return cyan('updated');
    case 'skipped':
      return yellow('skipped');
    default:
      return dim(' reused');
  }
}

async function askForToken(): Promise<string> {
  const value = await askSecret('Cloudflare API token');
  if (value.trim() === '') {
    throw new CliError('A Cloudflare API token is needed to provision resources.', {
      code: EXIT.config,
      hint: 'Create one with Workers, R2 and D1 edit permissions, then run `ms login`.',
    });
  }
  return value.trim();
}
