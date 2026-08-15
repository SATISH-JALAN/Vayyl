// Unit tests for the #[contractevent] decoder (Task 6.1).
// Builds synthetic ScVal events matching what VayylPool emits and asserts the
// decoder extracts commitments/nullifiers/amounts correctly — no live network.

import { describe, it, expect } from 'vitest';
import { xdr, nativeToScVal, Address } from '@stellar/stellar-sdk';
import { decodePoolEvent } from './decode.js';

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const bytesN = (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex, 'hex'));
const mapEntry = (k: string, v: xdr.ScVal) =>
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });

describe('decodePoolEvent', () => {
  it('decodes a deposit event', () => {
    const commitment = 'ab'.repeat(32);
    const topic = [sym('deposit'), bytesN(commitment)];
    const value = xdr.ScVal.scvMap([
      mapEntry('leaf_index', nativeToScVal(7, { type: 'u32' })),
      mapEntry('amount', nativeToScVal(1000n, { type: 'i128' })),
    ]);

    const decoded = decodePoolEvent(topic, value);
    expect(decoded).toEqual({
      kind: 'deposit',
      commitment,
      leafIndex: 7,
      amount: 1000n,
    });
  });

  it('decodes a transfer_v2 event, including the leaf index and ephemeral point', () => {
    const nullifier = '11'.repeat(32);
    const commitment = '22'.repeat(32);
    const ephemeralX = '33'.repeat(32);
    const ephemeralY = '44'.repeat(32);
    const topic = [sym('transfer_v2'), bytesN(nullifier)];
    const value = xdr.ScVal.scvMap([
      mapEntry('commitment', bytesN(commitment)),
      mapEntry('ephemeral_x', bytesN(ephemeralX)),
      mapEntry('ephemeral_y', bytesN(ephemeralY)),
      mapEntry('leaf_index', nativeToScVal(3, { type: 'u32' })),
      mapEntry('amount', nativeToScVal(10_000_000n, { type: 'i128' })),
    ]);

    // The leaf index is the whole reason this event exists in this shape: it is
    // what lets the output commitment be ordered in the tree. Losing it is what
    // corrupted every client's Merkle path under the old V1 transfer handling.
    expect(decodePoolEvent(topic, value)).toEqual({
      kind: 'transferV2',
      nullifier,
      commitment,
      leafIndex: 3,
      ephemeralX,
      ephemeralY,
      amount: 10_000_000n,
    });
  });

  it('decodes a withdraw event', () => {
    const nullifier = 'cd'.repeat(32);
    const recipient = 'GDLONDLUL5YRUMK4PEQIFFU4EHCAOEOK4BDKWZOKP3GSEPOPONZGKXHB';
    const topic = [sym('withdraw'), bytesN(nullifier)];
    const value = xdr.ScVal.scvMap([
      mapEntry('recipient', new Address(recipient).toScVal()),
      mapEntry('amount', nativeToScVal(500n, { type: 'i128' })),
    ]);

    const decoded = decodePoolEvent(topic, value);
    expect(decoded?.kind).toBe('withdraw');
    if (decoded?.kind === 'withdraw') {
      expect(decoded.nullifier).toBe(nullifier);
      expect(decoded.amount).toBe(500n);
      expect(decoded.recipient).toBe(recipient);
    }
  });

  it('decodes a transfer event', () => {
    const n1 = '11'.repeat(32);
    const n2 = '22'.repeat(32);
    const c1 = '33'.repeat(32);
    const c2 = '44'.repeat(32);
    const topic = [sym('transfer'), bytesN(n1), bytesN(n2)];
    const value = xdr.ScVal.scvMap([
      mapEntry('commitment1', bytesN(c1)),
      mapEntry('commitment2', bytesN(c2)),
    ]);

    const decoded = decodePoolEvent(topic, value);
    expect(decoded).toEqual({
      kind: 'transfer',
      nullifier1: n1,
      nullifier2: n2,
      commitment1: c1,
      commitment2: c2,
    });
  });

  it('decodes a rage-quit event', () => {
    // If this ever stops decoding, a publicly-exited note keeps looking
    // spendable in every wallet, because wallets learn about spends from the
    // nullifier feed. Each attempt then fails on-chain with a bare
    // NullifierAlreadyUsed and nothing explains why.
    const nullifier = '55'.repeat(32);
    const commitment = '66'.repeat(32);
    const recipient = 'GCL7FQ6NIJBMZNBUMI6Z6CLAMZZIRM4U6XHSYEXPQRARLZAMXUUI5CFC';
    const topic = [sym('ragequit_v2'), bytesN(nullifier)];
    const value = xdr.ScVal.scvMap([
      mapEntry('commitment', bytesN(commitment)),
      mapEntry('recipient', xdr.ScVal.scvAddress(Address.fromString(recipient).toScAddress())),
      mapEntry('amount', xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString('10000000') }))),
    ]);

    const decoded = decodePoolEvent(topic, value);
    expect(decoded).toEqual({
      kind: 'rageQuitV2',
      nullifier,
      commitment,
      recipient,
      amount: 10_000_000n,
    });
  });

  it('returns null for an unrelated event', () => {
    expect(decodePoolEvent([sym('mint')], xdr.ScVal.scvVoid())).toBeNull();
    expect(decodePoolEvent([], xdr.ScVal.scvVoid())).toBeNull();
  });
});
