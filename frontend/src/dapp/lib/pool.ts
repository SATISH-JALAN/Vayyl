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
  BASE_FEE,
  scValToNative,
  StrKey,
} from '@stellar/stellar-sdk';
import { signTransaction } from '@stellar/freighter-api';
import { NETWORK_PASSPHRASE } from './network';
import { parseRelayerSet, selectRelayer, type DelayPolicy } from './relayer-set';
import {
  fetchCommitmentsFrom,
  fetchSpentNullifiersFrom,
  fetchTransfersFrom,
  fetchDepositsFrom,
  type IndexedTransferRow,
  assertRootMatches,
} from './tree-source';
import { computeRoot } from './merkle';

// ---- config (env-overridable) ----------------------------------------------

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'https://soroban-testnet.stellar.org';
// Default to the local services. The former Railway deployments are gone (DNS no
// longer resolves), and defaulting to a dead host fails as an opaque network
// error at scan/relay time rather than at startup. Set the env vars to point at
// hosted services once they exist; see frontend/.env.testnet.
export const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || 'http://localhost:3001';
export const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL || 'http://localhost:3002';
// A SET, not a single endpoint. One relayer means every withdrawal shares a fee
// payer, which clusters the whole user base without touching the cryptography.
// Comma-separated; falls back to the single URL above when unset.
export const RELAYER_SET = parseRelayerSet(process.env.NEXT_PUBLIC_RELAYER_SET, RELAYER_URL);
// Withdrawal hold window. A fixed gap between deposit and withdrawal is the same
// weakness as a shared fee payer on a second axis.
export const WITHDRAW_DELAY: DelayPolicy = {
  minMs: Number(process.env.NEXT_PUBLIC_WITHDRAW_DELAY_MIN_MS ?? 30_000),
  maxMs: Number(process.env.NEXT_PUBLIC_WITHDRAW_DELAY_MAX_MS ?? 600_000),
};
export const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL || 'https://horizon-testnet.stellar.org';
export const V2_POOL_ID = process.env.NEXT_PUBLIC_POOL_XLM || 'CB6XFHGN4DMVEQRESJHPOUNYLUCGMOZTAIKTWH3I7KT3NVW2XY4NIOLC';
export const V2_VERIFIER_ID = process.env.NEXT_PUBLIC_VERIFIER || 'CBRMDGEMQERFTG3MCBHYPHMZPKVMDYFGHJAMREQW23ZDKVAMAFDRJ2J5';
export const V2_ASP_MEMBERSHIP_ID = process.env.NEXT_PUBLIC_ASP_MEMBERSHIP || 'CD5DLTOIEAYA6CATHKELFAYRBOEFQN5TMADCEAURVZMMTYVD6Y5POCMO';
export { V2_DENOMINATION_STROOPS, V2_DENOMINATION_XLM } from './denomination';
// Read-only source account for simulate-only calls; needs no signing key.
const VIEW_SOURCE = 'GCZTDHO2FG2ABMQ46ON2MN262Z7RXD7TRA2QWGGKQIZVT7ZXK6AUJ3TH';
export const POOL_IDS: Record<string, string | undefined> = {
  XLM: V2_POOL_ID,
  USDC: process.env.NEXT_PUBLIC_POOL_USDC,
};

export const server = new rpc.Server(RPC_URL, { allowHttp: true });
const INCLUSION_FEE = BASE_FEE;

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
    fee: INCLUSION_FEE,
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

export async function submitDepositV2(a: Omit<DepositArgs, 'publicAmount' | 'asset'>): Promise<string> {
  return buildSignSubmit(a.depositor, V2_POOL_ID, 'deposit_v2', [
    addr(a.depositor),
    proofScVal(a.proof),
    bytesN(a.commitment),
    bytesN(a.aspRoot),
  ]);
}

export interface DepositV3Args {
  depositor: string;
  proof: SnarkjsProof;
  commitment: string;
  aspRoot: string;
  /** Decimal stroops. String, not number: i128 exceeds JS integer precision. */
  amountStroops: string;
}

/**
 * Shield an arbitrary amount.
 *
 * Wallet-signed rather than relayed, unlike every spend path: the pool pulls
 * tokens from the depositor, so `depositor.require_auth()` has to be satisfied
 * by the account that owns them. The deposit is public by nature — the transfer
 * is on the ledger either way — and privacy begins at the next hop.
 */
