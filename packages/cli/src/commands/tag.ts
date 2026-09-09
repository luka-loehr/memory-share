import type { FlagSpecs, ParsedArgs } from '../cli/args.ts';
import { getBool, getList, getString } from '../cli/args.ts';
import { ApiClient } from '../core/api.ts';
import { loadConfig } from '../core/config.ts';
import { UsageError } from '../core/errors.ts';
import { normalizeTag, normalizeTags, parseIdList, resolveIds } from '../core/parse.ts';
import { cyan, dim } from '../ui/color.ts';
import { plural } from '../ui/format.ts';
import * as out from '../ui/out.ts';
import { confirm } from '../ui/prompt.ts';
import { assertKind } from './ls.ts';

export const tagFlags: FlagSpecs = {
  add: { type: 'list', short: 'a', describe: 'Tag to add (repeatable)' },
  remove: { type: 'list', short: 'r', describe: 'Tag to remove (repeatable)' },
  all: { type: 'boolean', describe: 'Operate on every asset in the pool' },
  from: { type: 'string', describe: 'Operate on every asset carrying this tag' },
  kind: { type: 'string', short: 'k', describe: 'Narrow a bulk selection to photo | video' },
  yes: { type: 'boolean', short: 'y', describe: 'Skip the confirmation on bulk changes' },
  json: { type: 'boolean', describe: 'Emit the result as JSON' },
};

/**
 * Two selection modes, deliberately not mixable: explicit ids, or a bulk query
 * (`--all`, `--from <tag>`). Silently unioning them makes it far too easy to
 * retag a whole library while meaning to touch three photos.
 */
export async function tag(args: ParsedArgs): Promise<number> {
  const add = normalizeTags(getList(args, 'add'));
  const remove = normalizeTags(getList(args, 'remove'));
  if (add.length === 0 && remove.length === 0) {
    throw new UsageError('Nothing to do — pass --add and/or --remove.');
  }
  const overlap = add.filter((name) => remove.includes(name));
  if (overlap.length > 0) {
    throw new UsageError(`--add and --remove both name ${overlap.join(', ')}.`);
  }

  const bulk = getBool(args, 'all') || getString(args, 'from') !== undefined;
  if (bulk && args.positionals.length > 0) {
    throw new UsageError('Give asset ids or a bulk selector, not both.');
  }
  if (!bulk && args.positionals.length === 0) {
    throw new UsageError('Which assets? Pass ids, or --all / --from <tag>.');
  }

  const client = new ApiClient(await loadConfig());
  const { assetIds, describedAs } = bulk
    ? await bulkSelection(client, args)
    : await explicitSelection(client, args);

  if (assetIds.length === 0) {
    out.note(`No assets matched ${describedAs}.`);
    return 0;
  }

  if (bulk) {
    const change = [
      add.length > 0 ? `add ${add.join(', ')}` : null,
      remove.length > 0 ? `remove ${remove.join(', ')}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' and ');
    await confirm(
      `This will ${change} on ${assetIds.length} ${plural(assetIds.length, 'asset')} (${describedAs}).`,
      { yes: getBool(args, 'yes') },
    );
  }

  const result = await client.tagAssets(assetIds, add, remove);
  const updated = result.updated ?? assetIds.length;

  if (getBool(args, 'json')) {
    out.json({ updated, assetIds, add, remove });
    return 0;
  }
  out.ok(
    `${updated} ${plural(updated, 'asset')} updated${add.length > 0 ? ` ${dim('+')}${cyan(add.join(' +'))}` : ''}${
      remove.length > 0 ? ` ${dim('-')}${remove.join(' -')}` : ''
    }`,
  );
  return 0;
}

async function explicitSelection(
  client: ApiClient,
  args: ParsedArgs,
): Promise<{ assetIds: string[]; describedAs: string }> {
  const requested = parseIdList(args.positionals);
  const pool = (await client.listAllAssets({})).map((asset) => asset.id);
  const { resolved, missing, ambiguous } = resolveIds(requested, pool);
  if (missing.length > 0) throw new UsageError(`No asset matches ${missing.join(', ')}.`);
  if (ambiguous.length > 0) {
    throw new UsageError(
      `${ambiguous.join(', ')} ${ambiguous.length === 1 ? 'matches' : 'match'} more than one asset.`,
      'Use more characters of the id.',
    );
  }
  return {
    assetIds: resolved,
    describedAs: `${resolved.length} named ${plural(resolved.length, 'asset')}`,
  };
}

async function bulkSelection(
  client: ApiClient,
  args: ParsedArgs,
): Promise<{ assetIds: string[]; describedAs: string }> {
  const from = getString(args, 'from');
  const query = {
    tag: from === undefined ? undefined : normalizeTag(from),
    kind: assertKind(getString(args, 'kind')),
  };
  const assets = await client.listAllAssets(query);
  const described = [
    query.tag === undefined ? 'the whole pool' : `tag ${query.tag}`,
    query.kind === undefined ? null : `${query.kind}s only`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
  return { assetIds: assets.map((asset) => asset.id), describedAs: described };
}
