import { create } from 'zustand';
import {
  isConnected,
  getAddress,
  signTransaction,
  requestAccess
} from '@stellar/freighter-api';

interface WalletState {
  address: string | null;
  network: string;
  isConnecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  setNetwork: (network: string) => void;
}

export const useWalletStore = create<WalletState>((set) => ({
  address: null,
  network: 'TESTNET',
  isConnecting: false,
  error: null,

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

  disconnect: () => {
    set({ address: null });
  },

  setNetwork: (network: string) => {
    set({ network });
  }
}));
