#!/usr/bin/env node
// ============================================================
// Position-circuit soundness tests
// ============================================================
// Witness-level pass/fail tests for the positions vertical. For each circuit:
//
//   (a) an honest witness generates cleanly -- this is COMPLETENESS, and it is
//       not a formality. A circuit with no satisfying witness for honest input
//       compiles perfectly and produces a feature nobody can use; a position
//       could be opened on-chain and never closed.
//
//   (b) a malformed witness that the soundness constraints must reject IS
//       rejected. Interior values (commitments, nullifiers, roots, derived
//       pubkeys) are recomputed by test/oracle_position.circom UNDER the
//       malformation, from the same library templates the real circuits use.
//       That matters: if the test held the honest commitments fixed, a
//       malformed witness would be rejected by the stale commitment rather than
//       by the constraint under test, and the test would keep passing after the
//       constraint was deleted.
//
// No trusted setup or ptau needed -- constraint violations fail at witness
// generation.
//
//   Usage:  node scripts/position_circuits_test.mjs
//   Exit 0 = every case behaved as expected; exit 1 = a regression.
// ============================================================

import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS = resolve(__dirname, '..');
const BUILD = resolve(CIRCUITS, 'build');
const NODE_MODULES = resolve(CIRCUITS, 'node_modules');
const DEPTH = 20;
const TWO64 = 1n << 64n; // the first value that fails RangeCheck64

// The tier table, mirrored from contracts/vayyl-types/src/lib.rs and
// circuits/lib/tiers.circom. scripts/check_tier_sync.js is what stops these
// three from drifting.
const TIERS = [
  { margin: 100_000_000n, size: 30n, maxPayout: 300_000_000n },
  { margin: 500_000_000n, size: 150n, maxPayout: 1_500_000_000n },
];

mkdirSync(BUILD, { recursive: true });

const compiled = new Map();

function compile(name, srcPath) {
  if (compiled.has(name)) return compiled.get(name);
  console.log(`  . compiling ${name} ...`);
  execSync(`circom "${srcPath}" --wasm --sym -o "${BUILD}" -l "${NODE_MODULES}"`,
    { stdio: ['ignore', 'ignore', 'inherit'] });

  const wcBuilder = require(resolve(BUILD, `${name}_js`, 'witness_calculator.js'));
  const wasm = readFileSync(resolve(BUILD, `${name}_js`, `${name}.wasm`));

  const sym = readFileSync(resolve(BUILD, `${name}.sym`), 'utf8');
  const nameToIdx = new Map();
  for (const line of sym.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split(',');
    if (parts[3]) nameToIdx.set(parts[3], Number(parts[1]));
  }
  const rec = { wcPromise: wcBuilder(wasm), nameToIdx };
  compiled.set(name, rec);
  return rec;
}

async function witness(name, input) {
  const wc = await compiled.get(name).wcPromise;
  // second arg true = sanity-check constraints; throws on violation
  return wc.calculateWitness(input, true);
}

async function namedOutputs(name, input, names) {
  const { nameToIdx } = compiled.get(name);
  const w = await witness(name, input);
  const out = {};
  for (const n of names) out[n] = BigInt(w[nameToIdx.get(`main.${n}`)]);
  return out;
}

// ---- fixtures --------------------------------------------------------------

const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const PATH_ELEMENTS = range(DEPTH, (i) => BigInt(i * 7 + 1));
const PATH_INDICES = range(DEPTH, (i) => BigInt(i % 2));
const PRIV_KEY = 444n;      // < the BabyJubjub subgroup order
const OTHER_KEY = 4441n;    // a different owner, for the theft cases
const ENTRY = 10_000_000n;  // 1 XLM per contract unit
const POSITION_ID = 0x5eedn;

const ORACLE_OUTPUTS = [
  'pubX', 'pubY', 'note_commitment', 'note_nullifier', 'note_root',
  'change_commitment', 'pos_commitment', 'pos_nullifier', 'out_commitment',
  'keeper_commitment',
];

