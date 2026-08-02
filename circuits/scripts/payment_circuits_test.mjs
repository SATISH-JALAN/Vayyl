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
compile('test_note', resolve(CIRCUITS, 'test', 'test_note.circom'));
compile('deposit', resolve(CIRCUITS, 'deposit.circom'));
compile('withdraw', resolve(CIRCUITS, 'withdraw.circom'));
compile('deposit_v2', resolve(CIRCUITS, 'deposit_v2.circom'));
compile('withdraw_v2', resolve(CIRCUITS, 'withdraw_v2.circom'));
compile('transfer', resolve(CIRCUITS, 'transfer.circom'));

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

// ---------- VAULT V2 FIXED-DENOMINATION DEPOSIT ----------
{
  const amount = 10_000_000n;
  const derived = await namedOutputs('test_note', {
    privKey: NOTE.privKey.toString(),
    amount: amount.toString(),
    blindness: NOTE.blindness.toString(),
  }, ['pubX', 'pubY', 'commitment', 'nullifier']);
  const o = await namedOutputs('oracle_note', {
    ...oracleInput(amount),
    pubX: derived.pubX.toString(),
    pubY: derived.pubY.toString(),
  }, ['asp_root']);

  const base = {
    commitment: derived.commitment.toString(),
    asp_root: o.asp_root.toString(),
    privKey: NOTE.privKey.toString(),
    blindness: NOTE.blindness.toString(),
    asp_pathElements: ASP_PATH_ELEMENTS.map(String),
    asp_pathIndices: ASP_PATH_INDICES.map(String),
  };

  await expectPass('deposit v2 · valid fixed note', 'deposit_v2', base);
  await expectFail('deposit v2 · wrong commitment', 'deposit_v2',
    { ...base, commitment: (derived.commitment + 1n).toString() });
  await expectFail('deposit v2 · wrong secret key', 'deposit_v2',
    { ...base, privKey: (NOTE.privKey + 1n).toString() });
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

// ---------- VAULT V2 FIXED-DENOMINATION WITHDRAW ----------
{
  const amount = 10_000_000n;
  const derived = await namedOutputs('test_note', {
    privKey: NOTE.privKey.toString(),
    amount: amount.toString(),
    blindness: NOTE.blindness.toString(),
  }, ['pubX', 'pubY', 'commitment', 'nullifier']);
  const o = await namedOutputs('oracle_note', {
    ...oracleInput(amount),
    pubX: derived.pubX.toString(),
    pubY: derived.pubY.toString(),
  }, ['root']);

  const base = {
    root: o.root.toString(),
    nullifier: derived.nullifier.toString(),
    withdraw_binding: '987654321',
    privKey: NOTE.privKey.toString(),
    blindness: NOTE.blindness.toString(),
    pathElements: PATH_ELEMENTS.map(String),
    pathIndices: PATH_INDICES.map(String),
  };

  await expectPass('withdraw v2 · valid fixed note', 'withdraw_v2', base);
  await expectFail('withdraw v2 · wrong nullifier', 'withdraw_v2',
    { ...base, nullifier: (derived.nullifier + 1n).toString() });
  await expectFail('withdraw v2 · wrong root', 'withdraw_v2',
    { ...base, root: (o.root + 1n).toString() });
  await expectFail('withdraw v2 · wrong secret key', 'withdraw_v2',
    { ...base, privKey: (NOTE.privKey + 1n).toString() });
}

// ---------- TRANSFER (2-in / 2-out) ----------
// Input notes go through Note(), so pubX/pubY are DERIVED from privKey rather
// than supplied. Both inputs must open against the same root, so the fixture
// builds a real 2-leaf tree instead of two unrelated paths.
{
  compile('hash2', resolve(CIRCUITS, 'test', 'hash2.circom'));
  const h2 = async (a, b) => {
    const wc = await compiled.get('hash2').wcPromise;
    const w = await wc.calculateWitness({ in: [a.toString(), b.toString()] }, false);
    return BigInt(w[1]);
  };

  // Empty-subtree ladder: zeros[0] = 0, zeros[l] = H(zeros[l-1], zeros[l-1]).
  const zeros = [0n];
  for (let l = 1; l <= DEPTH; l++) zeros[l] = await h2(zeros[l - 1], zeros[l - 1]);

  const derive = (privKey, amount, blindness) =>
    namedOutputs('test_note', {
      privKey: privKey.toString(),
      amount: amount.toString(),
      blindness: blindness.toString(),
    }, ['pubX', 'pubY', 'commitment', 'nullifier']);

  const IN1 = { privKey: 444n, amount: 1000n, blindness: 333n };
  const IN2 = { privKey: 555n, amount: 500n, blindness: 777n };
  const in1 = await derive(IN1.privKey, IN1.amount, IN1.blindness);
  const in2 = await derive(IN2.privKey, IN2.amount, IN2.blindness);

  // Two leaves at indices 0 and 1 of an otherwise-empty tree share a root.
  let root = await h2(in1.commitment, in2.commitment);
  for (let l = 1; l < DEPTH; l++) root = await h2(root, zeros[l]);

  const siblings = (other) => [other, ...zeros.slice(1, DEPTH)].map(String);
  const inPath1 = siblings(in2.commitment);
  const inPath2 = siblings(in1.commitment);
  const idx1 = range(DEPTH, () => 0n).map(String);
  const idx2 = range(DEPTH, (i) => (i === 0 ? 1n : 0n)).map(String);

  // Recipient + change notes. Output keys are free witnesses (the sender does
  // not hold the recipient's private key), but must still be real curve points.
  const OUT1 = { privKey: 666n, amount: 1200n, blindness: 111n };
  const OUT2 = { privKey: 444n, amount: 295n, blindness: 222n };
  const out1 = await derive(OUT1.privKey, OUT1.amount, OUT1.blindness);
  const out2 = await derive(OUT2.privKey, OUT2.amount, OUT2.blindness);
  const fee = 5n; // 1000 + 500 === 1200 + 295 + 5

  const base = {
    root: root.toString(),
    nullifier1: in1.nullifier.toString(),
    nullifier2: in2.nullifier.toString(),
    commitment1: out1.commitment.toString(),
    commitment2: out2.commitment.toString(),
    fee: fee.toString(),
    meta_hash: '424242',

    in_amount1: IN1.amount.toString(),
    in_blindness1: IN1.blindness.toString(),
    in_privKey1: IN1.privKey.toString(),
    in_pathElements1: inPath1,
    in_pathIndices1: idx1,

    in_amount2: IN2.amount.toString(),
    in_blindness2: IN2.blindness.toString(),
    in_privKey2: IN2.privKey.toString(),
    in_pathElements2: inPath2,
    in_pathIndices2: idx2,

    out_amount1: OUT1.amount.toString(),
    out_pubX1: out1.pubX.toString(),
    out_pubY1: out1.pubY.toString(),
    out_blindness1: OUT1.blindness.toString(),

    out_amount2: OUT2.amount.toString(),
    out_pubX2: out2.pubX.toString(),
    out_pubY2: out2.pubY.toString(),
    out_blindness2: OUT2.blindness.toString(),
  };

  await expectPass('transfer · valid 2-in/2-out witness', 'transfer', base);
  await expectFail('transfer · wrong nullifier1', 'transfer',
    { ...base, nullifier1: (in1.nullifier + 1n).toString() });
  await expectFail('transfer · wrong root', 'transfer',
    { ...base, root: (root + 1n).toString() });
  await expectFail('transfer · wrong output commitment', 'transfer',
    { ...base, commitment1: (out1.commitment + 1n).toString() });
  await expectFail('transfer · unbalanced (fee bumped)', 'transfer',
    { ...base, fee: (fee + 1n).toString() });

  // F1: privKey must be canonical. privKey + l derives the SAME public key, so
  // the note and its Merkle leaf are unchanged, but the nullifier differs —
  // which is one note spent twice. DerivePublicKey's subgroup check must refuse.
  const SUBORDER =
    2736030358979909402780800718157159386076813972158567259200215660948447373041n;
  await expectFail('transfer · non-canonical privKey (privKey + l)', 'transfer',
    { ...base, in_privKey1: (IN1.privKey + SUBORDER).toString() });
  await expectFail('transfer · zero privKey', 'transfer',
    { ...base, in_privKey1: '0' });

  // A privKey the prover does not own must not open someone else's note.
  await expectFail('transfer · wrong secret key for input 1', 'transfer',
    { ...base, in_privKey1: (IN1.privKey + 1n).toString() });

  // 1.5: input amounts are range-checked to 64 bits (via Note()), so the
  // balance equation cannot be satisfied by wrapping the field.
  await expectFail('transfer · in_amount1 >= 2^64 (range check)', 'transfer',
    { ...base, in_amount1: (1n << 64n).toString() });
  await expectFail('transfer · in_amount2 >= 2^64 (range check)', 'transfer',
    { ...base, in_amount2: (1n << 64n).toString() });

  // Same note as both inputs must be caught by the distinctness constraint.
  await expectFail('transfer · same note spent twice', 'transfer', {
    ...base,
    nullifier2: in1.nullifier.toString(),
    in_amount2: IN1.amount.toString(),
    in_blindness2: IN1.blindness.toString(),
    in_privKey2: IN1.privKey.toString(),
    in_pathElements2: inPath1,
    in_pathIndices2: idx1,
  });
}

console.log(`\n${failures === 0 ? '✅ all cases behaved as expected' : `❌ ${failures} regression(s)`}`);
process.exit(failures === 0 ? 0 : 1);
