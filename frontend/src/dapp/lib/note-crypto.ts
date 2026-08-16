// ============================================================
// At-rest encryption for the local note store
// ============================================================
// Shielded notes are bearer instruments: the secret IS the money. Anyone who
// reads a note's (amount, pubX, pubY, blindness, spendKey-derived nullifier)
// can spend it. Until now those sat as plaintext JSON in IndexedDB, so a shared
// machine, a synced profile, or anything with page-level access got the lot.
//
// Two separate leaks are fixed here, and fixing only the first would be theatre:
//
//   1. VALUES. Notes are sealed with AES-GCM under a key derived from the
//      wallet's viewing key, which never leaves memory and is itself derived
//      from a Freighter signature.
//
//   2. KEY NAMES. The store used `vayyl_notes_<viewingKey>` as the IndexedDB
//      key, printing the viewing key in the clear next to the ciphertext it
//      protects. The viewing key is what lets anyone rediscover every note the
//      wallet has ever received, so encrypting the value while publishing the
//      key alongside it protects nothing. Names are now derived through a hash.
//
// Deliberately NOT a password scheme. There is no second factor to forget and
// no KDF cost to tune: the key comes from the wallet, so recovery is "connect
// the same wallet" rather than "remember a passphrase you set months ago".
//
// Worker- and test-safe: no DOM, no wallet imports, no IndexedDB.

/** Domain separation. Must differ from the export-backup tag in storage.ts. */
const TAG_AT_REST = 'vayyl-at-rest-v1';
const TAG_NAME = 'vayyl-storage-name-v1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sha256(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', encoder.encode(input));
}

const toHex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The IndexedDB key for one kind of record, with the viewing key hashed out.
 *
 * Inspecting storage now reveals only that Vayyl is installed and roughly how
 * many records exist, which is unavoidable, rather than handing over the secret
 * that unlocks them.
 */
export async function scopedStorageKey(viewingKey: string, kind: string): Promise<string> {
  const digest = await sha256(`${TAG_NAME}:${kind}:${viewingKey}`);
  return `vayyl_${kind}_${toHex(digest).slice(0, 32)}`;
}

async function atRestKey(viewingKey: string): Promise<CryptoKey> {
  const raw = await sha256(`${TAG_AT_REST}:${viewingKey}`);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** What actually lands in IndexedDB. Recognisable so a legacy value is obvious. */
export interface SealedRecord {
  v: 1;
  iv: string;
  ct: string;
}

const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

export function isSealed(value: unknown): value is SealedRecord {
  return (
    typeof value === 'object' && value !== null &&
    (value as SealedRecord).v === 1 &&
    typeof (value as SealedRecord).iv === 'string' &&
    typeof (value as SealedRecord).ct === 'string'
  );
}

/** Encrypt a JSON-serialisable value under the wallet's viewing key. */
export async function seal(viewingKey: string, value: unknown): Promise<SealedRecord> {
  // A fresh IV per write. AES-GCM catastrophically loses confidentiality if an
  // IV is reused under the same key, and this key is long-lived by design.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await atRestKey(viewingKey),
    encoder.encode(JSON.stringify(value)),
  );
  return { v: 1, iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

/**
 * Decrypt a record written by `seal`.
 *
 * Throws on a wrong key or tampered ciphertext rather than returning a default:
 * GCM authenticates, and silently treating a failed open as "no notes" would
 * make a corrupted store look like an empty wallet, which is the single worst
 * thing this module could tell a user.
 */
export async function open<T>(viewingKey: string, record: SealedRecord): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(record.iv) },
    await atRestKey(viewingKey),
    fromBase64(record.ct),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}
