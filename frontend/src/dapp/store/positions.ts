import { create } from 'zustand';
import { useWalletStore } from './wallet';
import { useToastStore } from './toast';
import { getNotes, markNoteSpent, addNote } from '../lib/storage';
import { fetchCommitments } from '../lib/pool';
import { submitPositionOpen, submitPositionClose } from '../lib/position';

export interface Position {
  id: string; // from Indexer
  position_id: string;
  asset: string;
  type: 'Long' | 'Short';
  leverage: string;
  size: string;
  health: string;
  status: 'Active' | 'Closed';
  commitment: string;
  entry_price?: string;
  collateral?: string;
}

interface PositionsState {
  positions: Position[];
  isProving: boolean;
  status: string | null;
  fetchState: () => Promise<void>;
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
        if (e.data.status === 'success') resolve(e.data.result);
        else reject(new Error(e.data.error));
        worker.terminate();
      }
    };
    worker.postMessage({ type, payload, id: taskId });
  });
};

const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || 'http://localhost:3001';

export const usePositionsStore = create<PositionsState>((set, get) => ({
  positions: [],
  isProving: false,
  status: null,

  fetchState: async () => {
    const wallet = useWalletStore.getState();
    if (!wallet.address) return;
    try {
      const res = await fetch(`${INDEXER_URL}/positions?owner=${wallet.address}`);
      if (!res.ok) return;
      const data = await res.json();
      const positions = data.positions.map((p: any) => {
        let entryPrice = '2000';
        let collateral = '1000';
        let isLocallyClosed = false;
        try {
          const localData = localStorage.getItem('vayyl_pos_' + p.position_id);
          if (localData) {
            const parsed = JSON.parse(localData);
            if (parsed.entryPrice) entryPrice = String(parsed.entryPrice);
            if (parsed.collateral) collateral = String(parsed.collateral);
            if (parsed.closed) isLocallyClosed = true;
          }
        } catch (e) {}

        const isEffectivelyClosed = p.is_closed || isLocallyClosed;

        return {
          id: p.id.toString(),
          position_id: p.position_id,
          asset: 'XLM',
          type: p.direction === 1 ? 'Long' : (p.direction === 0 ? 'Short' : 'Long'),
          leverage: '10x', // We don't store leverage directly, just size and collateral
          size: p.size ? p.size.toString() : '500',
          health: isEffectivelyClosed ? '0%' : '100%',
          status: isEffectivelyClosed ? 'Closed' : 'Active',
          commitment: p.commitment,
          entry_price: entryPrice,
          collateral: collateral
        };
      });
      set({ positions });
    } catch (e) {
      console.error('fetchState positions failed', e);
    }
  },

  openPosition: async (asset, type, leverage, sizeStr) => {
    const wallet = useWalletStore.getState();
    if (!wallet.address) throw new Error('Connect your wallet first');
    const keys = await wallet.unlockShieldedKeys();

    set({ isProving: true, status: 'Checking collateral notes…' });
    try {
      const notes = await getNotes(keys.viewingKey);
      const note = notes.find((n) => !n.isSpent && n.asset === asset);
      if (!note) throw new Error('No unspent notes available for collateral');

      const leaves = await fetchCommitments();
      const idx = leaves.findIndex((c) => c.toString() === note.commitment);
      const leafIndex = idx >= 0 ? idx : note.leafIndex;

      const size = BigInt(sizeStr.replace(/[^0-9]/g, ''));
      const direction = type === 'Long' ? 1n : 0n;
      let entry_price = 2000n; // Fallback
      try {
        set({ status: 'Fetching live oracle price…' });
        const priceRes = await fetch(`http://localhost:3003/price/${asset}`);
        if (priceRes.ok) {
          const data = await priceRes.json();
          if (data && typeof data.price === 'number') {
            entry_price = BigInt(data.price);
          }
        }
      } catch (err) {
        console.warn('Oracle adapter unreachable. Falling back to mock price.', err);
      }

      const position_blindness = 4n;

      set({ status: 'Generating position proof…' });
      const proveResult = await runWorkerTask('PROVE_POSITION_OPEN', {
        amount: note.amount.toString(),
        pubX: note.pubX,
        pubY: note.pubY,
        blindness: note.blindness,
        privKey: keys.spendKey.toString(),
        leafIndex,
        leaves: leaves.map(c => c.toString()),
        size: size.toString(),
        direction: direction.toString(),
        entry_price: entry_price.toString(),
        position_blindness: position_blindness.toString(),
        meta_hash: "0",
      });

      const positionIdHex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map(b => b.toString(16).padStart(2, '0')).join('');

      set({ status: 'Submitting position…' });
      await submitPositionOpen({
        source: wallet.address,
        positionIdHex,
        owner: wallet.address,
        proof: proveResult.proof,
        root: proveResult.root,
        nullifier: proveResult.nullifier,
        positionCommitment: proveResult.position_commitment,
        metaHash: "0",
        direction,
        size,
        useRelayer: true,
      });

      try {
        localStorage.setItem(`vayyl_pos_${positionIdHex}`, JSON.stringify({ 
          entryPrice: Number(entry_price),
          collateral: Number(note.amount)
        }));
      } catch (e) {}

      await markNoteSpent(keys.viewingKey, note.id);
      
      set({ status: 'Position opened successfully.' });
      useToastStore.getState().addToast(`Position opened successfully!`, 'success');
      await get().fetchState();
    } catch (e: any) {
      console.error("Position open failed", e);
      set({ status: `Position open failed: ${e.message}` });
      useToastStore.getState().addToast(`Position open failed: ${e.message}`, 'error');
      throw e;
    } finally {
      set({ isProving: false });
    }
  },

  closePosition: async (position_id) => {
    const wallet = useWalletStore.getState();
    if (!wallet.address) throw new Error('Connect your wallet first');
    const keys = await wallet.unlockShieldedKeys();

    set({ isProving: true, status: 'Locating position…' });
    try {
      const state = get();
      const pos = state.positions.find(p => p.position_id === position_id);
      if (!pos) throw new Error('Position not found');

      let closeOraclePrice = 2500n; // Fallback
      try {
        set({ status: 'Fetching live oracle price…' });
        const priceRes = await fetch(`http://localhost:3003/price/${pos.asset}`);
        if (priceRes.ok) {
          const data = await priceRes.json();
          if (data && typeof data.price === 'number') {
            closeOraclePrice = BigInt(data.price);
          }
        }
      } catch (err) {
        console.warn('Oracle adapter unreachable. Falling back to mock price.', err);
      }

      const new_size = 0n;
      const new_direction = 0n;
      const new_entry_price = 0n;
      const new_collateral = 0n;
      const new_blindness = 55555n;
      
      const old_size = BigInt(pos.size.replace(/[^0-9]/g, ''));
      const old_direction = pos.type === 'Long' ? 1n : 0n;
      const old_entry_price = BigInt(pos.entry_price || '2000');
      const old_collateral = BigInt(pos.collateral || '1000');
      const old_blindness = 4n;

      let pnl = 0n;
      if (old_direction === 1n) {
        pnl = old_size * (closeOraclePrice - old_entry_price);
      } else {
        pnl = old_size * (old_entry_price - closeOraclePrice);
      }
      const note_amount = old_collateral + pnl;
      const note_blindness = 33333n;

      set({ status: 'Generating close proof…' });
      const proveResult = await runWorkerTask('PROVE_POSITION_CLOSE', {
        pubX: keys.pubX.toString(),
        pubY: keys.pubY.toString(),
        old_privKey: keys.spendKey.toString(),
        old_position_commitment: pos.commitment,
        new_size: new_size.toString(),
        new_direction: new_direction.toString(),
        new_entry_price: new_entry_price.toString(),
        new_collateral: new_collateral.toString(),
        new_blindness: new_blindness.toString(),
        old_size: old_size.toString(),
        old_direction: old_direction.toString(),
        old_entry_price: old_entry_price.toString(),
        old_collateral: old_collateral.toString(),
        old_blindness: old_blindness.toString(),
        note_amount: note_amount.toString(),
        note_blindness: note_blindness.toString(),
        oracle_price: closeOraclePrice.toString(),
        fee: "0",
        meta_hash: "0", // Should really be computed binding
      });

      set({ status: 'Submitting close transaction…' });
      await submitPositionClose({
        source: wallet.address,
        positionIdHex: pos.position_id,
        proof: proveResult.proof,
        positionNullifier: proveResult.position_nullifier,
        newPositionCommitment: proveResult.new_position_commitment,
        outputNoteCommitment: proveResult.output_note_commitment,
        fee: 0n,
        metaHash: "0",
        useRelayer: true,
      });

      // Save the new note to storage so it shows up in Dashboard
      await addNote(keys.viewingKey, {
        id: proveResult.output_note_commitment.toString(),
        amount: Number(note_amount),
        asset: pos.asset,
        commitment: proveResult.output_note_commitment.toString(),
        nullifier: '0',
        pubX: keys.pubX.toString(),
        pubY: keys.pubY.toString(),
        blindness: note_blindness.toString(),
        leafIndex: -1, // will be synced later
        isSpent: false,
        createdAt: Date.now()
      });

      try {
        const localData = localStorage.getItem(`vayyl_pos_${pos.position_id}`);
        let parsed = localData ? JSON.parse(localData) : {};
        parsed.closed = true;
        localStorage.setItem(`vayyl_pos_${pos.position_id}`, JSON.stringify(parsed));
      } catch (e) {}

      // Optimistic update in Zustand store
      set({ 
        positions: state.positions.map(p => 
          p.position_id === pos.position_id ? { ...p, status: 'Closed', health: '0%' } : p
        )
      });

      set({ status: 'Position closed successfully.' });
      useToastStore.getState().addToast(`Position closed successfully!`, 'success');
      
      // Still fetch state to sync other data, but our optimistic update will protect the status
      get().fetchState().catch(() => {});

    } catch (e: any) {
      console.error("Position close failed", e);
      set({ status: `Position close failed: ${e.message}` });
      useToastStore.getState().addToast(`Position close failed: ${e.message}`, 'error');
      throw e;
    } finally {
      set({ isProving: false });
    }
  }
}));
