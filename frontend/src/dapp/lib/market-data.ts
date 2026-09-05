// ============================================================
// Market price history for the chart
// ============================================================
// The chart shows the REAL XLM/USD market. The contracts do not read this feed
// and never will -- they settle against the SEP-40 oracle, and on testnet that
// oracle publishes a synthetic walk (see `scripts/push_price.mjs`). Two
// different numbers, deliberately:
//
//   chart          - what XLM is actually worth, so the page is legible
//   oracle / mark  - what the contract will settle and liquidate against
//
// Every screen that shows both has to label which is which. A trader who reads
// the chart as the settlement price will misjudge how close a position is to
// liquidation, and on testnet the two can be far apart.
//
// There is NO fabricated fallback. If both sources fail the chart says so and
// draws nothing. An invented candle is indistinguishable from a real one at a
// glance, which is exactly how the old `price: 2000` oracle default survived
// as long as it did.

import type { PriceAnchor } from './mark-price';

export interface Candle {
  /** Seconds since the epoch, which is what lightweight-charts expects. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Base-asset volume. Null when the source does not publish it. */
  volume: number | null;
}

export interface MarketSummary {
  last: number;
  /** Percentage move over the trailing 24h. Null when unknown. */
  change24h: number | null;
  /** Quote-currency volume over the trailing 24h. Null when unknown. */
  volume24h: number | null;
  source: string;
}

export type Interval = '5m' | '15m' | '1h' | '4h' | '1d';

export const INTERVALS: Array<{ id: Interval; label: string }> = [
  { id: '5m', label: '5m' },
  { id: '15m', label: '15m' },
  { id: '1h', label: '1h' },
  { id: '4h', label: '4h' },
  { id: '1d', label: '1D' },
];

/** Seconds each interval covers -- used to bucket CoinGecko's fixed candles. */
const INTERVAL_SECONDS: Record<Interval, number> = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

const BINANCE = 'https://api.binance.com/api/v3';
const COINGECKO = 'https://api.coingecko.com/api/v3';

export class MarketDataUnavailable extends Error {
  readonly attempts: string[];
  constructor(attempts: string[]) {
    super(`No market data source responded (tried: ${attempts.join(', ')})`);
    this.name = 'MarketDataUnavailable';
    this.attempts = attempts;
  }
}

const finite = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`Non-numeric value in market data: ${String(v)}`);
  return n;
};

/**
 * Binance kline rows: [openTime, open, high, low, close, volume, ...].
 *
 * Pure and exported so the shape can be tested without a network. A silently
 * mis-parsed column would put the low where the close belongs and draw a chart
 * that looks plausible and is wrong.
 */
export function parseBinanceKlines(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) throw new Error('Binance klines: expected an array');
  return raw.map((row) => {
    if (!Array.isArray(row) || row.length < 6) throw new Error('Binance klines: short row');
    return {
      time: Math.floor(finite(row[0]) / 1000),
      open: finite(row[1]),
      high: finite(row[2]),
      low: finite(row[3]),
      close: finite(row[4]),
      volume: finite(row[5]),
    };
  });
}

/** Binance 24h ticker -> summary. Pure. */
export function parseBinanceTicker(raw: unknown): Omit<MarketSummary, 'source'> {
  const t = raw as Record<string, unknown>;
  if (!t || typeof t !== 'object') throw new Error('Binance ticker: expected an object');
  return {
    last: finite(t.lastPrice),
    change24h: finite(t.priceChangePercent),
    volume24h: finite(t.quoteVolume),
  };
}

/**
 * CoinGecko OHLC rows: [ms, open, high, low, close]. No volume column, so
 * `volume` is null rather than zero -- zero would render as a real reading of
 * "nothing traded".
 */
export function parseCoingeckoOhlc(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) throw new Error('CoinGecko OHLC: expected an array');
  return raw.map((row) => {
    if (!Array.isArray(row) || row.length < 5) throw new Error('CoinGecko OHLC: short row');
    return {
      time: Math.floor(finite(row[0]) / 1000),
      open: finite(row[1]),
      high: finite(row[2]),
      low: finite(row[3]),
      close: finite(row[4]),
      volume: null,
    };
  });
}

/**
 * Merge finer candles into one bucket per interval.
 *
 * CoinGecko's granularity is chosen by its `days` parameter, not by the caller,
 * so its candles rarely line up with the timeframe the user picked. Bucketing
 * keeps the fallback honest: open of the first, close of the last, extremes
 * across the set, rather than pretending each source candle is one of ours.
 */
export function bucketCandles(candles: Candle[], interval: Interval): Candle[] {
  const width = INTERVAL_SECONDS[interval];
  const out: Candle[] = [];
  for (const c of candles) {
    const bucket = Math.floor(c.time / width) * width;
    const last = out[out.length - 1];
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      if (c.volume !== null) last.volume = (last.volume ?? 0) + c.volume;
    } else {
      out.push({ ...c, time: bucket });
    }
  }
  return out;
}

