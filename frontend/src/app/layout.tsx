import type { Metadata, Viewport } from 'next';
import { Cormorant_Garamond, JetBrains_Mono, Manrope } from 'next/font/google';

import '../styles/index.css';
import '../dapp/styles/dapp-tokens.css';
import '../dapp/styles/dapp-typography.css';
import '../dapp/styles/dapp-layout.css';
import '../dapp/styles/dapp-components.css';

const cormorant = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['300', '400', '600'],
  style: ['normal', 'italic'],
  variable: '--font-cormorant',
  display: 'swap',
});

const manrope = Manrope({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-manrope',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000');

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Vayyl - Confidential Settlement on Stellar',
  description:
    'Create private XLM notes and settle them with zero-knowledge proofs verified on Stellar Soroban.',
  icons: {
    icon: '/images/vayyl.logofevicon.png',
  },
  openGraph: {
    title: 'Vayyl - Confidential Settlement on Stellar',
    description: 'Private XLM notes with client-side proving and Soroban verification.',
    type: 'website',
    images: ['/images/hero-bg.webp'],
  },
  twitter: {
    card: 'summary_large_image',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${cormorant.variable} ${manrope.variable} ${jetbrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
