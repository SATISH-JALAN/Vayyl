#!/usr/bin/env node
// ============================================================
// Build the durable Merkle-tree snapshot
// ============================================================
// Soroban RPC retains contract events for roughly 7 days. This pool's deposits
// are already older than that: a getEvents call from the pool's first ledger now
// returns "startLedger must be within the ledger range: ...". The event stream
// that every leaf was originally read from no longer exists.
//
// That leaves the indexer's Postgres as the sole copy of the leaf ORDERING, and
// leaf ordering is not a convenience — a client builds its Merkle path from the
// ordered list, so losing it (or getting one index wrong) makes every note in
// the pool unspendable, not just the missing one. A single free-tier database
// standing between users and their funds is not an acceptable design.
//
// This script freezes that ordering into a file that is committed to the repo
// and shipped with the frontend, so the wallet keeps working when the indexer
// is down, restarted, or repointed.
//
// The snapshot is not trusted on its word. Two independent checks run before
// anything is written, and either failure aborts:
//
//   1. leaf count must equal the pool's own get_leaf_count()
//   2. the root recomputed from the ordered leaves must equal get_root()
//
// (2) is the load-bearing one. The root is a hash over the whole leaf list in
// order, so a snapshot with a missing, extra, altered, or reordered leaf cannot
// match the chain. A snapshot that passes is correct by construction.
//
// Provenance (tx hash + ledger per leaf) is carried through so the result stays
// auditable against Horizon's permanent history: see verify_tree_snapshot.mjs.
//
// Usage:  node scripts/build_tree_snapshot.mjs
//         INDEXER_URL=https://indexer.example node scripts/build_tree_snapshot.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const CIRCUITS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(CIRCUITS, '..');
const BUILD = resolve(CIRCUITS, 'build');

const DEPTH = 20;
const SOURCE = process.env.STELLAR_SOURCE || 'deployer';
const INDEXER_URL = (process.env.INDEXER_URL || 'http://localhost:3001').replace(/\/$/, '');

const deployment = JSON.parse(
  readFileSync(resolve(REPO, 'deployments', 'testnet-vault-v2.json'), 'utf8')
);
const OUT_DEPLOYMENTS = resolve(REPO, 'deployments', 'testnet-vault-v2-tree.json');
const OUT_FRONTEND = resolve(REPO, 'frontend', 'public', 'tree-snapshot.json');

// ---- chain helpers ---------------------------------------------------------

function stellar(...args) {
  return execFileSync('stellar', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function view(id, fn) {
  return stellar('contract', 'invoke', '--id', id, '--network', 'testnet',
    '--source', SOURCE, '--send', 'no', '--', fn);
}
const unquote = (v) => v.replace(/^"|"$/g, '');
const parseHex = (v) => BigInt(`0x${unquote(v).replace(/^0x/, '')}`);
const hex64 = (n) => n.toString(16).padStart(64, '0');

// ---- circuit-backed Poseidon2 ---------------------------------------------
// The same hash2 circuit the pool and the wallet agree on. Hand-rolling
// Poseidon2 here would let a parameter drift produce a snapshot that verifies
// against itself and against nothing else.

let hash2Calc = null;
async function h2(a, b) {
  if (!hash2Calc) {
    const builder = require(resolve(BUILD, 'hash2_js', 'witness_calculator.js'));
    hash2Calc = await builder(readFileSync(resolve(BUILD, 'hash2_js', 'hash2.wasm')));
  }
  const w = await hash2Calc.calculateWitness({ in: [a.toString(), b.toString()] }, false);
  return BigInt(w[1]);
}

async function zeroLadder() {
  const zeros = [0n];
  for (let l = 1; l <= DEPTH; l++) zeros[l] = await h2(zeros[l - 1], zeros[l - 1]);
  return zeros;
}

/** The exact fold the wallet performs over the ordered leaf list. */
async function computeRoot(leaves, zeros) {
  if (leaves.length === 0) return zeros[DEPTH];
  let level = [...leaves];
  for (let l = 0; l < DEPTH; l++) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(await h2(level[i], level[i + 1] ?? zeros[l]));
    }
    level = next;
  }
  return level[0];
}

