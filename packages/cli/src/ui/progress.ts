import { bold, cyan, dim, green, padEnd, red, truncate, yellow } from './color.ts';
import { formatBytes, formatEta, formatRate, plural } from './format.ts';
import { humanStream } from './out.ts';

export type FileOutcome = 'uploaded' | 'downloaded' | 'skipped' | 'failed' | 'verified';

interface ActiveRow {
  name: string;
  total: number;
  done: number;
}

interface RateSample {
  at: number;
  bytes: number;
}

const FRAME_MS = 80;
const RATE_WINDOW_MS = 5_000;
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const CLEAR_BELOW = '\x1b[0J';

export interface ProgressOptions {
  verb: string;
  totalFiles: number;
  totalBytes: number;
  /** Forced off for tests and for `--json`. */
  tty?: boolean;
  /** Defaults to wherever prose goes: stderr under `--json`, stdout otherwise. */
  stream?: NodeJS.WriteStream;
  /** How many in-flight files to show under the summary line. */
  rows?: number;
}

/**
 * A live progress block for uploads and downloads.
 *
 * On a TTY it draws a summary line, a bar, and one line per in-flight file,
 * repainting in place. Off a TTY — a CI log, a pipe, `--json` — it degrades to
 * one plain line per finished file plus a periodic heartbeat, because a
 * repainting bar in a log file is noise nobody can read afterwards.
 */
export class Progress {
  private readonly verb: string;
  private readonly stream: NodeJS.WriteStream;
  private readonly interactive: boolean;
  private readonly maxRows: number;

  private totalFiles: number;
  private totalBytes: number;
  private doneFiles = 0;
  private doneBytes = 0;
  private skipped = 0;
  private failed = 0;

  private readonly active = new Map<string, ActiveRow>();
  private readonly samples: RateSample[] = [];
  private readonly startedAt = Date.now();

  private painted = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeat = 0;
  private stopped = false;

  constructor(options: ProgressOptions) {
    this.verb = options.verb;
    this.stream = options.stream ?? humanStream();
    this.interactive = options.tty ?? this.stream.isTTY === true;
    this.maxRows = options.rows ?? 6;
    this.totalFiles = options.totalFiles;
    this.totalBytes = options.totalBytes;

    if (this.interactive) {
      this.stream.write(CURSOR_HIDE);
      this.timer = setInterval(() => this.paint(), FRAME_MS);
      this.timer.unref?.();
    }
  }

  /** Totals can move once hashing reveals a file is bigger than the stat said. */
  retotal(files: number, bytes: number): void {
    this.totalFiles = files;
    this.totalBytes = bytes;
  }

  start(key: string, name: string, total: number): void {
    this.active.set(key, { name, total, done: 0 });
    this.paint();
  }

  advance(key: string, delta: number): void {
    const row = this.active.get(key);
    if (row) row.done += delta;
    this.doneBytes += delta;
    this.samples.push({ at: Date.now(), bytes: delta });
    this.trimSamples();
    this.maybeHeartbeat();
  }

  finish(key: string, outcome: FileOutcome, name?: string, detail?: string): void {
    const row = this.active.get(key);
    this.active.delete(key);
    this.doneFiles++;
    if (outcome === 'skipped') this.skipped++;
    if (outcome === 'failed') this.failed++;
    const label = name ?? row?.name ?? key;
    this.log(`${outcomeTag(outcome)} ${label}${detail ? dim(`  ${detail}`) : ''}`);
  }

  /** Writes a permanent line above the live block without disturbing it. */
  log(text: string): void {
    if (this.stopped) {
      this.stream.write(`${text}\n`);
      return;
    }
    if (!this.interactive) {
      this.stream.write(`${text}\n`);
      return;
    }
    this.clear();
    this.stream.write(`${text}\n`);
    this.paint();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    if (this.interactive) {
      this.clear();
      this.stream.write(CURSOR_SHOW);
    }
  }

  summary(): {
    files: number;
    bytes: number;
    skipped: number;
    failed: number;
    seconds: number;
    rate: number;
  } {
    const seconds = (Date.now() - this.startedAt) / 1000;
    return {
      files: this.doneFiles,
      bytes: this.doneBytes,
      skipped: this.skipped,
      failed: this.failed,
      seconds,
      rate: seconds > 0 ? this.doneBytes / seconds : 0,
    };
  }

