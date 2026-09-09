const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

export function formatBytes(bytes: number, fractionDigits?: number): string {
  if (!Number.isFinite(bytes)) return '—';
  const sign = bytes < 0 ? '-' : '';
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = fractionDigits ?? (unit === 0 ? 0 : value < 100 ? 1 : 0);
  return `${sign}${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond, 1)}/s`;
}

/** Compact and monotonic: 0:07, 3:42, 1:12:30. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds > 86_400 * 7) return '—';
  return formatDuration(seconds);
}

/** Epoch seconds (the schema's unit) to a sortable local stamp. */
export function formatDate(epochSeconds: number | null | undefined): string {
  if (epochSeconds === null || epochSeconds === undefined || epochSeconds === 0) return '—';
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDimensions(width?: number, height?: number): string {
  if (!width || !height) return '—';
  return `${width}×${height}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

/** "3 files, 1.2 GB" — the phrase every summary line in this CLI ends with. */
export function countAndSize(count: number, bytes: number): string {
  return `${count} ${plural(count, 'file')}, ${formatBytes(bytes)}`;
}
