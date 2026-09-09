import type { FlagSpecs, ParsedArgs } from '../cli/args.ts';
import { getBool } from '../cli/args.ts';
import { ApiClient } from '../core/api.ts';
import { loadConfig } from '../core/config.ts';
import { describeTools, isHardware } from '../core/ffmpeg.ts';
import { chooseEncoder } from '../core/transcode.ts';
import { dim, green, red, yellow } from '../ui/color.ts';
import { formatBytes, plural } from '../ui/format.ts';
import * as out from '../ui/out.ts';
import { renderFields } from '../ui/table.ts';

export const statusFlags: FlagSpecs = {
  json: { type: 'boolean', describe: 'Emit the raw status document' },
};

export async function status(args: ParsedArgs): Promise<number> {
  const client = new ApiClient(await loadConfig());
  const body = await client.status();
  const tools = await describeTools();
  const encoder = await chooseEncoder().catch(() => null);

  if (getBool(args, 'json')) {
    out.json({ ...body, tools, encoder });
    return body.derive.failed > 0 ? 1 : 0;
  }

  const derive = body.derive ?? { pending: 0, running: 0, failed: 0 };
  out.line();
  out.line(
    renderFields([
      ['worker', client.baseUrl],
      ['pool', `${body.assets} ${plural(body.assets, 'asset')}, ${formatBytes(body.bytes)}`],
      ['memories', String(body.memories)],
      ['derivation', deriveLine(derive)],
      ['ffmpeg', toolLine(tools.find((tool) => tool.name === 'ffmpeg'))],
      ['ffprobe', toolLine(tools.find((tool) => tool.name === 'ffprobe'))],
      [
        'encoder',
        encoder === null
          ? red('unavailable')
          : `${encoder}${isHardware(encoder) ? dim(' (hardware)') : ''}`,
      ],
    ]),
  );
  out.line();

  if (derive.failed > 0) {
    out.warn(`${derive.failed} ${plural(derive.failed, 'asset')} failed to derive.`);
    out.hint('Those still download as originals; the share page shows them as developing.');
    return 1;
  }
  return 0;
}

function toolLine(tool: { path: string | null; source: string | null } | undefined): string {
  if (tool === undefined || tool.path === null) return red('not found');
  return `${tool.path} ${dim(`(${tool.source})`)}`;
}

function deriveLine(derive: { pending: number; running: number; failed: number }): string {
  const idle = derive.pending === 0 && derive.running === 0 && derive.failed === 0;
  if (idle) return green('idle');
  const parts: string[] = [];
  if (derive.running > 0) parts.push(yellow(`${derive.running} running`));
  if (derive.pending > 0) parts.push(`${derive.pending} pending`);
  if (derive.failed > 0) parts.push(red(`${derive.failed} failed`));
  return parts.join(dim(' · '));
}