/**
 * Recompute every interior value for one position, under `overrides`.
 *
 * Defaults describe a tier-0 long funded by a 150 XLM note: margin 10 XLM,
 * change 140 XLM.
 */
async function oracle(overrides = {}) {
  const t = TIERS[0];
  const p = {
    note_amount: 1_500_000_000n,
    note_blindness: 333n,
    privKey: PRIV_KEY,
    change_amount: 1_500_000_000n - t.margin,
    change_blindness: 334n,
    margin: t.margin,
    size: t.size,
    direction: 1n,
    entry_price: ENTRY,
    position_blindness: 555n,
    out_amount: t.margin,
    out_blindness: 777n,
    keeper_secret: 999n,
    ...overrides,
  };
  const input = Object.fromEntries(
    Object.entries(p).map(([k, v]) => [k, v.toString()]),
  );
  input.pathElements = PATH_ELEMENTS.map(String);
  input.pathIndices = PATH_INDICES.map(String);
  const o = await namedOutputs('oracle_position', input, ORACLE_OUTPUTS);
  return { ...o, p };
}

// ---- assertion helpers -----------------------------------------------------

let failures = 0;
let passes = 0;

async function expectPass(label, name, input) {
  try {
    await witness(name, input);
    passes++;
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${label} -- an HONEST witness was REJECTED: ${e.message.split('\n')[0]}`);
  }
}

async function expectFail(label, name, input) {
  try {
    await witness(name, input);
    failures++;
    console.log(`  FAIL  ${label} -- a malformed witness was ACCEPTED (unsound)`);
  } catch {
    passes++;
    console.log(`  PASS  ${label} -- rejected as expected`);
  }
}

// ---- run -------------------------------------------------------------------

console.log('=== Position-circuit soundness: open . health . close ===\n');

compile('oracle_position', resolve(CIRCUITS, 'test', 'oracle_position.circom'));
compile('position_open', resolve(CIRCUITS, 'position_open.circom'));
compile('position_health', resolve(CIRCUITS, 'position_health.circom'));
compile('position_close', resolve(CIRCUITS, 'position_close.circom'));

// ---------------------------------------------------------------------------
// position_open
// ---------------------------------------------------------------------------
console.log('\n-- position_open --');
{
  const openInput = (o, over = {}) => ({
    root: o.note_root.toString(),
    nullifier: o.note_nullifier.toString(),
    position_commitment: o.pos_commitment.toString(),
    change_commitment: o.change_commitment.toString(),
    tier_id: '0',
    entry_price: o.p.entry_price.toString(),
    direction: o.p.direction.toString(),
    position_id: POSITION_ID.toString(),
    privKey: o.p.privKey.toString(),
    in_amount: o.p.note_amount.toString(),
    in_blindness: o.p.note_blindness.toString(),
    pathElements: PATH_ELEMENTS.map(String),
    pathIndices: PATH_INDICES.map(String),
    change_amount: o.p.change_amount.toString(),
    change_blindness: o.p.change_blindness.toString(),
    position_blindness: o.p.position_blindness.toString(),
    ...over,
  });

  await expectPass('open . honest tier-0 long with change', 'position_open',
    openInput(await oracle()));

  await expectPass('open . honest short', 'position_open',
    openInput(await oracle({ direction: 0n }), { direction: '0' }));

  {
    // A note worth exactly the margin: change is zero, and must still prove.
    const t = TIERS[0];
    const o = await oracle({ note_amount: t.margin, change_amount: 0n });
    await expectPass('open . note exactly equal to the margin (zero change)',
      'position_open', openInput(o));
  }

  {
    // Tier 1, to prove the interpolation in TierConstants is not tier-0-only.
    const t = TIERS[1];
    const o = await oracle({
      margin: t.margin, size: t.size,
      note_amount: 2_000_000_000n, change_amount: 2_000_000_000n - t.margin,
    });
    await expectPass('open . honest tier-1', 'position_open',
      openInput(o, { tier_id: '1', in_amount: '2000000000',
        change_amount: (2_000_000_000n - t.margin).toString() }));
  }

  // --- soundness ---

  {
    // P2: the collateral must be the TIER's margin. Claiming a tier-0 position
    // while committing to tier-1 collateral would let a trader control 5x the
    // size for a tenth of the margin.
    const o = await oracle({ margin: TIERS[1].margin });
    await expectFail('open . position committed to a margin the tier does not have',
      'position_open', openInput(o));
  }

  {
    // Conservation: keeping the change while paying no margin is minting money.
    const o = await oracle({ change_amount: 1_500_000_000n });
    await expectFail('open . change equal to the whole note (margin unpaid)',
      'position_open', openInput(o));
  }

  {
    // The same, one stroop at a time -- the cheap version of the same attack.
    const o = await oracle({ change_amount: 1_500_000_000n - TIERS[0].margin + 1n });
    await expectFail('open . change one stroop too large', 'position_open',
      openInput(o));
  }

  {
    // A negative change (as a field element, p - 1) would wrap the conservation
    // equation. RangeCheck64 on change_amount is what stops it.
    const o = await oracle({ change_amount: TWO64 });
    await expectFail('open . change_amount >= 2^64', 'position_open', openInput(o));
  }

  {
    // F1: the note's public key is DERIVED from privKey. A prover who names a
    // key they do not own could spend a note that is not theirs.
    const o = await oracle();
    await expectFail('open . spending with the wrong private key', 'position_open',
      openInput(o, { privKey: OTHER_KEY.toString() }));
  }

  {
    // The Merkle path must actually reach the claimed root.
    const o = await oracle();
    await expectFail('open . a root the path does not produce', 'position_open',
      openInput(o, { root: (o.note_root + 1n).toString() }));
  }

  {
    // P0: entry_price is public and contract-supplied. A proof built against a
    // different entry price must not verify under the contract's.
    const o = await oracle();
    await expectFail('open . entry price other than the one committed',
      'position_open', openInput(o, { entry_price: (ENTRY + 1n).toString() }));
  }

  {
    // tier_id is pinned to a bit by TierConstants. A third tier does not exist,
    // and must fail rather than interpolate into values in no table.
    const o = await oracle();
    await expectFail('open . tier_id = 2 (no such tier)', 'position_open',
      openInput(o, { tier_id: '2' }));
  }

  {
    // direction selects the sign of every future PnL calculation.
    const o = await oracle({ direction: 2n });
    await expectFail('open . direction = 2 (not a bit)', 'position_open',
      openInput(o, { direction: '2' }));
  }

  {
    // The change note must be addressed to the spender. Otherwise a relayer
    // could redirect the remainder of somebody else's collateral note.
    const o = await oracle();
    const other = await oracle({ privKey: OTHER_KEY });
    await expectFail('open . change note addressed to another key', 'position_open',
      openInput(o, { change_commitment: other.change_commitment.toString() }));
  }
}

// ---------------------------------------------------------------------------
// position_health
// ---------------------------------------------------------------------------
console.log('\n-- position_health --');
{
  const HEALTH_SCALE = 10_000n;
  const THRESHOLD = 500n;

  const healthInput = (o, price, threshold = THRESHOLD, over = {}) => ({
    position_commitment: o.pos_commitment.toString(),
    oracle_price: price.toString(),
    oracle_timestamp: '1700000000',
    health_threshold: threshold.toString(),
    collateral_amount: o.p.margin.toString(),
    size: o.p.size.toString(),
    direction: o.p.direction.toString(),
    entry_price: o.p.entry_price.toString(),
    privKey: o.p.privKey.toString(),
    position_blindness: o.p.position_blindness.toString(),
    price_ge_entry: (price >= o.p.entry_price ? 1n : 0n).toString(),
    ...over,
  });

  const t = TIERS[0];

  await expectPass('health . a flat market is solvent with margin',
    'position_health', healthInput(await oracle(), ENTRY));

  await expectPass('health . a long in profit is solvent',
    'position_health', healthInput(await oracle(), ENTRY + 1_000_000n));

  {
    // A long that has lost most of its margin but still clears the 5% maintenance
    // requirement. This is the boundary the liquidation trigger sits on, so it
    // has to be provable right up to it.
    const o = await oracle();
    // equity = margin - size*(entry-price); requirement = size*price*500/10000.
    // At price = entry - 3_000_000: equity = 1e8 - 30*3e6 = 1e7,
    // requirement = 30 * 7e6 * 0.05 = 1.05e7 -> just insolvent. Use 2_500_000:
    // equity = 1e8 - 7.5e7 = 2.5e7, requirement = 30*7.5e6*0.05 = 1.125e7. OK.
    await expectPass('health . a long deep in loss but above maintenance margin',
      'position_health', healthInput(o, ENTRY - 2_500_000n));
  }

  await expectPass('health . a short in profit is solvent', 'position_health',
    healthInput(await oracle({ direction: 0n }), ENTRY - 1_000_000n));

  // --- soundness ---

  {
    // The whole point of the circuit: below the maintenance margin there must
    // be NO satisfying witness, which is what makes the heartbeat go stale.
    const o = await oracle();
    await expectFail('health . a long below the maintenance margin cannot attest',
      'position_health', healthInput(o, ENTRY - 3_200_000n));
  }

  {
    // Total loss: the position is worth nothing and must be unprovable.
    const o = await oracle();
    await expectFail('health . a wiped-out long cannot attest', 'position_health',
      healthInput(o, 1n));
  }

  {
    // The selector-via-range-check. Claiming the price rose when it fell would
    // turn a loss into a gain; the 65-bit check on the SELECTED delta rejects it.
    const o = await oracle();
    await expectFail('health . lying about the sign of the price move',
      'position_health', healthInput(o, ENTRY - 3_200_000n, THRESHOLD,
        { price_ge_entry: '1' }));
  }

  {
    // P7: the position's key is derived from privKey, so an attestation is a
    // statement by the OWNER rather than by anyone who learned the opening.
    const o = await oracle();
    await expectFail('health . attesting with the wrong private key',
      'position_health', healthInput(o, ENTRY, THRESHOLD,
        { privKey: OTHER_KEY.toString() }));
  }

  {
    // A softer threshold than the contract's would let an underwater position
    // keep attesting. The contract supplies the value, so this must not verify
    // against a different one -- proved here by the commitment/threshold pair
    // being inconsistent with a position that is actually below margin.
    const o = await oracle();
    await expectFail('health . a below-margin position with the contract threshold',
      'position_health', healthInput(o, ENTRY - 3_200_000n, THRESHOLD));
    await expectPass('health . ...but provable at a threshold of zero, which is why the contract fixes it',
      'position_health', healthInput(o, ENTRY - 3_200_000n, 0n));
  }

  {
    // Collateral must match the commitment; inflating it is the direct forge.
    const o = await oracle();
    await expectFail('health . claiming more collateral than the commitment binds',
      'position_health', healthInput(o, ENTRY, THRESHOLD,
        { collateral_amount: (t.margin * 10n).toString() }));
  }

  {
    // Range checks: an out-of-range size wraps the notional product.
    const o = await oracle({ size: TWO64 });
    await expectFail('health . size >= 2^64', 'position_health',
      healthInput(o, ENTRY, THRESHOLD, { size: TWO64.toString() }));
  }
}

// ---------------------------------------------------------------------------
// position_close
// ---------------------------------------------------------------------------
console.log('\n-- position_close --');
{
  const t = TIERS[0];

  const closeInput = (o, payout, fee = 0n, over = {}) => ({
    position_nullifier: o.pos_nullifier.toString(),
    output_note_commitment: o.out_commitment.toString(),
    old_position_commitment: o.pos_commitment.toString(),
    tier_id: '0',
    entry_price: o.p.entry_price.toString(),
    direction: o.p.direction.toString(),
    payout: payout.toString(),
    fee: fee.toString(),
    position_id: POSITION_ID.toString(),
    privKey: o.p.privKey.toString(),
    position_blindness: o.p.position_blindness.toString(),
    note_blindness: o.p.out_blindness.toString(),
    ...over,
  });

  await expectPass('close . flat settlement returns the margin', 'position_close',
    closeInput(await oracle({ out_amount: t.margin }), t.margin));

  {
    const payout = t.margin + t.size * 1_000_000n;
    const o = await oracle({ out_amount: payout });
    await expectPass('close . a winning position', 'position_close',
      closeInput(o, payout));
  }

  {
    // With a relayer fee: the note is payout - fee.
    const fee = 500_000n;
    const o = await oracle({ out_amount: t.margin - fee });
    await expectPass('close . fee is deducted from the note', 'position_close',
      closeInput(o, t.margin, fee));
  }

  {
    // A total loss settles to a zero note. It must still be provable, or the
    // position could never be closed and its vault reserve never freed.
    const o = await oracle({ out_amount: 0n });
    await expectPass('close . a wiped-out position settles to a zero note',
      'position_close', closeInput(o, 0n));
  }

  {
    // At the knock-out cap.
    const o = await oracle({ out_amount: t.maxPayout });
    await expectPass('close . payout exactly at the tier cap', 'position_close',
      closeInput(o, t.maxPayout));
  }

  // --- soundness ---

  {
    // The direct forge: mint a note bigger than the settlement.
    const o = await oracle({ out_amount: t.margin + 1n });
    await expectFail('close . note larger than the payout', 'position_close',
      closeInput(o, t.margin));
  }

  {
    // The cap is what the vault reserved against. A payout above it would be a
    // claim on money nobody set aside.
    const o = await oracle({ out_amount: t.maxPayout + 1n });
    await expectFail('close . payout above the tier cap', 'position_close',
      closeInput(o, t.maxPayout + 1n));
  }

  {
    // fee > payout would need a negative note. RangeCheck64 on (payout - fee)
    // is what makes that unsatisfiable rather than merely unusual.
    const o = await oracle({ out_amount: 0n });
    await expectFail('close . fee larger than the payout', 'position_close',
      closeInput(o, t.margin, t.margin + 1n));
  }

  {
    // P3/C3: ownership is proved by deriving the key, and the old commitment is
    // contract-supplied. Closing someone else's position must be impossible
    // even knowing its commitment.
    const o = await oracle({ out_amount: t.margin });
    await expectFail('close . closing a position owned by another key',
      'position_close', closeInput(o, t.margin, 0n, { privKey: OTHER_KEY.toString() }));
  }

  {
    // The output note must be addressed to the position's owner.
    const o = await oracle({ out_amount: t.margin });
    const other = await oracle({ out_amount: t.margin, privKey: OTHER_KEY });
    await expectFail('close . paying the settlement to another key', 'position_close',
      closeInput(o, t.margin, 0n,
        { output_note_commitment: other.out_commitment.toString() }));
  }

  {
    // The nullifier must be the one this position produces, or a close could be
    // recorded against a nullifier that never marks the position spent.
    const o = await oracle({ out_amount: t.margin });
    await expectFail('close . a nullifier this position does not produce',
      'position_close', closeInput(o, t.margin, 0n,
        { position_nullifier: (o.pos_nullifier + 1n).toString() }));
  }

  {
    // Settling a tier-0 position as though it were tier-1 would let the trader
    // claim the larger tier's cap.
    const o = await oracle({ out_amount: t.margin });
    await expectFail('close . claiming a different tier than the position has',
      'position_close', closeInput(o, t.margin, 0n, { tier_id: '1' }));
  }

  {
    // The contract passes the stored entry price; a proof built against another
    // one describes a different position.
    const o = await oracle({ out_amount: t.margin });
    await expectFail('close . an entry price other than the committed one',
      'position_close', closeInput(o, t.margin, 0n,
        { entry_price: (ENTRY + 1n).toString() }));
  }

  {
    // Flipping the direction changes which side of the trade is being settled.
    const o = await oracle({ out_amount: t.margin });
    await expectFail('close . flipping the direction', 'position_close',
      closeInput(o, t.margin, 0n, { direction: '0' }));
  }
}

// ---------------------------------------------------------------------------

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
  console.log('\nA failure here is a soundness or completeness regression. Do not register');
  console.log('verification keys from a circuit set in this state.');
  process.exit(1);
}
console.log('All position circuits behaved as expected.');
