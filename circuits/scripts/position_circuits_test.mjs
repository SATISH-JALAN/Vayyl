#!/usr/bin/env node
// ============================================================
// Position-circuit soundness test  (Sprint C)
// ============================================================
// Witness-level pass/fail tests for the positions vertical. For each circuit
// we assert:
//   (a) a VALID witness (all interior values consistent) generates cleanly, and
//   (b) a MALFORMED witness that the NEW soundness constraints must reject is
//       in fact rejected by calculateWitness's constraint sanity check.
//
// The constraints under test (audit H1) are:
//   · RangeCheck64 on the magnitudes that feed the size*price multiplications
//     (size / entry_price / oracle_price / collateral). Without them an
//     attacker picks values whose products wrap mod p back into the checked
//     window and forges a solvent position / balanced settlement.
//   · position_close old_direction boolean — old_direction drives the
//     settlement selector (2*old_direction-1); left unconstrained the settled
//     PnL (and extractable note_amount) is attacker-chosen.
//
// Interior values (commitments / nullifiers / roots / keeper hash / derived
// pubkey) are computed by test/oracle_position.circom, built from the SAME
// library templates the real circuits use — so "valid" means byte-consistent
// with the real hash, no hand-rolled JS Poseidon2 that could silently drift.
//
// No trusted setup / ptau needed: constraint violations fail at witness
// generation. Usage:  node scripts/position_circuits_test.mjs
// Exit 0 = all cases behaved as expected; exit 1 = a regression.
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
const TWO64 = 1n << 64n; // first value that fails RangeCheck64

mkdirSync(BUILD, { recursive: true });

const compiled = new Map(); // name -> { wcPromise, nameToIdx }

