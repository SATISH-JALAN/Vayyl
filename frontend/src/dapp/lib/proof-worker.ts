// ============================================================
// Proof generation Web Worker  (Tasks 6.2, 6.4)
// ============================================================
// Heavy Groth16 proving stays OFF the main thread (iOS Safari kills workers
// >~1–2GB; never move this inline). Builds REAL circuit inputs from real note
// secrets + a reconstructed Merkle path, then fullProve with the fresh
// wasm/zkey artifacts under /circuits (regenerated after the Poseidon2 fix).
//
// Transfer, positions, and orders are intentionally NOT handled here; the app
// labels them as roadmap until real circuit inputs and contract paths exist.

import * as snarkjs from 'snarkjs';
import { computeCommitment, computeNullifier, poseidon2Hash2 } from './poseidon';
import { buildMerklePath, TREE_DEPTH } from './merkle';

// V1 ASP is labeled-not-enforced (see CLAUDE.md / store note): the pool contract
// forwards `asp_root` to the verifier as a public input but never checks it
// against a registered allowlist. The Deposit circuit, however, still constrains
// `asp.root === asp_root` (asp_membership.circom → deposit.circom:45), so the
// root is NOT free — it's fully determined by (pubX, pubY) and the path. We must
// compute the exact root the circuit derives, or witness generation asserts.
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
        const aspPathElements = p.aspPathElements ?? Array(TREE_DEPTH).fill('0');
        const aspPathIndices = p.aspPathIndices ?? Array(TREE_DEPTH).fill(0);
        // `asp_root` is derived, not chosen: it must equal what the circuit
        // recomputes from (pubX, pubY, path), or deposit.circom:45 asserts.
        const aspRoot = await computeAspRoot(
          BigInt(p.pubX), BigInt(p.pubY), aspPathElements, aspPathIndices,
        );
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

      default:
        throw new Error(`Unknown / unsupported circuit type: ${type}`);
    }
    self.postMessage({ id, status: 'success', result });
  } catch (error) {
    self.postMessage({ id, status: 'error', error: (error as Error).message });
  }
};
