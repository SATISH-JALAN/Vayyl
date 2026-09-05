import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  async redirects() {
    return [
      {
        source: '/app.html',
        destination: '/app',
        permanent: true,
      },
    ];
  },

  // H10: the non-CSP half of the security headers. CSP itself is set per-request
  // in src/proxy.ts because it carries a nonce; these are static and so
  // belong here, where they also cover the static asset routes the middleware
  // matcher deliberately skips.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Defence in depth alongside the CSP's frame-ancestors, for anything
          // that ignores CSP.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // A shielded-pool URL should never leak to a third party, and the
          // DApp's paths are the user's activity.
          { key: 'Referrer-Policy', value: 'no-referrer' },
          // Nothing here needs a camera, a microphone or a location.
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
          // Keep the proving worker cross-origin isolated where the host allows
          // it; snarkjs benefits from SharedArrayBuffer when it is available.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
