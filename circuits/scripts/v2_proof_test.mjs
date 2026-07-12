#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groth16 } from 'snarkjs';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = resolve(root, 'build');
const v2 = resolve(build, 'v2');
const depth = 20;

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
const noteWitness = await noteCalculator.calculateWitness({
  privKey: '444',
  amount: '10000000',
  blindness: '333',
}, true);
const note = (name) => BigInt(noteWitness[noteSignals.get(`main.${name}`)]);

const hashCalculator = await calculator('hash2');
async function hash2(left, right) {
  const witness = await hashCalculator.calculateWitness({ in: [left.toString(), right.toString()] }, true);
  return BigInt(witness[1]);
}

const zeros = [0n];
for (let level = 1; level <= depth; level++) {
  zeros.push(await hash2(zeros[level - 1], zeros[level - 1]));
}

const aspLeaf = await hash2(note('pubX'), note('pubY'));
let aspRoot = aspLeaf;
for (let level = 0; level < depth; level++) aspRoot = await hash2(aspRoot, zeros[level]);

const depositInput = {
  commitment: note('commitment').toString(),
  asp_root: aspRoot.toString(),
  privKey: '444',
  blindness: '333',
  asp_pathElements: zeros.slice(0, depth).map(String),
  asp_pathIndices: Array(depth).fill('0'),
};
console.log('Generating Vault V2 deposit proof...');
const deposit = await groth16.fullProve(
  depositInput,
  resolve(v2, 'wasm', 'deposit_v2.wasm'),
  resolve(v2, 'zkey', 'deposit_v2_final.zkey'),
);
const depositVkey = JSON.parse(readFileSync(resolve(v2, 'vkey', 'deposit_v2_vkey.json'), 'utf8'));
assert.equal(await groth16.verify(depositVkey, deposit.publicSignals, deposit.proof), true);
const badDepositSignals = [...deposit.publicSignals];
badDepositSignals[0] = (BigInt(badDepositSignals[0]) + 1n).toString();
assert.equal(await groth16.verify(depositVkey, badDepositSignals, deposit.proof), false);
console.log('Deposit proof and commitment-tamper check passed.');

let poolRoot = note('commitment');
for (let level = 0; level < depth; level++) poolRoot = await hash2(poolRoot, zeros[level]);
const withdrawInput = {
  root: poolRoot.toString(),
  nullifier: note('nullifier').toString(),
  withdraw_binding: '987654321',
  privKey: '444',
  blindness: '333',
  pathElements: zeros.slice(0, depth).map(String),
  pathIndices: Array(depth).fill('0'),
};
console.log('Generating Vault V2 withdrawal proof...');
const withdraw = await groth16.fullProve(
  withdrawInput,
  resolve(v2, 'wasm', 'withdraw_v2.wasm'),
  resolve(v2, 'zkey', 'withdraw_v2_final.zkey'),
);
const withdrawVkey = JSON.parse(readFileSync(resolve(v2, 'vkey', 'withdraw_v2_vkey.json'), 'utf8'));
assert.equal(await groth16.verify(withdrawVkey, withdraw.publicSignals, withdraw.proof), true);
const badWithdrawSignals = [...withdraw.publicSignals];
badWithdrawSignals[2] = (BigInt(badWithdrawSignals[2]) + 1n).toString();
assert.equal(await groth16.verify(withdrawVkey, badWithdrawSignals, withdraw.proof), false);

console.log('Vault V2 Groth16 proofs verified; altered commitment and recipient binding were rejected.');
process.exit(0);