/** Derive a summary from candles when no ticker endpoint answered. */
export function summarize(candles: Candle[], source: string): MarketSummary | null {
  if (candles.length === 0) return null;
  const last = candles[candles.length - 1].close;
  const cutoff = candles[candles.length - 1].time - 86_400;
  const ref = candles.find((c) => c.time >= cutoff) ?? candles[0];
  const change24h = ref.open > 0 ? ((last - ref.open) / ref.open) * 100 : null;
  const volumes = candles.filter((c) => c.time >= cutoff && c.volume !== null);
  const volume24h = volumes.length > 0 ? volumes.reduce((s, c) => s + (c.volume ?? 0), 0) : null;
  return { last, change24h, volume24h, source };
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

export interface MarketSnapshot {
  candles: Candle[];
  summary: MarketSummary | null;
  source: string;
  /**
   * The publisher's price anchor, supplied by /api/market.
   *
   * It converts an oracle price into the USD the chart is drawn in. Null when
   * the publisher is not tracking a market (--synthetic / --fixed), in which
   * case no USD figure is meaningful and the UI must show none.
   */
  anchor?: PriceAnchor | null;
}

/**
 * What the BROWSER calls. Goes to our own origin, never to an exchange.
 *
 * `connect-src` in src/proxy.ts is a strict allowlist, and it is what stops an
 * XSS shipping the note store somewhere. Allowing api.binance.com through it so
 * the page could draw candles would widen the app's most important control for
 * its least important feature. `/api/market` runs `fetchMarket` server-side
 * instead, so the page only ever talks to 'self'.
 */
export async function fetchMarketViaProxy(
  interval: Interval,
  limit = 200,
  signal?: AbortSignal,
): Promise<MarketSnapshot> {
  const res = await fetch(`/api/market?interval=${interval}&limit=${limit}`, { signal });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new MarketDataUnavailable([detail?.error ?? `proxy HTTP ${res.status}`]);
  }
  return (await res.json()) as MarketSnapshot;
}

/**
 * Fetch candles for XLM/USD, trying Binance and then CoinGecko.
 *
 * Binance quotes XLM against USDT, not USD. They track closely enough for a
 * price chart and the UI labels the pair as reported rather than claiming USD.
 */
export async function fetchMarket(
  interval: Interval,
  limit = 200,
  signal?: AbortSignal,
  /**
   * Rightmost bar, epoch MILLISECONDS. Used for scroll-back pagination.
   *
   * Binance answers `endTime` + `limit` with the last `limit` bars ending
   * there, which is exactly what a chart asking for "N bars before this point"
   * needs. The CoinGecko fallback CANNOT do this -- its granularity comes from
   * a `days`-from-now window -- so a ranged request that falls through to it
   * returns nothing rather than the wrong window. An approximately-right range
   * would be indistinguishable from real history.
   */
  endTimeMs?: number,
): Promise<MarketSnapshot> {
  const attempts: string[] = [];
  const endParam = endTimeMs ? `&endTime=${endTimeMs}` : '';

  try {
    const [klines, ticker] = await Promise.all([
      getJson(`${BINANCE}/klines?symbol=XLMUSDT&interval=${interval}&limit=${limit}${endParam}`, signal),
      getJson(`${BINANCE}/ticker/24hr?symbol=XLMUSDT`, signal),
    ]);
    const candles = parseBinanceKlines(klines);
    if (candles.length > 0) {
      return {
        candles,
        summary: { ...parseBinanceTicker(ticker), source: 'Binance XLM/USDT' },
        source: 'Binance XLM/USDT',
      };
    }
    attempts.push('Binance (empty)');
  } catch (e) {
    attempts.push(`Binance (${(e as Error).message})`);
  }

  try {
    // CoinGecko picks granularity from `days`; ask for a span that yields
    // enough points to bucket into the requested interval.
    // Ranged requests are Binance-only. Rather than serve a recent window in
    // answer to a question about older history, say there is nothing.
    if (endTimeMs) {
      return { candles: [], summary: null, source: 'CoinGecko XLM/USD (no history)' };
    }
    const days = interval === '5m' || interval === '15m' ? 1 : interval === '1h' ? 7 : 30;
    const raw = await getJson(
      `${COINGECKO}/coins/stellar/ohlc?vs_currency=usd&days=${days}`,
      signal,
    );
    const candles = bucketCandles(parseCoingeckoOhlc(raw), interval).slice(-limit);
    if (candles.length > 0) {
      const source = 'CoinGecko XLM/USD';
      return { candles, summary: summarize(candles, source), source };
    }
    attempts.push('CoinGecko (empty)');
  } catch (e) {
    attempts.push(`CoinGecko (${(e as Error).message})`);
  }

  throw new MarketDataUnavailable(attempts);
}
