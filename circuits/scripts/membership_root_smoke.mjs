#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Address, BASE_FEE, Contract, Networks, TransactionBuilder, rpc } from '@stellar/stellar-sdk';

const API = process.env.VAYYL_RELAYER_URL ?? 'https://vault-v2-relayer-production.up.railway.app';
const RPC = process.env.VAYYL_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const MEMBERSHIP = process.env.VAYYL_ASP_MEMBERSHIP ?? 'CCGQLQS5JZQWXG72FFPLM3PKPBPBAP636C7YSVTJY5VYA5UXGLR4Q4WZ';
const VIEW_SOURCE = 'GA7QKKGRKCKTLZ67ZMXI7U6VEG5LPFLNEFPDKAN5Z6WSDHOBJHAXMWEC';
const depth = 20;
const require = createRequire(import.meta.url);
const build = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build');

const make = require(resolve(build, 'hash2_js', 'witness_calculator.js'));
const hashCalculator = await make(readFileSync(resolve(build, 'hash2_js', 'hash2.wasm')));
async function hash2(left, right) {
  const witness = await hashCalculator.calculateWitness({ in: [String(left), String(right)] }, true);
  return BigInt(witness[1]);
}

const response = await fetch(`${API}/v2/asp/leaves`);
const body = await response.json();
assert.equal(response.ok, true, body.error);
assert.ok(Array.isArray(body.leaves) && body.leaves.length >= 7);

const zeros = [0n];
for (let level = 1; level <= depth; level++) zeros.push(await hash2(zeros[level - 1], zeros[level - 1]));
let nodes = body.leaves.map(BigInt);
for (let level = 0; level < depth; level++) {
  const nodeAt = (index) => index < nodes.length ? nodes[index] : zeros[level];
  const parents = [];
  for (let index = 0; index < Math.ceil(nodes.length / 2); index++) {
    parents.push(await hash2(nodeAt(index * 2), nodeAt(index * 2 + 1)));
  }
  nodes = parents;
}
const reconstructedRoot = nodes[0];

const server = new rpc.Server(RPC);
const source = await server.getAccount(VIEW_SOURCE);
const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
  .addOperation(new Contract(MEMBERSHIP).call('root'))
  .setTimeout(30)
  .build();
const simulation = await server.simulateTransaction(tx);
assert.equal(rpc.Api.isSimulationError(simulation), false);
assert.ok(simulation.result);
const chainRoot = BigInt(`0x${Buffer.from(simulation.result.retval.bytes()).toString('hex')}`);
assert.equal(reconstructedRoot, chainRoot);

console.log(JSON.stringify({ membershipLeaves: body.leaves.length, reconstructedRoot: 'verified' }));