export async function submitDepositV3(a: DepositV3Args): Promise<string> {
  return buildSignSubmit(a.depositor, V2_POOL_ID, 'deposit_v3', [
    addr(a.depositor),
    proofScVal(a.proof),
    bytesN(a.commitment),
    bytesN(a.aspRoot),
    i128(BigInt(a.amountStroops)),
  ]);
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

export async function submitWithdrawV2(a: Pick<WithdrawArgs, 'proof' | 'nullifier' | 'recipient' | 'root'>): Promise<string> {
  const response = await fetch(`${RELAYER_URL}/v2/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pool: V2_POOL_ID, ...a }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success || !body.hash) {
    throw new Error(body.error || `Relayer request failed (${response.status})`);
  }
  return body.hash as string;
}

// ---- V3: arbitrary amounts -------------------------------------------------

export interface TransferV3Args {
  proof: SnarkjsProof;
  root: string;
  nullifier1: string;
  nullifier2: string;
  commitment1: string;
  commitment2: string;
  eph1X: string;
  eph1Y: string;
  eph2X: string;
  eph2Y: string;
  amountCt1: string;
  amountCt2: string;
}

/**
 * Submit an arbitrary-amount shielded transfer through the relayer.
 *
 * Never wallet-signed, for the same reason the V2 transfer is not: the relayer
 * is the transaction source, so the sender's Stellar address never touches the
 * ledger. A wallet-signed transfer would defeat the feature entirely.
 */
export async function submitTransferV3(a: TransferV3Args): Promise<string> {
  const response = await fetch(`${selectRelayer(RELAYER_SET)}/v3/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pool: V2_POOL_ID, ...a }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success || !body.hash) {
    throw new Error(body.error || `Relayer request failed (${response.status})`);
  }
  return body.hash as string;
}

export interface WithdrawV3Args {
  proof: SnarkjsProof;
  nullifier: string;
  recipient: string;
  root: string;
  /** Decimal stroops. A string throughout: i128 exceeds JS number precision. */
  amountStroops: string;
}

export async function submitWithdrawV3(a: WithdrawV3Args): Promise<string> {
  const response = await fetch(`${selectRelayer(RELAYER_SET)}/v3/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pool: V2_POOL_ID, ...a }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success || !body.hash) {
    throw new Error(body.error || `Relayer request failed (${response.status})`);
  }
  return body.hash as string;
}

export interface RageQuitV2Args {
  proof: SnarkjsProof;
  commitment: string;
  nullifier: string;
  recipient: string;
}

/**
 * Submit a public exit through the relayer.
 *
 * Relayed rather than wallet-signed for the same reason `withdraw_v2` is: the
 * people who need this are, by definition, ones the pool has stopped from
 * spending, and requiring them to hold a funded Stellar account to escape would
 * reintroduce the trap in a different shape. The proof is bound to `recipient`,
 * so possession of it is the authorization and the relayer cannot redirect the
 * payout.
 */
export async function submitRageQuitV2(a: RageQuitV2Args): Promise<string> {
  const response = await fetch(`${selectRelayer(RELAYER_SET)}/v2/ragequit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pool: V2_POOL_ID, ...a }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success || !body.hash) {
    throw new Error(body.error || `Relayer request failed (${response.status})`);
  }
  return body.hash as string;
}

export interface TransferV2Args {
  proof: SnarkjsProof;
  nullifier: string;
  commitment: string;
  ephemeralX: string;
  ephemeralY: string;
  root: string;
}

/**
 * Submit a shielded transfer through the relayer.
 *
 * Deliberately never signed by the user's wallet: the relayer is the
 * transaction source, so the sender's Stellar address never touches the ledger.
 * A wallet-signed transfer would defeat the entire feature.
 */
