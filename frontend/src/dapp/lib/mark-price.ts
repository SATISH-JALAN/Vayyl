// ============================================================
// Mark price: oracle stroops -> USD
// ============================================================
// The chart is quoted in USD (~0.18). The oracle is quoted in stroops of
// collateral per contract unit (~10,000,000, i.e. ~1.0 after scaling). Those
// are DIFFERENT QUANTITIES, and treating one as the other is not a rounding
// problem -- it puts the line an order of magnitude off the price scale.
//
// That is exactly the bug this module exists to fix. The chart previously drew
// the oracle level as `Number(oraclePrice) / 1e7`, which is ~1.0 on an axis
// running from 0.16 to 0.20. It was never visible in the right place, and
// because a chart always renders something, nothing complained.
//
// The conversion is the exact inverse of `rebase()` in scripts/push_price.mjs:
//
//     rebase:  oraclePrice = START_PRICE * (marketNow / marketAnchor)
//     inverse: marketNow   = marketAnchor * oraclePrice / START_PRICE
//
// IT ONLY HOLDS IN MARKET-TRACKING MODE. Under `--synthetic` or `--fixed` the
// published price is not derived from any market, so the inverse would produce
// a USD figure that no market ever printed. There is no way to detect that
// from the price alone, which is why the anchor -- written only by the
// market-tracking path -- is the signal. No anchor, no conversion, no line.

/** Mirrors START_PRICE in scripts/push_price.mjs. */
export const START_PRICE = 10_000_000n;

export interface PriceAnchor {
  /** The XLM/USD spot price at the moment the anchor was set. */
  market: number;
  /** ISO timestamp, for display and for judging how old the anchor is. */
  anchoredAt: string;
}

/**
 * Convert an oracle price to USD.
 *
 * Returns null -- never 0 -- when the conversion cannot be made. A zero would
 * render as a settlement price of $0.0000, which reads as "this position is
 * about to be wiped out" rather than "this number is unknown". Callers must
 * treat null as "draw nothing and say why".
 */
export function markUsd(oraclePrice: bigint | null, anchor: PriceAnchor | null): number | null {
  if (oraclePrice === null || anchor === null) return null;
  if (oraclePrice <= 0n) return null;
  if (!Number.isFinite(anchor.market) || anchor.market <= 0) return null;

  // The bigint stays whole until the final step. Every price the contract deals
  // in is an integer, and the rounding in `liquidationPrice` is deliberately
  // biased toward the trader being liquidated sooner -- converting earlier and
  // computing in floats would quietly erase that bias.
  return (anchor.market * Number(oraclePrice)) / Number(START_PRICE);
}

/**
 * The inverse, for turning a USD figure back into the contract's unit.
 *
 * Used only for display symmetry (showing what a USD level means in XLM/unit).
 * Never use it to produce a value that is fed to a proof or a contract call --
 * those must come from the chain, not from a round trip through a float.
 */
export function usdToOracle(usd: number, anchor: PriceAnchor | null): bigint | null {
  if (anchor === null || !Number.isFinite(usd) || usd <= 0) return null;
  if (!Number.isFinite(anchor.market) || anchor.market <= 0) return null;
  return BigInt(Math.round((usd / anchor.market) * Number(START_PRICE)));
}

/** Parse an anchor from an untrusted source (the API response or an env var). */
export function parseAnchor(raw: unknown): PriceAnchor | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const market = typeof a.market === 'number' ? a.market : Number(a.market);
  if (!Number.isFinite(market) || market <= 0) return null;
  return {
    market,
    anchoredAt: typeof a.anchoredAt === 'string' ? a.anchoredAt : '',
  };
}
