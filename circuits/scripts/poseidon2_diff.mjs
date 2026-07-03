#!/usr/bin/env node
// ============================================================
// Poseidon2 differential test harness  (Phase 0, Task 4.3)
// ============================================================
// "The single most important test in the entire project."
//
// Runs canonical inputs through the compiled Circom circuit and
// compares the output against the on-chain (rs-soroban-poseidon)
// values pinned in that crate's own test suite. A mismatch means
// commitments hashed client-side would be unspendable on-chain —
// the C1 / Bug-1 failure class, which is otherwise SILENT.
//
// Expected values are the exact hex literals asserted in
//   rs-soroban-poseidon/src/tests/poseidon2.rs
// (verified by that crate's `cargo test`), so they ARE the host output.
//
// Usage:  node scripts/poseidon2_diff.mjs
// Exit 0 = every vector matches; exit 1 = at least one mismatch.
// ============================================================

import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS = resolve(__dirname, '..');
const BUILD = resolve(CIRCUITS, 'build');
const NODE_MODULES = resolve(CIRCUITS, 'node_modules');

// BN254 scalar field modulus
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const mod = (x) => ((x % P) + P) % P;
const hx = (h) => BigInt(h);

// The large test value used by TV2 (sponge) and TV3 (permutation), reduced mod p
// exactly as the host's field arithmetic / compute_hash would reduce it.
const BIG = mod(hx('0x9a807b615c4d3e2fa0b1c2d3e4f56789fedcba9876543210abcdef0123456789'));

// ---- canonical vectors (pinned from rs-soroban-poseidon/src/tests/poseidon2.rs) ----
// `expected` are output STATE cells (permutation) or the single squeezed value (hash).
// `reduceInputs`: feed the field-reduced representative (matches host field/compute_hash).
const VECTORS = [
  // --- raw permutations ---
  { circuit: 'diff_perm_t2', label: 'perm t2 [0,1]',
    inputs: [0n, 1n], nOut: 2,
    expected: ['0x1d01e56f49579cec72319e145f06f6177f6c5253206e78c2689781452a31878b',
               '0x0d189ec589c41b8cffa88cfc523618a055abe8192c70f75aa72fc514560f6c61'] },
  { circuit: 'diff_perm_t3', label: 'perm t3 [0,1,2]',
    inputs: [0n, 1n, 2n], nOut: 3,
    expected: ['0x0bb61d24daca55eebcb1929a82650f328134334da98ea4f847f760054f4a3033',
               '0x303b6f7c86d043bfcbcc80214f26a30277a15d3f74ca654992defe7ff8d03570',
               '0x1ed25194542b12eef8617361c3ba7c52e660b145994427cc86296242cf766ec8'] },
  { circuit: 'diff_perm_t4', label: 'perm t4 [0,1,2,3]  (TV1)',
    inputs: [0n, 1n, 2n, 3n], nOut: 4,
    expected: ['0x01bd538c2ee014ed5141b29e9ae240bf8db3fe5b9a38629a9647cf8d76c01737',
               '0x239b62e7db98aa3a2a8f6a0d2fa1709e7a35959aa6c7034814d9daa90cbac662',
               '0x04cbb44c61d928ed06808456bf758cbf0c18d1e15a7b6dbc8245fa7515d5e3cb',
               '0x2e11c5cff2a22c64d01304b778d78f6998eff1ab73163a35603f54794c30847a'] },
  { circuit: 'diff_perm_t4', label: 'perm t4 [BIG x4]  (TV3)',
    inputs: [BIG, BIG, BIG, BIG], nOut: 4,
    expected: ['0x2bf1eaf87f7d27e8dc4056e9af975985bccc89077a21891d6c7b6ccce0631f95',
               '0x0c01fa1b8d0748becafbe452c0cb0231c38224ea824554c9362518eebdd5701f',
               '0x018555a8eb50cf07f64b019ebaf3af3c925c93e631f3ecd455db07bbb52bbdd3',
               '0x0cbea457c91c22c6c31fd89afd2541efc2edf31736b9f721e823b2165c90fd41'] },

  // --- sponge hashes (t=4) ---
  { circuit: 'diff_hash3', label: 'hash3 [1,2,3]  (noir n3)',
    inputs: [1n, 2n, 3n], nOut: 1,
    expected: ['0x23864adb160dddf590f1d3303683ebcb914f828e2635f6e85a32f0a1aecd3dd8'] },
  { circuit: 'hash4', label: 'hash4 [1,2,3,4]  (noir n4)',
    inputs: [1n, 2n, 3n, 4n], nOut: 1,
    expected: ['0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9'] },
  { circuit: 'hash4', label: 'hash4 [BIG x4]  (TV2 / barretenberg)',
    inputs: [BIG, BIG, BIG, BIG], nOut: 1,
    expected: ['0x2f43a0f83b51a6f5fc839dea0ecec74947637802a579fa9841930a25a0bcec11'] },
  { circuit: 'diff_hash5', label: 'hash5 [1,2,3,4,5]  (noir n5)',
    inputs: [1n, 2n, 3n, 4n, 5n], nOut: 1,
    expected: ['0x2247be7014a54d17342a7ef677f58d28877780d203860396967f5d0a18d259db'] },
];

