// ============================================================
// Pool store — the ONE real vertical: deposit → withdraw  (Tasks 6.2–6.4, 6.3)
// ============================================================
// Orchestrates: derive shielded keys -> build real inputs -> prove in the Web
// Worker -> assemble/sign/submit a real Soroban tx -> persist the spendable note.
// Transfer, positions, and orders are roadmap surfaces and are NOT touched here.

import { create } from 'zustand';
import { useWalletStore } from './wallet';
import { useToastStore } from './toast';
import {
  randomFieldElement,
} from '../lib/poseidon';
import {
  submitDeposit,
  submitWithdraw,
  fetchCommitments,
  fetchSpentNullifiers,
  computeWithdrawBinding,
} from '../lib/pool';
import { xlmToStroops } from '../lib/amount';
import {
  addNote,
  getNotes,
  markNoteSpent,
  saveNotes,
  getActivity,
  addActivity,
  type ShieldedNote,
  type ActivityEvent,
} from '../lib/storage';

interface PoolState {
  shieldedBalance: number;
  notes: ShieldedNote[];
  activity: ActivityEvent[];
  isProving: boolean;
  status: string | null;
  fetchState: () => Promise<void>;
  deposit: (amount: string, asset: string) => Promise<void>;
  withdraw: (amount: string, asset: string, destination: string) => Promise<void>;
  transfer: (amount: number, asset: string, recipient: string) => Promise<void>;
}

