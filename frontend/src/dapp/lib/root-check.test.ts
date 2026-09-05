// ============================================================
// M8: the client checks its tree against the chain before proving
// ============================================================
// The client rebuilds the leaf ordering from the indexer, with the committed
// snapshot as a fallback. Nothing compared the result to the pool, so a stale
// indexer cost a full proof generation and then failed on-chain with an opaque
// `UnknownRoot` — an error that points nowhere near the actual cause.
//
// This is deliberately not a security control (the contract's root check is
// authoritative either way). It is about failing early, and saying why.

import '../../../test/public-fetch-shim.ts';

import assert from 'node:assert/strict';
import test from 'node:test';

import { assertRootMatches } from './tree-source.ts';
import { computeRoot } from './merkle.ts';

const LEAVES = [11n, 22n, 33n];

test('leaves that reproduce the pool root pass through unchanged', async () => {
  const root = await computeRoot(LEAVES);
  const out = await assertRootMatches(LEAVES, root, computeRoot);
  assert.deepEqual(out, LEAVES, 'the leaves are returned so it can wrap a fetch inline');
});

test('a stale indexer is caught before proving, and named as the cause', async () => {
  // One leaf short: exactly what an indexer that has not caught up returns.
  const stale = LEAVES.slice(0, 2);
  const chainRoot = await computeRoot(LEAVES);

  await assert.rejects(
    () => assertRootMatches(stale, chainRoot, computeRoot),
    (err: Error) => {
      assert.match(err.message, /out of date/i);
      assert.match(err.message, /indexer/i, 'the message must point at the real cause');
      assert.match(err.message, /2 leaves/, 'says what it actually had');
      return true;
    },
  );
});

test('a mis-ORDERED tree is caught even with the right leaves', async () => {
  // The dangerous case. The same commitments in the wrong order produce a
  // different root, and the historical `leafIndex = -1` bug did exactly this.
  // Counting leaves would not catch it; comparing roots does.
  const reordered = [22n, 11n, 33n];
  const chainRoot = await computeRoot(LEAVES);

  assert.equal(reordered.length, LEAVES.length, 'same count, so only the root can tell');
  await assert.rejects(
    () => assertRootMatches(reordered, chainRoot, computeRoot),
    /out of date/i,
  );
});

test('the error reports both roots in full hex', async () => {
  // A 64-hex-digit root is what the user would compare against an explorer.
  await assert.rejects(
    () => assertRootMatches([1n], 999n, computeRoot),
    (err: Error) => {
      const roots = err.message.match(/0x[0-9a-f]{64}/g) ?? [];
      assert.equal(roots.length, 2, 'both the pool root and the computed root');
      return true;
    },
  );
});

test('an empty local tree against a populated pool is rejected', async () => {
  const chainRoot = await computeRoot(LEAVES);
  await assert.rejects(() => assertRootMatches([], chainRoot, computeRoot), /out of date/i);
});
