#!/usr/bin/env node
// ============================================================
// Rebuild the ASP leaf mirror from public chain history
// ============================================================
// The membership contract can look a leaf up (`get_leaf_index`, `is_member`)
// but cannot ENUMERATE, which led to the standing belief that a lost mirror is
// unrecoverable and that its loss permanently breaks deposits for the affected
// users. That belief is wrong, and this script is the counter-example.
//
// `insert_leaf(leaf)` takes the leaf as a call ARGUMENT, and Horizon keeps
// transaction envelopes forever. So the full ordered leaf set can be replayed
// from public history long after any local file is gone, exactly as the
// commitment tree can (see verify_tree_snapshot.mjs). Ordering comes from ledger
// sequence, which is the same order the contract inserted them in.
//
// The rebuilt set is not trusted on its word: its Merkle root must equal the
// contract's own `root()` before anything is written. A wrong mirror is worse
// than a missing one, because clients build ASP paths from it and a single
// misplaced leaf makes EVERY deposit fail an ASP-root check with an error that
// never mentions enrollment.
//
// Usage:  node scripts/recover_asp_leaves.mjs           (verify only)
//         node scripts/recover_asp_leaves.mjs --write   (rewrite the mirror)

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { xdr, Address } from '@stellar/stellar-sdk';

const require = createRequire(import.meta.url);
const CIRCUITS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(CIRCUITS, '..');
const BUILD = resolve(CIRCUITS, 'build');
const deployment = JSON.parse(readFileSync(resolve(REPO, 'deployments', 'testnet-vault-v2.json'), 'utf8'));

const DEPTH = 20;
const ASP = deployment.asp_membership;
const ADMIN = deployment.source_account;
const HORIZON = (process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org').replace(/\/$/, '');
const MIRROR = resolve(REPO, 'backend', 'relayer', 'asp-leaves.json');
const WRITE = process.argv.includes('--write');

// ---- helpers ---------------------------------------------------------------

function view(id, fn) {
  const r = spawnSync('stellar', [
    'contract', 'invoke', '--id', id, '--network', 'testnet',
    '--source', process.env.STELLAR_SOURCE || 'deployer', '--send', 'no', '--', fn,
  ], { encoding: 'utf8' });
  return (r.stdout ?? '').trim().replace(/^"|"$/g, '');
}

let hash2Calc = null;
async function h2(a, b) {
  if (!hash2Calc) {
    const builder = require(resolve(BUILD, 'hash2_js', 'witness_calculator.js'));
    hash2Calc = await builder(readFileSync(resolve(BUILD, 'hash2_js', 'hash2.wasm')));
  }
  const w = await hash2Calc.calculateWitness({ in: [a.toString(), b.toString()] }, false);
  return BigInt(w[1]);
}
async function computeRoot(leaves) {
  const zeros = [0n];
  for (let l = 1; l <= DEPTH; l++) zeros[l] = await h2(zeros[l - 1], zeros[l - 1]);
  if (leaves.length === 0) return zeros[DEPTH];
  let level = [...leaves];
  for (let l = 0; l < DEPTH; l++) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(await h2(level[i], level[i + 1] ?? zeros[l]));
    level = next;
  }
  return level[0];
}

/** Every successful insert_leaf against the membership contract, oldest first. */
async function replayInserts() {
  const found = [];
  let url = `${HORIZON}/accounts/${ADMIN}/transactions?limit=200&order=desc`;
  for (let page = 0; page < 20 && url; page++) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Horizon ${res.status}`);
    const body = await res.json();
    const records = body._embedded?.records ?? [];
    if (records.length === 0) break;
    for (const tx of records) {
      if (!tx.successful) continue;
      let env;
      try { env = xdr.TransactionEnvelope.fromXDR(tx.envelope_xdr, 'base64'); } catch { continue; }
      const inner = env.switch().name === 'envelopeTypeTxFeeBump'
        ? env.feeBump().tx().innerTx().v1().tx()
        : env.v1().tx();
      for (const op of inner.operations()) {
        if (op.body().switch().name !== 'invokeHostFunction') continue;
        const hf = op.body().invokeHostFunctionOp().hostFunction();
        if (hf.switch().name !== 'hostFunctionTypeInvokeContract') continue;
        const inv = hf.invokeContract();
        if (Address.fromScAddress(inv.contractAddress()).toString() !== ASP) continue;
        if (inv.functionName().toString() !== 'insert_leaf') continue;
        const arg = inv.args()[0];
        if (arg?.switch().name !== 'scvBytes') continue;
        found.push({
          ledger: Number(tx.ledger),
          txHash: tx.hash,
          leaf: BigInt(`0x${Buffer.from(arg.bytes()).toString('hex')}`).toString(),
        });
      }
    }
    url = body._links?.next?.href ?? null;
  }
  // Ledger order is insertion order, which is the order the contract assigned
  // indices in. Deduplicate: the contract ignores a repeat, so must we.
  found.sort((a, b) => a.ledger - b.ledger);
  const seen = new Set();
  return found.filter((f) => (seen.has(f.leaf) ? false : (seen.add(f.leaf), true)));
}

// ---- run -------------------------------------------------------------------

console.log(`membership ${ASP}`);
console.log(`horizon    ${HORIZON}\n`);

const replayed = await replayInserts();
console.log(`· replayed ${replayed.length} insert_leaf call(s) from permanent history`);

const onchainCount = Number(view(ASP, 'leaf_count'));
assert.equal(
  replayed.length, onchainCount,
  `replayed ${replayed.length} leaves but the contract reports ${onchainCount}. ` +
  `Some inserts came from an account other than ${ADMIN}; widen the scan before trusting this.`,
);
console.log(`· leaf count matches chain (${onchainCount})`);

const rebuiltRoot = await computeRoot(replayed.map((r) => BigInt(r.leaf)));
const onchainRoot = BigInt(`0x${view(ASP, 'root').replace(/^0x/, '')}`);
assert.equal(
  rebuiltRoot, onchainRoot,
  `rebuilt ASP root does not match the contract:\n` +
  `    rebuilt  0x${rebuiltRoot.toString(16).padStart(64, '0')}\n` +
  `    on-chain 0x${onchainRoot.toString(16).padStart(64, '0')}`,
);
console.log(`· rebuilt root matches the contract's root()`);

if (!WRITE) {
  console.log('\nMirror is reconstructible. Re-run with --write to rewrite it.');
  process.exit(0);
}

const rows = replayed.map((r, index) => ({ index, leaf: r.leaf, txHash: r.txHash }));
writeFileSync(MIRROR, `${JSON.stringify(rows, null, 2)}\n`);
console.log(`\nWrote ${MIRROR} (${rows.length} leaves, each traced to its insert transaction)`);
