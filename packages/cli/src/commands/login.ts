import type { FlagSpecs, ParsedArgs } from '../cli/args.ts';
import { getBool, getString } from '../cli/args.ts';
import { ApiClient } from '../core/api.ts';
import {
  type Config,
  configPath,
  maskSecret,
  readConfigFile,
  redact,
  saveConfig,
} from '../core/config.ts';
import { CliError, EXIT } from '../core/errors.ts';
import { normalizeBaseUrl } from '../core/parse.ts';
import { dim } from '../ui/color.ts';
import * as out from '../ui/out.ts';
import { ask, askSecret } from '../ui/prompt.ts';
import { renderFields } from '../ui/table.ts';

export const loginFlags: FlagSpecs = {
  url: { type: 'string', describe: 'Deployed worker URL', placeholder: '<url>' },
  token: { type: 'string', describe: 'Admin token (prompted if omitted)', placeholder: '<token>' },
  'cf-token': { type: 'string', describe: 'Cloudflare API token, for ms deploy' },
  account: { type: 'string', describe: 'Cloudflare account id, for ms deploy' },
  verify: { type: 'boolean', describe: 'Check the credentials before saving (default on)' },
  json: { type: 'boolean', describe: 'Print the saved config, redacted, as JSON' },
};

/**
 * Stores credentials at 0600. Values typed here are never echoed, never logged
 * and never printed back — the confirmation shows a fingerprint instead, which
 * is enough to tell two tokens apart and useless to anyone reading over a
 * shoulder or scrolling back through a shared terminal.
 */
export async function login(args: ParsedArgs): Promise<number> {
  const existing = await readConfigFile();

  const urlInput =
    getString(args, 'url') ??
    (await ask('Worker URL', existing.workerUrl ?? 'https://memory-share.workers.dev'));
  const workerUrl = normalizeBaseUrl(urlInput);

  const adminToken =
    getString(args, 'token') ??
    process.env.MS_ADMIN_TOKEN ??
    (await askSecret('Admin token')) ??
    '';
  if (adminToken.trim() === '') {
    throw new CliError('No admin token given; nothing was saved.', { code: EXIT.config });
  }

  const cloudflareApiToken =
    getString(args, 'cf-token') ??
    process.env.CLOUDFLARE_API_TOKEN ??
    (await askSecretOptional('Cloudflare API token, for `ms deploy`', existing.cloudflareApiToken));

  const accountId =
    getString(args, 'account') ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? existing.accountId;

  const config: Config = { workerUrl, adminToken: adminToken.trim() };
  if (cloudflareApiToken !== undefined && cloudflareApiToken !== '') {
    config.cloudflareApiToken = cloudflareApiToken;
  }
  if (accountId !== undefined && accountId !== '') config.accountId = accountId;

  if (getBool(args, 'verify', true)) {
    out.note('Checking the credentials against the worker…');
    const status = await new ApiClient(config).status().catch((error: unknown) => {
      throw error instanceof CliError
        ? new CliError(`Those credentials did not work. ${error.message}`, {
            code: error.code,
            hint: error.hint,
          })
        : error;
    });
    out.ok(`Reached ${workerUrl} — ${status.assets} assets, ${status.memories} memories.`);
  }

  const path = await saveConfig(config);

  if (getBool(args, 'json')) {
    out.json({ path, config: redact(config) });
    return 0;
  }

  out.line();
  out.line(
    renderFields([
      ['config', path],
      ['worker', workerUrl],
      ['admin token', maskSecret(config.adminToken) ?? '—'],
      ['cf token', maskSecret(config.cloudflareApiToken) ?? dim('not set')],
      ['account', config.accountId ?? dim('not set')],
    ]),
  );
  out.line();
  out.ok('Saved, readable only by you (0600).');
  return 0;
}

/** Optional secrets keep their previous value when the user just hits enter. */
async function askSecretOptional(question: string, previous?: string): Promise<string | undefined> {
  if (process.stdin.isTTY !== true) return previous;
  const suffix = previous === undefined ? 'optional, enter to skip' : 'enter to keep current';
  process.stdout.write(`${dim(`(${suffix})`)}\n`);
  const value = await askSecret(question);
  return value === '' ? previous : value;
}

export function configLocation(): string {
  return configPath();
}
