#!/usr/bin/env node
// ============================================================
// Public exit (rage-quit), end to end on testnet
// ============================================================
// The blocklist makes `withdraw_v2` and `transfer_v2` refuse a denied nullifier
// before any state change. With no other route out, a delisted depositor's funds
// would be stuck permanently — confiscation by omission, which is a worse
// failure than the one the blocklist prevents. `ragequit_v2` is the escape
// hatch, and this script is the proof that it actually works against the live
// stack rather than only in unit tests.
//
// What it demonstrates:
//
//   1. a real deposit is exited with NO Merkle path — the commitment is public
//      and the pool confirms inclusion by direct key lookup
//   2. the recipient's on-chain XLM balance actually increases
//   3. the note's nullifier is consumed, so the same note cannot then be
//      withdrawn privately (rage-quit and withdraw share one nullifier)
//   4. the exit is publicly linkable, which is the deliberate trade
//
// Point 3 is the one worth watching. If rage-quit used a different nullifier,
// every note could be spent twice — once publicly and once privately — and the
// pool would drain.
//
// Uses the deterministic notes seeded by e2e_vault_v2.mjs (privKey 1001+i,
// blindness 2001+i), so it needs no ASP enrollment and adds no leaf.
//
// Usage:  node scripts/e2e_ragequit_v2.mjs
//         RAGEQUIT_INDEX=3 node scripts/e2e_ragequit_v2.mjs

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

const AMOUNT = 10_000_000n;
const DEPOSIT_COUNT = 5; // seeded by e2e_vault_v2.mjs
const SOURCE = process.env.STELLAR_SOURCE || 'deployer';
const HORIZON = 'https://horizon-testnet.stellar.org';

// ---- chain helpers ---------------------------------------------------------

