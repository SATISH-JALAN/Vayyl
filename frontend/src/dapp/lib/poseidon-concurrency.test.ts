// ============================================================
// Poseidon2: concurrent calls must not corrupt each other
// ============================================================
// One WitnessCalculator instance is shared per wasm, and `calculateWitness` is
// not reentrant: it writes inputs into the module's linear memory, runs, and
// reads the witness back. Two overlapping calls interleave those steps, and the
// second call's inputs overwrite the first's -- so BOTH return the second hash,
// with no error raised anywhere.
//
// Why that is worth its own test file: a commitment computed from the wrong
// preimage is a note whose own proof cannot open it. The money is in the pool
// and unspendable, and the first symptom is an opaque on-chain verification
// failure some time later. The bug was reachable from any `Promise.all` over
// hashes, which is the natural way to write a batch derivation -- and is how it
// was found, from position-notes deriving its three domain-tagged blindings at
// once.

import '../../../test/public-fetch-shim.ts';

import assert from 'node:assert/strict';
import test from 'node:test';

import { poseidon2Hash2, poseidon2Hash4 } from './poseidon.ts';

test('concurrent hash4 calls each return their OWN hash', async () => {
  // The exact shape that failed: three different inputs launched together.
  const inputs: Array<[bigint, bigint, bigint, bigint]> = [
    [444n, 1n, 1n, 0n],
    [444n, 1n, 2n, 0n],
    [444n, 1n, 3n, 0n],
  ];

  const concurrent = await Promise.all(inputs.map((i) => poseidon2Hash4(...i)));

  // Sequentially is the ground truth: one call at a time cannot interleave.
  const sequential: bigint[] = [];
  for (const i of inputs) sequential.push(await poseidon2Hash4(...i));

  assert.deepEqual(concurrent, sequential, 'concurrent results must match sequential ones');
  assert.equal(new Set(concurrent.map(String)).size, 3, 'three inputs, three distinct hashes');
});

test('concurrent hash2 calls each return their OWN hash', async () => {
  const inputs: Array<[bigint, bigint]> = [[1n, 2n], [3n, 4n], [5n, 6n], [7n, 8n]];
  const concurrent = await Promise.all(inputs.map((i) => poseidon2Hash2(...i)));

  const sequential: bigint[] = [];
  for (const i of inputs) sequential.push(await poseidon2Hash2(...i));

  assert.deepEqual(concurrent, sequential);
  assert.equal(new Set(concurrent.map(String)).size, 4);
});

test('a heavy interleaving of both widths stays correct', async () => {
  // hash2 and hash4 use different wasm modules, so they have independent
  // queues. This checks the two queues do not interfere and that neither
  // degrades under load.
  const jobs: Array<Promise<bigint>> = [];
  const expect2: bigint[] = [];
  const expect4: bigint[] = [];
  for (let i = 0n; i < 12n; i++) {
    jobs.push(poseidon2Hash2(i, i + 1n));
    jobs.push(poseidon2Hash4(i, i + 1n, i + 2n, i + 3n));
  }
  const got = await Promise.all(jobs);

  for (let i = 0n; i < 12n; i++) {
    expect2.push(await poseidon2Hash2(i, i + 1n));
    expect4.push(await poseidon2Hash4(i, i + 1n, i + 2n, i + 3n));
  }

  for (let i = 0; i < 12; i++) {
    assert.equal(got[i * 2], expect2[i], `hash2 #${i}`);
    assert.equal(got[i * 2 + 1], expect4[i], `hash4 #${i}`);
  }
});

test('a rejected call does not wedge the queue for later callers', async () => {
  // The serialising chain must recover from a failure. If a thrown hash left the
  // queue in a rejected state, every subsequent hash in the session would fail
  // -- turning a single bad input into a dead wallet.
  await assert.rejects(() => poseidon2Hash2(undefined as unknown as bigint, 1n));
  assert.equal(await poseidon2Hash2(1n, 2n), await poseidon2Hash2(1n, 2n));
});

test('the same input still hashes to the same value under concurrency', async () => {
  // Determinism is what makes deterministic blindness derivation work at all.
  const results = await Promise.all(Array.from({ length: 8 }, () => poseidon2Hash4(9n, 8n, 7n, 6n)));
  assert.equal(new Set(results.map(String)).size, 1);
});
