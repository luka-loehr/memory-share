import type { FlagSpecs, ParsedArgs } from '../cli/args.ts';
import { getBool, getList, getString, has } from '../cli/args.ts';
import type { ApiClient } from '../core/api.ts';
import { ApiClient as Client } from '../core/api.ts';
import { loadConfig } from '../core/config.ts';
import { CliError, UsageError } from '../core/errors.ts';
import {
  assertSlug,
  dedupe,
  normalizeTag,
  parseExpiry,
  parseIdList,
  resolveIds,
} from '../core/parse.ts';
import type { Memory, PatchMemoryBody } from '../core/types.ts';
import { bold, cyan, dim, yellow } from '../ui/color.ts';
import { formatDate, plural } from '../ui/format.ts';
import * as out from '../ui/out.ts';
import { confirm } from '../ui/prompt.ts';
import { type Column, renderFields, renderTable } from '../ui/table.ts';
import { assetColumns } from './ls.ts';

export const memoryFlags: FlagSpecs = {
  tag: { type: 'list', short: 't', describe: 'Select assets by tag (repeatable)' },
  pick: { type: 'list', short: 'p', describe: 'Select assets by id (repeatable, comma-separated)' },
  note: { type: 'string', describe: 'A line shown on the unlock gate' },
  password: { type: 'string', describe: 'Set the password (generated when omitted)' },
  download: { type: 'boolean', describe: 'Allow originals to be downloaded (default on)' },
  expires: { type: 'string', describe: 'Expiry, e.g. 30d, 12h, 2026-12-24' },
  cover: { type: 'string', describe: 'Asset id to use as the cover' },
  title: { type: 'string', describe: 'Rename the memory (memory add/rm)' },
  yes: { type: 'boolean', short: 'y', describe: 'Skip confirmations' },
  json: { type: 'boolean', describe: 'Emit JSON' },
};

const SUBCOMMANDS = ['create', 'ls', 'show', 'add', 'rm', 'set', 'rotate'] as const;

export async function memory(args: ParsedArgs): Promise<number> {
  const [sub, ...rest] = args.positionals;
  if (sub === undefined) {
    throw new UsageError(`ms memory needs a subcommand: ${SUBCOMMANDS.join(', ')}.`);
  }
  const inner: ParsedArgs = { positionals: rest, flags: args.flags };
  const client = new Client(await loadConfig());

  switch (sub) {
    case 'create':
      return await createMemory(client, inner);
    case 'ls':
    case 'list':
      return await listMemories(client, inner);
    case 'show':
      return await showMemory(client, inner);
    case 'add':
      return await editMembers(client, inner, 'add');
    case 'set':
      return await setMemory(client, inner);
    case 'rm':
      return rest.length > 1 || has(inner, 'tag') || has(inner, 'pick')
        ? await editMembers(client, inner, 'remove')
        : await removeMemory(client, inner);
    case 'remove':
      return await removeMemory(client, inner);
    case 'rotate':
      return await rotateMemory(client, inner);
    default:
      throw new UsageError(
        `Unknown subcommand "${sub}".`,
        `Try one of: ${SUBCOMMANDS.join(', ')}.`,
      );
  }
}

// ----------------------------------------------------------------- create ---

async function createMemory(client: ApiClient, args: ParsedArgs): Promise<number> {
  const title = args.positionals.join(' ').trim();
  if (title === '') throw new UsageError('ms memory create needs a title.');

  const assetIds = await selectAssets(client, args, { required: true });
  const body = {
    title,
    note: getString(args, 'note'),
    assetIds,
    password: getString(args, 'password'),
    allowDownload: getBool(args, 'download', true),
    expiresAt: has(args, 'expires') ? parseExpiry(getString(args, 'expires') ?? '') : undefined,
  };

  const result = await client.createMemory(body);
  const url = shareUrl(client.baseUrl, result.memory.slug);

  if (getBool(args, 'json')) {
    // The password only exists in this response; a caller asking for JSON needs it.
    out.json({ memory: result.memory, password: result.password, url, count: assetIds.length });
    return 0;
  }

  out.line();
  out.ok(
    `${bold(result.memory.title)} — ${assetIds.length} ${plural(assetIds.length, 'asset')}${
      body.expiresAt ? dim(`, expires ${formatDate(body.expiresAt)}`) : ''
    }`,
  );
  out.shareBlock([
    ['link', url],
    ['password', result.password],
  ]);
  if (body.allowDownload === false)
    out.note('Downloads are off: recipients can view but not save.');
  out.note(
    `The password is shown once. Rotate it with \`ms memory rotate ${result.memory.slug}\`.`,
  );
  return 0;
}

// ------------------------------------------------------------------- read ---

