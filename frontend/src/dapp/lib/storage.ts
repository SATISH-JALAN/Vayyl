// ============================================================
// Persistent shielded-note storage  (Task 6.4)
// ============================================================
// A shielded note is only spendable if we keep everything needed to rebuild its
// commitment (amount, pubX, pubY, blindness) and its nullifier (spendKey), plus
// its leaf index for Merkle-path reconstruction. Persisted per viewing key in
// IndexedDB. Field-element values are stored as decimal strings (bigint-safe).

import { get, set } from 'idb-keyval';
import { V2_DENOMINATION_STROOPS, V2_DENOMINATION_XLM } from './denomination';

export interface ShieldedNote {
  id: string; // = commitment (decimal string), unique per note
  amount: number;
  amountStroops?: string; // exact contract amount; optional only for legacy local notes
  asset: string;
  protocol?: 'v1' | 'v2';
  pool?: string;
  // secrets needed to spend
  commitment: string; // decimal field element
  nullifier: string; // decimal field element (precomputed for convenience)
  pubX: string;
  pubY: string;
  blindness: string;
  leafIndex: number; // position in the pool's Merkle tree
  isSpent: boolean;
  /**
   * How this note entered the wallet. Absent on notes written before shielded
   * transfer existed, which were all deposits — treat undefined as 'deposit'.
   * Without this the activity feed labels received payments as deposits.
   */
  source?: 'deposit' | 'received';
  /** Sender's one-time point R, kept for provenance on received notes. */
  ephemeralX?: string;
  ephemeralY?: string;
  createdAt: number;
  txHash?: string;
}

const key = (viewingKey: string) => `vayyl_notes_${viewingKey}`;

// ---- activity log ----------------------------------------------------------
// Deposits are recoverable from notes, but a spend only flips `isSpent` — the
// withdraw's tx hash and time are otherwise lost. Record non-deposit events
// (withdraw / transfer) here so the dashboard can show real recent activity.

// 'RageQuit' is kept distinct from 'Withdraw' on purpose. A rage-quit publishes
// the commitment, so it permanently links that deposit to the payout address on
// the ledger. Folding it into "Withdraw" in the history would hide from the user
// which of their exits was the private one and which was not.
export type ActivityType = 'Deposit' | 'Withdraw' | 'Transfer' | 'RageQuit';

export interface ActivityEvent {
  id: string; // tx hash (or a unique fallback)
  type: ActivityType;
  amount: number;
  asset: string;
  protocol?: 'v1' | 'v2';
  pool?: string;
  txHash?: string;
  timestamp: number; // ms epoch
}

const activityKey = (viewingKey: string) => `vayyl_activity_${viewingKey}`;
const scanCursorKey = (viewingKey: string) => `vayyl_scan_cursor_${viewingKey}`;

/**
 * Highest ledger already examined for incoming payments. Scanning is a trial
 * decryption per transfer, so without a cursor every refresh would re-scan the
 * whole history and get slower forever.
 */
export const getScanCursor = async (viewingKey: string): Promise<number> => {
  const cursor = await get(scanCursorKey(viewingKey));
  return typeof cursor === 'number' ? cursor : 0;
};

export const setScanCursor = async (viewingKey: string, ledger: number): Promise<void> => {
  await set(scanCursorKey(viewingKey), ledger);
};

export const getActivity = async (viewingKey: string): Promise<ActivityEvent[]> => {
  const events = await get(activityKey(viewingKey));
  return events || [];
};

export const addActivity = async (viewingKey: string, event: ActivityEvent) => {
  const events = await getActivity(viewingKey);
  events.push(event);
  await set(activityKey(viewingKey), events);
};

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

export const clearV2Notes = async (viewingKey: string) => {
  await set(key(viewingKey), (await getNotes(viewingKey)).filter((note) => note.protocol !== 'v2'));
  await set(activityKey(viewingKey), (await getActivity(viewingKey)).filter((event) => event.protocol !== 'v2'));
};

const backupKey = async (viewingKey: string) => {
  const raw = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`vayyl-v2-backup:${viewingKey}`),
  );
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
};

const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

export async function exportV2Backup(viewingKey: string): Promise<string> {
  const payload = JSON.stringify({
    notes: (await getNotes(viewingKey)).filter((note) => note.protocol === 'v2'),
    activity: (await getActivity(viewingKey)).filter((event) => event.protocol === 'v2'),
  });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await backupKey(viewingKey),
    new TextEncoder().encode(payload),
  );
  return JSON.stringify({ version: 2, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) });
}

export async function importV2Backup(viewingKey: string, backup: string): Promise<number> {
  const envelope = JSON.parse(backup) as { version?: number; iv?: string; ciphertext?: string };
  if (envelope.version !== 2 || !envelope.iv || !envelope.ciphertext) {
    throw new Error('This is not a Vayyl note backup.');
  }
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(envelope.iv) },
    await backupKey(viewingKey),
    fromBase64(envelope.ciphertext),
  );
  const payload = JSON.parse(new TextDecoder().decode(decrypted)) as {
    notes?: ShieldedNote[];
    activity?: ActivityEvent[];
  };
  // `amountStroops` is the value the contract actually moves; validating only
  // the display `amount` left the load-bearing field unchecked. Both are pinned
  // to the pool denomination rather than a literal, so a future denomination
  // change cannot leave a stale constant behind here.
  const expectedStroops = V2_DENOMINATION_STROOPS.toString();
  if (!Array.isArray(payload.notes) || !payload.notes.every((note) =>
    note?.protocol === 'v2' && note.asset === 'XLM' && note.amount === V2_DENOMINATION_XLM &&
    (note.amountStroops === undefined || note.amountStroops === expectedStroops) &&
    typeof note.id === 'string' && /^\d+$/.test(note.commitment) && /^\d+$/.test(note.nullifier) &&
    /^\d+$/.test(note.blindness) && typeof note.pool === 'string' && Number.isInteger(note.leafIndex) &&
    (note.source === undefined || note.source === 'deposit' || note.source === 'received') &&
    (note.ephemeralX === undefined || /^\d+$/.test(note.ephemeralX)) &&
    (note.ephemeralY === undefined || /^\d+$/.test(note.ephemeralY))
  )) {
    throw new Error('The backup contains invalid note data.');
  }

  const existingNotes = await getNotes(viewingKey);
  const mergedNotes = new Map(existingNotes.map((note) => [note.id, note]));
  for (const note of payload.notes) mergedNotes.set(note.id, note);
  await saveNotes(viewingKey, [...mergedNotes.values()]);

  const existingActivity = await getActivity(viewingKey);
  const mergedActivity = new Map(existingActivity.map((event) => [event.id, event]));
  for (const event of payload.activity ?? []) {
    if (event?.protocol === 'v2' && typeof event.id === 'string') mergedActivity.set(event.id, event);
  }
  await set(activityKey(viewingKey), [...mergedActivity.values()]);
  return payload.notes.length;
}
