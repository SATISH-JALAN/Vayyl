// ============================================================
// Positions store
// ============================================================
// Rewritten for the tiered model. The previous version is worth describing,
// because every one of its defaults was a silent wrong answer:
//
//   let entryPrice = '2000';  // fallback when the indexer had no record
//   let collateral = '1000';
//   const position_blindness = 4n;
//   const note_blindness = 33333n;
//   leverage: '10x',          // hard-coded, never computed
//
// Those were not placeholders in dead code -- they fed the close proof. A
// position whose real entry price was anything other than 2000 would be closed
// against a witness describing a different position, and the proof would fail
// with nothing pointing at the reason. The fixed blindings meant two positions
// by the same wallet produced the SAME commitment, so the second was
// unspendable.
//
// Everything here now comes from one of exactly two places: the chain (via the
// contract or the indexer), or a derivation the circuit shares. Nothing is
// guessed, and where a value is unavailable the operation stops with a sentence
// instead of substituting a number.

import { create } from 'zustand';

import { useWalletStore } from './wallet';
import { useToastStore } from './toast';
import { getNotes, markNoteSpent, addNote } from '../lib/storage';
import { fetchVerifiedCommitments, V2_POOL_ID } from '../lib/pool';
import { keysForNote } from '../lib/legacy-notes';
import {
  fetchLpShares,
  fetchOnChainTiers,
  fetchOraclePrice,
  fetchPositionState,
  fetchVaultState,
  positionsConfigured,
  submitAddLiquidity,
  submitAttestHealth,
  submitPositionClose,
  submitPositionOpen,
  submitRemoveLiquidity,
  tierTableMatches,
  vaultCanCover,
  type VaultState,
} from '../lib/position';
import {
  changeBlindness,
  payoutBlindness,
  positionBlindness,
  positionIdHex,
  randomPositionId,
} from '../lib/position-notes';
import { getTier, leverageAt, priceBounds, settlementPayout, TIERS } from '../lib/tiers';
import { poseidon2Hash2 } from '../lib/poseidon';

const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || 'http://localhost:3001';

export interface Position {
  positionId: string; // 32-byte hex, as the contract stores it
  /**
   * The on-chain position commitment. Displayed so a user can match what the
   * app shows against what the ledger holds without trusting this app's copy.
   */
  commitment: string;
  tierId: number;
  direction: 0 | 1;
  entryPrice: bigint;
  openedAt: number;
  lastHealthTimestamp: number;
  isOpen: boolean;
  /** Settled value at the current price. Null while the price is unknown. */
  currentValue: bigint | null;
  /** The collateral note that funded it, if this browser recorded it. */
  collateralStroops?: bigint;
}

/**
 * A position that has already settled.
 *
 * Unlike `Position`, none of this can be re-read from the chain: closing
 * deletes the position record, so the indexer's copy of the PositionClose
 * event is the only surviving source. The UI must say so — every other number
 * on the page is chain-verified and this one is not, and quietly mixing the two
 * would make the stronger claim on behalf of the weaker data.
 */
export interface ClosedPosition {
  positionId: string;
  tierId: number;
  direction: 0 | 1;
  entryPrice: bigint;
  closePrice: bigint | null;
  payout: bigint | null;
  fee: bigint | null;
  outputNoteCommitment: string | null;
}

interface PositionsState {
  positions: Position[];
  /** Settled positions, from the indexer only. Empty when it is unreachable. */
  history: ClosedPosition[];
  /** True when the indexer did not answer, so `history` means "unknown". */
  historyUnavailable: boolean;
  vault: VaultState | null;
  lpShares: bigint;
  oraclePrice: bigint | null;
  oracleTimestamp: number | null;
  /** Set when the deployed tier table disagrees with this build's. */
  tierMismatch: boolean;
  configured: boolean;
  /**
   * True once a state fetch has completed at least once.
   *
   * Without it the UI cannot tell "the oracle is stale" from "nothing has
   * asked yet", and a null price on first render produced a banner saying the
   * price feed was stale -- on every page load, before a single request had
   * been made. An alarming claim about the protocol is not an acceptable
   * loading state.
   */
  hasFetched: boolean;
  isProving: boolean;
  status: string | null;

