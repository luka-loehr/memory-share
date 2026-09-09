/**
 * A very small palette. Colour carries meaning here — dim for chrome, one
 * accent for identifiers, red only for things that actually went wrong — so
 * there is deliberately no rainbow of helpers to reach for.
 */
const enabled = (() => {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.TERM === 'dumb') return false;
  return process.stdout.isTTY === true;
})();

export const colorEnabled = enabled;

function wrap(open: number, close: number) {
  return (text: string): string => (enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text);
}

export const dim = wrap(2, 22);
export const bold = wrap(1, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);
export const inverse = wrap(7, 27);

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC byte is the entire purpose
const ANSI = /\x1b\[[0-9;]*m/g;

/** Length as the terminal sees it: escape sequences occupy no columns. */
export function displayWidth(text: string): number {
  return [...text.replace(ANSI, '')].length;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export function padEnd(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}

export function padStart(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? ' '.repeat(pad) + text : text;
}

/** Middle-elides, because both ends of a filename or a hash carry information. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  const chars = [...text];
  if (chars.length <= width) return text;
  if (width <= 1) return '…';
  const head = Math.ceil((width - 1) / 2);
  const tail = width - 1 - head;
  return `${chars.slice(0, head).join('')}…${tail > 0 ? chars.slice(-tail).join('') : ''}`;
}
