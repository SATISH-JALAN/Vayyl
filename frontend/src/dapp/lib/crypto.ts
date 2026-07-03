// ============================================================
// Client-side shielded crypto  (Task 6.2)
// ============================================================
// Poseidon2 hashing lives in poseidon.ts (worker-safe, no wallet imports).
// This module adds the wallet-coupled pieces: viewing-key derivation from a
// Freighter signature, and deterministic shielded-key derivation from it.
// Re-exports the hashing helpers so existing imports keep working.

import { signMessage } from '@stellar/freighter-api';
import { poseidon2Hash2, FIELD_P, modP } from './poseidon';

export {
  poseidon2Hash2,
  poseidon2Hash4,
  computeCommitment,
  computeNullifier,
  randomFieldElement,
  FIELD_P,
} from './poseidon';

/** Legacy hex blindness kept for compatibility; prefer randomFieldElement(). */
export function generateBlindness(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return modP(x).toString();
}

// ---- Shielded key derivation (Task 6.2) ------------------------------------
// A real viewing key is derived from a Freighter signature (deriveViewingKey).
// From it we deterministically derive the account's spend key and the note
// public key. NOTE: pubX/pubY are Poseidon2-derived from the spend key, not a
// BabyJubjub DL public key — the payment circuits do not (yet) bind pubkey to
// privkey. Binding via lib/babyjubjub.circom DerivePublicKey is a §7 hardening
// item; until then these are deterministic, reconstructable, and spendable.

const TAG_SPEND = 1n;
const TAG_PUBX = 2n;
const TAG_PUBY = 3n;

export interface ShieldedKeys {
  viewingKey: string; // hex
  spendKey: bigint; // privKey used in the nullifier
  pubX: bigint;
  pubY: bigint;
}

export async function deriveShieldedKeys(viewingKey: string): Promise<ShieldedKeys> {
  const vkField = modP(BigInt('0x' + viewingKey.replace(/^0x/, '')));
  const spendKey = await poseidon2Hash2(vkField, TAG_SPEND);
  const pubX = await poseidon2Hash2(spendKey, TAG_PUBX);
  const pubY = await poseidon2Hash2(spendKey, TAG_PUBY);
  return { viewingKey, spendKey, pubX, pubY };
}

// ---- Viewing key from a Freighter signature --------------------------------

export const VAYYL_AUTH_MESSAGE =
  'Authenticate with Vayyl to derive your private viewing key. DO NOT SIGN THIS on untrusted domains.';

export const deriveViewingKey = async (): Promise<string> => {
  const signatureResponse = await signMessage(VAYYL_AUTH_MESSAGE, {
    networkPassphrase: 'Test SDF Network ; September 2015',
  });
  if ((signatureResponse as { error?: string }).error) {
    throw new Error((signatureResponse as { error?: string }).error);
  }

  let signedMessage = '';
  const anyResp = signatureResponse as unknown as
    | Uint8Array
    | string
    | { signedMessage?: string | Uint8Array };
  if (anyResp instanceof Uint8Array) {
    signedMessage = new TextDecoder().decode(anyResp);
  } else if (typeof anyResp === 'string') {
    signedMessage = anyResp;
  } else if (anyResp.signedMessage) {
    signedMessage =
      typeof anyResp.signedMessage === 'string'
        ? anyResp.signedMessage
        : new TextDecoder().decode(anyResp.signedMessage);
  }
  if (!signedMessage) throw new Error('Failed to extract signed message');

  const signatureBytes = new TextEncoder().encode(signedMessage);
  const hashBuffer = await crypto.subtle.digest('SHA-256', signatureBytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};
