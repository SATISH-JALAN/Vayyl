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