export async function submitTransferV2(a: TransferV2Args): Promise<string> {
  const response = await fetch(`${RELAYER_URL}/v2/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pool: V2_POOL_ID, ...a }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success || !body.hash) {
    throw new Error(body.error || `Relayer request failed (${response.status})`);
  }
  return body.hash as string;
}

export type { IndexedTransferRow } from './tree-source';

/**
 * The recipient scan feed — every shielded-transfer output with its ephemeral
 * point. Resolution rules (and the durable fallback behind them) live in
 * `tree-source.ts`, which is kept free of wallet imports so they can be tested.
 */
export async function fetchTransfers(since = 0): Promise<IndexedTransferRow[]> {
  return fetchTransfersFrom(INDEXER_URL, V2_POOL_ID, since);
}

export async function simulateRead(contractId: string, method: string, args: xdr.ScVal[]) {
  const source = await server.getAccount(VIEW_SOURCE);
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const result = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(result) || !result.result) {
    throw new Error(rpc.Api.isSimulationError(result) ? result.error : 'Contract read returned no result');
  }
  return scValToNative(result.result.retval);
}

export interface AnonymitySet {
  /** Unspent notes in the pool: the crowd a spend actually hides in. */
  unspent: number;
  /** Minimum required to withdraw. Zero means withdrawals are not gated. */
  floor: number;
}

/**
 * Read the live anonymity set from the chain.
 *
 * Read from the pool rather than counted from the indexer on purpose: this is
 * the number a user's privacy actually rests on, so it should come from the
 * same place that enforces it, not from a service that could be stale or
 * simply wrong. Cryptography gives unlinkability within a set and cannot
 * manufacture the set, so a user deserves to see the crowd before committing
 * funds rather than assuming a guarantee the size does not support.
 */
export async function fetchAnonymitySet(): Promise<AnonymitySet | null> {
  try {
    const [unspent, floor] = await Promise.all([
      simulateRead(V2_POOL_ID, 'unspent_note_count', []),
      simulateRead(V2_POOL_ID, 'anonymity_floor', []),
    ]);
    return { unspent: Number(unspent), floor: Number(floor) };
  } catch {
    // A pool that predates the floor has neither function. Reporting nothing is
    // right: showing a fabricated number would be worse than showing none.
    return null;
  }
}

export async function fetchV2AspLeafIndex(leaf: string): Promise<number | null> {
  try {
    return Number(await simulateRead(V2_ASP_MEMBERSHIP_ID, 'get_leaf_index', [bytesN(leaf)]));
  } catch {
    return null;
  }
}

export interface V2EnrollmentResult {
  leafIndex: number;
  txHash: string | null;
  leaves: string[];
}

export async function fetchV2AspLeaves(): Promise<string[]> {
  const response = await fetch(`${RELAYER_URL}/v2/asp/leaves`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(body.leaves)) {
    throw new Error(body.error || 'Membership state is unavailable.');
  }
  return body.leaves as string[];
}

export async function enrollV2AspLeaf(leaf: string): Promise<V2EnrollmentResult> {
  const response = await fetch(`${RELAYER_URL}/v2/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leaf }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success || !Number.isInteger(body.leafIndex) || !Array.isArray(body.leaves)) {
    throw new Error(body.error || 'Workspace enrollment failed.');
  }
  return body as V2EnrollmentResult;
}

export async function assertV2ServicesReady(recipient: string): Promise<void> {
  if (!StrKey.isValidEd25519PublicKey(recipient)) {
    throw new Error('Enter a valid funded Stellar account address beginning with G.');
  }
  // Any healthy operator will do: requiring a specific one would reintroduce a
  // single point of failure the set exists to remove.
  const [account, ...healths] = await Promise.all([
    fetch(`${HORIZON_URL}/accounts/${recipient}`),
    ...RELAYER_SET.map((url) =>
      fetch(`${url}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null)),
  ]);
  const relayer = healths.find(
    (h) => h && h.status === 'ok' && Number(h.nativeBalance ?? 0) >= 1);
  if (!account.ok) {
    throw new Error('The destination account is not active on this network. Fund it before withdrawing.');
  }
  if (!relayer) {
    throw new Error('No settlement service is available right now. Try again shortly.');
  }
}

// ---- indexer reads ---------------------------------------------------------
// Leaf ordering is served by the indexer but is NOT solely dependent on it: see
// `tree-source.ts` for why (Soroban RPC drops events after ~7 days) and for the
// reconciliation rules against the bundled static snapshot.

/** Ordered commitment field elements in leaf order. */
export async function fetchCommitments(): Promise<bigint[]> {
  return fetchCommitmentsFrom(INDEXER_URL, V2_POOL_ID);
}

/** The pool's current Merkle root, straight from the contract. */
export async function fetchPoolRoot(): Promise<bigint> {
  const raw = await simulateRead(V2_POOL_ID, 'get_root', []);
  // `get_root` returns BytesN<32>; scValToNative gives a Buffer/Uint8Array.
  const bytes = raw as Uint8Array;
  let out = 0n;
  for (const b of bytes) out = (out << 8n) | BigInt(b);
  return out;
}

/**
 * M8: verify the leaf ordering we are about to prove against BEFORE proving.
 * The rule itself lives in `tree-source.ts` (wallet-free, so it is testable);
 * this supplies the on-chain root.
 */
export async function assertLeavesMatchChain(leaves: bigint[]): Promise<bigint[]> {
  return assertRootMatches(leaves, await fetchPoolRoot(), (l) => computeRoot(l));
}

/** Fetch the commitment set and confirm it reproduces the pool's root. */
export async function fetchVerifiedCommitments(): Promise<bigint[]> {
  return assertLeavesMatchChain(await fetchCommitments());
}

export async function fetchSpentNullifiers(): Promise<Set<string>> {
  return fetchSpentNullifiersFrom(INDEXER_URL, V2_POOL_ID);
}

export type { IndexedDepositRow } from './tree-source';

/** Deposits with public amounts, for rediscovering this wallet's own deposits. */
export async function fetchDeposits() {
  return fetchDepositsFrom(INDEXER_URL, V2_POOL_ID);
}
