import type { Metadata } from 'next';

import type { RouteKey } from '../../dapp/App';
import DappClient from './DappClient';

export const metadata: Metadata = {
  title: 'Vayyl App - Confidential Settlement',
  description: 'Shield, back up, restore, and settle XLM notes with Vayyl.',
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

function routeFromView(value: string | string[] | undefined): RouteKey {
  const view = Array.isArray(value) ? value[0] : value;
  if (view === 'pool' || view === 'positions' || view === 'escrow' || view === 'settings') return view;
  return 'dashboard';
}

export default async function AppPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  return <DappClient initialRoute={routeFromView(params.view)} />;
}
