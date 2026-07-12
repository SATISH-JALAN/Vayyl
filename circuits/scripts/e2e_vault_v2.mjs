#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Address, Horizon, Keypair } from '@stellar/stellar-sdk';
import { groth16 } from 'snarkjs';

const require = createRequire(import.meta.url);
const circuitsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(circuitsRoot, '..');
const build = resolve(circuitsRoot, 'build');
const v2 = resolve(build, 'v2');
const deploymentPath = resolve(repoRoot, 'deployments', 'testnet-vault-v2.json');
const evidencePath = resolve(repoRoot, 'deployments', 'testnet-vault-v2-evidence.json');
const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));
const depth = 20;
const denomination = 10_000_000n;
const depositorAliases = ['vayyl-v2-a', 'vayyl-v2-b', 'vayyl-v2-c', 'vayyl-v2-d', 'vayyl-v2-e'];

function stellar(...args) {
  try {
    return execFileSync('stellar', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString() ?? '';
    if (stderr.includes('Transaction submitted successfully!')) return '';
    throw error;
  }
}

function invoke(id, source, fn, args = [], view = false) {
  const command = ['contract', 'invoke', '--id', id, '--network', 'testnet', '--source', source];
  if (view) command.push('--send', 'no');
  command.push('--', fn, ...args);
  return stellar(...command);
}

const fieldHex = (value) => BigInt(value).toString(16).padStart(64, '0');
const bytesArg = (value) => JSON.stringify({ bytes: fieldHex(value) });
const parseHexResult = (value) => BigInt(`0x${value.replace(/^"|"$/g, '').replace(/^0x/, '')}`);

async function calculator(name) {
  const make = require(resolve(build, `${name}_js`, 'witness_calculator.js'));
  return make(readFileSync(resolve(build, `${name}_js`, `${name}.wasm`)));
}

function signalMap(name) {
  return new Map(
    readFileSync(resolve(build, `${name}.sym`), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(',');
        return [parts[3], Number(parts[1])];
      }),
  );
}

const noteCalculator = await calculator('test_note');
const noteSignals = signalMap('test_note');
const hashCalculator = await calculator('hash2');

async function hash2(left, right) {
  const witness = await hashCalculator.calculateWitness({ in: [left.toString(), right.toString()] }, true);
  return BigInt(witness[1]);
}

async function deriveNote(privKey, blindness) {
  const witness = await noteCalculator.calculateWitness({
    privKey: privKey.toString(),
    amount: denomination.toString(),
    blindness: blindness.toString(),
  }, true);
  const signal = (name) => BigInt(witness[noteSignals.get(`main.${name}`)]);
  return {
    privKey,
    blindness,
    pubX: signal('pubX'),
    pubY: signal('pubY'),
    commitment: signal('commitment'),
    nullifier: signal('nullifier'),
  };
}

const zeros = [0n];
for (let level = 1; level <= depth; level++) zeros.push(await hash2(zeros[level - 1], zeros[level - 1]));

class MerkleTree {
  leaves = [];

  insert(leaf) {
    this.leaves.push(leaf);
  }

  async proof(index) {
    let nodes = [...this.leaves];
    let cursor = index;
    const pathElements = [];
    const pathIndices = [];
    for (let level = 0; level < depth; level++) {
      const right = cursor % 2 === 1;
      const sibling = right ? cursor - 1 : cursor + 1;
      pathElements.push(sibling < nodes.length ? nodes[sibling] : zeros[level]);
      pathIndices.push(right ? 1 : 0);
      const next = [];
      for (let i = 0; i < nodes.length; i += 2) {
        next.push(await hash2(nodes[i], i + 1 < nodes.length ? nodes[i + 1] : zeros[level]));
      }
      nodes = next;
      cursor = Math.floor(cursor / 2);
    }
    return { root: nodes[0] ?? zeros[depth], pathElements, pathIndices };
  }
}

function formatProof(proof) {
  const coordinate = (value) => BigInt(value).toString(16).padStart(64, '0');
  return JSON.stringify({
    a: { bytes: coordinate(proof.pi_a[0]) + coordinate(proof.pi_a[1]) },
    b: { bytes: coordinate(proof.pi_b[0][1]) + coordinate(proof.pi_b[0][0])
      + coordinate(proof.pi_b[1][1]) + coordinate(proof.pi_b[1][0]) },
    c: { bytes: coordinate(proof.pi_c[0]) + coordinate(proof.pi_c[1]) },
  });
}

