import Link from 'next/link';

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '100svh',
        display: 'grid',
        placeContent: 'center',
        gap: '18px',
        padding: '32px',
        textAlign: 'center',
      }}
    >
      <p className="label">No such memory</p>
      <h1 className="display" style={{ fontSize: 'clamp(2rem, 6vw, 3.4rem)' }}>
        This link has nothing behind it.
      </h1>
      <p style={{ color: 'var(--ash)', margin: 0, fontSize: '0.9375rem' }}>
        It may have been deleted, or it may have expired.
      </p>
      <Link className="label" href="/" style={{ color: 'var(--safelight-warm)' }}>
        Back
      </Link>
    </main>
  );
}
