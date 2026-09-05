// ============================================================
// Relayer fee-drain guards (D3, D4)
// ============================================================
// The relayer PAYS the fee for everything it submits, so every path that
// reaches `sendTransaction` is spending its balance. These two tests pin the
// guards on the paths that let a stranger spend it.
//
// Both assertions are that the call throws BEFORE any network I/O. The stub
// server below therefore throws on contact: if a test ever reaches it, the
// guard it covers has regressed.

import assert from 'node:assert/strict';
import test from 'node:test';
import * as StellarSdk from '@stellar/stellar-sdk';

import { RelayerService } from './relay.js';

const PASSPHRASE = StellarSdk.Networks.TESTNET;
const RELAYER = StellarSdk.Keypair.random();
const USER = StellarSdk.Keypair.random();
// A syntactically valid contract id that is NOT on the allowlist.
const ALLOWED = 'CB6XFHGN4DMVEQRESJHPOUNYLUCGMOZTAIKTWH3I7KT3NVW2XY4NIOLC';

function service(allowed: string[] = [ALLOWED]) {
    return new RelayerService('https://invalid.invalid', RELAYER.secret(), PASSPHRASE, allowed);
}

/** A source account object that needs no network round trip. */
function account() {
    return new StellarSdk.Account(USER.publicKey(), '1');
}

function build(op: StellarSdk.xdr.Operation): string {
    return new StellarSdk.TransactionBuilder(account(), {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: PASSPHRASE,
    })
        .addOperation(op)
        .setTimeout(60)
        .build()
        .toXDR();
}

test('D3: an uploadContractWasm envelope is refused, not fee-bumped', async () => {
    // The exact shape that used to slip through. `validateTransaction` checked
    // the allowlist only INSIDE an `if invokeContract` with no `else`, so a WASM
    // upload was validated by falling past the check — and the relayer paid to
    // upload arbitrary code.
    const upload = StellarSdk.Operation.uploadContractWasm({ wasm: Buffer.from([0x00, 0x61, 0x73, 0x6d]) });

    await assert.rejects(
        () => service().relayTransaction(build(upload)),
        (err: Error) => {
            assert.match(err.message, /Only contract invocations may be relayed/);
            assert.match(err.message, /hostFunctionTypeUploadContractWasm/);
            return true;
        },
        'a WASM upload must be refused before the relayer pays for it',
    );
});

test('D3: an invocation of a non-allowlisted contract is still refused', async () => {
    // The guard must not have traded one hole for another: invoke-contract is
    // the permitted type, but the allowlist still has to apply to it.
    const other = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    const call = new StellarSdk.Contract(other).call('withdraw_v3');

    await assert.rejects(
        () => service().relayTransaction(build(call)),
        (err: Error) => {
            assert.doesNotMatch(
                err.message,
                /Only contract invocations may be relayed/,
                'should be rejected by the allowlist, not by the type check',
            );
            return /Failed to relay transaction/.test(err.message);
        },
    );
});

test('D3: a multi-operation envelope is refused', async () => {
    const call = new StellarSdk.Contract(ALLOWED).call('withdraw_v3');
    const tx = new StellarSdk.TransactionBuilder(account(), {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: PASSPHRASE,
    })
        .addOperation(call)
        .addOperation(call)
        .setTimeout(60)
        .build()
        .toXDR();

    await assert.rejects(() => service().relayTransaction(tx), /exactly one operation/);
});

test('D4: a transaction that cannot be simulated is refused, not paid for', async () => {
    // The allowlisted contract passes validation, so this reaches `fetchBaseFee`.
    // The RPC URL is unreachable, which is precisely the "simulation failed"
    // branch that used to return a flat 0.5 XLM and submit anyway.
    const call = new StellarSdk.Contract(ALLOWED).call('withdraw_v3');

    await assert.rejects(
        () => service().relayTransaction(build(call)),
        (err: Error) => {
            assert.match(err.message, /Refusing to relay: simulation failed/);
            return true;
        },
        'a transaction that will not simulate must never be submitted',
    );
});

test('D4: the 0.5 XLM fallback fee is gone from the source', async () => {
    // Belt and braces: the failure mode was a magic number, and a magic number
    // is easy to reintroduce while "restoring" behaviour during a merge.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./relay.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(
        src,
        /return\s+5000000\s*;/,
        'the fixed 0.5 XLM simulation-failure fallback must not come back',
    );
});
