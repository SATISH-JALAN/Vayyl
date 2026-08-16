// ============================================================
// V3 note handoff: the amount must survive the trip
// ============================================================
// This covers the defect that reached testnet before it was caught. With a
// fixed denomination the recipient knew the amount, so recovering the blindness
// was enough to find the note. With arbitrary amounts they do not, and the
// commitment cannot be reproduced without it — so a note whose value never
// travelled is a note nobody can find or spend.
//
// The original acceptance test missed this because the sender handed the amount
// to the recipient in-process, which no real wallet can do. Every test here
// therefore reconstructs the note using ONLY what a recipient actually has: the
// on-chain event and their own spend key.

// Serves /circuits/*.wasm off frontend/public so the hashing below is the REAL
// compiled circuit, not a JS stand-in that could silently drift from it.
import '../../../test/public-fetch-shim.ts';

import assert from 'node:assert/strict';
import test from 'node:test';

import { BASE8, mulPointEscalar } from './babyjub.ts';
import {
  deriveOutgoingNoteV3,
  scanForIncomingNotesV3,
  randomScalar,
  type IndexedTransferV3,
} from './transfer.ts';

const hex = (v: bigint) => v.toString(16).padStart(64, '0');

/** What the indexer would serve for an output, from the on-chain event alone. */
const asEvent = (
  out: { commitment: bigint; ephemeralX: bigint; ephemeralY: bigint; amountCipher: bigint },
  leafIndex = 0,
): IndexedTransferV3 => ({
  commitment: hex(out.commitment),
  leafIndex,
  ephemeralX: out.ephemeralX.toString(),
  ephemeralY: out.ephemeralY.toString(),
  amountCipher: hex(out.amountCipher),
});

test('a recipient recovers the amount and finds the note from the event alone', async () => {
  const recipientSk = randomScalar();
  const recipientPk = mulPointEscalar(BASE8, recipientSk);
  const amount = 370_000_000n; // 37 XLM, not a denomination

  const out = await deriveOutgoingNoteV3(recipientPk, amount);
  const found = await scanForIncomingNotesV3(
    recipientSk, recipientPk[0], recipientPk[1], [asEvent(out, 9)],
  );

  assert.equal(found.length, 1);
  assert.equal(found[0].amountStroops, '370000000', 'the amount must survive the handoff');
  assert.equal(found[0].blindness, out.blindness.toString());
  assert.equal(found[0].commitment, out.commitment.toString());
  assert.equal(found[0].leafIndex, 9);
});

test('the sender recovers their own change the same way', async () => {
  // The scenario clean-device recovery exists for. Change is an output to
  // yourself, so it must be discoverable by exactly the same scan.
  const senderSk = randomScalar();
  const senderPk = mulPointEscalar(BASE8, senderSk);

  const change = await deriveOutgoingNoteV3(senderPk, 630_000_000n);
  const found = await scanForIncomingNotesV3(senderSk, senderPk[0], senderPk[1], [asEvent(change)]);

  assert.equal(found.length, 1);
  assert.equal(found[0].amountStroops, '630000000');
});

test('a stranger cannot recover the amount or match the note', async () => {
  const recipientPk = mulPointEscalar(BASE8, randomScalar());
  const out = await deriveOutgoingNoteV3(recipientPk, 370_000_000n);

  const strangerSk = randomScalar();
  const strangerPk = mulPointEscalar(BASE8, strangerSk);
  const found = await scanForIncomingNotesV3(
    strangerSk, strangerPk[0], strangerPk[1], [asEvent(out)],
  );
  assert.equal(found.length, 0);
});

test('the ciphertext does not equal the plaintext amount', async () => {
  // If the pad were ever dropped, this is the assertion that catches it: the
  // amount would sit on the ledger in the clear and the whole feature would be
  // a fixed-denomination pool with extra steps.
  const amount = 370_000_000n;
  const out = await deriveOutgoingNoteV3(mulPointEscalar(BASE8, randomScalar()), amount);
  assert.notEqual(out.amountCipher, amount);
});

test('the amount pad is not the blindness', async () => {
  // Both come from the same ECDH secret. If the domain tags collided, the pad
  // would equal the blindness — which the commitment already commits to — and
  // anyone could strip it.
  const pk = mulPointEscalar(BASE8, randomScalar());
  const amount = 370_000_000n;
  const out = await deriveOutgoingNoteV3(pk, amount);
  assert.notEqual(out.amountCipher - amount, out.blindness);
});

test('two notes of the same amount to the same key look unrelated', async () => {
  // The ephemeral scalar is fresh per note, so repeated payments of an
  // identical amount must not produce a repeated commitment or ciphertext.
  const pk = mulPointEscalar(BASE8, randomScalar());
  const a = await deriveOutgoingNoteV3(pk, 370_000_000n);
  const b = await deriveOutgoingNoteV3(pk, 370_000_000n);
  assert.notEqual(a.commitment, b.commitment);
  assert.notEqual(a.amountCipher, b.amountCipher);
  assert.notEqual(a.ephemeralX, b.ephemeralX);
});

test('a zero-amount change note round-trips', async () => {
  // Exact payments emit one. It is worthless but real, and a scan that choked
  // on it would stop at that event and miss everything after.
  const sk = randomScalar();
  const pk = mulPointEscalar(BASE8, sk);
  const out = await deriveOutgoingNoteV3(pk, 0n);
  const found = await scanForIncomingNotesV3(sk, pk[0], pk[1], [asEvent(out)]);
  assert.equal(found.length, 1);
  assert.equal(found[0].amountStroops, '0');
});

test('rejects a note whose recovered amount exceeds 64 bits', async () => {
  // The circuits range-check every amount, so no provable note can be this
  // large. Storing one would leave the wallet holding something it can never
  // spend, with no explanation.
  const sk = randomScalar();
  const pk = mulPointEscalar(BASE8, sk);
  const out = await deriveOutgoingNoteV3(pk, 1n);
  const tampered = asEvent(out);
  tampered.amountCipher = hex(BigInt(`0x${tampered.amountCipher}`) + (1n << 100n));
  assert.equal((await scanForIncomingNotesV3(sk, pk[0], pk[1], [tampered])).length, 0);
});

test('a malformed ephemeral point is skipped, not fatal', async () => {
  // One malicious sender must not be able to break scanning for everyone else.
  const sk = randomScalar();
  const pk = mulPointEscalar(BASE8, sk);
  const good = await deriveOutgoingNoteV3(pk, 100n);
  const bad: IndexedTransferV3 = {
    commitment: hex(1n), leafIndex: 0, ephemeralX: '1', ephemeralY: '1',
    amountCipher: hex(1n),
  };
  const found = await scanForIncomingNotesV3(sk, pk[0], pk[1], [bad, asEvent(good, 3)]);
  assert.equal(found.length, 1);
  assert.equal(found[0].leafIndex, 3);
});
