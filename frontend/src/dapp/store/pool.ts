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
  fetchState: (poolAddress: string) => Promise<void>;
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
  shieldedBalance: 0,
  notes: [],
  isProving: false,

  fetchState: async (poolAddress: string) => {
    try {
      const response = await fetch(`http://localhost:3001/commitments?pool=${poolAddress}`);
      const data = await response.json();
      if (data.commitments) {
        // In a real implementation, attempt to decrypt these commitments using the viewing key
        // For the demo, we just count them
        set({
          notes: data.commitments.map((c: any, i: number) => ({
            id: c.commitment_hash,
            amount: 1000, // mock decrypted amount
            asset: 'XLM',
            status: 'active'
          })),
          shieldedBalance: data.commitments.length * 1000 // mock sum
        });
      }
    } catch (e) {
      console.error("Failed to fetch state", e);
    }
  },

  deposit: async (amount: number, asset: string) => {
    set({ isProving: true });
    
    try {
      // Offload heavy ZK proving to Web Worker
      const result = await runWorkerTask('PROVE_DEPOSIT', { amount, asset });
      console.log('Proof generated:', result);

      // Submit to Relayer
      const relayRes = await fetch('http://localhost:3002/relay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tx: "mock_base64_xdr_containing_deposit_invocation_and_proof"
        })
      });
      const relayData = await relayRes.json();
      if (!relayData.success) throw new Error(relayData.error);

      set((state) => ({
        shieldedBalance: state.shieldedBalance + amount,
        notes: [
          ...state.notes,
          { id: `note_${Math.random().toString(36).substr(2, 9)}`, amount, asset, status: 'active' }
        ],
      }));
    } catch (e) {
      console.error("Deposit failed", e);
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

      const circuitInput = {
         // This would gather real UXTO notes
         in_amount: [amount, 0], 
         out_amount: [amount, 0],
         // ...
      };

      const result = await runWorkerTask('PROVE_TRANSFER', { amount, asset, recipient, circuitInput });
      console.log('Proof generated:', result);

      // Submit to Relayer
      const relayRes = await fetch('http://localhost:3002/relay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tx: "mock_base64_xdr_transfer"
        })
      });
      const relayData = await relayRes.json();
      if (!relayData.success) throw new Error(relayData.error);

      set((state) => ({
        shieldedBalance: state.shieldedBalance - amount,
      }));
    } catch (e) {
      console.error("Transfer failed", e);
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

      const circuitInput = {
        // Real inputs
      };

      const result = await runWorkerTask('PROVE_WITHDRAW', { amount, asset, destination, circuitInput });
      console.log('Proof generated:', result);

      // Submit to Relayer
      const relayRes = await fetch('http://localhost:3002/relay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tx: "mock_base64_xdr_withdraw"
        })
      });
      const relayData = await relayRes.json();
      if (!relayData.success) throw new Error(relayData.error);

      set((state) => ({
        shieldedBalance: state.shieldedBalance - amount,
      }));
    } catch (e) {
      console.error("Withdraw failed", e);
    } finally {
      set({ isProving: false });
    }
  }
}));
