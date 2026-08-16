// ============================================================
// Event decoding for VayylPool #[contractevent]s  (Task 6.1)
// ============================================================
// The pool emits typed events (contracts/vayyl-pool/src/lib.rs):
//   Deposit  { commitment(topic), leaf_index, amount }
//     topics: [ symbol("deposit"), BytesN<32> commitment ]
//     data:   Map { leaf_index: u32, amount: i128 }
//   Withdraw { nullifier(topic), recipient, amount }
//     topics: [ symbol("withdraw"), BytesN<32> nullifier ]
//     data:   Map { recipient: Address, amount: i128 }
//   Transfer { nullifier1(topic), nullifier2(topic), commitment1, commitment2 }
//     topics: [ symbol("transfer"), BytesN<32> n1, BytesN<32> n2 ]
//     data:   Map { commitment1: BytesN<32>, commitment2: BytesN<32> }
//     RETIRED — the pool no longer emits this. Decoding is kept deliberately:
//     the event still exists in ledger history on the older pools, and it
//     carries no leaf index, so an indexer pointed at one of them must SAY so
//     (see poller.ts) rather than skip the rows in silence.
//
// #[contractevent] default data format is scvMap of the non-topic fields, keyed
// by symbol. We decode topic[0] (the event name symbol) to route.

import { xdr, scValToNative } from '@stellar/stellar-sdk';

export type PoolEvent =
  | { kind: 'deposit'; commitment: string; leafIndex: number; amount: bigint }
  | { kind: 'withdraw'; nullifier: string; recipient: string; amount: bigint }
  | {
      kind: 'transfer';
      nullifier1: string;
      nullifier2: string;
      commitment1: string;
      commitment2: string;
    }
  | { kind: 'rageQuitV2'; nullifier: string; commitment: string; recipient: string; amount: bigint }
  | {
      kind: 'transferV3';
      nullifier1: string;
      nullifier2: string;
      outputs: Array<{
        commitment: string; leafIndex: number;
        ephemeralX: string; ephemeralY: string; amountCipher: string;
      }>;
    }
  | {
      kind: 'transferV2';
      nullifier: string;
      commitment: string;
      leafIndex: number;
      ephemeralX: string;
      ephemeralY: string;
      amount: bigint;
    }
  | { kind: 'PositionOpen'; positionId: string; owner: string; commitment: string; direction: number; size: bigint }
  | { kind: 'PositionHealth'; positionId: string; timestamp: number }
  | { kind: 'PositionClose'; positionId: string; newCommitment: string; outputNoteCommitment: string };

/** 32-byte ScVal (BytesN<32>) → lowercase hex, no 0x. */
function bytesN32ToHex(v: xdr.ScVal): string {
  const buf: Buffer = v.bytes ? Buffer.from(v.bytes()) : Buffer.alloc(0);
  return buf.toString('hex').padStart(64, '0');
}

function symbolName(v: xdr.ScVal): string {
  // scvSymbol → string
  const s = v.sym ? v.sym() : undefined;
  return s ? s.toString() : '';
}

/** Data Map → plain object keyed by symbol field name. */
function mapToObject(v: xdr.ScVal): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const entries = v.map ? v.map() : null;
  if (!entries) return out;
  for (const e of entries) {
    const key = symbolName(e.key());
    out[key] = scValToNative(e.val());
  }
  return out;
}

/**
 * Decode a raw RPC event (topic: xdr.ScVal[], value: xdr.ScVal) into a typed
 * PoolEvent, or null if it is not a recognised Vayyl event.
 */
