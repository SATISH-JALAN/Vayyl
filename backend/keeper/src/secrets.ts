// ============================================================
// Keeper secrets
// ============================================================
// A keeper claims a position by publishing `Poseidon2(secret, 0)` and collects
// by revealing `secret`. The commitment is what stops a watcher from copying a
// pending `reveal_and_seize` out of the mempool and front-running the bounty:
// until the reveal lands, nobody else knows the preimage.
//
// Two properties are therefore load-bearing, and both are easy to get wrong:
//
//   1. The secret must be UNPREDICTABLE. A counter, a timestamp, or anything
//      derived from the position id would let a rival compute the commitment
//      themselves and take the claim.
//
//   2. The secret must SURVIVE A RESTART. A claim is a two-transaction dance,
//      and a keeper that forgets its secret between them has permanently
//      forfeited that position's bounty -- and worse, its own escrow blocks
//      other keepers until the TTL expires. So secrets are persisted the moment
//      they are created, before the claim is submitted.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** BN254 scalar field modulus. */
const FIELD_R =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * A fresh secret, as 32-byte big-endian hex.
 *
 * Reduced into the scalar field, because the contract hashes it with Poseidon2
 * and rejects a non-canonical commitment. An unreduced 32-byte value lands above
 * the modulus roughly one time in eight, and the failure would look like a
 * flaky keeper rather than an encoding bug.
 */
export function freshSecret(): string {
  let x = 0n;
  for (const b of randomBytes(32)) x = (x << 8n) | BigInt(b);
  return (x % FIELD_R).toString(16).padStart(64, '0');
}

type Store = Record<string, string>;

export class SecretStore {
  private readonly path: string;
  private cache: Store;

  constructor(path: string) {
    this.path = path;
    this.cache = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as Store)
      : {};
  }

  get(positionId: string): string | undefined {
    return this.cache[positionId];
  }

  /**
   * Create and persist a secret for a position, or return the existing one.
   *
   * Idempotent on purpose: a keeper that crashed between `initiate` and
   * `reveal` restarts, finds its own escrow on-chain, and must reveal with the
   * SAME secret. Generating a new one here would make its own claim
   * unredeemable.
   */
  claim(positionId: string): string {
    const existing = this.cache[positionId];
    if (existing) return existing;
    const secret = freshSecret();
    this.cache[positionId] = secret;
    this.flush();
    return secret;
  }

  release(positionId: string): void {
    delete this.cache[positionId];
    this.flush();
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // 0600: this file is the difference between holding a claim and losing it.
    writeFileSync(this.path, JSON.stringify(this.cache, null, 2), { mode: 0o600 });
  }
}