function compile(name, srcPath) {
  if (compiled.has(name)) return compiled.get(name);
  console.log(`  · compiling ${name} …`);
  execSync(`circom "${srcPath}" --wasm --sym -o "${BUILD}" -l "${NODE_MODULES}"`,
    { stdio: ['ignore', 'ignore', 'inherit'] });

  const wcBuilder = require(resolve(BUILD, `${name}_js`, 'witness_calculator.js'));
  const wasm = readFileSync(resolve(BUILD, `${name}_js`, `${name}.wasm`));

  // Map signal name -> witness index via the .sym file (format: s,w,c,name)
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
const PATH_INDICES = range(DEPTH, (i) => BigInt(i % 2)); // valid path bits
const PRIV_KEY = 444n;                                   // < BJJ subgroup order
const NOTE_BLIND = 333n;
const POS_BLIND = 555n;
const KEEPER_SECRET = 999n;

const ORACLE_OUTPUTS = [
  'pubX', 'pubY', 'note_commitment', 'note_nullifier',
  'note_root', 'pos_commitment', 'pos_nullifier', 'keeper_commitment',
];

// Recompute all interior values for one position from the library templates.
// Any override (e.g. size = 2^64) flows into the real hashes so commitments and
// nullifiers stay byte-consistent — the ONLY thing that can then reject a
// malformed witness is the constraint under test, never a stale commitment.
async function oracle(overrides = {}) {
  const p = {
    amount: 100n, blindness: NOTE_BLIND, privKey: PRIV_KEY,
    size: 2n, direction: 1n, entry_price: 1000n,
    position_blindness: POS_BLIND, keeper_secret: KEEPER_SECRET,
    ...overrides,
  };
  const input = {
    amount: p.amount.toString(),
    blindness: p.blindness.toString(),
    privKey: p.privKey.toString(),
    pathElements: PATH_ELEMENTS.map(String),
    pathIndices: PATH_INDICES.map(String),
    size: p.size.toString(),
    direction: p.direction.toString(),
    entry_price: p.entry_price.toString(),
    position_blindness: p.position_blindness.toString(),
    keeper_secret: p.keeper_secret.toString(),
  };
  const o = await namedOutputs('oracle_position', input, ORACLE_OUTPUTS);
  return { ...o, p };
}

// ---- assertion helpers -----------------------------------------------------

let failures = 0;
async function expectPass(label, name, input) {
  try {
    await witness(name, input);
    console.log(`  ✅ PASS  ${label}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ FAIL  ${label} — valid witness was REJECTED: ${e.message.split('\n')[0]}`);
  }
}
async function expectFail(label, name, input) {
  try {
    await witness(name, input);
    failures++;
    console.log(`  ❌ FAIL  ${label} — malformed witness was ACCEPTED (unsound!)`);
  } catch {
    console.log(`  ✅ PASS  ${label} — malformed witness rejected as expected`);
  }
}

// ---- run -------------------------------------------------------------------

console.log('=== Position-circuit soundness (open · health · close · heartbeat) ===\n');

compile('oracle_position', resolve(CIRCUITS, 'test', 'oracle_position.circom'));
compile('position_open', resolve(CIRCUITS, 'position_open.circom'));
compile('position_health', resolve(CIRCUITS, 'position_health.circom'));
compile('position_close', resolve(CIRCUITS, 'position_close.circom'));
compile('liquidation_heartbeat', resolve(CIRCUITS, 'liquidation_heartbeat.circom'));

const META_HASH = 777n;

// ---------- POSITION OPEN ----------
console.log('\n-- position_open --');
{
  const openInput = (o) => ({
    root: o.note_root.toString(),
    nullifier: o.note_nullifier.toString(),
    position_commitment: o.pos_commitment.toString(),
    meta_hash: META_HASH.toString(),
    amount: o.p.amount.toString(),
    pubX: o.pubX.toString(),
    pubY: o.pubY.toString(),
    blindness: o.p.blindness.toString(),
    privKey: o.p.privKey.toString(),
    pathElements: PATH_ELEMENTS.map(String),
    pathIndices: PATH_INDICES.map(String),
    size: o.p.size.toString(),
    direction: o.p.direction.toString(),
    entry_price: o.p.entry_price.toString(),
    position_blindness: o.p.position_blindness.toString(),
  });

  await expectPass('open · valid witness', 'position_open', openInput(await oracle()));
  await expectFail('open · amount >= 2^64 (range check)', 'position_open',
    openInput(await oracle({ amount: TWO64 })));
  await expectFail('open · size >= 2^64 (range check)', 'position_open',
    openInput(await oracle({ size: TWO64 })));
}

// ---------- POSITION HEALTH ----------
console.log('\n-- position_health --');
{
  // direction=1 (long): gain when oracle >= entry. Solvent-with-margin when
  //   HEALTH_SCALE*(collateral + gain) >= HEALTH_SCALE*loss + size*oracle*threshold.
  // price_ge_entry is the sign selector pinned by a 65-bit range check; the test
  // supplies its TRUE value (or an override to exercise the selector soundness).
  const HEALTH_SCALE = 10000n;
  const healthInput = (o, oracle_price, threshold = 500n, sel = undefined) => ({
    position_commitment: o.pos_commitment.toString(),
    oracle_price: oracle_price.toString(),
    oracle_timestamp: 42n.toString(),
    health_threshold: threshold.toString(),
    collateral_amount: o.p.amount.toString(),
    size: o.p.size.toString(),
    direction: o.p.direction.toString(),
    entry_price: o.p.entry_price.toString(),
    pubX: o.pubX.toString(),
    pubY: o.pubY.toString(),
    position_blindness: o.p.position_blindness.toString(),
    price_ge_entry: (sel !== undefined ? sel
      : (oracle_price >= o.p.entry_price ? 1n : 0n)).toString(),
  });

  // Long, entry 1000, oracle 1500, size 2, collateral 100:
  //   gain = (1500-1000)*2 = 1000, equity = 1100, notional = 2*1500 = 3000.
  await expectPass('health · valid solvent witness (threshold 500)', 'position_health',
    healthInput(await oracle(), 1500n));

  // Maintenance-margin boundary: same solvent position, higher threshold.
  //   required = notional*threshold ; lhs = HEALTH_SCALE*equity = 11,000,000.
  //   threshold 100  -> required   300,000  <= 11,000,000  → healthy (accept)
  //   threshold 4000 -> required 12,000,000 >  11,000,000  → below margin (reject)
  await expectPass('health · within maintenance margin (threshold 100)', 'position_health',
    healthInput(await oracle(), 1500n, 100n));
  await expectFail('health · below maintenance margin rejected (threshold 4000)', 'position_health',
    healthInput(await oracle(), 1500n, 4000n));

  // Selector soundness: oracle(1500) >= entry(1000) so the TRUE selector is 1.
  // Forcing price_ge_entry = 0 makes selected_delta = entry-oracle = -500 (field
  // p-500, ~254 bits) → the 65-bit range check must reject.
  await expectFail('health · wrong price_ge_entry selector rejected', 'position_health',
    healthInput(await oracle(), 1500n, 500n, 0n));

  // size >= 2^64: solvency still holds in-field (lhs,rhs fit), so pre-fix this
  // FORGED position verified. The RangeCheck64 on size must reject it.
  await expectFail('health · size >= 2^64 (mod-p wrap vector)', 'position_health',
    healthInput(await oracle({ size: TWO64 }), 1500n));

  // entry_price >= 2^64 (short so it stays solvent): must be rejected.
  await expectFail('health · entry_price >= 2^64 (range check)', 'position_health',
    healthInput(await oracle({ direction: 0n, entry_price: TWO64 }), 1500n));

  // oracle_price >= 2^64 (public input, not in commitment): must be rejected.
  await expectFail('health · oracle_price >= 2^64 (range check)', 'position_health',
    healthInput(await oracle(), TWO64));

  void HEALTH_SCALE;
}

// ---------- POSITION CLOSE ----------
console.log('\n-- position_close --');
{
  // Valid settlement with real PnL. old long @1000, oracle 1500, size 2:
  //   lhs = 100 + 2*1500 = 3100 ; rhs = new_col + note + fee + 2*1000
  //   => new_col + note + fee = 1100  (1000 + 90 + 10)
  const oldPos = await oracle();                             // long, size 2, entry 1000
  const newPos = await oracle({ amount: 1000n, size: 1n, direction: 0n, entry_price: 1200n });
  const outNote = await oracle({ amount: 90n, blindness: 111n }); // its note_commitment is the output note

  const closeBase = {
    position_nullifier: oldPos.pos_nullifier.toString(),
    new_position_commitment: newPos.pos_commitment.toString(),
    output_note_commitment: outNote.note_commitment.toString(),
    oracle_price: 1500n.toString(),
    fee: 10n.toString(),
    meta_hash: META_HASH.toString(),
    old_collateral: 100n.toString(),
    old_size: 2n.toString(),
    old_direction: 1n.toString(),
    old_entry_price: 1000n.toString(),
    old_pubX: oldPos.pubX.toString(),
    old_pubY: oldPos.pubY.toString(),
    old_blindness: POS_BLIND.toString(),
    old_privKey: PRIV_KEY.toString(),
    new_collateral: 1000n.toString(),
    new_size: 1n.toString(),
    new_direction: 0n.toString(),
    new_entry_price: 1200n.toString(),
    new_pubX: newPos.pubX.toString(),
    new_pubY: newPos.pubY.toString(),
    new_blindness: POS_BLIND.toString(),
    note_amount: 90n.toString(),
    note_pubX: outNote.pubX.toString(),
    note_pubY: outNote.pubY.toString(),
    note_blindness: 111n.toString(),
  };
  await expectPass('close · valid settlement', 'position_close', closeBase);

  // --- isolation construction for the failing cases ---
  // Set oracle_price == old_entry_price so asset_val == debt_val and old_size
  // cancels from the balance equation. Then the settlement holds for ANY old_size
  // and ANY old_direction value, so the ONLY constraint that can reject is the
  // one under test — no stale-commitment or unbalanced-settlement masking.
  //   lhs = old_collateral + old_size*V ; rhs = new+note+fee + old_size*V
  //   => new_collateral + note_amount + fee = old_collateral = 100  (80+15+5)
  // Dedicated commitments matching the zero-PnL amounts (new_collateral=80,
  // note_amount=15) so only the constraint under test can reject.
  const zpNewPos = await oracle({ amount: 80n, size: 1n, direction: 0n, entry_price: 1200n });
  const zpOutNote = await oracle({ amount: 15n, blindness: 111n });
  const zeroPnl = (oldOracle) => {
    const nPos = zpNewPos, oNote = zpOutNote;
    return {
      position_nullifier: oldOracle.pos_nullifier.toString(),
      new_position_commitment: nPos.pos_commitment.toString(),
      output_note_commitment: oNote.note_commitment.toString(),
      oracle_price: 1000n.toString(),     // == old_entry_price
      fee: 5n.toString(),
      meta_hash: META_HASH.toString(),
      old_collateral: 100n.toString(),
      old_size: oldOracle.p.size.toString(),
      old_direction: oldOracle.p.direction.toString(),
      old_entry_price: 1000n.toString(),
      old_pubX: oldOracle.pubX.toString(),
      old_pubY: oldOracle.pubY.toString(),
      old_blindness: POS_BLIND.toString(),
      old_privKey: PRIV_KEY.toString(),
      new_collateral: 80n.toString(),
      new_size: 1n.toString(),
      new_direction: 0n.toString(),
      new_entry_price: 1200n.toString(),
      new_pubX: nPos.pubX.toString(),
      new_pubY: nPos.pubY.toString(),
      new_blindness: POS_BLIND.toString(),
      note_amount: 15n.toString(),
      note_pubX: oNote.pubX.toString(),
      note_pubY: oNote.pubY.toString(),
      note_blindness: 111n.toString(),
    };
  };

  // Sanity: the zero-PnL construction itself is a valid witness (old_size=2,
  // old_direction=1) — proves the failing cases below fail on the intended
  // constraint, not an artifact of the construction.
  await expectPass('close · zero-PnL construction is valid', 'position_close',
    zeroPnl(await oracle({ size: 2n, direction: 1n })));

  // old_size >= 2^64: the mod-p wrap vector. Balanced (old_size cancels),
  // commitment matches — only the new RangeCheck64 on old_size rejects.
  await expectFail('close · old_size >= 2^64 (mod-p wrap vector)', 'position_close',
    zeroPnl(await oracle({ size: TWO64, direction: 1n })));

  // old_direction = 2 (non-boolean): drives the settlement selector. Balanced
  // and commitment matches — only the new boolean constraint rejects.
  await expectFail('close · old_direction = 2 (arbitrary-PnL forge)', 'position_close',
    zeroPnl(await oracle({ size: 2n, direction: 2n })));
}

// ---------- LIQUIDATION HEARTBEAT ----------
console.log('\n-- liquidation_heartbeat --');
{
  const hbInput = (o) => ({
    position_commitment: o.pos_commitment.toString(),
    keeper_public_commitment: o.keeper_commitment.toString(),
    timestamp: 42n.toString(),
    collateral_amount: o.p.amount.toString(),
    size: o.p.size.toString(),
    direction: o.p.direction.toString(),
    entry_price: o.p.entry_price.toString(),
    pubX: o.pubX.toString(),
    pubY: o.pubY.toString(),
    position_blindness: o.p.position_blindness.toString(),
    keeper_secret: KEEPER_SECRET.toString(),
  });

  await expectPass('heartbeat · valid witness', 'liquidation_heartbeat',
    hbInput(await oracle()));
  await expectFail('heartbeat · size >= 2^64 (range check)', 'liquidation_heartbeat',
    hbInput(await oracle({ size: TWO64 })));
}

console.log(`\n${failures === 0 ? '✅ all cases behaved as expected' : `❌ ${failures} regression(s)`}`);
process.exit(failures === 0 ? 0 : 1);
