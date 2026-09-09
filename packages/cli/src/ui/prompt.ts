import { UsageError } from '../core/errors.ts';
import { bold, dim } from './color.ts';

const KEY_ENTER = ['\r', '\n'];
const KEY_EOT = '\x04';
const KEY_ETX = '\x03';
const KEY_BACKSPACE = ['\x7f', '\b'];

function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * Reads one line. With `mask`, raw mode is used and nothing is echoed at all —
 * not even asterisks, so the length of a token is not shoulder-readable.
 */
async function readLine(mask: boolean): Promise<string> {
  const stdin = process.stdin;
  const previousRaw = stdin.isRaw === true;
  if (mask && stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return await new Promise<string>((resolve, reject) => {
    let buffer = '';
    const cleanup = () => {
      stdin.off('data', onData);
      if (mask && stdin.setRawMode) stdin.setRawMode(previousRaw);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (KEY_ENTER.includes(char) || (mask && char === KEY_EOT)) {
          cleanup();
          if (mask) process.stdout.write('\n');
          resolve(buffer);
          return;
        }
        if (char === KEY_ETX) {
          cleanup();
          process.stdout.write('\n');
          reject(new UsageError('Cancelled.'));
          return;
        }
        if (KEY_BACKSPACE.includes(char)) {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += char;
      }
    };
    stdin.on('data', onData);
  });
}

export async function ask(question: string, fallback?: string): Promise<string> {
  if (!isInteractive()) {
    if (fallback !== undefined) return fallback;
    throw new UsageError(`Cannot ask "${question}" — stdin is not a terminal.`);
  }
  const suffix = fallback === undefined ? '' : dim(` (${fallback})`);
  process.stdout.write(`${question}${suffix} `);
  const answer = (await readLine(false)).trim();
  if (answer === '' && fallback !== undefined) return fallback;
  return answer;
}

/** Never echoes, and never returns the value anywhere but to the caller. */
export async function askSecret(question: string): Promise<string> {
  if (!isInteractive()) {
    throw new UsageError(
      `Cannot ask for "${question}" — stdin is not a terminal.`,
      'Set the value in the environment instead (MS_ADMIN_TOKEN, CLOUDFLARE_API_TOKEN).',
    );
  }
  process.stdout.write(`${question} ${dim('(hidden)')} `);
  return (await readLine(true)).trim();
}

/**
 * Destructive commands route through here. `--yes` skips it; a non-interactive
 * terminal without `--yes` refuses rather than assuming consent.
 */
export async function confirm(
  question: string,
  options: { yes?: boolean; expect?: string } = {},
): Promise<void> {
  if (options.yes === true) return;
  if (!isInteractive()) {
    throw new UsageError(
      'Refusing to run a destructive command without a terminal.',
      'Pass --yes if you are sure.',
    );
  }
  if (options.expect !== undefined) {
    process.stdout.write(`${question}\n  type ${bold(options.expect)} to confirm: `);
    const typed = (await readLine(false)).trim();
    if (typed !== options.expect) throw new UsageError('Cancelled — that did not match.');
    return;
  }
  process.stdout.write(`${question} ${dim('[y/N]')} `);
  const answer = (await readLine(false)).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') throw new UsageError('Cancelled.');
}