function die(msg) {
  console.error(`\nABORTED: ${msg}`);
  console.error('No snapshot was written. A wrong snapshot is worse than none.');
  process.exit(1);
}

// ---- run -------------------------------------------------------------------

console.log(`indexer  ${INDEXER_URL}`);
console.log(`pool     ${deployment.pool}\n`);

let payload;
try {
  const res = await fetch(`${INDEXER_URL}/snapshot`);
  if (!res.ok) die(`indexer /snapshot returned ${res.status}: ${await res.text()}`);
  payload = await res.json();
} catch (err) {
  die(`could not reach the indexer at ${INDEXER_URL} (${err.message}).\n` +
      `  Start it with: cd backend/indexer && pnpm dev`);
}

if (payload.pool !== deployment.pool) {
  die(`indexer is serving pool ${payload.pool}, but the deployment file says ${deployment.pool}`);
}

const leaves = payload.leaves ?? [];
// Density is re-checked here rather than trusted from the API: this is the last
// point before the ordering is frozen into a committed file.
leaves.forEach((leaf, i) => {
  if (leaf.index !== i) die(`leaf list is not dense: position ${i} carries leaf_index ${leaf.index}`);
  if (!/^[0-9a-f]{64}$/.test(leaf.commitment)) die(`leaf ${i} has a malformed commitment: ${leaf.commitment}`);
  if (!/^[0-9a-f]{64}$/.test(leaf.txHash ?? '')) die(`leaf ${i} has no usable tx hash; it could never be re-verified`);
});
console.log(`. ${leaves.length} leaves, dense, all with provenance`);

const onchainCount = Number(unquote(view(deployment.pool, 'get_leaf_count')));
if (leaves.length !== onchainCount) {
  die(`indexer has ${leaves.length} leaves but the pool reports ${onchainCount}.\n` +
      `  The indexer is behind or has lost rows; do not freeze this state.`);
}
console.log(`. leaf count matches chain (${onchainCount})`);

const zeros = await zeroLadder();
const rebuilt = await computeRoot(leaves.map((l) => BigInt(`0x${l.commitment}`)), zeros);
const onchainRoot = parseHex(view(deployment.pool, 'get_root'));
if (rebuilt !== onchainRoot) {
  die(`recomputed root does not match the chain:\n` +
      `    rebuilt  0x${hex64(rebuilt)}\n` +
      `    on-chain 0x${hex64(onchainRoot)}`);
}
console.log(`. recomputed root matches chain (0x${hex64(rebuilt)})`);

const snapshot = {
  $comment:
    'Durable copy of the pool leaf ordering. Soroban RPC only retains events ~7 days; ' +
    'this file is what lets a wallet rebuild Merkle paths after that window closes. ' +
    'Verify with: node circuits/scripts/verify_tree_snapshot.mjs',
  network: 'testnet',
  pool: deployment.pool,
  tree_depth: DEPTH,
  generated_at: new Date().toISOString(),
  leaf_count: leaves.length,
  root: hex64(rebuilt),
  root_verified_against_chain: true,
  leaves: leaves.map((l) => ({
    index: l.index,
    commitment: l.commitment,
    source: l.source,
    tx_hash: l.txHash,
    ledger: l.ledger,
    ...(l.ephemeralX ? { ephemeral_x: l.ephemeralX, ephemeral_y: l.ephemeralY } : {}),
    ...(l.amountCipher ? { amount_cipher: l.amountCipher } : {}),
  })),
  spent_nullifiers: (payload.nullifiers ?? []).slice().sort(),
};

const json = `${JSON.stringify(snapshot, null, 2)}\n`;
writeFileSync(OUT_DEPLOYMENTS, json);
mkdirSync(dirname(OUT_FRONTEND), { recursive: true });
writeFileSync(OUT_FRONTEND, json);

console.log(`\nWrote ${OUT_DEPLOYMENTS}`);
console.log(`Wrote ${OUT_FRONTEND}`);
console.log('\nCommit both. The wallet falls back to this file when the indexer is unreachable.');
