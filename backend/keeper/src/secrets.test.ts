// ============================================================
// Keeper secrets
// ============================================================
// The keeper's claim is a two-transaction dance: publish Poseidon2(secret, 0),
// then reveal `secret`. Losing the secret between them forfeits the bounty AND
// leaves an escrow nobody can redeem, which blocks that position from being
// liquidated by anyone until the TTL expires. So persistence is not a
// convenience here.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SecretStore, freshSecret } from './secrets';

const FIELD_R =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let dirs: string[] = [];
const storePath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'keeper-'));
  dirs.push(dir);
  return join(dir, 'secrets.json');
};

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('freshSecret', () => {
  it('is a canonical field element', () => {
    // The contract hashes it with Poseidon2 and stores the result as a
    // commitment; a value at or above the modulus would be rejected. An
    // unreduced 32-byte value lands there about one time in eight, which would
    // look like a flaky keeper rather than an encoding bug.
    for (let i = 0; i < 50; i++) {
      const s = freshSecret();
      expect(s).toHaveLength(64);
      expect(BigInt('0x' + s)).toBeLessThan(FIELD_R);
    }
  });

  it('is unpredictable', () => {
    // A counter or a timestamp would let a rival compute the commitment and
    // take the claim, which is the exact thing the commitment exists to stop.
    const seen = new Set(Array.from({ length: 200 }, () => freshSecret()));
    expect(seen.size).toBe(200);
  });
});

describe('SecretStore', () => {
  it('returns the same secret for a position on repeated claims', () => {
    // Idempotence is what lets a keeper that crashed between initiate and
    // reveal restart and still redeem its own escrow.
    const path = storePath();
    const store = new SecretStore(path);
    const first = store.claim('pos-1');
    expect(store.claim('pos-1')).toBe(first);
  });

  it('survives a restart', () => {
    const path = storePath();
    const first = new SecretStore(path).claim('pos-1');
    expect(new SecretStore(path).get('pos-1')).toBe(first);
  });

  it('gives different positions different secrets', () => {
    const store = new SecretStore(storePath());
    expect(store.claim('pos-1')).not.toBe(store.claim('pos-2'));
  });

  it('forgets a secret once released, and issues a new one after', () => {
    const path = storePath();
    const store = new SecretStore(path);
    const first = store.claim('pos-1');
    store.release('pos-1');
    expect(store.get('pos-1')).toBeUndefined();
    expect(new SecretStore(path).get('pos-1')).toBeUndefined();
    expect(store.claim('pos-1')).not.toBe(first);
  });

  it('starts empty when there is no file yet', () => {
    expect(new SecretStore(storePath()).get('anything')).toBeUndefined();
  });

  it('keeps other positions when one is released', () => {
    const store = new SecretStore(storePath());
    const a = store.claim('pos-1');
    store.claim('pos-2');
    store.release('pos-2');
    expect(store.get('pos-1')).toBe(a);
  });
});
