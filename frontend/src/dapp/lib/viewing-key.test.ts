// ============================================================
// Viewing-key derivation: entropy, wallet-version stability, origin binding
// ============================================================
// The viewing key derives the spend key, which derives every note. A change or
// an inconsistency here does not corrupt one note, it orphans the whole wallet.
// These tests pin the three properties that were missing (M4, M5, and the
// Freighter v3/v4 divergence found while fixing them).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeSignatureBytes,
  vayylAuthMessage,
  deriveViewingKeyV1FromResponse,
  VIEWING_KEY_VERSION,
} from './viewing-key.ts';

/** A realistic Ed25519 signature: 64 bytes that are NOT valid UTF-8. */
const SIGNATURE = new Uint8Array(64);
for (let i = 0; i < 64; i++) SIGNATURE[i] = (i * 37 + 0x80) & 0xff;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const hex = (bytes: Uint8Array) =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------------------
// The v3/v4 divergence
// ---------------------------------------------------------------------------

test('Freighter v3 (Buffer) and v4 (base64 string) yield identical signature bytes', () => {
  // `signMessage.d.ts` in the pinned @stellar/freighter-api@6.0.1 declares BOTH
  // `signedMessage: Buffer | null` (v3) and `signedMessage: string | null` (v4).
  // The old code decoded the Buffer as text and used the string as-is, so one
  // user derived two different viewing keys depending on their wallet version —
  // upgrading Freighter would have orphaned every note they owned.
  const v3 = normalizeSignatureBytes({ signedMessage: Buffer.from(SIGNATURE), signerAddress: 'G...' });
  const v4 = normalizeSignatureBytes({ signedMessage: b64(SIGNATURE), signerAddress: 'G...' });

  assert.equal(hex(v3), hex(SIGNATURE), 'v3 must pass the raw bytes through');
  assert.equal(hex(v4), hex(SIGNATURE), 'v4 base64 must decode back to the same bytes');
  assert.equal(hex(v3), hex(v4), 'the two wallet versions MUST converge');
});

test('a bare Uint8Array response is accepted', () => {
  assert.equal(hex(normalizeSignatureBytes(SIGNATURE)), hex(SIGNATURE));
});

test('a non-base64 string is hashed as UTF-8 rather than being mangled', () => {
  const out = normalizeSignatureBytes({ signedMessage: 'not-base64!!' });
  assert.equal(Buffer.from(out).toString('utf8'), 'not-base64!!');
});

test('a missing signature is an error, not an empty key', () => {
  assert.throws(() => normalizeSignatureBytes({ signedMessage: null }), /Failed to extract/);
  assert.throws(() => normalizeSignatureBytes(null), /Failed to extract/);
});

// ---------------------------------------------------------------------------
// M4: entropy
// ---------------------------------------------------------------------------

test('M4: the v1 derivation really did destroy entropy, the new one does not', async () => {
  // Two DIFFERENT signatures that differ only in bytes which are invalid UTF-8.
  // Both collapse to U+FFFD under TextDecoder, so v1 mapped them to one key.
  const a = new Uint8Array([0xff, 0xfe, 0x01, 0x02]);
  const b = new Uint8Array([0xff, 0xfd, 0x01, 0x02]);

  const v1a = await deriveViewingKeyV1FromResponse(a);
  const v1b = await deriveViewingKeyV1FromResponse(b);
  assert.equal(v1a, v1b, 'documents the v1 bug: two signatures, one viewing key');

  // The fix keeps them distinct, because it hashes the bytes.
  assert.notEqual(hex(normalizeSignatureBytes(a)), hex(normalizeSignatureBytes(b)));
});

test('the full 64 bytes of the signature survive normalisation', () => {
  // A lossy path would shrink or pad this; U+FFFD is three bytes, so a mangled
  // 64-byte signature comes back far longer than 64.
  assert.equal(normalizeSignatureBytes(SIGNATURE).length, 64);
});

// ---------------------------------------------------------------------------
// M5: origin binding
// ---------------------------------------------------------------------------

test('M5: the signed message binds version, origin and network', () => {
  const msg = vayylAuthMessage('https://app.vayyl.xyz');
  assert.match(msg, /^Vayyl shielded viewing key$/m);
  assert.match(msg, new RegExp(`^version: ${VIEWING_KEY_VERSION}$`, 'm'));
  assert.match(msg, /^origin: https:\/\/app\.vayyl\.xyz$/m);
  assert.match(msg, /^network: /m);
});

test('M5: a phishing origin produces a different message, hence a different key', () => {
  // This is the property that matters, and it does not rely on the user reading
  // the text: a signature obtained on evil.com is over a different message, so
  // it derives a key that owns none of the victim's notes.
  const real = vayylAuthMessage('https://app.vayyl.xyz');
  const evil = vayylAuthMessage('https://evil.example');
  assert.notEqual(real, evil);
});

test('the message is stable for a given origin', () => {
  // It must be byte-identical every time or the user gets a new wallet on every
  // unlock.
  assert.equal(vayylAuthMessage('https://a.example'), vayylAuthMessage('https://a.example'));
});
