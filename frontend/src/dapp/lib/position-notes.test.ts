// ============================================================
// Position note derivation: agreement with the circuit, and recovery
// ============================================================
// The first group is the one that matters most. Every value here is computed in
// TypeScript and consumed by a Circom circuit, and the two have no shared
// implementation -- the JS goes through the compiled hash2/hash4 witness
// calculators, the circuit through its own templates. If they disagree the
// wallet builds a commitment its own proof cannot open, and the failure appears
// on-chain as an opaque verification error with nothing naming the cause.
//
// So these tests compare against the REAL fixture in
// contracts/groth16-verifier/src/real_position_fixture.rs, which was produced
// by proving the actual circuit. Matching it is proof that the two
// implementations agree, not an assertion that they should.

import '../../../test/public-fetch-shim.ts';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { computeCommitment, computeNullifier, poseidon2Hash4 } from './poseidon.ts';
import { derivePublicKey } from './babyjub.ts';
import {
  asShieldedNote,
  changeBlindness,
  deriveChangeNote,
  derivePayoutNote,
  derivePositionCommitment,
  payoutBlindness,
  positionBlindness,
  positionIdHex,
  randomPositionId,
  recoverPositionNotes,
} from './position-notes.ts';
import { getTier, TIERS } from './tiers.ts';
import { FIELD_P } from './poseidon.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The exact witness the fixture generator used (circuits/scripts/gen_position_fixture.mjs). */
const FIXTURE = {
  privKey: 444n,
  noteAmount: 1_500_000_000n,
  noteBlindness: 333n,
  changeBlindness: 334n,
  positionBlindness: 555n,
  outBlindness: 777n,
  entry: 10_000_000n,
  positionId: 0x5eedn,
  closePrice: 11_000_000n,
};

