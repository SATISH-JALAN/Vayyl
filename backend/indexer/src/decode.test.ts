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

  it('returns null for an unrelated event', () => {
    expect(decodePoolEvent([sym('mint')], xdr.ScVal.scvVoid())).toBeNull();
    expect(decodePoolEvent([], xdr.ScVal.scvVoid())).toBeNull();
  });
});
