// ============================================================
// Choosing which notes to spend
// ============================================================
// A V3 transfer consumes exactly two inputs and produces exactly two outputs,
// always, regardless of what the wallet holds. That shape is fixed on purpose:
// the number of nullifiers and commitments is public, so letting it vary with
// the wallet's contents would leak how many notes a sender owns and whether
// they needed change.
//
// So this module answers one question: given the notes on hand and an amount to
// pay, which one or two cover it? A wallet with a single note still transacts,
// by pairing it with a dummy input the circuit prices at zero.
//
// Deliberately free of wallet and network imports so the policy below can be
// tested directly — the selection rule is the part most likely to be wrong in a
// way no type checks.

export interface SelectableNote {
  id: string;
  /** Exact contract amount in stroops. Decimal string; never a JS number. */
  amountStroops: string;
}

export interface NoteSelection<T extends SelectableNote> {
  /** The real notes being spent: one or two. */
  inputs: T[];
  /** True when only one real note is used and input 2 must be a dummy. */
  needsDummy: boolean;
  /** Sum of the selected inputs. */
  total: bigint;
  /** What comes back to the sender: total - amount. May be zero. */
  change: bigint;
}

export class InsufficientNotesError extends Error {
  // Declared explicitly rather than as constructor parameter properties: the
  // test runner strips types without transforming, and parameter properties are
  // a syntax transform, not a type annotation.
  readonly requested: bigint;
  readonly spendable: bigint;
  readonly bestPair: bigint;

  constructor(requested: bigint, spendable: bigint, bestPair: bigint) {
    super(
      spendable < requested
        ? `Not enough shielded balance: ${spendable} stroops available, ${requested} requested.`
        : `No combination of two notes covers ${requested} stroops. ` +
          `The largest two together hold ${bestPair}. Consolidate notes first, ` +
          `or send a smaller amount.`,
    );
    this.name = 'InsufficientNotesError';
    this.requested = requested;
    this.spendable = spendable;
    this.bestPair = bestPair;
  }
}

/**
 * Pick the notes to spend for `amount`.
 *
 * The rule, in order of preference:
 *
 *   1. one note of exactly the amount   — no change note carrying real value
 *   2. the smallest single note that covers it
 *   3. the pair whose total covers it with the least excess
 *
 * Preferring an exact match and then the tightest fit keeps change notes small,
 * which matters because change accumulates: a wallet that always spends its
 * largest note ends up with a long tail of dust it can never combine, since only
 * two inputs fit in a transfer.
 *
 * A single note is preferred over a pair even when a pair fits tighter. Spending
 * two notes retires two and creates two, leaving the wallet no better off, while
 * spending one retires one — so single-input spends are what actually reduce
 * fragmentation over time.
 *
 * This can fail on a wallet that holds enough in total but not in any two notes.
 * That is a real limit of a 2-in circuit and is surfaced as such rather than
 * silently under-paying; the fix is a consolidating self-payment, which is just
 * a transfer to your own address.
 */
export function selectNotes<T extends SelectableNote>(
  notes: T[],
  amount: bigint,
): NoteSelection<T> {
  if (amount <= 0n) throw new Error('Amount must be greater than zero.');

  const usable = notes
    .filter((n) => amountOf(n) > 0n)
    .sort((a, b) => (amountOf(a) < amountOf(b) ? -1 : amountOf(a) > amountOf(b) ? 1 : 0));

  // 1 & 2: smallest single note that covers the amount. Sorted ascending, so
  // the first hit is the tightest fit, and an exact match wins naturally.
  const single = usable.find((n) => amountOf(n) >= amount);
  if (single) {
    const total = amountOf(single);
    return { inputs: [single], needsDummy: true, total, change: total - amount };
  }

  // 3: best pair. Two pointers over the ascending list — the smallest total
  // that still covers the amount.
  let best: { pair: [T, T]; total: bigint } | null = null;
  for (let lo = 0, hi = usable.length - 1; lo < hi; ) {
    const total = amountOf(usable[lo]) + amountOf(usable[hi]);
    if (total >= amount) {
      if (!best || total < best.total) best = { pair: [usable[lo], usable[hi]], total };
      hi -= 1;
    } else {
      lo += 1;
    }
  }
  if (best) {
    return { inputs: best.pair, needsDummy: false, total: best.total, change: best.total - amount };
  }

  const spendable = usable.reduce((sum, n) => sum + amountOf(n), 0n);
  const largestTwo = usable.slice(-2).reduce((sum, n) => sum + amountOf(n), 0n);
  throw new InsufficientNotesError(amount, spendable, largestTwo);
}

/** Total spendable across every note, for balance display. */
export function totalSpendable(notes: SelectableNote[]): bigint {
  return notes.reduce((sum, n) => sum + amountOf(n), 0n);
}

/**
 * The largest amount a single transfer can send. Not the same as the balance:
 * only two notes fit in one transfer, so a fragmented wallet can hold more than
 * it can pay in one go. Showing this is what stops a user hitting a confusing
 * failure after waiting out a proof.
 */
export function maxSendableInOneTransfer(notes: SelectableNote[]): bigint {
  const sorted = notes
    .map(amountOf)
    .filter((a) => a > 0n)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return (sorted[0] ?? 0n) + (sorted[1] ?? 0n);
}

function amountOf(note: SelectableNote): bigint {
  return BigInt(note.amountStroops);
}
