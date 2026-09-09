'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatBytes, formatDuration, mediaUrl } from '@/lib/format';
import type { Manifest, ManifestItem } from '@/lib/memory';
import styles from './gallery.module.css';
import { useOverlay } from './overlay';
import { Viewer } from './viewer';

export type GalleryProps = {
  slug: string;
  manifest: Manifest;
};

/** True aspect ratio, or a gentle landscape default when EXIF gave us nothing. */
function aspectOf(item: ManifestItem): number {
  if (item.width > 0 && item.height > 0) return item.width / item.height;
  return 1.5;
}

/**
 * A photo is ALWAYS ready. It keeps no stored derivative — its renditions are
 * transformed from the original on the way out — so `derive_state` describes
 * videos and nothing else, and a photo tile must never show as developing.
 */
function isReady(item: ManifestItem): boolean {
  if (item.kind === 'photo') return true;
  return item.state === 'ready' || item.state === 'skipped';
}

/** Downloads are handed to the browser one at a time; popup blockers dislike bursts. */
function downloadSequentially(urls: string[]) {
  urls.forEach((url, index) => {
    window.setTimeout(() => {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = '';
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }, index * 400);
  });
}

export function Gallery({ slug, manifest }: GalleryProps) {
  const router = useRouter();
  const { setMediaOpen } = useOverlay();

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [selecting, setSelecting] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const items = manifest.items;

  // The viewer and the player own the screen while they are open; the orb steps
  // aside for them.
  useEffect(() => {
    setMediaOpen(openIndex !== null);
    return () => setMediaOpen(false);
  }, [openIndex, setMediaOpen]);

  const toggle = useCallback((id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectedItems = useMemo(
    () => items.filter((item) => selected.has(item.id)),
    [items, selected],
  );
  const selectedBytes = useMemo(
    () => selectedItems.reduce((total, item) => total + item.bytes, 0),
    [selectedItems],
  );
  const totalBytes = useMemo(() => items.reduce((total, item) => total + item.bytes, 0), [items]);

  async function lock() {
    await fetch(`/api/m/${encodeURIComponent(slug)}/lock`, { method: 'POST' });
    router.refresh();
  }

  const photos = items.filter((item) => item.kind === 'photo').length;
  const videos = items.length - photos;

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headline}>
          <div className={styles.kicker}>
            <span className={styles.tick} aria-hidden="true" />
            <span className="label">A memory, shared with you</span>
          </div>
          <h1 className={`display ${styles.title}`}>{manifest.title}</h1>
          {manifest.note ? <p className={styles.note}>{manifest.note}</p> : null}
        </div>

        <div className={styles.actions}>
          <span className={`label tabular ${styles.meta}`}>
            {photos} photo{photos === 1 ? '' : 's'}
            {videos > 0 ? ` · ${videos} video${videos === 1 ? '' : 's'}` : ''} ·{' '}
            {formatBytes(totalBytes)}
          </span>

          {manifest.allowDownload ? (
            <button
              type="button"
              className={`${styles.ghost} ${selecting ? styles.ghostOn : ''}`}
              onClick={() => {
                setSelecting((on) => !on);
                if (selecting) setSelected(new Set());
              }}
              aria-pressed={selecting}
            >
              {selecting ? 'Done' : 'Select'}
            </button>
          ) : null}

          <button type="button" className={styles.ghost} onClick={lock}>
            Lock
          </button>
        </div>
      </header>

      {items.length === 0 ? (
        <p className={`label ${styles.empty}`}>This memory is still empty.</p>
      ) : (
        <div className={`${styles.mosaic} ${selecting ? styles.selecting : ''}`}>
          {items.map((item, index) => (
            <Tile
              key={item.id}
              slug={slug}
              item={item}
              index={index}
              selectable={manifest.allowDownload}
              isSelected={selected.has(item.id)}
              onToggle={toggle}
              onOpen={setOpenIndex}
            />
          ))}
        </div>
      )}

      {selectedItems.length > 0 ? (
        <div className={styles.tray} role="region" aria-label="Selected items">
          <div className={styles.trayCount}>
            <span className={styles.trayNumber}>{selectedItems.length}</span>
            <span className="label tabular">{formatBytes(selectedBytes)}</span>
          </div>
          <span className={styles.traySep} aria-hidden="true" />
          <button type="button" className={styles.ghost} onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <button
            type="button"
            className={styles.solid}
            onClick={() =>
              downloadSequentially(
                selectedItems.map((item) => mediaUrl(slug, 'orig', item.id, true)),
              )
            }
          >
            Download originals
          </button>
        </div>
      ) : null}

      {openIndex !== null ? (
        <Viewer
          slug={slug}
          items={items}
          index={openIndex}
          allowDownload={manifest.allowDownload}
          onIndex={setOpenIndex}
          onClose={() => setOpenIndex(null)}
        />
      ) : null}
    </main>
  );
}

type TileProps = {
  slug: string;
  item: ManifestItem;
  index: number;
  selectable: boolean;
  isSelected: boolean;
  onToggle: (id: string) => void;
  onOpen: (index: number) => void;
};

function Tile({ slug, item, index, selectable, isSelected, onToggle, onOpen }: TileProps) {
  // A rendition can still fail to arrive — a source too large for the Images
  // binding, a format it cannot decode, a dropped connection. Invariant 3 says
  // the tile shows *something*, so a failed load falls back to the same plate
  // rather than the browser's broken-image icon.
  const [loadFailed, setLoadFailed] = useState(false);
  const ready = isReady(item) && !loadFailed;
  const unavailable = loadFailed || item.state === 'failed';

  return (
    <figure
      className={`${styles.tile} ${isSelected ? styles.selected : ''}`}
      style={{ '--ar': aspectOf(item) } as React.CSSProperties}
    >
      {ready ? (
        <img
          src={mediaUrl(slug, 'thumb', item.id)}
          alt={item.filename}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setLoadFailed(true)}
        />
      ) : (
        <div
          className={`${styles.plate} ${unavailable ? styles.plateFailed : ''}`}
          role="img"
          aria-label={
            unavailable ? `${item.filename} is unavailable` : `${item.filename} is still developing`
          }
        >
          <span className={styles.plateLabel}>
            <span className="label">{unavailable ? 'Unavailable' : 'Developing'}</span>
          </span>
        </div>
      )}

      <button
        type="button"
        className={styles.open}
        onClick={() => onOpen(index)}
        aria-label={`Open ${item.filename}`}
      />

      {item.kind === 'video' ? (
        <span className={styles.badge}>
          <PlayGlyph />
          <span className="tabular">{formatDuration(item.duration)}</span>
        </span>
      ) : null}

      {selectable ? (
        <button
          type="button"
          className={styles.check}
          role="checkbox"
          aria-checked={isSelected}
          aria-label={`Select ${item.filename}`}
          onClick={() => onToggle(item.id)}
        >
          <CheckGlyph />
        </button>
      ) : null}
    </figure>
  );
}

function PlayGlyph() {
  return (
    <svg width="8" height="9" viewBox="0 0 8 9" aria-hidden="true" focusable="false">
      <path d="M0 0l8 4.5L0 9z" fill="currentColor" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden="true" focusable="false">
      <path
        d="M1 5l3.4 3.4L11 1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
      />
    </svg>
  );
}
