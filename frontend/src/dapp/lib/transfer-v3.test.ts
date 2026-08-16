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
  deriveDepositBlindness,
  recoverOwnDeposits,
  randomScalar,
  type IndexedTransferV3,
} from './transfer.ts';
import { poseidon2Hash4 } from './poseidon.ts';

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

// ---- deposits must be recoverable too --------------------------------------
// Receipts and change come back through ECDH because the sender's ephemeral
// point is on-chain. A deposit has no sender but the depositor, so if its
// blindness were a local random value, clearing the browser would destroy every
// unspent deposit — and "recover your balance from your wallet alone" would be
// false for anyone holding one.

test('a wallet rediscovers its own deposits from the spend key alone', async () => {
  const spendKey = randomScalar();
  const pk = mulPointEscalar(BASE8, spendKey);

  // Two deposits of different, non-denomination amounts.
  const amounts = [1_000_000_000n, 370_000_000n];
  const deposits = [];
  for (const [i, amount] of amounts.entries()) {
    const blindness = await deriveDepositBlindness(spendKey, i);
    const commitment = await poseidon2Hash4(amount, pk[0], pk[1], blindness);
    deposits.push({
      commitment: commitment.toString(16).padStart(64, '0'),
      leafIndex: i,
      amountStroops: amount.toString(),
    });
  }

  const recovered = await recoverOwnDeposits(spendKey, pk[0], pk[1], deposits);
  assert.equal(recovered.length, 2);
  assert.deepEqual(recovered.map((d) => d.amountStroops), ['1000000000', '370000000']);
  assert.deepEqual(recovered.map((d) => d.depositIndex), [0, 1]);
});

test('deposit recovery finds a note at a non-contiguous index', async () => {
  // A wallet can deposit, spend, and deposit again, so the surviving indices
  // have gaps. Stopping the search at the first miss would lose the later note.
  const spendKey = randomScalar();
  const pk = mulPointEscalar(BASE8, spendKey);
  const amount = 500_000_000n;
  const blindness = await deriveDepositBlindness(spendKey, 7);
  const commitment = await poseidon2Hash4(amount, pk[0], pk[1], blindness);

  const recovered = await recoverOwnDeposits(spendKey, pk[0], pk[1], [{
    commitment: commitment.toString(16).padStart(64, '0'),
    leafIndex: 3,
    amountStroops: amount.toString(),
  }]);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].depositIndex, 7);
});

test('another wallet cannot claim someone else\'s deposit', async () => {
  const owner = randomScalar();
  const ownerPk = mulPointEscalar(BASE8, owner);
  const amount = 500_000_000n;
  const commitment = await poseidon2Hash4(
    amount, ownerPk[0], ownerPk[1], await deriveDepositBlindness(owner, 0),
  );

  const stranger = randomScalar();
  const strangerPk = mulPointEscalar(BASE8, stranger);
  const recovered = await recoverOwnDeposits(stranger, strangerPk[0], strangerPk[1], [{
    commitment: commitment.toString(16).padStart(64, '0'),
    leafIndex: 0,
    amountStroops: amount.toString(),
  }]);
  assert.equal(recovered.length, 0);
});

test('deposit blindness is deterministic and distinct per index', async () => {
  // Deterministic is the whole point: reproducible by the owner, unpredictable
  // to everyone else. Repeating across indices would reuse a blindness and make
  // two deposits of equal value share a commitment.
  const spendKey = randomScalar();
  const a = await deriveDepositBlindness(spendKey, 0);
  assert.equal(a, await deriveDepositBlindness(spendKey, 0));
  assert.notEqual(a, await deriveDepositBlindness(spendKey, 1));
  assert.notEqual(a, await deriveDepositBlindness(randomScalar(), 0));
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
