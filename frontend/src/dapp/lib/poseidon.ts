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

// One calculator instance is shared per wasm, and `calculateWitness` is NOT
// reentrant: it writes the inputs into the module's linear memory, runs, and
// reads the witness back out. Two overlapping calls interleave those steps, so
// the second call's inputs overwrite the first's and BOTH return the second
// hash -- silently, with no error anywhere.
//
// That is about as dangerous as a bug gets here. A commitment computed from the
// wrong preimage is a note whose own proof cannot open it: unspendable money,
// and the failure surfaces much later as an opaque on-chain verification error.
// It was reachable from any `Promise.all` over hashes, which is the obvious way
// to write a batch derivation.
//
// So calls are serialised per wasm. The cost is real but small (these are
// millisecond hashes, and the proving path is already single-threaded in a
// worker), and it removes the whole class rather than relying on every future
// caller remembering to await in sequence.
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(wasmUrl: string, job: () => Promise<T>): Promise<T> {
  const prior = queues.get(wasmUrl) ?? Promise.resolve();
  // `catch` on the CHAIN, not on the job: one failed hash must not wedge the
  // queue for every later caller, but it must still reject its own promise.
  const next = prior.then(job, job);
  queues.set(wasmUrl, next.catch(() => undefined));
  return next;
}

export async function poseidon2Hash2(a: bigint, b: bigint): Promise<bigint> {
  return serialize('/circuits/hash2.wasm', async () => {
    const wc = await calculator('/circuits/hash2.wasm');
    const w = await wc.calculateWitness({ in: [modP(a).toString(), modP(b).toString()] }, false);
    return w[1];
  });
}

export async function poseidon2Hash4(
  a: bigint, b: bigint, c: bigint, d: bigint,
): Promise<bigint> {
  return serialize('/circuits/hash4.wasm', async () => {
    const wc = await calculator('/circuits/hash4.wasm');
    const w = await wc.calculateWitness(
      { in: [modP(a).toString(), modP(b).toString(), modP(c).toString(), modP(d).toString()] },
      false,
    );
    return w[1];
  });
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
