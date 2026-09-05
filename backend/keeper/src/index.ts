// ============================================================
// Vayyl liquidation keeper
// ============================================================
// Watches open positions and liquidates the ones whose owners have stopped
// attesting solvency.
//
// This is a rewrite. The previous keeper shelled out to `stellar contract
// invoke ... is_stale` once per position per tick and, on finding a stale one,
// wrote a JSON flag file for an e2e script to notice. It never submitted a
// liquidation. So the path that protects the counterparty vault from insolvent
// positions had no implementation outside a test harness.
//
// The decision logic is in decide.ts, tested without a network. What lives here
// is scheduling and reporting.

import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Chain } from './chain.js';
import { decide, nextCheckDelay, watchable, type WatchedPosition } from './decide.js';
import { SecretStore } from './secrets.js';

dotenv.config();

const RPC_URL = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';
const INDEXER_URL = process.env.INDEXER_URL || 'http://localhost:3001';
const SECRET_KEY = process.env.KEEPER_SECRET_KEY;
const SECRET_STORE = process.env.KEEPER_SECRET_STORE || resolve('.keeper-secrets.json');
const TICK_SECONDS = Number(process.env.KEEPER_TICK_SECONDS || 15);
const DRY_RUN = process.env.KEEPER_DRY_RUN === 'true';

function engineAddress(): string {
  if (process.env.LIQUIDATION_ENGINE_ADDRESS) return process.env.LIQUIDATION_ENGINE_ADDRESS;
  const path = resolve('../../deployments/testnet.json');
  if (!existsSync(path)) {
    throw new Error(
      'Set LIQUIDATION_ENGINE_ADDRESS, or run from a checkout with deployments/testnet.json.',
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')).liquidation;
}

async function fetchPositions(): Promise<WatchedPosition[]> {
  try {
    const res = await fetch(`${INDEXER_URL}/positions`);
    if (!res.ok) return [];
    return watchable((await res.json()).positions ?? []);
  } catch (e) {
    // An unreachable indexer is an outage, not a reason to stop. Say so once
    // per tick and try again; positions are not at risk from a keeper that
    // cannot see them, only from one that never comes back.
    console.warn(`Indexer unreachable: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

async function main() {
  if (!SECRET_KEY) {
    // Refuse to start rather than run as a monitor that can never act. A keeper
    // silently unable to submit is indistinguishable from one with nothing to
    // do, right up until a position needed liquidating.
    console.error('Error: KEEPER_SECRET_KEY is required (the keeper signs its own transactions).');
    process.exit(1);
  }

  const engineId = engineAddress();
  const chain = new Chain(RPC_URL, engineId, SECRET_KEY);
  const secrets = new SecretStore(SECRET_STORE);

  console.log('Vayyl keeper');
  console.log(`  engine:  ${engineId}`);
  console.log(`  keeper:  ${chain.address}`);
  console.log(`  indexer: ${INDEXER_URL}`);
  try {
    console.log(`  grace:   ${await chain.gracePeriod()}s`);
    console.log(`  bounty:  ${await chain.bountyBps()} bps of seized collateral`);
  } catch (e) {
    console.warn(`  (could not read engine config: ${e instanceof Error ? e.message : e})`);
  }
  if (DRY_RUN) console.log('  MODE:    dry run — decisions logged, nothing submitted');

  // Per-position backoff, so a position with an hour of grace left is not
  // re-read every fifteen seconds.
  const nextCheck = new Map<string, number>();

  const tick = async () => {
    const now = Math.floor(Date.now() / 1000);
    const positions = await fetchPositions();
    if (positions.length === 0) return;

    for (const position of positions) {
      const id = position.position_id;
      if ((nextCheck.get(id) ?? 0) > now) continue;

      let view;
      try {
        view = await chain.view(id);
      } catch (e) {
        console.warn(`  ${id.slice(0, 12)}… read failed: ${e instanceof Error ? e.message : e}`);
        nextCheck.set(id, now + TICK_SECONDS);
        continue;
      }
      nextCheck.set(id, now + nextCheckDelay(view));

      const action = decide(view, chain.address, now);
      if (action.kind === 'skip') {
        console.log(`  ${id.slice(0, 12)}… ${action.reason}`);
        if (view.isLiquidated) secrets.release(id);
        continue;
      }

      if (DRY_RUN) {
        console.log(`  ${id.slice(0, 12)}… would ${action.kind}`);
        continue;
      }

      try {
        if (action.kind === 'initiate') {
          // The secret is persisted BEFORE the claim is submitted. A crash
          // between the two would otherwise leave an escrow this keeper could
          // never redeem, blocking the position until the TTL expired.
          const secret = secrets.claim(id);
          const commitment = await chain.keeperCommitment(secret);
          const hash = await chain.initiate(id, commitment);
          console.log(`  ${id.slice(0, 12)}… claimed (${hash})`);
          // Come back promptly: the reveal is the half that pays.
          nextCheck.set(id, now + 5);
        } else {
          const secret = secrets.get(id);
          if (!secret) {
            // Our address holds the escrow but we have lost the secret -- a
            // restart with a different secret store. Nothing can redeem it;
            // wait for the TTL and re-claim.
            console.warn(`  ${id.slice(0, 12)}… escrow is ours but the secret is missing`);
            continue;
          }
          const hash = await chain.revealAndSeize(id, secret);
          secrets.release(id);
          console.log(`  ${id.slice(0, 12)}… SEIZED (${hash})`);
        }
      } catch (e) {
        // A revert here is usually correct behaviour by the contract, most often
        // `PositionNotStale` because the owner attested between our claim and
        // our reveal (audit H5). That is the system working, not a keeper fault.
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`  ${id.slice(0, 12)}… ${action.kind} refused: ${message}`);
        nextCheck.set(id, now + TICK_SECONDS);
      }
    }
  };

  await tick();
  setInterval(() => {
    void tick().catch((e) => console.error('Tick failed:', e));
  }, TICK_SECONDS * 1000);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
