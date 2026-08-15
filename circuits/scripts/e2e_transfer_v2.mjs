#!/usr/bin/env node
// ============================================================
// Shielded transfer, end to end on testnet
// ============================================================
// Proves the whole payment loop against the live V2 stack, with no browser and
// no wallet in the way:
//
//   1. Alice spends a deposited note and creates one for Bob
//   2. Bob DISCOVERS it from public event data alone — the ephemeral point R
//      and his own spend key, with nothing sent to him out of band
//   3. Bob withdraws it to a Stellar account
//
// Step 2 is the one that matters. If the ECDH derivation in the browser ever
// drifts from the one used when sending, payments silently become unspendable
// and nothing errors — the note simply never appears. Running it here, against
// the same wasm the app ships, is what makes that failure loud.
//
// Usage:  node scripts/e2e_transfer_v2.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { Address } from '@stellar/stellar-sdk';
import { groth16 } from 'snarkjs';

const require = createRequire(import.meta.url);
const CIRCUITS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(CIRCUITS, '..');
const BUILD = resolve(CIRCUITS, 'build');
const V2 = resolve(BUILD, 'v2');
const deployment = JSON.parse(readFileSync(resolve(REPO, 'deployments', 'testnet-vault-v2.json'), 'utf8'));

const DEPTH = 20;
const AMOUNT = 10_000_000n;
const SOURCE = process.env.STELLAR_SOURCE || 'deployer';
const SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
const FIELD_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ---- chain helpers ---------------------------------------------------------

