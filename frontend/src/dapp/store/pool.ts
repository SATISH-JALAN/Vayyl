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
  submitDepositV2,
  submitWithdrawV2,
  submitRageQuitV2,
  submitTransferV2,
  fetchTransfers,
  fetchCommitments,
  fetchSpentNullifiers,
  computeWithdrawBinding,
  fetchV2AspLeafIndex,
  fetchV2AspLeaves,
  enrollV2AspLeaf,
  assertV2ServicesReady,
  V2_DENOMINATION_STROOPS,
  V2_DENOMINATION_XLM,
  V2_POOL_ID,
} from '../lib/pool';
import {
  addNote,
  getNotes,
  markNoteSpent,
  getActivity,
  addActivity,
  getScanCursor,
  setScanCursor,
  type ShieldedNote,
  type ActivityEvent,
} from '../lib/storage';
import { decodeShieldedAddress } from '../lib/address';
import type { DiscoveredNote } from '../lib/transfer';
import { poseidon2Hash2 } from '../lib/poseidon';

interface PoolState {
  shieldedBalance: number;
  notes: ShieldedNote[];
  activity: ActivityEvent[];
  isProving: boolean;
  status: string | null;
  aspLeaf: string | null;
  aspEligible: boolean | null;
  aspLeafIndex: number | null;
  fetchState: () => Promise<void>;
  deposit: () => Promise<void>;
  withdraw: (destination: string) => Promise<void>;
  ragequit: (destination: string) => Promise<void>;
  /**
   * Send one shielded note to a Vayyl shielded address. Amount and asset are
   * fixed by the pool denomination, so the recipient is the only parameter.
   */
  transfer: (recipientAddress: string) => Promise<void>;
  /** Claim payments sent to us since the last scan. */
  scanIncoming: () => Promise<void>;
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
  aspLeaf: null,
  aspEligible: null,
  aspLeafIndex: null,

  fetchState: async () => {
    const keys = useWalletStore.getState().keys;
    if (!keys) return;
    try {
      const [spent, identity] = await Promise.all([
        fetchSpentNullifiers().catch(() => new Set<string>()),
        runWorkerTask('PREPARE_V2_NOTE', { privKey: keys.spendKey.toString(), blindness: '0' }),
      ]);
      const aspLeafIndex = await fetchV2AspLeafIndex(identity.aspLeaf);

      // Claim any payments sent to us since the last scan. Failing here must not
      // break the rest of the view — an unreachable indexer should not make a
      // wallet look empty.
      try {
        await get().scanIncoming();
      } catch (e) {
        console.error('incoming-note scan failed', e);
      }

      const notes = (await getNotes(keys.viewingKey)).filter(
        (note) => note.protocol === 'v2' && note.pool === V2_POOL_ID,
      );
      // Reconcile spent status against on-chain nullifiers.
      for (const n of notes) {
        if (!n.isSpent && spent.has(n.nullifier)) {
          n.isSpent = true;
          await markNoteSpent(keys.viewingKey, n.id);
        }
      }
      const active = notes.filter((n) => !n.isSpent);

      // Build the activity feed from notes; withdraws and outgoing transfers
      // come from the explicit log (a spend only flips a flag on the note).
      // A note we RECEIVED is an incoming Transfer, not a Deposit — notes
      // written before shielded transfer existed have no `source` and were all
      // deposits.
      const deposits: ActivityEvent[] = notes.map((n) => ({
        id: n.txHash ?? n.commitment,
        type: n.source === 'received' ? 'Transfer' : 'Deposit',
        amount: n.amount,
        asset: n.asset,
        protocol: 'v2',
        pool: V2_POOL_ID,
        txHash: n.txHash,
        timestamp: n.createdAt,
      }));
      const logged = (await getActivity(keys.viewingKey)).filter(
        (event) => event.protocol === 'v2' && event.pool === V2_POOL_ID,
      );
      const activity = [...deposits, ...logged].sort((a, b) => b.timestamp - a.timestamp);

      set({
        notes,
        activity,
        shieldedBalance: active.reduce((s, n) => s + n.amount, 0),
        aspLeaf: identity.aspLeaf,
        aspEligible: aspLeafIndex !== null,
        aspLeafIndex,
      });
    } catch (e) {
      console.error('fetchState failed', e);
    }
  },

