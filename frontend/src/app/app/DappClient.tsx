'use client';

import { Buffer } from 'buffer';

import type { RouteKey } from '../../dapp/App';
import App from '../../dapp/App';

const globals = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (!globals.Buffer) globals.Buffer = Buffer;

export default function DappClient({ initialRoute = 'dashboard' }: { initialRoute?: RouteKey }) {
  return <App initialRoute={initialRoute} />;
}
