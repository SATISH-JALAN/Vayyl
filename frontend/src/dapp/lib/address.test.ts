// Shielded address + ECDH note handoff.
//
// These two things decide whether a payment is spendable by its recipient and
// nobody else, and both fail silently when wrong: a bad address produces a note
// no one can open, and a broken ECDH agreement produces a note the recipient
// never finds. Neither shows up as an error anywhere — the money is just gone.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Must precede anything that hashes: poseidon.ts fetches its wasm by absolute path.
import '../../../test/public-fetch-shim';

import {
  encodeShieldedAddress,
  decodeShieldedAddress,
  formatShieldedAddress,
} from './address';
import { BASE8, SUBORDER, derivePublicKey, mulPointEscalar, inCurve } from './babyjub';
import { deriveOutgoingNote, scanForIncomingNotes, randomScalar, V2_AMOUNT_STROOPS } from './transfer';
import { poseidon2Hash4 } from './poseidon';

describe('shielded address', () => {
  it('round-trips every key it encodes', async () => {
    for (const sk of [1n, 2n, 12345n, 999999999n, SUBORDER - 1n]) {
      const key = derivePublicKey(sk);
      const encoded = encodeShieldedAddress(key);
      const decoded = decodeShieldedAddress(encoded);
      assert.equal(decoded.pubX, key.pubX, `pubX round-trip failed for sk=${sk}`);
      assert.equal(decoded.pubY, key.pubY, `pubY round-trip failed for sk=${sk}`);
    }
  });

  it('produces a VAYYL-prefixed address of stable length', () => {
    const encoded = encodeShieldedAddress(derivePublicKey(42n));
    assert.ok(encoded.startsWith('VAYYL'), `expected VAYYL prefix, got ${encoded.slice(0, 8)}`);
    // 67 payload bytes -> 108 base32 chars, + 5 prefix.
    assert.equal(encoded.length, 113);
  });

  it('accepts a lowercase or padded paste', () => {
    const key = derivePublicKey(7n);
    const encoded = encodeShieldedAddress(key);
    const decoded = decodeShieldedAddress(`  ${encoded.toLowerCase()}  `);
    assert.equal(decoded.pubX, key.pubX);
  });

  it('rejects a single mistyped character', () => {
    const encoded = encodeShieldedAddress(derivePublicKey(31337n));
    let rejected = 0;
    // Mutate a spread of positions inside the payload.
    for (const pos of [6, 20, 44, 71, 99, encoded.length - 3]) {
      const ch = encoded[pos];
      const replacement = ch === 'A' ? 'B' : 'A';
      const mutated = encoded.slice(0, pos) + replacement + encoded.slice(pos + 1);
      assert.throws(() => decodeShieldedAddress(mutated), /checksum|curve|subgroup|field/i);
      rejected++;
    }
    assert.equal(rejected, 6);
  });

  it('rejects truncation, a wrong prefix, and junk characters', () => {
    const encoded = encodeShieldedAddress(derivePublicKey(5n));
    assert.throws(() => decodeShieldedAddress(encoded.slice(0, 40)), /truncated|checksum/i);
    assert.throws(() => decodeShieldedAddress(`XAYYL${encoded.slice(5)}`), /should start with VAYYL/i);
    assert.throws(() => decodeShieldedAddress(`${encoded.slice(0, -1)}!`), /Invalid character/i);
  });

  it('refuses to encode a point that is not on the curve', () => {
    const key = derivePublicKey(11n);
    assert.throws(
      () => encodeShieldedAddress({ pubX: key.pubX + 1n, pubY: key.pubY }),
      /not on the BabyJubjub curve/i,
    );
  });

  it('shortens for display without losing the prefix', () => {
    const encoded = encodeShieldedAddress(derivePublicKey(3n));
    const short = formatShieldedAddress(encoded);
    assert.ok(short.startsWith('VAYYL'));
    assert.ok(short.includes('…'));
    assert.ok(short.length < encoded.length);
  });
});

describe('ECDH note handoff', () => {
  it('agrees: mul(mul(G,a),b) === mul(mul(G,b),a)', () => {
    const a = 7654321n;
    const b = 1234567n;
    const left = mulPointEscalar(mulPointEscalar(BASE8, a), b);
    const right = mulPointEscalar(mulPointEscalar(BASE8, b), a);
    assert.deepEqual(left, right);
  });

  it('lets a recipient recover the blindness the sender chose', async () => {
    const recipientSk = 98765432101234n % SUBORDER;
    const recipient = derivePublicKey(recipientSk);

    const note = await deriveOutgoingNote([recipient.pubX, recipient.pubY]);

    // The sender publishes only R and the commitment. The recipient starts from
    // those alone — no shared secret, no message, no contact with the sender.
    const found = await scanForIncomingNotes(recipientSk, recipient.pubX, recipient.pubY, [
      {
        commitment: note.commitment.toString(16).padStart(64, '0'),
        leafIndex: 4,
        ephemeralX: note.ephemeralX.toString(),
        ephemeralY: note.ephemeralY.toString(),
      },
    ]);

    assert.equal(found.length, 1, 'recipient failed to discover their own note');
    assert.equal(found[0].blindness, note.blindness.toString());
    assert.equal(found[0].leafIndex, 4);
  });

  it('does not match a note addressed to someone else', async () => {
    const recipient = derivePublicKey(555n);
    const stranger = 777n;
    const strangerPub = derivePublicKey(stranger);

    const note = await deriveOutgoingNote([recipient.pubX, recipient.pubY]);
    const found = await scanForIncomingNotes(stranger, strangerPub.pubX, strangerPub.pubY, [
      {
        commitment: note.commitment.toString(16).padStart(64, '0'),
        leafIndex: 0,
        ephemeralX: note.ephemeralX.toString(),
        ephemeralY: note.ephemeralY.toString(),
      },
    ]);

    assert.equal(found.length, 0, 'a stranger must not be able to claim this note');
  });

  it('produces a commitment the recipient can rebuild from blindness alone', async () => {
    // This is what makes the note SPENDABLE: withdraw/transfer rebuild the
    // commitment from (amount, pubkey, blindness) and must land on the same
    // value the sender put in the tree.
    const sk = 24680n;
    const pub = derivePublicKey(sk);
    const note = await deriveOutgoingNote([pub.pubX, pub.pubY]);
    const rebuilt = await poseidon2Hash4(V2_AMOUNT_STROOPS, pub.pubX, pub.pubY, note.blindness);
    assert.equal(rebuilt, note.commitment);
  });

  it('skips a transfer whose ephemeral point is unusable instead of throwing', async () => {
    const sk = 13579n;
    const pub = derivePublicKey(sk);
    const found = await scanForIncomingNotes(sk, pub.pubX, pub.pubY, [
      // Off-curve R: one malicious sender must not break scanning for everyone.
      { commitment: '00'.repeat(32), leafIndex: 0, ephemeralX: '2', ephemeralY: '3' },
      // The identity point, which would make the shared secret constant.
      { commitment: '00'.repeat(32), leafIndex: 1, ephemeralX: '0', ephemeralY: '1' },
    ]);
    assert.equal(found.length, 0);
  });

  it('draws ephemeral scalars in [1, l) and does not repeat them', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const r = randomScalar();
      assert.ok(r > 0n && r < SUBORDER, `scalar ${r} out of range`);
      assert.ok(inCurve(mulPointEscalar(BASE8, r)), 'r·G left the curve');
      seen.add(r.toString());
    }
    assert.equal(seen.size, 200, 'ephemeral scalars repeated — reuse would link payments');
  });
});
