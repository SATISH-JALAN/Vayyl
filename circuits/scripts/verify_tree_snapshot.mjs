#!/usr/bin/env node
// ============================================================
// Independently verify the Merkle-tree snapshot against public history
// ============================================================
// `build_tree_snapshot.mjs` writes the snapshot from the indexer's database.
// This script re-derives it from sources the project does not control, so the
// file is believable to someone who does not trust our infrastructure — which
// includes us, six months from now, after a database has been lost.
//
// Two independent proofs, neither of which touches the indexer:
//
//   PER LEAF — Horizon keeps transaction envelopes permanently, long after
//   Soroban RPC has dropped the corresponding events. The commitment is a call
//   ARGUMENT to deposit_v2/transfer_v2, not merely an event field, so each leaf
//   can be re-read from the signed envelope of a transaction that is still
//   publicly fetchable by hash. We check the transaction succeeded, invoked this
//   pool, called a leaf-inserting function, and carried this exact commitment.
//
//   WHOLE TREE — the root recomputed over the ordered leaves must equal the
//   pool's own get_root(). The root commits to the entire list in order, so a
//   snapshot with any leaf missing, added, altered, or reordered cannot match.
//
// The per-leaf check proves each leaf is real; the root check proves the set and
// the ORDER are right. Together they pin the snapshot exactly.
//
// Note the one thing this deliberately does NOT claim: it cannot prove the
// snapshot is COMPLETE by reading Horizon alone, because Horizon cannot
// enumerate transactions by contract. Completeness comes from the root match
// against the live pool, which is why that check is fatal rather than advisory.
//
// Usage:  node scripts/verify_tree_snapshot.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { xdr, Address } from '@stellar/stellar-sdk';

const require = createRequire(import.meta.url);
const CIRCUITS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(CIRCUITS, '..');
const BUILD = resolve(CIRCUITS, 'build');

