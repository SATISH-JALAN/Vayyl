// ============================================================
// Market data parsing
// ============================================================
// Column order is the whole risk here. Binance and CoinGecko both return bare
// arrays, so putting the low where the close belongs produces a chart that is
// wrong and looks completely normal -- nothing throws, nothing logs, the
// candles just describe a market that never happened.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bucketCandles,
  parseBinanceKlines,
  parseBinanceTicker,
  parseCoingeckoOhlc,
  summarize,
} from './market-data.ts';

// One real-shaped Binance row: openTime, o, h, l, c, volume, closeTime, ...
const KLINE = [
  1_757_030_400_000,
  '0.18320000',
  '0.18470000',
  '0.18290000',
  '0.18400000',
  '1823456.0000',
  1_757_034_000_000,
  '335000.12',
  4821,
];

test('Binance rows map to the right fields, in the right order', () => {
  const [c] = parseBinanceKlines([KLINE]);
  assert.equal(c.time, 1_757_030_400); // seconds, not milliseconds
  assert.equal(c.open, 0.1832);
  assert.equal(c.high, 0.1847);
  assert.equal(c.low, 0.1829);
  assert.equal(c.close, 0.184);
  assert.equal(c.volume, 1_823_456);
});

test('a candle never has its high below its low', () => {
  // The cheapest possible check that the columns did not get transposed.
  const [c] = parseBinanceKlines([KLINE]);
  assert.ok(c.high >= c.low);
  assert.ok(c.high >= c.open && c.high >= c.close);
  assert.ok(c.low <= c.open && c.low <= c.close);
});

test('malformed rows throw rather than producing a NaN candle', () => {
  // A NaN silently becomes a gap in the chart instead of an error anyone sees.
  assert.throws(() => parseBinanceKlines([[1, 'x', '2', '3', '4', '5']]), /Non-numeric/);
  assert.throws(() => parseBinanceKlines([[1, '2']]), /short row/);
  assert.throws(() => parseBinanceKlines({} as unknown), /expected an array/);
});

test('CoinGecko rows parse, and report no volume rather than zero volume', () => {
  const [c] = parseCoingeckoOhlc([[1_757_030_400_000, 0.1832, 0.1847, 0.1829, 0.184]]);
  assert.equal(c.time, 1_757_030_400);
  assert.equal(c.close, 0.184);
  // Zero would render as a genuine "nothing traded" reading.
  assert.equal(c.volume, null);
});

test('bucketing keeps the open of the first candle and the close of the last', () => {
  const base = 1_757_030_400; // exactly on a 4h boundary
  const candles = [
    { time: base, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    { time: base + 3600, open: 1.5, high: 3, low: 1.4, close: 2.5, volume: 20 },
    { time: base + 7200, open: 2.5, high: 2.6, low: 0.2, close: 0.9, volume: 30 },
    { time: base + 14400, open: 0.9, high: 1, low: 0.8, close: 1, volume: 5 },
  ];
  const out = bucketCandles(candles, '4h');
  assert.equal(out.length, 2);
  assert.equal(out[0].open, 1);
  assert.equal(out[0].close, 0.9);
  assert.equal(out[0].high, 3);
  assert.equal(out[0].low, 0.2);
  assert.equal(out[0].volume, 60);
  assert.equal(out[1].time, base + 14400);
});

test('bucketing carries null volume through without inventing a number', () => {
  const base = 1_757_030_400;
  const out = bucketCandles(
    [
      { time: base, open: 1, high: 2, low: 1, close: 2, volume: null },
      { time: base + 3600, open: 2, high: 3, low: 2, close: 3, volume: null },
    ],
    '4h',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].volume, null);
});

test('the ticker parses percent and quote volume as numbers', () => {
  const s = parseBinanceTicker({
    lastPrice: '0.18400000',
    priceChangePercent: '4.27',
    quoteVolume: '18234567.1',
  });
  assert.equal(s.last, 0.184);
  assert.equal(s.change24h, 4.27);
  assert.equal(s.volume24h, 18_234_567.1);
});

test('summarize measures the 24h move from the candle 24h back, not the first one', () => {
  // With 30 days of candles, using candles[0] would report a monthly move
  // under a "24h change" label.
  const day = 86_400;
  const now = 1_757_030_400;
  const candles = Array.from({ length: 30 }, (_, i) => ({
    time: now - (29 - i) * day,
    open: 1 + i,
    high: 2 + i,
    low: i,
    close: 1.5 + i,
    volume: 100,
  }));
  const s = summarize(candles, 'test')!;
  assert.equal(s.last, 30.5);
  // The reference is the first candle at or after the cutoff -- index 28, which
  // opens at 29. Using candles[0] would report a 3000% "24h" move.
  assert.ok(s.change24h !== null && Math.abs(s.change24h - ((30.5 - 29) / 29) * 100) < 1e-9);
  assert.ok(s.change24h! < 10, 'a 24h window must not report the whole month');
});

test('summarize returns null on an empty series instead of a zero price', () => {
  assert.equal(summarize([], 'test'), null);
});

test('volume is null when no candle in the window reported one', () => {
  const s = summarize(
    [{ time: 1_757_030_400, open: 1, high: 1, low: 1, close: 1, volume: null }],
    'test',
  )!;
  assert.equal(s.volume24h, null);
});
