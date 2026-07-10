import { xdr, Address, nativeToScVal } from '@stellar/stellar-sdk';
import { buildSignSubmit, type SnarkjsProof } from './pool';

export const POSITION_MANAGER_ID = process.env.NEXT_PUBLIC_POSITION_MANAGER || '';

const toHexField = (dec: string) => BigInt(dec).toString(16).padStart(64, '0');

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 ? '0' + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function g1Bytes(pt: string[]): Uint8Array {
  return hexToBytes(toHexField(pt[0]) + toHexField(pt[1]));
}
function g2Bytes(pt: string[][]): Uint8Array {
  return hexToBytes(
    toHexField(pt[0][1]) + toHexField(pt[0][0]) + toHexField(pt[1][1]) + toHexField(pt[1][0]),
  );
}
function frBytes(dec: string): Uint8Array {
  return hexToBytes(toHexField(dec));
}

const bytesScVal = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));

function proofScVal(proof: SnarkjsProof): xdr.ScVal {
  const entry = (name: string, val: xdr.ScVal) =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val });
  return xdr.ScVal.scvMap([
    entry('a', bytesScVal(g1Bytes(proof.pi_a))),
    entry('b', bytesScVal(g2Bytes(proof.pi_b))),
    entry('c', bytesScVal(g1Bytes(proof.pi_c))),
  ]);
}

const bytesN = (dec: string) => bytesScVal(frBytes(dec));
const i128 = (v: bigint | number) => nativeToScVal(BigInt(v), { type: 'i128' });
const addr = (a: string) => new Address(a).toScVal();

export interface OpenPositionArgs {
  source: string;
  positionIdHex: string; // 32 bytes hex
  owner: string;
  proof: SnarkjsProof;
  root: string;
  nullifier: string;
  positionCommitment: string;
  metaHash: string;
  direction: number | bigint;
  size: number | bigint;
  useRelayer?: boolean;
}

export async function submitPositionOpen(a: OpenPositionArgs): Promise<string> {
  const args = [
    bytesScVal(hexToBytes(a.positionIdHex)),
    addr(a.owner),
    proofScVal(a.proof),
    bytesN(a.root),
    bytesN(a.nullifier),
    bytesN(a.positionCommitment),
    bytesN(a.metaHash),
    nativeToScVal(Number(a.direction), { type: 'u32' }),
    nativeToScVal(BigInt(a.size), { type: 'i128' }),
  ];
  return buildSignSubmit(a.source, POSITION_MANAGER_ID, 'open_position', args, a.useRelayer);
}

export interface ClosePositionArgs {
  source: string;
  positionIdHex: string; // 32 bytes hex
  proof: SnarkjsProof;
  positionNullifier: string;
  newPositionCommitment: string;
  outputNoteCommitment: string;
  fee: bigint;
  metaHash: string;
  useRelayer?: boolean;
}

export async function submitPositionClose(a: ClosePositionArgs): Promise<string> {
  const args = [
    bytesScVal(hexToBytes(a.positionIdHex)),
    proofScVal(a.proof),
    bytesN(a.positionNullifier),
    bytesN(a.newPositionCommitment),
    bytesN(a.outputNoteCommitment),
    i128(a.fee),
    bytesN(a.metaHash),
  ];
  return buildSignSubmit(a.source, POSITION_MANAGER_ID, 'close_or_modify_position', args, a.useRelayer);
}
