// ============================================================
// Shielded transfer: note handoff without a message
// ============================================================
// A recipient can only spend a note if they know its blindness, but the SENDER
// chooses that blindness. Rather than shipping a ciphertext or asking the two
// parties to exchange anything, the blindness is DERIVED from a Diffie-Hellman
// secret both sides can compute:
//
//   sender     r  = random scalar in [1, l)
//              R  = r·G                        <- published on-chain
//              S  = r·PK_recipient
//              b  = Poseidon2(S.x, 0)
//              C  = Poseidon2_4(1 XLM, PK_recipient, b)
//
//   recipient  S' = spendKey·R  =  spendKey·r·G  =  r·PK_recipient  =  S
//              b' = Poseidon2(S'.x, 0)
//              keeps the events whose C it can reproduce
//
// Nobody without spendKey can compute S, so nobody else can tell which note
// belongs to whom — the sender does not even learn when it is spent.
//
// Worker-safe: no wallet imports, no DOM.

import { BASE8, SUBORDER, inCurve, mulPointEscalar, type Point } from './babyjub';
import { poseidon2Hash2, poseidon2Hash4 } from './poseidon';

export { V2_DENOMINATION_STROOPS as V2_AMOUNT_STROOPS } from './denomination';
import { V2_DENOMINATION_STROOPS as V2_AMOUNT_STROOPS } from './denomination';

/**
 * Domain tag for the ECDH-derived blindness. Shares a namespace with keys.ts,
 * where TAG_SPEND = 1n — keep them distinct so the two derivations can never
 * collide.
 */
const TAG_ECDH_BLINDNESS = 0n;

const IDENTITY: Point = [0n, 1n];

/**
 * A recipient key must be on the curve AND in the prime-order subgroup.
 *
 * The subgroup check is not defensive programming. If a sender publishes an R
 * of small order, the shared secret collapses to one of only 8 possible values,
 * determined by `spendKey mod 8`. An attacker enumerates all 8, publishes the
 * matching note, and if the wallet claims and spends it — visible as a
 * nullifier on-chain — they have learned 3 bits of the recipient's spend key
 * for the price of 1 XLM. The same reasoning applies to a recipient's key.
 */
export function assertUsablePoint(point: Point, label: string): void {
  if (!inCurve(point)) throw new Error(`${label} is not on the BabyJubjub curve.`);
  if (point[0] === IDENTITY[0] && point[1] === IDENTITY[1]) {
    throw new Error(`${label} is the identity point.`);
  }
  const [x, y] = mulPointEscalar(point, SUBORDER);
  if (x !== IDENTITY[0] || y !== IDENTITY[1]) {
    throw new Error(`${label} is not in the prime-order subgroup.`);
  }
}

/** Uniform scalar in [1, l) by rejection sampling — never reduce, that biases. */
export function randomScalar(): bigint {
  for (;;) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let x = 0n;
    for (const b of bytes) x = (x << 8n) | BigInt(b);
    x &= (1n << 251n) - 1n; // l is 251 bits; masking keeps rejection cheap
    if (x > 0n && x < SUBORDER) return x;
  }
}

export interface OutgoingNote {
  ephemeralX: bigint;
  ephemeralY: bigint;
  blindness: bigint;
  commitment: bigint;
}

/**
 * Build the output note for `recipient`. The ephemeral scalar is generated here
 * and never returned — it has no use after this and holding it would only
 * create a way to later prove who sent what.
 */
export async function deriveOutgoingNote(recipient: Point): Promise<OutgoingNote> {
  assertUsablePoint(recipient, 'Recipient key');

  const r = randomScalar();
  const ephemeral = mulPointEscalar(BASE8, r);
  const shared = mulPointEscalar(recipient, r);
  const blindness = await poseidon2Hash2(shared[0], TAG_ECDH_BLINDNESS);
  const commitment = await poseidon2Hash4(
    V2_AMOUNT_STROOPS,
    recipient[0],
    recipient[1],
    blindness,
  );

  return { ephemeralX: ephemeral[0], ephemeralY: ephemeral[1], blindness, commitment };
}

export interface IndexedTransfer {
  commitment: string;
  leafIndex: number;
  ephemeralX: string;
  ephemeralY: string;
  txHash?: string;
}

export interface DiscoveredNote {
  commitment: string;
  blindness: string;
  leafIndex: number;
  ephemeralX: string;
  ephemeralY: string;
  txHash?: string;
}

/**
 * Trial-decrypt every transfer against our own key. Costs one scalar
 * multiplication and two Poseidon2 hashes per event; callers should pass only
 * events newer than their last scan.
 *
 * Events with an unusable R are skipped rather than throwing: one malicious
 * sender must not be able to break scanning for everyone else.
 */
export async function scanForIncomingNotes(
  spendKey: bigint,
  pubX: bigint,
  pubY: bigint,
  transfers: IndexedTransfer[],
): Promise<DiscoveredNote[]> {
  const found: DiscoveredNote[] = [];

  for (const event of transfers) {
    let ephemeral: Point;
    try {
      ephemeral = [BigInt(event.ephemeralX), BigInt(event.ephemeralY)];
      assertUsablePoint(ephemeral, 'Ephemeral point');
    } catch {
      continue;
    }

    const shared = mulPointEscalar(ephemeral, spendKey);
    const blindness = await poseidon2Hash2(shared[0], TAG_ECDH_BLINDNESS);
    const commitment = await poseidon2Hash4(V2_AMOUNT_STROOPS, pubX, pubY, blindness);

    // Commitments arrive from the indexer as hex; compare as field elements so
    // formatting differences can never cause a missed note.
    if (commitment === BigInt(`0x${event.commitment}`)) {
      found.push({
        commitment: commitment.toString(),
        blindness: blindness.toString(),
        leafIndex: event.leafIndex,
        ephemeralX: event.ephemeralX,
        ephemeralY: event.ephemeralY,
        txHash: event.txHash,
      });
    }
  }

  return found;
}
