// ============================================================
// Client ↔ circuit key-derivation parity  (Sprint 1, task 1.2)
// ============================================================
// The circuit derives a note's public key from its private key
// (`DerivePublicKey()` in circuits/lib/babyjubjub.circom). The client must
// derive the SAME point, or the commitment it builds hashes to a Merkle leaf the
// proof cannot open — which surfaces on-chain as an opaque verification failure,
// not as anything pointing at key derivation. That silent-mismatch mode is what
// these tests exist to prevent.
//
// Ground truth is the COMPILED CIRCUIT, not a second JS implementation. If the
// artifacts are missing the tests fail loudly with build instructions rather than
// skipping: a parity check that quietly no-ops is worse than no parity check.
//
//   Build:  cd circuits
//           circom test/test_derive_key.circom --r1cs --wasm -o build/ -l node_modules
//           circom test/test_note.circom --r1cs --wasm -o build/ -l node_modules
//   Run:    cd frontend && pnpm test

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import buildWitnessCalculator from './witness_calculator.js';
import {
  BASE8,
  FIELD_P,
  SUBORDER,
  addPoint,
  derivePublicKey,
  inCurve,
  mulPointEscalar,
} from './babyjub.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const CIRCUIT_SRC = path.join(REPO, 'circuits/lib/babyjubjub.circom');

// poseidon.ts loads its Poseidon2 wasm with `fetch('/circuits/hash2.wasm')`, an
// absolute URL with no meaning outside a browser. Serve those paths off
// frontend/public so deriveShieldedKeys runs here exactly as the app runs it —
// same wasm, same hashing — rather than against a stand-in.
const PUBLIC_DIR = path.join(REPO, 'frontend/public');
const upstreamFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString();
  if (url.startsWith('/')) {
    const file = path.join(PUBLIC_DIR, url);
    if (!existsSync(file)) throw new Error(`test fetch shim: missing ${file}`);
    return new Response(readFileSync(file), { status: 200 });
  }
  return upstreamFetch(input, init);
}) as typeof fetch;

function loadCircuit(name: string, wasmRelPath: string) {
  const wasmPath = path.join(REPO, wasmRelPath);
  if (!existsSync(wasmPath)) {
    throw new Error(
      `Missing circuit artifact for ${name}: ${wasmPath}\n` +
        `Build it first:\n  cd circuits && circom test/${name}.circom --r1cs --wasm -o build/ -l node_modules`,
    );
  }
  return buildWitnessCalculator(readFileSync(wasmPath));
}

const deriveKeyCircuit = loadCircuit(
  'test_derive_key',
  'circuits/build/test_derive_key_js/test_derive_key.wasm',
);
const noteCircuit = loadCircuit('test_note', 'circuits/build/test_note_js/test_note.wasm');

/** DerivePublicKey() witness: [1, pubX, pubY, privKey]. */
async function circuitDerivePublicKey(privKey: bigint) {
  const wc = await deriveKeyCircuit;
  const w = await wc.calculateWitness({ privKey: privKey.toString() }, true);
  return { pubX: w[1], pubY: w[2] };
}

/** Note() witness: [1, pubX, pubY, commitment, nullifier, ...inputs]. */
async function circuitNote(privKey: bigint, amount: bigint, blindness: bigint) {
  const wc = await noteCircuit;
  const w = await wc.calculateWitness(
    { privKey: privKey.toString(), amount: amount.toString(), blindness: blindness.toString() },
    true,
  );
  return { pubX: w[1], pubY: w[2], commitment: w[3], nullifier: w[4] };
}

const rejects = async (privKey: bigint) => {
  await assert.rejects(() => circuitNote(privKey, 10_000_000n, 12345n));
};

// A spread of scalars: small, large, and both boundaries of [1, l).
const SCALARS = [
  1n,
  2n,
  12345n,
  1234567890123456789012345678901234567890n,
  SUBORDER / 2n,
  SUBORDER - 2n,
  SUBORDER - 1n,
];

// ---- the load-bearing test -------------------------------------------------

test('client derivePublicKey matches the circuit witness exactly', async () => {
  for (const sk of SCALARS) {
    const client = derivePublicKey(sk);
    const circuit = await circuitDerivePublicKey(sk);
    assert.equal(client.pubX, circuit.pubX, `pubX mismatch for privKey=${sk}`);
    assert.equal(client.pubY, circuit.pubY, `pubY mismatch for privKey=${sk}`);
  }
});

test('client derivation matches the full Note() template too', async () => {
  for (const sk of SCALARS.slice(0, 4)) {
    const client = derivePublicKey(sk);
    const note = await circuitNote(sk, 10_000_000n, 999n);
    assert.equal(client.pubX, note.pubX);
    assert.equal(client.pubY, note.pubY);
  }
});