function fixtureInputs(name: 'POSITION_OPEN' | 'POSITION_CLOSE'): bigint[] {
  const src = readFileSync(
    resolve(REPO, 'contracts/groth16-verifier/src/real_position_fixture.rs'),
    'utf8',
  );
  const m = src.match(new RegExp(`${name}_PUBLIC_INPUTS[^=]*=\\s*\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`${name}_PUBLIC_INPUTS not found -- regenerate the fixture`);
  return [...m[1].matchAll(/"([0-9a-f]{64})"/g)].map((g) => BigInt('0x' + g[1]));
}

// ---------------------------------------------------------------------------
// Agreement with the circuit
// ---------------------------------------------------------------------------

test('the JS position commitment equals the one the circuit proved', async () => {
  const t = getTier(0);
  const { pubX, pubY } = derivePublicKey(FIXTURE.privKey);
  const meta = await poseidon2Hash4(t.size, 1n, FIXTURE.entry, FIXTURE.positionBlindness);
  const commitment = await poseidon2Hash4(t.marginStroops, pubX, pubY, meta);

  const [, , positionCommitment] = fixtureInputs('POSITION_OPEN');
  assert.equal(commitment, positionCommitment,
    'PositionCommitment field order differs between TypeScript and Circom');
});

test('the JS collateral nullifier equals the one the circuit proved', async () => {
  // This exercises derivePublicKey (BabyJubjub scalar mul) as well as the two
  // hashes -- if the key derivation drifted, the commitment would too.
  const { pubX, pubY } = derivePublicKey(FIXTURE.privKey);
  const commitment = await computeCommitment(
    FIXTURE.noteAmount, pubX, pubY, FIXTURE.noteBlindness,
  );
  const nullifier = await computeNullifier(commitment, FIXTURE.privKey);

  const [, fixtureNullifier] = fixtureInputs('POSITION_OPEN');
  assert.equal(nullifier, fixtureNullifier);
});

test('the JS change note equals the one the circuit proved', async () => {
  const t = getTier(0);
  const { pubX, pubY } = derivePublicKey(FIXTURE.privKey);
  const changeAmount = FIXTURE.noteAmount - t.marginStroops;
  const commitment = await computeCommitment(
    changeAmount, pubX, pubY, FIXTURE.changeBlindness,
  );

  const [, , , changeCommitment] = fixtureInputs('POSITION_OPEN');
  assert.equal(commitment, changeCommitment);
});

test('the JS payout note equals the one the circuit proved', async () => {
  const t = getTier(0);
  const { pubX, pubY } = derivePublicKey(FIXTURE.privKey);
  const payout = t.marginStroops + t.size * (FIXTURE.closePrice - FIXTURE.entry);
  const commitment = await computeCommitment(payout, pubX, pubY, FIXTURE.outBlindness);

  const [, outputNoteCommitment] = fixtureInputs('POSITION_CLOSE');
  assert.equal(commitment, outputNoteCommitment);
});

test('the fixture public inputs carry the tier, price, direction and id the contract sends', () => {
  // Ordering is a contract between position-manager and the circuit that
  // nothing at runtime checks. Pinning the scalar slots here means a reorder in
  // either place fails a test rather than every real proof.
  const open = fixtureInputs('POSITION_OPEN');
  assert.equal(open.length, 8);
  assert.equal(open[4], 0n, 'slot 4 is tier_id');
  assert.equal(open[5], FIXTURE.entry, 'slot 5 is entry_price');
  assert.equal(open[6], 1n, 'slot 6 is direction');
  assert.equal(open[7], FIXTURE.positionId, 'slot 7 is position_id');

  const close = fixtureInputs('POSITION_CLOSE');
  assert.equal(close.length, 9);
  assert.equal(close[3], 0n, 'slot 3 is tier_id');
  assert.equal(close[4], FIXTURE.entry, 'slot 4 is entry_price');
  assert.equal(close[5], 1n, 'slot 5 is direction');
  assert.equal(close[6], getTier(0).marginStroops + getTier(0).size * 1_000_000n, 'slot 6 is payout');
  assert.equal(close[7], 0n, 'slot 7 is fee');
  assert.equal(close[8], FIXTURE.positionId, 'slot 8 is position_id');
});

// ---------------------------------------------------------------------------
// Deterministic blindness
// ---------------------------------------------------------------------------

test('blindness is reproducible from the spend key and the position id alone', async () => {
  // This is the whole recovery story: no ephemeral point, no stored secret.
  // Clearing the browser must not cost the user their change or their payout.
  const a = await changeBlindness(444n, 0x5eedn);
  const b = await changeBlindness(444n, 0x5eedn);
  assert.equal(a, b);
});

test('the three derived blindings differ from each other', async () => {
  // They are derived from the SAME (key, position) pair, so without domain tags
  // the position commitment, the change note and the payout note would all
  // share a blinding factor -- and two notes of the same amount would collide
  // into one commitment, making the second unspendable.
  const [pos, change, payout] = await Promise.all([
    positionBlindness(444n, 0x5eedn),
    changeBlindness(444n, 0x5eedn),
    payoutBlindness(444n, 0x5eedn),
  ]);
  assert.equal(new Set([pos, change, payout].map(String)).size, 3);
});

test('a different position id gives different blindings', async () => {
  assert.notEqual(await changeBlindness(444n, 1n), await changeBlindness(444n, 2n));
});

test('a different spend key gives different blindings', async () => {
  // The secrecy of the blinding factor rests entirely on the spend key. If it
  // did not vary with the key, anyone could recompute anyone's notes.
  assert.notEqual(await changeBlindness(444n, 1n), await changeBlindness(445n, 1n));
});

// ---------------------------------------------------------------------------
// Position ids
// ---------------------------------------------------------------------------

test('a generated position id is a canonical field element', () => {
  // The contract passes it straight through as a public input, and the verifier
  // rejects anything at or above the BN254 modulus (C1). A raw 32-byte value
  // would put roughly one open in eight into an unexplainable revert.
  for (let i = 0; i < 50; i++) {
    const id = randomPositionId();
    assert.ok(id >= 0n && id < FIELD_P, `id ${id} is out of the field`);
  }
});

test('position ids are distinct', () => {
  const ids = new Set(Array.from({ length: 50 }, () => randomPositionId().toString()));
  assert.equal(ids.size, 50);
});

test('the hex encoding is exactly 32 bytes', () => {
  assert.equal(positionIdHex(1n).length, 64);
  assert.equal(positionIdHex(1n), '0'.repeat(63) + '1');
  assert.equal(positionIdHex(0x5eedn).length, 64);
});

// ---------------------------------------------------------------------------
// Note construction
// ---------------------------------------------------------------------------

test('the change note is the collateral note minus the tier margin', async () => {
  const t = getTier(0);
  const note = await deriveChangeNote(444n, 1n, t, 1_500_000_000n);
  assert.equal(note.amountStroops, 1_500_000_000n - t.marginStroops);
});

test('a note exactly equal to the margin yields zero change', async () => {
  const t = getTier(0);
  const note = await deriveChangeNote(444n, 1n, t, t.marginStroops);
  assert.equal(note.amountStroops, 0n);
});

test('a note too small for the tier is refused with a usable message', async () => {
  // The circuit's conservation constraint would reject this too, but only after
  // the user waited for a proof. Saying so here is the difference between a
  // sentence they can act on and a snarkjs stack trace.
  const t = getTier(1);
  await assert.rejects(
    () => deriveChangeNote(444n, 1n, t, t.marginStroops - 1n),
    (e: Error) => {
      assert.match(e.message, /needs/);
      assert.match(e.message, new RegExp(t.name));
      return true;
    },
  );
});

test('the payout note is the settlement net of the fee', async () => {
  const note = await derivePayoutNote(444n, 1n, 130_000_000n, 500_000n);
  assert.equal(note.amountStroops, 129_500_000n);
});

test('a fee above the payout is refused', async () => {
  await assert.rejects(() => derivePayoutNote(444n, 1n, 100n, 101n), /fee is larger/);
});

test('a wiped-out position still derives a valid zero note', async () => {
  // It must, or the position could never be closed and its vault reserve never
  // freed.
  const note = await derivePayoutNote(444n, 1n, 0n, 0n);
  assert.equal(note.amountStroops, 0n);
  assert.ok(note.commitment > 0n, 'a zero-value note is still a real leaf');
});

test('the position commitment helper agrees with the raw formula', async () => {
  const t = getTier(0);
  const { commitment, blindness } = await derivePositionCommitment(444n, 7n, t, 1, 10_000_000n);
  const { pubX, pubY } = derivePublicKey(444n);
  const meta = await poseidon2Hash4(t.size, 1n, 10_000_000n, blindness);
  assert.equal(commitment, await poseidon2Hash4(t.marginStroops, pubX, pubY, meta));
  assert.equal(blindness, await positionBlindness(444n, 7n));
});

// ---------------------------------------------------------------------------
// Recovery on a clean device
// ---------------------------------------------------------------------------

test('every note a position produced is recoverable from public data plus the spend key', async () => {
  const t = getTier(0);
  const collateral = 1_500_000_000n;
  const positions = [
    { positionId: '1', tierId: 0, direction: 1 as const, entryPrice: '10000000', closed: false },
    {
      positionId: '2', tierId: 0, direction: 1 as const, entryPrice: '10000000',
      closed: true, payout: '130000000', fee: '0',
    },
  ];

  const notes = await recoverPositionNotes(444n, positions, () => collateral);

  // Two changes (one per open) plus one payout (the closed one).
  assert.equal(notes.length, 3);
  assert.equal(notes.filter((n) => n.source === 'change').length, 2);
  const payout = notes.find((n) => n.source === 'payout')!;
  assert.equal(payout.amountStroops, 130_000_000n);

  // And each recovered commitment matches what a fresh derivation produces,
  // which is what lets the wallet find the leaf in the pool tree.
  const expected = await deriveChangeNote(444n, 1n, t, collateral);
  assert.equal(notes[0].commitment, expected.commitment);
});

test('recovery skips zero-value notes rather than listing empty entries', async () => {
  const t = getTier(0);
  const notes = await recoverPositionNotes(
    444n,
    [{ positionId: '1', tierId: 0, direction: 1, entryPrice: '10000000', closed: true, payout: '0', fee: '0' }],
    () => t.marginStroops, // exact margin -> zero change
  );
  assert.equal(notes.length, 0);
});

test('recovery works without knowing the collateral, for the payout half', async () => {
  // A wallet restored on a clean device may not know which note funded an old
  // position. The payout is still fully recoverable, because its amount is
  // public in the close event.
  const notes = await recoverPositionNotes(
    444n,
    [{ positionId: '1', tierId: 0, direction: 1, entryPrice: '10000000', closed: true, payout: '130000000' }],
    () => undefined,
  );
  assert.equal(notes.length, 1);
  assert.equal(notes[0].source, 'payout');
});

test('a recovered note is shaped for the wallet store', async () => {
  const note = await derivePayoutNote(444n, 1n, 130_000_000n, 0n);
  const shaped = asShieldedNote(note, 444n, 'CPOOL', 'payout', 'abc123');
  assert.equal(shaped.protocol, 'v3');
  assert.equal(shaped.amountStroops, '130000000');
  assert.equal(shaped.amount, 13);
  assert.equal(shaped.leafIndex, -1, 'resolved by the indexer before proving');
  assert.equal(shaped.isSpent, false);
  assert.equal(shaped.txHash, 'abc123');
  assert.equal(shaped.id, shaped.commitment);
});

test('all tiers can derive a change note', async () => {
  for (const tier of TIERS) {
    const note = await deriveChangeNote(444n, 1n, tier, tier.marginStroops * 2n);
    assert.equal(note.amountStroops, tier.marginStroops);
  }
});
