// ============================================================
// PositionManager and CounterpartyVault contract client
// ============================================================
// Argument ORDER in every builder below must match the contract's Rust
// signature exactly, and the public-input order the contract builds must match
// the circuit's `component main { public [...] }`. Neither is checked by
// anything at runtime: a mismatch produces a transaction that simulates,
// submits, and reverts with an error naming nothing useful.

import { xdr, Address, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';

import { buildSignSubmit, simulateRead, type SnarkjsProof } from './pool';
import { getTier, type Tier } from './tiers';

export const POSITION_MANAGER_ID = process.env.NEXT_PUBLIC_POSITION_MANAGER || '';
export const COUNTERPARTY_VAULT_ID = process.env.NEXT_PUBLIC_COUNTERPARTY_VAULT || '';

/** True when the positions vertical is deployed and pointed at. */
export const positionsConfigured = () => Boolean(POSITION_MANAGER_ID && COUNTERPARTY_VAULT_ID);

const toHexField = (dec: string) => BigInt(dec).toString(16).padStart(64, '0');

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 ? '0' + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

const g1Bytes = (pt: string[]) => hexToBytes(toHexField(pt[0]) + toHexField(pt[1]));
const g2Bytes = (pt: string[][]) =>
  hexToBytes(
    toHexField(pt[0][1]) + toHexField(pt[0][0]) + toHexField(pt[1][1]) + toHexField(pt[1][0]),
  );

const bytesScVal = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));
const bytesN = (dec: string) => bytesScVal(hexToBytes(toHexField(dec)));
const i128 = (v: bigint | number) => nativeToScVal(BigInt(v), { type: 'i128' });
const u32 = (v: number) => nativeToScVal(v, { type: 'u32' });
const addr = (a: string) => new Address(a).toScVal();

function proofScVal(proof: SnarkjsProof): xdr.ScVal {
  const entry = (name: string, val: xdr.ScVal) =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val });
  return xdr.ScVal.scvMap([
    entry('a', bytesScVal(g1Bytes(proof.pi_a))),
    entry('b', bytesScVal(g2Bytes(proof.pi_b))),
    entry('c', bytesScVal(g1Bytes(proof.pi_c))),
  ]);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface OpenPositionArgs {
  source: string;
  positionIdHex: string;
  owner: string;
  tierId: number;
  direction: 0 | 1;
  proof: SnarkjsProof;
  root: string;
  nullifier: string;
  positionCommitment: string;
  changeCommitment: string;
  useRelayer?: boolean;
}

export async function submitPositionOpen(a: OpenPositionArgs): Promise<string> {
  const args = [
    bytesScVal(hexToBytes(a.positionIdHex)),
    addr(a.owner),
    u32(a.tierId),
    u32(a.direction),
    proofScVal(a.proof),
    bytesN(a.root),
    bytesN(a.nullifier),
    bytesN(a.positionCommitment),
    bytesN(a.changeCommitment),
  ];
  // Never relayed by default. `open_position` calls `owner.require_auth()`, and
  // the owner is a public field of the position anyway, so routing through a
  // relayer would buy no privacy while adding a party that can fail.
  return buildSignSubmit(a.source, POSITION_MANAGER_ID, 'open_position', args, a.useRelayer);
}

export interface ClosePositionArgs {
  source: string;
  positionIdHex: string;
  proof: SnarkjsProof;
  positionNullifier: string;
  outputNoteCommitment: string;
  feeStroops: bigint;
  useRelayer?: boolean;
}

export async function submitPositionClose(a: ClosePositionArgs): Promise<string> {
  const args = [
    bytesScVal(hexToBytes(a.positionIdHex)),
    proofScVal(a.proof),
    bytesN(a.positionNullifier),
    bytesN(a.outputNoteCommitment),
    i128(a.feeStroops),
  ];
  return buildSignSubmit(a.source, POSITION_MANAGER_ID, 'close_position', args, a.useRelayer);
}

export interface AttestHealthArgs {
  source: string;
  positionIdHex: string;
  proof: SnarkjsProof;
  useRelayer?: boolean;
}

export async function submitAttestHealth(a: AttestHealthArgs): Promise<string> {
  const args = [bytesScVal(hexToBytes(a.positionIdHex)), proofScVal(a.proof)];
  return buildSignSubmit(a.source, POSITION_MANAGER_ID, 'attest_health', args, a.useRelayer);
}

export async function submitAddLiquidity(
  source: string,
  amountStroops: bigint,
): Promise<string> {
  return buildSignSubmit(source, COUNTERPARTY_VAULT_ID, 'deposit_liquidity', [
    addr(source),
    i128(amountStroops),
  ]);
}

