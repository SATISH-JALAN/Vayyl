import { Networks } from '@stellar/stellar-sdk';

export const NETWORK = 'TESTNET';
export const NETWORK_PASSPHRASE = Networks.TESTNET;

export function isExpectedWalletNetwork(details: {
  network?: string;
  networkPassphrase?: string;
}): boolean {
  return details.network
    ? details.network.trim().toUpperCase() === NETWORK
    : details.networkPassphrase === NETWORK_PASSPHRASE;
}
