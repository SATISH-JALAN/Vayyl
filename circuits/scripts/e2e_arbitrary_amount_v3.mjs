#!/usr/bin/env node
// ============================================================
// Arbitrary-amount private payment, end to end on testnet
// ============================================================
// The acceptance test for arbitrary-amount payments, run against the live
// contracts with real Groth16 proofs:
//
//   1. shield 100 XLM                       (deposit_v3)
//   2. privately pay 37 XLM to a recipient  (transfer_v3, 2-in / 2-out)
//   3. the recipient spends their 37        (withdraw_v3)
//   4. the sender spends their 63 change    (withdraw_v3)
//
// Step 2 is the one that could not be expressed at all before: TransferV2
// hard-coded both amounts to 10,000,000 stroops, so the only payment the system
// could make was exactly 1 XLM. Steps 3 and 4 matter because a payment that
// cannot be spent onward is not a payment; the change note in particular is the
// part a naive implementation loses.
//
// The amounts in step 2 never touch the ledger. Only the deposit and the two
// withdrawals move tokens, and those are public by nature.
//
// Usage:  node scripts/e2e_arbitrary_amount_v3.mjs

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { Address } from '@stellar/stellar-sdk';
import { groth16 } from 'snarkjs';

const require = createRequire(import.meta.url);
const CIRCUITS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(CIRCUITS, '..');
const BUILD = resolve(CIRCUITS, 'build');
const V3 = resolve(BUILD, 'v3');
const deployment = JSON.parse(readFileSync(resolve(REPO, 'deployments', 'testnet-vault-v2.json'), 'utf8'));
const snapshot = JSON.parse(readFileSync(resolve(REPO, 'deployments', 'testnet-vault-v2-tree.json'), 'utf8'));

const DEPTH = 20;
const XLM = 10_000_000n;                 // stroops per XLM
const SHIELD = 100n * XLM;
const PAY = 37n * XLM;
const CHANGE = SHIELD - PAY;             // 63 XLM
const SOURCE = process.env.STELLAR_SOURCE || 'deployer';
const HORIZON = 'https://horizon-testnet.stellar.org';
const SUBORDER =
  2736030358979909402780800718157159386076813972158567259200215660948447373041n;
const P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
// Domain tags. Blindness and the amount pad come from the SAME ECDH secret, so
// they must be separated or the pad would equal the blindness and leak it.
const TAG_BLINDNESS = 0n;
const TAG_AMOUNT = 1n;

const txs = [];

// ---- chain helpers ---------------------------------------------------------

// spawnSync rather than execFileSync so BOTH streams are readable on success.
// The CLI prints its result to stdout but the transaction hash only to stderr,
// as an explorer link, and this script's whole output is a list of hashes.
function stellarRaw(...args) {
  const r = spawnSync('stellar', args, { encoding: 'utf8' });
  const stdout = (r.stdout ?? '').trim();
  const stderr = (r.stderr ?? '').trim();
  const submitted = stderr.includes('Transaction submitted successfully!');
  // The CLI can panic while FORMATTING the result of a call that already
  // committed; a submitted transaction is a success regardless of exit code.
  if (r.status !== 0 && !submitted) {
    throw new Error(`stellar ${args.slice(0, 3).join(' ')} failed:\n${stderr.slice(0, 600)}`);
  }
  const m = /tx\/([a-f0-9]{64})/.exec(stderr);
  return { stdout, hash: m ? m[1] : null };
}
const stellar = (...args) => stellarRaw(...args).stdout;

function invoke(id, fn, args = [], view = false) {
  const cmd = ['contract', 'invoke', '--id', id, '--network', 'testnet', '--source', SOURCE];
  if (view) cmd.push('--send', 'no');
  return stellarRaw(...cmd, '--', fn, ...args).stdout;
}
/** Invoke, record the resulting transaction hash, and refuse to continue without one. */
function submit(label, id, fn, args) {
  const { hash } = stellarRaw(
    'contract', 'invoke', '--id', id, '--network', 'testnet', '--source', SOURCE, '--', fn, ...args);
  assert.ok(hash, `${label}: no transaction hash returned; evidence would be unverifiable`);
  txs.push({ step: label, hash, explorer: `https://stellar.expert/explorer/testnet/tx/${hash}` });
  console.log(`  ${label}: ${hash}`);
  return hash;
}
const fieldHex = (v) => BigInt(v).toString(16).padStart(64, '0');
const bytesArg = (v) => JSON.stringify({ bytes: fieldHex(v) });
const parseHex = (v) => BigInt(`0x${v.replace(/^"|"$/g, '').replace(/^0x/, '')}`);

