// ============================================================
// Position event decoding
// ============================================================
// Soroban RPC keeps events for about seven days and a position can be open far
// longer, so this decoder is the only durable record that a position id belongs
// to an address -- and, after a close, the only record of what it settled for.
//
// The amounts are i128 stroops on-chain. Every one of them is decoded as a
// BigInt: a `Number` above 2^53 rounds silently, and a mis-recorded payout is a
// payout note the wallet can never re-derive.

import { describe, it, expect } from 'vitest';
import { xdr, nativeToScVal, Address, Keypair } from '@stellar/stellar-sdk';

import { decodePoolEvent } from './decode.js';

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const bytesN = (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex, 'hex'));
const mapEntry = (k: string, v: xdr.ScVal) =>
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });

const OWNER = Keypair.random().publicKey();
const POSITION_ID = 'aa'.repeat(32);

describe('position_open', () => {
  const event = (over: Partial<Record<string, xdr.ScVal>> = {}) => {
    const topic = [sym('position_open'), bytesN(POSITION_ID), new Address(OWNER).toScVal()];
    const value = xdr.ScVal.scvMap([
      mapEntry('commitment', over.commitment ?? bytesN('bb'.repeat(32))),
      mapEntry('change_commitment', over.change_commitment ?? bytesN('cc'.repeat(32))),
      mapEntry('tier_id', over.tier_id ?? nativeToScVal(1, { type: 'u32' })),
      mapEntry('direction', over.direction ?? nativeToScVal(1, { type: 'u32' })),
      mapEntry('size', over.size ?? nativeToScVal(150n, { type: 'i128' })),
      mapEntry('margin', over.margin ?? nativeToScVal(500_000_000n, { type: 'i128' })),
      mapEntry('entry_price', over.entry_price ?? nativeToScVal(10_000_000n, { type: 'i128' })),
    ]);
    return decodePoolEvent(topic, value);
  };

  it('decodes every field the wallet needs to re-derive its notes', () => {
    expect(event()).toEqual({
      kind: 'PositionOpen',
      positionId: POSITION_ID,
      owner: OWNER,
      commitment: 'bb'.repeat(32),
      changeCommitment: 'cc'.repeat(32),
      tierId: 1,
      direction: 1,
      size: 150n,
      margin: 500_000_000n,
      entryPrice: 10_000_000n,
    });
  });

  it('keeps the entry price as a BigInt', () => {
    // The entry price is what every future PnL is measured from. Rounding it
    // would mis-price the position for its whole life.
    const decoded = event({ entry_price: nativeToScVal(9_007_199_254_740_993n, { type: 'i128' }) });
    expect(decoded && 'entryPrice' in decoded && decoded.entryPrice).toBe(9_007_199_254_740_993n);
  });

  it('records a short as direction 0, not as a missing value', () => {
    const decoded = event({ direction: nativeToScVal(0, { type: 'u32' }) });
    expect(decoded && 'direction' in decoded && decoded.direction).toBe(0);
  });

  it('returns null when the owner topic is missing', () => {
    // A malformed event must not become a row with an empty owner, which would
    // surface in every wallet's position list.
    expect(decodePoolEvent([sym('position_open'), bytesN(POSITION_ID)], xdr.ScVal.scvMap([]))).toBeNull();
  });
});

describe('position_close', () => {
  it('decodes the settlement, which is what makes the payout note recoverable', () => {
    const topic = [sym('position_close'), bytesN(POSITION_ID)];
    const value = xdr.ScVal.scvMap([
      mapEntry('output_note_commitment', bytesN('dd'.repeat(32))),
      mapEntry('close_price', nativeToScVal(11_000_000n, { type: 'i128' })),
      mapEntry('payout', nativeToScVal(130_000_000n, { type: 'i128' })),
      mapEntry('fee', nativeToScVal(0n, { type: 'i128' })),
    ]);

    expect(decodePoolEvent(topic, value)).toEqual({
      kind: 'PositionClose',
      positionId: POSITION_ID,
      outputNoteCommitment: 'dd'.repeat(32),
      closePrice: 11_000_000n,
      payout: 130_000_000n,
      fee: 0n,
    });
  });

  it('decodes a zero payout rather than treating it as absent', () => {
    // A wiped-out position settles for exactly zero. Recording that as missing
    // would make it indistinguishable from an unrecorded close.
    const topic = [sym('position_close'), bytesN(POSITION_ID)];
    const value = xdr.ScVal.scvMap([
      mapEntry('output_note_commitment', bytesN('ee'.repeat(32))),
      mapEntry('close_price', nativeToScVal(1n, { type: 'i128' })),
      mapEntry('payout', nativeToScVal(0n, { type: 'i128' })),
      mapEntry('fee', nativeToScVal(0n, { type: 'i128' })),
    ]);
    const decoded = decodePoolEvent(topic, value);
    expect(decoded && 'payout' in decoded && decoded.payout).toBe(0n);
  });
});

describe('position_health', () => {
  it('decodes the attestation timestamp', () => {
    const topic = [sym('position_health'), bytesN(POSITION_ID)];
    const value = xdr.ScVal.scvMap([
      mapEntry('timestamp', nativeToScVal(1_700_000_000n, { type: 'u64' })),
      mapEntry('oracle_price', nativeToScVal(10_000_000n, { type: 'i128' })),
    ]);
    expect(decodePoolEvent(topic, value)).toEqual({
      kind: 'PositionHealth',
      positionId: POSITION_ID,
      timestamp: 1_700_000_000,
    });
  });
});

describe('position_seized', () => {
  it('decodes a liquidation, so a seized position stops looking open', () => {
    // Emitted by LiquidationEngine, not PositionManager. Without it a seized
    // position would keep appearing in the owner's list forever, and they would
    // have no record of where their collateral went.
    const keeper = Keypair.random().publicKey();
    const topic = [sym('position_seized'), bytesN(POSITION_ID), new Address(keeper).toScVal()];
    const value = xdr.ScVal.scvMap([
      mapEntry('collateral', nativeToScVal(100_000_000n, { type: 'i128' })),
      mapEntry('bounty', nativeToScVal(5_000_000n, { type: 'i128' })),
      mapEntry('to_vault', nativeToScVal(95_000_000n, { type: 'i128' })),
    ]);

    expect(decodePoolEvent(topic, value)).toEqual({
      kind: 'PositionSeized',
      positionId: POSITION_ID,
      keeper,
      collateral: 100_000_000n,
      bounty: 5_000_000n,
    });
  });
});

describe('unknown events', () => {
  it('are ignored rather than throwing', () => {
    // The indexer subscribes to whole contracts, so it sees events it does not
    // model. Throwing on one would stall the poller at that ledger.
    expect(decodePoolEvent([sym('something_else')], xdr.ScVal.scvMap([]))).toBeNull();
  });
});