  fetchState: () => Promise<void>;
  openPosition: (tierId: number, direction: 0 | 1) => Promise<void>;
  closePosition: (positionId: string) => Promise<void>;
  attestHealth: (positionId: string) => Promise<void>;
  addLiquidity: (amountStroops: bigint) => Promise<void>;
  removeLiquidity: (shares: bigint) => Promise<void>;
}

const runWorkerTask = (type: string, payload: unknown): Promise<any> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../lib/proof-worker.ts', import.meta.url), {
      type: 'module',
    });
    const taskId = Math.random().toString(36).substring(7);
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.id !== taskId) return;
      if (e.data.status === 'success') resolve(e.data.result);
      else reject(new Error(e.data.error));
      worker.terminate();
    };
    worker.onerror = (e) => {
      reject(new Error(e.message || 'Proof worker failed'));
      worker.terminate();
    };
    worker.postMessage({ type, payload, id: taskId });
  });

/**
 * Local record of how a position was funded.
 *
 * Two fields, for two different reasons:
 *
 * - `collateralStroops` lets the UI show the change note's size and lets
 *   recovery re-derive it without a full rescan. Losing it costs convenience
 *   only: `recoverPositionNotes` can still find the payout from public data.
 * - `legacyViewingKey` is load-bearing. A position opened with a note recovered
 *   from the OLD viewing key is committed to that key's public key, so closing
 *   it needs that key. Without this the close would build a witness under the
 *   current identity, produce a commitment that is not the stored one, and fail
 *   the C3 binding with nothing explaining why.
 */
interface LocalPositionRecord {
  collateralStroops: string;
  legacyViewingKey?: string;
}

const recordKey = (positionId: string) => `vayyl_pos_record_${positionId}`;

function rememberPosition(positionId: string, record: LocalPositionRecord) {
  try {
    localStorage.setItem(recordKey(positionId), JSON.stringify(record));
  } catch {
    // A private window with storage blocked. The position still opens.
  }
}

function recallPosition(positionId: string): LocalPositionRecord | undefined {
  try {
    const raw = localStorage.getItem(recordKey(positionId));
    return raw ? (JSON.parse(raw) as LocalPositionRecord) : undefined;
  } catch {
    return undefined;
  }
}

