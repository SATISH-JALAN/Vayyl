#!/usr/bin/env node
// ============================================================
// Payment-circuit soundness test  (Task 5.7)
// ============================================================
// Witness-level pass/fail tests for the deposit→withdraw vertical.
// For each in-scope circuit we assert:
//   (a) a VALID witness (all interior values consistent) generates cleanly, and
//   (b) a MALFORMED witness (one public input corrupted) is REJECTED by the
//       circuit's constraints (calculateWitness sanity check throws).
//
// Interior values (commitment / nullifier / Merkle roots) are computed by an
// oracle circuit (test/oracle_note.circom) built from the SAME library
// templates, so "valid" means byte-consistent with the real hash — no
// hand-rolled JS Poseidon2 that could silently drift (the C1 failure class).
//
// No trusted setup / ptau needed: constraint violations fail at witness
// generation. Usage:  node scripts/payment_circuits_test.mjs
// Exit 0 = all cases behaved as expected; exit 1 = a regression.
// ============================================================

import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS = resolve(__dirname, '..');
const BUILD = resolve(CIRCUITS, 'build');
const NODE_MODULES = resolve(CIRCUITS, 'node_modules');
const DEPTH = 20;

mkdirSync(BUILD, { recursive: true });

const compiled = new Map(); // name -> { wcPromise, nameToIdx: Map }

function compile(name, srcPath) {
  if (compiled.has(name)) return compiled.get(name);
  console.log(`  · compiling ${name} …`);
  execSync(`circom "${srcPath}" --wasm --sym -o "${BUILD}" -l "${NODE_MODULES}"`,
    { stdio: ['ignore', 'ignore', 'inherit'] });

  const wcBuilder = require(resolve(BUILD, `${name}_js`, 'witness_calculator.js'));
  const wasm = readFileSync(resolve(BUILD, `${name}_js`, `${name}.wasm`));

  // Map signal name -> witness index via the .sym file (format: s,w,c,name)
  const sym = readFileSync(resolve(BUILD, `${name}.sym`), 'utf8');
  const nameToIdx = new Map();
  for (const line of sym.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split(',');
    const w = parts[1];
    const signal = parts[3];
    if (signal) nameToIdx.set(signal, Number(w));
  }
  const rec = { wcPromise: wcBuilder(wasm), nameToIdx };
  compiled.set(name, rec);
  return rec;
}

async function witness(name, input) {
  const { wcPromise } = compiled.get(name);
  const wc = await wcPromise;
  // second arg true = sanity-check constraints; throws on violation
  return wc.calculateWitness(input, true);
}

async function namedOutputs(name, input, names) {
  const { nameToIdx } = compiled.get(name);
  const w = await witness(name, input);
  const out = {};
  for (const n of names) out[n] = BigInt(w[nameToIdx.get(`main.${n}`)]);
  return out;
}

// ---- test fixtures ---------------------------------------------------------

const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
// Arbitrary-but-consistent private note components + Merkle path.
const NOTE = { pubX: 111n, pubY: 222n, blindness: 333n, privKey: 444n };
const PATH_ELEMENTS = range(DEPTH, (i) => BigInt(i * 7 + 1));
const PATH_INDICES = range(DEPTH, (i) => BigInt(i % 2)); // valid bits
const ASP_PATH_ELEMENTS = range(DEPTH, (i) => BigInt(i * 13 + 3));
const ASP_PATH_INDICES = range(DEPTH, (i) => BigInt((i + 1) % 2));

function oracleInput(amount) {
  return {
    amount: amount.toString(),
    pubX: NOTE.pubX.toString(),
    pubY: NOTE.pubY.toString(),
    blindness: NOTE.blindness.toString(),
    privKey: NOTE.privKey.toString(),
    pathElements: PATH_ELEMENTS.map(String),
    pathIndices: PATH_INDICES.map(String),
    asp_pathElements: ASP_PATH_ELEMENTS.map(String),
    asp_pathIndices: ASP_PATH_INDICES.map(String),
  };
}

// ---- assertion helpers -----------------------------------------------------

let failures = 0;
async function expectPass(label, name, input) {
  try {
    await witness(name, input);
    console.log(`  ✅ PASS  ${label}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ FAIL  ${label} — valid witness was REJECTED: ${e.message.split('\n')[0]}`);
  }
}
async function expectFail(label, name, input) {
  try {
    await witness(name, input);
    failures++;
    console.log(`  ❌ FAIL  ${label} — malformed witness was ACCEPTED (unsound!)`);
  } catch {
    console.log(`  ✅ PASS  ${label} — malformed witness rejected as expected`);
  }
}

// ---- run -------------------------------------------------------------------

console.log('=== Payment-circuit soundness (deposit + withdraw) ===\n');

compile('oracle_note', resolve(CIRCUITS, 'test', 'oracle_note.circom'));
compile('deposit', resolve(CIRCUITS, 'deposit.circom'));
compile('withdraw', resolve(CIRCUITS, 'withdraw.circom'));

// ---------- DEPOSIT ----------
{
  const amount = 1000n;
  const o = await namedOutputs('oracle_note', oracleInput(amount), ['commitment', 'asp_root']);

  const base = {
    amount: amount.toString(),
    commitment: o.commitment.toString(),
    asp_root: o.asp_root.toString(),
    pubX: NOTE.pubX.toString(),
    pubY: NOTE.pubY.toString(),
    blindness: NOTE.blindness.toString(),
    asp_pathElements: ASP_PATH_ELEMENTS.map(String),
    asp_pathIndices: ASP_PATH_INDICES.map(String),
  };

  await expectPass('deposit · valid witness', 'deposit', base);
  await expectFail('deposit · wrong commitment', 'deposit',
    { ...base, commitment: (o.commitment + 1n).toString() });
  await expectFail('deposit · wrong asp_root', 'deposit',
    { ...base, asp_root: (o.asp_root + 1n).toString() });
  // amount that does not fit in 64 bits must fail the Num2Bits range check
  await expectFail('deposit · amount >= 2^64 (range check)', 'deposit',
    { ...base, amount: (1n << 64n).toString() });
}

// ---------- WITHDRAW ----------
{
  const publicAmount = 1000n;
  const fee = 5n;
  const amount = publicAmount + fee; // circuit enforces amount === public_amount + fee
  const o = await namedOutputs('oracle_note', oracleInput(amount),
    ['commitment', 'nullifier', 'root']);

  const base = {
    root: o.root.toString(),
    nullifier: o.nullifier.toString(),
    public_amount: publicAmount.toString(),
    fee: fee.toString(),
    withdraw_binding: 987654321n.toString(), // bound via public-input mechanism
    amount: amount.toString(),
    pubX: NOTE.pubX.toString(),
    pubY: NOTE.pubY.toString(),
    blindness: NOTE.blindness.toString(),
    privKey: NOTE.privKey.toString(),
    pathElements: PATH_ELEMENTS.map(String),
    pathIndices: PATH_INDICES.map(String),
  };

  await expectPass('withdraw · valid witness', 'withdraw', base);
  await expectFail('withdraw · wrong nullifier', 'withdraw',
    { ...base, nullifier: (o.nullifier + 1n).toString() });
  await expectFail('withdraw · wrong root', 'withdraw',
    { ...base, root: (o.root + 1n).toString() });
  // amount != public_amount + fee must fail the balance constraint
  await expectFail('withdraw · unbalanced amount', 'withdraw',
    { ...base, fee: (fee + 1n).toString() });
}

console.log(`\n${failures === 0 ? '✅ all cases behaved as expected' : `❌ ${failures} regression(s)`}`);
process.exit(failures === 0 ? 0 : 1);