  deposit: async () => {
    const wallet = useWalletStore.getState();
    if (!wallet.address) throw new Error('Connect your wallet first');
    const keys = await wallet.unlockShieldedKeys();

    set({ isProving: true, status: 'Preparing workspace…' });
    try {
      const identity = await runWorkerTask('PREPARE_V2_NOTE', {
        privKey: keys.spendKey.toString(),
        blindness: '0',
      });
      let aspLeafIndex = await fetchV2AspLeafIndex(identity.aspLeaf);
      set({ aspLeaf: identity.aspLeaf, aspEligible: aspLeafIndex !== null, aspLeafIndex });
      let aspLeaves: string[];
      if (aspLeafIndex === null) {
        set({ status: 'Preparing private workspace…' });
        const enrollment = await enrollV2AspLeaf(identity.aspLeaf);
        aspLeafIndex = enrollment.leafIndex;
        aspLeaves = enrollment.leaves;
        set({ aspEligible: true, aspLeafIndex });
      } else {
        aspLeaves = await fetchV2AspLeaves();
      }

      const blindness = randomFieldElement().toString();
      set({ status: 'Generating fixed-note deposit proof…' });
      const proveResult = await runWorkerTask('PROVE_DEPOSIT_V2', {
        privKey: keys.spendKey.toString(),
        blindness,
        aspLeafIndex,
        aspLeaves,
      });

      set({ status: 'Submitting 1 XLM deposit…' });
      const txHash = await submitDepositV2({
        depositor: wallet.address,
        proof: proveResult.proof,
        commitment: proveResult.commitment,
        aspRoot: proveResult.aspRoot,
      });

      // Persist the spendable note. leafIndex is corrected from the indexer on
      // the next fetchState (event carries the true index).
      const commitment: string = proveResult.commitment;
      const existing = (await getNotes(keys.viewingKey)).filter((note) => note.protocol === 'v2');
      await addNote(keys.viewingKey, {
        id: commitment,
        amount: V2_DENOMINATION_XLM,
        amountStroops: V2_DENOMINATION_STROOPS.toString(),
        asset: 'XLM',
        protocol: 'v2',
        pool: V2_POOL_ID,
        commitment,
        nullifier: proveResult.nullifier,
        pubX: proveResult.pubX,
        pubY: proveResult.pubY,
        blindness,
        leafIndex: existing.length,
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

  withdraw: async (destination: string) => {
    const wallet = useWalletStore.getState();
    if (!wallet.address) throw new Error('Connect your wallet first');
    const keys = await wallet.unlockShieldedKeys();

    set({ isProving: true, status: 'Selecting note…' });
    try {
      const notes = await getNotes(keys.viewingKey);
      const note = notes.find((n) => !n.isSpent && n.protocol === 'v2' && n.pool === V2_POOL_ID);
      if (!note) {
        throw new Error('No unspent 1 XLM note was found for this wallet.');
      }

      set({ status: 'Checking destination and relayer…' });
      await assertV2ServicesReady(destination);
      const withdrawBinding = await computeWithdrawBinding(destination, V2_DENOMINATION_STROOPS);

      // Reconstruct the tree from the indexer's ordered commitments.
      set({ status: 'Reconstructing Merkle path…' });
      const leaves = await fetchCommitments();
      // Locate this note's leaf index by matching its commitment.
      const idx = leaves.findIndex((c) => c.toString() === note.commitment);
      if (idx < 0) throw new Error('This note is not indexed yet. Wait a few seconds and retry.');

      set({ status: 'Generating withdraw proof…' });
      const proveResult = await runWorkerTask('PROVE_WITHDRAW_V2', {
        blindness: note.blindness,
        privKey: keys.spendKey.toString(),
        commitment: note.commitment,
        leafIndex: idx,
        withdrawBinding,
        leaves: leaves.map((c) => c.toString()),
      });

      set({ status: 'Submitting withdrawal…' });
      const txHash = await submitWithdrawV2({
        proof: proveResult.proof,
        nullifier: proveResult.nullifier,
        recipient: destination,
        root: proveResult.root,
      });

      await markNoteSpent(keys.viewingKey, note.id);
      await addActivity(keys.viewingKey, {
        id: txHash,
        type: 'Withdraw',
        amount: note.amount,
        asset: 'XLM',
        protocol: 'v2',
        pool: V2_POOL_ID,
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

  /**
   * Public exit. Releases a note without an anonymity set, by publishing the
   * commitment and letting the pool confirm inclusion by direct lookup.
   *
   * This exists because `withdraw` and `transfer` both refuse a nullifier the
   * ASP blocklist has denied. With no other route out, a delisted depositor's
   * funds would be stuck permanently — confiscation by omission, and a worse
   * outcome than whatever the blocklist was guarding against. Rage-quit trades
   * the user's privacy for their liquidity: the deposit and the payout address
   * are linked on the ledger forever, which is exactly why the compliance
   * property survives. It denies an anonymous exit, not an exit.
   *
   * Deliberately NOT gated on being blocked. Checking would mean asking the
   * blocklist whether it is refusing you, from a client that has already been
   * refused; anyone willing to give up their privacy may take this route.
   */
  ragequit: async (destination: string) => {
    const wallet = useWalletStore.getState();
    if (!wallet.address) throw new Error('Connect your wallet first');
    const keys = await wallet.unlockShieldedKeys();

    set({ isProving: true, status: 'Selecting note…' });
    try {
      const notes = await getNotes(keys.viewingKey);
      const note = notes.find((n) => !n.isSpent && n.protocol === 'v2' && n.pool === V2_POOL_ID);
      if (!note) throw new Error('No unspent 1 XLM note was found for this wallet.');

      set({ status: 'Checking destination and relayer…' });
      await assertV2ServicesReady(destination);
      // Same binding as withdraw: the pool recomputes it from (recipient,
      // amount), so a relayer cannot redirect the payout.
      const exitBinding = await computeWithdrawBinding(destination, V2_DENOMINATION_STROOPS);

      // No Merkle path and no indexer dependency — the commitment is public and
      // the pool looks it up directly. That matters here more than anywhere
      // else: this is the escape hatch, so it must not depend on the indexer
      // being up.
      set({ status: 'Generating exit proof…' });
      const proveResult = await runWorkerTask('PROVE_RAGEQUIT_V2', {
        blindness: note.blindness,
        privKey: keys.spendKey.toString(),
        commitment: note.commitment,
        exitBinding,
      });

      set({ status: 'Submitting public exit…' });
      const txHash = await submitRageQuitV2({
        proof: proveResult.proof,
        commitment: proveResult.commitment,
        nullifier: proveResult.nullifier,
        recipient: destination,
      });

      await markNoteSpent(keys.viewingKey, note.id);
      await addActivity(keys.viewingKey, {
        id: txHash,
        type: 'RageQuit',
        amount: note.amount,
        asset: 'XLM',
        protocol: 'v2',
        pool: V2_POOL_ID,
        txHash,
        timestamp: Date.now(),
      });
      set({ status: `Public exit confirmed: ${txHash}` });
      useToastStore.getState().addToast(
        `Public exit confirmed. This withdrawal is publicly linked to your deposit.`,
        'success',
      );
      await get().fetchState();
    } catch (e: any) {
      set({ status: `Public exit failed: ${e.message}` });
      useToastStore.getState().addToast(`Public exit failed: ${e.message}`, 'error');
      throw e;
    } finally {
      set({ isProving: false });
    }
  },

  transfer: async (recipientAddress: string) => {
    const wallet = useWalletStore.getState();
    if (!wallet.address) throw new Error('Connect your wallet first');
    const keys = await wallet.unlockShieldedKeys();

    set({ isProving: true, status: 'Checking recipient…' });
    try {
      // Decode first: every failure mode here is one the user can fix, and a
      // malformed key would otherwise produce a note nobody can ever open.
      const recipient = decodeShieldedAddress(recipientAddress);

      set({ status: 'Selecting note…' });
      const notes = await getNotes(keys.viewingKey);
      const note = notes.find((n) => !n.isSpent && n.protocol === 'v2' && n.pool === V2_POOL_ID);
      if (!note) throw new Error('No unspent 1 XLM note was found for this wallet.');

      set({ status: 'Reconstructing Merkle path…' });
      const leaves = await fetchCommitments();
      const idx = leaves.findIndex((c) => c.toString() === note.commitment);
      if (idx < 0) throw new Error('This note is not indexed yet. Wait a few seconds and retry.');

      // The ephemeral scalar, the shared secret and the output blindness are all
      // produced inside the worker and never leave it.
      set({ status: 'Generating transfer proof…' });
      const proveResult = await runWorkerTask('PROVE_TRANSFER_V2', {
        privKey: keys.spendKey.toString(),
        blindness: note.blindness,
        commitment: note.commitment,
        leafIndex: idx,
        leaves: leaves.map((c) => c.toString()),
        recipientPubX: recipient.pubX.toString(),
        recipientPubY: recipient.pubY.toString(),
      });

      // Relayed, never wallet-signed: the sender's Stellar address must not
      // appear on the ledger, or the payment is not private.
      set({ status: 'Submitting transfer…' });
      const txHash = await submitTransferV2({
        proof: proveResult.proof,
        nullifier: proveResult.nullifier,
        commitment: proveResult.commitment,
        ephemeralX: proveResult.ephemeralX,
        ephemeralY: proveResult.ephemeralY,
        root: proveResult.root,
      });

      await markNoteSpent(keys.viewingKey, note.id);
      await addActivity(keys.viewingKey, {
        id: txHash,
        type: 'Transfer',
        amount: note.amount,
        asset: 'XLM',
        protocol: 'v2',
        pool: V2_POOL_ID,
        txHash,
        timestamp: Date.now(),
      });
      set({ status: `Transfer confirmed: ${txHash}` });
      useToastStore.getState().addToast(`Transfer sent! Transaction: ${txHash.slice(0, 8)}…`, 'success');
      await get().fetchState();
    } catch (e: any) {
      set({ status: `Transfer failed: ${e.message}` });
      useToastStore.getState().addToast(`Transfer failed: ${e.message}`, 'error');
      throw e;
    } finally {
      set({ isProving: false });
    }
  },

  scanIncoming: async () => {
    const keys = useWalletStore.getState().keys;
    if (!keys) return;

    // Scanning costs a scalar multiplication and two hashes per event, so it is
    // incremental: only events at or after the cursor are re-examined. Without
    // this every fetchState would rescan the entire history.
    const cursor = await getScanCursor(keys.viewingKey);
    const transfers = await fetchTransfers(cursor);
    if (transfers.length === 0) return;

    const { notes: discovered } = await runWorkerTask('SCAN_TRANSFERS_V2', {
      spendKey: keys.spendKey.toString(),
      pubX: keys.pubX.toString(),
      pubY: keys.pubY.toString(),
      transfers,
    });

    for (const found of discovered as DiscoveredNote[]) {
      await addNote(keys.viewingKey, {
        id: found.commitment,
        amount: V2_DENOMINATION_XLM,
        amountStroops: V2_DENOMINATION_STROOPS.toString(),
        asset: 'XLM',
        protocol: 'v2',
        pool: V2_POOL_ID,
        commitment: found.commitment,
        // The nullifier is OUR nullifier for this note: Poseidon2(commitment,
        // spendKey). Only we can compute it, which is why only we can spend it.
        nullifier: (await poseidon2Hash2(BigInt(found.commitment), keys.spendKey)).toString(),
        pubX: keys.pubX.toString(),
        pubY: keys.pubY.toString(),
        blindness: found.blindness,
        leafIndex: found.leafIndex,
        isSpent: false,
        source: 'received',
        ephemeralX: found.ephemeralX,
        ephemeralY: found.ephemeralY,
        createdAt: Date.now(),
        txHash: found.txHash,
      });
    }

    const highest = transfers.reduce((max, t) => Math.max(max, t.ledgerSequence ?? 0), cursor);
    await setScanCursor(keys.viewingKey, highest);
  },
}));
