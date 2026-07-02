import { get, set, del } from 'idb-keyval';

export interface ShieldedNote {
  id: string;
  amount: number;
  asset: string;
  commitment: string;
  isSpent: boolean;
  createdAt: number;
}

// Prefix with viewingKey to isolate notes per user
export const saveNotes = async (viewingKey: string, notes: ShieldedNote[]) => {
  await set(`vayyl_notes_${viewingKey}`, notes);
};

export const getNotes = async (viewingKey: string): Promise<ShieldedNote[]> => {
  const notes = await get(`vayyl_notes_${viewingKey}`);
  return notes || [];
};

export const clearNotes = async (viewingKey: string) => {
  await del(`vayyl_notes_${viewingKey}`);
};
