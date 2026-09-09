import type { Metadata, Viewport } from 'next';
import { Fraunces, Instrument_Sans } from 'next/font/google';
import { Orb } from '@/app/components/orb';
import { OverlayProvider } from '@/app/components/overlay';
import './globals.css';

/*
 * Fraunces for display — a variable serif with SOFT and WONK axes, so headings
 * can be genuinely idiosyncratic rather than merely large. Instrument Sans
 * carries every label and control: narrow, slightly mechanical, and content to
 * stay out of the way at 11px with wide tracking.
 */
const fraunces = Fraunces({
  subsets: ['latin'],
  axes: ['SOFT', 'WONK', 'opsz'],
  variable: '--font-fraunces',
  display: 'swap',
});

const instrument = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-instrument',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'memory-share',
  description: 'A private album, shared as a link.',
  // Share pages are secrets in a URL; keep them out of every index.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#0a0908',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${instrument.variable}`}>
      <body>
        <OverlayProvider>
          {children}
          {/* Pinned globally, but suppressed by the overlay context whenever a
              photo or a video is open — the orb must never sit over media. */}
          <Orb />
        </OverlayProvider>
      </body>
    </html>
  );
}
