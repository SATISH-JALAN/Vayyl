// ============================================================
// Poseidon2 hashing (worker-safe, no wallet imports)  (Task 6.2)
// ============================================================
// Byte-identical to the Circom circuits — runs the same Poseidon2Hash_2 /
// Poseidon2Hash_4 templates compiled to /circuits/hash{2,4}.wasm via the
// vendored circom witness calculator. Kept free of @stellar/freighter-api so it
// can be imported from the proof Web Worker (no `window`) and the main thread.

import buildWitnessCalculator from './witness_calculator.js';

export const FIELD_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const modP = (x: bigint) => ((x % FIELD_P) + FIELD_P) % FIELD_P;

const wcCache = new Map<string, Promise<import('./witness_calculator.js').WitnessCalculator>>();

async function calculator(wasmUrl: string) {
  let p = wcCache.get(wasmUrl);
  if (!p) {
    p = (async () => {
      const resp = await fetch(wasmUrl);
      if (!resp.ok) throw new Error(`Failed to load ${wasmUrl}: ${resp.status}`);
      return buildWitnessCalculator(await resp.arrayBuffer());
    })();
    wcCache.set(wasmUrl, p);
  }
  return p;
}

export async function poseidon2Hash2(a: bigint, b: bigint): Promise<bigint> {
  const wc = await calculator('/circuits/hash2.wasm');
  const w = await wc.calculateWitness({ in: [modP(a).toString(), modP(b).toString()] }, false);
  return w[1];
}

export async function poseidon2Hash4(
  a: bigint, b: bigint, c: bigint, d: bigint,
): Promise<bigint> {
  const wc = await calculator('/circuits/hash4.wasm');
  const w = await wc.calculateWitness(
    { in: [modP(a).toString(), modP(b).toString(), modP(c).toString(), modP(d).toString()] },
    false,
  );
  return w[1];
}

/** commitment = Poseidon2(amount, pubX, pubY, blindness) */
export const computeCommitment = (amount: bigint, pubX: bigint, pubY: bigint, blindness: bigint) =>
  poseidon2Hash4(amount, pubX, pubY, blindness);

/** nullifier = Poseidon2(commitment, privKey) */
export const computeNullifier = (commitment: bigint, privKey: bigint) =>
  poseidon2Hash2(commitment, privKey);

export function randomFieldElement(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return modP(x);
}
