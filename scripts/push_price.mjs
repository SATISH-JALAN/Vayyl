#!/usr/bin/env node
// ============================================================
// Testnet price publisher
// ============================================================
// Keeps the SEP-40 mock oracle fresh so positions can be opened, attested and
// closed.
//
// Why this has to exist. `PositionManager::MAX_ORACLE_AGE` is 300 seconds, and
// every write path -- open, attest, close -- refuses a price older than that.
// The deploy script publishes exactly one price, so without something running,
// the whole positions vertical stops working five minutes after deployment and
// the failure is a bare `StaleOracle` that looks like a bug in the contracts.
// That check is correct and must not be loosened: judging solvency against a
// price the market has left behind is the failure liquidation exists to
// prevent. So the answer is to publish, not to widen the window.
//
// WHAT IS PUBLISHED. By default the mark follows the REAL XLM/USD market,
// rebased onto the tier table's design point -- see `rebase()` for why the raw
// dollar price would be a category error. A synthetic random walk is still
// available behind `--synthetic` for forcing liquidations on demand.
//
// Nothing here should ever run against mainnet, and the script refuses to.
//
// Usage:
//   node scripts/push_price.mjs                    # track the real market
//   node scripts/push_price.mjs --synthetic        # random walk
//   node scripts/push_price.mjs --fixed 10000000   # hold one price
//   node scripts/push_price.mjs --once             # publish once and exit
//
// Environment:
//   STELLAR_SOURCE   key alias to sign with (default: deployer)
//   ORACLE_ID        oracle contract (default: `oracle` in deployments/testnet.json)
//   PRICE_INTERVAL   seconds between publications (default: 60)
//   PRICE_ASSET      SEP-40 asset symbol (default: XLM)

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

const NETWORK = process.env.STELLAR_NETWORK || 'testnet';
const SOURCE = process.env.STELLAR_SOURCE || 'deployer';
const ASSET = process.env.PRICE_ASSET || 'XLM';
const INTERVAL = Number(process.env.PRICE_INTERVAL || 60);

// Stroops of collateral per contract unit. 10,000,000 = 1 XLM per unit, which
// puts both tiers at 3x leverage -- see vayyl_types::TIER_SIZE.
const START_PRICE = 10_000_000n;

// How far one step may move the price, in basis points. Synthetic mode only.
// 150bp keeps a tier-0 position roughly 40 steps from its knock-out and 30 from
// a wipe-out, so a tester sees real movement within a session without a
// position dying in two ticks.
const STEP_BPS = 150n;

// Hard rails for the synthetic walk. An unbounded walk eventually wanders
// somewhere that makes every open position knock out or die at once, and a
// tester would read that as the protocol misbehaving rather than as this
// script.
const MIN_PRICE = START_PRICE / 2n;
const MAX_PRICE = START_PRICE * 2n;

// Where the market-tracking anchor is remembered. Without persistence the
// anchor would be re-established on every restart, so the published price would
// snap back to exactly 1 XLM/unit and every open position would take a step
// change corresponding to nothing that happened in the market -- a position
// could be liquidated by a service restart.
const ANCHOR_FILE = resolve(REPO, 'deployments', '.price-anchor.json');

// Vayyl settles in XLM, so the number that moves a position is what XLM is
// worth. Same pair the chart draws, which is the point.
const MARKET_URL = 'https://api.binance.com/api/v3/ticker/price?symbol=XLMUSDT';

// A sanity band on the tracked price. NOT the synthetic clamp -- a real market
// may legitimately move a long way. This only rejects a reading that would
// break the arithmetic downstream: the circuits range-check the price to 64
// bits, and a zero would make every notional zero and every position trivially
// healthy, which is the quietest possible way to disable liquidation.
const SANE_MIN = 1n;
const SANE_MAX = 1n << 63n;

if (NETWORK === 'public' || NETWORK === 'mainnet') {
  console.error('Refusing to run against mainnet. This publishes a test-network price.');
  process.exit(1);
}

function oracleId() {
  if (process.env.ORACLE_ID) return process.env.ORACLE_ID.trim();
  const file = resolve(REPO, 'deployments', `${NETWORK}.json`);
  if (!existsSync(file)) {
    throw new Error(`Set ORACLE_ID, or deploy first (${file} not found).`);
  }
  const id = JSON.parse(readFileSync(file, 'utf8')).oracle;
  if (!id) throw new Error(`No "oracle" key in ${file}.`);
  return id;
}

/**
 * Rebase a real market price onto the tier table's design point.
 *
 * The oracle unit is stroops of collateral per contract unit, and the tier
 * table is built around 1 XLM per unit (10,000,000). Publishing the raw
 * XLM/USD number instead would be a category error: it is a different quantity
 * in different units, and at roughly $0.18 it would put a tier-0 position at
 * about 16x rather than the 3x the vault reserves against.
 *
 * So the published price carries the market's MOVEMENT, anchored so the anchor
 * moment reads exactly START_PRICE. A 4% day on XLM/USD is a 4% day on the
 * mark, the chart and the mark agree in shape, and the tiers keep the leverage
 * they were designed for.
 *
 * Pure and exported for the test.
 */
