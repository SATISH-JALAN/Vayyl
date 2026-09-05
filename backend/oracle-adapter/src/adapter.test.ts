// ============================================================
// Oracle adapter: the staleness policy
// ============================================================
// This service had no tests at all, and it is the one that decides whether a
// price is fresh enough to liquidate someone against. Everything below is about
// the policy rather than the plumbing, because the policy is what was wrong:
// a one-year staleness window, and a fabricated fallback price served in the
// same shape as a real reading.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MAX_STALENESS,
  NoPriceError,
  OracleAdapter,
  StaleOracleError,
  evaluate,
} from './adapter.ts';

const NOW = 1_700_000_000;
const PRICE = 10_000_000n; // 1 XLM per contract unit

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

test('a fresh price is returned with its age', () => {
  const reading = evaluate('XLM', { price: PRICE, timestamp: NOW - 30 }, NOW);
  assert.equal(reading.price, PRICE);
  assert.equal(reading.timestamp, NOW - 30);
  assert.equal(reading.ageSeconds, 30);
});

test('a price at exactly the age limit is still accepted', () => {
  // Off-by-one here makes the window one second shorter than documented, and
  // every client computing the same window would disagree with this service.
  const reading = evaluate('XLM', { price: PRICE, timestamp: NOW - DEFAULT_MAX_STALENESS }, NOW);
  assert.equal(reading.ageSeconds, DEFAULT_MAX_STALENESS);
});

test('a price one second past the limit is refused', () => {
  assert.throws(
    () => evaluate('XLM', { price: PRICE, timestamp: NOW - DEFAULT_MAX_STALENESS - 1 }, NOW),
    StaleOracleError,
  );
});

test('the default window is minutes, not a year', () => {
  // The previous value was 31,536,000 seconds. That is not a staleness check:
  // every price the feed had ever published passed it.
  assert.ok(DEFAULT_MAX_STALENESS <= 600, 'a staleness window measured in hours is not one');
  assert.equal(DEFAULT_MAX_STALENESS, 300, 'must match PositionManager::MAX_ORACLE_AGE');
});

test('an hour-old price is refused under the default window', () => {
  assert.throws(() => evaluate('XLM', { price: PRICE, timestamp: NOW - 3600 }, NOW), StaleOracleError);
});

test('a future-dated price is refused rather than treated as fresh', () => {
  // It reads as "newer than now" to every downstream staleness comparison, so
  // one such record would make positions unliquidatable until the clock caught
  // up. A feed publishing into the future is malfunctioning, and serving its
  // numbers anyway hides that.
  assert.throws(() => evaluate('XLM', { price: PRICE, timestamp: NOW + 60 }, NOW), StaleOracleError);
});

// ---------------------------------------------------------------------------
// No price is not price zero
// ---------------------------------------------------------------------------

test('a missing price raises rather than returning zero', () => {
  // A zero price makes every notional zero and therefore every position
  // trivially healthy -- the quietest way to disable liquidation.
  assert.throws(() => evaluate('XLM', null, NOW), NoPriceError);
});

test('a zero or negative published price is refused', () => {
  assert.throws(() => evaluate('XLM', { price: 0n, timestamp: NOW }, NOW), NoPriceError);
  assert.throws(() => evaluate('XLM', { price: -1n, timestamp: NOW }, NOW), NoPriceError);
});

test('the error names the asset and both numbers', () => {
  // An operator reading a log line should not have to guess which feed stalled
  // or by how much.
  try {
    evaluate('XLM', { price: PRICE, timestamp: NOW - 9999 }, NOW);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof StaleOracleError);
    assert.match(e.message, /XLM/);
    assert.match(e.message, /9999s old/);
    assert.match(e.message, /limit is 300s/);
    assert.equal(e.ageSeconds, 9999);
  }
});

// ---------------------------------------------------------------------------
// Precision
// ---------------------------------------------------------------------------

test('a price above 2^53 survives without losing precision', () => {
  // The previous adapter did `Number(nativeResult[0])`. Stroops are i128
  // on-chain, so anything above 2^53 rounded silently -- a mis-priced position
  // with no error anywhere.
  const huge = 9_007_199_254_740_993n; // 2^53 + 1, the first integer a double cannot hold
  const reading = evaluate('XLM', { price: huge, timestamp: NOW }, NOW);
  assert.equal(reading.price, huge);
  assert.notEqual(Number(reading.price), Number(huge) - 1);
  assert.equal(reading.price.toString(), '9007199254740993');
});

// ---------------------------------------------------------------------------
// The adapter around the policy
// ---------------------------------------------------------------------------

const withSource = (raw: { price: bigint; timestamp: number } | null, max?: number) =>
  new OracleAdapter('http://localhost', 'CORACLE', max ?? DEFAULT_MAX_STALENESS, async () => raw);

test('the adapter applies the policy to what the chain returned', async () => {
  const adapter = withSource({ price: PRICE, timestamp: NOW - 10 });
  const reading = await adapter.getAssetPrice('XLM', NOW);
  assert.equal(reading.price, PRICE);
  assert.equal(reading.ageSeconds, 10);
});

test('the adapter refuses a stale reading rather than substituting one', async () => {
  // The behaviour this replaces: on ANY error the HTTP layer answered
  // `price: 2000` with a fresh timestamp, formatted exactly like a real
  // reading. Nothing downstream could tell the difference.
  const adapter = withSource({ price: PRICE, timestamp: NOW - 100_000 });
  await assert.rejects(() => adapter.getAssetPrice('XLM', NOW), StaleOracleError);
});

test('the staleness window is configurable, and honoured', async () => {
  const tight = withSource({ price: PRICE, timestamp: NOW - 45 }, 30);
  await assert.rejects(() => tight.getAssetPrice('XLM', NOW), StaleOracleError);

  const loose = withSource({ price: PRICE, timestamp: NOW - 45 }, 60);
  assert.equal((await loose.getAssetPrice('XLM', NOW)).ageSeconds, 45);
});

test('an unreachable chain propagates rather than being swallowed', async () => {
  const adapter = new OracleAdapter('http://localhost', 'CORACLE', 300, async () => {
    throw new Error('simulation failed');
  });
  await assert.rejects(() => adapter.getAssetPrice('XLM', NOW), /simulation failed/);
});

test('an asset the feed has never published raises NoPrice', async () => {
  await assert.rejects(() => withSource(null).getAssetPrice('DOGE', NOW), NoPriceError);
});
