// ============================================================
// Client-side shielded crypto  (Task 6.2)
// ============================================================
// Poseidon2 hashing lives in poseidon.ts (worker-safe, no wallet imports).
// This module adds the wallet-coupled pieces: viewing-key derivation from a
// Freighter signature, and deterministic shielded-key derivation from it.
// Re-exports the hashing helpers so existing imports keep working.

import { signMessage } from '@stellar/freighter-api';
import { modP } from './poseidon';
import { NETWORK_PASSPHRASE } from './network';
import {
  vayylAuthMessage,
  normalizeSignatureBytes,
  deriveViewingKeyFromSignature,
  deriveViewingKeyV1FromResponse,
  currentOrigin,
  VAYYL_AUTH_MESSAGE,
} from './viewing-key';

export {
  poseidon2Hash2,
  poseidon2Hash4,
  computeCommitment,
  computeNullifier,
  randomFieldElement,
  FIELD_P,
} from './poseidon';

export { deriveShieldedKeys, type ShieldedKeys } from './keys';
export { derivePublicKey, mulPointEscalar, BASE8, SUBORDER } from './babyjub';

/** Legacy hex blindness kept for compatibility; prefer randomFieldElement(). */
export function generateBlindness(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return modP(x).toString();
}

// ---- Shielded key derivation (Task 6.2) ------------------------------------
// Lives in keys.ts (worker-safe, no wallet imports) and is re-exported above so
// existing imports keep working. The viewing key it consumes comes from
// deriveViewingKey below, which is the genuinely wallet-coupled half.

// ---- Viewing key from a Freighter signature --------------------------------
//
// Everything byte-level lives in viewing-key.ts (wallet-free, so it is testable
// under `node --test`). What remains here is the one step that genuinely needs
// the wallet: asking Freighter to sign.

export {
  VIEWING_KEY_VERSION,
  VAYYL_AUTH_MESSAGE,
  vayylAuthMessage,
  normalizeSignatureBytes,
  deriveViewingKeyFromSignature,
  deriveViewingKeyV1FromResponse,
  currentOrigin,
} from './viewing-key';

export const deriveViewingKey = async (
  address: string,
  origin: string = currentOrigin(),
): Promise<string> => {
  const response = await signMessage(vayylAuthMessage(origin), {
    address,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  if ((response as { error?: string }).error) {
    throw new Error((response as { error?: string }).error);
  }
  return deriveViewingKeyFromSignature(normalizeSignatureBytes(response));
};

/**
 * The v1 viewing key, for recovering notes shielded before the v2 change.
 * Deliberately not called in the normal flow — see viewing-key.ts.
 */
export const deriveViewingKeyV1 = async (address: string): Promise<string> => {
  const response = await signMessage(VAYYL_AUTH_MESSAGE, {
    address,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  if ((response as { error?: string }).error) {
    throw new Error((response as { error?: string }).error);
  }
  return deriveViewingKeyV1FromResponse(response);
};
