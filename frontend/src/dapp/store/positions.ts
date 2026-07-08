import { create } from 'zustand';

export interface Position {
  id: string;
  asset: string;
  type: 'Long' | 'Short';
  leverage: string;
  size: string;
  health: string;
  status: 'Active' | 'Closed';
}

interface PositionsState {
  positions: Position[];
  isProving: boolean;
  openPosition: (asset: string, type: 'Long' | 'Short', leverage: string, size: string) => Promise<void>;
  closePosition: (id: string) => Promise<void>;
}

const runWorkerTask = (type: string, payload: any): Promise<any> => {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../lib/proof-worker.ts', import.meta.url), {
      type: 'module',
    });
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

export const usePositionsStore = create<PositionsState>((set, get) => ({
  positions: [
    { id: 'pos_1', asset: 'USDC/XLM', type: 'Long', leverage: '5x', size: '$12,500', health: '92%', status: 'Active' },
    { id: 'pos_2', asset: 'BTC/USDC', type: 'Short', leverage: '2x', size: '$8,200', health: '85%', status: 'Active' }
  ],
  isProving: false,

  openPosition: async (asset, type, leverage, size) => {
    set({ isProving: true });
    try {
      const result = await runWorkerTask('PROVE_POSITION_OPEN', { asset, type, leverage, size });
      console.log('Proof generated:', result);

      set((state) => ({
        positions: [
          ...state.positions,
          { 
            id: `pos_${Math.random().toString(36).substring(7)}`, 
            asset, 
            type, 
            leverage, 
            size, 
            health: '100%', 
            status: 'Active' 
          }
        ],
      }));
    } catch (e) {
      console.error("Proof failed", e);
      throw e;
    } finally {
      set({ isProving: false });
    }
  },

  closePosition: async (id) => {
    set({ isProving: true });
    try {
      const result = await runWorkerTask('PROVE_POSITION_CLOSE', { id });
      console.log('Proof generated:', result);

      set((state) => ({
        positions: state.positions.map(p => 
          p.id === id ? { ...p, status: 'Closed' as const } : p
        ).filter(p => p.status === 'Active')
      }));
    } catch (e) {
      console.error("Proof failed", e);
      throw e;
    } finally {
      set({ isProving: false });
    }
  }
}));
