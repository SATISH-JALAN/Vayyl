// ============================================================
// Relayer set: selection and timing defences
// ============================================================
// The circuits hide WHICH note a spend consumes. The network layer can hand
// that back in three different ways, and all three are addressed here.
//
//   1. FEE PAYER. With a single relayer, every withdrawal shares one source
//      account, so an observer clusters the entire user base by fee payer
//      without touching the cryptography. A set with client-side random
//      selection breaks the cluster.
//
//   2. TIMING. A withdrawal submitted moments after its deposit is linkable by
//      inspection. A randomised delay decorrelates the two.
//
//   3. SHAPE. One transaction per withdrawal keeps a one-to-one correspondence
//      an observer can count. Batching is the answer, and it lives in the
//      contract because Soroban permits exactly one InvokeHostFunction per
//      transaction (`withdraw_v3_batch`).
//
// Relayers stay stateless with respect to funds: they pay fees and never hold
// note secrets or take custody. Adding operators therefore adds privacy without
// adding trust, which is what makes an open set safe to run.
//
// Free of wallet and DOM imports so the selection and timing policy is testable.

/** Randomness seam. Tests inject a deterministic source; production uses WebCrypto. */
export interface RandomSource {
  /** Uniform float in [0, 1). */
  next(): number;
}

export const cryptoRandom: RandomSource = {
  next() {
    // Not Math.random: this decides which operator sees a payment and how long
    // it is held, so it should not come from a predictable PRNG.
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] / 2 ** 32;
  },
};

/**
 * Parse the configured relayer set.
 *
 * Duplicates are collapsed, because a URL listed twice would be selected twice
 * as often and quietly weight the distribution toward one operator.
 */
export function parseRelayerSet(configured: string | undefined, fallback: string): string[] {
  const entries = (configured ?? '')
    .split(',')
    .map((url) => url.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const unique = [...new Set(entries)];
  return unique.length > 0 ? unique : [fallback.replace(/\/$/, '')];
}

/**
 * Pick a relayer uniformly at random.
 *
 * Uniform rather than round-robin or least-recently-used on purpose: any
 * stateful policy is itself a pattern, and a determined observer can learn it
 * and undo the mixing. Uniform selection has no state to learn.
 */
export function selectRelayer(relayers: string[], random: RandomSource = cryptoRandom): string {
  if (relayers.length === 0) throw new Error('No relayer is configured.');
  return relayers[Math.floor(random.next() * relayers.length) % relayers.length];
}

export interface DelayPolicy {
  /** Lower bound in milliseconds. */
  minMs: number;
  /** Upper bound in milliseconds, inclusive. */
  maxMs: number;
}

/**
 * A withdrawal delay drawn uniformly from the policy window.
 *
 * Uniform, not exponential or "average N seconds". A distribution with a mode
 * hands an observer a most-likely offset to correlate against; a uniform draw
 * over a wide window gives every offset equal weight. The window should be wide
 * relative to how often the pool sees activity, since a delay that is long in
 * seconds but short in *transactions* mixes nothing.
 */
export function drawDelayMs(policy: DelayPolicy, random: RandomSource = cryptoRandom): number {
  const { minMs, maxMs } = policy;
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || minMs < 0 || maxMs < minMs) {
    throw new Error('Invalid delay policy.');
  }
  if (maxMs === minMs) return minMs;
  return minMs + Math.floor(random.next() * (maxMs - minMs + 1));
}

/**
 * Honest description of what a given policy buys, for display.
 *
 * A user told only "your withdrawal is delayed" cannot judge whether that helps.
 * A delay only mixes if other transactions land inside the window, so the
 * message says so rather than implying that waiting alone confers privacy.
 */
export function describeDelay(delayMs: number, unspentNotes: number | null): string {
  const seconds = Math.round(delayMs / 1000);
  const window = seconds >= 120 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`;
  if (unspentNotes !== null && unspentNotes < 2) {
    return `Holding for ${window}. With ${unspentNotes} other note${unspentNotes === 1 ? '' : 's'} ` +
      `in the pool, the delay alone will not hide this withdrawal.`;
  }
  return `Holding for ${window} so this withdrawal does not line up with your deposit.`;
}
