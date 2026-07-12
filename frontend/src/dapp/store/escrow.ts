import { create } from 'zustand';
const runWorkerTask = (type: string, payload: any): Promise<any> => {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../lib/proof-worker.ts', import.meta.url), {
      type: 'module',
    });
    const taskId = Math.random().toString(36).substring(7);
    
    worker.onmessage = (e: any) => {
      if (e.data.id === taskId) {
        if (e.data.status === 'success') resolve(e.data.result);
        else reject(new Error(e.data.error));
        worker.terminate();
      }
    };
    worker.postMessage({ type, payload, id: taskId });
  });
};
import { useToastStore } from './toast';
import { NETWORK_PASSPHRASE } from '../lib/network';

// Stub for now
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org";

export interface HiddenOrder {
  order_id: string; // hex
  trigger_price: string;
  order_direction: 'LONG' | 'SHORT';
  escrow_amount: string;
  status: 'active' | 'executed' | 'cancelled';
}

export interface AgenticQuest {
  quest_id: string; // hex
  reward_amount: string;
  task_data: string; // Mock descriptive data
  status: 'active' | 'claimed';
}

interface EscrowState {
  orders: HiddenOrder[];
  quests: AgenticQuest[];
  isProving: boolean;
  status: string | null;

  fetchState: () => Promise<void>;
  commitOrder: (escrowAmount: string, triggerPrice: string, direction: 'LONG' | 'SHORT') => Promise<void>;
  cancelOrder: (orderId: string) => Promise<void>;
  createQuest: (rewardAmount: string, taskData: string) => Promise<void>;
  claimQuest: (questId: string) => Promise<void>;
}

const ORDER_REGISTRY_ID = process.env.NEXT_PUBLIC_ORDER_REGISTRY;
const AGENTIC_HUB_ID = process.env.NEXT_PUBLIC_AGENTIC_HUB;
const POOL_ID = process.env.NEXT_PUBLIC_POOL_XLM; // Using XLM pool for MVP

// Simple mock cache for local development without an indexer
const getLocalCache = (key: string) => {
  if (typeof window === 'undefined') return [];
  const stored = localStorage.getItem(key);
  return stored ? JSON.parse(stored) : [];
};

const setLocalCache = (key: string, data: any) => {
  if (typeof window !== 'undefined') {
    localStorage.setItem(key, JSON.stringify(data));
  }
};

export const useEscrowStore = create<EscrowState>((set, get) => ({
  orders: [],
  quests: [],
  isProving: false,
  status: null,

  fetchState: async () => {
    // In a production app, we would query an indexer for the user's active orders and quests.
    // For this MVP, we load from localStorage cache.
    set({
      orders: getLocalCache('vayyl_orders'),
      quests: getLocalCache('vayyl_quests')
    });
  },

  commitOrder: async (escrowAmount, triggerPrice, direction) => {
    set({ isProving: true, status: 'Committing order...' });
    try {
      if (!ORDER_REGISTRY_ID) throw new Error("Order registry not configured");
      
      const order_id = Array.from(window.crypto.getRandomValues(new Uint8Array(32)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      
      // We don't generate a proof here, we just compute the commitment locally.
      // But the frontend usually doesn't have the WASM circuits loaded outside the worker.
      // We'll use the worker to generate a dummy proof just to get the commitment from Poseidon2.
      // Actually, since PROVE_HIDDEN_ORDER_TRIGGER computes commitment, we can just use that
      // with dummy oracle prices, OR we can add a simple COMPUTE_COMMITMENT task.
      // For now, we will just simulate success and add to local cache for UI display.
      
      // Simulate network delay
      await new Promise(r => setTimeout(r, 1000));

      const newOrder: HiddenOrder = {
        order_id,
        trigger_price: triggerPrice,
        order_direction: direction,
        escrow_amount: escrowAmount,
        status: 'active'
      };

      const newOrders = [newOrder, ...get().orders];
      setLocalCache('vayyl_orders', newOrders);
      set({ orders: newOrders });

      useToastStore.getState().addToast(`Order ${order_id.slice(0,8)} committed`, 'success');
    } catch (e: any) {
      console.error(e);
      useToastStore.getState().addToast(`Commit order failed: ${e.message}`, 'error');
    } finally {
      set({ isProving: false, status: null });
    }
  },

  cancelOrder: async (orderId) => {
    set({ isProving: true, status: 'Cancelling order...' });
    try {
      await new Promise(r => setTimeout(r, 1000));
      
      const newOrders = get().orders.map(o => 
        o.order_id === orderId ? { ...o, status: 'cancelled' as const } : o
      );
      
      setLocalCache('vayyl_orders', newOrders);
      set({ orders: newOrders });
      useToastStore.getState().addToast('Order cancelled', 'success');
    } catch (e: any) {
      console.error(e);
      useToastStore.getState().addToast(`Cancel order failed: ${e.message}`, 'error');
    } finally {
      set({ isProving: false, status: null });
    }
  },

  createQuest: async (rewardAmount, taskData) => {
    set({ isProving: true, status: 'Creating quest...' });
    try {
      const quest_id = Array.from(window.crypto.getRandomValues(new Uint8Array(32)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
        
      await new Promise(r => setTimeout(r, 1000));

      const newQuest: AgenticQuest = {
        quest_id,
        reward_amount: rewardAmount,
        task_data: taskData,
        status: 'active'
      };

      const newQuests = [newQuest, ...get().quests];
      setLocalCache('vayyl_quests', newQuests);
      set({ quests: newQuests });

      useToastStore.getState().addToast(`Quest created for ${rewardAmount} XLM`, 'success');
    } catch (e: any) {
      console.error(e);
      useToastStore.getState().addToast(`Create quest failed: ${e.message}`, 'error');
    } finally {
      set({ isProving: false, status: null });
    }
  },

  claimQuest: async (questId) => {
    set({ isProving: true, status: 'Generating ZK proof...' });
    try {
      // Simulate proof generation
      const bid_price = "100";
      const bid_size = "50";
      const salt = "987654321";

      const proofRes = await runWorkerTask('PROVE_SEALED_ORDER', {
        bid_price,
        bid_size,
        salt
      });
      
      set({ status: 'Submitting claim...' });
      await new Promise(r => setTimeout(r, 1500));

      const newQuests = get().quests.map(q => 
        q.quest_id === questId ? { ...q, status: 'claimed' as const } : q
      );
      
      setLocalCache('vayyl_quests', newQuests);
      set({ quests: newQuests });

      useToastStore.getState().addToast('Quest claimed successfully!', 'success');
    } catch (e: any) {
      console.error(e);
      useToastStore.getState().addToast(`Claim quest failed: ${e.message}`, 'error');
    } finally {
      set({ isProving: false, status: null });
    }
  }

}));
