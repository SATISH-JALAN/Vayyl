// Relayer-set selection and timing policy.
//
// These properties are what stop the network layer handing back the linkability
// the circuits remove, so they are worth pinning precisely: a selection that
// silently favours one operator, or a delay that collapses to a constant, would
// look fine in the UI and provide nothing.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseRelayerSet,
  selectRelayer,
  drawDelayMs,
  describeDelay,
  type RandomSource,
} from './relayer-set.ts';

/** Deterministic source so distribution claims can be asserted, not hoped for. */
const fixed = (...values: number[]): RandomSource => {
  let i = 0;
  return { next: () => values[i++ % values.length] };
};

test('parses a comma-separated set and normalises trailing slashes', () => {
  const set = parseRelayerSet('https://a.example/, https://b.example ,https://c.example', 'x');
  assert.deepEqual(set, ['https://a.example', 'https://b.example', 'https://c.example']);
});

test('collapses duplicates so one operator is not weighted twice', () => {
  // A URL listed twice would be chosen twice as often, quietly concentrating
  // traffic on one operator — the exact thing the set exists to avoid.
  const set = parseRelayerSet('https://a.example,https://a.example/,https://b.example', 'x');
  assert.deepEqual(set, ['https://a.example', 'https://b.example']);
});

test('falls back to the single configured relayer when no set is given', () => {
  assert.deepEqual(parseRelayerSet(undefined, 'http://localhost:3002'), ['http://localhost:3002']);
  assert.deepEqual(parseRelayerSet('   ', 'http://localhost:3002/'), ['http://localhost:3002']);
});

test('selection covers every relayer and respects the draw', () => {
  const set = ['a', 'b', 'c'];
  assert.equal(selectRelayer(set, fixed(0)), 'a');
  assert.equal(selectRelayer(set, fixed(0.5)), 'b');
  assert.equal(selectRelayer(set, fixed(0.999)), 'c');
});

test('selection stays in range at the top of the interval', () => {
  // next() is documented as [0,1), but a source returning exactly 1 must not
  // index past the end and throw at submit time.
  assert.equal(selectRelayer(['a', 'b'], fixed(1)), 'a');
});

test('selection is roughly uniform across the set', () => {
  // Not a statistical proof, just a guard against an off-by-one that never
  // picks the first or last operator.
  const set = ['a', 'b', 'c', 'd'];
  const counts = new Map(set.map((r) => [r, 0]));
  for (let i = 0; i < 4000; i++) {
    const picked = selectRelayer(set);
    counts.set(picked, counts.get(picked)! + 1);
  }
  for (const relayer of set) {
    const share = counts.get(relayer)! / 4000;
    assert.ok(share > 0.15 && share < 0.35, `${relayer} took ${(share * 100).toFixed(1)}% of draws`);
  }
});

test('rejects an empty relayer set rather than submitting nowhere', () => {
  assert.throws(() => selectRelayer([]), /No relayer is configured/);
});

test('delay is drawn inside the window and actually varies', () => {
  const policy = { minMs: 30_000, maxMs: 600_000 };
  const seen = new Set<number>();
  for (let i = 0; i < 500; i++) {
    const delay = drawDelayMs(policy);
    assert.ok(delay >= policy.minMs && delay <= policy.maxMs, `delay ${delay} out of window`);
    seen.add(delay);
  }
  // A policy that collapses to one value provides no decorrelation at all.
  assert.ok(seen.size > 100, `delay took only ${seen.size} distinct values`);
});

test('delay hits both ends of the window', () => {
  const policy = { minMs: 1_000, maxMs: 2_000 };
  assert.equal(drawDelayMs(policy, fixed(0)), 1_000);
  assert.equal(drawDelayMs(policy, fixed(0.9999)), 2_000);
});

test('a zero-width window is allowed and returns the fixed value', () => {
  assert.equal(drawDelayMs({ minMs: 5_000, maxMs: 5_000 }), 5_000);
});

test('rejects an inverted or negative window', () => {
  assert.throws(() => drawDelayMs({ minMs: 10, maxMs: 5 }), /Invalid delay policy/);
  assert.throws(() => drawDelayMs({ minMs: -1, maxMs: 10 }), /Invalid delay policy/);
});

test('the delay message admits when the delay cannot help', () => {
  // A delay only mixes if other transactions land inside the window. Telling a
  // user their withdrawal is "private because it is delayed" when the pool is
  // empty would be the kind of claim this project exists to avoid making.
  const empty = describeDelay(300_000, 0);
  assert.match(empty, /will not hide/);
  const busy = describeDelay(300_000, 25);
  assert.match(busy, /does not line up with your deposit/);
  assert.ok(!busy.includes('will not hide'));
});
