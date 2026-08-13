// Regression tests for the getEvents pagination loop.
//
// The bug these exist to prevent: getEvents scans a bounded ledger window per
// call and returns an EMPTY page *with a cursor* whenever that window holds no
// matching event. The old loop treated any short page as "caught up", stopped,
// and then persisted the network head as the resume point — so every event
// after the first empty page was skipped and never looked at again. Backfilling
// the live pool needed 14 pages, 13 of them empty, so this silently dropped
// almost the entire commitment history. A missing early leaf shifts every later
// leaf index and breaks Merkle-path reconstruction for ALL users, so this is a
// fund-loss-class defect, not a lag bug.
//
// No network: a stub server is injected over the real rpc.Server.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { xdr, nativeToScVal } from '@stellar/stellar-sdk';
import { Poller } from './poller.js';

const POOL = 'CB6XFHGN4DMVEQRESJHPOUNYLUCGMOZTAIKTWH3I7KT3NVW2XY4NIOLC';

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const bytesN = (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex, 'hex'));
const mapEntry = (k: string, v: xdr.ScVal) =>
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });

/** RPC cursors are "<10-digit ledger>-<10-digit index>"; only the ledger is read. */
const cursorAt = (ledger: number) => `${String(ledger).padStart(10, '0')}-0000000001`;

function depositEvent(ledger: number, leafIndex: number, commitment: string) {
  return {
    topic: [sym('deposit'), bytesN(commitment)],
    value: xdr.ScVal.scvMap([
      mapEntry('leaf_index', nativeToScVal(leafIndex, { type: 'u32' })),
      mapEntry('amount', nativeToScVal(10_000_000n, { type: 'i128' })),
    ]),
    ledger,
    txHash: `tx${leafIndex}`,
    id: `${ledger}-${leafIndex}`,
  };
}

/** Captures only what pollOnce actually touches. */
function makeDb() {
  return {
    commitments: [] as { commitment: string; leafIndex: number }[],
    resumePoints: [] as number[],
    async setLastLedger(_pool: string, ledger: number) {
      this.resumePoints.push(ledger);
    },
    async insertCommitment(_pool: string, commitment: string, leafIndex: number) {
      this.commitments.push({ commitment, leafIndex });
    },
    async insertNullifier() {},
  };
}

/** Replays a fixed script of pages; an Error entry is thrown when reached. */
function makeServer(pages: unknown[]) {
  return {
    requests: [] as any[],
    async getEvents(req: any) {
      this.requests.push(req);
      const page = pages[this.requests.length - 1];
      if (page instanceof Error) throw page;
      if (!page) throw new Error('stub server ran out of scripted pages');
      return page;
    },
  };
}

function pollerWith(server: unknown, db: unknown) {
  const poller = new Poller('http://localhost:8000', db as any, POOL);
  (poller as any).server = server;
  return poller;
}

describe('Poller.pollOnce pagination', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps paginating through empty pages that carry a cursor', async () => {
    const db = makeDb();
    const server = makeServer([
      { events: [], cursor: cursorAt(1100), latestLedger: 2000 },
      { events: [], cursor: cursorAt(1200), latestLedger: 2000 },
      { events: [], cursor: cursorAt(1300), latestLedger: 2000 },
      { events: [], cursor: undefined, latestLedger: 2000 },
    ]);

    await pollerWith(server, db).pollOnce(1000);

    // The old loop stopped after the first short page.
    expect(server.requests).toHaveLength(4);
  });

  it('processes an event that only appears after a run of empty pages', async () => {
    const db = makeDb();
    const commitment = 'ab'.repeat(32);
    const server = makeServer([
      { events: [], cursor: cursorAt(1100), latestLedger: 2000 },
      { events: [], cursor: cursorAt(1200), latestLedger: 2000 },
      { events: [depositEvent(1500, 3, commitment)], cursor: cursorAt(1500), latestLedger: 2000 },
      { events: [], cursor: undefined, latestLedger: 2000 },
    ]);

    await pollerWith(server, db).pollOnce(1000);

    // This is the whole defect: the old loop returned before reaching page 3
    // and persisted the head, so this deposit was skipped permanently.
    expect(db.commitments).toEqual([{ commitment, leafIndex: 3 }]);
  });

  it('only sends startLedger on the first request, then follows the cursor', async () => {
    const db = makeDb();
    const server = makeServer([
      { events: [], cursor: cursorAt(1100), latestLedger: 2000 },
      { events: [], cursor: undefined, latestLedger: 2000 },
    ]);

    await pollerWith(server, db).pollOnce(1000);

    expect(server.requests[0].startLedger).toBe(1000);
    expect(server.requests[0].cursor).toBeUndefined();
    expect(server.requests[1].cursor).toBe(cursorAt(1100));
    expect(server.requests[1].startLedger).toBeUndefined();
  });

  it('resumes from how far it actually scanned when it hits the per-tick page cap', async () => {
    const db = makeDb();
    // 400 pages is MAX_PAGES_PER_TICK; every one carries a cursor, so the loop
    // exits on the cap rather than on cursor exhaustion.
    const pages = Array.from({ length: 400 }, (_, i) => ({
      events: [],
      cursor: cursorAt(1000 + (i + 1) * 10),
      latestLedger: 9_000_000,
    }));
    const server = makeServer(pages);

    const next = await pollerWith(server, db).pollOnce(1000);

    // Must resume just past the last ledger the cursor reached (5000), NOT jump
    // to the network head, which would skip everything in between.
    expect(next).toBe(5001);
    expect(db.resumePoints).toEqual([5001]);
    expect(next).toBeLessThan(9_000_000);
  });

  it('advances past a stale start ledger that has aged out of RPC retention', async () => {
    const db = makeDb();
    const server = makeServer([
      new Error('start is before oldest ledger range: 5000 - 9000'),
      { events: [], cursor: undefined, latestLedger: 9000 },
    ]);

    const next = await pollerWith(server, db).pollOnce(1000);

    // Clamped to floor + 1 and retried rather than wedging on an unsatisfiable
    // request forever.
    expect(server.requests[1].startLedger).toBe(5001);
    expect(next).toBe(9000);
  });

  it('rethrows errors that are not a retention-range rejection', async () => {
    const db = makeDb();
    const server = makeServer([new Error('connection refused')]);

    await expect(pollerWith(server, db).pollOnce(1000)).rejects.toThrow('connection refused');
  });
});
