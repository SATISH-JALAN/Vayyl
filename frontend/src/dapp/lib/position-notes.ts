// ============================================================
// Position note derivation and recovery
// ============================================================
// A position produces two shielded notes the wallet has to be able to find
// again: the CHANGE from the collateral note at open, and the PAYOUT at close.
// Both are ordinary pool notes, so finding one means knowing its blindness --
// and a blindness drawn at random and stored only in this browser is a note
// that vanishes when the browser does.
//
// The payments side solves this with an ephemeral point and an encrypted
// amount published alongside the commitment, because a payment's recipient and
// value are secrets the sender has to transmit. Neither applies here:
//
//   - The recipient is the position's own owner, whose spend key we already
//     have. There is nobody to transmit a key agreement to.
//   - The amount is derivable from PUBLIC event data. `PositionOpen` carries
//     the tier and hence the margin; `PositionClose` carries the payout
//     outright.
//
// So blindness is derived deterministically from (spendKey, position_id) under
// a domain tag, and recovery on a clean device is: read the position events for
// my address, re-derive, recompute the commitment, match it against the pool
// tree. No extra public inputs, no ECDH, and one fewer thing that can be
// tampered with in flight.
//
// The spend key is secret, so the blindness is unpredictable to everyone else,
// which is the only property a blinding factor has to have. The domain tags are
// what stop the three values derived from the same (key, position) pair from
// colliding.

import { poseidon2Hash4, computeCommitment, FIELD_P } from './poseidon';
import { derivePublicKey } from './babyjub';
import { getTier, settlementPayout, type Tier } from './tiers';
import type { ShieldedNote } from './storage';

const TAG_POSITION = 1n;
const TAG_CHANGE = 2n;
const TAG_PAYOUT = 3n;

/**
 * A fresh position id: 32 random bytes reduced into the scalar field.
 *
 * It has to be a CANONICAL field element because the contract passes it
 * straight through as a public input, and the verifier rejects anything at or
 * above the BN254 modulus (audit C1). Generating it as a raw 32-byte value
 * would put roughly one in eight positions into a state where the open reverts
 * with `NonCanonicalFieldElement` for no reason the user can act on.
 */
export function randomPositionId(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x % FIELD_P;
}

/** 32-byte big-endian hex, as the contract client expects. */
export const positionIdHex = (id: bigint): string => id.toString(16).padStart(64, '0');

const deriveBlindness = (spendKey: bigint, positionId: bigint, tag: bigint) =>
  poseidon2Hash4(spendKey, positionId, tag, 0n);

/** Blinding factor for the position commitment itself. */
export const positionBlindness = (spendKey: bigint, positionId: bigint) =>
  deriveBlindness(spendKey, positionId, TAG_POSITION);

/** Blinding factor for the change note returned at open. */
export const changeBlindness = (spendKey: bigint, positionId: bigint) =>
  deriveBlindness(spendKey, positionId, TAG_CHANGE);

/** Blinding factor for the settled payout note minted at close. */
export const payoutBlindness = (spendKey: bigint, positionId: bigint) =>
  deriveBlindness(spendKey, positionId, TAG_PAYOUT);

export interface DerivedNote {
  amountStroops: bigint;
  blindness: bigint;
  commitment: bigint;
}

/**
 * The change note an open produces: the collateral note minus the tier margin.
 *
 * Throws when the note cannot cover the margin. That is a real precondition and
 * catching it here is the difference between a sentence the user can act on and
 * a witness-generation failure deep inside snarkjs: the circuit's conservation
 * constraint would reject it, but only after the user waited for a proof.
 */
export async function deriveChangeNote(
  spendKey: bigint,
  positionId: bigint,
  tier: Tier,
  collateralStroops: bigint,
): Promise<DerivedNote> {
  if (collateralStroops < tier.marginStroops) {
    throw new Error(
      `This note holds ${collateralStroops} stroops but the ${tier.name} tier needs ` +
      `${tier.marginStroops}. Send yourself a larger amount first.`,
    );
  }
  const { pubX, pubY } = derivePublicKey(spendKey);
  const amountStroops = collateralStroops - tier.marginStroops;
  const blindness = await changeBlindness(spendKey, positionId);
  return {
    amountStroops,
    blindness,
    commitment: await computeCommitment(amountStroops, pubX, pubY, blindness),
  };
}

