// ============================================================
// Keeper decision logic
// ============================================================
// Pure, so the policy can be tested without a network. The policy is the whole
// service: everything else is transport.
//
// What the previous keeper did, for contrast: it shelled out to
// `stellar contract invoke ... is_stale` once per position, and when a position
// was stale it wrote a JSON flag file. It never liquidated anything. The e2e
// script watched for the file. So the liquidation path had no implementation at
// all outside a test harness.

/** A position as the indexer reports it. */
export interface WatchedPosition {
  position_id: string;
  owner: string;
  tier_id: number;
  is_closed: boolean;
}

/** The on-chain liquidation state of one position. */
export interface EngineView {
  isStale: boolean;
  isLiquidated: boolean;
  secondsUntilStale: number;
  /** Who holds the claim, and since when. Absent when unclaimed. */
  escrow?: { keeper: string; initiatedAt: number };
}

export type Action =
  | { kind: 'skip'; reason: string }
  | { kind: 'initiate' }
  | { kind: 'reveal' };

/** Must match `LiquidationEngineContract::ESCROW_TTL`. */
export const ESCROW_TTL = 900;

/**
 * What this keeper should do about one position, right now.
 *
 * The ordering matters and each branch closes a specific hole:
 *
 * - A liquidated or closed position is finished. Acting on it wastes a fee and,
 *   worse, would look like a bug in the logs.
 *
 * - A position that is not stale must be left alone. This is checked HERE and
 *   again by the contract at reveal time (audit H5): an owner who attests
 *   health between our `initiate` and our `reveal` has done exactly what they
 *   are supposed to, and liquidating them for it punishes the correct
 *   behaviour.
 *
 * - Another keeper's live claim is respected rather than raced. The contract
 *   refuses the overwrite anyway (audit H4), so attempting it only burns fees;
 *   but the claim EXPIRES, so a keeper that initiated and vanished cannot
 *   shield a position forever.
 */
export function decide(
  view: EngineView,
  self: string,
  now: number,
): Action {
  if (view.isLiquidated) {
    return { kind: 'skip', reason: 'already liquidated' };
  }
  if (!view.isStale) {
    return {
      kind: 'skip',
      reason: `healthy; stale in ${view.secondsUntilStale}s`,
    };
  }

  const escrow = view.escrow;
  if (!escrow) {
    return { kind: 'initiate' };
  }
  if (escrow.keeper === self) {
    // Our own claim: finish it. The contract re-checks staleness, so if the
    // owner cured the position in the meantime this reverts harmlessly.
    return { kind: 'reveal' };
  }
  if (now < escrow.initiatedAt + ESCROW_TTL) {
    return {
      kind: 'skip',
      reason: `claimed by ${escrow.keeper.slice(0, 8)}… for another ` +
        `${escrow.initiatedAt + ESCROW_TTL - now}s`,
    };
  }
  // Their claim expired without a reveal. Taking it over is what stops an
  // abandoned claim from blocking liquidation indefinitely.
  return { kind: 'initiate' };
}

/**
 * How long to wait before looking at this position again.
 *
 * Polling every position every few seconds is the obvious implementation and it
 * is wasteful: a position with fifty minutes of grace left will still have
 * forty-nine after a minute of polling. Sleeping until it is nearly due turns
 * an O(positions) RPC load per tick into something closer to O(events).
 *
 * Clamped at both ends: never busier than the floor, never so patient that a
 * newly opened position goes unnoticed for an hour.
 */
export function nextCheckDelay(
  view: EngineView,
  floorSeconds = 15,
  ceilingSeconds = 300,
): number {
  if (view.isLiquidated) return ceilingSeconds;
  if (view.isStale) return floorSeconds;
  // Aim to arrive just after it goes stale, not before.
  const target = Math.max(floorSeconds, view.secondsUntilStale + 1);
  return Math.min(ceilingSeconds, target);
}

/** Positions worth watching at all. */
export function watchable(positions: WatchedPosition[]): WatchedPosition[] {
  return positions.filter((p) => !p.is_closed);
}
