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

// ---------- TRANSFER V2 (1-in / 1-out, fixed denomination) ----------
// Spends one 1-XLM note and creates one 1-XLM note for the recipient. Amounts
// are circuit constants, so there is no balance equation to attack — the
// interesting surface is the spend side, the recipient key, and the ephemeral
// point that carries recipient discovery.
{
  compile('transfer_v2', resolve(CIRCUITS, 'transfer_v2.circom'));
  compile('hash2', resolve(CIRCUITS, 'test', 'hash2.circom'));
  const h2 = async (a, b) => {
    const wc = await compiled.get('hash2').wcPromise;
    const w = await wc.calculateWitness({ in: [a.toString(), b.toString()] }, false);
    return BigInt(w[1]);
  };
  const derive = (privKey, amount, blindness) =>
    namedOutputs('test_note', {
      privKey: privKey.toString(),
      amount: amount.toString(),
      blindness: blindness.toString(),
    }, ['pubX', 'pubY', 'commitment', 'nullifier']);

  const AMOUNT = 10000000n;         // the V2 denomination, hard-coded in the circuit
  const SUBORDER =
    2736030358979909402780800718157159386076813972158567259200215660948447373041n;

  // Input note sits at index 0 of an otherwise-empty tree: climb the zero ladder.
  const zeros = [0n];
  for (let l = 1; l <= DEPTH; l++) zeros[l] = await h2(zeros[l - 1], zeros[l - 1]);
  const IN = { privKey: 444n, blindness: 333n };
  const input = await derive(IN.privKey, AMOUNT, IN.blindness);
  let root = input.commitment;
  for (let l = 0; l < DEPTH; l++) root = await h2(root, zeros[l]);

  // Note() derives a public key by scalar-multiplying the base point, so the
  // oracle doubles as a way to produce genuine curve points: the recipient's
  // key and the sender's ephemeral R = r·G are both just pubkeys of a scalar.
  const RECIPIENT_SK = 999n;
  const recipient = await derive(RECIPIENT_SK, AMOUNT, 1n);
  const EPHEMERAL_R = 12345n;
  const ephemeral = await derive(EPHEMERAL_R, AMOUNT, 1n);

  // The circuit does not verify that blindness_out came from ECDH — see the
  // header of transfer_v2.circom — so any field element is a valid witness here.
  const BLINDNESS_OUT = 24680n;
  const outCommitment = (await namedOutputs('oracle_note', {
    amount: AMOUNT.toString(),
    pubX: recipient.pubX.toString(),
    pubY: recipient.pubY.toString(),
    blindness: BLINDNESS_OUT.toString(),
    privKey: RECIPIENT_SK.toString(),
    pathElements: PATH_ELEMENTS.map(String),
    pathIndices: PATH_INDICES.map(String),
    asp_pathElements: ASP_PATH_ELEMENTS.map(String),
    asp_pathIndices: ASP_PATH_INDICES.map(String),
  }, ['commitment'])).commitment;

  const base = {
    root: root.toString(),
    nullifier: input.nullifier.toString(),
    commitment_out: outCommitment.toString(),
    ephemeral_x: ephemeral.pubX.toString(),
    ephemeral_y: ephemeral.pubY.toString(),
    privKey: IN.privKey.toString(),
    blindness_in: IN.blindness.toString(),
    pathElements: zeros.slice(0, DEPTH).map(String),
    pathIndices: range(DEPTH, () => 0n).map(String),
    out_pubX: recipient.pubX.toString(),
    out_pubY: recipient.pubY.toString(),
    blindness_out: BLINDNESS_OUT.toString(),
  };

  await expectPass('transfer v2 · valid 1-in/1-out', 'transfer_v2', base);

  await expectFail('transfer v2 · wrong nullifier', 'transfer_v2',
    { ...base, nullifier: (input.nullifier + 1n).toString() });
  await expectFail('transfer v2 · wrong root', 'transfer_v2',
    { ...base, root: (root + 1n).toString() });
  await expectFail('transfer v2 · wrong output commitment', 'transfer_v2',
    { ...base, commitment_out: (outCommitment + 1n).toString() });
  await expectFail('transfer v2 · wrong secret key', 'transfer_v2',
    { ...base, privKey: (IN.privKey + 1n).toString() });

  // F1 regression: privKey and privKey + l derive the same public key, hence the
  // same commitment and leaf, but a different nullifier. Must not be provable.
  await expectFail('transfer v2 · non-canonical privKey (k + l)', 'transfer_v2',
    { ...base, privKey: (IN.privKey + SUBORDER).toString() });
  await expectFail('transfer v2 · zero privKey', 'transfer_v2',
    { ...base, privKey: '0' });

  // A recipient key off the curve yields a commitment nobody can ever open —
  // BabyCheck turns that silent burn into a failed proof.
  await expectFail('transfer v2 · recipient pubkey off-curve', 'transfer_v2',
    { ...base, out_pubX: (recipient.pubX + 1n).toString() });
  await expectFail('transfer v2 · ephemeral point off-curve', 'transfer_v2',
    { ...base, ephemeral_x: (ephemeral.pubX + 1n).toString() });

  // Substituting a DIFFERENT well-formed ephemeral point is expected to satisfy
  // the constraints: the circuit never ties R to blindness_out. Tamper-evidence
  // comes from R being a public input, so any substitution changes the Groth16
  // statement and fails verification on-chain. This case pins that boundary so
  // nobody later mistakes the circuit for proving ECDH agreement.
  const otherEph = await derive(EPHEMERAL_R + 1n, AMOUNT, 1n);
  await expectPass('transfer v2 · different valid R satisfies the circuit (bound by proof, not constraints)',
    'transfer_v2',
    { ...base, ephemeral_x: otherEph.pubX.toString(), ephemeral_y: otherEph.pubY.toString() });
}


