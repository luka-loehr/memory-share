import { bold, cyan, dim, padEnd } from '../ui/color.ts';
import type { FlagSpecs } from './args.ts';

export interface CommandHelp {
  name: string;
  summary: string;
  usage: string[];
  flags: FlagSpecs;
  details?: string[];
}

const INDENT = '  ';

export function renderGlobalHelp(commands: readonly CommandHelp[], version: string): string {
  const width = Math.max(...commands.map((command) => command.name.length));
  const lines = [
    `${bold('ms')} ${dim(version)} — self-hosted photo and video sharing`,
    '',
    bold('USAGE'),
    `${INDENT}ms <command> [options]`,
    '',
    bold('COMMANDS'),
  ];
  for (const command of commands) {
    lines.push(`${INDENT}${cyan(padEnd(command.name, width))}  ${command.summary}`);
  }
  lines.push(
    '',
    bold('GLOBAL'),
    `${INDENT}${padEnd('--json', 14)}  machine-readable output, on every read command`,
    `${INDENT}${padEnd('--yes, -y', 14)}  skip confirmations on destructive commands`,
    `${INDENT}${padEnd('--help, -h', 14)}  this, or per-command help`,
    `${INDENT}${padEnd('--version', 14)}  print the version`,
    '',
    dim(`${INDENT}Environment: MS_WORKER_URL, MS_ADMIN_TOKEN, MS_CONFIG_PATH, NO_COLOR.`),
    dim(`${INDENT}Start with ${'`ms login`'}, or ${'`ms deploy`'} to provision a new instance.`),
    '',
  );
  return lines.join('\n');
}

export function renderCommandHelp(command: CommandHelp): string {
  const lines = [`${bold(`ms ${command.name}`)} — ${command.summary}`, '', bold('USAGE')];
  for (const usage of command.usage) lines.push(`${INDENT}${usage}`);

  const entries = Object.entries(command.flags);
  if (entries.length > 0) {
    const labels = entries.map(([name, spec]) =>
      flagLabel(name, spec.type, spec.short, spec.placeholder),
    );
    const width = Math.max(...labels.map((label) => label.length));
    lines.push('', bold('OPTIONS'));
    entries.forEach(([, spec], index) => {
      lines.push(`${INDENT}${padEnd(labels[index] ?? '', width)}  ${spec.describe}`);
    });
  }

  if (command.details !== undefined && command.details.length > 0) {
    lines.push('', bold('NOTES'));
    for (const detail of command.details) lines.push(`${INDENT}${dim(detail)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function flagLabel(name: string, type: string, short?: string, placeholder?: string): string {
  const lead = short === undefined ? `    --${name}` : `-${short}, --${name}`;
  if (type === 'boolean') return lead;
  return `${lead} ${placeholder ?? (type === 'number' ? '<n>' : '<value>')}`;
}
