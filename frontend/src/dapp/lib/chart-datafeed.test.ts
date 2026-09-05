// ============================================================
// Bar loading
// ============================================================
// Every assertion here guards a failure that produces a WRONG CHART rather than
// an error: a doubled seconds->ms conversion, a zero volume that reads as "no
// trading", unsorted bars, or infinite pagination against a source with no more
// history. Chart engines do not validate their input; they draw it.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  barsFromCandles,
  clipTo,
  loadBars,
  moreFor,
  planLoad,
  type BarTransport,
} from './chart-datafeed.ts';
import type { Candle } from './market-data.ts';

const candle = (time: number, close = 0.18, volume: number | null = 100): Candle => ({
  time,
  open: 0.17,
  high: 0.19,
  low: 0.16,
  close,
  volume,
});

test('seconds become milliseconds exactly once', () => {
  // The classic: convert twice and the bars land in the year 57000, the chart
  // renders empty, and nothing throws.
  const [b] = barsFromCandles([candle(1_788_630_000)]);
  assert.equal(b.timestamp, 1_788_630_000_000);
  assert.ok(b.timestamp < 2_000_000_000_000, 'timestamp is not in the far future');
});

test('OHLC values survive the conversion unchanged', () => {
  const [b] = barsFromCandles([candle(1_788_630_000, 0.1842)]);
  assert.equal(b.open, 0.17);
  assert.equal(b.high, 0.19);
  assert.equal(b.low, 0.16);
  assert.equal(b.close, 0.1842);
  assert.ok(b.high >= b.low, 'columns were not transposed');
});

test('a missing volume becomes undefined, never zero', () => {
  // CoinGecko publishes no volume. A zero bar is a real reading meaning
  // "nothing traded", which is a different and false claim.
  const [b] = barsFromCandles([candle(1_788_630_000, 0.18, null)]);
  assert.equal(b.volume, undefined);
  assert.notEqual(b.volume, 0);
});

test('bars come out ascending and deduplicated', () => {
  const bars = barsFromCandles([
    candle(300),
    candle(100),
    candle(200),
    candle(100), // duplicate timestamp
  ]);
  assert.deepEqual(
    bars.map((b) => b.timestamp),
    [100_000, 200_000, 300_000],
  );
});

test('clipping drops bars past the requested right edge', () => {
  const bars = barsFromCandles([candle(100), candle(200), candle(300)]);
  assert.equal(clipTo(bars, 200).length, 2);
  assert.equal(clipTo(bars, null).length, 3);
});

test('an empty page reports no more history, so pagination stops', () => {
  // Returning `more: true` on an empty page makes a chart request the same
  // range forever. The CoinGecko fallback genuinely cannot serve arbitrary
  // history, so this is a real state, not a theoretical one.
  const empty: BarTransport = async () => ({ candles: [] });
  return loadBars(empty, { interval: '1h', to: null, countBack: 200 }).then((r) => {
    assert.deepEqual(r.bars, []);
    assert.equal(r.more, false);
  });
});

test('a page with bars reports more history available', async () => {
  const t: BarTransport = async () => ({ candles: [candle(100), candle(200)] });
  const r = await loadBars(t, { interval: '1h', to: null, countBack: 200 });
  assert.equal(r.bars.length, 2);
  assert.equal(r.more, true);
});

test('the request reaches the transport unchanged', async () => {
  let seen: unknown = null;
  const t: BarTransport = async (req) => {
    seen = req;
    return { candles: [] };
  };
  await loadBars(t, { interval: '4h', to: 1_788_630_000, countBack: 300 });
  assert.deepEqual(seen, { interval: '4h', to: 1_788_630_000, countBack: 300 });
});

test('a transport failure propagates rather than yielding an empty chart', async () => {
  // Silently returning [] would render a blank chart that looks like "no data
  // exists" instead of "the request failed".
  const t: BarTransport = async () => {
    throw new Error('HTTP 502');
  };
  await assert.rejects(
    () => loadBars(t, { interval: '1h', to: null, countBack: 200 }),
    /502/,
  );
});

// ============================================================
// Load planning
// ============================================================
// A REGRESSION SUITE, not a hypothetical one. The first version of the loader
// answered every non-`forward` request with the latest window and reported a
// bare `more: true` -- which means "more in both directions". The chart then
// asked `backward` for bars newer than its last one, received the same 200
// latest bars, and appended them past the live edge. The visible result was a
// date from a week earlier drawn to the RIGHT of today. Nothing threw, no
// request failed, and no log line appeared.

test('init asks for the latest window', () => {
  assert.deepEqual(planLoad('init', null), { fetch: true, to: null });
});

test('forward pages backwards in time from the given timestamp', () => {
  // Milliseconds in, SECONDS out -- the proxy and Binance both take seconds.
  assert.deepEqual(planLoad('forward', 1_788_630_000_000), {
    fetch: true,
    to: 1_788_630_000,
  });
});

test('forward without a usable timestamp fetches nothing', () => {
  // Returning the latest window here is precisely the bug above: the chart
  // asked for older history and would have been handed today's bars again.
  for (const t of [null, 0, -1]) {
    assert.deepEqual(planLoad('forward', t), { fetch: false, to: null }, `timestamp ${t}`);
  }
});

test('backward never fetches', () => {
  // There is nothing newer than the live edge to page into. Live updates are a
  // subscribeBar concern.
  assert.deepEqual(planLoad('backward', 1_788_630_000_000), { fetch: false, to: null });
  assert.deepEqual(planLoad('backward', null), { fetch: false, to: null });
});

test('update refreshes the latest window', () => {
  assert.deepEqual(planLoad('update', 1_788_630_000_000), { fetch: true, to: null });
});

test('more.backward is false for every load type', () => {
  // The single assertion that pins the fix. A true here restarts the loop.
  for (const type of ['init', 'forward', 'backward', 'update'] as const) {
    for (const count of [0, 1, 200]) {
      assert.equal(moreFor(type, count).backward, false, `${type} with ${count} bars`);
    }
  }
});

test('more.forward follows whether bars actually came back', () => {
  assert.equal(moreFor('init', 200).forward, true);
  assert.equal(moreFor('forward', 200).forward, true);
  // An empty page means the source has nothing older. Saying otherwise makes
  // the chart paginate forever against the CoinGecko fallback, which cannot
  // serve arbitrary ranges at all.
  assert.equal(moreFor('forward', 0).forward, false);
  assert.equal(moreFor('backward', 200).forward, false);
});
