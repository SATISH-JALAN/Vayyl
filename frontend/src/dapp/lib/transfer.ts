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

// ============================================================
// V3: the amount has to travel with the note
// ============================================================
// The V2 handoff above works because the amount was a constant everyone knew.
// With arbitrary amounts the recipient cannot reproduce
// `C = Poseidon2_4(amount, PK, b)` without knowing `amount`, so a note whose
// value was never transmitted is a note nobody can ever find or spend. Hiding
// the amount from its own owner is not privacy.
//
// Each output therefore publishes its amount under a one-time pad drawn from
// the same ECDH secret, with a DIFFERENT domain tag:
//
//     amount_ct = amount + Poseidon2(S.x, TAG_ECDH_AMOUNT)   (mod p)
//
// The tags must differ. Sharing one would make the pad equal the blindness,
// which is published inside the commitment — the amount would be recoverable by
// anyone. The pad is uniform over the field and S is fresh per transfer, so the
// ciphertext on its own reveals nothing.

/** BN254 scalar field order; the pad arithmetic is modulo this. */
const FIELD_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Domain tag for the ECDH-derived amount pad. MUST differ from the blindness tag. */
const TAG_ECDH_AMOUNT = 1n;

export interface OutgoingNoteV3 extends OutgoingNote {
  /** `amount + pad (mod p)`, published on-chain and bound into the proof. */
  amountCipher: bigint;
  amount: bigint;
}

/**
 * Build an output note of an arbitrary amount for `recipient`.
 *
 * Used for BOTH outputs of a transfer: the payment, where `recipient` is the
 * payee, and the change, where `recipient` is the sender's own key. Treating
 * them identically is what lets one rescan routine recover everything a wallet
 * owns, including change it sent to itself.
 */
export async function deriveOutgoingNoteV3(
  recipient: Point,
  amount: bigint,
): Promise<OutgoingNoteV3> {
  assertUsablePoint(recipient, 'Recipient key');
  if (amount < 0n) throw new Error('Note amount cannot be negative.');

  const r = randomScalar();
  const ephemeral = mulPointEscalar(BASE8, r);
  const shared = mulPointEscalar(recipient, r);
  const blindness = await poseidon2Hash2(shared[0], TAG_ECDH_BLINDNESS);
  const commitment = await poseidon2Hash4(amount, recipient[0], recipient[1], blindness);
  const pad = await poseidon2Hash2(shared[0], TAG_ECDH_AMOUNT);

  return {
    ephemeralX: ephemeral[0],
    ephemeralY: ephemeral[1],
    blindness,
    commitment,
    amount,
    amountCipher: (amount + pad) % FIELD_P,
  };
}

// ============================================================
// Deposits have to be re-derivable too
// ============================================================
// A received note and a change note are both recoverable on a clean device,
// because the sender's ephemeral point is on-chain and the blindness comes out
// of ECDH. A DEPOSIT is not: the depositor picks its blindness themselves, and
// if that is a random value held only in browser storage then clearing the
// profile destroys the note. "Recover your balance from your wallet alone" is
// false the moment any of that balance sits in an unspent deposit.
//
// So deposit blindness is derived, not drawn:
//
//     blindness_i = Poseidon2(spendKey, TAG_DEPOSIT + i)
//
// for the wallet's i-th deposit. A rescan re-derives the sequence and matches it
// against the deposits the indexer reports, whose amounts are public on-chain.
// Nothing is weakened: the value is still unpredictable to anyone without the
// spend key, and it is now reproducible by the one person who should be able to.
//
// The offset keeps this clear of TAG_ECDH_BLINDNESS (0), TAG_ECDH_AMOUNT (1)
// and keys.ts's TAG_SPEND (1), which share the Poseidon2 namespace.
const TAG_DEPOSIT = 1_000_000n;

/** Blindness for the wallet's `index`-th deposit. Deterministic by design. */
export async function deriveDepositBlindness(spendKey: bigint, index: number): Promise<bigint> {
  if (!Number.isInteger(index) || index < 0) throw new Error('Deposit index must be a non-negative integer.');
  return poseidon2Hash2(spendKey, TAG_DEPOSIT + BigInt(index));
}

/** A deposit leaf as the indexer reports it. The amount is public on-chain. */
export interface IndexedDeposit {
  commitment: string;
  leafIndex: number;
  /** Decimal stroops, from the Deposit event. */
  amountStroops: string;
  txHash?: string;
}

