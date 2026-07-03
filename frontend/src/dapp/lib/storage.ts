// ============================================================
// Persistent shielded-note storage  (Task 6.4)
// ============================================================
// A shielded note is only spendable if we keep everything needed to rebuild its
// commitment (amount, pubX, pubY, blindness) and its nullifier (spendKey), plus
// its leaf index for Merkle-path reconstruction. Persisted per viewing key in
// IndexedDB. Field-element values are stored as decimal strings (bigint-safe).

import { get, set, del } from 'idb-keyval';

export interface ShieldedNote {
  id: string; // = commitment (decimal string), unique per note
  amount: number;
  asset: string;
  // secrets needed to spend
  commitment: string; // decimal field element
  nullifier: string; // decimal field element (precomputed for convenience)
  pubX: string;
  pubY: string;
  blindness: string;
  leafIndex: number; // position in the pool's Merkle tree
  isSpent: boolean;
  createdAt: number;
  txHash?: string;
}

const key = (viewingKey: string) => `vayyl_notes_${viewingKey}`;

export const saveNotes = async (viewingKey: string, notes: ShieldedNote[]) => {
  await set(key(viewingKey), notes);
};

export const getNotes = async (viewingKey: string): Promise<ShieldedNote[]> => {
  const notes = await get(key(viewingKey));
  return notes || [];
};

/** Append a note (dedup by commitment id). */
export const addNote = async (viewingKey: string, note: ShieldedNote) => {
  const notes = await getNotes(viewingKey);
  if (!notes.some((n) => n.id === note.id)) {
    notes.push(note);
    await saveNotes(viewingKey, notes);
  }
};

/** Mark a note spent by its commitment id. */
export const markNoteSpent = async (viewingKey: string, id: string) => {
  const notes = await getNotes(viewingKey);
  const n = notes.find((x) => x.id === id);
  if (n) {
    n.isSpent = true;
    await saveNotes(viewingKey, notes);
  }
};

/** Fill in / correct a note's leaf index once observed on-chain (via indexer). */
export const setNoteLeafIndex = async (viewingKey: string, id: string, leafIndex: number) => {
  const notes = await getNotes(viewingKey);
  const n = notes.find((x) => x.id === id);
  if (n && n.leafIndex !== leafIndex) {
    n.leafIndex = leafIndex;
    await saveNotes(viewingKey, notes);
  }
};

export const clearNotes = async (viewingKey: string) => {
  await del(key(viewingKey));
};