const runWorkerTask = (type: string, payload: any): Promise<any> =>
  new Promise((resolve, reject) => {
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

export const usePoolStore = create<PoolState>((set, get) => ({
  shieldedBalance: 0,
  notes: [],
  activity: [],
  isProving: false,
  status: null,

  fetchState: async () => {
    const keys = useWalletStore.getState().keys;
    if (!keys) return;
    try {
      const [spent] = await Promise.all([fetchSpentNullifiers().catch(() => new Set<string>())]);
      const notes = await getNotes(keys.viewingKey);
      // Reconcile spent status against on-chain nullifiers.
      let changed = false;
      for (const n of notes) {
        if (!n.isSpent && spent.has(n.nullifier)) {
          n.isSpent = true;
          changed = true;
        }
      }
      if (changed) await saveNotes(keys.viewingKey, notes);
      const active = notes.filter((n) => !n.isSpent);

      // Build the activity feed: every note is a past Deposit; withdraws/transfers
      // come from the explicit log (a spend only flips a flag on the note).
      const deposits: ActivityEvent[] = notes.map((n) => ({
        id: n.txHash ?? n.commitment,
        type: 'Deposit',
        amount: n.amount,
        asset: n.asset,
        txHash: n.txHash,
        timestamp: n.createdAt,
      }));
      const logged = await getActivity(keys.viewingKey);
      const activity = [...deposits, ...logged].sort((a, b) => b.timestamp - a.timestamp);

      set({
        notes,
        activity,
        shieldedBalance: active.reduce((s, n) => s + n.amount, 0),
      });
    } catch (e) {
      console.error('fetchState failed', e);
    }
  },

  deposit: async (amount: string, asset: string) => {
    const wallet = useWalletStore.getState();
    if (!wallet.address) throw new Error('Connect your wallet first');
    const keys = await wallet.unlockShieldedKeys();

    const amountStroops = xlmToStroops(amount);
    const amountXlm = Number(amount);
    set({ isProving: true, status: 'Generating deposit proof…' });
    try {
      const blindness = randomFieldElement().toString();
      const proveResult = await runWorkerTask('PROVE_DEPOSIT', {
        amount: amountStroops.toString(),
        pubX: keys.pubX.toString(),
        pubY: keys.pubY.toString(),
        blindness,
      });

      // ASP is enforced on-chain: the deposit reverts with Error #8 unless this
      // key's leaf is in the ASP tree. Surface the leaf so an admin can insert it
      // (scripts/asp_insert.js) — indispensable for diagnosing an Error #8.
      console.info(
        '[Vayyl] ASP leaf for this key:', proveResult.aspLeaf,
        '\n  pubX:', keys.pubX.toString(),
        '\n  pubY:', keys.pubY.toString(),
        '\n  asp_root:', proveResult.aspRoot,
      );

      set({ status: 'Submitting transaction…' });
      const txHash = await submitDeposit({
        depositor: wallet.address,
        proof: proveResult.proof,
        commitment: proveResult.commitment,
        publicAmount: amountStroops,
        // Must match the proof's asp_root public signal exactly (derived in the
        // worker), and be a root the ASP contract has produced — else the on-chain
        // is_known_root gate rejects the deposit (Error #8).
        aspRoot: proveResult.aspRoot,
        asset,
      });

      // Persist the spendable note. leafIndex is corrected from the indexer on
      // the next fetchState (event carries the true index).
      const commitment: string = proveResult.commitment;
      const nullifier = await import('../lib/poseidon').then((m) =>
        m.computeNullifier(BigInt(commitment), keys.spendKey),
      );
      const existing = await getNotes(keys.viewingKey);
      await addNote(keys.viewingKey, {
        id: commitment,
        amount: amountXlm,
        amountStroops: amountStroops.toString(),
        asset,
        commitment,
        nullifier: nullifier.toString(),
        pubX: keys.pubX.toString(),
        pubY: keys.pubY.toString(),
        blindness,
        leafIndex: existing.filter((n) => n.asset === asset).length, // provisional
        isSpent: false,
        createdAt: Date.now(),
        txHash,
      });

      set({ status: `Deposit confirmed: ${txHash}` });
      useToastStore.getState().addToast(`Deposit confirmed! Transaction: ${txHash.slice(0, 8)}…`, 'success');
      await get().fetchState();
    } catch (e: any) {
      set({ status: `Deposit failed: ${e.message}` });
      useToastStore.getState().addToast(`Deposit failed: ${e.message}`, 'error');
      throw e;
    } finally {
      set({ isProving: false });
    }
  },

  withdraw: async (amount: string, asset: string, destination: string) => {
    const wallet = useWalletStore.getState();
    if (!wallet.address) throw new Error('Connect your wallet first');
    const keys = await wallet.unlockShieldedKeys();

    set({ isProving: true, status: 'Selecting note…' });
    try {
      const notes = await getNotes(keys.viewingKey);
      // Minimal note selection: one unspent note of exactly `amount` (single-note
      // withdraw — the MVP vertical; multi-note aggregation is post-MVP).
      const requestedStroops = xlmToStroops(amount);
      const note = notes.find((n) =>
        !n.isSpent &&
        n.asset === asset &&
        BigInt(n.amountStroops ?? xlmToStroops(String(n.amount))) === requestedStroops,
      );
      if (!note) {
        throw new Error(
          `No single unspent ${asset} note of ${amount} found. Vault v1 withdraws one whole note.`,
        );
      }

      const fee = 0n;
      const publicAmount = BigInt(note.amountStroops ?? xlmToStroops(String(note.amount)));
      const withdrawBinding = await computeWithdrawBinding(destination, publicAmount);

      // Reconstruct the tree from the indexer's ordered commitments.
      set({ status: 'Reconstructing Merkle path…' });
      const leaves = await fetchCommitments();
      // Locate this note's leaf index by matching its commitment.
      const idx = leaves.findIndex((c) => c.toString() === note.commitment);
      const leafIndex = idx >= 0 ? idx : note.leafIndex;

      set({ status: 'Generating withdraw proof…' });
      const proveResult = await runWorkerTask('PROVE_WITHDRAW', {
        amount: publicAmount.toString(),
        pubX: note.pubX,
        pubY: note.pubY,
        blindness: note.blindness,
        privKey: keys.spendKey.toString(),
        leafIndex,
        publicAmount: publicAmount.toString(),
        fee: fee.toString(),
        withdrawBinding,
        leaves: leaves.map((c) => c.toString()),
      });

      set({ status: 'Submitting to Mainnet…' });
      const txHash = await submitWithdraw({
        source: wallet.address,
        proof: proveResult.proof,
        nullifier: proveResult.nullifier,
        publicAmount,
        recipient: destination,
        root: proveResult.root,
        fee,
        relayer: wallet.address,
        asset,
        useRelayer: false,
      });

      await markNoteSpent(keys.viewingKey, note.id);
      await addActivity(keys.viewingKey, {
        id: txHash,
        type: 'Withdraw',
        amount: note.amount,
        asset,
        txHash,
        timestamp: Date.now(),
      });
      set({ status: `Withdraw confirmed: ${txHash}` });
      useToastStore.getState().addToast(`Withdraw confirmed! Transaction: ${txHash.slice(0, 8)}…`, 'success');
      await get().fetchState();
    } catch (e: any) {
      set({ status: `Withdraw failed: ${e.message}` });
      useToastStore.getState().addToast(`Withdraw failed: ${e.message}`, 'error');
      throw e;
    } finally {
      set({ isProving: false });
    }
  },

  transfer: async () => {
    // Shielded→shielded transfer is the §2 stretch / §7 item 1 — needs the H2
    // circuit fix + transfer inputs. Intentionally not wired in the MVP.
    throw new Error('Transfer is on the roadmap and not enabled in this build.');
  },
}));
