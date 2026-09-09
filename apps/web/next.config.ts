import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Share pages are per-session and password gated; nothing here is cacheable at the edge.
  poweredByHeader: false,
};

export default nextConfig;