/** The settled note a close produces, for a payout the contract has computed. */
export async function derivePayoutNote(
  spendKey: bigint,
  positionId: bigint,
  payoutStroops: bigint,
  feeStroops: bigint,
): Promise<DerivedNote> {
  if (feeStroops > payoutStroops) {
    throw new Error('The relayer fee is larger than this position settles for.');
  }
  const { pubX, pubY } = derivePublicKey(spendKey);
  const amountStroops = payoutStroops - feeStroops;
  const blindness = await payoutBlindness(spendKey, positionId);
  return {
    amountStroops,
    blindness,
    commitment: await computeCommitment(amountStroops, pubX, pubY, blindness),
  };
}

/** The position commitment, as the circuit computes it. */
export async function derivePositionCommitment(
  spendKey: bigint,
  positionId: bigint,
  tier: Tier,
  direction: 0 | 1,
  entryPrice: bigint,
): Promise<{ commitment: bigint; blindness: bigint }> {
  const { pubX, pubY } = derivePublicKey(spendKey);
  const blindness = await positionBlindness(spendKey, positionId);
  // PositionCommitment = Poseidon2_4(collateral, pubX, pubY,
  //                                  Poseidon2_4(size, direction, entry, blindness))
  const meta = await poseidon2Hash4(tier.size, BigInt(direction), entryPrice, blindness);
  const commitment = await poseidon2Hash4(tier.marginStroops, pubX, pubY, meta);
  return { commitment, blindness };
}

/**
 * One position, as the indexer reports it from public events.
 *
 * Every field here is public on-chain. That is what makes recovery possible
 * without any extra transmitted data -- and it is also the honest statement of
 * what a position does NOT hide.
 */
export interface PositionRecord {
  positionId: string; // decimal or 0x-prefixed hex
  tierId: number;
  direction: 0 | 1;
  entryPrice: string;
  /** Present once the position has closed. */
  payout?: string;
  fee?: string;
  closed: boolean;
}

const asField = (value: string): bigint =>
  value.startsWith('0x') ? BigInt(value) : BigInt(value);

/**
 * Rebuild every note this wallet's positions produced, from public data.
 *
 * This is the clean-device recovery path. Given the position events for an
 * address and that address's spend key, it re-derives the change note of every
 * open and the payout note of every close -- enough to locate them in the pool
 * tree and spend them.
 *
 * Notes whose amount is zero are skipped: they are valid leaves but carry
 * nothing, and listing them would show a wallet full of empty entries.
 */
export async function recoverPositionNotes(
  spendKey: bigint,
  positions: PositionRecord[],
  collateralOf: (positionId: string) => bigint | undefined,
): Promise<Array<DerivedNote & { positionId: string; source: 'change' | 'payout' }>> {
  const out: Array<DerivedNote & { positionId: string; source: 'change' | 'payout' }> = [];

  for (const p of positions) {
    const id = asField(p.positionId);
    const tier = getTier(p.tierId);

    const collateral = collateralOf(p.positionId);
    if (collateral !== undefined && collateral > tier.marginStroops) {
      const change = await deriveChangeNote(spendKey, id, tier, collateral);
      if (change.amountStroops > 0n) out.push({ ...change, positionId: p.positionId, source: 'change' });
    }

    if (p.closed && p.payout !== undefined) {
      const payout = await derivePayoutNote(
        spendKey,
        id,
        BigInt(p.payout),
        BigInt(p.fee ?? '0'),
      );
      if (payout.amountStroops > 0n) out.push({ ...payout, positionId: p.positionId, source: 'payout' });
    }
  }

  return out;
}

/** Shape a derived note for the wallet's note store. */
export function asShieldedNote(
  note: DerivedNote,
  spendKey: bigint,
  pool: string,
  source: 'change' | 'payout',
  txHash?: string,
): ShieldedNote {
  const { pubX, pubY } = derivePublicKey(spendKey);
  return {
    id: note.commitment.toString(),
    amount: Number(note.amountStroops) / 1e7,
    amountStroops: note.amountStroops.toString(),
    asset: 'XLM',
    protocol: 'v3',
    pool,
    commitment: note.commitment.toString(),
    // Filled in by the wallet once it can compute it; the store recomputes the
    // nullifier from (commitment, spendKey) when the note is first written.
    nullifier: '0',
    pubX: pubX.toString(),
    pubY: pubY.toString(),
    blindness: note.blindness.toString(),
    // -1 until the indexer reports where the leaf landed. The tree source
    // resolves it before proving; a wrong index produces a Merkle path that
    // opens to a root the pool never had.
    leafIndex: -1,
    isSpent: false,
    source: source === 'change' ? 'change' : 'received',
    createdAt: Date.now(),
    txHash,
  };
}

/** Estimate a position's current value, for display only. */
export const quoteLocally = settlementPayout;
