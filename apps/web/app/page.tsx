/**
 * The root is deliberately almost nothing: this deployment is a place links
 * point into, not a product page. Everything interesting is behind /m/<slug>.
 */
export default function Home() {
  return (
    <main
      style={{
        minHeight: '100svh',
        display: 'grid',
        alignContent: 'center',
        gap: '20px',
        padding: 'clamp(28px, 6vw, 80px)',
        maxWidth: '760px',
      }}
    >
      <p className="label">memory-share</p>
      <h1
        className="display"
        style={{ fontSize: 'clamp(2.4rem, 8vw, 5rem)', color: 'var(--silver)' }}
      >
        Photographs, kept where you keep them.
      </h1>
      <p
        style={{
          color: 'var(--ash)',
          margin: 0,
          fontSize: '1rem',
          lineHeight: 1.7,
          maxWidth: '46ch',
        }}
      >
        A memory is an album with a password. Open the link you were sent, type the password, and
        the photographs are yours to browse and to download exactly as they came off the camera.
      </p>
    </main>
  );
}
