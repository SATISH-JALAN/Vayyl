// ============================================================
// Shielded key derivation (worker-safe, no wallet imports)
// ============================================================
// Split from crypto.ts for the same reason poseidon.ts was: this is pure
// crypto, and pulling in @stellar/freighter-api to reach it forces a browser
// wallet SDK into the proof worker and into `node --test`. crypto.ts re-exports
// everything here, so existing imports keep working.
//
// A viewing key (derived from a Freighter signature — see crypto.ts) yields the
// account's spend key, and the spend key yields the note public key by
// BabyJubjub scalar multiplication: `(pubX, pubY) = spendKey·G`. That is the same
// operation `DerivePublicKey()` performs inside the circuit
// (circuits/lib/babyjubjub.circom). The circuit derives the public key from the
// private key rather than accepting it as a free witness, so a client deriving it
// any other way builds a commitment whose Merkle leaf its proof can never open —
// and the failure surfaces on-chain as an opaque verification error, not as
// anything pointing back at key derivation. crypto.test.ts pins the two together
// against the compiled circuit.

import { poseidon2Hash2, modP } from './poseidon';
import { derivePublicKey, SUBORDER } from './babyjub';

const TAG_SPEND = 1n;

export interface ShieldedKeys {
  viewingKey: string; // hex
  spendKey: bigint; // privKey used in the nullifier; canonical in [1, SUBORDER)
  pubX: bigint;
  pubY: bigint;
}

/**
 * Derive the account's shielded identity from its viewing key.
 *
 * The spend key is reduced into [1, SUBORDER) because that is exactly the domain
 * the circuit constrains. Two reasons, both load-bearing:
 *   - Soundness: scalars differing by SUBORDER derive the same public key but a
 *     different nullifier, which is the F1 double-spend.
 *   - Completeness: a raw Poseidon2 output reaches ~2^254 and overflows the
 *     circuit's 251-bit decomposition about a third of the time, failing witness
 *     generation outright.
 */
export async function deriveShieldedKeys(viewingKey: string): Promise<ShieldedKeys> {
  const vkField = modP(BigInt('0x' + viewingKey.replace(/^0x/, '')));
  const raw = await poseidon2Hash2(vkField, TAG_SPEND);
  // P/SUBORDER ≈ 8, so the modulo bias costs well under one bit out of 251 —
  // negligible, and it buys canonicity. The 0 case is unreachable in practice but
  // would be a key anyone can derive and therefore anyone can spend.
  const reduced = raw % SUBORDER;
  const spendKey = reduced === 0n ? 1n : reduced;
  const { pubX, pubY } = derivePublicKey(spendKey);
  return { viewingKey, spendKey, pubX, pubY };
}
