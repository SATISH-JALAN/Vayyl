// ============================================================
// At-rest encryption tests
// ============================================================
// Shielded notes are bearer instruments, so "encrypted at rest" has to mean the
// plaintext is genuinely unreadable from storage, not merely that an encrypt
// function exists somewhere. These assert the properties an inspector of the
// IndexedDB contents would actually check.

import assert from 'node:assert/strict';
import test from 'node:test';

import { seal, open, isSealed, scopedStorageKey } from './note-crypto.ts';

const VIEWING_KEY = '0xdeadbeefcafe1234567890abcdef';
const NOTE = {
  id: 'abc',
  commitment: '12345678901234567890',
  blindness: '99887766554433221100',
  amountStroops: '370000000',
  nullifier: '55554444333322221111',
};

test('the sealed record contains no plaintext of what it protects', async () => {
  const sealed = await seal(VIEWING_KEY, [NOTE]);
  const serialised = JSON.stringify(sealed);

  // The exact check an inspector would run against IndexedDB.
  for (const secret of [NOTE.commitment, NOTE.blindness, NOTE.nullifier, NOTE.amountStroops]) {
    assert.ok(!serialised.includes(secret), `sealed record leaks ${secret}`);
  }
  assert.ok(!serialised.includes(VIEWING_KEY), 'sealed record leaks the viewing key');
});

test('round-trips exactly', async () => {
  const notes = [NOTE, { ...NOTE, id: 'def', amountStroops: '630000000' }];
  const recovered = await open<typeof notes>(VIEWING_KEY, await seal(VIEWING_KEY, notes));
  assert.deepEqual(recovered, notes);
});

test('a different viewing key cannot open the record', async () => {
  const sealed = await seal(VIEWING_KEY, [NOTE]);
  await assert.rejects(open('0xsomeoneelse', sealed));
});

test('tampered ciphertext is rejected, not silently mangled', async () => {
  // AES-GCM authenticates. Returning garbage, or an empty array, would make a
  // corrupted store look like an empty wallet — the worst possible answer.
  const sealed = await seal(VIEWING_KEY, [NOTE]);
  const flipped = { ...sealed, ct: `${sealed.ct.slice(0, -4)}AAAA` };
  await assert.rejects(open(VIEWING_KEY, flipped));
});

test('each write uses a fresh IV', async () => {
  // Reusing an IV under one long-lived key is catastrophic for AES-GCM, and the
  // key here is derived from the wallet so it never rotates.
  const a = await seal(VIEWING_KEY, [NOTE]);
  const b = await seal(VIEWING_KEY, [NOTE]);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct, 'identical plaintext must not produce identical ciphertext');
});

test('storage key names do not contain the viewing key', async () => {
  // The store previously used `vayyl_notes_<viewingKey>` as the IndexedDB key,
  // printing the secret next to the ciphertext it protects. Encrypting values
  // while publishing the key alongside them protects nothing.
  const name = await scopedStorageKey(VIEWING_KEY, 'notes');
  assert.ok(!name.includes(VIEWING_KEY), 'storage key name leaks the viewing key');
  assert.match(name, /^vayyl_notes_[0-9a-f]{32}$/);
});

test('storage key names are stable, and distinct per wallet and per kind', async () => {
  const a = await scopedStorageKey(VIEWING_KEY, 'notes');
  assert.equal(a, await scopedStorageKey(VIEWING_KEY, 'notes'), 'must be deterministic');
  assert.notEqual(a, await scopedStorageKey(VIEWING_KEY, 'activity'), 'kinds must not collide');
  assert.notEqual(a, await scopedStorageKey('0xother', 'notes'), 'wallets must not collide');
});

test('isSealed distinguishes a sealed record from a legacy plaintext array', async () => {
  // Drives the migration path: a legacy entry is a bare array and must be
  // recognised so it can be read once and re-written encrypted, rather than
  // being treated as corrupt and discarded.
  assert.ok(isSealed(await seal(VIEWING_KEY, [NOTE])));
  assert.ok(!isSealed([NOTE]));
  assert.ok(!isSealed(undefined));
  assert.ok(!isSealed({ v: 2, iv: 'x', ct: 'y' }));
});

test('handles an empty collection', async () => {
  assert.deepEqual(await open(VIEWING_KEY, await seal(VIEWING_KEY, [])), []);
});
