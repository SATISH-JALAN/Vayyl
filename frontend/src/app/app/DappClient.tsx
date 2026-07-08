'use client';

import { Buffer } from 'buffer';
import dynamic from 'next/dynamic';

const globals = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (!globals.Buffer) globals.Buffer = Buffer;

const DappRuntime = dynamic(() => import('./DappRuntime'), {
  ssr: false,
  loading: () => <div className="dapp-shell" />,
});

export default function DappClient() {
  return <DappRuntime />;
}