export async function submitRemoveLiquidity(source: string, shares: bigint): Promise<string> {
  return buildSignSubmit(source, COUNTERPARTY_VAULT_ID, 'withdraw_liquidity', [
    addr(source),
    i128(shares),
  ]);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface OnChainPosition {
  owner: string;
  commitment: string;
  lastHealthTimestamp: number;
  tierId: number;
  entryPrice: bigint;
  direction: 0 | 1;
  openedAt: number;
}

export async function fetchPositionState(positionIdHex: string): Promise<OnChainPosition | null> {
  try {
    const raw = await simulateRead(POSITION_MANAGER_ID, 'get_position_state', [
      bytesScVal(hexToBytes(positionIdHex)),
    ]);
    return {
      owner: String(raw.owner),
      commitment: Buffer.from(raw.commitment).toString('hex'),
      lastHealthTimestamp: Number(raw.last_health_timestamp),
      tierId: Number(raw.tier_id),
      entryPrice: BigInt(raw.entry_price),
      direction: Number(raw.direction) === 1 ? 1 : 0,
      openedAt: Number(raw.opened_at),
    };
  } catch {
    // PositionNotFound is the normal answer for a closed or seized position,
    // and a caller asking "is this still open?" should get `null`, not an
    // exception it has to pattern-match on an error code to interpret.
    return null;
  }
}

/**
 * The live oracle price, read through the contract's OWN staleness rules.
 *
 * Deliberately not read from the oracle directly. The contract is the authority
 * on whether a price is fresh enough to act on, so asking it means the UI can
 * say "the price feed is stale, opening is unavailable" BEFORE the user waits
 * for a proof that was always going to be rejected.
 */
export async function fetchOraclePrice(): Promise<{ price: bigint; timestamp: number } | null> {
  try {
    const raw = await simulateRead(POSITION_MANAGER_ID, 'current_price', []);
    return { price: BigInt(raw.price), timestamp: Number(raw.timestamp) };
  } catch {
    return null;
  }
}

/** What the contract would settle this position for at `closePrice`. */
export async function fetchQuotedPayout(
  positionIdHex: string,
  closePrice: bigint,
): Promise<bigint | null> {
  try {
    const raw = await simulateRead(POSITION_MANAGER_ID, 'quote_payout', [
      bytesScVal(hexToBytes(positionIdHex)),
      i128(closePrice),
    ]);
    return BigInt(raw);
  } catch {
    return null;
  }
}

export async function fetchHealthThreshold(): Promise<bigint | null> {
  try {
    return BigInt(await simulateRead(POSITION_MANAGER_ID, 'health_threshold', []));
  } catch {
    return null;
  }
}

/**
 * The tier table AS THE CONTRACT HAS IT.
 *
 * The UI's own table (lib/tiers.ts) is what builds witnesses, and it has to
 * agree with the deployed contract or every proof fails. Reading the contract's
 * table lets the app detect a disagreement and say so, rather than letting each
 * user discover it one failed transaction at a time.
 */
export async function fetchOnChainTiers(): Promise<Array<[bigint, bigint, bigint]> | null> {
  try {
    const raw = await simulateRead(POSITION_MANAGER_ID, 'tiers', []);
    return (raw as unknown[]).map((row) => {
      const [margin, size, maxPayout] = row as [unknown, unknown, unknown];
      return [BigInt(margin as bigint), BigInt(size as bigint), BigInt(maxPayout as bigint)];
    });
  } catch {
    return null;
  }
}

/** Compare the deployed tier table against the one this build proves against. */
export function tierTableMatches(
  onChain: Array<[bigint, bigint, bigint]>,
  local: Tier[] = [getTier(0), getTier(1)],
): boolean {
  if (onChain.length !== local.length) return false;
  return local.every((t, i) => {
    const [margin, size, maxPayout] = onChain[i];
    return margin === t.marginStroops && size === t.size && maxPayout === t.maxPayoutStroops;
  });
}

export interface VaultState {
  balance: bigint;
  totalReserved: bigint;
  freeBalance: bigint;
  totalShares: bigint;
}

/**
 * The counterparty vault's capacity.
 *
 * `freeBalance` is what the UI must show before an open: a position cannot be
 * created unless the vault can already cover its best case. That is a normal
 * state, not an error, and the UI is required to present it as one.
 */
export async function fetchVaultState(): Promise<VaultState | null> {
  try {
    const [balance, totalReserved, freeBalance, totalShares] = await Promise.all([
      simulateRead(COUNTERPARTY_VAULT_ID, 'balance', []),
      simulateRead(COUNTERPARTY_VAULT_ID, 'total_reserved', []),
      simulateRead(COUNTERPARTY_VAULT_ID, 'free_balance', []),
      simulateRead(COUNTERPARTY_VAULT_ID, 'total_shares', []),
    ]);
    return {
      balance: BigInt(balance),
      totalReserved: BigInt(totalReserved),
      freeBalance: BigInt(freeBalance),
      totalShares: BigInt(totalShares),
    };
  } catch {
    return null;
  }
}

export async function fetchLpShares(address: string): Promise<bigint | null> {
  try {
    return BigInt(await simulateRead(COUNTERPARTY_VAULT_ID, 'shares_of', [addr(address)]));
  } catch {
    return null;
  }
}

/** Whether the vault can back one more position in this tier, right now. */
export function vaultCanCover(vault: VaultState, tier: Tier): boolean {
  return vault.freeBalance >= tier.maxPayoutStroops - tier.marginStroops;
}

export { scValToNative };