async function nativeBalance(account) {
  const res = await fetch(`${HORIZON}/accounts/${account}`);
  if (!res.ok) throw new Error(`Horizon ${res.status}`);
  const b = await res.json();
  return BigInt(b.balances.find((x) => x.asset_type === 'native').balance.replace('.', ''));
}

// ---- circuit-backed crypto -------------------------------------------------

const wcCache = new Map();
async function calc(name, dir, input) {
  if (!wcCache.has(name)) {
    const builder = require(resolve(dir, `${name}_js`, 'witness_calculator.js'));
    wcCache.set(name, builder(readFileSync(resolve(dir, `${name}_js`, `${name}.wasm`))));
  }
  return (await wcCache.get(name)).calculateWitness(input, false);
}
const h2 = async (a, b) => BigInt((await calc('hash2', BUILD, { in: [a.toString(), b.toString()] }))[1]);
const h4 = async (a, b, c, d) => BigInt((await calc('hash4', BUILD, { in: [a, b, c, d].map(String) }))[1]);
/** Note(): [1]=pubX [2]=pubY [3]=commitment [4]=nullifier */
async function note(privKey, amount, blindness) {
  const w = await calc('test_note', BUILD, {
    privKey: privKey.toString(), amount: amount.toString(), blindness: blindness.toString(),
  });
  return { pubX: BigInt(w[1]), pubY: BigInt(w[2]), commitment: BigInt(w[3]), nullifier: BigInt(w[4]) };
}
const randScalar = () => (BigInt(`0x${randomBytes(32).toString('hex')}`) % (SUBORDER - 1n)) + 1n;

async function zeroLadder() {
  const z = [0n];
  for (let l = 1; l <= DEPTH; l++) z[l] = await h2(z[l - 1], z[l - 1]);
  return z;
}
async function merklePath(leaves, index, zeros) {
  const pathElements = [], pathIndices = [];
  let level = [...leaves], idx = index;
  for (let l = 0; l < DEPTH; l++) {
    pathElements.push(idx % 2 === 0 ? (level[idx + 1] ?? zeros[l]) : level[idx - 1]);
    pathIndices.push(idx % 2);
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(await h2(level[i], level[i + 1] ?? zeros[l]));
    level = next;
    idx >>= 1;
  }
  return { root: level[0] ?? zeros[DEPTH], pathElements, pathIndices };
}

/** The pool's binding: sha256(recipient_xdr ‖ amount_be128), top 3 bits cleared. */
function withdrawBinding(recipient, amount) {
  const amt = Buffer.alloc(16);
  amt.writeBigInt64BE(0n, 0);
  amt.writeBigInt64BE(amount, 8);
  const d = createHash('sha256')
    .update(Buffer.concat([new Address(recipient).toScVal().toXDR(), amt]))
    .digest();
  d[0] &= 0x1f;
  return BigInt(`0x${d.toString('hex')}`);
}

const g1 = (p) => fieldHex(p[0]) + fieldHex(p[1]);
const g2 = (p) => fieldHex(p[0][1]) + fieldHex(p[0][0]) + fieldHex(p[1][1]) + fieldHex(p[1][0]);
const proofArg = (p) => JSON.stringify({ a: g1(p.pi_a), b: g2(p.pi_b), c: g1(p.pi_c) });

async function prove(name, input) {
  const { proof, publicSignals } = await groth16.fullProve(
    input, resolve(V3, `${name}_js`, `${name}.wasm`), resolve(V3, 'zkey', `${name}_final.zkey`));
  const vkey = JSON.parse(readFileSync(resolve(V3, 'vkey', `${name}_vkey.json`), 'utf8'));
  assert.ok(await groth16.verify(vkey, publicSignals, proof), `snarkjs refused its own ${name} proof`);
  return { proof, publicSignals };
}

// ---- run -------------------------------------------------------------------

console.log(`pool     ${deployment.pool}`);
console.log(`verifier ${deployment.verifier}\n`);

const zeros = await zeroLadder();

