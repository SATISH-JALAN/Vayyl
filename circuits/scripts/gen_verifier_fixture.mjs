#!/usr/bin/env node
// ============================================================
// Real Groth16 proof fixture for the on-chain verifier tests
// ============================================================
// Emits contracts/groth16-verifier/src/real_proof_fixture.rs — a genuine
// withdraw_v2 proof, its verification key, and its public inputs, serialized in
// exactly the byte layout `Groth16VerifierContract::verify` consumes.
//
// Why this exists: before Sprint 1 no test in the repo ever exercised a real
// pairing. The one cross-contract test fed all-zero points, panicked inside
// Bn254G1Affine::from_bytes, and passed only because it was annotated
// `#[should_panic]` — it never reached the pairing check at all. A verifier that
// has never verified anything is not a tested verifier.
//
// Byte layout (must match circuits/scripts/format_stellar_vk.js):
//   G1 = x ‖ y                    (2 × 32-byte big-endian)
//   G2 = x_c1 ‖ x_c0 ‖ y_c1 ‖ y_c0 (4 × 32-byte big-endian — note c1 FIRST)
// Proof A/B/C are passed through unnegated; the contract negates α, vk_x and C
// itself.
//
// Usage:  node scripts/gen_verifier_fixture.mjs

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as snarkjs from 'snarkjs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS = resolve(__dirname, '..');
const BUILD = resolve(CIRCUITS, 'build');
const V2 = resolve(BUILD, 'v2');
const NODE_MODULES = resolve(CIRCUITS, 'node_modules');
const OUT = resolve(CIRCUITS, '..', 'contracts', 'groth16-verifier', 'src', 'real_proof_fixture.rs');
const DEPTH = 20;

// ---- witness helpers (same pattern as payment_circuits_test.mjs) ------------

function compile(name, srcPath) {
  execSync(`circom "${srcPath}" --wasm --sym -o "${BUILD}" -l "${NODE_MODULES}"`,
    { stdio: ['ignore', 'ignore', 'inherit'] });
  const wcBuilder = require(resolve(BUILD, `${name}_js`, 'witness_calculator.js'));
  const wasm = readFileSync(resolve(BUILD, `${name}_js`, `${name}.wasm`));
  const sym = readFileSync(resolve(BUILD, `${name}.sym`), 'utf8');
  const nameToIdx = new Map();
  for (const line of sym.split(/\r?\n/)) {
    const p = line.split(',');
    if (p[3]) nameToIdx.set(p[3], Number(p[1]));
  }
  return { wc: wcBuilder(wasm), nameToIdx };
}

console.log('· compiling helper circuits');
const hash2 = compile('hash2', resolve(CIRCUITS, 'test', 'hash2.circom'));
const testNote = compile('test_note', resolve(CIRCUITS, 'test', 'test_note.circom'));

const h2 = async (a, b) => {
  const wc = await hash2.wc;
  return BigInt((await wc.calculateWitness({ in: [a.toString(), b.toString()] }, false))[1]);
};

async function note(privKey, amount, blindness) {
  const wc = await testNote.wc;
  const w = await wc.calculateWitness({
    privKey: privKey.toString(), amount: amount.toString(), blindness: blindness.toString(),
  }, true);
  const at = (n) => BigInt(w[testNote.nameToIdx.get(`main.${n}`)]);
  return { pubX: at('pubX'), pubY: at('pubY'), commitment: at('commitment'), nullifier: at('nullifier') };
}

// ---- build a valid withdraw_v2 statement -----------------------------------

const AMOUNT = 10_000_000n; // fixed V2 denomination
const PRIV_KEY = 444n;
const BLINDNESS = 333n;
const WITHDRAW_BINDING = 987654321n;

console.log('· deriving note + Merkle path');
const n = await note(PRIV_KEY, AMOUNT, BLINDNESS);

// Note sits at index 0 of an otherwise-empty tree: climb the zero ladder.
const zeros = [0n];
for (let l = 1; l <= DEPTH; l++) zeros[l] = await h2(zeros[l - 1], zeros[l - 1]);
let root = n.commitment;
for (let l = 0; l < DEPTH; l++) root = await h2(root, zeros[l]);

