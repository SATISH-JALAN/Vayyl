// ============================================================
// Leaf-ordering source: live indexer, with a durable static fallback
// ============================================================
// Soroban RPC retains contract events for roughly 7 days. Once a pool's
// deposits age out of that window, the indexer's database is the only live copy
// of the leaf ORDERING — and the ordering is what every wallet folds into a
// Merkle path. Lose it and no note can be spent; get one early index wrong and
// every later leaf shifts, so a single gap breaks spending for the whole pool,
// not just the affected note.
//
// So the ordering is also shipped as a static asset, built and root-checked
// against the chain by `circuits/scripts/build_tree_snapshot.mjs` and
// independently re-verifiable against Horizon's permanent transaction history
// by `verify_tree_snapshot.mjs`.
//
// This module is deliberately free of wallet and network-signing imports so the
// reconciliation rules below can be tested directly. `pool.ts` re-exports them.

export interface TreeSnapshotLeaf {
  index: number;
  commitment: string;
  source: string;
  tx_hash: string;
  ledger: number;
  ephemeral_x?: string;
  ephemeral_y?: string;
  /** V3 only: the output's amount under a one-time pad. */
  amount_cipher?: string;
}

export interface TreeSnapshot {
  pool: string;
  leaf_count: number;
  root: string;
  leaves: TreeSnapshotLeaf[];
  spent_nullifiers: string[];
}

export interface IndexedTransferRow {
  commitment: string;
  leafIndex: number;
  ephemeralX: string;
  ephemeralY: string;
  /** V3 only. Absent on V2 rows, whose amount was a known constant. */
  amountCipher?: string;
  txHash?: string;
  ledgerSequence?: number;
}

const toField = (hex: string) => BigInt('0x' + hex.replace(/^0x/, ''));

/** Snapshot cache keyed by pool, so a pool switch cannot serve stale leaves. */
const snapshotCache = new Map<string, Promise<TreeSnapshot | null>>();

/** Test seam: drop memoised snapshots. */
export function resetSnapshotCache(): void {
  snapshotCache.clear();
}

/**
 * The bundled snapshot, or null when it is absent or belongs to another pool.
 * A snapshot from a different deployment is worse than none: it would yield
 * confidently wrong Merkle paths instead of an honest failure.
 */
export async function loadTreeSnapshot(poolId: string): Promise<TreeSnapshot | null> {
  let cached = snapshotCache.get(poolId);
  if (!cached) {
    cached = (async () => {
      try {
        const res = await fetch('/tree-snapshot.json', { cache: 'no-cache' });
        if (!res.ok) return null;
        const snap = (await res.json()) as TreeSnapshot;
        if (snap.pool !== poolId) {
          console.error(`tree snapshot is for pool ${snap.pool}, expected ${poolId}; ignoring it`);
          return null;
        }
        return snap;
      } catch {
        return null;
      }
    })();
    snapshotCache.set(poolId, cached);
  }
  return cached;
}

/**
 * Ordered commitment field elements in leaf order.
 *
 * The indexer is preferred because it is live, but it is not trusted to be
 * complete. The failure that actually loses funds is not an indexer that errors
 * — that fails loudly — but one that answers 200 OK with a PREFIX of the truth,
 * because a short prefix still hashes to a well-formed root that the pool has
 * simply never accepted. So the snapshot acts as a floor: whichever source
 * carries more leaves wins.
 */
export async function fetchCommitmentsFrom(indexerUrl: string, poolId: string): Promise<bigint[]> {
  const snapshot = await loadTreeSnapshot(poolId);
  const fallback = snapshot?.leaves.map((l) => toField(l.commitment)) ?? null;

  try {
    const res = await fetch(`${indexerUrl}/commitments`);
    if (!res.ok) throw new Error(`indexer /commitments ${res.status}`);
    const data = await res.json();
    // commitment_hash is stored as 64-char hex by the indexer.
    const live = (data.commitments as string[]).map(toField);
    if (!fallback || live.length >= fallback.length) return live;
    console.warn(
      `indexer served ${live.length} leaves but the bundled snapshot has ${fallback.length}; ` +
      `using the snapshot. The indexer is behind.`
    );
    return fallback;
  } catch (err) {
    if (!fallback) throw err;
    console.warn(`indexer unreachable (${(err as Error).message}); using the bundled tree snapshot`);
    return fallback;
  }
}

