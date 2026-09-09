import { describe, expect, test } from 'bun:test';
import { displayWidth, stripAnsi, truncate } from '../src/ui/color.ts';
import {
  countAndSize,
  formatBytes,
  formatDimensions,
  formatDuration,
  formatEta,
  formatRate,
  plural,
} from '../src/ui/format.ts';
import { type Column, renderTable } from '../src/ui/table.ts';

describe('formatBytes', () => {
  test('scales to a readable unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3.5 * 1024 ** 3)).toBe('3.5 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
  });

  test('drops the fraction once the number is wide enough to read', () => {
    expect(formatBytes(700 * 1024)).toBe('700 KB');
  });

  test('survives nonsense', () => {
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatDuration and formatEta', () => {
  test('is compact below an hour and full above it', () => {
    expect(formatDuration(7)).toBe('0:07');
    expect(formatDuration(222)).toBe('3:42');
    expect(formatDuration(4350)).toBe('1:12:30');
  });

  test('unknowable values render as an em dash, not "NaN"', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatEta(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatEta(86_400 * 30)).toBe('—');
  });
});

describe('small formatters', () => {
  test('rate, dimensions, plurals and the summary phrase', () => {
    expect(formatRate(0)).toBe('—');
    expect(formatRate(5 * 1024 * 1024)).toBe('5.0 MB/s');
    expect(formatDimensions(4032, 3024)).toBe('4032×3024');
    expect(formatDimensions(0, 0)).toBe('—');
    expect(plural(1, 'file')).toBe('file');
    expect(plural(2, 'file')).toBe('files');
    expect(plural(2, 'memory', 'memories')).toBe('memories');
    expect(countAndSize(1, 1024)).toBe('1 file, 1.0 KB');
  });
});

describe('truncate', () => {
  test('elides the middle, keeping both informative ends', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('IMG_20190714_181203.jpg', 12)).toHaveLength(12);
    expect(truncate('abcdefghij', 5)).toBe('ab…ij');
    expect(truncate('abc', 1)).toBe('…');
    expect(truncate('abc', 0)).toBe('');
  });
});

describe('displayWidth', () => {
  test('ignores ANSI escapes so coloured columns still line up', () => {
    const coloured = '\x1b[36mabc\x1b[39m';
    expect(displayWidth(coloured)).toBe(3);
    expect(stripAnsi(coloured)).toBe('abc');
  });
});

interface Row {
  id: string;
  name: string;
  size: number;
}

const ROWS: Row[] = [
  { id: 'aabbccdd', name: 'IMG_0001.jpg', size: 1024 },
  { id: 'ee112233', name: 'a-much-longer-filename.mov', size: 3.5 * 1024 ** 3 },
];

const COLUMNS: Column<Row>[] = [
  { header: 'ID', value: (row) => row.id },
  { header: 'FILENAME', value: (row) => row.name, flex: true, minWidth: 6 },
  { header: 'SIZE', value: (row) => formatBytes(row.size), align: 'right' },
];

describe('renderTable', () => {
  test('columns align across every row', () => {
    const lines = renderTable(ROWS, COLUMNS, { width: 200 }).split('\n');
    const positions = lines.map((line) => stripAnsi(line).indexOf('IMG_0001.jpg'));
    expect(lines).toHaveLength(3);
    const nameColumn = stripAnsi(lines[0] ?? '').indexOf('FILENAME');
    expect(stripAnsi(lines[1] ?? '').indexOf('IMG_0001.jpg')).toBe(nameColumn);
    expect(positions[0]).toBe(-1);
  });

  test('numeric columns are right-aligned so digits stack', () => {
    const lines = renderTable(ROWS, COLUMNS, { width: 200 }).split('\n').map(stripAnsi);
    const ends = lines.slice(1).map((line) => line.trimEnd().length);
    expect(ends[0]).toBe(ends[1]);
  });

  test('a narrow terminal squeezes the flexible column, not the fixed ones', () => {
    const lines = renderTable(ROWS, COLUMNS, { width: 40 }).split('\n').map(stripAnsi);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
    expect(lines[1]).toContain('aabbccdd');
    expect(lines[1]).toContain('1.0 KB');
  });

  test('an empty row set still renders the header', () => {
    expect(stripAnsi(renderTable([], COLUMNS, { width: 80 }))).toContain('FILENAME');
  });
});
