// ============================================================
// Oracle price -> USD
// ============================================================
// The test that matters is the ROUND TRIP against the real `rebase()` in
// scripts/push_price.mjs, not against a second copy of the formula here. The
// publisher and the UI are two ends of one conversion; if they drift, the chart
// draws a settlement line that does not correspond to what settles, and nothing
// errors. Importing the actual publisher is the same technique tiers.test.ts
// uses to stop the tier table drifting across three languages.

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { START_PRICE, markUsd, parseAnchor, usdToOracle } from './mark-price.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { rebase } = await import(pathToFileURL(resolve(REPO, 'scripts/push_price.mjs')).href);

const ANCHOR = { market: 0.1847, anchoredAt: '2026-09-05T18:57:21.876Z' };

test('markUsd is the exact inverse of the publisher rebase', () => {
  for (const spot of [0.1847, 0.2, 0.15, 0.3, 0.09, 1.25]) {
    const published = rebase(spot, ANCHOR.market);
    const recovered = markUsd(published, ANCHOR)!;
    // Integer truncation in rebase costs at most one stroop, which is ~1e-8 USD.
    assert.ok(
      Math.abs(recovered - spot) < 1e-6,
      `spot ${spot} -> ${published} -> ${recovered}`,
    );
  }
});

test('the anchor price maps back to the anchor USD figure', () => {
  assert.equal(markUsd(START_PRICE, ANCHOR), ANCHOR.market);
});

test('a chart-scale figure comes out, not a contract-scale one', () => {
  // The actual bug. The chart axis runs ~0.16-0.20; the old code drew ~1.0, an
  // order of magnitude away, so the "oracle line" was never on screen in a
  // meaningful place.
  const usd = markUsd(START_PRICE, ANCHOR)!;
  assert.ok(usd > 0.01 && usd < 10, `expected a USD-scale number, got ${usd}`);
  assert.notEqual(usd, Number(START_PRICE) / 1e7);
});

test('a missing anchor yields null, never zero', () => {
  // Zero would render as $0.0000 -- indistinguishable from "this position is
  // about to be wiped out" rather than "this number is unknown". The anchor is
  // absent precisely when the publisher is in --synthetic or --fixed mode,
  // where no USD figure is meaningful at all.
  assert.equal(markUsd(START_PRICE, null), null);
  assert.equal(markUsd(null, ANCHOR), null);
});

test('a non-positive or nonsense input yields null', () => {
  assert.equal(markUsd(0n, ANCHOR), null);
  assert.equal(markUsd(-1n, ANCHOR), null);
  assert.equal(markUsd(START_PRICE, { market: 0, anchoredAt: '' }), null);
  assert.equal(markUsd(START_PRICE, { market: -1, anchoredAt: '' }), null);
  assert.equal(markUsd(START_PRICE, { market: Number.NaN, anchoredAt: '' }), null);
});

test('conversion is monotonic, so the line never moves against the price', () => {
  let previous = -Infinity;
  for (let p = 1_000_000n; p <= 30_000_000n; p += 500_000n) {
    const usd = markUsd(p, ANCHOR)!;
    assert.ok(usd > previous, `not monotonic at ${p}`);
    previous = usd;
  }
});

test('usdToOracle round-trips back to the contract unit', () => {
  const usd = markUsd(12_345_678n, ANCHOR)!;
  const back = usdToOracle(usd, ANCHOR)!;
  assert.ok(back >= 12_345_677n && back <= 12_345_679n, `got ${back}`);
  assert.equal(usdToOracle(0, ANCHOR), null);
  assert.equal(usdToOracle(1, null), null);
});

test('parseAnchor rejects anything it cannot use', () => {
  assert.deepEqual(parseAnchor({ market: 0.1847, anchoredAt: 'x' }), {
    market: 0.1847,
    anchoredAt: 'x',
  });
  // The publisher writes market as a number; a string is still usable.
  assert.equal(parseAnchor({ market: '0.1847' })?.market, 0.1847);
  assert.equal(parseAnchor({ market: 0 }), null);
  assert.equal(parseAnchor({ market: 'not a number' }), null);
  assert.equal(parseAnchor(null), null);
  assert.equal(parseAnchor('0.1847'), null);
});
