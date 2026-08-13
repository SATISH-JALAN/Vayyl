#!/usr/bin/env node
// ============================================================
// Indexer -> Merkle root -> chain consistency check
// ============================================================
// The browser wallet never reads leaves from the chain. It pulls the ordered
// commitment list from the indexer's /commitments feed, rebuilds the tree
// locally, and submits the resulting root inside a proof. So the indexer IS the
// tree as far as every user is concerned.
//
// That makes indexer drift uniquely nasty: a missing or misordered leaf yields
// a root the pool has never seen, and the only symptom is an opaque UnknownRoot
// at submit time — after the user has already waited out a ~10s proof. Worse,
// one missing EARLY leaf shifts every later leaf, so a single gap breaks
// spending for every note in the pool, not just the affected one.
//
// This script closes that loop directly: fetch what the indexer serves, rebuild
// the root exactly as the client does, and compare it to the pool's own
// get_root. Run it whenever the indexer is restarted, repointed at a different
// pool, or resumed after downtime.
//
// Usage:  node scripts/verify_indexer_root.mjs
//         INDEXER_URL=http://localhost:3001 node scripts/verify_indexer_root.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const CIRCUITS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(CIRCUITS, '..');
const BUILD = resolve(CIRCUITS, 'build');
const deployment = JSON.parse(
  readFileSync(resolve(REPO, 'deployments', 'testnet-vault-v2.json'), 'utf8')
);

const DEPTH = 20;
const SOURCE = process.env.STELLAR_SOURCE || 'deployer';
const INDEXER_URL = (process.env.INDEXER_URL || 'http://localhost:3001').replace(/\/$/, '');

// ---- chain helpers ---------------------------------------------------------

function stellar(...args) {
  try {
    return execFileSync('stellar', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString() ?? '';
    if (stderr.includes('Transaction submitted successfully!')) return '';
    throw error;
  }
}
function view(id, fn) {
  return stellar('contract', 'invoke', '--id', id, '--network', 'testnet',
    '--source', SOURCE, '--send', 'no', '--', fn);
}
const parseHex = (v) => BigInt(`0x${v.replace(/^"|"$/g, '').replace(/^0x/, '')}`);

// ---- circuit-backed Poseidon2 (never hand-rolled) --------------------------

const wcCache = new Map();
async function calc(name, input) {
  if (!wcCache.has(name)) {
    const builder = require(resolve(BUILD, `${name}_js`, 'witness_calculator.js'));
    wcCache.set(name, builder(readFileSync(resolve(BUILD, `${name}_js`, `${name}.wasm`))));
  }
  return (await wcCache.get(name)).calculateWitness(input, false);
}
const h2 = async (a, b) => BigInt((await calc('hash2', { in: [a.toString(), b.toString()] }))[1]);

async function zeroLadder() {
  const zeros = [0n];
  for (let l = 1; l <= DEPTH; l++) zeros[l] = await h2(zeros[l - 1], zeros[l - 1]);
  return zeros;
}

/** Same fold the client performs over the ordered leaf list. */
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

// ---- run -------------------------------------------------------------------

console.log(`indexer  ${INDEXER_URL}`);
console.log(`pool     ${deployment.pool}\n`);

// 1. Density. A gap here is the failure this script exists to catch, and it is
//    worth reporting on its own terms before any hashing happens.
const health = await (await fetch(`${INDEXER_URL}/health`)).json();
assert.equal(health.status, 'ok', `indexer unhealthy: ${JSON.stringify(health)}`);
assert.equal(
  health.pool, deployment.pool,
  `indexer is indexing ${health.pool}, but the deployment file says ${deployment.pool}`
);
assert.equal(
  health.commitmentsDense, true,
  `indexer leaf set has gaps (count=${health.count}, maxIndex=${health.maxIndex}). ` +
  `Every note in the pool is unspendable until this is backfilled.`
);
console.log(`. leaf set is dense (${health.count} leaves, maxIndex ${health.maxIndex})`);

// 2. The indexer's ordered feed must match the pool's own leaf count.
const { commitments } = await (await fetch(`${INDEXER_URL}/commitments`)).json();
const leafCount = Number(view(deployment.pool, 'get_leaf_count').replace(/"/g, ''));
assert.equal(
  commitments.length, leafCount,
  `indexer serves ${commitments.length} leaves but the pool reports ${leafCount}`
);
console.log(`. leaf count matches chain (${leafCount})`);

// 3. The root the client would submit must be one the pool recognises.
const zeros = await zeroLadder();
const leaves = commitments.map((c) => BigInt(`0x${c}`));
const rebuilt = await computeRoot(leaves, zeros);
const onchain = parseHex(view(deployment.pool, 'get_root'));

assert.equal(
  rebuilt, onchain,
  `rebuilt root does not match on-chain root:\n` +
  `  rebuilt  0x${rebuilt.toString(16).padStart(64, '0')}\n` +
  `  on-chain 0x${onchain.toString(16).padStart(64, '0')}`
);
console.log(`. rebuilt root matches on-chain root (0x${rebuilt.toString(16).padStart(64, '0')})`);

console.log('\nIndexer is consistent with the chain. Wallets can spend.');