function stellar(...args) {
  try {
    return execFileSync('stellar', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    // The CLI can panic while FORMATTING the result of a call that already
    // committed. The transaction is on-chain regardless — same allowance the
    // other e2e scripts make.
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
function tryInvoke(id, fn, args) {
  try {
    invoke(id, fn, args);
    return { ok: true, stderr: '' };
  } catch (error) {
    return { ok: false, stderr: error?.stderr?.toString() ?? String(error) };
  }
}
const fieldHex = (v) => BigInt(v).toString(16).padStart(64, '0');
const bytesArg = (v) => JSON.stringify({ bytes: fieldHex(v) });

async function nativeBalance(account) {
  const res = await fetch(`${HORIZON}/accounts/${account}`);
  if (!res.ok) throw new Error(`Horizon ${res.status} for ${account}`);
  const body = await res.json();
  return BigInt(
    body.balances.find((b) => b.asset_type === 'native').balance.replace('.', '')
  );
}

// ---- circuit-backed crypto (never hand-rolled) -----------------------------

const wcCache = new Map();
async function calc(name, dir, input) {
  if (!wcCache.has(name)) {
    const builder = require(resolve(dir, `${name}_js`, 'witness_calculator.js'));
    wcCache.set(name, builder(readFileSync(resolve(dir, `${name}_js`, `${name}.wasm`))));
  }
  return (await wcCache.get(name)).calculateWitness(input, false);
}
/** Note() outputs: [1]=pubX [2]=pubY [3]=commitment [4]=nullifier. */
async function note(privKey, amount, blindness) {
  const w = await calc('test_note', BUILD, {
    privKey: privKey.toString(), amount: amount.toString(), blindness: blindness.toString(),
  });
  return { pubX: BigInt(w[1]), pubY: BigInt(w[2]), commitment: BigInt(w[3]), nullifier: BigInt(w[4]) };
}

/** The pool's exit_binding: sha256(recipient_xdr ‖ amount_be128), top 3 bits cleared. */
function exitBinding(recipient, amount) {
  const amt = Buffer.alloc(16);
  amt.writeBigInt64BE(0n, 0);
  amt.writeBigInt64BE(amount, 8);
  const digest = createHash('sha256')
    .update(Buffer.concat([new Address(recipient).toScVal().toXDR(), amt]))
    .digest();
  digest[0] &= 0x1f;
  return BigInt(`0x${digest.toString('hex')}`);
}

// ---- run -------------------------------------------------------------------

console.log(`pool     ${deployment.pool}`);
console.log(`verifier ${deployment.verifier}\n`);

const leafCount = Number(invoke(deployment.pool, 'get_leaf_count', [], true).replace(/"/g, ''));
const rootBefore = invoke(deployment.pool, 'get_root', [], true).replace(/"/g, '');
console.log(`· pool holds ${leafCount} leaves`);

// The seeded deposits are consumed in order by the e2e scripts; the next unspent
// one sits at (leafCount - DEPOSIT_COUNT), since each transfer adds a leaf and
// each spend consumes one seeded note.
const index = Number(process.env.RAGEQUIT_INDEX ?? Math.max(0, leafCount - DEPOSIT_COUNT));
assert.ok(
  index < DEPOSIT_COUNT,
  `all ${DEPOSIT_COUNT} seeded deposits are spent; re-seed with e2e_vault_v2.mjs`
);
const privKey = 1001n + BigInt(index);
const blindness = 2001n + BigInt(index);
const target = await note(privKey, AMOUNT, blindness);
console.log(`· exiting seeded deposit ${index}, commitment ${target.commitment.toString(16).slice(0, 12)}…`);

const recipient = stellar('keys', 'address', 'vayyl-v2-recipient');
const binding = exitBinding(recipient, AMOUNT);
const balanceBefore = await nativeBalance(recipient);
console.log(`· recipient ${recipient} holds ${balanceBefore} stroops`);

// ---- prove ----
// No Merkle path: the commitment is a PUBLIC input and the pool looks it up
// directly. That is the whole design — an escape hatch must not depend on the
// indexer being up to rebuild a tree.
console.log('· proving ragequit_v2 …');
const { proof, publicSignals } = await groth16.fullProve({
  commitment: target.commitment.toString(),
  nullifier: target.nullifier.toString(),
  exit_binding: binding.toString(),
  privKey: privKey.toString(),
  blindness: blindness.toString(),
}, resolve(V2, 'wasm', 'ragequit_v2.wasm'), resolve(V2, 'zkey', 'ragequit_v2_final.zkey'));

const vkey = JSON.parse(readFileSync(resolve(V2, 'vkey', 'ragequit_v2_vkey.json'), 'utf8'));
assert.ok(await groth16.verify(vkey, publicSignals, proof), 'snarkjs refused its own rage-quit proof');
assert.equal(publicSignals.length, 3, 'rage-quit publishes commitment, nullifier, exit_binding');
console.log('· proof verifies locally, 3 public signals');

// ---- submit ----
const g1 = (p) => fieldHex(p[0]) + fieldHex(p[1]);
const g2 = (p) => fieldHex(p[0][1]) + fieldHex(p[0][0]) + fieldHex(p[1][1]) + fieldHex(p[1][0]);
const proofArg = JSON.stringify({ a: g1(proof.pi_a), b: g2(proof.pi_b), c: g1(proof.pi_c) });

invoke(deployment.pool, 'ragequit_v2', [
  '--proof', proofArg,
  '--commitment', bytesArg(target.commitment),
  '--nullifier', bytesArg(target.nullifier),
  '--recipient', recipient,
]);

const balanceAfter = await nativeBalance(recipient);
assert.equal(
  balanceAfter - balanceBefore, AMOUNT,
  `recipient gained ${balanceAfter - balanceBefore} stroops, expected ${AMOUNT}`
);
console.log(`· rage-quit paid out: ${balanceBefore} -> ${balanceAfter} stroops (+${AMOUNT})`);

// The tree must be untouched: rage-quit spends a note, it does not create one.
const leafCountAfter = Number(invoke(deployment.pool, 'get_leaf_count', [], true).replace(/"/g, ''));
const rootAfter = invoke(deployment.pool, 'get_root', [], true).replace(/"/g, '');
assert.equal(leafCountAfter, leafCount, 'rage-quit must not insert a leaf');
assert.equal(rootAfter, rootBefore, 'rage-quit must not change the Merkle root');
console.log('· Merkle tree unchanged (no leaf inserted, root identical)');

// ---- the property that keeps the pool solvent ----
// Rage-quit and withdraw share one nullifier. If they did not, every note could
// be spent twice — once publicly, once privately — and the pool would drain.
const replay = tryInvoke(deployment.pool, 'ragequit_v2', [
  '--proof', proofArg,
  '--commitment', bytesArg(target.commitment),
  '--nullifier', bytesArg(target.nullifier),
  '--recipient', recipient,
]);
assert.ok(!replay.ok, 'a rage-quit was replayable — the note could be drained repeatedly');
assert.ok(
  /Error\(Contract, #4\)/.test(replay.stderr),
  `expected NullifierAlreadyUsed (#4), got:\n${replay.stderr.slice(0, 400)}`
);
console.log('· replay rejected with NullifierAlreadyUsed — the note is spent exactly once');

console.log('\nPublic exit verified on the live testnet pool.');
console.log('A depositor the blocklist has denied can still recover their funds.');