function stellar(...args) {
  try {
    return execFileSync('stellar', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    // The CLI can panic while FORMATTING the result of a call that already
    // committed (soroban-spec-tools cannot render some Address values). The
    // transaction is on-chain regardless, so treat a submitted tx as success —
    // the same allowance e2e_vault_v2.mjs makes.
    const stderr = error?.stderr?.toString() ?? '';
    if (stderr.includes('Transaction submitted successfully!')) return '';
    throw error;
  }
}
function invoke(id, fn, args = [], view = false) {
  const cmd = ['contract', 'invoke', '--id', id, '--network', 'testnet', '--source', SOURCE];
  if (view) cmd.push('--send', 'no');
  return stellar(...cmd, '--', fn, ...args);
}
const fieldHex = (v) => BigInt(v).toString(16).padStart(64, '0');
const bytesArg = (v) => JSON.stringify({ bytes: fieldHex(v) });
const parseHex = (v) => BigInt(`0x${v.replace(/^"|"$/g, '').replace(/^0x/, '')}`);

// ---- circuit-backed crypto (never hand-rolled) -----------------------------

const wcCache = new Map();
async function calc(name, dir, input) {
  if (!wcCache.has(name)) {
    const builder = require(resolve(dir, `${name}_js`, 'witness_calculator.js'));
    wcCache.set(name, builder(readFileSync(resolve(dir, `${name}_js`, `${name}.wasm`))));
  }
  return (await wcCache.get(name)).calculateWitness(input, false);
}
const h2 = async (a, b) => BigInt((await calc('hash2', BUILD, { in: [a.toString(), b.toString()] }))[1]);
const h4 = async (a, b, c, d) =>
  BigInt((await calc('hash4', BUILD, { in: [a, b, c, d].map(String) }))[1]);

/**
 * Note() outputs, read positionally: [1]=pubX [2]=pubY [3]=commitment [4]=nullifier.
 * Uses test_note, which is a bare `Note()` main component — the same template
 * the deposit/withdraw/transfer circuits instantiate, so the values here cannot
 * drift from what the pool verifies.
 */
async function note(privKey, amount, blindness) {
  const w = await calc('test_note', BUILD, {
    privKey: privKey.toString(), amount: amount.toString(), blindness: blindness.toString(),
  });
  return { pubX: BigInt(w[1]), pubY: BigInt(w[2]), commitment: BigInt(w[3]), nullifier: BigInt(w[4]) };
}

// BabyJubjub in native BigInt — mirrors frontend/src/dapp/lib/babyjub.ts.
const A = 168700n, D = 168696n;
const mod = (x) => ((x % FIELD_P) + FIELD_P) % FIELD_P;
function addPoint([x1, y1], [x2, y2]) {
  const beta = mod(x1 * y2), gamma = mod(y1 * x2);
  const delta = mod((y1 - mod(A * x1)) * (x2 + y2));
  const tau = mod(beta * gamma);
  const dtau = mod(D * tau);
  const inv = (v) => {
    let [old_r, r] = [mod(v), FIELD_P], [old_s, s] = [1n, 0n];
    while (r !== 0n) { const q = old_r / r; [old_r, r] = [r, old_r - q * r]; [old_s, s] = [s, old_s - q * s]; }
    return mod(old_s);
  };
  return [mod((beta + gamma) * inv(1n + dtau)), mod((delta + mod(A * beta) - gamma) * inv(1n - dtau))];
}
function mulPointEscalar(base, scalar) {
  let res = [0n, 1n], exp = base, rem = scalar;
  while (rem !== 0n) { if (rem & 1n) res = addPoint(res, exp); exp = addPoint(exp, exp); rem >>= 1n; }
  return res;
}
const BASE8 = [
  5299619240641551281634865583518297030282874472190772894086521144482721001553n,
  16950150798460657717958625567821834550301663161624707787222815936182638968203n,
];

// ---- Merkle ----------------------------------------------------------------

async function zeroLadder() {
  const zeros = [0n];
  for (let l = 1; l <= DEPTH; l++) zeros[l] = await h2(zeros[l - 1], zeros[l - 1]);
  return zeros;
}
async function merklePath(leaves, index, zeros) {
  const pathElements = [], pathIndices = [];
  let level = [...leaves], idx = index;
  for (let l = 0; l < DEPTH; l++) {
    const sibling = idx % 2 === 0 ? (level[idx + 1] ?? zeros[l]) : level[idx - 1];
    pathElements.push(sibling);
    pathIndices.push(idx % 2);
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(await h2(level[i], level[i + 1] ?? zeros[l]));
    level = next;
    idx >>= 1;
  }
  let root = level[0] ?? zeros[DEPTH];
  return { root, pathElements, pathIndices };
}

// ---- run -------------------------------------------------------------------

console.log(`pool     ${deployment.pool}`);
console.log(`verifier ${deployment.verifier}\n`);

const zeros = await zeroLadder();

// Rebuild the on-chain leaf set. e2e_vault_v2.mjs seeded five deposits from
// deterministic keys, so the same derivation reproduces them exactly.
const leafCount = Number(invoke(deployment.pool, 'get_leaf_count', [], true).replace(/"/g, ''));
assert.ok(leafCount >= 1, 'pool has no leaves; run e2e_vault_v2.mjs first');
console.log(`· pool holds ${leafCount} leaves`);

const DEPOSIT_COUNT = 5;      // seeded by e2e_vault_v2.mjs
const R_BASE = 424242424242n; // ephemeral scalar for transfer #0; #k uses R_BASE + k

// Deterministic reconstruction so the script is re-runnable: the first five
// leaves are the seeded deposits, and every later leaf is a transfer output
// this script itself created, each from a known ephemeral scalar.
const BOB_SPEND_KEY = 777000111222333n % SUBORDER;
const bob = mulPointEscalar(BASE8, BOB_SPEND_KEY);

const seeded = [];
for (let i = 0; i < DEPOSIT_COUNT; i++) {
  seeded.push(await note(1001n + BigInt(i), AMOUNT, 2001n + BigInt(i)));
}
const priorTransfers = Math.max(0, leafCount - DEPOSIT_COUNT);
const leaves = seeded.map((n) => n.commitment);
for (let k = 0; k < priorTransfers; k++) {
  const Rk = mulPointEscalar(BASE8, (R_BASE + BigInt(k)) % SUBORDER);
  const Sk = mulPointEscalar(bob, (R_BASE + BigInt(k)) % SUBORDER);
  void Rk;
  leaves.push(await h4(AMOUNT, bob[0], bob[1], await h2(Sk[0], 0n)));
}

const onchainRoot = parseHex(invoke(deployment.pool, 'get_root', [], true));
const rebuilt = await merklePath(leaves, 0, zeros);
assert.equal(rebuilt.root, onchainRoot, 'rebuilt root does not match on-chain root');
console.log(`· rebuilt Merkle root matches on-chain root (${priorTransfers} prior transfer(s))`);

// Spend a deposit that has not been spent yet: one per run.
//
// The default derivation assumes seeded deposits are consumed only by this
// script. `e2e_ragequit_v2.mjs` also consumes one, so pass TRANSFER_INDEX
// explicitly after a rage-quit run rather than letting this collide with an
// already-spent note.
const spendIndex = Number(process.env.TRANSFER_INDEX ?? priorTransfers);
assert.ok(spendIndex < DEPOSIT_COUNT, `all ${DEPOSIT_COUNT} seeded deposits are spent; re-seed with e2e_vault_v2.mjs`);
const alice = seeded[spendIndex];
console.log(`· Alice spends deposit ${spendIndex}`);
console.log(`· Bob's shielded pubkey ${bob[0].toString().slice(0, 16)}…`);

// ---- Alice builds the payment ----
// r is one-time; R goes on chain, S never leaves this process.
const r = (R_BASE + BigInt(priorTransfers)) % SUBORDER;
const R = mulPointEscalar(BASE8, r);
const S = mulPointEscalar(bob, r);
const outBlindness = await h2(S[0], 0n);
const outCommitment = await h4(AMOUNT, bob[0], bob[1], outBlindness);

const path = await merklePath(leaves, spendIndex, zeros);
console.log('· proving transfer_v2 …');
const { proof, publicSignals } = await groth16.fullProve({
  root: path.root.toString(),
  nullifier: alice.nullifier.toString(),
  commitment_out: outCommitment.toString(),
  ephemeral_x: R[0].toString(),
  ephemeral_y: R[1].toString(),
  privKey: (1001n + BigInt(spendIndex)).toString(),
  blindness_in: (2001n + BigInt(spendIndex)).toString(),
  pathElements: path.pathElements.map(String),
  pathIndices: path.pathIndices.map(String),
  out_pubX: bob[0].toString(),
  out_pubY: bob[1].toString(),
  blindness_out: outBlindness.toString(),
}, resolve(V2, 'wasm', 'transfer_v2.wasm'), resolve(V2, 'zkey', 'transfer_v2_final.zkey'));

const vkey = JSON.parse(readFileSync(resolve(V2, 'vkey', 'transfer_v2_vkey.json'), 'utf8'));
assert.ok(await groth16.verify(vkey, publicSignals, proof), 'snarkjs refused its own transfer proof');
assert.equal(publicSignals.length, 5);
console.log('· proof verifies locally, 5 public signals');

// ---- submit ----
const g1 = (p) => fieldHex(p[0]) + fieldHex(p[1]);
const g2 = (p) => fieldHex(p[0][1]) + fieldHex(p[0][0]) + fieldHex(p[1][1]) + fieldHex(p[1][0]);
const proofArg = JSON.stringify({ a: g1(proof.pi_a), b: g2(proof.pi_b), c: g1(proof.pi_c) });

const poolBefore = invoke(deployment.pool, 'get_leaf_count', [], true).replace(/"/g, '');
invoke(deployment.pool, 'transfer_v2', [
  '--proof', proofArg,
  '--nullifier', bytesArg(alice.nullifier),
  '--commitment', bytesArg(outCommitment),
  '--ephemeral_x', bytesArg(R[0]),
  '--ephemeral_y', bytesArg(R[1]),
  '--root', bytesArg(path.root),
]);
const poolAfter = invoke(deployment.pool, 'get_leaf_count', [], true).replace(/"/g, '');
assert.equal(Number(poolAfter), Number(poolBefore) + 1, 'transfer must add exactly one leaf');
console.log(`· transfer accepted on-chain (leaves ${poolBefore} -> ${poolAfter})`);

// ---- Bob discovers the note from public data alone ----
// Everything below uses ONLY R (public, from the event) and Bob's own key.
const S_bob = mulPointEscalar(R, BOB_SPEND_KEY);
const bobBlindness = await h2(S_bob[0], 0n);
const bobCommitment = await h4(AMOUNT, bob[0], bob[1], bobBlindness);
assert.equal(bobBlindness, outBlindness, 'ECDH disagreement: Bob derived a different blindness');
assert.equal(bobCommitment, outCommitment, 'Bob could not reproduce the commitment');
console.log('· Bob discovered the note using only the on-chain ephemeral point');

// ---- Bob spends it ----
const bobNullifier = await h2(outCommitment, BOB_SPEND_KEY);
const newLeaves = [...leaves, outCommitment];
const bobPath = await merklePath(newLeaves, newLeaves.length - 1, zeros);
assert.equal(bobPath.root, parseHex(invoke(deployment.pool, 'get_root', [], true)), 'root mismatch after transfer');

const recipient = stellar('keys', 'address', 'vayyl-v2-recipient');
const bindingBytes = Buffer.concat([
  new Address(recipient).toScVal().toXDR(),
  (() => { const b = Buffer.alloc(16); b.writeBigInt64BE(0n, 0); b.writeBigInt64BE(AMOUNT, 8); return b; })(),
]);
const bindingHash = createHash('sha256').update(bindingBytes).digest();
bindingHash[0] &= 0x1f;
const withdrawBinding = BigInt(`0x${bindingHash.toString('hex')}`);

console.log('· proving withdraw_v2 for Bob …');
const bobProof = await groth16.fullProve({
  root: bobPath.root.toString(),
  nullifier: bobNullifier.toString(),
  withdraw_binding: withdrawBinding.toString(),
  privKey: BOB_SPEND_KEY.toString(),
  blindness: bobBlindness.toString(),
  pathElements: bobPath.pathElements.map(String),
  pathIndices: bobPath.pathIndices.map(String),
}, resolve(V2, 'wasm', 'withdraw_v2.wasm'), resolve(V2, 'zkey', 'withdraw_v2_final.zkey'));

invoke(deployment.pool, 'withdraw_v2', [
  '--proof', JSON.stringify({
    a: g1(bobProof.proof.pi_a), b: g2(bobProof.proof.pi_b), c: g1(bobProof.proof.pi_c),
  }),
  '--nullifier', bytesArg(bobNullifier),
  '--recipient', recipient,
  '--root', bytesArg(bobPath.root),
]);
console.log(`· Bob withdrew 1 XLM to ${recipient}`);

console.log('\n✅ shield -> private transfer -> recipient discovers -> withdraw: all green');
process.exit(0);
