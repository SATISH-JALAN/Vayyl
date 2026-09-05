// ============================================================
// The testnet price walk stays inside its rails
// ============================================================
// `scripts/push_price.mjs` keeps the mock oracle fresh, because
// `MAX_ORACLE_AGE` is 300s and every position write path refuses anything
// older. It publishes a synthetic random walk so a tester can actually watch a
// position gain, lose, knock out at the tier cap and go liquidatable.
//
// The property worth pinning is the CLAMP. An unbounded walk eventually
// wanders somewhere that resolves every open position at once -- every long
// knocked out, or every short wiped -- and a tester would read that as the
// protocol misbehaving rather than as the price generator. The clamp is what
// keeps a testnet session legible.
//
// Lives here rather than next to the script because this is the only package
// wired to run TypeScript tests over repo-wide files, and an untested clamp is
// how the rails quietly stop being rails.

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
// pathToFileURL, not a raw path: on Windows an absolute path starts with a
// drive letter, which the ESM loader reads as an unsupported URL scheme.
const { nextPrice, rebase } = await import(
  pathToFileURL(resolve(REPO, 'scripts/push_price.mjs')).href
);

const START = 10_000_000n;
const MIN = START / 2n;
const MAX = START * 2n;

test('a step moves the price, in the direction the coin chose', () => {
  assert.ok(nextPrice(START, 0.9) > START, 'a high roll moves up');
  assert.ok(nextPrice(START, 0.1) < START, 'a low roll moves down');
});

test('a step is 150 basis points', () => {
  // Sized so a tier-0 position is roughly 40 steps from its knock-out. Much
  // larger and a position dies within a couple of ticks; much smaller and a
  // tester watches a flat line.
  assert.equal(nextPrice(START, 0.9), START + (START * 150n) / 10_000n);
});

test('the walk never escapes its rails, however the coin lands', () => {
  // The property that matters. Driven to both extremes deterministically
  // rather than by sampling, because "probably stays in range" is not a rail.
  let up = START;
  for (let i = 0; i < 500; i++) up = nextPrice(up, 1);
  assert.equal(up, MAX);

  let down = START;
  for (let i = 0; i < 500; i++) down = nextPrice(down, 0);
  assert.equal(down, MIN);
});

test('a long random walk stays inside the rails', () => {
  let p = START;
  for (let i = 0; i < 5_000; i++) {
    p = nextPrice(p, Math.random());
    assert.ok(p >= MIN && p <= MAX, `escaped at step ${i}: ${p}`);
  }
});

test('the price stays positive, so no notional is ever zero', () => {
  // A zero price makes every notional zero and every position trivially
  // healthy -- the quietest way to disable liquidation. The lower rail is what
  // makes that unreachable.
  let p = START;
  for (let i = 0; i < 1_000; i++) {
    p = nextPrice(p, 0);
    assert.ok(p > 0n);
  }
});

test('the price stays inside the 64-bit domain the circuits enforce', () => {
  // A price at or above 2^64 would make positions unprovable: openable
  // on-chain and impossible to close.
  let p = START;
  for (let i = 0; i < 1_000; i++) p = nextPrice(p, 1);
  assert.ok(p < 1n << 64n);
});

test('the walk is reachable from either rail, so it never gets stuck', () => {
  // At a rail the next step must still be able to come back, or the price
  // pins there and every position freezes at one outcome.
  assert.ok(nextPrice(MAX, 0) < MAX, 'can descend from the ceiling');
  assert.ok(nextPrice(MIN, 1) > MIN, 'can rise from the floor');
});

// ============================================================
// Market rebasing
// ============================================================
// The publisher's default mode tracks real XLM/USD. It must publish the
// market's MOVEMENT, not its price: the oracle unit is stroops of collateral
// per contract unit, and the tier table is built around 1 XLM/unit. Publishing
// $0.18 directly would put a tier-0 position near 16x rather than the 3x the
// counterparty vault reserves against -- the vault would still reserve for 3x,
// so the shortfall would only surface when a winning position could not be paid.

test('the anchor price maps exactly to the tier design point', () => {
  assert.equal(rebase(0.1846, 0.1846), START);
});

test('a market move becomes the same proportional move in the mark', () => {
  // +10% on XLM/USD is +10% on the mark, so the chart and the mark agree in
  // shape even though they are quoted in different units.
  assert.equal(rebase(0.1846 * 1.1, 0.1846), (START * 110n) / 100n);
  assert.equal(rebase(0.1846 * 1.2, 0.1846), (START * 120n) / 100n);
  assert.equal(rebase(0.0923, 0.1846), START / 2n);
});

test('the raw dollar price is NOT what gets published', () => {
  // The regression this whole function exists to prevent. If rebase ever
  // returned something near the dollar figure, tier leverage would silently
  // change and the vault would be reserving against the wrong worst case.
  const published = rebase(0.1846, 0.1846);
  assert.ok(published > 1_000_000n, 'must be in stroops-per-unit, not dollars');
  assert.equal(published, 10_000_000n);
});

test('rebasing is monotonic, so the mark never moves against the market', () => {
  let previous = 0n;
  for (let cents = 1; cents <= 100; cents++) {
    const price = rebase(cents / 100, 0.1846);
    assert.ok(price > previous, `not monotonic at ${cents}c`);
    previous = price;
  }
});

test('a non-positive market price throws rather than publishing zero', () => {
  // A zero mark makes every notional zero and every position trivially
  // healthy, which disables liquidation without any error being raised.
  assert.throws(() => rebase(0, 0.1846), /Non-positive/);
  assert.throws(() => rebase(-1, 0.1846), /Non-positive/);
  assert.throws(() => rebase(0.1846, 0), /Non-positive/);
});

test('an absurd market reading is refused, not published', () => {
  // The circuits range-check the price to 64 bits. A price at or above 2^64
  // makes positions openable on-chain and impossible to close.
  assert.throws(() => rebase(1e30, 0.1846), /out of sane range/);
});