export const usePositionsStore = create<PositionsState>((set, get) => ({
  positions: [],
  history: [],
  historyUnavailable: false,
  vault: null,
  lpShares: 0n,
  oraclePrice: null,
  oracleTimestamp: null,
  tierMismatch: false,
  configured: positionsConfigured(),
  hasFetched: false,
  isProving: false,
  status: null,

  fetchState: async () => {
    const wallet = useWalletStore.getState();
    if (!positionsConfigured()) return;

    // The price, the vault and the tier table are PUBLIC. Gating them on a
    // connected wallet left `oraclePrice` null for every visitor who had not
    // connected yet, and the order panel renders a null price as "the oracle
    // price is stale or unavailable" -- an alarming claim about the protocol
    // when the truth was that nothing had asked. A disconnected visitor should
    // see the real mark price, the real liquidation bounds and the real vault
    // capacity; only their OWN positions and LP shares need an address.
    //
    // Reads are independent and each is allowed to fail on its own. A vault
    // read that times out must not blank the position list, and vice versa --
    // an empty screen reads as "you have nothing", which is a lie.
    const [price, vault, shares, onChainTiers] = await Promise.all([
      fetchOraclePrice(),
      fetchVaultState(),
      wallet.address ? fetchLpShares(wallet.address) : Promise.resolve(0n),
      fetchOnChainTiers(),
    ]);

    set({
      oraclePrice: price?.price ?? null,
      oracleTimestamp: price?.timestamp ?? null,
      vault,
      lpShares: shares ?? 0n,
      tierMismatch: onChainTiers ? !tierTableMatches(onChainTiers) : false,
      hasFetched: true,
    });

    // Positions are per-wallet. Without an address there is nothing to list,
    // and the indexer query below would be meaningless.
    if (!wallet.address) {
      set({ positions: [], history: [], historyUnavailable: false });
      return;
    }

    interface IndexedRow {
      position_id: string;
      is_closed?: boolean;
      tier_id?: number | string | null;
      direction?: number | string | null;
      entry_price?: string | number | null;
      close_price?: string | number | null;
      payout?: string | number | null;
      fee?: string | number | null;
      output_note_commitment?: string | null;
    }

    let rows: IndexedRow[] = [];
    let indexerAnswered = false;
    try {
      const res = await fetch(`${INDEXER_URL}/positions?owner=${wallet.address}`);
      if (res.ok) {
        rows = (await res.json()).positions ?? [];
        indexerAnswered = true;
      }
    } catch {
      // The indexer is a convenience for LISTING open positions, not the source
      // of truth for any of them; every open-position field below is re-read
      // from the chain. History is the one thing it alone can answer.
    }

    const num = (v: unknown): bigint | null =>
      v === null || v === undefined || v === '' ? null : BigInt(v as string);

    set({
      historyUnavailable: !indexerAnswered,
      history: rows
        .filter((r) => r.is_closed)
        .map((r) => ({
          positionId: r.position_id,
          tierId: Number(r.tier_id ?? 0),
          direction: Number(r.direction) === 1 ? 1 : 0,
          entryPrice: num(r.entry_price) ?? 0n,
          closePrice: num(r.close_price),
          payout: num(r.payout),
          fee: num(r.fee),
          outputNoteCommitment: r.output_note_commitment ?? null,
        })),
    });

    const positions: Position[] = [];
    for (const row of rows) {
      if (row.is_closed) continue;
      const onChain = await fetchPositionState(row.position_id);
      if (!onChain) continue; // closed or seized; the chain is authoritative
      const tier = getTier(onChain.tierId);
      positions.push({
        positionId: row.position_id,
        commitment: onChain.commitment,
        tierId: onChain.tierId,
        direction: onChain.direction,
        entryPrice: onChain.entryPrice,
        openedAt: onChain.openedAt,
        lastHealthTimestamp: onChain.lastHealthTimestamp,
        isOpen: true,
        currentValue: price
          ? settlementPayout(tier, onChain.direction, onChain.entryPrice, price.price)
          : null,
        collateralStroops: (() => {
          const rec = recallPosition(row.position_id);
          return rec ? BigInt(rec.collateralStroops) : undefined;
        })(),
      });
    }
    set({ positions });
  },

  openPosition: async (tierId, direction) => {
    const wallet = useWalletStore.getState();
    if (!wallet.address) throw new Error('Connect your wallet first');
    const keys = await wallet.unlockShieldedKeys();
    const tier = getTier(tierId);

    set({ isProving: true, status: 'Checking the price feed…' });
    try {
      // Every precondition is checked BEFORE proving. Each of these would
      // otherwise cost the user a minute of proof generation to discover.
      const price = await fetchOraclePrice();
      if (!price) {
        throw new Error(
          'The price feed is stale or unavailable, so positions cannot be opened right now. ' +
          'This is the same check the contract makes; try again shortly.',
        );
      }

      set({ status: 'Checking counterparty capacity…' });
      const vault = await fetchVaultState();
      if (!vault) throw new Error('Could not read the counterparty vault.');
      if (!vaultCanCover(vault, tier)) {
        throw new Error(
          `The counterparty is full: the vault has ${vault.freeBalance} stroops free and this ` +
          `${tier.name} position needs ${tier.maxPayoutStroops - tier.marginStroops} set aside. ` +
          'This is normal — wait for a position to close, or add liquidity.',
        );
      }

      const onChainTiers = await fetchOnChainTiers();
      if (onChainTiers && !tierTableMatches(onChainTiers)) {
        throw new Error(
          'This app build and the deployed contract disagree about the tier table, ' +
          'so any proof it generated would be rejected on-chain. Reload, or report this.',
        );
      }

      set({ status: 'Selecting collateral…' });
      const notes = (await getNotes(keys.viewingKey)).filter(
        (n) => !n.isSpent && n.protocol === 'v3' && n.pool === V2_POOL_ID && n.amountStroops,
      );
      // The largest single note that can cover the margin. One note, because
      // position_open spends exactly one -- there is no 2-input variant.
      const candidates = notes
        .filter((n) => BigInt(n.amountStroops!) >= tier.marginStroops)
        .sort((a, b) => (BigInt(a.amountStroops!) < BigInt(b.amountStroops!) ? -1 : 1));
      const note = candidates[0];
      if (!note) {
        const best = notes.reduce((m, n) => (BigInt(n.amountStroops!) > m ? BigInt(n.amountStroops!) : m), 0n);
        throw new Error(
          `No single shielded note covers the ${tier.name} margin of ` +
          `${Number(tier.marginStroops) / 1e7} XLM. Your largest is ${Number(best) / 1e7} XLM. ` +
          'Send yourself a larger amount first — a position spends one note.',
        );
      }

      set({ status: 'Reconstructing the Merkle path…' });
      const leaves = await fetchVerifiedCommitments();
      const leafIndex = leaves.findIndex((c) => c.toString() === note.commitment);
      if (leafIndex < 0) {
        throw new Error('This note is not indexed yet. Wait a few seconds and retry.');
      }

      // A note recovered from the legacy viewing key is opened by the legacy
      // spend key, and the position's own key must be that same one or the
      // payout note would be addressed to an identity the wallet does not use.
      const noteKeys = await keysForNote(note, keys);

      const positionId = randomPositionId();
      const idHex = positionIdHex(positionId);
      const [posBlind, chgBlind] = [
        await positionBlindness(noteKeys.spendKey, positionId),
        await changeBlindness(noteKeys.spendKey, positionId),
      ];

      set({ status: 'Generating the position proof…' });
      const proved = await runWorkerTask('PROVE_POSITION_OPEN', {
        privKey: noteKeys.spendKey.toString(),
        collateralStroops: note.amountStroops!,
        collateralBlindness: note.blindness,
        leafIndex,
        leaves: leaves.map((c) => c.toString()),
        tierId,
        marginStroops: tier.marginStroops.toString(),
        size: tier.size.toString(),
        direction,
        entryPrice: price.price.toString(),
        positionId: positionId.toString(),
        positionBlindness: posBlind.toString(),
        changeBlindness: chgBlind.toString(),
      });

      set({ status: 'Opening the position…' });
      const txHash = await submitPositionOpen({
        source: wallet.address,
        positionIdHex: idHex,
        owner: wallet.address,
        tierId,
        direction,
        proof: proved.proof,
        root: proved.root,
        nullifier: proved.nullifier,
        positionCommitment: proved.position_commitment,
        changeCommitment: proved.change_commitment,
      });

      // Bookkeeping AFTER the chain accepted it. Marking the note spent before
      // submission would hide a live note if the transaction failed.
      await markNoteSpent(keys.viewingKey, note.id);
      rememberPosition(idHex, {
        collateralStroops: note.amountStroops!,
        legacyViewingKey: note.legacyViewingKey,
      });

      const changeAmount = BigInt(proved.change_amount);
      if (changeAmount > 0n) {
        await addNote(keys.viewingKey, {
          id: proved.change_commitment,
          amount: Number(changeAmount) / 1e7,
          amountStroops: changeAmount.toString(),
          asset: 'XLM',
          protocol: 'v3',
          pool: V2_POOL_ID,
          commitment: proved.change_commitment,
          nullifier: (await poseidon2Hash2(BigInt(proved.change_commitment), noteKeys.spendKey)).toString(),
          pubX: noteKeys.pubX.toString(),
          pubY: noteKeys.pubY.toString(),
          blindness: chgBlind.toString(),
          leafIndex: -1,
          isSpent: false,
          source: 'change',
          createdAt: Date.now(),
          txHash,
          keyVersion: note.keyVersion,
          legacyViewingKey: note.legacyViewingKey,
        });
      }

      set({ status: 'Position opened.' });
      useToastStore.getState().addToast('Position opened.', 'success');
      await get().fetchState();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Opening the position failed.';
      set({ status: message });
      useToastStore.getState().addToast(message, 'error');
      throw e;
    } finally {
      set({ isProving: false });
    }
  },

  closePosition: async (positionId) => {
    const wallet = useWalletStore.getState();
    if (!wallet.address) throw new Error('Connect your wallet first');
    const keys = await wallet.unlockShieldedKeys();

    set({ isProving: true, status: 'Reading the position…' });
    try {
      // Re-read from the chain rather than trusting the list in memory. The
      // close proof is built against `entry_price` and `tier_id`, and a stale
      // local copy produces a witness for a different position.
      const onChain = await fetchPositionState(positionId);
      if (!onChain) throw new Error('This position is no longer open.');
      const tier = getTier(onChain.tierId);

      set({ status: 'Reading the settlement price…' });
      const price = await fetchOraclePrice();
      if (!price) {
        throw new Error(
          'The price feed is stale, so the contract will not settle right now. ' +
          'Your position is unaffected; try again shortly.',
        );
      }

      // Computed with the same formula the contract uses. The contract recomputes
      // it from its own state at execution time, so this must agree or the proof
      // fails -- which is why `settlementPayout` is tested against the contract's
      // Rust in tiers.test.ts rather than being written twice by eye.
      const payout = settlementPayout(tier, onChain.direction, onChain.entryPrice, price.price);
      const fee = 0n;

      // The position is committed to whichever key owned the collateral note.
      // For an ordinary position that is the wallet's current identity; for one
      // funded by a note recovered from the old viewing key it is that key, and
      // using the wrong one produces a commitment that is not the stored one.
      const record = recallPosition(positionId);
      const noteKeys = record?.legacyViewingKey
        ? await keysForNote(
            { legacyViewingKey: record.legacyViewingKey } as never,
            keys,
          )
        : keys;

      const posBlind = await positionBlindness(noteKeys.spendKey, BigInt('0x' + positionId));
      const outBlind = await payoutBlindness(noteKeys.spendKey, BigInt('0x' + positionId));

      set({ status: 'Generating the close proof…' });
      const proved = await runWorkerTask('PROVE_POSITION_CLOSE', {
        privKey: noteKeys.spendKey.toString(),
        tierId: onChain.tierId,
        marginStroops: tier.marginStroops.toString(),
        size: tier.size.toString(),
        direction: onChain.direction,
        entryPrice: onChain.entryPrice.toString(),
        positionId: BigInt('0x' + positionId).toString(),
        positionBlindness: posBlind.toString(),
        payoutStroops: payout.toString(),
        feeStroops: fee.toString(),
        payoutBlindness: outBlind.toString(),
      });

      set({ status: 'Settling…' });
      const txHash = await submitPositionClose({
        source: wallet.address,
        positionIdHex: positionId,
        proof: proved.proof,
        positionNullifier: proved.position_nullifier,
        outputNoteCommitment: proved.output_note_commitment,
        feeStroops: fee,
      });

      const noteAmount = BigInt(proved.note_amount);
      if (noteAmount > 0n) {
        await addNote(keys.viewingKey, {
          id: proved.output_note_commitment,
          amount: Number(noteAmount) / 1e7,
          amountStroops: noteAmount.toString(),
          asset: 'XLM',
          protocol: 'v3',
          pool: V2_POOL_ID,
          commitment: proved.output_note_commitment,
          nullifier: (await poseidon2Hash2(BigInt(proved.output_note_commitment), noteKeys.spendKey)).toString(),
          pubX: noteKeys.pubX.toString(),
          pubY: noteKeys.pubY.toString(),
          blindness: outBlind.toString(),
          leafIndex: -1,
          isSpent: false,
          source: 'received',
          createdAt: Date.now(),
          txHash,
        });
      }

      const settled = Number(noteAmount) / 1e7;
      set({ status: `Position closed. ${settled} XLM is back in your shielded balance.` });
      useToastStore.getState().addToast(`Position closed for ${settled} XLM.`, 'success');
      await get().fetchState();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Closing the position failed.';
      set({ status: message });
      useToastStore.getState().addToast(message, 'error');
      throw e;
    } finally {
      set({ isProving: false });
    }
  },

  attestHealth: async (positionId) => {
    const wallet = useWalletStore.getState();
    if (!wallet.address) throw new Error('Connect your wallet first');
    const keys = await wallet.unlockShieldedKeys();

    set({ isProving: true, status: 'Reading the position…' });
    try {
      const onChain = await fetchPositionState(positionId);
      if (!onChain) throw new Error('This position is no longer open.');
      const tier = getTier(onChain.tierId);

      const price = await fetchOraclePrice();
      if (!price) throw new Error('The price feed is stale; attestation would be rejected.');

      // Same key resolution closePosition uses, and for the same reason: the
      // position is committed to whichever key owned the collateral note. A
      // position funded from a note recovered under the old viewing key is
      // committed to THAT key, so attesting with the wallet's current one
      // rebuilds a different position_commitment and the proof fails. This used
      // to read keys.spendKey directly, which meant such a position could be
      // closed but never attested -- a failure that reads as random.
      const record = recallPosition(positionId);
      const noteKeys = record?.legacyViewingKey
        ? await keysForNote(
            { legacyViewingKey: record.legacyViewingKey } as never,
            keys,
          )
        : keys;

      const posBlind = await positionBlindness(noteKeys.spendKey, BigInt('0x' + positionId));

      set({ status: 'Proving solvency…' });
      const proved = await runWorkerTask('PROVE_POSITION_HEALTH', {
        privKey: noteKeys.spendKey.toString(),
        tierId: onChain.tierId,
        marginStroops: tier.marginStroops.toString(),
        size: tier.size.toString(),
        direction: onChain.direction,
        entryPrice: onChain.entryPrice.toString(),
        positionBlindness: posBlind.toString(),
        oraclePrice: price.price.toString(),
        oracleTimestamp: price.timestamp.toString(),
        healthThreshold: '500',
      });

      set({ status: 'Submitting the attestation…' });
      await submitAttestHealth({
        source: wallet.address,
        positionIdHex: positionId,
        proof: proved.proof,
      });

      set({ status: 'Health attested.' });
      useToastStore.getState().addToast('Health attested — the liquidation clock is reset.', 'success');
      await get().fetchState();
    } catch (e) {
      // A failed health proof is INFORMATION, not an error to hide: it means the
      // position is below maintenance margin, which is precisely when it becomes
      // liquidatable. Say so rather than reporting a generic failure.
      const raw = e instanceof Error ? e.message : String(e);
      const message = /witness|constraint|Assert/i.test(raw)
        ? 'This position is below its maintenance margin, so solvency cannot be proved. ' +
          'It will be liquidated when its grace period expires — close it now to keep what is left.'
        : raw;
      set({ status: message });
      useToastStore.getState().addToast(message, 'error');
      throw e;
    } finally {
      set({ isProving: false });
    }
  },

  addLiquidity: async (amountStroops) => {
    const wallet = useWalletStore.getState();
    if (!wallet.address) throw new Error('Connect your wallet first');
    set({ status: 'Adding liquidity…' });
    try {
      await submitAddLiquidity(wallet.address, amountStroops);
      useToastStore.getState().addToast('Liquidity added to the counterparty vault.', 'success');
      await get().fetchState();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Adding liquidity failed.';
      useToastStore.getState().addToast(message, 'error');
      throw e;
    } finally {
      set({ status: null });
    }
  },

  removeLiquidity: async (shares) => {
    const wallet = useWalletStore.getState();
    if (!wallet.address) throw new Error('Connect your wallet first');
    set({ status: 'Removing liquidity…' });
    try {
      await submitRemoveLiquidity(wallet.address, shares);
      useToastStore.getState().addToast('Liquidity removed.', 'success');
      await get().fetchState();
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // Error 10 is WouldBreakReserve. LPs are subordinate to open positions by
      // design, and that is a state worth explaining rather than a failure.
      const message = /#10|WouldBreakReserve/.test(raw)
        ? 'That much is currently backing open positions and cannot be withdrawn yet. ' +
          'It frees up as those positions close.'
        : raw;
      useToastStore.getState().addToast(message, 'error');
      throw e;
    } finally {
      set({ status: null });
    }
  },
}));

// Re-exported so components render tier facts without importing the table
// separately and risking a second source of truth.
export { TIERS, getTier, leverageAt, priceBounds, settlementPayout };
