// ============================================================
// Liquidation price agrees with the health constraint itself
// ============================================================
// The tests that matter here don't check the formula against a second copy of
// the formula. They check it against the RULE -- the same inequality the
// circuit constrains -- evaluated directly at the boundary and one tick either
// side. If the algebra in `liquidation.ts` is rearranged wrongly, the boundary
// lands in the wrong place and these fail; a duplicated formula would agree
// with itself and prove nothing.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HEALTH_SCALE,
  HEALTH_THRESHOLD,
  MAX_ORACLE_AGE,
  distanceToLiquidation,
  equityAt,
  liquidationPrice,
  marginHealth,
  pnlAt,
} from './liquidation.ts';
import { getTier, priceBounds, TIERS } from './tiers.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const ENTRY = 10_000_000n; // 1 XLM per unit, the tier table's design point

/**
 * The constraint as the circuit states it, with nothing rearranged.
 * HEALTH_SCALE*(collateral + gain) >= HEALTH_SCALE*loss + size*price*threshold
 */
function circuitSaysHealthy(tierId: number, direction: 0 | 1, entry: bigint, price: bigint) {
  const tier = getTier(tierId);
  const delta = direction === 1 ? price - entry : entry - price;
  const magnitude = delta < 0n ? -delta : delta;
  const gain = delta >= 0n ? magnitude * tier.size : 0n;
  const loss = delta < 0n ? magnitude * tier.size : 0n;
  const lhs = HEALTH_SCALE * (tier.marginStroops + gain);
  const rhs = HEALTH_SCALE * loss + tier.size * price * HEALTH_THRESHOLD;
  return lhs >= rhs;
}

test('the mirrored contract constants still match position-manager', () => {
  // Same class of bug as the tier table: nothing at runtime compares these, so
  // a change to HEALTH_THRESHOLD on-chain would leave the UI drawing a
  // liquidation price that no longer matches the price a keeper acts on -- and
  // it would keep looking entirely reasonable.
  const src = readFileSync(
    resolve(REPO, 'contracts/position-manager/src/lib.rs'),
    'utf8',
  );

  const threshold = src.match(/pub const HEALTH_THRESHOLD:\s*u64\s*=\s*(\d+)/);
  assert.ok(threshold, 'HEALTH_THRESHOLD not found in position-manager');
  assert.equal(BigInt(threshold[1]), HEALTH_THRESHOLD);

  const age = src.match(/pub const MAX_ORACLE_AGE:\s*u64\s*=\s*(\d+)/);
  assert.ok(age, 'MAX_ORACLE_AGE not found in position-manager');
  assert.equal(Number(age[1]), MAX_ORACLE_AGE);

  // HEALTH_SCALE lives in the circuit, not the contract.
  const circuit = readFileSync(resolve(REPO, 'circuits/position_health.circom'), 'utf8');
  const scale = circuit.match(/var HEALTH_SCALE\s*=\s*(\d+)/);
  assert.ok(scale, 'HEALTH_SCALE not found in position_health.circom');
  assert.equal(BigInt(scale[1]), HEALTH_SCALE);
});

test('the liquidation price is the last price the circuit still calls healthy', () => {
  for (const tier of TIERS) {
    for (const direction of [0, 1] as const) {
      const liq = liquidationPrice(tier, direction, ENTRY);
      assert.ok(liq !== null, `tier ${tier.id} dir ${direction} should have a bound`);

      assert.ok(
        circuitSaysHealthy(tier.id, direction, ENTRY, liq),
        `tier ${tier.id} dir ${direction}: boundary ${liq} should still be healthy`,
      );

      // One tick in the direction that hurts must fail. A long dies as the
      // price falls, a short as it rises.
      const past = direction === 1 ? liq - 1n : liq + 1n;
      assert.ok(
        !circuitSaysHealthy(tier.id, direction, ENTRY, past),
        `tier ${tier.id} dir ${direction}: ${past} should be unhealthy`,
      );
    }
  }
});

test('marginHealth agrees with the constraint at every price around the boundary', () => {
  // Sweeping rather than spot-checking, because an off-by-one in the ratio
  // arithmetic would still pass a single well-chosen assertion.
  for (const tier of TIERS) {
    for (const direction of [0, 1] as const) {
      const liq = liquidationPrice(tier, direction, ENTRY)!;
      for (let d = -5n; d <= 5n; d++) {
        const price = liq + d;
        if (price <= 0n) continue;
        assert.equal(
          marginHealth(tier, direction, ENTRY, price).healthy,
          circuitSaysHealthy(tier.id, direction, ENTRY, price),
          `tier ${tier.id} dir ${direction} price ${price}`,
        );
      }
    }
  }
});

test('liquidation happens before wipe-out, never after', () => {
  // The maintenance margin exists to seize a position while there is still
  // collateral to seize. If these ever crossed, the keeper would be arriving
  // after the money was gone -- the vault would be paying for the shortfall.
  for (const tier of TIERS) {
    for (const direction of [0, 1] as const) {
      const liq = liquidationPrice(tier, direction, ENTRY)!;
      const { wipeOut } = priceBounds(tier, direction, ENTRY);
      if (direction === 1) {
        assert.ok(liq > wipeOut, `long tier ${tier.id}: liq ${liq} must sit above wipe-out ${wipeOut}`);
      } else {
        assert.ok(liq < wipeOut, `short tier ${tier.id}: liq ${liq} must sit below wipe-out ${wipeOut}`);
      }
    }
  }
});

test('a position opened at the current price is healthy at that price', () => {
  // Otherwise the product would open positions that are immediately seizable.
  for (const tier of TIERS) {
    for (const direction of [0, 1] as const) {
      assert.ok(
        marginHealth(tier, direction, ENTRY, ENTRY).healthy,
        `tier ${tier.id} dir ${direction} should open healthy`,
      );
    }
  }
});

test('PnL is signed and symmetric between the two directions', () => {
  const tier = getTier(0);
  const up = ENTRY + 1_000_000n;
  assert.equal(pnlAt(tier, 1, ENTRY, up), -pnlAt(tier, 0, ENTRY, up));
  assert.equal(pnlAt(tier, 1, ENTRY, ENTRY), 0n);
  assert.equal(equityAt(tier, 1, ENTRY, ENTRY), tier.marginStroops);
});

test('PnL is not capped, because health is not settlement', () => {
  // settlementPayout clamps at the tier ceiling; health must not, or a
  // knocked-out long would report the same equity as one merely at the cap and
  // the health bar would stop moving.
  const tier = getTier(0);
  const farAbove = ENTRY + 100_000_000n;
  assert.ok(pnlAt(tier, 1, ENTRY, farAbove) > tier.maxPayoutStroops);
});

test('a short with no reachable liquidation price returns null, not zero', () => {
  // Zero would render as "liquidates at 0.0000", which reads like imminent
  // death rather than "cannot be liquidated on this side".
  const tier = getTier(0);
  // A long whose collateral already exceeds its notional cannot be liquidated
  // by a falling price: numerator goes non-positive.
  const tinyEntry = 1n;
  assert.equal(liquidationPrice(tier, 1, tinyEntry), null);
});

test('distance to liquidation is positive while healthy and negative past it', () => {
  const tier = getTier(0);
  const liq = liquidationPrice(tier, 1, ENTRY)!;
  assert.ok(distanceToLiquidation(tier, 1, ENTRY, ENTRY)! > 0);
  assert.ok(distanceToLiquidation(tier, 1, ENTRY, liq - 100n)! < 0);
  assert.equal(distanceToLiquidation(tier, 1, 1n, ENTRY), null);
});
