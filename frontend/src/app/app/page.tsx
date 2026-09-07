import type { Metadata } from 'next';

import { routeFromView } from '../../dapp/routes';
import DappClient from './DappClient';

export const metadata: Metadata = {
  title: 'Vayyl App - Confidential Settlement',
  description: 'Shield, back up, restore, and settle XLM notes with Vayyl.',
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

// routeFromView is shared with the client parser in src/dapp/App.tsx. It used
// to be a second hand-written whitelist here, and it had fallen behind by one
// route: 'compliance' was missing, so /app?view=compliance server-rendered the
// Dashboard and swapped to Compliance only after hydration.

export default async function AppPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  return <DappClient initialRoute={routeFromView(params.view)} />;
}
