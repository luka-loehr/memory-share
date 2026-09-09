'use client';

import { useEffect, useRef, useState } from 'react';
import { formatBytes, formatTaken, mediaUrl } from '@/lib/format';
import type { ManifestItem } from '@/lib/memory';
import { VideoPlayer } from './video';
import styles from './viewer.module.css';

export type ViewerProps = {
  slug: string;
  items: ManifestItem[];
  index: number;
  allowDownload: boolean;
  onIndex: (index: number) => void;
  onClose: () => void;
};

/**
 * Photos are always viewable — the view rendition is produced on demand. A
 * video is only viewable once its locally-encoded proxy has been uploaded.
 */
function isViewable(item: ManifestItem): boolean {
  if (item.kind === 'photo') return true;
  return item.state === 'ready' || item.state === 'skipped';
}

export function Viewer({ slug, items, index, allowDownload, onIndex, onClose }: ViewerProps) {
  const item = items[index];
  // Reset per item, so failing on one photo does not condemn the next.
  const [loadFailed, setLoadFailed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the item.
  useEffect(() => setLoadFailed(false), [index]);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;
  const isVideo = item?.kind === 'video';

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      // On a video the bare arrows belong to the scrubber, so stepping through
      // the album is Shift+Arrow there. On a photo, plain arrows step.
      const stepping = isVideo ? event.shiftKey : true;
      if (!stepping) return;

      if (event.key === 'ArrowLeft' && hasPrev) {
        event.preventDefault();
        onIndex(index - 1);
      } else if (event.key === 'ArrowRight' && hasNext) {
        event.preventDefault();
        onIndex(index + 1);
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, hasPrev, hasNext, isVideo, onIndex, onClose]);

  // A simple focus trap: Tab cycles inside the overlay while it is open.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      const surface = surfaceRef.current;
      if (!surface) return;

      const focusable = surface.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Nothing behind the overlay should scroll while it is open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  if (!item) return null;

  const viewable = isViewable(item) && !loadFailed;
  const taken = formatTaken(item.takenAt);

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={item.filename}
      ref={surfaceRef}
    >
      <div className={styles.bar}>
        <div className={styles.barInfo}>
          <span className="label tabular">
            {index + 1} / {items.length}
          </span>
          <span className={styles.filename}>{item.filename}</span>
          {taken ? <span className="label">{taken}</span> : null}
        </div>

        <div className={styles.barActions}>
          {allowDownload ? (
            <a
              className={styles.textButton}
              href={mediaUrl(slug, 'orig', item.id, true)}
              download
              // The original, byte for byte — never the derivative.
            >
              Original · {formatBytes(item.bytes)}
            </a>
          ) : null}
          <button
            ref={closeRef}
            type="button"
            className={styles.iconButton}
            onClick={onClose}
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.4" fill="none" />
            </svg>
          </button>
        </div>
      </div>

      <div className={styles.stage}>
        {hasPrev ? (
          <button
            type="button"
            className={`${styles.nav} ${styles.navPrev}`}
            onClick={() => onIndex(index - 1)}
            aria-label="Previous"
          >
            <Chevron direction="left" />
          </button>
        ) : null}

        {!viewable ? (
          <div className={styles.developing}>
            <span className="label">
              {loadFailed || item.state === 'failed'
                ? 'This one is unavailable'
                : 'Still developing'}
            </span>
            <span className="label" style={{ color: 'var(--ash-dim)' }}>
              {item.filename}
            </span>
          </div>
        ) : item.kind === 'video' ? (
          <VideoPlayer
            key={item.id}
            src={mediaUrl(slug, 'view', item.id)}
            poster={mediaUrl(slug, 'thumb', item.id)}
            duration={item.duration}
          />
        ) : (
          <img
            key={item.id}
            className={styles.photo}
            src={mediaUrl(slug, 'view', item.id)}
            alt={item.filename}
            draggable={false}
            onError={() => setLoadFailed(true)}
          />
        )}

        {hasNext ? (
          <button
            type="button"
            className={`${styles.nav} ${styles.navNext}`}
            onClick={() => onIndex(index + 1)}
            aria-label="Next"
          >
            <Chevron direction="right" />
          </button>
        ) : null}
      </div>

      {/* Photos get a footer line; videos get an empty strip, because the
          player's own controls own the bottom of the screen. */}
      <div className={`${styles.footer} ${isVideo ? styles.footerHidden : ''}`}>
        <span className="label">
          {item.width > 0 ? `${item.width} × ${item.height}` : 'Dimensions unknown'}
        </span>
        <span className="label">Esc to close · ← → to move</span>
      </div>
    </div>
  );
}

function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true" focusable="false">
      <path
        d={direction === 'left' ? 'M9 1L1 8l8 7' : 'M1 1l8 7-8 7'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}