// ---- constants are pinned to the circuit source ----------------------------

test('BASE8 and SUBORDER match circuits/lib/babyjubjub.circom', () => {
  const src = readFileSync(CIRCUIT_SRC, 'utf8');
  assert.ok(src.includes(BASE8[0].toString()), 'BASE8.x is not the circuit base point');
  assert.ok(src.includes(BASE8[1].toString()), 'BASE8.y is not the circuit base point');
  assert.ok(src.includes(SUBORDER.toString()), 'SUBORDER is not the circuit subgroup order');
});

test('babyjub FIELD_P has not drifted from poseidon FIELD_P', async () => {
  const poseidon = await import('./poseidon.ts');
  assert.equal(FIELD_P, poseidon.FIELD_P);
});

test('BASE8 is on the curve and has order SUBORDER', () => {
  assert.ok(inCurve(BASE8));
  // l·G == identity, and no smaller multiple tested here is
  const [ix, iy] = mulPointEscalar(BASE8, SUBORDER);
  assert.equal(ix, 0n);
  assert.equal(iy, 1n);
});

test('point arithmetic is internally consistent', () => {
  const g2 = addPoint(BASE8, BASE8);
  assert.deepEqual(mulPointEscalar(BASE8, 2n), g2);
  assert.deepEqual(mulPointEscalar(BASE8, 3n), addPoint(g2, BASE8));
  assert.ok(inCurve(mulPointEscalar(BASE8, 1234567n)));
});

// ---- F1 regression: one note must yield exactly one nullifier ---------------

test('circuit rejects non-canonical scalars (the F1 double-spend)', async () => {
  const k = 1234567890123456789012345678901234567890n;

  // k and k+l derive the SAME public key -> same commitment, same Merkle leaf
  // -> but nullifier = Poseidon2(commitment, privKey) differs. Before the
  // subgroup constraint this gave 6 spends of one note.
  const viaClient = derivePublicKey(k);
  const shifted = mulPointEscalar(BASE8, k + SUBORDER);
  assert.equal(viaClient.pubX, shifted[0], 'k and k+l must share a public key (curve fact)');
  assert.equal(viaClient.pubY, shifted[1]);

  // ...so the circuit has to be the thing that refuses them.
  await rejects(k + SUBORDER);
  await rejects(k + 2n * SUBORDER);
  await rejects(SUBORDER);
  await rejects(2n * SUBORDER);
});

test('circuit rejects the zero scalar (identity point is spendable by anyone)', async () => {
  await rejects(0n);
});

test('circuit accepts both boundaries of the canonical range', async () => {
  await assert.doesNotReject(() => circuitNote(1n, 10_000_000n, 1n));
  await assert.doesNotReject(() => circuitNote(SUBORDER - 1n, 10_000_000n, 1n));
});

test('client refuses out-of-range scalars instead of emitting a bad key', () => {
  assert.throws(() => derivePublicKey(0n), /\[1, /);
  assert.throws(() => derivePublicKey(SUBORDER), /\[1, /);
  assert.throws(() => derivePublicKey(SUBORDER + 1n), /\[1, /);
  assert.throws(() => derivePublicKey(-1n), /\[1, /);
});

// ---- deriveShieldedKeys produces keys the circuit always accepts ------------
//
// The spend key is a Poseidon2 output reduced mod l. Unreduced it exceeds the
// circuit's 251-bit decomposition roughly a third of the time, which failed
// witness generation outright — so this covers completeness, not just soundness.

test('deriveShieldedKeys yields canonical, circuit-valid keys', async () => {
  const { deriveShieldedKeys } = await import('./keys.ts');

  for (let i = 0; i < 12; i++) {
    const viewingKey = (BigInt(i) * 0x9e3779b97f4a7c15n)
      .toString(16)
      .padStart(64, '0')
      .slice(-64);
    const keys = await deriveShieldedKeys(viewingKey);

    assert.ok(keys.spendKey >= 1n && keys.spendKey < SUBORDER, `spendKey out of range: ${keys.spendKey}`);

    const circuit = await circuitDerivePublicKey(keys.spendKey);
    assert.equal(keys.pubX, circuit.pubX, `pubX mismatch for viewingKey ${viewingKey}`);
    assert.equal(keys.pubY, circuit.pubY, `pubY mismatch for viewingKey ${viewingKey}`);
  }
});

test('deriveShieldedKeys is deterministic', async () => {
  const { deriveShieldedKeys } = await import('./keys.ts');
  const vk = 'a3f1'.repeat(16);
  const a = await deriveShieldedKeys(vk);
  const b = await deriveShieldedKeys(vk);
  assert.deepEqual(a, b);
});
