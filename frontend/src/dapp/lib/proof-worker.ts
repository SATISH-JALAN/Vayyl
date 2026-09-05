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
import { computeCommitment, computeNullifier, poseidon2Hash2, poseidon2Hash4 } from './poseidon';
import { buildMerklePath, zeroHashes, TREE_DEPTH } from './merkle';
import { derivePublicKey } from './babyjub';
import {
  deriveOutgoingNote,
  deriveOutgoingNoteV3,
  scanForIncomingNotes,
  scanForIncomingNotesV3,
  recoverOwnDeposits,
  randomScalar,
  type IndexedDeposit,
  type IndexedTransfer,
  type IndexedTransferV3,
} from './transfer';
import buildWitnessCalculator from './witness_calculator.js';

const V2_AMOUNT = '10000000';

let v2NoteCalculator: ReturnType<typeof buildWitnessCalculator> | null = null;

async function deriveV2Note(privKey: string, blindness: string) {
  return deriveNote(privKey, V2_AMOUNT, blindness);
}

/**
 * Derive a note of any amount through the SAME `Note()` circuit the proofs use.
 *
 * Going through the circuit rather than reimplementing the derivation in JS is
 * the point: a JS version that drifts from the circuit produces commitments the
 * proof cannot open, and that failure surfaces on-chain as an opaque
 * verification error with nothing pointing at the cause.
 *
 * It also inherits the circuit's range check, so an out-of-range amount fails
 * here — locally, with a real message — instead of at proving time.
 */
async function deriveNote(privKey: string, amount: string, blindness: string) {
  v2NoteCalculator ??= fetch('/circuits/v2/note.wasm')
    .then((response) => {
      if (!response.ok) throw new Error(`Failed to load V2 note circuit (${response.status})`);
      return response.arrayBuffer();
    })
    .then((wasm) => buildWitnessCalculator(wasm));
  const calculator = await v2NoteCalculator;
  const witness = await calculator.calculateWitness({ privKey, amount, blindness }, true);
  return {
    pubX: witness[1].toString(),
    pubY: witness[2].toString(),
    commitment: witness[3].toString(),
    nullifier: witness[4].toString(),
  };
}

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

interface V2DepositPayload {
  privKey: string;
  blindness: string;
  aspLeafIndex: number;
  aspLeaves: string[];
}

interface V2WithdrawPayload {
  privKey: string;
  blindness: string;
  commitment: string;
  leafIndex: number;
  withdrawBinding: string;
  leaves: string[];
}

interface V2TransferPayload {
  privKey: string;
  blindness: string;
  commitment: string;
  leafIndex: number;
  leaves: string[];
  recipientPubX: string;
  recipientPubY: string;
}

// ---- V3 payloads -----------------------------------------------------------
// Amounts travel as decimal STRINGS of stroops throughout. Never as numbers:
// stroops are i128 on-chain and anything above 2^53 loses precision silently in
// a JS number, which would mis-price a note with no error anywhere.

interface V3DepositPayload {
  privKey: string;
  blindness: string;
  amountStroops: string;
  aspLeafIndex: number;
  aspLeaves: string[];
}

interface V3WithdrawPayload {
  privKey: string;
  blindness: string;
  amountStroops: string;
  commitment: string;
  leafIndex: number;
  leaves: string[];
  withdrawBinding: string;
}

interface V3InputNote {
  amountStroops: string;
  blindness: string;
  leafIndex: number;
}

interface V3TransferPayload {
  privKey: string;
  /** The note being spent. Always real. */
  in1: V3InputNote;
  /** A second real note, or absent to spend a single note against a dummy. */
  in2?: V3InputNote;
  leaves: string[];
  recipientPubX: string;
  recipientPubY: string;
  /** What the recipient receives; the remainder returns as change. */
  amountStroops: string;
}

interface V3RecoverDepositsPayload {
  spendKey: string;
  pubX: string;
  pubY: string;
  deposits: IndexedDeposit[];
}