const input = {
  root: root.toString(),
  nullifier: n.nullifier.toString(),
  withdraw_binding: WITHDRAW_BINDING.toString(),
  privKey: PRIV_KEY.toString(),
  blindness: BLINDNESS.toString(),
  pathElements: zeros.slice(0, DEPTH).map(String),
  pathIndices: Array.from({ length: DEPTH }, () => '0'),
};

console.log('· proving (groth16 fullProve)');
const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  input,
  resolve(V2, 'wasm', 'withdraw_v2.wasm'),
  resolve(V2, 'zkey', 'withdraw_v2_final.zkey'),
);

const vkey = JSON.parse(readFileSync(resolve(V2, 'vkey', 'withdraw_v2_vkey.json'), 'utf8'));
const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
if (!ok) throw new Error('snarkjs refused its own proof — aborting before emitting a fixture');
console.log('· snarkjs verify: OK');
console.log('· publicSignals:', publicSignals);

// ---- serialize to the contract's byte layout -------------------------------

const fe = (x) => BigInt(x).toString(16).padStart(64, '0');
const g1 = (pt) => fe(pt[0]) + fe(pt[1]);
const g2 = (pt) => fe(pt[0][1]) + fe(pt[0][0]) + fe(pt[1][1]) + fe(pt[1][0]);

const fixture = {
  proof_a: g1(proof.pi_a),
  proof_b: g2(proof.pi_b),
  proof_c: g1(proof.pi_c),
  public_inputs: publicSignals.map(fe),
  alpha_g1: g1(vkey.vk_alpha_1),
  beta_g2: g2(vkey.vk_beta_2),
  gamma_g2: g2(vkey.vk_gamma_2),
  delta_g2: g2(vkey.vk_delta_2),
  ic: vkey.IC.map(g1),
};

if (fixture.gamma_g2 === fixture.delta_g2) {
  throw new Error('gamma == delta in the generated VK (Veil Cash bug) — regenerate the setup');
}

// ---- emit Rust -------------------------------------------------------------

const arr = (items) => items.map((h) => `    "${h}",`).join('\n');

const rs = `// @generated by circuits/scripts/gen_verifier_fixture.mjs — DO NOT EDIT BY HAND.
//
// A REAL Groth16 proof for withdraw_v2, with its verification key and public
// inputs, in the exact byte layout Groth16VerifierContract::verify consumes:
//   G1 = x ‖ y                     (2 × 32-byte big-endian)
//   G2 = x_c1 ‖ x_c0 ‖ y_c1 ‖ y_c0 (4 × 32-byte big-endian, c1 first)
// A/B/C are unnegated; the contract negates alpha, vk_x and C itself.
//
// Statement proved: possession of the secret for a 1-XLM note at index 0 of an
// otherwise-empty tree, bound to a withdraw recipient.
//   public inputs = [root, nullifier, withdraw_binding]
//
// Regenerate after ANY change to withdraw_v2.circom, lib/note.circom,
// lib/babyjubjub.circom, or the phase-2 setup:
//     cd circuits && node scripts/gen_verifier_fixture.mjs

pub const PROOF_A: &str = "${fixture.proof_a}";
pub const PROOF_B: &str = "${fixture.proof_b}";
pub const PROOF_C: &str = "${fixture.proof_c}";

pub const PUBLIC_INPUTS: [&str; ${fixture.public_inputs.length}] = [
${arr(fixture.public_inputs)}
];

pub const VK_ALPHA_G1: &str = "${fixture.alpha_g1}";
pub const VK_BETA_G2: &str = "${fixture.beta_g2}";
pub const VK_GAMMA_G2: &str = "${fixture.gamma_g2}";
pub const VK_DELTA_G2: &str = "${fixture.delta_g2}";

pub const VK_IC: [&str; ${fixture.ic.length}] = [
${arr(fixture.ic)}
];
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, rs);
console.log(`· wrote ${OUT}`);

// snarkjs leaves a worker pool open; nothing else to wait on.
process.exit(0);
