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
};

export default nextConfig;