interface V3ScanPayload {
  spendKey: string;
  pubX: string;
  pubY: string;
  transfers: IndexedTransferV3[];
}

interface V2RageQuitPayload {
  privKey: string;
  blindness: string;
  commitment: string;
  exitBinding: string;
}

interface V2ScanPayload {
  spendKey: string;
  pubX: string;
  pubY: string;
  transfers: IndexedTransfer[];
}

// ---- positions -------------------------------------------------------------
// Everything the CONTRACT decides arrives here as a value to pass through, not
// as something to recompute. `entryPrice` is the oracle price the contract read
// under a staleness check, `payoutStroops` is what the contract will settle for,
// and `marginStroops`/`size` come from the tier table. Recomputing any of them
// client-side is how a proof ends up verifying locally and failing on-chain.

interface PositionOpenPayload {
  privKey: string;
  /** The whole collateral note being spent, in stroops. */
  collateralStroops: string;
  collateralBlindness: string;
  leafIndex: number;
  leaves: string[];
  tierId: number;
  marginStroops: string;
  size: string;
  direction: number;
  entryPrice: string;
  positionId: string;
  positionBlindness: string;
  changeBlindness: string;
}

interface PositionHealthPayload {
  privKey: string;
  tierId: number;
  marginStroops: string;
  size: string;
  direction: number;
  entryPrice: string;
  positionBlindness: string;
  oraclePrice: string;
  oracleTimestamp: string;
  healthThreshold: string;
}

interface PositionClosePayload {
  privKey: string;
  tierId: number;
  marginStroops: string;
  size: string;
  direction: number;
  entryPrice: string;
  positionId: string;
  positionBlindness: string;
  payoutStroops: string;
  feeStroops: string;
  payoutBlindness: string;
}

