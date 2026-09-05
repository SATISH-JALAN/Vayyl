// ============================================================
// Dual-key note recovery: the v1 -> v2 viewing-key migration
// ============================================================
// The property under test is not "the merge function works". It is that a note
// shielded under the OLD viewing key is still spendable after the derivation
// changed. Get this wrong and the wallet shows a zero balance while the funds
// sit in the pool forever, which is indistinguishable from having lost them.

import '../../../test/public-fetch-shim.ts';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENT_KEY_VERSION,
  isLegacyNote,
  keysForNote,
  mergeNotes,
  noteKeyVersion,
  shareOneKey,
  tagLegacyNotes,
} from './legacy-notes.ts';
import { deriveShieldedKeys } from './keys.ts';
import type { ShieldedNote } from './storage.ts';

const note = (id: string, over: Partial<ShieldedNote> = {}): ShieldedNote =>
  ({
    id,
    amount: 1,
    asset: 'XLM',
    commitment: id,
    nullifier: '0',
    pubX: '1',
    pubY: '2',
    blindness: '3',
    leafIndex: 0,
    isSpent: false,
    createdAt: 0,
    ...over,
  }) as ShieldedNote;

const V1_KEY = 'aa'.repeat(32);
const V2_KEY = 'bb'.repeat(32);

// ---------------------------------------------------------------------------
// The reason the whole mechanism has to exist
// ---------------------------------------------------------------------------

test('a different viewing key really does yield a different spend key and note pubkey', async () => {
  // This is the fact the migration is built around. If these ever coincided,
  // recovery would be unnecessary; because they do not, a v1 note is opaque to
  // the v2 identity and vice versa.
  const v1 = await deriveShieldedKeys(V1_KEY);
  const v2 = await deriveShieldedKeys(V2_KEY);

  assert.notEqual(v1.spendKey, v2.spendKey, 'spend keys must differ');
  assert.notEqual(v1.pubX, v2.pubX, 'note public keys must differ');
  // ...so the commitment (which binds pubX/pubY) and the nullifier (which binds
  // spendKey) are BOTH unreachable from the wrong key.
});

// ---------------------------------------------------------------------------
// Tagging
// ---------------------------------------------------------------------------

test('an untagged note is treated as current, not as legacy', () => {
  // Every note written before the tag existed came from the current derivation.
  // Defaulting the other way would send live notes down the recovery path and
  // derive the wrong spend key for them.
  const n = note('1');
  assert.equal(noteKeyVersion(n), CURRENT_KEY_VERSION);
  assert.equal(isLegacyNote(n), false);
});

test('tagging attaches the key that actually opens the note', () => {
  const [tagged] = tagLegacyNotes([note('1')], V1_KEY);
  assert.equal(tagged.legacyViewingKey, V1_KEY);
  assert.equal(tagged.keyVersion, 1);
  assert.equal(isLegacyNote(tagged), true);
});

test('tagging is idempotent and never re-points an already-tagged note', () => {
  // Recovery is a button a user can press twice. The second press must not
  // rewrite the key on a note recovered from a different source.
  const already = note('1', { keyVersion: 1, legacyViewingKey: 'cc'.repeat(32) });
  const [out] = tagLegacyNotes([already], V1_KEY);
  assert.equal(out.legacyViewingKey, 'cc'.repeat(32), 'the original key must survive');
});

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

test('merging adopts new notes and reports how many', () => {
  const { notes, added } = mergeNotes([note('a')], [note('b'), note('c')]);
  assert.equal(added, 2);
  assert.deepEqual(notes.map((n) => n.id).sort(), ['a', 'b', 'c']);
});

test('a spent note is NOT resurrected by a stale recovered copy', () => {
  // The dangerous case. The live record knows the note was spent; the recovered
  // snapshot does not. Preferring the snapshot would hand the user a note whose
  // nullifier the pool has already seen — a proof that always fails on-chain.
  const live = note('a', { isSpent: true });
  const stale = note('a', { isSpent: false });
  const { notes, added } = mergeNotes([live], [stale]);
  assert.equal(added, 0);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].isSpent, true, 'the live record wins');
});

test('re-running recovery adopts nothing the second time', () => {
  const recovered = tagLegacyNotes([note('a')], V1_KEY);
  const first = mergeNotes([], recovered);
  const second = mergeNotes(first.notes, recovered);
  assert.equal(first.added, 1);
  assert.equal(second.added, 0);
});

// ---------------------------------------------------------------------------
// Key selection at proving time
// ---------------------------------------------------------------------------

test('a current note proves with the wallet key; a legacy note does not', async () => {
  const current = await deriveShieldedKeys(V2_KEY);
  const legacyIdentity = await deriveShieldedKeys(V1_KEY);

  const plain = await keysForNote(note('a'), current);
  assert.equal(plain.spendKey, current.spendKey, 'ordinary notes are untouched');

  const [tagged] = tagLegacyNotes([note('b')], V1_KEY);
  const resolved = await keysForNote(tagged, current);
  assert.equal(resolved.spendKey, legacyIdentity.spendKey, 'legacy notes get the v1 key');
  assert.notEqual(resolved.spendKey, current.spendKey);
});

test('a note tagged with the CURRENT key resolves to the current keys', async () => {
  // Defensive: after a full drain-and-reshield the tag may name the key already
  // in use. Re-deriving would be wasted work and a second source of truth.
  const current = await deriveShieldedKeys(V2_KEY);
  const n = note('a', { keyVersion: 1, legacyViewingKey: V2_KEY });
  assert.equal((await keysForNote(n, current)).spendKey, current.spendKey);
});

// ---------------------------------------------------------------------------
// The 2-input transfer constraint
// ---------------------------------------------------------------------------

test('mixing a legacy note with a current one in one transfer is refused', () => {
  // transfer_v3 takes a single privKey for both inputs, so such a spend is
  // simply unprovable. Catching it here is the difference between a sentence
  // the user can act on and a snarkjs witness error.
  const [legacy] = tagLegacyNotes([note('a')], V1_KEY);
  assert.equal(shareOneKey([legacy, note('b')]), false);
});

test('two notes under the same key, and any single note, are fine', () => {
  const pair = tagLegacyNotes([note('a'), note('b')], V1_KEY);
  assert.equal(shareOneKey(pair), true);
  assert.equal(shareOneKey([note('a'), note('b')]), true, 'two current notes');
  assert.equal(shareOneKey([pair[0]]), true, 'a single note is always fine');
  assert.equal(shareOneKey([]), true);
});
