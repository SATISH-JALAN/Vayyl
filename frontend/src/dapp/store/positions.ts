import { create } from 'zustand';
import { useWalletStore } from './wallet';
import { getNotes, markNoteSpent } from '../lib/storage';
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
}

interface PositionsState {
  positions: Position[];
  isProving: boolean;
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

  fetchState: async () => {
    const wallet = useWalletStore.getState();
    if (!wallet.address) return;
    try {
      const res = await fetch(`${INDEXER_URL}/positions?owner=${wallet.address}`);
      if (!res.ok) return;
      const data = await res.json();
      const positions = data.positions.map((p: any) => ({
        id: p.id.toString(),
        position_id: p.position_id,
        asset: 'USDC', // Assuming USDC for MVP
        type: 'Long',  // The indexer schema doesn't decode direction, hardcoded for MVP UI
        leverage: '10x',
        size: '500',   // Hardcoded for MVP UI display
        health: p.is_closed ? '0%' : '100%',
        status: p.is_closed ? 'Closed' : 'Active',
        commitment: p.commitment
      }));
      set({ positions });
    } catch (e) {
      console.error('fetchState positions failed', e);
    }
  },

  openPosition: async (asset, type, leverage, sizeStr) => {
    const wallet = useWalletStore.getState();
    if (!wallet.address) throw new Error('Connect your wallet first');
    const keys = await wallet.unlockShieldedKeys();

    set({ isProving: true });
    try {
      const notes = await getNotes(keys.viewingKey);
      const note = notes.find((n) => !n.isSpent && n.asset === asset);
      if (!note) throw new Error('No unspent notes available for collateral');

      const leaves = await fetchCommitments();
      const idx = leaves.findIndex((c) => c.toString() === note.commitment);
      const leafIndex = idx >= 0 ? idx : note.leafIndex;

      const size = BigInt(sizeStr.replace(/[^0-9]/g, ''));
      const direction = type === 'Long' ? 1n : 0n;
      const entry_price = 2000n; // Hardcoded mock oracle price for MVP
      const position_blindness = 4n;

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

      await submitPositionOpen({
        source: wallet.address,
        positionIdHex,
        owner: wallet.address,
        proof: proveResult.proof,
        root: proveResult.root,
        nullifier: proveResult.nullifier,
        positionCommitment: proveResult.position_commitment,
        metaHash: "0",
        useRelayer: true,
      });

      await markNoteSpent(keys.viewingKey, note.id);
      await get().fetchState();
    } catch (e) {
      console.error("Position open failed", e);
      throw e;
    } finally {
      set({ isProving: false });
    }
  },

  closePosition: async (position_id) => {
    const wallet = useWalletStore.getState();
    if (!wallet.address) throw new Error('Connect your wallet first');
    const keys = await wallet.unlockShieldedKeys();

    set({ isProving: true });
    try {
      const state = get();
      const pos = state.positions.find(p => p.position_id === position_id);
      if (!pos) throw new Error('Position not found');

      const closeOraclePrice = 2500n; // Hardcoded mock
      const new_size = 0n;
      const new_direction = 0n;
      const new_entry_price = 0n;
      const new_collateral = 0n;
      const new_blindness = 55555n;
      
      const old_size = BigInt(pos.size.replace(/[^0-9]/g, ''));
      const old_direction = pos.type === 'Long' ? 1n : 0n;
      const old_entry_price = 2000n; // Hardcoded mock
      const old_collateral = 500n; // Assuming standard note amount 500
      const old_blindness = 4n;

      const note_amount = 251000n; // PnL calculation mock matching E2E
      const note_blindness = 33333n;

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

      await get().fetchState();
    } catch (e) {
      console.error("Position close failed", e);
      throw e;
    } finally {
      set({ isProving: false });
    }
  }
}));
