import { bold, cyan, dim, green, red, yellow } from './color.ts';

/** Everything human-readable goes to stderr when --json is on, so stdout stays parseable. */
let jsonMode = false;

export function setJsonMode(value: boolean): void {
  jsonMode = value;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/** Where prose belongs right now: stderr under --json, stdout otherwise. */
export function humanStream(): NodeJS.WriteStream {
  return jsonMode ? process.stderr : process.stdout;
}

export function line(text = ''): void {
  humanStream().write(`${text}\n`);
}

export function note(text: string): void {
  humanStream().write(`${dim(text)}\n`);
}

export function ok(text: string): void {
  humanStream().write(`${green('ok')}  ${text}\n`);
}

export function warn(text: string): void {
  process.stderr.write(`${yellow('warn')}  ${text}\n`);
}

export function fail(text: string): void {
  process.stderr.write(`${red('error')}  ${text}\n`);
}

export function hint(text: string): void {
  process.stderr.write(`${dim(`        ${text}`)}\n`);
}

export function heading(text: string): void {
  humanStream().write(`\n${bold(text)}\n`);
}

/** The one place stdout is written in --json mode. */
export function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The share block. A password is useless if the person reading it has to guess
 * where it starts, so it gets a framed, selectable region of its own.
 */
export function shareBlock(fields: readonly (readonly [string, string])[]): void {
  const width = Math.max(...fields.map(([key]) => key.length));
  humanStream().write('\n');
  for (const [key, value] of fields) {
    humanStream().write(`  ${dim(key.padStart(width))}  ${cyan(value)}\n`);
  }
  humanStream().write('\n');
}