async function listMemories(client: ApiClient, args: ParsedArgs): Promise<number> {
  const memories = await client.listMemories();
  if (getBool(args, 'json')) {
    out.json({
      memories: memories.map((entry) => ({ ...entry, url: shareUrl(client.baseUrl, entry.slug) })),
    });
    return 0;
  }
  if (memories.length === 0) {
    out.note('No memories yet. `ms memory create "Croatia" --tag croatia` makes one.');
    return 0;
  }
  out.line(renderTable(memories, memoryColumns()));
  out.line();
  out.note(`${memories.length} ${plural(memories.length, 'memory', 'memories')}`);
  return 0;
}

async function showMemory(client: ApiClient, args: ParsedArgs): Promise<number> {
  const slug = requireSlug(args, 'ms memory show <slug>');
  const detail = await client.getMemory(slug).catch(async (error: unknown) => {
    if (error instanceof CliError && /404/.test(error.message)) {
      throw new UsageError(`No memory with the slug "${slug}".`, '`ms memory ls` lists them.');
    }
    throw error;
  });
  const entry = detail.memory;
  const assets = detail.items ?? [];

  if (getBool(args, 'json')) {
    out.json({ memory: entry, url: shareUrl(client.baseUrl, entry.slug), assets });
    return 0;
  }

  out.line();
  out.line(
    renderFields([
      ['title', bold(entry.title)],
      ['slug', cyan(entry.slug)],
      ['link', shareUrl(client.baseUrl, entry.slug)],
      ['note', entry.note ?? dim('—')],
      ['assets', String(assets.length)],
      ['downloads', allowsDownload(entry) ? 'allowed' : yellow('blocked')],
      ['expires', expiryLabel(entry)],
      ['created', formatDate(entry.created_at)],
      ['updated', formatDate(entry.updated_at)],
    ]),
  );
  if (assets.length > 0) {
    out.line();
    out.line(renderTable(assets, assetColumns()));
  }
  out.line();
  return 0;
}

// ------------------------------------------------------------------ write ---

async function editMembers(
  client: ApiClient,
  args: ParsedArgs,
  direction: 'add' | 'remove',
): Promise<number> {
  const slug = requireSlug(
    args,
    `ms memory ${direction === 'add' ? 'add' : 'rm'} <slug> <ids|--tag>`,
  );
  const rest: ParsedArgs = { positionals: args.positionals.slice(1), flags: args.flags };
  const assetIds = await selectAssets(client, rest, { required: true, positionalsAreIds: true });

  if (direction === 'remove') {
    await confirm(
      `Remove ${assetIds.length} ${plural(assetIds.length, 'asset')} from ${slug}? The files stay in the pool.`,
      { yes: getBool(args, 'yes') },
    );
  }

  const patch = direction === 'add' ? { add: assetIds } : { remove: assetIds };
  const title = getString(args, 'title');
  const cover = getString(args, 'cover');
  const result = await client.patchMemory(slug, {
    ...patch,
    ...(title === undefined ? {} : { title }),
    ...(cover === undefined ? {} : { cover }),
    ...(has(args, 'download') ? { allowDownload: getBool(args, 'download', true) } : {}),
    ...(has(args, 'note') ? { note: getString(args, 'note') } : {}),
  });

  if (getBool(args, 'json')) {
    out.json({ memory: result.memory, [direction]: assetIds });
    return 0;
  }
  out.ok(
    `${direction === 'add' ? 'Added' : 'Removed'} ${assetIds.length} ${plural(assetIds.length, 'asset')} ${
      direction === 'add' ? 'to' : 'from'
    } ${cyan(slug)}.`,
  );
  if (direction === 'remove') out.note('The assets themselves are untouched.');
  return 0;
}

/**
 * Everything `PATCH /memories/:slug` can change that is not membership. Expiry
 * is patchable now, so a link that is about to lapse can be extended without
 * recreating the memory — which would change the slug and the password, i.e.
 * break the very link you were trying to keep alive.
 */
async function setMemory(client: ApiClient, args: ParsedArgs): Promise<number> {
  const slug = requireSlug(args, 'ms memory set <slug> [--title x] [--expires 30d]');
  const patch: PatchMemoryBody = {};
  const title = getString(args, 'title');
  const note = getString(args, 'note');
  const cover = getString(args, 'cover');
  if (title !== undefined) patch.title = title;
  if (has(args, 'note')) patch.note = note ?? '';
  if (cover !== undefined) patch.cover = cover;
  if (has(args, 'download')) patch.allowDownload = getBool(args, 'download', true);
  if (has(args, 'expires')) patch.expiresAt = parseExpiry(getString(args, 'expires') ?? '');

  if (Object.keys(patch).length === 0) {
    throw new UsageError(
      'Nothing to change.',
      'Pass --title, --note, --cover, --expires, or --download / --no-download.',
    );
  }

  const result = await client.patchMemory(slug, patch);
  if (getBool(args, 'json')) {
    out.json({ memory: result.memory, changed: Object.keys(patch) });
    return 0;
  }
  out.ok(`Updated ${cyan(slug)}: ${Object.keys(patch).join(', ')}.`);
  if (patch.expiresAt !== undefined) {
    out.note(`The link now expires ${formatDate(patch.expiresAt)}.`);
  }
  return 0;
}

