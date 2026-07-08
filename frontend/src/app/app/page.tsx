import type { Metadata } from 'next';

import DappClient from './DappClient';

export const metadata: Metadata = {
  title: 'Vayyl App - Confidential Settlement',
  description: 'Connect Freighter on Stellar testnet to use the Vayyl confidential settlement DApp.',
};

export default function AppPage() {
  return <DappClient />;
}
