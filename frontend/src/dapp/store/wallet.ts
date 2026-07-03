import { create } from 'zustand';
import {
  getAddress,
  requestAccess
} from '@stellar/freighter-api';
import { deriveViewingKey, deriveShieldedKeys, type ShieldedKeys } from '../lib/crypto';

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
  setNetwork: (network: string) => void;
}

export const useWalletStore = create<WalletState>((set, get) => ({
  address: null,
  network: 'TESTNET',
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
          set({ address: res.address });
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
      const viewingKey = await deriveViewingKey();
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

  setNetwork: (network: string) => {
    set({ network });
  }
}));