// Current leaf set, from the committed snapshot. Verified against chain before
// anything is spent: a wrong leaf list yields a root the pool never saw.
let leaves = snapshot.leaves.map((l) => BigInt(`0x${l.commitment}`));
const onchainRoot = parseHex(invoke(deployment.pool, 'get_root', [], true));
assert.equal((await merklePath(leaves, 0, zeros)).root, onchainRoot,
  'snapshot leaves do not reproduce the on-chain root; rebuild it first');
console.log(`· snapshot of ${leaves.length} leaves matches the on-chain root`);

// ---- 1. shield 100 XLM ----
const SENDER_SK = randScalar();
const senderId = await note(SENDER_SK, 0n, 0n);   // key material only
const aspLeaf = await h2(senderId.pubX, senderId.pubY);

// The sender must be in the approval set to deposit. We hold the ASP admin key.
const aspMirror = JSON.parse(readFileSync(resolve(REPO, 'backend', 'relayer', 'asp-leaves.json'), 'utf8'));
const aspLeaves = aspMirror.map((r) => BigInt(r.leaf));
// Fail fast and legibly on a stale mirror. Checking only after the insert would
// leave a leaf on chain that the local list does not know about, making the
// mirror MORE wrong than it started.
{
  const before = await merklePath(aspLeaves, 0, zeros);
  const chainRoot = parseHex(invoke(deployment.asp_membership, 'root', [], true));
  assert.equal(before.root, chainRoot,
    `the ASP mirror is stale (${aspLeaves.length} leaves locally). ` +
    `Rebuild it from chain first: node scripts/recover_asp_leaves.mjs --write`);
}
submit('asp insert_leaf', deployment.asp_membership, 'insert_leaf', ['--leaf', bytesArg(aspLeaf)]);
aspLeaves.push(aspLeaf);
const aspIndex = aspLeaves.length - 1;
const aspPath = await merklePath(aspLeaves, aspIndex, zeros);
const aspRootOnChain = parseHex(invoke(deployment.asp_membership, 'root', [], true));
assert.equal(aspPath.root, aspRootOnChain, 'rebuilt ASP root does not match chain');
console.log(`· enrolled in the approval set at index ${aspIndex}`);