// ---------- RAGE-QUIT V2 (public exit) ----------
// The escape hatch for a note whose nullifier is on the ASP blocklist. There is
// no Merkle path and no privacy: `commitment` is public, so the proof's only job
// is to show the caller can open that exact commitment and that the nullifier is
// the one bound to it. The attacks worth pinning are therefore substitution
// attacks - opening someone else's commitment, or exiting with a nullifier that
// does not match the note being spent (which would leave it double-spendable).
{
  compile('ragequit_v2', resolve(CIRCUITS, 'ragequit_v2.circom'));
  const derive = (privKey, amount, blindness) =>
    namedOutputs('test_note', {
      privKey: privKey.toString(),
      amount: amount.toString(),
      blindness: blindness.toString(),
    }, ['pubX', 'pubY', 'commitment', 'nullifier']);

  const AMOUNT = 10000000n;
  const SUBORDER =
    2736030358979909402780800718157159386076813972158567259200215660948447373041n;

  const OWNER = { privKey: 4242n, blindness: 1337n };
  const note = await derive(OWNER.privKey, AMOUNT, OWNER.blindness);
  const base = {
    commitment: note.commitment.toString(),
    nullifier: note.nullifier.toString(),
    exit_binding: '55555',
    privKey: OWNER.privKey.toString(),
    blindness: OWNER.blindness.toString(),
  };

  await expectPass('ragequit v2 - owner opens their own commitment', 'ragequit_v2', base);

  // The whole security of the exit: you may only exit a commitment you can open.
  const stranger = await derive(777n, AMOUNT, 888n);
  await expectFail('ragequit v2 - exiting another party commitment', 'ragequit_v2',
    { ...base, commitment: stranger.commitment.toString() });
  await expectFail('ragequit v2 - wrong privKey for this commitment', 'ragequit_v2',
    { ...base, privKey: (OWNER.privKey + 1n).toString() });
  await expectFail('ragequit v2 - wrong blindness for this commitment', 'ragequit_v2',
    { ...base, blindness: (OWNER.blindness + 1n).toString() });

  // A mismatched nullifier would let the same note be exited AND later spent
  // through withdraw_v2, since the pool only ever marks the nullifier it is given.
  await expectFail('ragequit v2 - nullifier not bound to this commitment', 'ragequit_v2',
    { ...base, nullifier: stranger.nullifier.toString() });
  await expectFail('ragequit v2 - nullifier off by one', 'ragequit_v2',
    { ...base, nullifier: (note.nullifier + 1n).toString() });

  // Same subgroup discipline as every other Note()-based circuit: a
  // non-canonical key must not yield a second valid witness for one note.
  await expectFail('ragequit v2 - non-canonical privKey (k + l)', 'ragequit_v2',
    { ...base, privKey: (OWNER.privKey + SUBORDER).toString() });
  await expectFail('ragequit v2 - zero privKey', 'ragequit_v2',
    { ...base, privKey: '0' });

  // exit_binding is unconstrained inside the circuit by design - it is bound by
  // being a PUBLIC input, exactly like withdraw_v2's withdraw_binding. Any value
  // satisfies the constraints; tampering changes the Groth16 statement and fails
  // verification on-chain. Pinned so nobody mistakes it for a checked field.
  await expectPass('ragequit v2 - any exit_binding satisfies the constraints (bound by proof, not constraints)',
    'ragequit_v2', { ...base, exit_binding: '99999' });
}

console.log(`\n${failures === 0 ? '✅ all cases behaved as expected' : `❌ ${failures} regression(s)`}`);
process.exit(failures === 0 ? 0 : 1);
