/** Display helpers. Binary units, because these are file sizes on disk. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** m:ss, or h:mm:ss past an hour. Used by the tiles and the scrubber. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatTaken(epochSeconds: number | null): string | null {
  if (!epochSeconds) return null;
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Build a media URL from a content hash. The client only ever knows the hash
 * and which rendition it wants — never whether the bytes will come from a
 * stored object or an edge transform.
 */
export function mediaUrl(
  slug: string,
  variant: 'thumb' | 'view' | 'orig',
  assetId: string,
  download = false,
): string {
  return `/api/m/${encodeURIComponent(slug)}/media/${variant}/${encodeURIComponent(assetId)}${
    download ? '?dl=1' : ''
  }`;
}
