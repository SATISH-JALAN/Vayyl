#!/usr/bin/env node
// ============================================================
// Payment-circuit soundness test  (Task 5.7)
// ============================================================
// Witness-level pass/fail tests for the V2 shielded-payment vertical.
// The V1 circuits these once covered were retired: they never bound a note's
// public key to its private key, so one note could yield unlimited nullifiers.
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

console.log('=== Payment-circuit soundness (V2 vault: deposit / transfer / withdraw / rage-quit) ===\n');

compile('oracle_note', resolve(CIRCUITS, 'test', 'oracle_note.circom'));
compile('test_note', resolve(CIRCUITS, 'test', 'test_note.circom'));
compile('deposit_v2', resolve(CIRCUITS, 'deposit_v2.circom'));
compile('withdraw_v2', resolve(CIRCUITS, 'withdraw_v2.circom'));

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


// ---------- TRANSFER V3 (2-in / 2-out, arbitrary amounts) ----------
// The first circuit in this codebase with a REAL balance equation, which makes
// it the first with a real way to create money. Everything below is aimed at
// that: the valid cases establish the feature works, and the failing cases
// establish that the four ways to break conservation (mint, burn, field wrap,
// and spending one note twice) are all constrained.
{
  compile('transfer_v3', resolve(CIRCUITS, 'transfer_v3.circom'));
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
  const commitmentOf = (amount, pubX, pubY, blindness) =>
    namedOutputs('oracle_note', {
      amount: amount.toString(), pubX: pubX.toString(), pubY: pubY.toString(),
      blindness: blindness.toString(), privKey: 1n.toString(),
      pathElements: PATH_ELEMENTS.map(String), pathIndices: PATH_INDICES.map(String),
      asp_pathElements: ASP_PATH_ELEMENTS.map(String),
      asp_pathIndices: ASP_PATH_INDICES.map(String),
    }, ['commitment']).then((o) => o.commitment);

  const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const SUBORDER =
    2736030358979909402780800718157159386076813972158567259200215660948447373041n;

  // A wallet holding two notes: 100 XLM and 20 XLM, at leaves 0 and 1.
  const SENDER_SK = 444n;
  const IN1 = { amount: 1000000000n, blindness: 333n };  // 100 XLM
  const IN2 = { amount: 200000000n, blindness: 334n };   //  20 XLM
  const in1 = await derive(SENDER_SK, IN1.amount, IN1.blindness);
  const in2 = await derive(SENDER_SK, IN2.amount, IN2.blindness);

  const zeros = [0n];
  for (let l = 1; l <= DEPTH; l++) zeros[l] = await h2(zeros[l - 1], zeros[l - 1]);

  // Two leaves side by side, everything to the right empty.
  let root = await h2(in1.commitment, in2.commitment);
  for (let l = 1; l < DEPTH; l++) root = await h2(root, zeros[l]);

  const path1Elements = [in2.commitment, ...zeros.slice(1, DEPTH)];
  const path1Indices = range(DEPTH, () => 0n);
  const path2Elements = [in1.commitment, ...zeros.slice(1, DEPTH)];
  const path2Indices = range(DEPTH, (i) => (i === 0 ? 1n : 0n));

  // Pay 37 XLM, keep 83 as change. This is the exact scenario in the
  // deliverable: a fixed-denomination pool cannot express it at all.
  const PAY = 370000000n;
  const CHANGE = IN1.amount + IN2.amount - PAY; // 830000000
  const RECIPIENT_SK = 999n;
  const recipient = await derive(RECIPIENT_SK, 1n, 1n);
  const sender = { pubX: in1.pubX, pubY: in1.pubY };

  // R = r·G for each output. Both outputs get one so that a wallet restored on
  // a clean device rediscovers its CHANGE as readily as its receipts.
  const eph1 = await derive(12345n, 1n, 1n);
  const eph2 = await derive(54321n, 1n, 1n);
  const OUT1_BLIND = 24680n;
  const OUT2_BLIND = 13579n;

  const outCommitment1 = await commitmentOf(PAY, recipient.pubX, recipient.pubY, OUT1_BLIND);
  const outCommitment2 = await commitmentOf(CHANGE, sender.pubX, sender.pubY, OUT2_BLIND);

  const base = {
    root: root.toString(),
    nullifier1: in1.nullifier.toString(),
    nullifier2: in2.nullifier.toString(),
    commitment_out1: outCommitment1.toString(),
    commitment_out2: outCommitment2.toString(),
    eph1_x: eph1.pubX.toString(), eph1_y: eph1.pubY.toString(),
    eph2_x: eph2.pubX.toString(), eph2_y: eph2.pubY.toString(),
    // amount + Poseidon2(S.x, TAG_AMOUNT) mod p. The circuit only BINDS these
    // (it cannot verify the encryption without an in-circuit variable-base
    // scalar mul), so any field element is a valid witness here — the real
    // check is that a tampered value changes the public statement and fails
    // verification on-chain.
    amount_ct1: (PAY + 111111n).toString(),
    amount_ct2: (CHANGE + 222222n).toString(),
    privKey: SENDER_SK.toString(),
    in_amount1: IN1.amount.toString(),
    in_blindness1: IN1.blindness.toString(),
    in_pathElements1: path1Elements.map(String),
    in_pathIndices1: path1Indices.map(String),
    in_amount2: IN2.amount.toString(),
    in_blindness2: IN2.blindness.toString(),
    in_pathElements2: path2Elements.map(String),
    in_pathIndices2: path2Indices.map(String),
    isDummy2: '0',
    out_amount1: PAY.toString(),
    out_pubX1: recipient.pubX.toString(), out_pubY1: recipient.pubY.toString(),
    out_blindness1: OUT1_BLIND.toString(),
    out_amount2: CHANGE.toString(),
    out_pubX2: sender.pubX.toString(), out_pubY2: sender.pubY.toString(),
    out_blindness2: OUT2_BLIND.toString(),
  };

  await expectPass('transfer v3 · pay 37 from notes of 100 + 20, keep change', 'transfer_v3', base);

  // Exact payment: change note is still emitted, carrying zero. The output
  // count must not vary with whether change was needed, or the shape of the
  // transaction leaks whether the sender spent their balance exactly.
  {
    const zeroChange = await commitmentOf(0n, sender.pubX, sender.pubY, OUT2_BLIND);
    const all = IN1.amount + IN2.amount;
    const exactOut = await commitmentOf(all, recipient.pubX, recipient.pubY, OUT1_BLIND);
    await expectPass('transfer v3 · exact payment still emits a zero change note', 'transfer_v3', {
      ...base,
      out_amount1: all.toString(), commitment_out1: exactOut.toString(),
      out_amount2: '0', commitment_out2: zeroChange.toString(),
    });
  }

  // One-note wallet: input 2 is a dummy, so its membership is waived and it
  // contributes nothing. Without this a wallet holding a single note could not
  // pay at all.
  {
    const DUMMY_BLIND = 777777n;
    const dummy = await derive(SENDER_SK, 0n, DUMMY_BLIND);
    const payOut = await commitmentOf(300000000n, recipient.pubX, recipient.pubY, OUT1_BLIND);
    const changeOut = await commitmentOf(700000000n, sender.pubX, sender.pubY, OUT2_BLIND);
    const dummyBase = {
      ...base,
      nullifier2: dummy.nullifier.toString(),
      in_amount2: '0',
      in_blindness2: DUMMY_BLIND.toString(),
      // Deliberately garbage: the point is that it is never checked.
      in_pathElements2: range(DEPTH, (i) => BigInt(i + 99)).map(String),
      in_pathIndices2: range(DEPTH, () => 0n).map(String),
      isDummy2: '1',
      out_amount1: '300000000', commitment_out1: payOut.toString(),
      out_amount2: '700000000', commitment_out2: changeOut.toString(),
    };
    await expectPass('transfer v3 · single-note wallet pays via a dummy input', 'transfer_v3', dummyBase);

    // A dummy that carries value would be money from nothing.
    await expectFail('transfer v3 · dummy input carrying a nonzero amount', 'transfer_v3',
      { ...dummyBase, in_amount2: IN2.amount.toString() });

    // isDummy2 must be a bit. A larger value would satisfy
    // isDummy2*(amount)===0 only for amount 0, but could make (root-r)*(1-d)
    // vanish for a non-member note.
    await expectFail('transfer v3 · non-boolean isDummy2', 'transfer_v3',
      { ...dummyBase, isDummy2: '2' });
  }

  // ---- conservation ----
  // Minting: pay out more than was put in.
  {
    const tooMuch = await commitmentOf(PAY + 1n, recipient.pubX, recipient.pubY, OUT1_BLIND);
    await expectFail('transfer v3 · outputs exceed inputs (mint)', 'transfer_v3',
      { ...base, out_amount1: (PAY + 1n).toString(), commitment_out1: tooMuch.toString() });
  }
  // Burning: quietly destroy value. Conservation is equality, not inequality.
  {
    const tooLittle = await commitmentOf(PAY - 1n, recipient.pubX, recipient.pubY, OUT1_BLIND);
    await expectFail('transfer v3 · outputs below inputs (burn)', 'transfer_v3',
      { ...base, out_amount1: (PAY - 1n).toString(), commitment_out1: tooLittle.toString() });
  }

  // The attack the range checks exist for: choose outputs that satisfy the sum
  // MODULO p while being astronomically large in the integers. Without a width
  // bound on every term, this is free money and the equation still "balances".
  {
    const wrapA = P - 1n;
    const wrapB = IN1.amount + IN2.amount + 1n;   // wrapA + wrapB ≡ in1+in2 (mod p)
    const cA = await commitmentOf(wrapA, recipient.pubX, recipient.pubY, OUT1_BLIND);
    const cB = await commitmentOf(wrapB, sender.pubX, sender.pubY, OUT2_BLIND);
    await expectFail('transfer v3 · field-wrap overflow balances mod p', 'transfer_v3',
      { ...base,
        out_amount1: wrapA.toString(), commitment_out1: cA.toString(),
        out_amount2: wrapB.toString(), commitment_out2: cB.toString() });
  }

  // Individual width bounds, each side.
  {
    const big = 1n << 64n;
    const c = await commitmentOf(big, recipient.pubX, recipient.pubY, OUT1_BLIND);
    await expectFail('transfer v3 · out_amount1 >= 2^64', 'transfer_v3',
      { ...base, out_amount1: big.toString(), commitment_out1: c.toString(),
        out_amount2: (IN1.amount + IN2.amount - big).toString() });

    // Input amounts are bounded inside Note() itself, which is why the oracle
    // cannot even be made to produce a note of this size: the range check fires
    // before a commitment exists. Assert that directly, since it is the property
    // the balance equation leans on, then assert the transfer circuit rejects a
    // tampered input amount too.
    await expectFail('transfer v3 · Note() refuses to mint an amount >= 2^64', 'test_note',
      { privKey: SENDER_SK.toString(), amount: big.toString(), blindness: IN1.blindness.toString() });
    await expectFail('transfer v3 · in_amount1 >= 2^64', 'transfer_v3',
      { ...base, in_amount1: big.toString() });
  }

  // Presenting one note as both inputs would double the wallet's balance.
  await expectFail('transfer v3 · same note used as both inputs', 'transfer_v3',
    { ...base,
      nullifier2: in1.nullifier.toString(),
      in_amount2: IN1.amount.toString(),
      in_blindness2: IN1.blindness.toString(),
      in_pathElements2: path1Elements.map(String),
      in_pathIndices2: path1Indices.map(String) });

  // ---- ownership and membership ----
  await expectFail('transfer v3 · wrong spend key', 'transfer_v3',
    { ...base, privKey: (SENDER_SK + 1n).toString() });
  await expectFail('transfer v3 · non-canonical privKey (k + l)', 'transfer_v3',
    { ...base, privKey: (SENDER_SK + SUBORDER).toString() });
  await expectFail('transfer v3 · wrong root', 'transfer_v3',
    { ...base, root: (root + 1n).toString() });
  await expectFail('transfer v3 · real input 2 with a bogus Merkle path', 'transfer_v3',
    { ...base, in_pathElements2: range(DEPTH, (i) => BigInt(i + 5)).map(String) });
  await expectFail('transfer v3 · wrong nullifier1', 'transfer_v3',
    { ...base, nullifier1: (in1.nullifier + 1n).toString() });
  await expectFail('transfer v3 · tampered output commitment', 'transfer_v3',
    { ...base, commitment_out1: (outCommitment1 + 1n).toString() });

  // An off-curve recipient key yields a commitment nobody can ever open, which
  // burns the payment silently rather than failing loudly.
  await expectFail('transfer v3 · recipient pubkey off-curve', 'transfer_v3',
    { ...base, out_pubX1: '1', out_pubY1: '1' });
  await expectFail('transfer v3 · ephemeral point off-curve', 'transfer_v3',
    { ...base, eph1_x: '1', eph1_y: '1' });
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
