// ============================================================
// Client-side Merkle tree / path reconstruction  (Task 6.4)
// ============================================================
// Rebuilds the pool's Poseidon2 Merkle tree from the ordered commitment list
// (served by the indexer) and produces the (pathElements, pathIndices, root)
// a withdraw proof needs. MUST match VayylPool exactly:
//   - depth 20, hash2(l,r) = Poseidon2Hash_2(l,r)  (same wasm as the circuit)
//   - zero subtrees: zeros[0]=0, zeros[l]=hash2(zeros[l-1], zeros[l-1])
//   - parent = hash2(leftChild, rightChild)  (DualMux ordering in merkle.circom)
// The reconstructed root equals the on-chain root (or a root in the H4 window),
// so the withdraw proof binds a root the pool will accept.

import { poseidon2Hash2 } from './poseidon';

export const TREE_DEPTH = 20;

export interface MerklePath {
  root: bigint;
  pathElements: bigint[]; // length TREE_DEPTH
  pathIndices: number[]; // length TREE_DEPTH, each 0/1
}

/**
 * Precompute zero-subtree hashes for levels 0..depth (array length depth+1).
 * `zeros[l]` is the root of an all-empty subtree of height `l`, i.e. the sibling
 * a leaf sees at level `l` when everything to its right is empty. Shared by the
 * withdraw path here and the deposit ASP path (proof-worker.ts) so both match the
 * on-chain empty-subtree ladder exactly (`asp-membership::initialize`).
 */
export async function zeroHashes(depth: number): Promise<bigint[]> {
  const zeros: bigint[] = [0n];
  for (let l = 1; l <= depth; l++) {
    zeros[l] = await poseidon2Hash2(zeros[l - 1], zeros[l - 1]);
  }
  return zeros;
}

/**
 * Build the Merkle path for `leafIndex` given all leaves in insertion order.
 * Only materialises occupied nodes (O(N) per level), so it is cheap for the
 * testnet-scale leaf counts we expect.
 */
export async function buildMerklePath(
  leaves: bigint[],
  leafIndex: number,
  depth: number = TREE_DEPTH,
): Promise<MerklePath> {
  if (leafIndex < 0 || leafIndex >= (1 << depth)) {
    throw new Error(`leafIndex ${leafIndex} out of range for depth ${depth}`);
  }
  const zeros = await zeroHashes(depth);

  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];

  // node(level, k): occupied value or the level's zero-subtree hash.
  let level = leaves.slice();
  const nodeAt = (arr: bigint[], k: number, l: number) =>
    k < arr.length ? arr[k] : zeros[l];

  for (let l = 0; l < depth; l++) {
    const idx = Math.floor(leafIndex / 2 ** l);
    const sibIdx = idx ^ 1;
    pathIndices.push(idx & 1);
    pathElements.push(nodeAt(level, sibIdx, l));

    // hash this level up to the next
    const next: bigint[] = [];
    const parentCount = Math.ceil(level.length / 2);
    for (let j = 0; j < parentCount; j++) {
      const left = nodeAt(level, 2 * j, l);
      const right = nodeAt(level, 2 * j + 1, l);
      next.push(await poseidon2Hash2(left, right));
    }
    level = next;
  }

  const root = level.length > 0 ? level[0] : zeros[depth];
  return { root, pathElements, pathIndices };
}

/** The root of a tree containing exactly `leaves` (no target leaf). */
export async function computeRoot(leaves: bigint[], depth: number = TREE_DEPTH): Promise<bigint> {
  const zeros = await zeroHashes(depth);
  let level = leaves.slice();
  const nodeAt = (arr: bigint[], k: number, l: number) =>
    k < arr.length ? arr[k] : zeros[l];
  for (let l = 0; l < depth; l++) {
    const next: bigint[] = [];
    const parentCount = Math.max(1, Math.ceil(level.length / 2));
    if (level.length === 0) return zeros[depth];
    for (let j = 0; j < parentCount; j++) {
      next.push(await poseidon2Hash2(nodeAt(level, 2 * j, l), nodeAt(level, 2 * j + 1, l)));
    }
    level = next;
  }
  return level[0];
}