const inBlind = randScalar();
const inNote = await note(SENDER_SK, SHIELD, inBlind);
console.log('· proving deposit_v3 (100 XLM) …');
const dep = await prove('deposit_v3', {
  commitment: inNote.commitment.toString(),
  asp_root: aspPath.root.toString(),
  amount: SHIELD.toString(),
  privKey: SENDER_SK.toString(),
  blindness: inBlind.toString(),
  asp_pathElements: aspPath.pathElements.map(String),
  asp_pathIndices: aspPath.pathIndices.map(String),
});
const depositor = stellar('keys', 'address', SOURCE);
submit('deposit_v3 (100 XLM)', deployment.pool, 'deposit_v3', [
  '--depositor', depositor,
  '--proof', proofArg(dep.proof),
  '--commitment', bytesArg(inNote.commitment),
  '--asp_root', bytesArg(aspPath.root),
  '--amount', SHIELD.toString(),
]);
leaves.push(inNote.commitment);
const inIndex = leaves.length - 1;
assert.equal(Number(invoke(deployment.pool, 'get_leaf_count', [], true).replace(/"/g, '')), leaves.length);
console.log(`· shielded ${SHIELD / XLM} XLM at leaf ${inIndex}`);

// ---- 2. privately pay 37 XLM ----
// One note in, so input 2 is a dummy: amount 0, membership waived, fresh
// blindness so its nullifier cannot collide with anything.
const RECIPIENT_SK = randScalar();
const recipient = await note(RECIPIENT_SK, 0n, 0n);
const dummyBlind = randScalar();
const dummy = await note(SENDER_SK, 0n, dummyBlind);

// A one-time point per output. The change note gets one too, so a wallet
// restored on a clean device rediscovers it exactly like a receipt.
const r1 = randScalar(), r2 = randScalar();
const R1 = await note(r1, 0n, 0n), R2 = await note(r2, 0n, 0n);
// blindness = Poseidon2(S.x, 0) where S = r·PK. Computed the same way the
// recipient will when scanning.
const S1 = await note((r1 * RECIPIENT_SK) % SUBORDER, 0n, 0n);
const S2 = await note((r2 * SENDER_SK) % SUBORDER, 0n, 0n);
const outBlind1 = await h2(S1.pubX, TAG_BLINDNESS);
const outBlind2 = await h2(S2.pubX, TAG_BLINDNESS);
// One-time pad in the scalar field. Without this the owner cannot recompute
// their commitment, because they do not know the amount.
const amountCt1 = (PAY + await h2(S1.pubX, TAG_AMOUNT)) % P;
const amountCt2 = (CHANGE + await h2(S2.pubX, TAG_AMOUNT)) % P;
const outCommit1 = await h4(PAY, recipient.pubX, recipient.pubY, outBlind1);
const outCommit2 = await h4(CHANGE, senderId.pubX, senderId.pubY, outBlind2);

const path1 = await merklePath(leaves, inIndex, zeros);
console.log('· proving transfer_v3 (2-in / 2-out, 37 + 63) …');
const tr = await prove('transfer_v3', {
  root: path1.root.toString(),
  nullifier1: inNote.nullifier.toString(),
  nullifier2: dummy.nullifier.toString(),
  commitment_out1: outCommit1.toString(),
  commitment_out2: outCommit2.toString(),
  eph1_x: R1.pubX.toString(), eph1_y: R1.pubY.toString(),
  eph2_x: R2.pubX.toString(), eph2_y: R2.pubY.toString(),
  amount_ct1: amountCt1.toString(), amount_ct2: amountCt2.toString(),
  privKey: SENDER_SK.toString(),
  in_amount1: SHIELD.toString(),
  in_blindness1: inBlind.toString(),
  in_pathElements1: path1.pathElements.map(String),
  in_pathIndices1: path1.pathIndices.map(String),
  in_amount2: '0',
  in_blindness2: dummyBlind.toString(),
  in_pathElements2: path1.pathElements.map(String),
  in_pathIndices2: path1.pathIndices.map(String),
  isDummy2: '1',
  out_amount1: PAY.toString(),
  out_pubX1: recipient.pubX.toString(), out_pubY1: recipient.pubY.toString(),
  out_blindness1: outBlind1.toString(),
  out_amount2: CHANGE.toString(),
  out_pubX2: senderId.pubX.toString(), out_pubY2: senderId.pubY.toString(),
  out_blindness2: outBlind2.toString(),
});
assert.equal(tr.publicSignals.length, 11);

const poolBalanceBefore = parseHex('0');
submit('transfer_v3 (37 XLM private)', deployment.pool, 'transfer_v3', [
  '--proof', proofArg(tr.proof),
  '--root', bytesArg(path1.root),
  '--nullifier1', bytesArg(inNote.nullifier),
  '--nullifier2', bytesArg(dummy.nullifier),
  '--commitment1', bytesArg(outCommit1),
  '--commitment2', bytesArg(outCommit2),
  '--eph1_x', bytesArg(R1.pubX), '--eph1_y', bytesArg(R1.pubY),
  '--eph2_x', bytesArg(R2.pubX), '--eph2_y', bytesArg(R2.pubY),
  '--amount_ct1', bytesArg(amountCt1), '--amount_ct2', bytesArg(amountCt2),
]);
leaves.push(outCommit1, outCommit2);
const payIndex = leaves.length - 2, changeIndex = leaves.length - 1;
console.log(`· paid ${PAY / XLM} XLM privately; change ${CHANGE / XLM} XLM at leaf ${changeIndex}`);
void poolBalanceBefore;

// The recipient rediscovers the note from public data alone: R1 from the event
// and their own spend key. If this drifts, payments silently vanish.
const S1r = await note((RECIPIENT_SK * r1) % SUBORDER, 0n, 0n);
const recoveredBlind = await h2(S1r.pubX, TAG_BLINDNESS);
assert.equal(recoveredBlind, outBlind1, 'ECDH disagreement: recipient derived a different blindness');
// The amount too, which is the part that fixed denominations never needed. A
// recipient who cannot recover it cannot rebuild the commitment, and a note
// they cannot rebuild is a note they can never spend.
const recoveredAmount = (amountCt1 - await h2(S1r.pubX, TAG_AMOUNT) + P) % P;
assert.equal(recoveredAmount, PAY, 'recipient recovered the wrong amount');
const rebuilt = await h4(recoveredAmount, recipient.pubX, recipient.pubY, recoveredBlind);
assert.equal(rebuilt, outCommit1, 'recipient could not rebuild the commitment from recovered values');
console.log(`· recipient recovered amount ${recoveredAmount / XLM} XLM and rebuilt the commitment,`);
console.log('  using only the ephemeral point, the ciphertext, and their own key');

// Same for the sender's change, which is what makes clean-device recovery work.
const S2s = await note((SENDER_SK * r2) % SUBORDER, 0n, 0n);
const recoveredChange = (amountCt2 - await h2(S2s.pubX, TAG_AMOUNT) + P) % P;
assert.equal(recoveredChange, CHANGE, 'sender could not recover their own change amount');
console.log(`· sender recovered their ${recoveredChange / XLM} XLM change the same way`);

// ---- 3. recipient spends the 37 ----
const payee = stellar('keys', 'address', 'vayyl-v2-recipient');
const payeeBefore = await nativeBalance(payee);
const path2 = await merklePath(leaves, payIndex, zeros);
const recvNullifier = await h2(outCommit1, RECIPIENT_SK);
console.log('· proving withdraw_v3 for the recipient (37 XLM) …');
const w1 = await prove('withdraw_v3', {
  root: path2.root.toString(),
  nullifier: recvNullifier.toString(),
  amount: PAY.toString(),
  withdraw_binding: withdrawBinding(payee, PAY).toString(),
  privKey: RECIPIENT_SK.toString(),
  blindness: outBlind1.toString(),
  pathElements: path2.pathElements.map(String),
  pathIndices: path2.pathIndices.map(String),
});
submit('withdraw_v3 recipient (37 XLM)', deployment.pool, 'withdraw_v3', [
  '--proof', proofArg(w1.proof),
  '--nullifier', bytesArg(recvNullifier),
  '--recipient', payee,
  '--root', bytesArg(path2.root),
  '--amount', PAY.toString(),
]);
assert.equal(await nativeBalance(payee) - payeeBefore, PAY, 'recipient did not receive 37 XLM');
console.log(`· recipient withdrew ${PAY / XLM} XLM`);

// ---- 4. sender spends the change ----
const changeDest = stellar('keys', 'address', 'vayyl-v2-a');
const changeBefore = await nativeBalance(changeDest);
const path3 = await merklePath(leaves, changeIndex, zeros);
const changeNullifier = await h2(outCommit2, SENDER_SK);
console.log('· proving withdraw_v3 for the change (63 XLM) …');
const w2 = await prove('withdraw_v3', {
  root: path3.root.toString(),
  nullifier: changeNullifier.toString(),
  amount: CHANGE.toString(),
  withdraw_binding: withdrawBinding(changeDest, CHANGE).toString(),
  privKey: SENDER_SK.toString(),
  blindness: outBlind2.toString(),
  pathElements: path3.pathElements.map(String),
  pathIndices: path3.pathIndices.map(String),
});
submit('withdraw_v3 change (63 XLM)', deployment.pool, 'withdraw_v3', [
  '--proof', proofArg(w2.proof),
  '--nullifier', bytesArg(changeNullifier),
  '--recipient', changeDest,
  '--root', bytesArg(path3.root),
  '--amount', CHANGE.toString(),
]);
assert.equal(await nativeBalance(changeDest) - changeBefore, CHANGE, 'sender did not receive 63 XLM change');
console.log(`· sender withdrew the ${CHANGE / XLM} XLM change`);

// ---- evidence ----
const evidence = {
  $comment:
    'Arbitrary-amount private payment, proven on Stellar testnet. Shield 100 XLM, ' +
    'privately pay 37, recipient spends the 37, sender spends the 63 change. ' +
    'The 37/63 split never appears on the ledger: only the deposit and the two ' +
    'withdrawals move tokens.',
  network: 'testnet',
  pool: deployment.pool,
  verifier: deployment.verifier,
  ran_at: new Date().toISOString(),
  amounts_xlm: { shielded: 100, paid_privately: 37, change: 63 },
  transactions: txs,
};
const out = resolve(REPO, 'deployments', 'testnet-v3-arbitrary-amount-evidence.json');
writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);

console.log(`\nWrote ${out}`);
console.log('\nArbitrary-amount private payment verified end to end on testnet.');
console.log('Shield 100 -> pay 37 privately -> recipient spends 37 -> sender spends 63 change.');
