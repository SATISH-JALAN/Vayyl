// ============================================================
// Position tiers
// ============================================================
// Collateral and size are PUBLIC constants chosen from a small table, not
// amounts the user types. Two reasons, and they pull in the same direction:
//
//   - The counterparty vault has to reserve real capital against the best case
//     of every open position. It can only do that if the best case is knowable
//     without opening the commitment, which means the size must be public.
//   - Every position in a tier looks identical on-chain. That IS the anonymity
//     set. A free-form size field would make each position uniquely
//     identifiable by its own numbers.
//
// THESE VALUES ARE MIRRORED IN THREE PLACES and must be identical in all:
//
//   contracts/vayyl-types/src/lib.rs   TIER_MARGIN / TIER_SIZE / TIER_MAX_PAYOUT
//   circuits/lib/tiers.circom          TierConstants
//   frontend/src/dapp/lib/tiers.ts     this file
//
// A mismatch does not error anywhere. The contract builds a public input from
// its table, the circuit constrains against its own, and the pairing check
// simply fails -- on-chain, after the user has paid for a proof, with nothing
// in the failure that points at the cause. `tiers.test.ts` reads all three
// files and compares them, so a drift fails the test run instead.

export interface Tier {
  id: number;
  name: string;
  /** Collateral required, in stroops. Exactly what the position locks up. */
  marginStroops: bigint;
  /** Position size, in contract units. */
  size: bigint;
  /** The most this position can ever pay out, margin included. */
  maxPayoutStroops: bigint;
}

export const TIERS: Tier[] = [
  {
    id: 0,
    name: 'Starter',
    marginStroops: 100_000_000n,
    size: 30n,
    maxPayoutStroops: 300_000_000n,
  },
  {
    id: 1,
    name: 'Standard',
    marginStroops: 500_000_000n,
    size: 150n,
    maxPayoutStroops: 1_500_000_000n,
  },
];

export const getTier = (id: number): Tier => {
  const tier = TIERS.find((t) => t.id === id);
  if (!tier) throw new Error(`Unknown position tier ${id}`);
  return tier;
};

/**
 * What the vault must set aside while this position is open: the profit it may
 * owe beyond the trader's own margin.
 */
export const tierReserve = (tier: Tier): bigint => tier.maxPayoutStroops - tier.marginStroops;

/**
 * The settled value of a position, in stroops.
 *
 * A deliberate reimplementation of `settlement_payout` in
 * `contracts/position-manager/src/lib.rs`. Kept in sync because the UI must
 * quote the number the contract will actually compute; where it matters the
 * store reads `quote_payout` from the contract instead of trusting this, and
 * this exists for the cases where showing a live estimate beats a round trip
 * (a slider, a hover, a preview before the position exists).
 */
export function settlementPayout(
  tier: Tier,
  direction: 0 | 1,
  entryPrice: bigint,
  closePrice: bigint,
): bigint {
  const delta = direction === 1 ? closePrice - entryPrice : entryPrice - closePrice;
  const raw = tier.marginStroops + tier.size * delta;
  if (raw < 0n) return 0n;
  if (raw > tier.maxPayoutStroops) return tier.maxPayoutStroops;
  return raw;
}

/**
 * The price at which a position knocks out (upside) or is wiped out (downside).
 *
 * Both are real, published limits of the product, and the UI is required to
 * show them. A trader who discovers the cap at settlement has been misled: past
 * it a winning position simply stops earning.
 */
export function priceBounds(
  tier: Tier,
  direction: 0 | 1,
  entryPrice: bigint,
): { knockOut: bigint; wipeOut: bigint } {
  // Rounded UP, not down. `size` rarely divides the margin evenly, and flooring
  // would return a price at which the position has not quite knocked out and
  // has not quite been wiped out -- so the two numbers the UI presents as hard
  // limits would each be one tick short of true. Rounding up makes each bound
  // the first price at which the stated thing has actually happened.
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  const upside = ceilDiv(tier.maxPayoutStroops - tier.marginStroops, tier.size);
  const downside = ceilDiv(tier.marginStroops, tier.size);
  return direction === 1
    ? { knockOut: entryPrice + upside, wipeOut: entryPrice - downside }
    : { knockOut: entryPrice - upside, wipeOut: entryPrice + downside };
}

/**
 * Leverage at a given entry price, as a plain multiple.
 *
 * Leverage FLOATS, because what a tier fixes is the size, not the notional. At
 * a price of 1 XLM per unit both tiers are 3x; at half that they are 1.5x. The
 * UI must show the number for the live price rather than a fixed label, or it
 * will be wrong most of the time.
 */
export function leverageAt(tier: Tier, entryPrice: bigint): number {
  if (entryPrice <= 0n) return 0;
  const notional = tier.size * entryPrice;
  return Number(notional) / Number(tier.marginStroops);
}
