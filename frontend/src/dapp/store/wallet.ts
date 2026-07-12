import { create } from 'zustand';
import {
  getAddress,
  requestAccess,
  isConnected,
  isAllowed,
  getNetworkDetails,
} from '@stellar/freighter-api';
import { deriveViewingKey, deriveShieldedKeys, type ShieldedKeys } from '../lib/crypto';
import { isExpectedWalletNetwork, NETWORK } from '../lib/network';

async function getExpectedNetwork(): Promise<string> {
  const details = await getNetworkDetails();
  if (details.error) throw new Error(details.error);
  if (!isExpectedWalletNetwork(details)) {
    throw new Error('Switch Freighter to Stellar Testnet to continue.');
  }
  return NETWORK;
}

interface WalletState {
  address: string | null;
  network: string;
  isConnecting: boolean;
  error: string | null;
  // Real shielded identity (Task 6.2) — derived from a Freighter signature.
  keys: ShieldedKeys | null;
  isUnlocking: boolean;
  connect: () => Promise<void>;
  /** Derive the shielded viewing/spend keys (prompts a Freighter signature). */
  unlockShieldedKeys: () => Promise<ShieldedKeys>;
  disconnect: () => void;
  autoConnect: () => Promise<void>;
}

export const useWalletStore = create<WalletState>((set, get) => ({
  address: null,
  network: NETWORK,
  isConnecting: false,
  error: null,
  keys: null,
  isUnlocking: false,

  connect: async () => {
    set({ isConnecting: true, error: null });
    try {
      const isAllowed = await requestAccess();
      if (isAllowed) {
        const res = await getAddress();
        if (res.address) {
          const network = await getExpectedNetwork();
          set({ address: res.address, network });
        } else if (res.error) {
          set({ error: res.error });
        }
      } else {
        set({ error: 'Access denied by user.' });
      }
    } catch (e: any) {
      set({ error: e.message || 'Failed to connect wallet.' });
    } finally {
      set({ isConnecting: false });
    }
  },

  unlockShieldedKeys: async () => {
    const existing = get().keys;
    if (existing) return existing;
    set({ isUnlocking: true, error: null });
    try {
      if (!get().address) throw new Error('Connect your wallet first');
      await getExpectedNetwork();
      const viewingKey = await deriveViewingKey(get().address!);
      const keys = await deriveShieldedKeys(viewingKey);
      set({ keys });
      return keys;
    } catch (e: any) {
      set({ error: e.message || 'Failed to derive shielded keys.' });
      throw e;
    } finally {
      set({ isUnlocking: false });
    }
  },

  disconnect: () => {
    set({ address: null, keys: null });
  },

  autoConnect: async () => {
    try {
      if (await isConnected() && await isAllowed()) {
        const res = await getAddress();
        if (res.address) {
          const network = await getExpectedNetwork();
          set({ address: res.address, network });
        }
      }
    } catch (e) {
      console.warn('Failed to auto-connect wallet', e);
    }
  }
}));
