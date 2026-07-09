// ============================================================
// Proof generation Web Worker  (Tasks 6.2, 6.4)
// ============================================================
// Heavy Groth16 proving stays OFF the main thread (iOS Safari kills workers
// >~1–2GB; never move this inline). Builds REAL circuit inputs from real note
// secrets + a reconstructed Merkle path, then fullProve with the fresh
// wasm/zkey artifacts under /circuits (regenerated after the Poseidon2 fix).
//
// Positions/orders remain mock and are intentionally NOT handled here — they
// stay UI-only ("vision") per the MVP scope.

import * as snarkjs from 'snarkjs';
import { computeCommitment, computeNullifier, poseidon2Hash2 } from './poseidon';
import { buildMerklePath, zeroHashes, TREE_DEPTH } from './merkle';

// ASP is ENFORCED on-chain: `vayyl-pool::deposit` calls
// `asp_membership.is_known_root(asp_root)` and aborts with Error #8 unless the
// root is one the ASP contract actually produced via `insert_leaf` (Sprint C
// hardening). Two things must therefore line up for a deposit to pass:
//   1. the depositor's leaf `Poseidon2(pubX,pubY)` is inserted into the ASP tree
//      (admin-gated — see scripts/asp_insert.js), and
//   2. we submit the SAME `asp_root` the ASP contract computed for that leaf.
// The Deposit circuit independently constrains `asp.root === asp_root`
// (asp_membership.circom → deposit.circom:45), so the root is fully determined by
// (pubX, pubY, path) — we must reproduce the on-chain path, not fabricate one.
//
// For a single approved key sitting at index 0 in an otherwise-empty tree the
// path is the empty-subtree ladder (`zeroHashes`) with all-left index bits, which
// yields exactly `asp_membership.root()` after that one insert. A pre-computed
// path (Tier 2: indexer-served) can be supplied via `aspPathElements`/Indices for
// trees with more than one leaf.
//
// Mirrors MerkleProof(20): leaf = Poseidon2(pubX,pubY); climb, and for
// pathIndices[i]==0 the current node is the LEFT child (DualMux s=0):
//   parent = Poseidon2(current, sibling).
async function computeAspRoot(
  pubX: bigint,
  pubY: bigint,
  pathElements: string[],
  pathIndices: number[],
): Promise<bigint> {
  let node = await poseidon2Hash2(pubX, pubY);
  for (let i = 0; i < TREE_DEPTH; i++) {
    const sib = BigInt(pathElements[i]);
    node =
      (pathIndices[i] & 1) === 0
        ? await poseidon2Hash2(node, sib)
        : await poseidon2Hash2(sib, node);
  }
  return node;
}

interface DepositPayload {
  amount: string;
  pubX: string;
  pubY: string;
  blindness: string;
  aspRoot?: string;
  aspPathElements?: string[];
  aspPathIndices?: number[];
}

interface WithdrawPayload {
  // note secrets
  amount: string; // note value = public_amount + fee
  pubX: string;
  pubY: string;
  blindness: string;
  privKey: string;
  leafIndex: number;
  // public
  publicAmount: string;
  fee: string;
  withdrawBinding: string;
  // tree
  leaves: string[]; // ordered commitment field elements (decimal)
}

