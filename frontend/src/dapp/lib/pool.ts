// ============================================================
// VayylPool interaction: encode proof + assemble/sign/submit  (Task 6.3)
// ============================================================
// Replaces the old mock-XDR path. Builds a real Soroban invocation of
// VayylPool.deposit / .withdraw with the real Groth16 proof + public inputs,
// simulates to attach footprint + resource fees, signs with Freighter, and
// submits (direct, or via the relayer fee-bump for withdraw privacy).
//
// Encoding mirrors circuits/scripts/format_stellar_vk.js exactly:
//   G1 (A,C) -> 64 bytes (x‖y), G2 (B) -> 128 bytes (x_c1‖x_c0‖y_c1‖y_c0),
//   Fr (public inputs / commitment / nullifier / root) -> 32 bytes big-endian.
// The contracttype enum CircuitId serialises as scvVec([scvSymbol(variant)]).

import {
  Contract,
  TransactionBuilder,
  Address,
  nativeToScVal,
  xdr,
  rpc,
  Networks,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import { signTransaction } from '@stellar/freighter-api';

// ---- config (env-overridable) ----------------------------------------------

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'https://soroban-testnet.stellar.org';
export const NETWORK_PASSPHRASE = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET;
export const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || 'http://localhost:3001';
export const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL || 'http://localhost:3002';
export const POOL_IDS: Record<string, string | undefined> = {
  XLM: process.env.NEXT_PUBLIC_POOL_XLM,
  USDC: process.env.NEXT_PUBLIC_POOL_USDC,
};

export const server = new rpc.Server(RPC_URL, { allowHttp: true });

export function poolIdForAsset(asset: string): string {
  const id = POOL_IDS[asset];
  if (!id) throw new Error(`No pool contract configured for ${asset} (set NEXT_PUBLIC_POOL_${asset})`);
  return id;
}

// ---- snarkjs proof types ---------------------------------------------------

export interface SnarkjsProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
}

// ---- field/point formatting ------------------------------------------------

const toHexField = (dec: string) => BigInt(dec).toString(16).padStart(64, '0');

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 ? '0' + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function g1Bytes(pt: string[]): Uint8Array {
  return hexToBytes(toHexField(pt[0]) + toHexField(pt[1])); // 64 bytes
}
function g2Bytes(pt: string[][]): Uint8Array {
  return hexToBytes(
    toHexField(pt[0][1]) + toHexField(pt[0][0]) + toHexField(pt[1][1]) + toHexField(pt[1][0]),
  ); // 128 bytes
}
function frBytes(dec: string): Uint8Array {
  return hexToBytes(toHexField(dec)); // 32 bytes
}

// ---- ScVal builders --------------------------------------------------------

const bytesScVal = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));

/** Groth16Proof { a: BytesN<64>, b: BytesN<128>, c: BytesN<64> } */
function proofScVal(proof: SnarkjsProof): xdr.ScVal {
  const entry = (name: string, val: xdr.ScVal) =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val });
  return xdr.ScVal.scvMap([
    entry('a', bytesScVal(g1Bytes(proof.pi_a))),
    entry('b', bytesScVal(g2Bytes(proof.pi_b))),
    entry('c', bytesScVal(g1Bytes(proof.pi_c))),
  ]);
}

/** CircuitId unit variant -> scvVec([scvSymbol("Deposit")]) */
const circuitIdScVal = (variant: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)]);

const bytesN = (dec: string) => bytesScVal(frBytes(dec));
const i128 = (v: bigint | number) => nativeToScVal(BigInt(v), { type: 'i128' });
const addr = (a: string) => new Address(a).toScVal();

// ---- M3: withdraw binding (must match VayylPool::compute_withdraw_binding) --
// pool: sha256( recipient.to_xdr()  ‖  amount.to_be_bytes()[0..16] ) then
//       clear the top 3 bits of byte[0] (&= 0x1F) so it fits BN254.
// recipient.to_xdr() in Soroban == the XDR of ScVal::Address, which the JS SDK
// reproduces via Address(...).toScVal().toXDR(). ⚠ M3 LANDMINE: a byte mismatch
// makes every withdraw proof silently fail to verify — validate against a live
// contract call once before trusting it (see docs landmine §8).
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', input);
  return new Uint8Array(digest);
}

