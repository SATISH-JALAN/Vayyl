#!/usr/bin/env node
// ============================================================
// End-to-end proof pipeline test  (Task 6.6)
// ============================================================
// The single test that proves Circom → snarkjs → proof-bridge is internally
// consistent, using the FRESH zkeys/VKs from Task 5.8. For deposit + withdraw:
//   1. compute valid public inputs via the oracle circuit (consistent hashing),
//   2. groth16.fullProve with the compiled wasm + *_final.zkey,
//   3. groth16.verify against *_vkey.json  (proves wasm/zkey/vkey agree),
//   4. proof-bridge convert-proof on the proof.json  (proves serialization),
//      asserting the 256-byte A|B|C layout Soroban's verifier expects.
//
// The ONLY leg this can't exercise offline is the on-chain pairing check —
// that needs a deployed Groth16Verifier (Stellar CLI, Task 4.1). Everything
// up to the contract boundary is proven here.
//
// Usage:  node scripts/proof_pipeline_test.mjs
// Exit 0 = pipeline consistent; exit 1 = a mismatch.
// ============================================================

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as snarkjs from 'snarkjs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS = resolve(__dirname, '..');
const BUILD = resolve(CIRCUITS, 'build');
const NODE_MODULES = resolve(CIRCUITS, 'node_modules');
const DEPTH = 20;
const BRIDGE = resolve(CIRCUITS, '..', 'backend', 'proof-bridge', 'target', 'debug', 'proof-bridge.exe');

mkdirSync(BUILD, { recursive: true });

// ---- oracle plumbing (reused from payment_circuits_test) --------------------

let oracleRec = null;
function compileOracle() {
  if (oracleRec) return oracleRec;
  const src = resolve(CIRCUITS, 'test', 'oracle_note.circom');
  execSync(`circom "${src}" --wasm --sym -o "${BUILD}" -l "${NODE_MODULES}"`,
    { stdio: ['ignore', 'ignore', 'inherit'] });
  const wcBuilder = require(resolve(BUILD, 'oracle_note_js', 'witness_calculator.js'));
  const wasm = readFileSync(resolve(BUILD, 'oracle_note_js', 'oracle_note.wasm'));
  const sym = readFileSync(resolve(BUILD, 'oracle_note.sym'), 'utf8');
  const nameToIdx = new Map();
  for (const line of sym.split(/\r?\n/)) {
    if (!line) continue;
    const p = line.split(',');
    if (p[3]) nameToIdx.set(p[3], Number(p[1]));
  }
  oracleRec = { wcPromise: wcBuilder(wasm), nameToIdx };
  return oracleRec;
}

async function oracle(amount, names) {
  const { wcPromise, nameToIdx } = compileOracle();
  const wc = await wcPromise;
  const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const input = {
    amount: amount.toString(), pubX: '111', pubY: '222', blindness: '333', privKey: '444',
    pathElements: range(DEPTH, (i) => (i * 7 + 1).toString()),
    pathIndices: range(DEPTH, (i) => (i % 2).toString()),
    asp_pathElements: range(DEPTH, (i) => (i * 13 + 3).toString()),
    asp_pathIndices: range(DEPTH, (i) => ((i + 1) % 2).toString()),
  };
  const w = await wc.calculateWitness(input, true);
  const out = {};
  for (const n of names) out[n] = BigInt(w[nameToIdx.get(`main.${n}`)]);
  return out;
}

// ---- pipeline for one circuit ----------------------------------------------

let failures = 0;
function ok(label, cond, detail = '') {
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}

async function runCircuit(name, input, expectedPublicCount) {
  console.log(`\n── ${name} ──`);
  const wasm = resolve(BUILD, `${name}_js`, `${name}.wasm`);
  const zkey = resolve(BUILD, 'zkey', `${name}_final.zkey`);
  const vkey = JSON.parse(readFileSync(resolve(BUILD, 'vkey', `${name}_vkey.json`), 'utf8'));

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  ok(`${name} · proof generated (${publicSignals.length} public signals)`,
    publicSignals.length === expectedPublicCount,
    `expected ${expectedPublicCount}, got ${publicSignals.length}`);

  const verified = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  ok(`${name} · snarkjs.verify against fresh VK`, verified === true);

  // proof-bridge serialization
  const proofPath = resolve(BUILD, `${name}_proof.json`);
  const publicPath = resolve(BUILD, `${name}_public.json`);
  const binPath = resolve(BUILD, `${name}_proof.bin`);
  writeFileSync(proofPath, JSON.stringify(proof));
  writeFileSync(publicPath, JSON.stringify(publicSignals));

  if (existsSync(BRIDGE)) {
    execSync(`"${BRIDGE}" convert-proof --input "${proofPath}" --output "${binPath}"`,
      { stdio: ['ignore', 'ignore', 'inherit'] });
    const size = statSync(binPath).size;
    // A(G1=64) + B(G2=128) + C(G1=64) = 256 bytes
    ok(`${name} · proof-bridge → ${size}-byte binary (A|B|C)`, size === 256,
      `expected 256, got ${size}`);
  } else {
    console.log(`  ⚠ proof-bridge binary not found at ${BRIDGE} — skipping serialization (run: cargo build in backend/proof-bridge)`);
  }
  return { proof, publicSignals };
}

// ---- run --------------------------------------------------------------------

console.log('=== Proof pipeline (deposit + withdraw): Circom → snarkjs → proof-bridge ===');

// DEPOSIT: public [amount, commitment, asp_root]
{
  const amount = 1000n;
  const o = await oracle(amount, ['commitment', 'asp_root']);
  const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  await runCircuit('deposit', {
    amount: amount.toString(),
    commitment: o.commitment.toString(),
    asp_root: o.asp_root.toString(),
    pubX: '111', pubY: '222', blindness: '333',
    asp_pathElements: range(DEPTH, (i) => (i * 13 + 3).toString()),
    asp_pathIndices: range(DEPTH, (i) => ((i + 1) % 2).toString()),
  }, 3);
}

// WITHDRAW: public [root, nullifier, public_amount, fee, withdraw_binding]
{
  const publicAmount = 1000n, fee = 5n, amount = publicAmount + fee;
  const o = await oracle(amount, ['commitment', 'nullifier', 'root']);
  const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  await runCircuit('withdraw', {
    root: o.root.toString(),
    nullifier: o.nullifier.toString(),
    public_amount: publicAmount.toString(),
    fee: fee.toString(),
    withdraw_binding: '987654321',
    amount: amount.toString(),
    pubX: '111', pubY: '222', blindness: '333', privKey: '444',
    pathElements: range(DEPTH, (i) => (i * 7 + 1).toString()),
    pathIndices: range(DEPTH, (i) => (i % 2).toString()),
  }, 5);
}

console.log(`\n${failures === 0 ? '✅ proof pipeline consistent end-to-end (up to the on-chain pairing check)' : `❌ ${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
