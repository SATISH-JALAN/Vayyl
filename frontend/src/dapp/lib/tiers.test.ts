// ============================================================
// Tier tables: the three-way sync, and the settlement arithmetic
// ============================================================
// The first test here is the important one. Tier constants live in Rust, in
// Circom and in TypeScript, and nothing at runtime compares them. A drift
// produces proofs that snarkjs accepts and the chain rejects, with an error
// that names none of the three files. So the comparison happens here, by
// reading the actual sources.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  TIERS,
  getTier,
  leverageAt,
  priceBounds,
  settlementPayout,
  tierReserve,
} from './tiers.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Pull `[a, b]` out of a Rust `pub const NAME: [i128; 2] = [ ... ];`. */
function rustTable(source: string, name: string): bigint[] {
  const m = source.match(new RegExp(`pub const ${name}:[^=]*=\\s*\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`${name} not found in vayyl-types`);
  return m[1]
    .split(',')
    .map((s) => s.replace(/_/g, '').trim())
    .filter(Boolean)
    .map(BigInt);
}

/** Pull the interpolation endpoints out of `a + tier_id * (b - a)`. */
function circomPair(source: string, signal: string): [bigint, bigint] {
  const m = source.match(
    new RegExp(`${signal}\\s*<==\\s*(\\d+)\\s*\\+\\s*tier_id\\s*\\*\\s*\\(\\s*(\\d+)\\s*-\\s*(\\d+)\\s*\\)`),
  );
  if (!m) throw new Error(`${signal} interpolation not found in tiers.circom`);
  const [, base, high, low] = m;
  assert.equal(base, low, `${signal}: the interpolation base must be tier 0`);
  return [BigInt(base), BigInt(high)];
}

test('the tier tables in Rust, Circom and TypeScript are identical', () => {
  const rust = readFileSync(resolve(REPO, 'contracts/vayyl-types/src/lib.rs'), 'utf8');
  const circom = readFileSync(resolve(REPO, 'circuits/lib/tiers.circom'), 'utf8');

  const rustMargin = rustTable(rust, 'TIER_MARGIN');
  const rustSize = rustTable(rust, 'TIER_SIZE');
  const rustMax = rustTable(rust, 'TIER_MAX_PAYOUT');

  assert.equal(rustMargin.length, TIERS.length, 'tier COUNT differs between Rust and TypeScript');
  assert.deepEqual(rustMargin, TIERS.map((t) => t.marginStroops), 'TIER_MARGIN');
  assert.deepEqual(rustSize, TIERS.map((t) => t.size), 'TIER_SIZE');
  assert.deepEqual(rustMax, TIERS.map((t) => t.maxPayoutStroops), 'TIER_MAX_PAYOUT');

  assert.deepEqual(circomPair(circom, 'margin'), rustMargin, 'circom margin');
  assert.deepEqual(circomPair(circom, 'size'), rustSize, 'circom size');
  assert.deepEqual(circomPair(circom, 'max_payout'), rustMax, 'circom max_payout');
});

test('the circom template pins tier_id to a bit, matching the two-entry table', () => {
  // The interpolation `a + tier_id*(b-a)` is only valid for tier_id in {0,1}.
  // If a third tier is ever added, this constraint is what makes forgetting to
  // convert it into a real selector impossible to miss.
  const circom = readFileSync(resolve(REPO, 'circuits/lib/tiers.circom'), 'utf8');
  assert.match(circom, /tier_id\s*\*\s*\(\s*tier_id\s*-\s*1\s*\)\s*===\s*0/);
  assert.equal(TIERS.length, 2, 'tiers.circom interpolates; it supports exactly two tiers');
});

// ---------------------------------------------------------------------------
// The economics
// ---------------------------------------------------------------------------

test('every tier can pay out more than its own margin', () => {
  // The vault reserves `max_payout - margin`. If that were zero the reserve
  // would set nothing aside while still succeeding, quietly removing the only
  // solvency guarantee the system has.
  for (const tier of TIERS) {
    assert.ok(tier.maxPayoutStroops > tier.marginStroops, `tier ${tier.id}`);
    assert.ok(tierReserve(tier) > 0n);
  }
});

test('every tier constant fits the 64-bit domain the circuits enforce', () => {
  // A constant at or above 2^64 makes the tier unprovable: the position could
  // be opened on-chain and never closed.
  const limit = 1n << 64n;
  for (const tier of TIERS) {
    assert.ok(tier.marginStroops < limit);
    assert.ok(tier.size < limit);
    assert.ok(tier.maxPayoutStroops < limit);
  }
});

const T0 = getTier(0);
const ENTRY = 10_000_000n; // 1 XLM per contract unit

test('a flat market settles for exactly the margin', () => {
  assert.equal(settlementPayout(T0, 1, ENTRY, ENTRY), T0.marginStroops);
  assert.equal(settlementPayout(T0, 0, ENTRY, ENTRY), T0.marginStroops);
});

test('a long and a short are mirror images of the same move', () => {
  const up = ENTRY + 1_000_000n;
  const long = settlementPayout(T0, 1, ENTRY, up);
  const short = settlementPayout(T0, 0, ENTRY, up);
  assert.equal(long, T0.marginStroops + T0.size * 1_000_000n);
  assert.equal(long - T0.marginStroops, T0.marginStroops - short);
});

test('a winning position knocks out at the cap and stops earning', () => {
  // The defining product limitation, and the reason the vault stays solvent.
  assert.equal(settlementPayout(T0, 1, ENTRY, ENTRY * 100n), T0.maxPayoutStroops);
});

test('a losing position floors at zero and never owes more than its margin', () => {
  assert.equal(settlementPayout(T0, 1, ENTRY, 1n), 0n);
  assert.equal(settlementPayout(T0, 0, ENTRY, ENTRY * 1000n), 0n);
});

test('the quoted bounds are the prices where those two things happen', () => {
  // These are shown to the user before they commit, so they have to be the
  // real thresholds rather than a rounded illustration.
  const { knockOut, wipeOut } = priceBounds(T0, 1, ENTRY);
  assert.equal(settlementPayout(T0, 1, ENTRY, knockOut), T0.maxPayoutStroops);
  assert.equal(settlementPayout(T0, 1, ENTRY, wipeOut), 0n);
  // One tick inside each bound is strictly better than the bound itself.
  assert.ok(settlementPayout(T0, 1, ENTRY, knockOut - 1n) < T0.maxPayoutStroops);
  assert.ok(settlementPayout(T0, 1, ENTRY, wipeOut + 1n) > 0n);
});

test('short bounds run the other way', () => {
  const { knockOut, wipeOut } = priceBounds(T0, 0, ENTRY);
  assert.ok(knockOut < ENTRY, 'a short profits as the price falls');
  assert.ok(wipeOut > ENTRY);
  assert.equal(settlementPayout(T0, 0, ENTRY, knockOut), T0.maxPayoutStroops);
  assert.equal(settlementPayout(T0, 0, ENTRY, wipeOut), 0n);
});

test('leverage floats with the entry price rather than being a fixed label', () => {
  // A tier fixes the SIZE, not the notional. Showing a static "3x" would be
  // wrong at every price except one.
  assert.equal(leverageAt(T0, ENTRY), 3);
  assert.equal(leverageAt(T0, ENTRY / 2n), 1.5);
  assert.equal(leverageAt(T0, 0n), 0, 'no divide-by-zero on a missing price');
});

test('both tiers offer the same leverage, so the choice is size not risk profile', () => {
  const [a, b] = TIERS;
  assert.equal(leverageAt(a, ENTRY), leverageAt(b, ENTRY));
});

test('an unknown tier throws rather than returning undefined', () => {
  assert.throws(() => getTier(99), /Unknown position tier/);
});