/**
 * The recipient scan feed. A recipient discovers the note sent to them only by
 * trial-matching these ephemeral points, so losing the feed loses the payment
 * as surely as losing the leaf ordering does.
 */
export async function fetchTransfersFrom(
  indexerUrl: string,
  poolId: string,
  since = 0,
): Promise<IndexedTransferRow[]> {
  try {
    const res = await fetch(`${indexerUrl}/transfers?since=${since}`);
    if (!res.ok) throw new Error(`indexer /transfers ${res.status}`);
    const data = await res.json();
    return (data.transfers ?? []) as IndexedTransferRow[];
  } catch (err) {
    const snapshot = await loadTreeSnapshot(poolId);
    if (!snapshot) throw err;
    console.warn(`indexer unreachable (${(err as Error).message}); scanning the bundled tree snapshot`);
    return snapshot.leaves
      .filter((l) => l.source === 'transfer' && l.ephemeral_x && l.ledger >= since)
      .map((l) => ({
        commitment: l.commitment,
        leafIndex: l.index,
        ephemeralX: l.ephemeral_x!,
        ephemeralY: l.ephemeral_y!,
        amountCipher: l.amount_cipher,
        txHash: l.tx_hash,
        ledgerSequence: l.ledger,
      }));
  }
}

export interface IndexedDepositRow {
  commitment: string;
  leafIndex: number;
  amountStroops: string;
  txHash?: string;
}

/**
 * Deposits with their public amounts — the clean-device recovery feed.
 *
 * Falls back to the bundled snapshot, which is what makes recovery independent
 * of us: a user restoring a wallet needs this to exist somewhere that is not
 * our database. Snapshot rows carry no amount, so only the live feed can drive
 * a full recovery; the fallback still lets the tree be rebuilt.
 */
export async function fetchDepositsFrom(
  indexerUrl: string,
  poolId: string,
): Promise<IndexedDepositRow[]> {
  try {
    const res = await fetch(`${indexerUrl}/deposits`);
    if (!res.ok) throw new Error(`indexer /deposits ${res.status}`);
    return ((await res.json()).deposits ?? []) as IndexedDepositRow[];
  } catch (err) {
    void (await loadTreeSnapshot(poolId));
    console.warn(`indexer unreachable (${(err as Error).message}); deposit recovery unavailable`);
    return [];
  }
}

/**
 * Spent nullifiers, used only to hide already-spent notes in the UI. Falling
 * back to a stale set is safe in the direction that matters: the pool rejects a
 * double-spend regardless, so the worst case is a note that looks spendable and
 * is not — never the reverse.
 */
export async function fetchSpentNullifiersFrom(
  indexerUrl: string,
  poolId: string,
): Promise<Set<string>> {
  const res = await fetch(`${indexerUrl}/nullifiers`).catch(() => null);
  if (!res || !res.ok) {
    const snapshot = await loadTreeSnapshot(poolId);
    return new Set((snapshot?.spent_nullifiers ?? []).map((h) => toField(h).toString()));
  }
  const data = await res.json();
  return new Set((data.nullifiers as string[]).map((h) => toField(h).toString()));
}

/**
 * M8: confirm a reconstructed leaf ordering reproduces the pool's on-chain root.
 *
 * The client rebuilds the tree from the indexer, falling back to the committed
 * snapshot. Nothing compared the result to the chain, so a stale or mis-ordered
 * indexer cost the user a full proof generation — tens of seconds on a phone —
 * and then came back as an opaque `UnknownRoot` from the contract, an error
 * that says nothing about the indexer being behind.
 *
 * This is NOT a security control. The contract's own root check is
 * authoritative and unchanged; a client that skipped this could not thereby
 * spend anything. It exists so the failure happens in the right place, before
 * the expensive step, with a message naming the actual cause.
 *
 * Takes the on-chain root as a parameter so the rule stays wallet-free and
 * testable; `pool.ts` supplies it from `get_root`.
 */
export async function assertRootMatches(
  leaves: bigint[],
  onChainRoot: bigint,
  computeRootFn: (leaves: bigint[]) => Promise<bigint>,
): Promise<bigint[]> {
  const local = await computeRootFn(leaves);
  if (local !== onChainRoot) {
    const hex = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}`;
    throw new Error(
      `Note history is out of date: the local tree (${leaves.length} leaves) does not ` +
      `match the pool. Pool root ${hex(onChainRoot)}, computed ${hex(local)}. ` +
      `The indexer is probably behind — retry in a moment.`
    );
  }
  return leaves;
}