export interface RecoveredDeposit {
  commitment: string;
  blindness: string;
  amountStroops: string;
  leafIndex: number;
  /** Which deposit of this wallet it was; needed to continue the sequence. */
  depositIndex: number;
  txHash?: string;
}

/**
 * Rediscover this wallet's own deposits from public data plus the spend key.
 *
 * `maxIndex` bounds the search. It has to exist because the sequence is
 * unbounded in principle, and it is generous rather than tight: stopping at the
 * first miss would be wrong, since a wallet can deposit, spend, and deposit
 * again, leaving gaps in which indices are still unspent.
 */
export async function recoverOwnDeposits(
  spendKey: bigint,
  pubX: bigint,
  pubY: bigint,
  deposits: IndexedDeposit[],
  maxIndex = 64,
): Promise<RecoveredDeposit[]> {
  // Precompute the candidate blindnesses once, then match every deposit against
  // them: the alternative rehashes the whole sequence per leaf.
  const candidates: bigint[] = [];
  for (let i = 0; i <= maxIndex; i++) candidates.push(await deriveDepositBlindness(spendKey, i));

  const found: RecoveredDeposit[] = [];
  for (const deposit of deposits) {
    const target = BigInt(`0x${deposit.commitment.replace(/^0x/, '')}`);
    const amount = BigInt(deposit.amountStroops);
    for (let i = 0; i < candidates.length; i++) {
      if ((await poseidon2Hash4(amount, pubX, pubY, candidates[i])) !== target) continue;
      found.push({
        commitment: target.toString(),
        blindness: candidates[i].toString(),
        amountStroops: deposit.amountStroops,
        leafIndex: deposit.leafIndex,
        depositIndex: i,
        txHash: deposit.txHash,
      });
      break;
    }
  }
  return found;
}

export interface IndexedTransferV3 {
  commitment: string;
  leafIndex: number;
  ephemeralX: string;
  ephemeralY: string;
  /** Hex, from the event. */
  amountCipher: string;
  txHash?: string;
}

export interface DiscoveredNoteV3 extends DiscoveredNote {
  /** Recovered plaintext amount, in stroops. */
  amountStroops: string;
}

/**
 * Trial-decrypt V3 transfer outputs against our own key.
 *
 * Unlike the V2 scan this must recover the amount BEFORE it can check the
 * commitment, because the amount is an input to the commitment. A wrong
 * candidate simply fails to reproduce the commitment, which is the same
 * all-or-nothing match as before.
 *
 * A recovered amount is rejected if it does not fit in 64 bits. The circuits
 * range-check every amount, so no legitimate note can exceed that; a larger
 * value means the sender constructed the ciphertext wrongly, and storing it
 * would leave the wallet holding a note it can never prove.
 */
export async function scanForIncomingNotesV3(
  spendKey: bigint,
  pubX: bigint,
  pubY: bigint,
  transfers: IndexedTransferV3[],
): Promise<DiscoveredNoteV3[]> {
  const found: DiscoveredNoteV3[] = [];

  for (const event of transfers) {
    let ephemeral: Point;
    try {
      ephemeral = [BigInt(event.ephemeralX), BigInt(event.ephemeralY)];
      assertUsablePoint(ephemeral, 'Ephemeral point');
    } catch {
      // One malicious sender must not be able to break scanning for everyone.
      continue;
    }

    const shared = mulPointEscalar(ephemeral, spendKey);
    const blindness = await poseidon2Hash2(shared[0], TAG_ECDH_BLINDNESS);
    const pad = await poseidon2Hash2(shared[0], TAG_ECDH_AMOUNT);
    const cipher = BigInt(`0x${event.amountCipher.replace(/^0x/, '')}`);
    const amount = (cipher - pad + FIELD_P) % FIELD_P;
    if (amount >= 1n << 64n) continue;

    const commitment = await poseidon2Hash4(amount, pubX, pubY, blindness);
    if (commitment !== BigInt(`0x${event.commitment}`)) continue;

    found.push({
      commitment: commitment.toString(),
      blindness: blindness.toString(),
      amountStroops: amount.toString(),
      leafIndex: event.leafIndex,
      ephemeralX: event.ephemeralX,
      ephemeralY: event.ephemeralY,
      txHash: event.txHash,
    });
  }

  return found;
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