export function rebase(marketNow, marketAnchor, startPrice = START_PRICE) {
  if (!(marketNow > 0) || !(marketAnchor > 0)) {
    throw new Error(`Non-positive market price (now=${marketNow}, anchor=${marketAnchor})`);
  }
  // Scaled integer arithmetic. Floats would let the anchor drift over a long
  // run, and that drift would be indistinguishable from market movement.
  const SCALE = 1_000_000_000n;
  const ratio =
    (BigInt(Math.round(marketNow * 1e9)) * SCALE) / BigInt(Math.round(marketAnchor * 1e9));
  const price = (startPrice * ratio) / SCALE;
  if (price < SANE_MIN || price > SANE_MAX) {
    throw new Error(`Rebased price out of sane range: ${price}`);
  }
  return price;
}

/**
 * One step of the synthetic walk, clamped.
 *
 * Exported for the test: the interesting property is that it stays inside the
 * rails no matter how the coin lands, because a price that escapes them makes
 * every open position resolve at once.
 */
export function nextPrice(current, roll) {
  const delta = (current * STEP_BPS) / 10_000n;
  const moved = roll < 0.5 ? current - delta : current + delta;
  if (moved < MIN_PRICE) return MIN_PRICE;
  if (moved > MAX_PRICE) return MAX_PRICE;
  return moved;
}

async function marketPrice() {
  const res = await fetch(MARKET_URL);
  if (!res.ok) throw new Error(`market feed HTTP ${res.status}`);
  const body = await res.json();
  const px = Number(body.price);
  if (!Number.isFinite(px) || px <= 0) throw new Error(`bad market price: ${body.price}`);
  return px;
}

/** Read the persisted anchor, or null if there is not a usable one. */
function readAnchor() {
  if (!existsSync(ANCHOR_FILE)) return null;
  try {
    const a = JSON.parse(readFileSync(ANCHOR_FILE, 'utf8'));
    return typeof a.market === 'number' && a.market > 0 ? a : null;
  } catch {
    return null;
  }
}

function writeAnchor(market) {
  const anchor = {
    market,
    anchoredAt: new Date().toISOString(),
    startPrice: START_PRICE.toString(),
  };
  writeFileSync(ANCHOR_FILE, JSON.stringify(anchor, null, 2));
  return anchor;
}

function publish(id, price) {
  // The asset encoding must match what PositionManager was initialized with,
  // byte for byte. A mismatch is not an error anywhere: the manager looks up a
  // slot that was never written and reads it as "no price published".
  execFileSync(
    'stellar',
    [
      'contract', 'invoke',
      '--id', id,
      '--network', NETWORK,
      '--source', SOURCE,
      '--',
      'set_price',
      '--asset', JSON.stringify({ Other: ASSET }),
      '--price', price.toString(),
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const synthetic = args.includes('--synthetic');
  const fixedIdx = args.indexOf('--fixed');
  const fixed = fixedIdx === -1 ? null : BigInt(args[fixedIdx + 1]);

  const id = oracleId();
  console.log(`Publishing ${ASSET} to ${id} on ${NETWORK} as ${SOURCE}`);

  // Default: follow the real market. The synthetic walk made the mark drift
  // away from the chart for no reason anyone could point at, which reads as the
  // protocol being wrong rather than as the generator being made up.
  let mode = fixed !== null ? 'fixed' : synthetic ? 'synthetic' : 'market';
  let anchor = null;

  if (mode === 'market') {
    try {
      const now = await marketPrice();
      anchor = readAnchor() ?? writeAnchor(now);
      console.log(`Tracking real XLM/USD, rebased so the anchor reads ${START_PRICE}.`);
      console.log(`  anchor $${anchor.market} set ${anchor.anchoredAt}; spot $${now}`);
      console.log('  The mark carries the market MOVEMENT, not its absolute value:');
      console.log('  the oracle unit is stroops of collateral per contract unit and the');
      console.log('  tier table is built around 1 XLM/unit, so publishing $0.18 directly');
      console.log('  would put tier 0 near 16x instead of the 3x the vault reserves for.');
      console.log('');
    } catch (e) {
      console.error(`Market feed unavailable (${e.message}); falling back to the synthetic walk.`);
      mode = 'synthetic';
    }
  }

  if (mode === 'synthetic') {
    console.log(
      `Synthetic random walk from ${START_PRICE}, +/-${STEP_BPS}bp per step, every ${INTERVAL}s`,
    );
    console.log('This is NOT a market price. It exists so positions move.');
    console.log('');
  } else if (mode === 'fixed') {
    console.log(`Holding a fixed price of ${fixed}`);
    console.log('');
  }

  let price = fixed ?? START_PRICE;

  const tick = async () => {
    if (mode === 'market') {
      try {
        price = rebase(await marketPrice(), anchor.market);
      } catch (e) {
        // Republish the last known price rather than skipping. The contract
        // refuses anything older than 300s, so a silent gap takes the whole
        // vertical down; republishing a slightly stale number keeps positions
        // operable, and the age is visible in the UI either way.
        console.error(`  market read failed, republishing last price: ${e.message}`);
      }
    }

    try {
      publish(id, price);
      const xlm = (Number(price) / 1e7).toFixed(4);
      console.log(`${new Date().toISOString()}  ${price}  (${xlm} XLM/unit)`);
    } catch (e) {
      // Keep going. A single failed publication is survivable -- the contract's
      // window is 300s and this runs every 60 -- whereas exiting would take the
      // whole positions vertical down with it a few minutes later.
      console.error(`  publish failed: ${e.message?.split('\n')[0] ?? e}`);
    }

    if (mode === 'synthetic') price = nextPrice(price, Math.random());
  };

  await tick();
  if (once) return;
  setInterval(() => void tick(), INTERVAL * 1000);
}

// Only run the loop when invoked directly, so tests can import the pure parts.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error('Fatal:', e.message ?? e);
    process.exit(1);
  });
}
