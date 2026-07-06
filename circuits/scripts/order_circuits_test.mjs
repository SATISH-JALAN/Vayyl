#!/usr/bin/env node
// ============================================================
// Order-circuit soundness test  (Sprint E)
// ============================================================
// Witness-level pass/fail tests for hidden_order_trigger + sealed_order. For
// each circuit we assert a VALID witness generates cleanly and a MALFORMED one
// that the new soundness constraints must reject is in fact rejected.
//
// Constraints under test (system design §2.9 / §2.12):
//   · commitment binding: hash3(a,b,salt) === order_commitment
//   · order_direction boolean
//   · trigger fired via selector-on-the-selected-value: gap in [0,2^64). An
//     UNTRIGGERED order (price hasn't crossed) yields a field-negative gap and
//     must be rejected — this is what stops early execution.
//   · RangeCheck64 on trigger/oracle/bid magnitudes.
//
// Commitments are computed by test/oracle_order.circom (same Poseidon2 template
// the real circuits use), so "valid" is byte-consistent — the only thing that
// can reject a malformed witness is the constraint under test.
//
// No trusted setup needed: constraint violations fail at witness generation.
// Usage: node scripts/order_circuits_test.mjs   (exit 0 = all as expected)
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
const TWO64 = 1n << 64n;

mkdirSync(BUILD, { recursive: true });

const compiled = new Map();
function compile(name, srcPath) {
  if (compiled.has(name)) return compiled.get(name);
  console.log(`  · compiling ${name} …`);
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
  return wc.calculateWitness(input, true);
}
async function commitment(a, b, salt) {
  const { nameToIdx } = compiled.get('oracle_order');
  const w = await witness('oracle_order', { a: a.toString(), b: b.toString(), salt: salt.toString() });
  return BigInt(w[nameToIdx.get('main.commitment')]);
}

let failures = 0;
async function expectPass(label, name, input) {
  try { await witness(name, input); console.log(`  ✅ PASS  ${label}`); }
  catch (e) { failures++; console.log(`  ❌ FAIL  ${label} — valid witness REJECTED: ${e.message.split('\n')[0]}`); }
}
async function expectFail(label, name, input) {
  try { await witness(name, input); failures++; console.log(`  ❌ FAIL  ${label} — malformed witness ACCEPTED (unsound!)`); }
  catch { console.log(`  ✅ PASS  ${label} — malformed witness rejected as expected`); }
}

console.log('=== Order-circuit soundness (hidden_order_trigger · sealed_order) ===\n');
compile('oracle_order', resolve(CIRCUITS, 'test', 'oracle_order.circom'));
compile('hidden_order_trigger', resolve(CIRCUITS, 'hidden_order_trigger.circom'));
compile('sealed_order', resolve(CIRCUITS, 'sealed_order.circom'));

const SALT = 12345n;
const META = 777n;

// ---------- HIDDEN ORDER TRIGGER ----------
console.log('\n-- hidden_order_trigger --');
{
  // direction=1: fires when oracle >= trigger.
  const trig = async (trigger_price, direction, oracle_price, saltOverride) => {
    const salt = saltOverride ?? SALT;
    const c = await commitment(trigger_price, direction, salt);
    return {
      order_commitment: c.toString(),
      oracle_price: oracle_price.toString(),
      meta_hash: META.toString(),
      trigger_price: trigger_price.toString(),
      order_direction: direction.toString(),
      salt: salt.toString(),
    };
  };

  // Up-order (dir=1) trigger 1000; oracle 1500 >= 1000 → fired.
  await expectPass('up-order fired (oracle 1500 >= trigger 1000)', 'hidden_order_trigger',
    await trig(1000n, 1n, 1500n));
  // Up-order not yet fired: oracle 800 < 1000 → gap negative → must reject.
  await expectFail('up-order NOT fired (oracle 800 < trigger 1000) rejected', 'hidden_order_trigger',
    await trig(1000n, 1n, 800n));

  // Down-order (dir=0) trigger 1000; oracle 700 <= 1000 → fired.
  await expectPass('down-order fired (oracle 700 <= trigger 1000)', 'hidden_order_trigger',
    await trig(1000n, 0n, 700n));
  // Down-order not yet fired: oracle 1200 > 1000 → reject.
  await expectFail('down-order NOT fired (oracle 1200 > trigger 1000) rejected', 'hidden_order_trigger',
    await trig(1000n, 0n, 1200n));

  // Wrong commitment opening (salt mismatch): pass a witness whose private
  // trigger/dir/salt don't hash to the public commitment → binding fails.
  {
    const c = await commitment(1000n, 1n, SALT);
    await expectFail('forged opening (salt mismatch) rejected', 'hidden_order_trigger', {
      order_commitment: c.toString(),
      oracle_price: '1500',
      meta_hash: META.toString(),
      trigger_price: '1000',
      order_direction: '1',
      salt: '99999', // != SALT used in the commitment
    });
  }

  // Non-boolean direction = 2.
  {
    const c = await commitment(1000n, 2n, SALT);
    await expectFail('non-boolean direction rejected', 'hidden_order_trigger', {
      order_commitment: c.toString(),
      oracle_price: '1500',
      meta_hash: META.toString(),
      trigger_price: '1000',
      order_direction: '2',
      salt: SALT.toString(),
    });
  }

  // oracle_price >= 2^64 (range check).
  await expectFail('oracle_price >= 2^64 rejected', 'hidden_order_trigger',
    await trig(1000n, 1n, TWO64));
}

// ---------- SEALED ORDER ----------
console.log('\n-- sealed_order --');
{
  const sealed = async (bid_price, bid_size, saltForWitness) => {
    const c = await commitment(bid_price, bid_size, SALT);
    return {
      order_commitment: c.toString(),
      bid_price: bid_price.toString(),
      bid_size: bid_size.toString(),
      salt: (saltForWitness ?? SALT).toString(),
    };
  };

  await expectPass('valid sealed order opening', 'sealed_order', await sealed(2500n, 3n));
  await expectFail('forged opening (salt mismatch) rejected', 'sealed_order',
    await sealed(2500n, 3n, 88888n));
  await expectFail('bid_price >= 2^64 rejected', 'sealed_order', await sealed(TWO64, 3n));
  await expectFail('bid_size >= 2^64 rejected', 'sealed_order', await sealed(2500n, TWO64));
}

console.log(`\n${failures === 0 ? '✅ all cases behaved as expected' : `❌ ${failures} regression(s)`}`);
process.exit(failures === 0 ? 0 : 1);
