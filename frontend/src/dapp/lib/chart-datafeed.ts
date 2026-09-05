// ============================================================
// Bar loading, engine-agnostic
// ============================================================
// KLineChart v10 and TradingView Advanced Charts both pull bars through a
// loader object rather than being handed an array -- `DataLoader.getBars` and
// `Datafeed.getBars` respectively, with near-identical shapes. So the fetching
// and conversion live here once, and each engine wraps them in its own object.
//
// Everything below is pure over an injected transport, which is what lets it be
// tested with no DOM, no network and no charting library present.

import { type Candle, type Interval } from './market-data';

/** One bar in KLineChart's shape. Timestamps are MILLISECONDS. */
export interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface BarRequest {
  interval: Interval;
  /** Rightmost bar, epoch SECONDS. Null means "the latest". */
  to: number | null;
  /** How many bars the chart wants. */
  countBack: number;
}

export interface BarResult {
  bars: Bar[];
  /** False when the source has nothing older, so the chart stops paginating. */
  more: boolean;
}

export type BarTransport = (req: BarRequest) => Promise<{ candles: Candle[] }>;

/** KLineChart's four load reasons. */
export type LoadType = 'init' | 'forward' | 'backward' | 'update';

/** Which directions the chart may keep asking in. */
export interface MoreFlags {
  forward: boolean;
  backward: boolean;
}

export interface LoadPlan {
  /** False means answer with an empty page without touching the network. */
  fetch: boolean;
  /** Rightmost bar, epoch SECONDS, or null for "the latest". */
  to: number | null;
}

/**
 * Decide what one `getBars` call should actually fetch.
 *
 * THIS IS WHERE A REAL BUG LIVED, and it is worth spelling out because the
 * symptom pointed nowhere near the cause. The first version treated every
 * non-`forward` request as "give me the latest window" and answered a bare
 * `more: true`. `more: true` means "more in BOTH directions", so the chart kept
 * asking `backward` for bars newer than its last one — and got handed the same
 * 200 latest bars every time, which it appended after the live edge. The chart
 * drew a date from a week earlier immediately to the right of today, and
 * nothing threw, logged, or failed a request.
 *
 *  - `init`    — the latest window.
 *  - `forward` — strictly OLDER than `timestamp`. This is scroll-back.
 *  - `backward`— bars NEWER than `timestamp`. This feed's newest bar is the
 *                live one, so there is never anything to serve here. Live
 *                updates are a `subscribeBar` job, not a pagination job.
 *  - `update`  — refresh the forming candle: the latest window again.
 *
 * A `forward` request with no usable timestamp fetches NOTHING. Falling back to
 * the latest window there is what produced the duplication above.
 */
export function planLoad(type: LoadType, timestampMs: number | null): LoadPlan {
  switch (type) {
    case 'init':
    case 'update':
      return { fetch: true, to: null };
    case 'forward':
      return timestampMs && timestampMs > 0
        ? { fetch: true, to: Math.floor(timestampMs / 1000) }
        : { fetch: false, to: null };
    case 'backward':
      return { fetch: false, to: null };
  }
}

/**
 * Which directions still have history, given what came back.
 *
 * `backward` is ALWAYS false. There is nothing newer than the live edge to
 * page into, and saying otherwise is what made the chart loop.
 */
export function moreFor(type: LoadType, barCount: number): MoreFlags {
  return {
    // An empty page means the source has nothing older; keep asking and the
    // chart paginates forever against the CoinGecko fallback, which genuinely
    // cannot serve arbitrary ranges.
    forward: type === 'backward' ? false : barCount > 0,
    backward: false,
  };
}

/**
 * Convert market candles to chart bars.
 *
 * Three conversions that each have a wrong-looking-but-plausible alternative:
 *
 *  - seconds -> MILLISECONDS, exactly once. Doing it twice yields timestamps in
 *    the year 57000 and an empty chart with no error anywhere.
 *  - `volume: null` becomes `undefined`, never 0. The CoinGecko fallback
 *    genuinely publishes no volume, and a zero bar reads as "nothing traded".
 *  - ascending order, deduplicated. Chart engines assume both and misdraw
 *    silently rather than throwing when they do not hold.
 */
export function barsFromCandles(candles: Candle[]): Bar[] {
  const seen = new Set<number>();
  const bars: Bar[] = [];
  for (const c of [...candles].sort((a, b) => a.time - b.time)) {
    if (seen.has(c.time)) continue;
    seen.add(c.time);
    bars.push({
      timestamp: c.time * 1000,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? undefined,
    });
  }
  return bars;
}

/** Drop anything at or after the requested right edge. */
export function clipTo(bars: Bar[], to: number | null): Bar[] {
  if (to === null) return bars;
  const limit = to * 1000;
  return bars.filter((b) => b.timestamp <= limit);
}

/**
 * Fetch one page of bars.
 *
 * `more` is false on an empty page so the chart stops asking. Returning true
 * with nothing in it makes a chart paginate forever against a source that has
 * no more history -- which is the actual behaviour of the CoinGecko fallback,
 * since it serves only a recent window and cannot answer an arbitrary range.
 */
export async function loadBars(transport: BarTransport, req: BarRequest): Promise<BarResult> {
  const { candles } = await transport(req);
  const bars = clipTo(barsFromCandles(candles), req.to);
  return { bars, more: bars.length > 0 };
}

/** The transport the browser uses: same-origin, never an exchange directly. */
export const proxyTransport: BarTransport = async (req) => {
  const params = new URLSearchParams({
    interval: req.interval,
    limit: String(req.countBack),
  });
  if (req.to !== null) params.set('to', String(req.to));
  const res = await fetch(`/api/market?${params.toString()}`);
  if (!res.ok) throw new Error(`market proxy HTTP ${res.status}`);
  return (await res.json()) as { candles: Candle[] };
};