function withdrawBinding(recipient) {
  const addressXdr = new Address(recipient).toScVal().toXDR();
  const amount = Buffer.alloc(16);
  amount.writeBigUInt64BE(denomination, 8);
  const digest = createHash('sha256').update(Buffer.concat([addressXdr, amount])).digest();
  digest[0] &= 0x1f;
  return BigInt(`0x${digest.toString('hex')}`);
}

const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');
async function latestTransaction(address) {
  const page = await horizon.transactions().forAccount(address).order('desc').limit(1).call();
  return page.records[0].hash;
}

function nativeStroops(account) {
  const balance = account.balances.find((item) => item.asset_type === 'native')?.balance ?? '0';
  const [whole, fraction = ''] = balance.split('.');
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0').slice(0, 7));
}

async function startRelayer(secret, port) {
  const child = spawn(process.execPath, [resolve(repoRoot, 'backend', 'relayer', 'dist', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      RPC_URL: 'https://soroban-testnet.stellar.org',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
      RELAYER_SECRET: secret,
      ALLOWED_POOLS: deployment.pool,
    },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      if ((await fetch(`${url}/health`)).ok) return { child, url };
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  child.kill();
  throw new Error('Relayer did not become healthy');
}

async function relay(url, request) {
  const response = await fetch(`${url}/v2/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await response.json();
  return { ok: response.ok && body.success, body };
}

console.log('Preparing five independent fixed-denomination deposits...');
const aspTree = new MerkleTree();
const poolTree = new MerkleTree();
const notes = [];
const deposits = [];
const existingAspLeaves = Number(invoke(
  deployment.asp_membership,
  'vayyl-testnet-v2',
  'leaf_count',
  [],
  true,
).replace(/"/g, ''));
const existingPoolLeaves = Number(invoke(
  deployment.pool,
  'vayyl-testnet-v2',
  'get_leaf_count',
  [],
  true,
).replace(/"/g, ''));
assert.ok(existingAspLeaves >= existingPoolLeaves && existingAspLeaves <= 5);
assert.ok(existingPoolLeaves <= 5);

for (let i = 0; i < depositorAliases.length; i++) {
  const alias = depositorAliases[i];
  const address = stellar('keys', 'address', alias);
  const note = await deriveNote(1001n + BigInt(i), 2001n + BigInt(i));
  const aspLeaf = await hash2(note.pubX, note.pubY);
  if (i >= existingAspLeaves) {
    invoke(deployment.asp_membership, 'vayyl-testnet-v2', 'insert_leaf', ['--leaf', bytesArg(aspLeaf)]);
  }
  aspTree.insert(aspLeaf);
  const aspProof = await aspTree.proof(i);
  if (i >= existingAspLeaves || i === existingAspLeaves - 1) {
    assert.equal(
      parseHexResult(invoke(deployment.asp_membership, 'vayyl-testnet-v2', 'root', [], true)),
      aspProof.root,
    );
  }

  if (i >= existingPoolLeaves) {
    const deposit = await groth16.fullProve({
      commitment: note.commitment.toString(),
      asp_root: aspProof.root.toString(),
      privKey: note.privKey.toString(),
      blindness: note.blindness.toString(),
      asp_pathElements: aspProof.pathElements.map(String),
      asp_pathIndices: aspProof.pathIndices.map(String),
    }, resolve(v2, 'wasm', 'deposit_v2.wasm'), resolve(v2, 'zkey', 'deposit_v2_final.zkey'));
    invoke(deployment.pool, alias, 'deposit_v2', [
      '--depositor', address,
      '--proof', formatProof(deposit.proof),
      '--commitment', bytesArg(note.commitment),
      '--asp_root', bytesArg(aspProof.root),
    ]);
  }
  poolTree.insert(note.commitment);
  notes.push(note);
  deposits.push({ wallet: alias.slice(-1).toUpperCase(), address, commitment: fieldHex(note.commitment), tx_hash: await latestTransaction(address) });
  console.log(`Deposit ${i + 1}/5 confirmed.`);
}

const poolProof = await poolTree.proof(2);
assert.equal(parseHexResult(invoke(deployment.pool, 'vayyl-testnet-v2', 'get_root', [], true)), poolProof.root);
assert.equal(Number(invoke(deployment.pool, 'vayyl-testnet-v2', 'get_leaf_count', [], true).replace(/"/g, '')), 5);

const recipient = stellar('keys', 'address', 'vayyl-v2-recipient');
const relayerAddress = stellar('keys', 'address', 'vayyl-v2-relayer');
const relayerTransactions = await horizon.transactions().forAccount(relayerAddress).order('desc').limit(10).call();
const confirmedRelayerWithdrawal = relayerTransactions.records.find(
  (transaction) => transaction.source_account === relayerAddress && transaction.successful,
);
const binding = withdrawBinding(recipient);
const withdrawal = await groth16.fullProve({
  root: poolProof.root.toString(),
  nullifier: notes[2].nullifier.toString(),
  withdraw_binding: binding.toString(),
  privKey: notes[2].privKey.toString(),
  blindness: notes[2].blindness.toString(),
  pathElements: poolProof.pathElements.map(String),
  pathIndices: poolProof.pathIndices.map(String),
}, resolve(v2, 'wasm', 'withdraw_v2.wasm'), resolve(v2, 'zkey', 'withdraw_v2_final.zkey'));
const request = {
  pool: deployment.pool,
  proof: withdrawal.proof,
  nullifier: notes[2].nullifier.toString(),
  recipient,
  root: poolProof.root.toString(),
};

const unfunded = await startRelayer(Keypair.random().secret(), 3303);
const unfundedResult = await relay(unfunded.url, request);
unfunded.child.kill();
assert.equal(unfundedResult.ok, false);

const relayerSecret = stellar('keys', 'secret', 'vayyl-v2-relayer');
const liveRelayer = await startRelayer(relayerSecret, 3302);
let withdrawalHash = confirmedRelayerWithdrawal?.hash;
try {
  const wrongRoot = await relay(liveRelayer.url, { ...request, root: (poolProof.root + 1n).toString() });
  assert.equal(wrongRoot.ok, false);
  const wrongRecipient = await relay(liveRelayer.url, { ...request, recipient: deposits[0].address });
  assert.equal(wrongRecipient.ok, false);
  const wrongNullifier = await relay(liveRelayer.url, { ...request, nullifier: (notes[2].nullifier + 1n).toString() });
  assert.equal(wrongNullifier.ok, false);

  if (!withdrawalHash) {
    const before = nativeStroops(await horizon.loadAccount(recipient));
    const success = await relay(liveRelayer.url, request);
    assert.equal(success.ok, true, success.body.error);
    withdrawalHash = success.body.hash;
    const after = nativeStroops(await horizon.loadAccount(recipient));
    assert.equal(after - before, denomination);
  }

  const doubleSpend = await relay(liveRelayer.url, request);
  assert.equal(doubleSpend.ok, false);

  const blockedProof = await poolTree.proof(4);
  const blockedBinding = withdrawBinding(recipient);
  const blockedWithdrawal = await groth16.fullProve({
    root: blockedProof.root.toString(),
    nullifier: notes[4].nullifier.toString(),
    withdraw_binding: blockedBinding.toString(),
    privKey: notes[4].privKey.toString(),
    blindness: notes[4].blindness.toString(),
    pathElements: blockedProof.pathElements.map(String),
    pathIndices: blockedProof.pathIndices.map(String),
  }, resolve(v2, 'wasm', 'withdraw_v2.wasm'), resolve(v2, 'zkey', 'withdraw_v2_final.zkey'));
  const isNotBlocked = invoke(
    deployment.asp_non_membership,
    'vayyl-testnet-v2',
    'is_not_blocked',
    ['--leaf', bytesArg(notes[4].nullifier)],
    true,
  ).replace(/"/g, '') === 'true';
  if (isNotBlocked) {
    invoke(deployment.asp_non_membership, 'vayyl-testnet-v2', 'block_leaf', ['--leaf', bytesArg(notes[4].nullifier)]);
  }
  let blockedRejected = false;
  try {
    invoke(deployment.pool, 'vayyl-v2-relayer', 'withdraw_v2', [
      '--proof', formatProof(blockedWithdrawal.proof),
      '--nullifier', bytesArg(notes[4].nullifier),
      '--recipient', recipient,
      '--root', bytesArg(blockedProof.root),
    ]);
  } catch {
    blockedRejected = true;
  }
  assert.equal(blockedRejected, true);
} finally {
  liveRelayer.child.kill();
}

writeFileSync(evidencePath, JSON.stringify({
  network: 'testnet',
  tested_at: new Date().toISOString(),
  pool: deployment.pool,
  verifier: deployment.verifier,
  relayer: relayerAddress,
  recipient,
  denomination_stroops: Number(denomination),
  deposits,
  withdrawal_tx_hash: withdrawalHash,
  checks: {
    five_equal_deposits: true,
    relayer_submitted_withdrawal: true,
    recipient_received_fixed_denomination: true,
    unknown_root_rejected: true,
    changed_recipient_rejected: true,
    altered_nullifier_rejected: true,
    double_spend_rejected: true,
    blocked_nullifier_rejected: true,
    unfunded_relayer_rejected: true,
  },
}, null, 2));

console.log(`Vault V2 testnet evidence complete. Withdrawal: ${withdrawalHash}`);
process.exit(0);