self.onmessage = async (e: MessageEvent) => {
  const { type, payload, id } = e.data;
  try {
    let result;
    switch (type) {
      case 'PROVE_DEPOSIT': {
        const p = payload as DepositPayload;
        const commitment = await computeCommitment(
          BigInt(p.amount), BigInt(p.pubX), BigInt(p.pubY), BigInt(p.blindness),
        );
        // Default path = the real empty-subtree ladder for a leaf at index 0
        // (sibling at level l is `zeros[l]`, all-left index bits). This is the
        // correct membership path for the first/only approved key — NOT a
        // placeholder — and reproduces the on-chain `asp_membership.root()`.
        // Callers may override for a populated tree (Tier 2, indexer-served path).
        const zeros = await zeroHashes(TREE_DEPTH); // [zeros[0]..zeros[20]]
        const aspPathElements =
          p.aspPathElements ?? zeros.slice(0, TREE_DEPTH).map((z) => z.toString());
        const aspPathIndices = p.aspPathIndices ?? Array(TREE_DEPTH).fill(0);
        // `asp_root` is derived, not chosen: it must equal what the circuit
        // recomputes from (pubX, pubY, path), or deposit.circom:45 asserts.
        const aspRoot = await computeAspRoot(
          BigInt(p.pubX), BigInt(p.pubY), aspPathElements, aspPathIndices,
        );
        // The ASP leaf the admin must have inserted for this deposit to clear the
        // on-chain `is_known_root` gate. Surfaced so the caller can display/insert it.
        const aspLeaf = await poseidon2Hash2(BigInt(p.pubX), BigInt(p.pubY));
        const input = {
          amount: p.amount,
          commitment: commitment.toString(),
          asp_root: aspRoot.toString(),
          pubX: p.pubX,
          pubY: p.pubY,
          blindness: p.blindness,
          asp_pathElements: aspPathElements,
          asp_pathIndices: aspPathIndices,
        };
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          input, '/circuits/deposit.wasm', '/circuits/deposit_final.zkey',
        );
        result = {
          proof,
          publicSignals,
          commitment: commitment.toString(),
          aspRoot: aspRoot.toString(),
          aspLeaf: aspLeaf.toString(),
        };
        break;
      }

      case 'PROVE_WITHDRAW': {
        const p = payload as WithdrawPayload;
        const commitment = await computeCommitment(
          BigInt(p.amount), BigInt(p.pubX), BigInt(p.pubY), BigInt(p.blindness),
        );
        const nullifier = await computeNullifier(commitment, BigInt(p.privKey));

        const leaves = p.leaves.map((x) => BigInt(x));
        const { root, pathElements, pathIndices } = await buildMerklePath(leaves, p.leafIndex);

        const input = {
          root: root.toString(),
          nullifier: nullifier.toString(),
          public_amount: p.publicAmount,
          fee: p.fee,
          withdraw_binding: p.withdrawBinding,
          amount: p.amount,
          pubX: p.pubX,
          pubY: p.pubY,
          blindness: p.blindness,
          privKey: p.privKey,
          pathElements: pathElements.map((x) => x.toString()),
          pathIndices: pathIndices.map((x) => x.toString()),
        };
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          input, '/circuits/withdraw.wasm', '/circuits/withdraw_final.zkey',
        );
        result = {
          proof, publicSignals,
          nullifier: nullifier.toString(),
          root: root.toString(),
        };
        break;
      }

      case 'PROVE_POSITION_OPEN': {
        const p = payload as any;
        
        // Mock note secrets for MVP
        const amount = 500n;
        const pubX = 1n;
        const pubY = 2n;
        const blindness = 3n;
        const privKey = 10n;
        
        const commitment = await computeCommitment(amount, pubX, pubY, blindness);
        const nullifier = await computeNullifier(commitment, privKey);
        
        const size = p.size ? BigInt(p.size.replace(/[^0-9]/g, '')) : 12500n;
        const direction = p.type === 'Long' ? 1n : 0n;
        const entry_price = 1000n;
        const position_blindness = 4n;
        
        // Position Commitment
        const pos_commit = await poseidon2Hash2(size, await poseidon2Hash2(direction, await poseidon2Hash2(entry_price, await poseidon2Hash2(pubX, await poseidon2Hash2(pubY, position_blindness)))));
        
        const zeros = await zeroHashes(TREE_DEPTH);
        const pathElements = zeros.slice(0, TREE_DEPTH).map(z => z.toString());
        const pathIndices = Array(TREE_DEPTH).fill(0);
        
        const root = await computeAspRoot(pubX, pubY, pathElements, pathIndices);

        const input = {
          root: root.toString(),
          nullifier: nullifier.toString(),
          position_commitment: pos_commit.toString(),
          meta_hash: "0",
          amount: amount.toString(),
          pubX: pubX.toString(),
          pubY: pubY.toString(),
          blindness: blindness.toString(),
          privKey: privKey.toString(),
          pathElements,
          pathIndices,
          size: size.toString(),
          direction: direction.toString(),
          entry_price: entry_price.toString(),
          position_blindness: position_blindness.toString(),
        };

        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          input, '/circuits/position_open.wasm', '/circuits/position_open_final.zkey'
        );
        
        result = { proof, publicSignals, position_commitment: pos_commit.toString() };
        break;
      }

      case 'PROVE_HIDDEN_ORDER_TRIGGER': {
        const p = payload as any;
        
        const trigger_price = 1500n;
        const order_direction = 1n;
        const salt = 5n;
        
        // order_commitment = Poseidon2(trigger_price, order_direction, salt)
        let commit = await poseidon2Hash2(trigger_price, await poseidon2Hash2(order_direction, salt));
        
        const input = {
          order_commitment: commit.toString(),
          oracle_price: "2000", // > 1500, so it fires
          meta_hash: "0",
          trigger_price: trigger_price.toString(),
          order_direction: order_direction.toString(),
          salt: salt.toString()
        };

        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          input, '/circuits/hidden_order_trigger.wasm', '/circuits/hidden_order_trigger_final.zkey'
        );
        
        result = { proof, publicSignals, order_commitment: commit.toString() };
        break;
      }

      default:
        throw new Error(`Unknown / unsupported circuit type: ${type}`);
    }
    self.postMessage({ id, status: 'success', result });
  } catch (error) {
    self.postMessage({ id, status: 'error', error: (error as Error).message });
  }
};