export function decodePoolEvent(topic: xdr.ScVal[], value: xdr.ScVal): PoolEvent | null {
  if (!topic || topic.length === 0) return null;
  const name = symbolName(topic[0]);
  const data = mapToObject(value);

  switch (name) {
    case 'deposit': {
      if (topic.length < 2) return null;
      return {
        kind: 'deposit',
        commitment: bytesN32ToHex(topic[1]),
        leafIndex: Number(data.leaf_index ?? 0),
        amount: BigInt((data.amount as bigint | number | string) ?? 0),
      };
    }
    case 'withdraw': {
      if (topic.length < 2) return null;
      return {
        kind: 'withdraw',
        nullifier: bytesN32ToHex(topic[1]),
        recipient: String(data.recipient ?? ''),
        amount: BigInt((data.amount as bigint | number | string) ?? 0),
      };
    }
    case 'transfer': {
      if (topic.length < 3) return null;
      const c1 = data.commitment1 as Buffer | Uint8Array | undefined;
      const c2 = data.commitment2 as Buffer | Uint8Array | undefined;
      const hex = (b?: Buffer | Uint8Array) =>
        b ? Buffer.from(b).toString('hex').padStart(64, '0') : '';
      return {
        kind: 'transfer',
        nullifier1: bytesN32ToHex(topic[1]),
        nullifier2: bytesN32ToHex(topic[2]),
        commitment1: hex(c1),
        commitment2: hex(c2),
      };
    }
    // V2 shielded transfer: one nullifier spent, one commitment created. Unlike
    // the V1 `transfer` above, this event carries the output's leaf_index, which
    // is what lets the commitment be placed correctly in the tree.
    case 'transfer_v2': {
      if (topic.length < 2) return null;
      const hex = (b?: Buffer | Uint8Array) =>
        b ? Buffer.from(b).toString('hex').padStart(64, '0') : '';
      return {
        kind: 'transferV2',
        nullifier: bytesN32ToHex(topic[1]),
        commitment: hex(data.commitment as Buffer | Uint8Array | undefined),
        leafIndex: Number(data.leaf_index ?? 0),
        ephemeralX: hex(data.ephemeral_x as Buffer | Uint8Array | undefined),
        ephemeralY: hex(data.ephemeral_y as Buffer | Uint8Array | undefined),
        amount: BigInt((data.amount as bigint | number | string) ?? 0),
      };
    }
    // Public exit. The nullifier here MUST be indexed like any other spend:
    // wallets hide already-spent notes by checking the nullifier feed, so
    // missing these would leave a rage-quit note looking spendable forever and
    // every attempt to spend it failing on-chain with NullifierAlreadyUsed.
    // The commitment is carried too, because rage-quit publishes it on purpose
    // — that public deposit-to-payout link is the trade being made.
    case 'ragequit_v2': {
      if (topic.length < 2) return null;
      const hex = (b?: Buffer | Uint8Array) =>
        b ? Buffer.from(b).toString('hex').padStart(64, '0') : '';
      return {
        kind: 'rageQuitV2',
        nullifier: bytesN32ToHex(topic[1]),
        commitment: hex(data.commitment as Buffer | Uint8Array | undefined),
        recipient: String(data.recipient ?? ''),
        amount: BigInt((data.amount as bigint | number | string) ?? 0),
      };
    }
    // V3 arbitrary-amount transfer: two notes spent, two created. Carries NO
    // amounts, which is the point — the values stay inside the proof. Both
    // outputs must be indexed with their own leaf index and ephemeral point:
    // output 2 is the sender's CHANGE, and a wallet restored on a clean device
    // rediscovers it through the same scan it uses for receipts. Dropping it
    // would silently lose most of a sender's balance on recovery.
    case 'transfer_v3': {
      if (topic.length < 3) return null;
      const hex = (b?: Buffer | Uint8Array) =>
        b ? Buffer.from(b).toString('hex').padStart(64, '0') : '';
      return {
        kind: 'transferV3',
        nullifier1: bytesN32ToHex(topic[1]),
        nullifier2: bytesN32ToHex(topic[2]),
        outputs: [
          {
            commitment: hex(data.commitment1 as Buffer | Uint8Array | undefined),
            leafIndex: Number(data.leaf_index1 ?? 0),
            ephemeralX: hex(data.eph1_x as Buffer | Uint8Array | undefined),
            ephemeralY: hex(data.eph1_y as Buffer | Uint8Array | undefined),
            amountCipher: hex(data.amount_ct1 as Buffer | Uint8Array | undefined),
          },
          {
            commitment: hex(data.commitment2 as Buffer | Uint8Array | undefined),
            leafIndex: Number(data.leaf_index2 ?? 0),
            ephemeralX: hex(data.eph2_x as Buffer | Uint8Array | undefined),
            ephemeralY: hex(data.eph2_y as Buffer | Uint8Array | undefined),
            amountCipher: hex(data.amount_ct2 as Buffer | Uint8Array | undefined),
          },
        ],
      };
    }
    case 'position_open': {
      if (topic.length < 3) return null;
      const c = data.commitment as Buffer | Uint8Array | undefined;
      const hex = (b?: Buffer | Uint8Array) =>
        b ? Buffer.from(b).toString('hex').padStart(64, '0') : '';
      return {
        kind: 'PositionOpen',
        positionId: bytesN32ToHex(topic[1]),
        owner: String(scValToNative(topic[2])),
        commitment: hex(c),
        direction: Number(data.direction ?? 0),
        size: BigInt((data.size as bigint | number | string) ?? 0),
      };
    }
    case 'position_health': {
      if (topic.length < 2) return null;
      return {
        kind: 'PositionHealth',
        positionId: bytesN32ToHex(topic[1]),
        timestamp: Number(data.timestamp ?? 0),
      };
    }
    case 'position_close': {
      if (topic.length < 2) return null;
      const nc = data.new_commitment as Buffer | Uint8Array | undefined;
      const oc = data.output_note_commitment as Buffer | Uint8Array | undefined;
      const hex = (b?: Buffer | Uint8Array) =>
        b ? Buffer.from(b).toString('hex').padStart(64, '0') : '';
      return {
        kind: 'PositionClose',
        positionId: bytesN32ToHex(topic[1]),
        newCommitment: hex(nc),
        outputNoteCommitment: hex(oc),
      };
    }
    default:
      return null;
  }
}