function i128Be16(v: bigint): Uint8Array {
  // Two's-complement big-endian over 16 bytes (amounts are non-negative here).
  const out = new Uint8Array(16);
  let x = v < 0n ? (1n << 128n) + v : v;
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Field-element decimal string of the withdraw binding for (recipient, amount). */
export async function computeWithdrawBinding(recipient: string, amount: bigint): Promise<string> {
  const recipientXdr = new Address(recipient).toScVal().toXDR(); // Buffer
  const buf = new Uint8Array(recipientXdr.length + 16);
  buf.set(new Uint8Array(recipientXdr), 0);
  buf.set(i128Be16(amount), recipientXdr.length);
  const h = await sha256(buf);
  h[0] &= 0x1f;
  let x = 0n;
  for (const b of h) x = (x << 8n) | BigInt(b);
  return x.toString();
}

// ---- tx assembly + submit --------------------------------------------------

export async function buildSignSubmit(
  sourceAddress: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  useRelayer: boolean = false
): Promise<string> {
  const source = await server.getAccount(sourceAddress);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  // Simulate → attach footprint + resource fees (and any required auth).
  const prepared = await server.prepareTransaction(tx);

  const signed = await signTransaction(prepared.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: sourceAddress,
  });
  const signedXdr = typeof signed === 'string' ? signed : (signed as { signedTxXdr: string }).signedTxXdr;

  if (useRelayer) {
    const res = await fetch(`${RELAYER_URL}/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx: signedXdr })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(`Relayer failed: ${data.error || JSON.stringify(data)}`);
    }
    if (data.response?.status === 'ERROR') {
      throw new Error(`Relayer failed to submit transaction to network: ${JSON.stringify(data.response.errorResult || data.response)}`);
    }
    // The relayer response contains the fee bump transaction hash
    const hash = data.response?.hash;
    if (!hash) throw new Error('Relayer did not return a transaction hash');

    // Poll for finality
    let attempts = 0;
    while (true) {
      const txRes = await server.getTransaction(hash);
      if (txRes.status === 'SUCCESS') return hash;
      if (txRes.status === 'FAILED') {
        throw new Error(`Transaction ${hash} failed on-chain: ${JSON.stringify(txRes)}`);
      }
      if (++attempts > 30) throw new Error(`Timed out waiting for ${hash}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const signedTx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const sent = await server.sendTransaction(signedTx);
  if (sent.status === 'ERROR') {
    throw new Error(`Submission failed: ${JSON.stringify(sent.errorResult ?? sent)}`);
  }

  // Poll for finality.
  let attempts = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await server.getTransaction(sent.hash);
    if (res.status === 'SUCCESS') return sent.hash;
    if (res.status === 'FAILED') {
      throw new Error(`Transaction ${sent.hash} failed on-chain: ${JSON.stringify(res)}`);
    }
    if (++attempts > 30) throw new Error(`Timed out waiting for ${sent.hash}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---- public API ------------------------------------------------------------

export interface DepositArgs {
  depositor: string;
  proof: SnarkjsProof;
  commitment: string; // decimal field element
  publicAmount: bigint;
  aspRoot: string; // decimal field element
  asset: string;
  useRelayer?: boolean;
}

export async function submitDeposit(a: DepositArgs): Promise<string> {
  const args = [
    addr(a.depositor),
    proofScVal(a.proof),
    bytesN(a.commitment),
    i128(a.publicAmount),
    bytesN(a.aspRoot),
  ];
  return buildSignSubmit(a.depositor, poolIdForAsset(a.asset), 'deposit', args, a.useRelayer);
}

export interface WithdrawArgs {
  source: string; // account that pays fees / submits (connected wallet or relayer)
  proof: SnarkjsProof;
  nullifier: string;
  publicAmount: bigint;
  recipient: string;
  root: string;
  fee: bigint;
  relayer: string;
  asset: string;
  useRelayer?: boolean;
}

export async function submitWithdraw(a: WithdrawArgs): Promise<string> {
  const args = [
    proofScVal(a.proof),
    bytesN(a.nullifier),
    i128(a.publicAmount),
    addr(a.recipient),
    bytesN(a.root),
    i128(a.fee),
    addr(a.relayer),
  ];
  return buildSignSubmit(a.source, poolIdForAsset(a.asset), 'withdraw', args, a.useRelayer);
}

// ---- indexer reads ---------------------------------------------------------

/** Ordered commitment field elements (leaf order) from the indexer. */
export async function fetchCommitments(): Promise<bigint[]> {
  const res = await fetch(`${INDEXER_URL}/commitments`);
  if (!res.ok) throw new Error(`indexer /commitments ${res.status}`);
  const data = await res.json();
  // commitment_hash stored as hex (64 chars) by the indexer.
  return (data.commitments as string[]).map((h) => BigInt('0x' + h.replace(/^0x/, '')));
}

export async function fetchSpentNullifiers(): Promise<Set<string>> {
  const res = await fetch(`${INDEXER_URL}/nullifiers`);
  if (!res.ok) return new Set();
  const data = await res.json();
  return new Set((data.nullifiers as string[]).map((h) => BigInt('0x' + h.replace(/^0x/, '')).toString()));
}
