#!/usr/bin/env node
// ============================================================
// Real Groth16 proof fixtures for the position circuits
// ============================================================
// Emits contracts/groth16-verifier/src/real_position_fixture.rs -- genuine
// position_open and position_close proofs with their verification keys and
// public inputs, serialized in exactly the byte layout
// `Groth16VerifierContract::verify` consumes.
//
// Why the on-chain fixture matters more here than anywhere else.
//
// The circuit soundness suite (position_circuits_test.mjs) works at the witness
// level, so it never touches a proving key, a pairing, or the contract's byte
// serialization. Everything between "the constraints are right" and "the chain
// accepts it" -- the Phase-2 setup, the G1/G2 encoding, the public-input
// ordering, the C1 canonicality guard -- is untested by it. Each of those fails
// SILENTLY: the proof verifies locally and is rejected on-chain with nothing in
// the error naming the cause. That is exactly the class of bug this repo has hit
// before.
//
// So the fixture proves the whole pipeline end to end, in the place it will
// actually run.
//
// Byte layout (must match circuits/scripts/format_stellar_vk.js):
//   G1 = x || y                       (2 x 32-byte big-endian)
//   G2 = x_c1 || x_c0 || y_c1 || y_c0 (4 x 32-byte big-endian -- c1 FIRST)
// Proof A/B/C are passed through unnegated; the contract negates alpha, vk_x
// and C itself.
//
// Usage:  node scripts/gen_position_fixture.mjs
// Requires: scripts/compile_positions.sh and scripts/setup_positions.ps1 to
// have run, so build/zkey/*_final.zkey and build/vkey/*_vkey.json exist.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as snarkjs from 'snarkjs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS = resolve(__dirname, '..');
const BUILD = resolve(CIRCUITS, 'build');
const NODE_MODULES = resolve(CIRCUITS, 'node_modules');
const OUT = resolve(
  CIRCUITS, '..', 'contracts', 'groth16-verifier', 'src', 'real_position_fixture.rs',
);
const DEPTH = 20;

// Tier 0, mirrored from contracts/vayyl-types and circuits/lib/tiers.circom.
const MARGIN = 100_000_000n;
const SIZE = 30n;
const ENTRY = 10_000_000n;
const NOTE_AMOUNT = 1_500_000_000n;
const CHANGE = NOTE_AMOUNT - MARGIN;
const PRIV_KEY = 444n;
const NOTE_BLIND = 333n;
const CHANGE_BLIND = 334n;
const POS_BLIND = 555n;
const OUT_BLIND = 777n;
const POSITION_ID = 0x5eedn;
// A winning close: the price rose 0.1 XLM per unit, so payout = margin + 30*1e6.
const CLOSE_PRICE = ENTRY + 1_000_000n;
const PAYOUT = MARGIN + SIZE * (CLOSE_PRICE - ENTRY);
const FEE = 0n;

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

console.log('. compiling the oracle circuit');
const oracleC = compile('oracle_position', resolve(CIRCUITS, 'test', 'oracle_position.circom'));
const hash2 = compile('hash2', resolve(CIRCUITS, 'test', 'hash2.circom'));

const h2 = async (a, b) => {
  const wc = await hash2.wc;
  return BigInt((await wc.calculateWitness({ in: [a.toString(), b.toString()] }, false))[1]);
};

// The note sits at index 0 of an otherwise-empty tree, so the path is the zero
// ladder -- the same shape the pool's frontier produces for a first insert.
const zeros = [0n];
for (let l = 1; l <= DEPTH; l++) zeros[l] = await h2(zeros[l - 1], zeros[l - 1]);

console.log('. deriving the position from the library templates');
const oracleInput = {
  note_amount: NOTE_AMOUNT.toString(),
  note_blindness: NOTE_BLIND.toString(),
  privKey: PRIV_KEY.toString(),
  pathElements: zeros.slice(0, DEPTH).map(String),
  pathIndices: Array.from({ length: DEPTH }, () => '0'),
  change_amount: CHANGE.toString(),
  change_blindness: CHANGE_BLIND.toString(),
  margin: MARGIN.toString(),
  size: SIZE.toString(),
  direction: '1',
  entry_price: ENTRY.toString(),
  position_blindness: POS_BLIND.toString(),
  out_amount: (PAYOUT - FEE).toString(),
  out_blindness: OUT_BLIND.toString(),
  keeper_secret: '999',
};
const ow = await (await oracleC.wc).calculateWitness(oracleInput, true);
const at = (n) => BigInt(ow[oracleC.nameToIdx.get(`main.${n}`)]);
const O = {
  noteNullifier: at('note_nullifier'),
  noteRoot: at('note_root'),
  changeCommitment: at('change_commitment'),
  posCommitment: at('pos_commitment'),
  posNullifier: at('pos_nullifier'),
  outCommitment: at('out_commitment'),
};

