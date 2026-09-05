// ============================================================
// Keeper decision policy
// ============================================================
// The previous keeper had one test, for a one-line string parser. It never
// liquidated anything, so there was no policy to test. These cover the four
// decisions it can make and the two audit findings that shape them:
//
//   H4 -- `initiate_liquidation` used to be unauthenticated and overwrote any
//         pending escrow, so a watcher could take the bounty for work another
//         keeper had started.
//   H5 -- staleness was checked only at claim time, so an owner who attested
//         health before the reveal was liquidated anyway, for doing exactly
//         what they were supposed to.

import { describe, expect, it } from 'vitest';

import { ESCROW_TTL, decide, nextCheckDelay, watchable, type EngineView } from './decide';

const SELF = 'GKEEPER_SELF_ADDRESS_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const RIVAL = 'GKEEPER_RIVAL_ADDRESS_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const NOW = 1_700_000_000;

const view = (over: Partial<EngineView> = {}): EngineView => ({
  isStale: true,
  isLiquidated: false,
  secondsUntilStale: 0,
  ...over,
});

describe('decide', () => {
  it('claims an unclaimed stale position', () => {
    expect(decide(view(), SELF, NOW)).toEqual({ kind: 'initiate' });
  });

  it('leaves a healthy position alone and says when it will be due', () => {
    const action = decide(view({ isStale: false, secondsUntilStale: 1800 }), SELF, NOW);
    expect(action.kind).toBe('skip');
    expect(action.kind === 'skip' && action.reason).toContain('1800s');
  });

  it('does nothing to an already-liquidated position', () => {
    expect(decide(view({ isLiquidated: true }), SELF, NOW).kind).toBe('skip');
  });

  it('finishes its own claim', () => {
    const v = view({ escrow: { keeper: SELF, initiatedAt: NOW - 10 } });
    expect(decide(v, SELF, NOW)).toEqual({ kind: 'reveal' });
  });

  // H4
  it('respects another keeper live claim rather than racing it', () => {
    const v = view({ escrow: { keeper: RIVAL, initiatedAt: NOW - 60 } });
    const action = decide(v, SELF, NOW);
    expect(action.kind).toBe('skip');
    expect(action.kind === 'skip' && action.reason).toContain('claimed by');
  });

  it('reports how long a rival claim has left, so the log is actionable', () => {
    const v = view({ escrow: { keeper: RIVAL, initiatedAt: NOW - 100 } });
    const action = decide(v, SELF, NOW);
    expect(action.kind === 'skip' && action.reason).toContain(`${ESCROW_TTL - 100}s`);
  });

  it('takes over an abandoned claim once it expires', () => {
    // The other side of H4: a claim that could never expire would let one
    // keeper shield a position from liquidation forever, deliberately or by
    // crashing.
    const v = view({ escrow: { keeper: RIVAL, initiatedAt: NOW - ESCROW_TTL - 1 } });
    expect(decide(v, SELF, NOW)).toEqual({ kind: 'initiate' });
  });

  it('does not take over one second early', () => {
    const v = view({ escrow: { keeper: RIVAL, initiatedAt: NOW - ESCROW_TTL + 1 } });
    expect(decide(v, SELF, NOW).kind).toBe('skip');
  });

  // H5
  it('stands down when the owner cured the position before the reveal', () => {
    // The keeper holds the claim, but the position is healthy again. Attesting
    // health is exactly what an owner is supposed to do; liquidating them for
    // it would punish the correct behaviour. The contract also refuses, so this
    // is the cheap half of a check made twice.
    const v = view({ isStale: false, secondsUntilStale: 3400, escrow: { keeper: SELF, initiatedAt: NOW - 10 } });
    expect(decide(v, SELF, NOW).kind).toBe('skip');
  });

  it('liquidation state wins over everything, including our own claim', () => {
    const v = view({ isLiquidated: true, escrow: { keeper: SELF, initiatedAt: NOW - 10 } });
    expect(decide(v, SELF, NOW).kind).toBe('skip');
  });
});

describe('nextCheckDelay', () => {
  it('waits until just after a healthy position is due', () => {
    // Polling a position with fifty minutes of grace every fifteen seconds is
    // 200 wasted RPC reads per position.
    expect(nextCheckDelay(view({ isStale: false, secondsUntilStale: 120 }))).toBe(121);
  });

  it('never polls faster than the floor', () => {
    expect(nextCheckDelay(view({ isStale: false, secondsUntilStale: 1 }), 15)).toBe(15);
    expect(nextCheckDelay(view({ isStale: true }), 15)).toBe(15);
  });

  it('never waits longer than the ceiling, so a new position is noticed', () => {
    expect(nextCheckDelay(view({ isStale: false, secondsUntilStale: 100_000 }), 15, 300)).toBe(300);
  });

  it('checks a stale position promptly', () => {
    expect(nextCheckDelay(view({ isStale: true, secondsUntilStale: 0 }))).toBe(15);
  });
});

describe('watchable', () => {
  it('drops closed positions', () => {
    const rows = [
      { position_id: 'a', owner: 'G1', tier_id: 0, is_closed: false },
      { position_id: 'b', owner: 'G1', tier_id: 0, is_closed: true },
    ];
    expect(watchable(rows).map((p) => p.position_id)).toEqual(['a']);
  });

  it('handles an empty list', () => {
    expect(watchable([])).toEqual([]);
  });
});
