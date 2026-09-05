// ============================================================
// Viewing-key derivation (worker-safe, no wallet imports)
// ============================================================
// Split from crypto.ts for the same reason poseidon.ts and keys.ts were: this
// is pure crypto, and reaching it through crypto.ts drags @stellar/freighter-api
// — a browser-only SDK — into the proof worker and into `node --test`.
//
// crypto.ts keeps the one genuinely wallet-coupled step (asking Freighter to
// sign) and delegates every byte-level decision to this module, so all of it is
// testable without a browser.

import { NETWORK_PASSPHRASE } from './network';

/** Bumped whenever the derivation or the signed message changes. */
export const VIEWING_KEY_VERSION = 2;

/**
 * The message the wallet signs, bound to version, origin and network (M5).
 *
 * Binding the ORIGIN is the actual protection, and it does not depend on the
 * user reading the text. A phishing site at evil.com can only ever obtain a
 * signature over `origin: https://evil.com`, which derives a key unrelated to
 * the user's real one — so the notes it can see is none of them. The previous
 * message was a fixed string with no origin and no version, so a signature
 * obtained anywhere unlocked everything, and its own warning text was the only
 * control.
 *
 * The network passphrase is included so a testnet identity and a mainnet
 * identity can never be the same key.
 */
export function vayylAuthMessage(origin: string): string {
  return [
    'Vayyl shielded viewing key',
    `version: ${VIEWING_KEY_VERSION}`,
    `origin: ${origin}`,
    `network: ${NETWORK_PASSPHRASE}`,
    '',
    'Signing this derives the key that can SEE AND SPEND every shielded note in',
    'this wallet. Only sign it on the origin shown above.',
  ].join('\n');
}

/**
 * Legacy v1 message. Kept only so v1 notes stay recoverable — never signed for
 * new keys.
 */
export const VAYYL_AUTH_MESSAGE =
  'Authenticate with Vayyl to derive your private viewing key. DO NOT SIGN THIS on untrusted domains.';

const isStrictBase64 = (s: string) =>
  s.length > 0 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);

/**
 * Normalise Freighter's two response shapes to the SAME raw signature bytes.
 *
 * `signMessage` returns `signedMessage: Buffer` on Freighter v3 and
 * `signedMessage: string` (base64) on v4 — both shapes are declared in the
 * bundled `signMessage.d.ts` of @stellar/freighter-api@6.0.1. The old code fed
 * the Buffer through `TextDecoder().decode()` and used the string as-is, so ONE
 * user signing ONE message derived two different viewing keys depending on
 * their wallet version. Upgrading Freighter would have silently orphaned every
 * note they owned.
 *
 * Decoding base64 back to bytes makes both paths converge on the signature
 * itself, which is the only stable thing on offer.
 */
export function normalizeSignatureBytes(resp: unknown): Uint8Array {
  const inner =
    resp && typeof resp === 'object' && 'signedMessage' in (resp as any)
      ? (resp as any).signedMessage
      : resp;

  if (inner == null) throw new Error('Failed to extract signed message');
  if (inner instanceof Uint8Array) return new Uint8Array(inner);
  if (ArrayBuffer.isView(inner)) {
    const v = inner as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  if (typeof inner === 'string') {
    if (isStrictBase64(inner)) {
      const bin = atob(inner);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    // Not base64 — hash the UTF-8 bytes of whatever the wallet gave us. That is
    // lossless in this direction, unlike decoding arbitrary bytes AS text.
    return new TextEncoder().encode(inner);
  }
  throw new Error('Unrecognised signMessage response shape');
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Derive the viewing key from raw signature bytes.
 *
 * M4: the old code did `TextEncoder().encode(TextDecoder().decode(bytes))`,
 * which is not a round trip. Every byte sequence that is not valid UTF-8
 * collapses to U+FFFD, and an Ed25519 signature is 64 essentially-random bytes,
 * so most signatures lost entropy before the digest — distinct signatures could
 * map to the same viewing key. Hash the bytes.
 */
export async function deriveViewingKeyFromSignature(sig: Uint8Array): Promise<string> {
  if (sig.length === 0) throw new Error('Failed to extract signed message');
  const tag = new TextEncoder().encode(`vayyl:viewing-key:v${VIEWING_KEY_VERSION}:`);
  const input = new Uint8Array(tag.length + sig.length);
  input.set(tag, 0);
  input.set(sig, tag.length);
  const hash = await crypto.subtle.digest('SHA-256', input);
  return toHex(new Uint8Array(hash));
}

/** The origin this page is actually served from; '' outside a browser. */
export function currentOrigin(): string {
  return typeof globalThis !== 'undefined' && (globalThis as any).location?.origin
    ? (globalThis as any).location.origin
    : '';
}

/**
 * The ORIGINAL v1 digest, reproduced exactly — lossy decode included.
 *
 * MIGRATION: notes shielded before v2 are owned by the key this returns, so it
 * is the only way to find or spend them. Exported rather than deleted for that
 * reason, and deliberately NOT called anywhere in the normal flow.
 */
export const deriveViewingKeyV1FromResponse = async (resp: unknown): Promise<string> => {
  let signedMessage = '';
  const anyResp = resp as Uint8Array | string | { signedMessage?: string | Uint8Array };
  if (anyResp instanceof Uint8Array) {
    signedMessage = new TextDecoder().decode(anyResp);
  } else if (typeof anyResp === 'string') {
    signedMessage = anyResp;
  } else if (anyResp && (anyResp as any).signedMessage) {
    const sm = (anyResp as any).signedMessage;
    signedMessage = typeof sm === 'string' ? sm : new TextDecoder().decode(sm);
  }
  if (!signedMessage) throw new Error('Failed to extract signed message');
  const bytes = new TextEncoder().encode(signedMessage);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(hash));
};