const statements = {
  position_open: {
    input: {
      root: O.noteRoot.toString(),
      nullifier: O.noteNullifier.toString(),
      position_commitment: O.posCommitment.toString(),
      change_commitment: O.changeCommitment.toString(),
      tier_id: '0',
      entry_price: ENTRY.toString(),
      direction: '1',
      position_id: POSITION_ID.toString(),
      privKey: PRIV_KEY.toString(),
      in_amount: NOTE_AMOUNT.toString(),
      in_blindness: NOTE_BLIND.toString(),
      pathElements: zeros.slice(0, DEPTH).map(String),
      pathIndices: Array.from({ length: DEPTH }, () => '0'),
      change_amount: CHANGE.toString(),
      change_blindness: CHANGE_BLIND.toString(),
      position_blindness: POS_BLIND.toString(),
    },
    describe: [
      'opening a tier-0 LONG at 1 XLM per unit, funded by a 150 XLM note at',
      'index 0 of an otherwise-empty tree, returning 140 XLM as change.',
      'public inputs = [root, nullifier, position_commitment, change_commitment,',
      '                 tier_id, entry_price, direction, position_id]',
    ],
  },
  position_close: {
    input: {
      position_nullifier: O.posNullifier.toString(),
      output_note_commitment: O.outCommitment.toString(),
      old_position_commitment: O.posCommitment.toString(),
      tier_id: '0',
      entry_price: ENTRY.toString(),
      direction: '1',
      payout: PAYOUT.toString(),
      fee: FEE.toString(),
      position_id: POSITION_ID.toString(),
      privKey: PRIV_KEY.toString(),
      position_blindness: POS_BLIND.toString(),
      note_blindness: OUT_BLIND.toString(),
    },
    describe: [
      'closing that same position after a 0.1 XLM/unit rise, settling to a',
      '13 XLM shielded note (10 XLM margin + 3 XLM profit, under the 30 XLM cap).',
      'public inputs = [position_nullifier, output_note_commitment,',
      '                 old_position_commitment, tier_id, entry_price, direction,',
      '                 payout, fee, position_id]',
    ],
  },
};

const fe = (x) => BigInt(x).toString(16).padStart(64, '0');
const g1 = (pt) => fe(pt[0]) + fe(pt[1]);
const g2 = (pt) => fe(pt[0][1]) + fe(pt[0][0]) + fe(pt[1][1]) + fe(pt[1][0]);
const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const blocks = [];
for (const [name, spec] of Object.entries(statements)) {
  console.log(`. proving ${name} (groth16 fullProve)`);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    spec.input,
    resolve(BUILD, 'wasm', `${name}.wasm`),
    resolve(BUILD, 'zkey', `${name}_final.zkey`),
  );

  const vkey = JSON.parse(readFileSync(resolve(BUILD, 'vkey', `${name}_vkey.json`), 'utf8'));
  if (!(await snarkjs.groth16.verify(vkey, publicSignals, proof))) {
    throw new Error(`snarkjs refused its own ${name} proof -- aborting before emitting a fixture`);
  }
  console.log(`  snarkjs verify: OK (${publicSignals.length} public inputs)`);

  const gamma = g2(vkey.vk_gamma_2);
  const delta = g2(vkey.vk_delta_2);
  if (gamma === delta) {
    throw new Error(`gamma == delta in the ${name} VK (Veil Cash bug) -- regenerate the setup`);
  }

  // C1: the contract's verifier rejects any public input at or above the BN254
  // scalar modulus. An honest witness never produces one, but asserting it here
  // means a fixture that would fail on-chain never reaches the Rust tests.
  for (const s of publicSignals) {
    if (BigInt(s) >= BN254_R) {
      throw new Error(`${name} produced a non-canonical public input: ${s}`);
    }
  }

  const upper = name.toUpperCase();
  blocks.push(`// ${spec.describe.join('\n// ')}
pub const ${upper}_PROOF_A: &str = "${g1(proof.pi_a)}";
pub const ${upper}_PROOF_B: &str = "${g2(proof.pi_b)}";
pub const ${upper}_PROOF_C: &str = "${g1(proof.pi_c)}";

pub const ${upper}_PUBLIC_INPUTS: [&str; ${publicSignals.length}] = [
${publicSignals.map((s) => `    "${fe(s)}",`).join('\n')}
];

pub const ${upper}_VK_ALPHA_G1: &str = "${g1(vkey.vk_alpha_1)}";
pub const ${upper}_VK_BETA_G2: &str = "${g2(vkey.vk_beta_2)}";
pub const ${upper}_VK_GAMMA_G2: &str = "${gamma}";
pub const ${upper}_VK_DELTA_G2: &str = "${delta}";

pub const ${upper}_VK_IC: [&str; ${vkey.IC.length}] = [
${vkey.IC.map((pt) => `    "${g1(pt)}",`).join('\n')}
];`);
}

const rs = `// @generated by circuits/scripts/gen_position_fixture.mjs -- DO NOT EDIT BY HAND.
//
// REAL Groth16 proofs for the position circuits, with their verification keys
// and public inputs, in the exact byte layout Groth16VerifierContract::verify
// consumes:
//   G1 = x || y                       (2 x 32-byte big-endian)
//   G2 = x_c1 || x_c0 || y_c1 || y_c0 (4 x 32-byte big-endian, c1 first)
// A/B/C are unnegated; the contract negates alpha, vk_x and C itself.
//
// These exist because everything between "the constraints are right" and "the
// chain accepts it" -- the Phase-2 setup, the curve-point encoding, the
// public-input ORDER -- fails silently. A wrong ordering produces a proof that
// snarkjs verifies and the contract rejects, with nothing in the failure that
// points at the cause.
//
// Regenerate after ANY change to position_open.circom, position_close.circom,
// lib/tiers.circom, lib/note.circom, lib/position_primitives.circom,
// lib/babyjubjub.circom, or the phase-2 setup:
//     circuits/scripts/compile_positions.sh
//     circuits/scripts/setup_positions.ps1
//     node circuits/scripts/gen_position_fixture.mjs

${blocks.join('\n\n')}
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, rs);
console.log(`. wrote ${OUT}`);
process.exit(0);
