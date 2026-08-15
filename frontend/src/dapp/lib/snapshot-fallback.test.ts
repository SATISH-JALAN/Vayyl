// ============================================================
// Tree-snapshot fallback — regression tests
// ============================================================
// These cover the single point of failure the snapshot exists to remove.
// Soroban RPC retains contract events for ~7 days, so once a pool's deposits
// age out, the indexer's database is the only live copy of the leaf ORDERING.
// A wallet folds that ordering into a Merkle path, so if it is lost the wallet
// submits a root the pool has never seen and the note cannot be spent. Not
// "that user's note": every note, because one missing early leaf shifts the
// index of every leaf after it.
//
// The dangerous case is deliberately NOT "the indexer errors" — that fails
// loudly. It is "the indexer returns a SHORT list": a fresh or mid-backfill
// indexer answering 200 OK with a prefix of the truth, which hashes to a
// perfectly well-formed root that is simply wrong. `rejects a TRUNCATED
// indexer response` is the test that matters.

import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';

import {
  fetchCommitmentsFrom,
  fetchSpentNullifiersFrom,
  fetchTransfersFrom,
  resetSnapshotCache,
} from './tree-source.ts';

const POOL = 'CB6XFHGN4DMVEQRESJHPOUNYLUCGMOZTAIKTWH3I7KT3NVW2XY4NIOLC';
const INDEXER = 'http://indexer.test';

const LEAVES = [
  { index: 0, commitment: 'aa'.repeat(32), source: 'deposit', tx_hash: '11'.repeat(32), ledger: 100 },
  { index: 1, commitment: 'bb'.repeat(32), source: 'deposit', tx_hash: '22'.repeat(32), ledger: 101 },
  {
    index: 2, commitment: 'cc'.repeat(32), source: 'transfer', tx_hash: '33'.repeat(32), ledger: 102,
    ephemeral_x: 'dd'.repeat(32), ephemeral_y: 'ee'.repeat(32),
  },
];

const snapshotBody = (pool: string = POOL) => ({
  pool,
  leaf_count: LEAVES.length,
  root: 'ff'.repeat(32),
  leaves: LEAVES,
  spent_nullifiers: ['09'.repeat(32)],
});

const realFetch = globalThis.fetch;
beforeEach(() => resetSnapshotCache());
afterEach(() => {
  globalThis.fetch = realFetch;
  resetSnapshotCache();
});

/** Route `/tree-snapshot.json` to the static asset, everything else to `indexer`. */
function stubFetch(opts: {
  snapshot?: unknown | 'missing';
  indexer?: (url: string) => { ok: boolean; body?: unknown } | 'throw';
}) {
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes('tree-snapshot.json')) {
      if (opts.snapshot === 'missing') return { ok: false, status: 404 } as Response;
      return { ok: true, json: async () => opts.snapshot ?? snapshotBody() } as Response;
    }
    const res = opts.indexer?.(url);
    if (!res || res === 'throw') throw new Error('connection refused');
    return { ok: res.ok, status: res.ok ? 200 : 503, json: async () => res.body } as Response;
  }) as typeof fetch;
}

test('falls back to the bundled snapshot when the indexer is unreachable', async () => {
  stubFetch({ indexer: () => 'throw' });
  const leaves = await fetchCommitmentsFrom(INDEXER, POOL);
  assert.equal(leaves.length, 3);
  assert.equal(leaves[0], BigInt('0x' + 'aa'.repeat(32)));
  assert.equal(leaves[2], BigInt('0x' + 'cc'.repeat(32)));
});

test('prefers the live indexer when it is ahead of the snapshot', async () => {
  const live = [...LEAVES.map((l) => l.commitment), '77'.repeat(32)];
  stubFetch({ indexer: () => ({ ok: true, body: { commitments: live } }) });
  const leaves = await fetchCommitmentsFrom(INDEXER, POOL);
  assert.equal(leaves.length, 4, 'a newer leaf from the indexer must not be dropped');
  assert.equal(leaves[3], BigInt('0x' + '77'.repeat(32)));
});

test('rejects a TRUNCATED indexer response in favour of the snapshot', async () => {
  // Silent corruption: 200 OK, well-formed, and short. Taking it at face value
  // yields a valid-looking root the pool never accepted, so every withdrawal
  // fails with an opaque UnknownRoot after the user has waited out a proof.
  stubFetch({ indexer: () => ({ ok: true, body: { commitments: [LEAVES[0].commitment] } }) });
  const leaves = await fetchCommitmentsFrom(INDEXER, POOL);
  assert.equal(leaves.length, 3, 'a short indexer prefix must never win over the snapshot');
});

test('ignores a snapshot belonging to a different pool', async () => {
  // A stale asset from another deployment would produce confidently wrong
  // paths, so it must be discarded rather than merged or trusted.
  stubFetch({ snapshot: snapshotBody('CBSOMEOTHERPOOL'), indexer: () => 'throw' });
  await assert.rejects(fetchCommitmentsFrom(INDEXER, POOL), /connection refused/);
});

test('propagates the indexer failure when no snapshot is bundled', async () => {
  stubFetch({ snapshot: 'missing', indexer: () => 'throw' });
  await assert.rejects(fetchCommitmentsFrom(INDEXER, POOL), /connection refused/);
});

test('recovers the transfer scan feed from the snapshot', async () => {
  // Without this feed a recipient cannot discover the note sent to them — it is
  // findable only by trial-matching these ephemeral points.
  stubFetch({ indexer: () => 'throw' });
  const rows = await fetchTransfersFrom(INDEXER, POOL);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].leafIndex, 2);
  assert.equal(rows[0].ephemeralX, 'dd'.repeat(32));
  assert.equal(rows[0].commitment, 'cc'.repeat(32));
});

test('honours the `since` cursor when scanning the snapshot', async () => {
  stubFetch({ indexer: () => 'throw' });
  assert.equal((await fetchTransfersFrom(INDEXER, POOL, 999)).length, 0);
  assert.equal((await fetchTransfersFrom(INDEXER, POOL, 102)).length, 1);
});

test('recovers spent nullifiers from the snapshot', async () => {
  stubFetch({ indexer: () => ({ ok: false }) });
  const spent = await fetchSpentNullifiersFrom(INDEXER, POOL);
  assert.equal(spent.size, 1);
  assert.ok(spent.has(BigInt('0x' + '09'.repeat(32)).toString()));
});
