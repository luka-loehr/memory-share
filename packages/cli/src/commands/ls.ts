import type { FlagSpecs, ParsedArgs } from '../cli/args.ts';
import { getBool, getNumber, getString } from '../cli/args.ts';
import { ApiClient } from '../core/api.ts';
import { loadConfig } from '../core/config.ts';
import { UsageError } from '../core/errors.ts';
import { normalizeTag } from '../core/parse.ts';
import type { Asset } from '../core/types.ts';
import { cyan, dim, red, yellow } from '../ui/color.ts';
import { formatBytes, formatDate, formatDimensions, formatDuration, plural } from '../ui/format.ts';
import * as out from '../ui/out.ts';
import { type Column, renderTable } from '../ui/table.ts';

export const lsFlags: FlagSpecs = {
  tag: { type: 'string', short: 't', describe: 'Only assets carrying this tag' },
  kind: { type: 'string', short: 'k', describe: 'photo | video' },
  limit: { type: 'number', short: 'n', describe: 'Stop after N assets' },
  json: { type: 'boolean', describe: 'Emit the asset rows as JSON' },
};

export function assertKind(value: string | undefined): 'photo' | 'video' | undefined {
  if (value === undefined) return undefined;
  const kind = value.trim().toLowerCase();
  if (kind === 'photo' || kind === 'video') return kind;
  throw new UsageError(`--kind takes photo or video, not "${value}".`);
}

export async function ls(args: ParsedArgs): Promise<number> {
  const client = new ApiClient(await loadConfig());
  const tag = getString(args, 'tag');
  const query = {
    tag: tag === undefined ? undefined : normalizeTag(tag),
    kind: assertKind(getString(args, 'kind')),
  };

  const limit = getNumber(args, 'limit', 0);
  let assets = await client.listAllAssets(query);
  if (limit > 0) assets = assets.slice(0, limit);

  if (getBool(args, 'json')) {
    out.json({ assets, count: assets.length });
    return 0;
  }

  if (assets.length === 0) {
    out.note(query.tag ? `Nothing tagged ${query.tag}.` : 'The pool is empty.');
    return 0;
  }

  out.line(renderTable(assets, assetColumns()));
  const bytes = assets.reduce((sum, asset) => sum + (asset.bytes ?? 0), 0);
  out.line();
  out.note(`${assets.length} ${plural(assets.length, 'asset')}, ${formatBytes(bytes)}`);
  return 0;
}

/**
 * Short ids by default: 10 hex characters is unambiguous in any realistic pool
 * and is what every other command accepts as a prefix, so the table doubles as
 * a source of copy-pasteable arguments.
 */
export function assetColumns(): Column<Asset>[] {
  return [
    { header: 'ID', value: (a) => cyan(a.id.slice(0, 10)), minWidth: 6 },
    { header: 'FILENAME', value: (a) => a.filename, flex: true, minWidth: 12 },
    { header: 'KIND', value: (a) => (a.kind === 'video' ? 'video' : 'photo') },
    { header: 'SIZE', value: (a) => formatBytes(a.bytes), align: 'right' },
    { header: 'DIMENSIONS', value: (a) => formatDimensions(a.width, a.height), align: 'right' },
    {
      header: 'LENGTH',
      value: (a) => (a.kind === 'video' ? formatDuration(a.duration) : dim('—')),
      align: 'right',
    },
    { header: 'TAKEN', value: (a) => formatDate(a.taken_at) },
    { header: 'DERIVE', value: (a) => deriveBadge(a) },
    { header: 'TAGS', value: (a) => (a.tags ?? []).join(' ') || dim('—'), flex: true, minWidth: 4 },
  ];
}

function deriveBadge(asset: Asset): string {
  switch (asset.derive_state) {
    case 'ready':
      return dim('ready');
    case 'failed':
      return red('failed');
    case 'running':
      return yellow('running');
    case 'skipped':
      return dim('skipped');
    case 'pending':
      return yellow('pending');
    default:
      return dim('—');
  }
}
