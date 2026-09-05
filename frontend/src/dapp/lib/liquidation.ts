// ============================================================
// Liquidation price and margin health
// ============================================================
// Both numbers here are read off ONE inequality -- the solvency constraint in
// `circuits/position_health.circom`, which is also what `PositionManager`
// enforces via HEALTH_THRESHOLD:
//
//   HEALTH_SCALE*(collateral + gain) >= HEALTH_SCALE*loss + size*price*threshold
//
// `gain` and `loss` are the two halves of the same signed PnL, so the whole
// thing collapses to
//
//   HEALTH_SCALE*(collateral + pnl) >= size*price*threshold
//
// with pnl = (price - entry)*size for a long and (entry - price)*size for a
// short. Everything below is that line rearranged, in integer arithmetic.
//
// Why derive it rather than approximate it: a liquidation price the UI is even
// slightly wrong about is worse than none. Show a number a shade too generous
// and a trader who is watching it gets seized while the screen says they are
// fine. Both bounds are therefore rounded TOWARDS the trader being liquidated
// sooner, so the displayed price is the first one at which they are genuinely
// still safe.
//
// These constants mirror `contracts/position-manager/src/lib.rs`. They are not
// in the tier table, so `tiers.test.ts` does not cover them -- if the contract
// changes HEALTH_THRESHOLD, this file has to change with it.

import type { Tier } from './tiers';

/** Mirrors HEALTH_SCALE in position_health.circom. */
export const HEALTH_SCALE = 10_000n;

/** Mirrors PositionManager::HEALTH_THRESHOLD -- 500 = 5% of notional. */
export const HEALTH_THRESHOLD = 500n;

/**
 * Mirrors PositionManager::MAX_ORACLE_AGE, in seconds.
 *
 * Past this the contract refuses to open, attest or close. The UI shows the
 * live age against it so a user who suddenly cannot transact can see why,
 * instead of reading a bare `StaleOracle` as a broken contract.
 */
export const MAX_ORACLE_AGE = 300;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * Signed profit or loss at a given price, in stroops.
 *
 * Uncapped on purpose. The knock-out cap belongs to settlement
 * (`settlementPayout`); health is judged on the real position, and clamping
 * here would make a knocked-out long look like it was still gaining.
 */
export function pnlAt(tier: Tier, direction: 0 | 1, entryPrice: bigint, price: bigint): bigint {
  const delta = direction === 1 ? price - entryPrice : entryPrice - price;
  return delta * tier.size;
}

/** Collateral plus PnL: what the position is actually worth right now. */
export function equityAt(tier: Tier, direction: 0 | 1, entryPrice: bigint, price: bigint): bigint {
  return tier.marginStroops + pnlAt(tier, direction, entryPrice, price);
}

/**
 * The price at which the position stops being attestable.
 *
 * At this price the health proof still succeeds; one tick past it, in the
 * direction that hurts, the owner can no longer produce a proof, their
 * heartbeat goes stale and a keeper may seize after the grace window.
 *
 * Returns null when no positive price triggers it -- a short's equity grows as
 * the price falls, and if the collateral is large enough relative to the size,
 * the constraint holds everywhere in [0, inf). Callers must render that as "no
 * liquidation price", never as zero, which would read as "liquidates at any
 * price".
 */
export function liquidationPrice(tier: Tier, direction: 0 | 1, entryPrice: bigint): bigint | null {
  const S = tier.size;
  const C = tier.marginStroops;
  const T = HEALTH_THRESHOLD;
  const H = HEALTH_SCALE;

  if (S <= 0n) return null;

  if (direction === 1) {
    // H*C + H*S*(p - e) >= T*S*p  ->  p*(H - T)*S >= H*S*e - H*C
    const numerator = H * S * entryPrice - H * C;
    const denominator = (H - T) * S;
    if (numerator <= 0n) return null; // healthy down to a price of zero
    // Round UP: the boundary must be a price that is still healthy.
    return ceilDiv(numerator, denominator);
  }

  // Short: H*C + H*S*(e - p) >= T*S*p  ->  p*(H + T)*S <= H*C + H*S*e
  const numerator = H * C + H * S * entryPrice;
  const denominator = (H + T) * S;
  // Round DOWN, same reason in the opposite direction.
  return numerator / denominator;
}

export interface MarginHealth {
  /** Collateral + PnL, in stroops. Can be negative on a losing position. */
  equity: bigint;
  /** What the maintenance margin requires at this price, in stroops. */
  required: bigint;
  /**
   * Equity as a fraction of notional, in HEALTH_SCALE units, so it is directly
   * comparable to HEALTH_THRESHOLD. Null when notional is zero.
   */
  ratio: bigint | null;
  /** Whether a health proof would be accepted at this price right now. */
  healthy: boolean;
}

/**
 * Margin health at a price.
 *
 * `price` must be the ORACLE price -- the one the contract reads and the keeper
 * acts on. Feeding a market price from an exchange here would produce a health
 * bar that disagrees with the chain about whether a position is about to be
 * seized.
 */
export function marginHealth(
  tier: Tier,
  direction: 0 | 1,
  entryPrice: bigint,
  price: bigint,
): MarginHealth {
  const equity = equityAt(tier, direction, entryPrice, price);
  const notional = tier.size * price;
  const required = (notional * HEALTH_THRESHOLD) / HEALTH_SCALE;
  const healthy = HEALTH_SCALE * equity >= notional * HEALTH_THRESHOLD;
  const ratio = notional > 0n ? (equity * HEALTH_SCALE) / notional : null;
  return { equity, required, ratio, healthy };
}

/**
 * How far the price may move before liquidation, as a percentage of the current
 * price. Null whenever the liquidation price is unreachable or the current
 * price is unknown.
 */
export function distanceToLiquidation(
  tier: Tier,
  direction: 0 | 1,
  entryPrice: bigint,
  price: bigint,
): number | null {
  const liq = liquidationPrice(tier, direction, entryPrice);
  if (liq === null || price <= 0n) return null;
  const gap = direction === 1 ? price - liq : liq - price;
  return (Number(gap) / Number(price)) * 100;
}
