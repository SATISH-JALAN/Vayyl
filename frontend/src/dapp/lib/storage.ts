// ============================================================
// Persistent shielded-note storage  (Task 6.4)
// ============================================================
// A shielded note is only spendable if we keep everything needed to rebuild its
// commitment (amount, pubX, pubY, blindness) and its nullifier (spendKey), plus
// its leaf index for Merkle-path reconstruction. Persisted per viewing key in
// IndexedDB. Field-element values are stored as decimal strings (bigint-safe).

import { get, set, del } from 'idb-keyval';
import { seal, open, isSealed, scopedStorageKey } from './note-crypto';
import { V2_DENOMINATION_STROOPS, V2_DENOMINATION_XLM } from './denomination';

export interface ShieldedNote {
  id: string; // = commitment (decimal string), unique per note
  amount: number;
  amountStroops?: string; // exact contract amount; optional only for legacy local notes
  asset: string;
  protocol?: 'v1' | 'v2' | 'v3';
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
  // 'change' is distinct from 'received' on purpose: change is money coming
  // back from your own spend, not a payment someone made to you, and folding
  // the two together would make the activity feed misreport what happened.
  source?: 'deposit' | 'received' | 'change';
  /**
   * Which deposit of this wallet this was. Deposit blindness is derived from
   * (spendKey, depositIndex) rather than drawn at random, so a clean device can
   * re-derive it; keeping the index makes the sequence explicit and lets the
   * next deposit continue it without colliding.
   */
  depositIndex?: number;
  /** Sender's one-time point R, kept for provenance on received notes. */
  ephemeralX?: string;
  ephemeralY?: string;
  createdAt: number;
  txHash?: string;
}


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
  protocol?: 'v1' | 'v2' | 'v3';
  pool?: string;
  txHash?: string;
  timestamp: number; // ms epoch
}

// ---- at-rest encryption ----------------------------------------------------
// Notes are bearer instruments: reading one is enough to spend it. Everything
// below goes through `seal`/`open` (see note-crypto.ts), and the IndexedDB key
// NAMES are hashed rather than carrying the viewing key in the clear.
//
// The legacy names are kept only so existing wallets can be migrated. Reading
// one is a one-time event: the record is immediately re-written sealed under
// the new name and the plaintext deleted. Dropping the fallback instead would
// destroy the notes of anyone who had used the app before this change, which
// for a bearer instrument means destroying their money.

const legacyNotesKey = (viewingKey: string) => `vayyl_notes_${viewingKey}`;
const legacyActivityKey = (viewingKey: string) => `vayyl_activity_${viewingKey}`;
const legacyCursorKey = (viewingKey: string) => `vayyl_scan_cursor_${viewingKey}`;

/**
 * Read one record, transparently migrating a legacy plaintext entry.
 *
 * A failed `open` propagates rather than falling back to the default. GCM
 * authenticates, so a failure means a wrong key or a tampered store, and
 * reporting that as "no notes" would show an empty wallet to someone whose
 * funds are still perfectly real.
 */
async function readSealed<T>(
  viewingKey: string,
  kind: string,
  legacyKey: string,
  fallback: T,
): Promise<T> {
  const name = await scopedStorageKey(viewingKey, kind);
  const current = await get(name);
  if (isSealed(current)) return open<T>(viewingKey, current);

  const legacy = await get(legacyKey);
  if (legacy === undefined) return fallback;

  // Found plaintext from before this change: seal it, then remove the original.
  await set(name, await seal(viewingKey, legacy));
  await del(legacyKey);
  return legacy as T;
}

async function writeSealed(viewingKey: string, kind: string, value: unknown): Promise<void> {
  await set(await scopedStorageKey(viewingKey, kind), await seal(viewingKey, value));
}

/**
 * Highest ledger already examined for incoming payments. Scanning is a trial
 * decryption per transfer, so without a cursor every refresh would re-scan the
 * whole history and get slower forever.
 */
export const getScanCursor = async (viewingKey: string): Promise<number> => {
  const cursor = await readSealed<number>(viewingKey, 'cursor', legacyCursorKey(viewingKey), 0);
  return typeof cursor === 'number' ? cursor : 0;
};

export const setScanCursor = async (viewingKey: string, ledger: number): Promise<void> => {
  await writeSealed(viewingKey, 'cursor', ledger);
};

export const getActivity = async (viewingKey: string): Promise<ActivityEvent[]> =>
  readSealed<ActivityEvent[]>(viewingKey, 'activity', legacyActivityKey(viewingKey), []);

export const addActivity = async (viewingKey: string, event: ActivityEvent) => {
  const events = await getActivity(viewingKey);
  events.push(event);
  await writeSealed(viewingKey, 'activity', events);
};

export const saveNotes = async (viewingKey: string, notes: ShieldedNote[]) => {
  await writeSealed(viewingKey, 'notes', notes);
};

export const getNotes = async (viewingKey: string): Promise<ShieldedNote[]> =>
  readSealed<ShieldedNote[]>(viewingKey, 'notes', legacyNotesKey(viewingKey), []);

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
  await writeSealed(viewingKey, 'notes',
    (await getNotes(viewingKey)).filter((note) => note.protocol !== 'v2'));
  await writeSealed(viewingKey, 'activity',
    (await getActivity(viewingKey)).filter((event) => event.protocol !== 'v2'));
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
    notes: (await getNotes(viewingKey)).filter(
      (note) => note.protocol === 'v2' || note.protocol === 'v3'),
    activity: (await getActivity(viewingKey)).filter(
      (event) => event.protocol === 'v2' || event.protocol === 'v3'),
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
  // `amountStroops` is the value the contract actually moves, so it is the field
  // that must be checked; validating only the display `amount` would leave the
  // load-bearing one unchecked.
  //
  // V2 notes are pinned to the pool denomination. V3 notes are not, and cannot
  // be: arbitrary amounts are the entire point, so the check is that the value
  // is a positive integer inside the 64-bit range the circuits enforce. A note
  // outside that range is one no proof could ever open.
  const expectedStroops = V2_DENOMINATION_STROOPS.toString();
  const amountValid = (note: ShieldedNote) => {
    if (note.protocol === 'v2') {
      return note.amount === V2_DENOMINATION_XLM &&
        (note.amountStroops === undefined || note.amountStroops === expectedStroops);
    }
    if (typeof note.amountStroops !== 'string' || !/^\d+$/.test(note.amountStroops)) return false;
    const stroops = BigInt(note.amountStroops);
    return stroops >= 0n && stroops < 1n << 64n;
  };
  if (!Array.isArray(payload.notes) || !payload.notes.every((note) =>
    (note?.protocol === 'v2' || note?.protocol === 'v3') && note.asset === 'XLM' &&
    amountValid(note) &&
    typeof note.id === 'string' && /^\d+$/.test(note.commitment) && /^\d+$/.test(note.nullifier) &&
    /^\d+$/.test(note.blindness) && typeof note.pool === 'string' && Number.isInteger(note.leafIndex) &&
    (note.source === undefined || note.source === 'deposit' ||
      note.source === 'received' || note.source === 'change') &&
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
    if ((event?.protocol === 'v2' || event?.protocol === 'v3') && typeof event.id === 'string') {
      mergedActivity.set(event.id, event);
    }
  }
  await writeSealed(viewingKey, 'activity', [...mergedActivity.values()]);
  return payload.notes.length;
}