const DEPTH = 20;
const SOURCE = process.env.STELLAR_SOURCE || 'deployer';
const HORIZON = (process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org').replace(/\/$/, '');

// Functions that append a leaf, and where the commitment sits in their argument
// list. Anything not listed here cannot legitimately have produced a leaf.
//   deposit_v2(depositor, proof, commitment, asp_root)
//   transfer_v2(proof, nullifier, commitment, ephemeral_x, ephemeral_y, root)
//   deposit_v3(depositor, proof, commitment, asp_root, amount)
//   transfer_v3(proof, root, nf1, nf2, commitment1, commitment2, eph…)  <- TWO leaves
const LEAF_FUNCTIONS = {
  deposit_v2: { commitmentArgs: [2], source: 'deposit' },
  transfer_v2: { commitmentArgs: [2], source: 'transfer' },
  deposit_v3: { commitmentArgs: [2], source: 'deposit' },
  // Both outputs of a V3 transfer are leaves: the recipient's note and the
  // sender's change. Either may be the one being verified.
  transfer_v3: { commitmentArgs: [4, 5], source: 'transfer' },
};

const snapshot = JSON.parse(
  readFileSync(resolve(REPO, 'deployments', 'testnet-vault-v2-tree.json'), 'utf8')
);

// ---- chain + hashing helpers ----------------------------------------------

function view(id, fn) {
  return execFileSync('stellar', [
    'contract', 'invoke', '--id', id, '--network', 'testnet',
    '--source', SOURCE, '--send', 'no', '--', fn,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const unquote = (v) => v.replace(/^"|"$/g, '');
const hex64 = (n) => n.toString(16).padStart(64, '0');

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

/** Every invocation of `pool` inside a transaction envelope. */
function poolInvocations(envelopeXdr, pool) {
  const env = xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64');
  const tx = env.switch().name === 'envelopeTypeTxFeeBump'
    ? env.feeBump().tx().innerTx().v1().tx()
    : env.v1().tx();
  const out = [];
  for (const op of tx.operations()) {
    if (op.body().switch().name !== 'invokeHostFunction') continue;
    const hf = op.body().invokeHostFunctionOp().hostFunction();
    if (hf.switch().name !== 'hostFunctionTypeInvokeContract') continue;
    const inv = hf.invokeContract();
    if (Address.fromScAddress(inv.contractAddress()).toString() !== pool) continue;
    out.push({ fn: inv.functionName().toString(), args: inv.args() });
  }
  return out;
}
const argHex = (v) => (v?.switch().name === 'scvBytes' ? Buffer.from(v.bytes()).toString('hex') : null);

// ---- run -------------------------------------------------------------------

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  FAIL  ${msg}`); };

console.log(`snapshot  ${snapshot.leaf_count} leaves, generated ${snapshot.generated_at}`);
console.log(`pool      ${snapshot.pool}`);
console.log(`horizon   ${HORIZON}\n`);

console.log('Per-leaf verification against Horizon (permanent history):');
for (const leaf of snapshot.leaves) {
  const label = `leaf ${String(leaf.index).padStart(3)}  ${leaf.commitment.slice(0, 12)}…`;
  let tx;
  try {
    const res = await fetch(`${HORIZON}/transactions/${leaf.tx_hash}`);
    if (!res.ok) { fail(`${label}  tx ${leaf.tx_hash.slice(0, 12)}… not found on Horizon (${res.status})`); continue; }
    tx = await res.json();
  } catch (err) {
    fail(`${label}  Horizon unreachable: ${err.message}`);
    continue;
  }

  if (tx.successful !== true) { fail(`${label}  transaction did not succeed`); continue; }
  if (Number(tx.ledger) !== Number(leaf.ledger)) {
    fail(`${label}  ledger mismatch: snapshot says ${leaf.ledger}, Horizon says ${tx.ledger}`);
    continue;
  }

  const calls = poolInvocations(tx.envelope_xdr, snapshot.pool);
  if (calls.length === 0) { fail(`${label}  transaction does not invoke this pool`); continue; }

  const match = calls.find((c) => {
    const spec = LEAF_FUNCTIONS[c.fn];
    return spec && spec.commitmentArgs.some((i) => argHex(c.args[i]) === leaf.commitment);
  });
  if (!match) {
    fail(`${label}  no ${Object.keys(LEAF_FUNCTIONS).join('/')} call carrying this commitment ` +
         `(found: ${calls.map((c) => c.fn).join(', ')})`);
    continue;
  }
  if (LEAF_FUNCTIONS[match.fn].source !== leaf.source) {
    fail(`${label}  snapshot labels this '${leaf.source}' but the call was ${match.fn}`);
    continue;
  }
  console.log(`  ok    ${label}  ${match.fn} @ ledger ${leaf.ledger}`);
}

console.log('\nWhole-tree verification against the live pool:');
const rebuilt = await computeRoot(snapshot.leaves.map((l) => BigInt(`0x${l.commitment}`)));
if (hex64(rebuilt) !== snapshot.root) {
  fail(`snapshot records root ${snapshot.root} but its own leaves hash to ${hex64(rebuilt)}`);
} else {
  console.log(`  ok    recomputed root matches the value recorded in the snapshot`);
}

const onchainCount = Number(unquote(view(snapshot.pool, 'get_leaf_count')));
if (onchainCount !== snapshot.leaf_count) {
  fail(`pool holds ${onchainCount} leaves, snapshot has ${snapshot.leaf_count} — snapshot is stale, rebuild it`);
} else {
  console.log(`  ok    leaf count matches chain (${onchainCount})`);
}

const onchainRoot = BigInt(`0x${unquote(view(snapshot.pool, 'get_root')).replace(/^0x/, '')}`);
if (rebuilt !== onchainRoot) {
  fail(`recomputed root 0x${hex64(rebuilt)} != on-chain root 0x${hex64(onchainRoot)}`);
} else {
  console.log(`  ok    recomputed root matches the pool's get_root()`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed. The snapshot is NOT trustworthy.`);
  process.exit(1);
}
console.log('\nSnapshot verified: every leaf traces to a successful on-chain transaction,');
console.log('and the ordered set reproduces the pool\'s current root. Wallets can rely on it.');
