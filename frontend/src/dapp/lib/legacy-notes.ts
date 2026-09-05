// ============================================================
// Dual-key note recovery (viewing key v1 -> v2)
// ============================================================
// The viewing-key derivation changed on 2026-09-05 (M4/M5): v1 hashed a lossy
// UTF-8 *decode* of the wallet signature and signed a fixed, origin-free
// message; v2 hashes the raw signature bytes over an origin- and
// network-bound message. That is a strictly better key -- and a completely
// different one.
//
// Why that is not merely cosmetic. The whole chain is deterministic:
//
//     viewingKey --(deriveShieldedKeys)--> spendKey --(BabyJubjub)--> (pubX, pubY)
//
// A note's commitment binds (pubX, pubY), and its nullifier is
// Poseidon2(commitment, spendKey). So a note shielded under v1 can ONLY be
// opened by the v1 spend key. Deriving v2 and calling it "the wallet" does not
// migrate those notes, it hides them: the balance reads zero while the funds
// sit in the pool, permanently.
//
// Re-shielding is not an escape hatch either -- spending the note in order to
// move it is exactly the operation that needs the v1 key.
//
// So the fix has to be dual-key: keep both keys, tag each note with the key
// version that owns it, and pick the right spend key per note at proving time.
// `keyVersion === undefined` means v2, because every note written before this
// module existed was written by the current code path.
//
// This module holds the pure half so it is testable under `node --test`:
// no idb-keyval, no wallet SDK. `storage.ts` owns the IndexedDB side and
// `pool.ts` the proving side.

import { deriveShieldedKeys, type ShieldedKeys } from './keys';
import type { ShieldedNote } from './storage';

/** The key version notes are written under today. Mirrors VIEWING_KEY_VERSION. */
export const CURRENT_KEY_VERSION = 2;

/**
 * Which viewing key opens this note.
 *
 * Untagged notes are v2: the tag was introduced alongside v2, so anything
 * written before it came from the current derivation. Only a note carrying an
 * explicit `legacyViewingKey` is treated as foreign.
 */
export function noteKeyVersion(note: ShieldedNote): number {
  return note.keyVersion ?? CURRENT_KEY_VERSION;
}

export function isLegacyNote(note: ShieldedNote): boolean {
  return noteKeyVersion(note) < CURRENT_KEY_VERSION;
}

/**
 * Stamp recovered notes with the key that owns them.
 *
 * The legacy viewing key travels *with the note* rather than in a single
 * wallet-level field because the two sets coexist indefinitely: a wallet can
 * hold v1 and v2 notes at once, and nothing forces the user to drain the old
 * ones first. Storing it per-note is what lets `keysForNote` stay a pure
 * lookup instead of a guess.
 *
 * Already-tagged notes are returned untouched, so re-running recovery is
 * idempotent and cannot re-point a note at the wrong key.
 */
export function tagLegacyNotes(
  notes: ShieldedNote[],
  legacyViewingKey: string,
  keyVersion = 1,
): ShieldedNote[] {
  return notes.map((note) =>
    note.legacyViewingKey ? note : { ...note, keyVersion, legacyViewingKey },
  );
}

/**
 * Merge recovered notes into the live set, keeping the existing record on a
 * collision.
 *
 * Existing-wins is deliberate. The live record is the one whose `isSpent` and
 * `leafIndex` have been maintained by the running app; the recovered copy is a
 * snapshot from another store. Letting the snapshot win could resurrect a note
 * already spent, and the user would then generate a proof for a nullifier the
 * pool has already seen -- a guaranteed on-chain failure that looks like a
 * wallet bug.
 */
export function mergeNotes(
  current: ShieldedNote[],
  incoming: ShieldedNote[],
): { notes: ShieldedNote[]; added: number } {
  const byId = new Map(current.map((n) => [n.id, n]));
  let added = 0;
  for (const note of incoming) {
    if (byId.has(note.id)) continue;
    byId.set(note.id, note);
    added++;
  }
  return { notes: Array.from(byId.values()), added };
}

/**
 * The shielded keys that can actually spend `note`.
 *
 * Returns the wallet's current keys for ordinary notes, and re-derives the
 * legacy identity for a recovered one. Derivation is memoised per viewing key:
 * it is a Poseidon2 hash plus a BabyJubjub scalar multiplication, and a
 * multi-note spend would otherwise repeat it for every input.
 */
const legacyKeyCache = new Map<string, Promise<ShieldedKeys>>();

export async function keysForNote(
  note: ShieldedNote,
  currentKeys: ShieldedKeys,
): Promise<ShieldedKeys> {
  const legacy = note.legacyViewingKey;
  if (!legacy || legacy === currentKeys.viewingKey) return currentKeys;

  let pending = legacyKeyCache.get(legacy);
  if (!pending) {
    pending = deriveShieldedKeys(legacy);
    legacyKeyCache.set(legacy, pending);
  }
  return pending;
}

/**
 * True when every note in `selection` is spendable with ONE key.
 *
 * The V3 transfer circuit takes a single `privKey` for both inputs, so a spend
 * mixing a v1 note with a v2 note is unprovable. The witness would be built
 * from one key and the other note's nullifier would not match -- and because
 * the failure surfaces as a witness-generation error deep inside snarkjs, the
 * user would see a stack trace rather than "these notes cannot be combined".
 * Callers check this first and say so plainly.
 */
export function shareOneKey(selection: ShieldedNote[]): boolean {
  if (selection.length < 2) return true;
  const first = selection[0].legacyViewingKey ?? '';
  return selection.every((n) => (n.legacyViewingKey ?? '') === first);
}