// ---- compile + witness plumbing --------------------------------------------

mkdirSync(BUILD, { recursive: true });
const compiled = new Map(); // circuit -> { wc, outIdx: number[] }

function compile(circuit) {
  if (compiled.has(circuit)) return compiled.get(circuit);
  const src = resolve(CIRCUITS, 'test', `${circuit}.circom`);
  console.log(`  · compiling ${circuit} …`);
  execSync(`circom "${src}" --wasm --sym -o "${BUILD}" -l "${NODE_MODULES}"`,
    { stdio: ['ignore', 'ignore', 'inherit'] });

  // Load witness calculator (CommonJS) + wasm bytes
  const wcBuilder = require(resolve(BUILD, `${circuit}_js`, 'witness_calculator.js'));
  const wasm = readFileSync(resolve(BUILD, `${circuit}_js`, `${circuit}.wasm`));

  // Map main.out[i] -> witness index via the .sym file (format: s,w,c,name)
  const sym = readFileSync(resolve(BUILD, `${circuit}.sym`), 'utf8');
  const outIdx = [];
  for (const line of sym.split(/\r?\n/)) {
    if (!line) continue;
    const [, w, , name] = line.split(',');
    const m = name && name.match(/^main\.out(?:\[(\d+)\])?$/);
    if (m) outIdx[m[1] === undefined ? 0 : +m[1]] = Number(w);
  }
  const rec = { wcBuilderPromise: wcBuilder(wasm), outIdx };
  compiled.set(circuit, rec);
  return rec;
}

async function witnessOutputs(circuit, inputs, nOut) {
  const { wcBuilderPromise, outIdx } = compile(circuit);
  const wc = await wcBuilderPromise;
  const w = await wc.calculateWitness({ in: inputs.map((x) => x.toString()) }, true);
  const out = [];
  for (let i = 0; i < nOut; i++) out.push(BigInt(w[outIdx[i]]));
  return out;
}

// ---- run -------------------------------------------------------------------

console.log('=== Poseidon2 differential harness (Circom vs rs-soroban-poseidon) ===\n');
let failures = 0;

for (const v of VECTORS) {
  let ok = true, detail = '';
  try {
    const got = await witnessOutputs(v.circuit, v.inputs, v.nOut);
    for (let i = 0; i < v.nOut; i++) {
      if (got[i] !== mod(hx(v.expected[i]))) {
        ok = false;
        if (!detail) detail = `        out[${i}] want ${hx(v.expected[i])}\n                 got  ${got[i]}`;
      }
    }
  } catch (e) {
    ok = false; detail = `        error: ${e.message.split('\n')[0]}`;
  }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${v.label}`);
  if (!ok && detail) console.log(detail);
  if (!ok) failures++;
}

console.log(`\n${failures === 0 ? 'ALL VECTORS MATCH ✅  — Circom Poseidon2 == on-chain'
  : `${failures}/${VECTORS.length} VECTOR(S) FAILED ❌  — do NOT trust any hash until green`}`);
process.exit(failures === 0 ? 0 : 1);
