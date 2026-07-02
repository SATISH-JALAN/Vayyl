import { create } from 'zustand';
import ProofWorker from '../lib/proof-worker?worker';

export interface ShieldedNote {
  id: string;
  amount: number;
  asset: string;
  status: 'active' | 'spent';
}

interface PoolState {
  shieldedBalance: number;
  notes: ShieldedNote[];
  isProving: boolean;
  deposit: (amount: number, asset: string) => Promise<void>;
  withdraw: (amount: number, asset: string, destination: string) => Promise<void>;
  transfer: (amount: number, asset: string, recipient: string) => Promise<void>;
}

const runWorkerTask = (type: string, payload: any): Promise<any> => {
  return new Promise((resolve, reject) => {
    const worker = new ProofWorker();
    const taskId = Math.random().toString(36).substring(7);
    
    worker.onmessage = (e: any) => {
      if (e.data.id === taskId) {
        if (e.data.status === 'success') {
          resolve(e.data.result);
        } else {
          reject(new Error(e.data.error));
        }
        worker.terminate();
      }
    };
    
    worker.postMessage({ type, payload, id: taskId });
  });
};

export const usePoolStore = create<PoolState>((set, get) => ({
  // Initialize with some mock data so the UI isn't empty for the demo
  shieldedBalance: 12500,
  notes: [
    { id: 'note_1x9f...', amount: 10000, asset: 'XLM', status: 'active' },
    { id: 'note_2y7b...', amount: 2500, asset: 'XLM', status: 'active' },
  ],
  isProving: false,

  deposit: async (amount: number, asset: string) => {
    set({ isProving: true });
    
    try {
      // Offload heavy ZK proving to Web Worker
      const result = await runWorkerTask('PROVE_DEPOSIT', { amount, asset });
      console.log('Proof generated:', result);

      set((state) => ({
        shieldedBalance: state.shieldedBalance + amount,
        notes: [
          ...state.notes,
          { id: `note_${Math.random().toString(36).substr(2, 9)}`, amount, asset, status: 'active' }
        ],
      }));
    } catch (e) {
      console.error("Proof failed", e);
    } finally {
      set({ isProving: false });
    }
  },

  transfer: async (amount: number, asset: string, recipient: string) => {
    set({ isProving: true });
    
    try {
      const state = get();
      if (amount > state.shieldedBalance) {
        throw new Error("Insufficient shielded balance");
      }

      // Offload heavy ZK proving to Web Worker
      const result = await runWorkerTask('PROVE_TRANSFER', { amount, asset, recipient });
      console.log('Proof generated:', result);

      // In a real implementation, transferring doesn't change total shielded balance
      // because you just spend an old note and create a new one (and send to recipient)
      // But for the local UI, the sender's balance decreases.
      set((state) => ({
        shieldedBalance: state.shieldedBalance - amount,
      }));
    } catch (e) {
      console.error("Proof failed", e);
      throw e;
    } finally {
      set({ isProving: false });
    }
  },

  withdraw: async (amount: number, asset: string, destination: string) => {
    set({ isProving: true });
    
    try {
      const state = get();
      if (amount > state.shieldedBalance) {
        throw new Error("Insufficient shielded balance");
      }

      // Offload heavy ZK proving to Web Worker
      const result = await runWorkerTask('PROVE_WITHDRAW', { amount, asset, destination });
      console.log('Proof generated:', result);

      set((state) => ({
        shieldedBalance: state.shieldedBalance - amount,
      }));
    } catch (e) {
      console.error("Proof failed", e);
    } finally {
      set({ isProving: false });
    }
  }
}));
