'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDuration } from '@/lib/format';
import styles from './video.module.css';

/*
 * A hand-built player, because the stock controls are both ugly and, in a dark
 * full-bleed viewer, out of place.
 *
 * Seeking is entirely ordinary HTMLMediaElement seeking — the interesting half
 * is on the server: /api/m/:slug/media/* answers Range with 206 and a correct
 * Content-Range, so setting currentTime makes the browser ask for exactly the
 * byte window it needs rather than refetching the file. A faststart MP4 (moov
 * at the front, per the derive pipeline) means that works from the first frame.
 */

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const HIDE_AFTER_MS = 2600;

export type VideoPlayerProps = {
  src: string;
  poster?: string;
  /** Known duration from the manifest; bridges the gap before metadata loads. */
  duration?: number | null;
};

export function VideoPlayer({ src, poster, duration }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const scrubberRef = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef<number | null>(null);

  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(duration ?? 0);
  const [buffered, setBuffered] = useState<Array<[number, number]>>([]);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);
  const [hoverAt, setHoverAt] = useState<{ time: number; x: number } | null>(null);
  const [waiting, setWaiting] = useState(false);

  const clampedTotal = total > 0 && Number.isFinite(total) ? total : 0;
  const progress = clampedTotal > 0 ? Math.min(current / clampedTotal, 1) : 0;

  /* ------------------------------------------------------------ playback -- */

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }, []);

  const seekTo = useCallback(
    (time: number) => {
      const video = videoRef.current;
      if (!video || clampedTotal <= 0) return;
      const next = Math.max(0, Math.min(time, clampedTotal));
      video.currentTime = next;
      setCurrent(next);
    },
    [clampedTotal],
  );

  const nudge = useCallback(
    (delta: number) => seekTo((videoRef.current?.currentTime ?? 0) + delta),
    [seekTo],
  );

  /* -------------------------------------------------------- auto-hiding -- */

  const wake = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      // Never hide while the user is mid-gesture or reading the speed menu, and
      // never hide a paused player — there is nothing to watch behind it.
      const video = videoRef.current;
      if (video && !video.paused && !scrubbing && !speedOpen) setControlsVisible(false);
    }, HIDE_AFTER_MS);
  }, [scrubbing, speedOpen]);

  useEffect(() => {
    wake();
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [wake]);

  useEffect(() => {
    if (!playing) setControlsVisible(true);
  }, [playing]);

  /* ------------------------------------------------------------- events -- */

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const readBuffered = () => {
      const ranges: Array<[number, number]> = [];
      for (let i = 0; i < video.buffered.length; i++) {
        ranges.push([video.buffered.start(i), video.buffered.end(i)]);
      }
      setBuffered(ranges);
    };

    const onTime = () => {
      if (!scrubbing) setCurrent(video.currentTime);
      readBuffered();
    };
    const onMeta = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) setTotal(video.duration);
      readBuffered();
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onVolume = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };
    const onWaiting = () => setWaiting(true);
    const onPlaying = () => setWaiting(false);

    video.addEventListener('timeupdate', onTime);
    video.addEventListener('progress', readBuffered);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('durationchange', onMeta);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('volumechange', onVolume);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('canplay', onPlaying);

    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('progress', readBuffered);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('durationchange', onMeta);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('volumechange', onVolume);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('canplay', onPlaying);
    };
  }, [scrubbing]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  /* ---------------------------------------------------------- scrubbing -- */

  const timeAtClientX = useCallback(
    (clientX: number) => {
      const rail = scrubberRef.current;
      if (!rail || clampedTotal <= 0) return 0;
      const rect = rail.getBoundingClientRect();
      const ratio = Math.max(0, Math.min((clientX - rect.left) / rect.width, 1));
      return ratio * clampedTotal;
    },
    [clampedTotal],
  );

  const onScrubDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (clampedTotal <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setScrubbing(true);
    // Optimistic: move the head immediately, commit the seek on release, so
    // dragging stays smooth instead of firing a seek per pixel.
    setCurrent(timeAtClientX(event.clientX));
  };

  const onScrubMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const time = timeAtClientX(event.clientX);
    const rect = event.currentTarget.getBoundingClientRect();
    setHoverAt({ time, x: Math.max(28, Math.min(event.clientX - rect.left, rect.width - 28)) });
    if (scrubbing) setCurrent(time);
  };

  const onScrubUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setScrubbing(false);
    seekTo(timeAtClientX(event.clientX));
    wake();
  };

  /* ---------------------------------------------------------- keyboard --- */

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Let form controls (the volume slider) keep their own key handling.
    if ((event.target as HTMLElement).tagName === 'INPUT') return;

    const video = videoRef.current;
    if (!video) return;

    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
      wake();
    };

    switch (event.key) {
      case ' ':
      case 'k':
      case 'K':
        handled();
        togglePlay();
        break;
      case 'ArrowLeft':
        // Shift+Arrow belongs to the viewer, for stepping through the album.
        if (event.shiftKey) return;
        handled();
        nudge(-5);
        break;
      case 'ArrowRight':
        if (event.shiftKey) return;
        handled();
        nudge(5);
        break;
      case 'j':
      case 'J':
        handled();
        nudge(-10);
        break;
      case 'l':
      case 'L':
        handled();
        nudge(10);
        break;
      case 'ArrowUp':
        handled();
        video.volume = Math.min(1, video.volume + 0.1);
        break;
      case 'ArrowDown':
        handled();
        video.volume = Math.max(0, video.volume - 0.1);
        break;
      case 'm':
      case 'M':
        handled();
        video.muted = !video.muted;
        break;
      case 'f':
      case 'F':
        handled();
        void toggleFullscreen();
        break;
      case 'Home':
        handled();
        seekTo(0);
        break;
      case 'End':
        handled();
        seekTo(clampedTotal);
        break;
      default:
        break;
    }
  };

  async function toggleFullscreen() {
    const shell = shellRef.current;
    if (!shell) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await shell.requestFullscreen();
    } catch {
      // Fullscreen refused (iOS Safari on some elements). Not worth surfacing.
    }
  }

  async function togglePip() {
    const video = videoRef.current;
    if (!video || !document.pictureInPictureEnabled) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      /* ignore */
    }
  }

  const hideCursor = playing && !controlsVisible;

  return (
    <div
      ref={shellRef}
      className={`${styles.player} ${hideCursor ? styles.cursorHidden : ''}`}
      onPointerMove={wake}
      onKeyDown={onKeyDown}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a composite media widget must hold focus.
      tabIndex={0}
      role="region"
      aria-label="Video player"
    >
      <video
        ref={videoRef}
        className={styles.video}
        src={src}
        poster={poster}
        playsInline
        preload="metadata"
        onClick={togglePlay}
        // No `controls`: everything below is the control surface.
      />

      {waiting && playing ? (
        <div className={styles.stalled}>
          <span className="label">Buffering</span>
        </div>
      ) : null}

      {!playing ? (
        <button type="button" className={styles.bigPlay} onClick={togglePlay} aria-label="Play">
          <span className={styles.bigPlayDisc}>
            <svg width="20" height="24" viewBox="0 0 20 24" aria-hidden="true">
              <path d="M0 0l20 12L0 24z" fill="currentColor" />
            </svg>
          </span>
        </button>
      ) : null}

      <div
        className={`${styles.controls} ${controlsVisible ? '' : styles.controlsHidden}`}
        onPointerEnter={() => setControlsVisible(true)}
      >
        {/* Scrubber first and alone on its line. Nothing may share this row. */}
        <div
          ref={scrubberRef}
          className={`${styles.scrubber} ${scrubbing ? styles.scrubbing : ''}`}
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(clampedTotal)}
          aria-valuenow={Math.round(current)}
          aria-valuetext={`${formatDuration(current)} of ${formatDuration(clampedTotal)}`}
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerUp={onScrubUp}
          onPointerLeave={() => setHoverAt(null)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              nudge(-5);
            } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              nudge(5);
            }
          }}
        >
          <div className={styles.rail}>
            {clampedTotal > 0
              ? buffered.map(([start, end], i) => (
                  <div
                    key={i}
                    className={styles.buffered}
                    style={{
                      left: `${(start / clampedTotal) * 100}%`,
                      width: `${((end - start) / clampedTotal) * 100}%`,
                    }}
                  />
                ))
              : null}
            <div className={styles.played} style={{ width: `${progress * 100}%` }} />
          </div>
          <span className={styles.knob} style={{ left: `${progress * 100}%` }} />

          {hoverAt && clampedTotal > 0 ? (
            <span className={styles.preview} style={{ left: hoverAt.x }}>
              {formatDuration(hoverAt.time)}
            </span>
          ) : null}
        </div>

        <div className={styles.row}>
          <button
            type="button"
            className={styles.button}
            onClick={togglePlay}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? (
              <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true">
                <path d="M0 0h4v14H0zM8 0h4v14H8z" fill="currentColor" />
              </svg>
            ) : (
              <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true">
                <path d="M0 0l12 7-12 7z" fill="currentColor" />
              </svg>
            )}
          </button>

          <div className={styles.volumeGroup}>
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                const video = videoRef.current;
                if (video) video.muted = !video.muted;
              }}
              aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
              aria-pressed={muted}
            >
              <SpeakerGlyph muted={muted || volume === 0} />
            </button>
            <div className={styles.volume}>
              <input
                className={styles.slider}
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                aria-label="Volume"
                onChange={(event) => {
                  const video = videoRef.current;
                  if (!video) return;
                  video.volume = Number(event.target.value);
                  video.muted = Number(event.target.value) === 0;
                }}
              />
            </div>
          </div>

          <span className={styles.time}>
            <span className={styles.timeNow}>{formatDuration(current)}</span>
            {' / '}
            {formatDuration(clampedTotal)}
          </span>

          <span className={styles.spacer} />

          <div className={styles.menuWrap}>
            <button
              type="button"
              className={`${styles.button} ${styles.wide}`}
              onClick={() => setSpeedOpen((open) => !open)}
              aria-label="Playback speed"
              aria-haspopup="menu"
              aria-expanded={speedOpen}
            >
              {speed}×
            </button>
            {speedOpen ? (
              <div className={styles.menu} role="menu">
                {SPEEDS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={speed === value}
                    className={`${styles.menuItem} ${speed === value ? styles.menuItemOn : ''}`}
                    onClick={() => {
                      const video = videoRef.current;
                      if (video) video.playbackRate = value;
                      setSpeed(value);
                      setSpeedOpen(false);
                    }}
                  >
                    {value}×
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {typeof document !== 'undefined' && document.pictureInPictureEnabled ? (
            <button
              type="button"
              className={styles.button}
              onClick={togglePip}
              aria-label="Picture in picture"
            >
              <svg width="15" height="13" viewBox="0 0 15 13" aria-hidden="true">
                <rect
                  x="0.7"
                  y="0.7"
                  width="13.6"
                  height="11.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
                <rect x="7" y="6" width="6" height="5" fill="currentColor" />
              </svg>
            </button>
          ) : null}

          <button
            type="button"
            className={styles.button}
            onClick={toggleFullscreen}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            aria-pressed={fullscreen}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d={
                  fullscreen
                    ? 'M5 1v4H1M9 13V9h4M1 9h4v4M13 5H9V1'
                    : 'M1 5V1h4M13 5V1H9M1 9v4h4M13 9v4H9'
                }
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function SpeakerGlyph({ muted }: { muted: boolean }) {
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
      <path d="M1 5h3l4-3.5v11L4 9H1z" fill="currentColor" />
      {muted ? (
        <path d="M10.5 5l4 4M14.5 5l-4 4" stroke="currentColor" strokeWidth="1.3" fill="none" />
      ) : (
        <path
          d="M10.6 4.4a4 4 0 010 5.2M12.6 2.6a6.6 6.6 0 010 8.8"
          stroke="currentColor"
          strokeWidth="1.3"
          fill="none"
        />
      )}
    </svg>
  );
}