  // ------------------------------------------------------------ internals --

  private trimSamples(): void {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    while (this.samples.length > 0 && (this.samples[0]?.at ?? 0) < cutoff) this.samples.shift();
  }

  /** Bytes/second over the recent window, so a stalled part shows as a slowdown. */
  private rate(): number {
    this.trimSamples();
    if (this.samples.length < 2) {
      const elapsed = (Date.now() - this.startedAt) / 1000;
      return elapsed > 0 ? this.doneBytes / elapsed : 0;
    }
    const first = this.samples[0];
    if (first === undefined) return 0;
    const span = (Date.now() - first.at) / 1000;
    const bytes = this.samples.reduce((sum, sample) => sum + sample.bytes, 0);
    return span > 0 ? bytes / span : 0;
  }

  private eta(): number {
    const rate = this.rate();
    if (rate <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.totalBytes - this.doneBytes) / rate;
  }

  private maybeHeartbeat(): void {
    if (this.interactive || this.stopped) return;
    const now = Date.now();
    if (now - this.lastHeartbeat < 10_000) return;
    this.lastHeartbeat = now;
    this.stream.write(`${dim(this.summaryLine(80))}\n`);
  }

  private clear(): void {
    if (this.painted === 0) return;
    this.stream.write(`\x1b[${this.painted}A\r${CLEAR_BELOW}`);
    this.painted = 0;
  }

  private paint(): void {
    if (!this.interactive || this.stopped) return;
    const width = Math.max(20, this.stream.columns ?? 80);
    const lines: string[] = [this.summaryLine(width)];

    const bar = this.barLine(width);
    if (bar !== null) lines.push(bar);

    const rows = [...this.active.values()].slice(0, this.maxRows);
    for (const row of rows) lines.push(this.fileLine(row, width));
    const hidden = this.active.size - rows.length;
    if (hidden > 0) lines.push(dim(`  … ${hidden} more in flight`));

    this.clear();
    this.stream.write(`${lines.join('\n')}\n`);
    this.painted = lines.length;
  }

  private summaryLine(width: number): string {
    const files = `${this.doneFiles}/${this.totalFiles} ${plural(this.totalFiles, 'file')}`;
    const bytes = `${formatBytes(this.doneBytes)} / ${formatBytes(this.totalBytes)}`;
    const parts = [
      bold(this.verb),
      files,
      bytes,
      formatRate(this.rate()),
      `ETA ${formatEta(this.eta())}`,
    ];
    const joined = parts.join(dim('  ·  '));
    return width < 60 ? `${bold(this.verb)} ${files}  ${formatRate(this.rate())}` : joined;
  }

  private barLine(width: number): string | null {
    if (width < 40) return null;
    const inner = Math.min(width - 8, 60);
    const fraction = this.totalBytes > 0 ? Math.min(1, this.doneBytes / this.totalBytes) : 0;
    const filled = Math.round(inner * fraction);
    const bar = `${'━'.repeat(filled)}${dim('─'.repeat(inner - filled))}`;
    return `  ${cyan(bar)} ${padEnd(`${Math.round(fraction * 100)}%`, 4)}`;
  }

  private fileLine(row: ActiveRow, width: number): string {
    const pct = row.total > 0 ? Math.min(100, Math.round((row.done / row.total) * 100)) : 0;
    const right = `${String(pct).padStart(3)}%  ${formatBytes(row.total)}`;
    const nameWidth = Math.max(8, width - right.length - 6);
    return `  ${dim('·')} ${padEnd(truncate(row.name, nameWidth), nameWidth)}  ${dim(right)}`;
  }
}

function outcomeTag(outcome: FileOutcome): string {
  switch (outcome) {
    case 'uploaded':
      return green('   up');
    case 'downloaded':
      return green(' down');
    case 'verified':
      return green('   ok');
    case 'skipped':
      return dim(' skip');
    case 'failed':
      return red(' fail');
    default:
      return yellow('    ?');
  }
}
