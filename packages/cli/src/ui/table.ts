import { dim, displayWidth, padEnd, padStart, truncate } from './color.ts';

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  align?: 'left' | 'right';
  /** Columns marked flexible give up width first when the terminal is narrow. */
  flex?: boolean;
  minWidth?: number;
}

export interface TableOptions {
  /** Overrides the detected terminal width; 0 disables fitting entirely. */
  width?: number;
  gap?: number;
}

export function terminalWidth(): number {
  const columns = process.stdout.columns;
  return typeof columns === 'number' && columns > 20 ? columns : 100;
}

/**
 * Renders an aligned table. Numeric columns are right-aligned so digits stack,
 * and when the terminal is too narrow the flexible columns are squeezed (and
 * middle-elided) before anything is dropped.
 */
export function renderTable<T>(
  rows: readonly T[],
  columns: readonly Column<T>[],
  options: TableOptions = {},
): string {
  if (columns.length === 0) return '';
  const gap = options.gap ?? 2;
  const cells = rows.map((row) => columns.map((column) => column.value(row)));

  const widths = columns.map((column, index) =>
    Math.max(displayWidth(column.header), ...cells.map((row) => displayWidth(row[index] ?? ''))),
  );

  const available = options.width ?? terminalWidth();
  if (available > 0) shrinkToFit(widths, columns, available - gap * (columns.length - 1));

  const separator = ' '.repeat(gap);
  const line = (values: readonly string[], header: boolean): string =>
    values
      .map((value, index) => {
        const width = widths[index] ?? 0;
        const clipped = truncate(value, width);
        return columns[index]?.align === 'right'
          ? padStart(clipped, width)
          : padEnd(clipped, width);
      })
      .join(separator)
      .replace(/\s+$/, '') || (header ? '' : '');

  const out: string[] = [
    dim(
      line(
        columns.map((c) => c.header),
        true,
      ),
    ),
  ];
  for (const row of cells) out.push(line(row, false));
  return out.join('\n');
}

/** Trims flexible columns first, then everything, never below `minWidth`. */
function shrinkToFit<T>(widths: number[], columns: readonly Column<T>[], budget: number): void {
  const floor = (index: number): number => columns[index]?.minWidth ?? 3;
  for (const flexOnly of [true, false]) {
    let total = widths.reduce((sum, width) => sum + width, 0);
    while (total > budget) {
      const candidates = widths
        .map((width, index) => ({ width, index }))
        .filter(({ index, width }) => width > floor(index) && (!flexOnly || columns[index]?.flex));
      if (candidates.length === 0) break;
      let widest = candidates[0];
      for (const candidate of candidates) {
        if (widest === undefined || candidate.width > widest.width) widest = candidate;
      }
      if (widest === undefined) break;
      widths[widest.index] = widest.width - 1;
      total--;
    }
    if (widths.reduce((sum, width) => sum + width, 0) <= budget) return;
  }
}

/** A key/value block, used by `ms memory show` and `ms status`. */
export function renderFields(fields: readonly (readonly [string, string])[]): string {
  const width = Math.max(...fields.map(([key]) => displayWidth(key)));
  return fields.map(([key, value]) => `${dim(padStart(key, width))}  ${value}`).join('\n');
}