self.onmessage = async (e: MessageEvent) => {
  const { type, payload, id } = e.data;
  try {
    let result;
    switch (type) {
      case 'PREPARE_V2_NOTE': {
        const p = payload as Pick<V2DepositPayload, 'privKey' | 'blindness'>;
        const note = await deriveV2Note(p.privKey, p.blindness);
        result = { ...note, aspLeaf: (await poseidon2Hash2(BigInt(note.pubX), BigInt(note.pubY))).toString() };
        break;
      }

      case 'PROVE_DEPOSIT_V2': {
        const p = payload as V2DepositPayload;
        const note = await deriveV2Note(p.privKey, p.blindness);
        const aspLeaf = await poseidon2Hash2(BigInt(note.pubX), BigInt(note.pubY));
        const aspLeaves = p.aspLeaves.map(BigInt);
        if (aspLeaves[p.aspLeafIndex] !== aspLeaf) {
          throw new Error('The workspace membership path does not match this shielded identity.');
        }
        const aspPath = await buildMerklePath(aspLeaves, p.aspLeafIndex);
        const input = {
          commitment: note.commitment,
          asp_root: aspPath.root.toString(),
          privKey: p.privKey,
          blindness: p.blindness,
          asp_pathElements: aspPath.pathElements.map(String),
          asp_pathIndices: aspPath.pathIndices.map(String),
        };
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          input, '/circuits/v2/deposit_v2.wasm', '/circuits/v2/deposit_v2_final.zkey',
        );
        result = { ...note, proof, publicSignals, aspLeaf: aspLeaf.toString(), aspRoot: aspPath.root.toString() };
        break;
      }

      case 'PROVE_WITHDRAW_V2': {
        const p = payload as V2WithdrawPayload;
        const note = await deriveV2Note(p.privKey, p.blindness);
        if (note.commitment !== p.commitment) throw new Error('The local note does not belong to this workspace.');
        const leaves = p.leaves.map(BigInt);
        const path = await buildMerklePath(leaves, p.leafIndex);
        const input = {
          root: path.root.toString(),
          nullifier: note.nullifier,
          withdraw_binding: p.withdrawBinding,
          privKey: p.privKey,
          blindness: p.blindness,
          pathElements: path.pathElements.map(String),
          pathIndices: path.pathIndices.map(String),
        };
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          input, '/circuits/v2/withdraw_v2.wasm', '/circuits/v2/withdraw_v2_final.zkey',
        );
        result = { proof, publicSignals, nullifier: note.nullifier, root: path.root.toString() };
        break;
      }

      // ── V3: arbitrary amounts ──────────────────────────────────────────
      // The amount is a real signal now rather than a circuit constant, so it
      // has to be carried consistently through every step: into the note, into
      // the proof's public statement, and (for transfer) encrypted to whoever
      // ends up owning the output.

      case 'PROVE_DEPOSIT_V3': {
        const p = payload as V3DepositPayload;
        const note = await deriveNote(p.privKey, p.amountStroops, p.blindness);
        const aspLeaf = await poseidon2Hash2(BigInt(note.pubX), BigInt(note.pubY));
        const aspLeaves = p.aspLeaves.map(BigInt);
        if (aspLeaves[p.aspLeafIndex] !== aspLeaf) {
          throw new Error('The workspace membership path does not match this shielded identity.');
        }
        const aspPath = await buildMerklePath(aspLeaves, p.aspLeafIndex);
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          {
            commitment: note.commitment,
            asp_root: aspPath.root.toString(),
            amount: p.amountStroops,
            privKey: p.privKey,
            blindness: p.blindness,
            asp_pathElements: aspPath.pathElements.map(String),
            asp_pathIndices: aspPath.pathIndices.map(String),
          },
          '/circuits/v3/deposit_v3.wasm', '/circuits/v3/deposit_v3_final.zkey',
        );
        result = { ...note, proof, publicSignals, aspLeaf: aspLeaf.toString(), aspRoot: aspPath.root.toString() };
        break;
      }

      case 'PROVE_WITHDRAW_V3': {
        const p = payload as V3WithdrawPayload;
        const note = await deriveNote(p.privKey, p.amountStroops, p.blindness);
        if (note.commitment !== p.commitment) throw new Error('The local note does not belong to this workspace.');
        const path = await buildMerklePath(p.leaves.map(BigInt), p.leafIndex);
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          {
            root: path.root.toString(),
            nullifier: note.nullifier,
            amount: p.amountStroops,
            withdraw_binding: p.withdrawBinding,
            privKey: p.privKey,
            blindness: p.blindness,
            pathElements: path.pathElements.map(String),
            pathIndices: path.pathIndices.map(String),
          },
          '/circuits/v3/withdraw_v3.wasm', '/circuits/v3/withdraw_v3_final.zkey',
        );
        result = { proof, publicSignals, nullifier: note.nullifier, root: path.root.toString() };
        break;
      }

      case 'PROVE_TRANSFER_V3': {
        const p = payload as V3TransferPayload;
        const leaves = p.leaves.map(BigInt);

        // Input 1 is always real.
        const in1 = await deriveNote(p.privKey, p.in1.amountStroops, p.in1.blindness);
        const path1 = await buildMerklePath(leaves, p.in1.leafIndex);

        // Input 2 is either a second real note or a dummy worth nothing. The
        // dummy's blindness MUST be fresh per transfer: it still produces a
        // nullifier the pool marks spent, so reusing one makes the next
        // transfer fail on-chain as a double spend.
        // D1: draw the dummy blindness ONCE and thread the same value into both
        // the derivation and the witness below. Deriving `in2` from a fresh
        // scalar while handing the circuit `in_blindness2: '0'` makes
        // `note2.nullifier === nullifier2` unsatisfiable, so `fullProve` throws
        // during witness generation -- and `needsDummy` is true whenever a
        // single note covers the amount, i.e. the ordinary case.
        //
        // Do NOT "fix" that by deriving with '0' to match: the dummy nullifier
        // would then be a constant per wallet and the SECOND single-note
        // transfer would be rejected on-chain as a double spend.
        const dummyBlindness = randomScalar().toString();
        const in2 = p.in2
          ? await deriveNote(p.privKey, p.in2.amountStroops, p.in2.blindness)
          : await deriveNote(p.privKey, '0', dummyBlindness);
        const path2 = p.in2 ? await buildMerklePath(leaves, p.in2.leafIndex) : path1;
        const in2Amount = p.in2 ? p.in2.amountStroops : '0';
        const isDummy2 = p.in2 ? '0' : '1';

        const total = BigInt(p.in1.amountStroops) + BigInt(in2Amount);
        const payAmount = BigInt(p.amountStroops);
        const change = total - payAmount;
        if (change < 0n) throw new Error('Selected notes do not cover the amount.');

        // Both outputs are built the same way, including the change note. The
        // sender's own change gets an ephemeral point and an encrypted amount
        // exactly like the payment, so a wallet restored on a clean device
        // rediscovers it by the same scan.
        const payOut = await deriveOutgoingNoteV3(
          [BigInt(p.recipientPubX), BigInt(p.recipientPubY)], payAmount,
        );
        const changeOut = await deriveOutgoingNoteV3(
          [BigInt(in1.pubX), BigInt(in1.pubY)], change,
        );

        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          {
            root: path1.root.toString(),
            nullifier1: in1.nullifier,
            nullifier2: in2.nullifier,
            commitment_out1: payOut.commitment.toString(),
            commitment_out2: changeOut.commitment.toString(),
            eph1_x: payOut.ephemeralX.toString(), eph1_y: payOut.ephemeralY.toString(),
            eph2_x: changeOut.ephemeralX.toString(), eph2_y: changeOut.ephemeralY.toString(),
            amount_ct1: payOut.amountCipher.toString(),
            amount_ct2: changeOut.amountCipher.toString(),
            privKey: p.privKey,
            in_amount1: p.in1.amountStroops,
            in_blindness1: p.in1.blindness,
            in_pathElements1: path1.pathElements.map(String),
            in_pathIndices1: path1.pathIndices.map(String),
            in_amount2: in2Amount,
            in_blindness2: p.in2 ? p.in2.blindness : dummyBlindness,
            in_pathElements2: path2.pathElements.map(String),
            in_pathIndices2: path2.pathIndices.map(String),
            isDummy2,
            out_amount1: payAmount.toString(),
            out_pubX1: p.recipientPubX, out_pubY1: p.recipientPubY,
            out_blindness1: payOut.blindness.toString(),
            out_amount2: change.toString(),
            out_pubX2: in1.pubX, out_pubY2: in1.pubY,
            out_blindness2: changeOut.blindness.toString(),
          },
          '/circuits/v3/transfer_v3.wasm', '/circuits/v3/transfer_v3_final.zkey',
        );

        result = {
          proof,
          publicSignals,
          root: path1.root.toString(),
          nullifier1: in1.nullifier,
          nullifier2: in2.nullifier,
          commitment1: payOut.commitment.toString(),
          commitment2: changeOut.commitment.toString(),
          eph1X: payOut.ephemeralX.toString(), eph1Y: payOut.ephemeralY.toString(),
          eph2X: changeOut.ephemeralX.toString(), eph2Y: changeOut.ephemeralY.toString(),
          amountCt1: payOut.amountCipher.toString(),
          amountCt2: changeOut.amountCipher.toString(),
          // What the wallet must persist to keep spending its own change.
          change: {
            commitment: changeOut.commitment.toString(),
            blindness: changeOut.blindness.toString(),
            amountStroops: change.toString(),
            pubX: in1.pubX,
            pubY: in1.pubY,
          },
        };
        break;
      }

      // Rediscover this wallet's OWN deposits. Receipts and change come back
      // through ECDH; a deposit has no sender but the depositor, so it is only
      // recoverable because its blindness is derived from the spend key.
      case 'RECOVER_DEPOSITS': {
        const p = payload as V3RecoverDepositsPayload;
        result = {
          deposits: await recoverOwnDeposits(
            BigInt(p.spendKey), BigInt(p.pubX), BigInt(p.pubY), p.deposits,
          ),
        };
        break;
      }

      case 'SCAN_TRANSFERS_V3': {
        const p = payload as V3ScanPayload;
        result = {
          notes: await scanForIncomingNotesV3(
            BigInt(p.spendKey), BigInt(p.pubX), BigInt(p.pubY), p.transfers,
          ),
        };
        break;
      }

      // Public exit. Unlike withdraw_v2 there is no Merkle path: the commitment
      // is a PUBLIC input, so the pool checks inclusion by direct key lookup.
      // That is also why this proof is much cheaper to produce — worth knowing,
      // because the people who need it are the ones a blocklist has already
      // stopped, and making them wait longest would be perverse.
      case 'PROVE_RAGEQUIT_V2': {
        const p = payload as V2RageQuitPayload;
        const note = await deriveV2Note(p.privKey, p.blindness);
        if (note.commitment !== p.commitment) throw new Error('The local note does not belong to this workspace.');
        const input = {
          commitment: note.commitment,
          nullifier: note.nullifier,
          exit_binding: p.exitBinding,
          privKey: p.privKey,
          blindness: p.blindness,
        };
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          input, '/circuits/v2/ragequit_v2.wasm', '/circuits/v2/ragequit_v2_final.zkey',
        );
        result = { proof, publicSignals, nullifier: note.nullifier, commitment: note.commitment };
        break;
      }

      case 'PROVE_TRANSFER_V2': {
        const p = payload as V2TransferPayload;
        const note = await deriveV2Note(p.privKey, p.blindness);
        if (note.commitment !== p.commitment) throw new Error('The local note does not belong to this workspace.');

        // The ephemeral scalar is drawn INSIDE the worker and never returned.
        // Keeping it would create a way to later prove who sent this payment.
        const out = await deriveOutgoingNote([BigInt(p.recipientPubX), BigInt(p.recipientPubY)]);

        const leaves = p.leaves.map(BigInt);
        const path = await buildMerklePath(leaves, p.leafIndex);
        const input = {
          root: path.root.toString(),
          nullifier: note.nullifier,
          commitment_out: out.commitment.toString(),
          ephemeral_x: out.ephemeralX.toString(),
          ephemeral_y: out.ephemeralY.toString(),
          privKey: p.privKey,
          blindness_in: p.blindness,
          pathElements: path.pathElements.map(String),
          pathIndices: path.pathIndices.map(String),
          out_pubX: p.recipientPubX,
          out_pubY: p.recipientPubY,
          blindness_out: out.blindness.toString(),
        };
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          input, '/circuits/v2/transfer_v2.wasm', '/circuits/v2/transfer_v2_final.zkey',
        );
        result = {
          proof,
          publicSignals,
          nullifier: note.nullifier,
          root: path.root.toString(),
          commitment: out.commitment.toString(),
          ephemeralX: out.ephemeralX.toString(),
          ephemeralY: out.ephemeralY.toString(),
        };
        break;
      }

      case 'SCAN_TRANSFERS_V2': {
        const p = payload as V2ScanPayload;
        result = {
          notes: await scanForIncomingNotes(
            BigInt(p.spendKey), BigInt(p.pubX), BigInt(p.pubY), p.transfers,
          ),
        };
        break;
      }

      // ---- positions ---------------------------------------------------
      // These witness layouts mirror position_open.circom and
      // position_close.circom exactly. Everything the CONTRACT supplies as a
      // public input -- tier, entry price, direction, payout, position id --
      // is passed through unchanged rather than recomputed here. A client that
      // derived its own value would produce a proof that verifies locally and
      // is rejected on-chain, which is precisely the failure mode this vertical
      // kept hitting.

      case 'PROVE_POSITION_OPEN': {
        const p = payload as PositionOpenPayload;

        const privKey = BigInt(p.privKey);
        const inAmount = BigInt(p.collateralStroops);
        const inBlindness = BigInt(p.collateralBlindness);
        const margin = BigInt(p.marginStroops);
        const size = BigInt(p.size);
        const direction = BigInt(p.direction);
        const entryPrice = BigInt(p.entryPrice);
        const positionId = BigInt(p.positionId);

        // Derived, exactly as Note() does inside the circuit. A note whose
        // public key came from anywhere else builds a commitment the proof
        // cannot open.
        const { pubX, pubY } = derivePublicKey(privKey);

        const commitment = await computeCommitment(inAmount, pubX, pubY, inBlindness);
        const nullifier = await computeNullifier(commitment, privKey);

        const leaves = p.leaves.map((x: string) => BigInt(x));
        const { root, pathElements, pathIndices } = await buildMerklePath(leaves, p.leafIndex);

        // Blindness is derived from (spendKey, positionId) rather than drawn at
        // random, so both notes survive losing this browser. See
        // lib/position-notes.ts for why that is safe and why it is necessary.
        const changeAmount = inAmount - margin;
        const changeBlind = BigInt(p.changeBlindness);
        const changeCommitment = await computeCommitment(changeAmount, pubX, pubY, changeBlind);

        const posBlind = BigInt(p.positionBlindness);
        const meta = await poseidon2Hash4(size, direction, entryPrice, posBlind);
        const positionCommitment = await poseidon2Hash4(margin, pubX, pubY, meta);

        const input = {
          root: root.toString(),
          nullifier: nullifier.toString(),
          position_commitment: positionCommitment.toString(),
          change_commitment: changeCommitment.toString(),
          tier_id: p.tierId.toString(),
          entry_price: entryPrice.toString(),
          direction: direction.toString(),
          position_id: positionId.toString(),
          privKey: privKey.toString(),
          in_amount: inAmount.toString(),
          in_blindness: inBlindness.toString(),
          pathElements: pathElements.map((x) => x.toString()),
          pathIndices: pathIndices.map((x) => x.toString()),
          change_amount: changeAmount.toString(),
          change_blindness: changeBlind.toString(),
          position_blindness: posBlind.toString(),
        };

        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          input, '/circuits/position_open.wasm', '/circuits/position_open_final.zkey',
        );

        result = {
          proof,
          publicSignals,
          root: root.toString(),
          nullifier: nullifier.toString(),
          position_commitment: positionCommitment.toString(),
          change_commitment: changeCommitment.toString(),
          change_amount: changeAmount.toString(),
          change_blindness: changeBlind.toString(),
        };
        break;
      }

      case 'PROVE_POSITION_HEALTH': {
        const p = payload as PositionHealthPayload;

        const privKey = BigInt(p.privKey);
        const { pubX, pubY } = derivePublicKey(privKey);
        const margin = BigInt(p.marginStroops);
        const size = BigInt(p.size);
        const direction = BigInt(p.direction);
        const entryPrice = BigInt(p.entryPrice);
        const oraclePrice = BigInt(p.oraclePrice);
        const posBlind = BigInt(p.positionBlindness);

        const meta = await poseidon2Hash4(size, direction, entryPrice, posBlind);
        const positionCommitment = await poseidon2Hash4(margin, pubX, pubY, meta);

        const input = {
          position_commitment: positionCommitment.toString(),
          oracle_price: oraclePrice.toString(),
          oracle_timestamp: p.oracleTimestamp.toString(),
          health_threshold: p.healthThreshold.toString(),
          collateral_amount: margin.toString(),
          size: size.toString(),
          direction: direction.toString(),
          entry_price: entryPrice.toString(),
          privKey: privKey.toString(),
          position_blindness: posBlind.toString(),
          // The sign selector, pinned in-circuit by a range check on the
          // SELECTED delta. Supplying the wrong one forges nothing; it simply
          // fails to prove.
          price_ge_entry: (oraclePrice >= entryPrice ? 1n : 0n).toString(),
        };

        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          input, '/circuits/position_health.wasm', '/circuits/position_health_final.zkey',
        );

        result = { proof, publicSignals, position_commitment: positionCommitment.toString() };
        break;
      }

      case 'PROVE_POSITION_CLOSE': {
        const p = payload as PositionClosePayload;

        const privKey = BigInt(p.privKey);
        const { pubX, pubY } = derivePublicKey(privKey);

        const margin = BigInt(p.marginStroops);
        const size = BigInt(p.size);
        const direction = BigInt(p.direction);
        const entryPrice = BigInt(p.entryPrice);
        const payout = BigInt(p.payoutStroops);
        const fee = BigInt(p.feeStroops);
        const positionId = BigInt(p.positionId);
        const posBlind = BigInt(p.positionBlindness);

        // Recomputed rather than taken from the caller, so it is guaranteed to
        // be the commitment THIS key opens. The contract supplies the stored one
        // as a public input (audit C3); if the two disagree the proof fails,
        // which is the correct outcome and better than proving against a value
        // the chain will not accept.
        const meta = await poseidon2Hash4(size, direction, entryPrice, posBlind);
        const oldPositionCommitment = await poseidon2Hash4(margin, pubX, pubY, meta);
        const positionNullifier = await poseidon2Hash2(oldPositionCommitment, privKey);

        const noteAmount = payout - fee;
        const noteBlind = BigInt(p.payoutBlindness);
        const outputNoteCommitment = await computeCommitment(noteAmount, pubX, pubY, noteBlind);

        const input = {
          position_nullifier: positionNullifier.toString(),
          output_note_commitment: outputNoteCommitment.toString(),
          old_position_commitment: oldPositionCommitment.toString(),
          tier_id: p.tierId.toString(),
          entry_price: entryPrice.toString(),
          direction: direction.toString(),
          payout: payout.toString(),
          fee: fee.toString(),
          position_id: positionId.toString(),
          privKey: privKey.toString(),
          position_blindness: posBlind.toString(),
          note_blindness: noteBlind.toString(),
        };

        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          input, '/circuits/position_close.wasm', '/circuits/position_close_final.zkey',
        );

        result = {
          proof,
          publicSignals,
          position_nullifier: positionNullifier.toString(),
          output_note_commitment: outputNoteCommitment.toString(),
          note_amount: noteAmount.toString(),
          note_blindness: noteBlind.toString(),
        };
        break;
      }

      case 'PROVE_HIDDEN_ORDER_TRIGGER': {
        const p = payload as any;
        
        const trigger_price = BigInt(p.trigger_price);
        const order_direction = BigInt(p.order_direction);
        const salt = BigInt(p.salt);
        
        // order_commitment = Poseidon2(trigger_price, order_direction, salt)
        let commit = await poseidon2Hash2(trigger_price, await poseidon2Hash2(order_direction, salt));
        
        const input = {
          order_commitment: commit.toString(),
          oracle_price: p.oracle_price.toString(),
          meta_hash: p.meta_hash,
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

      case 'PROVE_SEALED_ORDER': {
        const p = payload as any;
        
        const bid_price = BigInt(p.bid_price);
        const bid_size = BigInt(p.bid_size);
        const salt = BigInt(p.salt);
        
        // order_commitment = Poseidon2(bid_price, bid_size, salt)
        let commit = await poseidon2Hash2(bid_price, await poseidon2Hash2(bid_size, salt));
        
        const input = {
          order_commitment: commit.toString(),
          bid_price: bid_price.toString(),
          bid_size: bid_size.toString(),
          salt: salt.toString()
        };

        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          input, '/circuits/sealed_order.wasm', '/circuits/sealed_order_final.zkey'
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
