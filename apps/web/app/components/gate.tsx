'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Dither } from './dither';
import styles from './gate.module.css';

export type GateProps = {
  slug: string;
  title: string;
  note: string | null;
};

export function Gate({ slug, title, note }: GateProps) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !password) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/m/${encodeURIComponent(slug)}/unlock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (response.ok) {
        setPassword('');
        // The cookie is set; the server component re-renders as the gallery.
        router.refresh();
        return;
      }

      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(
        body.error === 'rate_limited'
          ? 'Too many attempts. The gate is closed for a while.'
          : 'That is not the password for this memory.',
      );
      setBusy(false);
      inputRef.current?.select();
    } catch {
      setError('The connection failed. Try again.');
      setBusy(false);
    }
  }

  return (
    <main className={styles.shell}>
      <Dither src={`/api/m/${encodeURIComponent(slug)}/cover`} className={styles.plate} />

      <div className={styles.layout}>
        <div className={styles.panel}>
          <div className={styles.eyebrow}>
            <span className="label">Sealed</span>
          </div>

          <h1 className={`display ${styles.title}`}>{title}</h1>
          {note ? <p className={styles.note}>{note}</p> : null}

          <form onSubmit={submit} noValidate>
            <div className={styles.field}>
              <label className={`label ${styles.fieldLabel}`} htmlFor="ms-password">
                Password
              </label>
              <div className={styles.inputWrap}>
                <input
                  ref={inputRef}
                  id="ms-password"
                  className={styles.input}
                  type={visible ? 'text' : 'password'}
                  value={password}
                  autoComplete="current-password"
                  // biome-ignore lint/a11y/noAutofocus: this page exists only to take a password.
                  autoFocus
                  spellCheck={false}
                  placeholder="••••••••••"
                  aria-invalid={error !== null}
                  aria-describedby={error ? 'ms-error' : undefined}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  type="button"
                  className={styles.reveal}
                  onClick={() => setVisible((v) => !v)}
                  aria-label={visible ? 'Hide password' : 'Show password'}
                  aria-pressed={visible}
                >
                  <span className="label">{visible ? 'Hide' : 'Show'}</span>
                </button>
              </div>
            </div>

            <button className={styles.submit} type="submit" disabled={busy || !password}>
              {busy ? 'Developing…' : 'Unlock'}
            </button>
          </form>

          {error ? (
            <p className={styles.error} id="ms-error" role="alert">
              <span aria-hidden="true">—</span>
              {error}
            </p>
          ) : null}

          <p className={styles.foot}>
            Nothing here is public. The photographs stay unreadable until the password checks out —
            the image behind this panel is all that is sent before then.
          </p>
        </div>
      </div>
    </main>
  );
}
