// ============================================================
// Small display formatters
// ============================================================
// Shared rather than copied. These were duplicated in ActivityFeed and were
// about to be duplicated again on the payments ledger, which is how two views
// of the same event end up disagreeing about how old it is.

/** "just now" / "45s ago" / "12m ago" / "3h ago" / "2d ago". */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 60) return seconds <= 1 ? 'just now' : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Head and tail of a long hex or field value.
 *
 * Both ends, never just the head: commitments and nullifiers routinely share a
 * prefix, so a head-only abbreviation can show two different notes as the same
 * string.
 */
export function shortHash(value: string, head = 8, tail = 6): string {
  return value.length <= head + tail + 3 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export const EXPLORER_TX = 'https://stellar.expert/explorer/testnet/tx';
