'use client';

import styles from './orb.module.css';
import { useOverlay } from './overlay';

const REPO = 'https://github.com/luka-loehr/memory-share';

/**
 * A dot in the corner that becomes a sentence when you reach for it.
 *
 * It is present on every surface except the photo viewer and the video player:
 * media gets the whole screen, uninterrupted.
 */
export function Orb() {
  const { mediaOpen } = useOverlay();

  return (
    <a
      className={`${styles.orb} ${mediaOpen ? styles.hidden : ''}`}
      href={REPO}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="memory-share on GitHub — try it yourself"
      // `inert` takes it out of the tab order AND out of the accessibility tree
      // while a photo or video is open, without hiding an anchor that still has
      // to be announced normally the rest of the time.
      inert={mediaOpen}
    >
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.label}>try memory-share</span>
    </a>
  );
}