async function rotateMemory(client: ApiClient, args: ParsedArgs): Promise<number> {
  const slug = requireSlug(args, 'ms memory rotate <slug>');
  await confirm(`Rotating the password for ${slug} breaks every link already shared.`, {
    yes: getBool(args, 'yes'),
  });
  const result = await client.rotateMemory(slug);

  if (getBool(args, 'json')) {
    out.json({ slug, password: result.password, url: shareUrl(client.baseUrl, slug) });
    return 0;
  }
  out.shareBlock([
    ['link', shareUrl(client.baseUrl, slug)],
    ['password', result.password],
  ]);
  out.note('Anyone holding the old password is now locked out.');
  return 0;
}

async function removeMemory(client: ApiClient, args: ParsedArgs): Promise<number> {
  const slug = requireSlug(args, 'ms memory rm <slug>');
  await confirm(
    `Delete the memory ${bold(slug)}?\n  ${dim('The photos and videos in it are NOT deleted — they stay in the pool and in every other memory. Only this album and its link go away.')}`,
    { yes: getBool(args, 'yes'), expect: getBool(args, 'yes') ? undefined : slug },
  );
  await client.deleteMemory(slug);

  if (getBool(args, 'json')) {
    out.json({ slug, deleted: true, assetsDeleted: 0 });
    return 0;
  }
  out.ok(`Deleted the memory ${cyan(slug)}.`);
  out.note('No assets were deleted. `ms ls` still shows every one of them.');
  return 0;
}

// --------------------------------------------------------------- plumbing ---

/**
 * Assets for a memory come from a tag query, explicit ids, or both. Ids may be
 * abbreviated, and an ambiguous prefix is refused rather than guessed — putting
 * the wrong photograph in an album is not something the recipient can undo.
 */
async function selectAssets(
  client: ApiClient,
  args: ParsedArgs,
  options: { required?: boolean; positionalsAreIds?: boolean } = {},
): Promise<string[]> {
  const tags = getList(args, 'tag').map(normalizeTag);
  // For `memory create` the positionals are the title, not asset ids.
  const picks = [
    ...getList(args, 'pick'),
    ...(options.positionalsAreIds === true ? args.positionals : []),
  ];

  const ids: string[] = [];
  for (const name of tags) {
    const assets = await client.listAllAssets({ tag: name });
    if (assets.length === 0) out.warn(`Nothing is tagged ${name}.`);
    ids.push(...assets.map((asset) => asset.id));
  }

  if (picks.length > 0) {
    const requested = parseIdList(picks);
    const pool = (await client.listAllAssets({})).map((asset) => asset.id);
    const { resolved, missing, ambiguous } = resolveIds(requested, pool);
    if (missing.length > 0) throw new UsageError(`No asset matches ${missing.join(', ')}.`);
    if (ambiguous.length > 0) {
      throw new UsageError(
        `${ambiguous.join(', ')} ${ambiguous.length === 1 ? 'matches' : 'match'} more than one asset.`,
        'Use more characters of the id.',
      );
    }
    ids.push(...resolved);
  }

  const unique = dedupe(ids);
  if (unique.length === 0 && options.required === true) {
    throw new UsageError(
      'No assets selected.',
      'Pass --tag <name> and/or --pick <id,id>. `ms ls` lists what is in the pool.',
    );
  }
  return unique;
}

function requireSlug(args: ParsedArgs, usage: string): string {
  const value = args.positionals[0];
  if (value === undefined) throw new UsageError(`Missing slug — ${usage}.`);
  return assertSlug(value);
}

export function memberIds(entry: Memory): string[] {
  if (Array.isArray(entry.assetIds)) return entry.assetIds;
  if (Array.isArray(entry.assets)) return entry.assets.map((asset) => asset.id);
  return [];
}

export function allowsDownload(entry: Memory): boolean {
  return entry.allow_download === undefined ? true : Boolean(entry.allow_download);
}

function expiryLabel(entry: Memory): string {
  if (!entry.expires_at) return dim('never');
  const expired = entry.expires_at * 1000 < Date.now();
  const label = formatDate(entry.expires_at);
  return expired ? yellow(`${label} (expired)`) : label;
}

/** The share page, not the API route: /m/<slug> is what gets pasted to people. */
export function shareUrl(baseUrl: string, slug: string): string {
  return `${baseUrl}/m/${slug}`;
}

function memoryColumns(): Column<Memory>[] {
  return [
    { header: 'SLUG', value: (m) => cyan(m.slug), flex: true, minWidth: 8 },
    { header: 'TITLE', value: (m) => m.title, flex: true, minWidth: 10 },
    {
      header: 'ASSETS',
      value: (m) => String(m.count ?? memberIds(m).length ?? 0),
      align: 'right',
    },
    { header: 'DOWNLOAD', value: (m) => (allowsDownload(m) ? 'yes' : yellow('no')) },
    { header: 'EXPIRES', value: (m) => expiryLabel(m) },
    { header: 'CREATED', value: (m) => formatDate(m.created_at) },
  ];
}
