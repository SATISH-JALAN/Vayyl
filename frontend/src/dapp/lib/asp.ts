// ============================================================
// Association Set Provider reads
// ============================================================
// Two contracts, both deployed and both read-only from the app's side:
//
//   asp-membership      — the allow-list. A deposit proves its commitment is a
//                         leaf of THIS tree, so its root is a public input to
//                         the deposit circuit.
//   asp-non-membership  — the deny-list, proved the other way round.
//
// THEIR INTERFACES ARE NOT THE SAME, which is the trap here. The allow-list
// counts with `leaf_count`, the deny-list with `blocked_count`, and the
// deny-list's membership predicate is `is_not_blocked` — inverted. Calling the
// wrong name does not return zero: the host aborts with
// Error(WasmVm, MissingValue), so a shared code path silently reports the whole
// set as unreachable. That is exactly what happened the first time.
//
// Everything here is a simulated read: no signature, no fee, no wallet. That is
// the point of the page it feeds — anyone can check the roots the app claims
// against the ledger without connecting anything.

import { xdr } from '@stellar/stellar-sdk';

import { simulateRead, V2_ASP_MEMBERSHIP_ID } from './pool';

export const ASP_NON_MEMBERSHIP_ID = process.env.NEXT_PUBLIC_ASP_NON_MEMBERSHIP || '';

export interface AspSet {
  /** Which contract answered, so the reading can be checked on an explorer. */
  contractId: string;
  root: string;
  count: number;
  /** What the count counts, since the two sets do not count the same thing. */
  countLabel: string;
}

export interface AspState {
  membership: AspSet | null;
  nonMembership: AspSet | null;
  /** Per-set failure text. A set that did not answer is not a set with zero leaves. */
  errors: { membership: string | null; nonMembership: string | null };
}

const hex = (value: unknown): string => {
  if (typeof value === 'string') return value.startsWith('0x') ? value.slice(2) : value;
  if (value instanceof Uint8Array) {
    return Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Never render "[object Object]" as a Merkle root — a root that looks wrong is
  // less dangerous than one that looks plausible and is not a root at all.
  return '';
};

/** 32 raw bytes from a hex commitment. */
function leafScVal(hexLeaf: string): xdr.ScVal {
  // Built here rather than reusing pool.ts's `bytesN`, which takes a DECIMAL
  // field-element string. Feeding it hex would produce a valid-looking 32-byte
  // leaf that is not the one asked about, and the answer would be a confident
  // "not enrolled".
  return xdr.ScVal.scvBytes(Buffer.from(hexLeaf, 'hex'));
}

async function readSet(
  contractId: string,
  countMethod: string,
  countLabel: string,
): Promise<AspSet> {
  if (!contractId) throw new Error('No contract address configured');
  const [root, count] = await Promise.all([
    simulateRead(contractId, 'root', []),
    simulateRead(contractId, countMethod, []),
  ]);
  const rootHex = hex(root);
  if (!rootHex) throw new Error('Contract returned a root in an unexpected shape');
  return { contractId, root: rootHex, count: Number(count), countLabel };
}

/**
 * Read both sets.
 *
 * Settled independently: the deny-list being unreachable says nothing about the
 * allow-list, and collapsing both into one failure would hide a working half.
 */
export async function fetchAspState(): Promise<AspState> {
  const [membership, nonMembership] = await Promise.allSettled([
    readSet(V2_ASP_MEMBERSHIP_ID, 'leaf_count', 'Enrolled leaves'),
    readSet(ASP_NON_MEMBERSHIP_ID, 'blocked_count', 'Blocked entries'),
  ]);

  return {
    membership: membership.status === 'fulfilled' ? membership.value : null,
    nonMembership: nonMembership.status === 'fulfilled' ? nonMembership.value : null,
    errors: {
      membership: membership.status === 'rejected' ? String(membership.reason) : null,
      nonMembership: nonMembership.status === 'rejected' ? String(nonMembership.reason) : null,
    },
  };
}

export interface CommitmentStatus {
  /** In the allow-list. Null when that contract did not answer. */
  enrolled: boolean | null;
  /** On the deny-list. Null when that contract did not answer. */
  blocked: boolean | null;
}

/** Normalise and validate a commitment the user typed. */
export function normaliseLeaf(input: string): string {
  const clean = input.trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error('A commitment is 64 hex characters (32 bytes).');
  }
  return clean.toLowerCase();
}

/**
 * Ask both sets about one commitment.
 *
 * Answered independently and reported as null on failure rather than false.
 * "Not blocked" and "we could not ask whether it is blocked" are different
 * answers, and on a compliance page conflating them is the whole problem.
 */
export async function checkCommitment(input: string): Promise<CommitmentStatus> {
  const leaf = leafScVal(normaliseLeaf(input));

  const [enrolled, notBlocked] = await Promise.allSettled([
    simulateRead(V2_ASP_MEMBERSHIP_ID, 'is_member', [leaf]),
    // NOTE the inversion: the deny-list answers "is_not_blocked".
    simulateRead(ASP_NON_MEMBERSHIP_ID, 'is_not_blocked', [leaf]),
  ]);

  return {
    enrolled: enrolled.status === 'fulfilled' ? Boolean(enrolled.value) : null,
    blocked: notBlocked.status === 'fulfilled' ? !notBlocked.value : null,
  };
}
