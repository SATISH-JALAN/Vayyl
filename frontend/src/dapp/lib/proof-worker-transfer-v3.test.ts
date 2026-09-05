// ============================================================
// D1: the single-note V3 transfer must be provable
// ============================================================
// `note-selection.ts` returns `needsDummy: true` whenever ONE note covers the
// amount, which is the ordinary case for any wallet that has ever received a
// payment. So this is the common path, not an edge case.
//
// The bug: the worker derived the dummy input from a fresh random blindness but
// handed the circuit `in_blindness2: '0'`. `transfer_v3.circom` constrains
// `note2.nullifier === nullifier2`, rebuilding note2 from `in_blindness2` — so
// the two sides disagreed, the R1CS was unsatisfiable, and `fullProve` threw
// during witness generation. Every single-note transfer failed.
//
// These tests drive the REAL worker (not a copy of its logic): `self` is
// shimmed and `snarkjs` is module-mocked so the witness it assembles can be
// captured. Capturing rather than proving keeps this fast and pins the exact
// constraint that was violated; a real proof against the 19 MB zkey would test
// the same arithmetic far more slowly, and `fullProve`'s absolute `/circuits`
// paths do not resolve outside a browser anyway.

import '../../../test/public-fetch-shim.ts';

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { BASE8, mulPointEscalar } from './babyjub.ts';
import { randomScalar } from './transfer.ts';
import buildWitnessCalculator from './witness_calculator.js';

// ---------------------------------------------------------------------------
// Capture the witness the worker hands to snarkjs.
//
// Must be mocked BEFORE the worker module is imported below, or it binds the
// real implementation.
// ---------------------------------------------------------------------------
const captured: any[] = [];

mock.module('snarkjs', {
  exports: {
    groth16: {
      fullProve: async (input: any) => {
        captured.push(input);
        return {
          proof: { pi_a: [], pi_b: [], pi_c: [] },
          publicSignals: ['0', '0', '0', '0', '0', '0', '0', '0', '0'],
        };
      },
    },
  },
});

// The worker assigns `self.onmessage` at import time, so `self` must exist
// first and must stay the SAME object for every test in this file.
let resolveReply: (v: any) => void = () => {};
(globalThis as any).self = {
  onmessage: null,
  postMessage: (m: any) => resolveReply(m),
};

const workerReady = import('./proof-worker.ts');

async function send(payload: any) {
  await workerReady;
  const reply = new Promise<any>((r) => { resolveReply = r; });
  (globalThis as any).self.onmessage({
    data: { id: 'test', type: 'PROVE_TRANSFER_V3', payload },
  });
  const settled = await reply;
  if (settled.status === 'error') throw new Error(settled.error);
  return captured[captured.length - 1];
}

// --- derive a note exactly as the worker does: through the Note() circuit ----
let calculator: any = null;
async function deriveNote(privKey: string, amount: string, blindness: string) {
  if (!calculator) {
    const wasm = await (await fetch('/circuits/v2/note.wasm')).arrayBuffer();
    calculator = await buildWitnessCalculator(wasm);
  }
  const w = await calculator.calculateWitness({ privKey, amount, blindness }, true);
  return {
    pubX: w[1].toString(),
    pubY: w[2].toString(),
    commitment: w[3].toString(),
    nullifier: w[4].toString(),
  };
}

/** A one-note wallet: the note sits at leaf 0 and nothing else is in the tree. */
async function oneNoteTransfer() {
  const privKey = randomScalar().toString();
  const blindness = randomScalar().toString();
  const amountStroops = '1000000000'; // 100 XLM
  const note = await deriveNote(privKey, amountStroops, blindness);
  const recipientPk = mulPointEscalar(BASE8, randomScalar());

  return {
    privKey,
    in1: { amountStroops, blindness, leafIndex: 0 },
    // no `in2` -> needsDummy, the path that could not prove
    leaves: [note.commitment],
    recipientPubX: recipientPk[0].toString(),
    recipientPubY: recipientPk[1].toString(),
    amountStroops: '370000000', // pay 37, keep 63 as change
  };
}

test('a one-note wallet builds a satisfiable transfer witness', async () => {
  const input = await send(await oneNoteTransfer());

  // The constraint transfer_v3.circom actually enforces on the dummy input.
  // Before the fix, nullifier2 came from a random blindness while in_blindness2
  // was '0', so these two disagreed and no witness existed.
  assert.equal(input.in_amount2, '0', 'the dummy input is worth nothing');
  assert.equal(input.isDummy2, '1');

  const rebuilt = await deriveNote(input.privKey, input.in_amount2, input.in_blindness2);
  assert.equal(
    input.nullifier2,
    rebuilt.nullifier,
    'nullifier2 must be derivable from the in_blindness2 handed to the circuit — ' +
      'this is the D1 unsatisfiable-witness bug',
  );
});

test('the dummy blindness is never zero', async () => {
  // The literal regression. '0' is what the worker used to pass, and it is also
  // the tempting "fix" for the mismatch — see the next test for why it is wrong.
  const input = await send(await oneNoteTransfer());
  assert.notEqual(input.in_blindness2, '0');
  assert.notEqual(input.in_blindness2, 0);
});

test('two single-note transfers from one wallet use different dummy nullifiers', async () => {
  // The trap in the other direction. Deriving the dummy with a CONSTANT
  // blindness would satisfy the circuit but make the dummy nullifier a constant
  // per wallet — so the pool would reject the second single-note transfer as a
  // double spend, on-chain, after the user had already paid for proving.
  const payload = await oneNoteTransfer();
  const first = await send(payload);
  const second = await send(payload);

  assert.notEqual(
    first.in_blindness2,
    second.in_blindness2,
    'the dummy blindness must be fresh per transfer',
  );
  assert.notEqual(
    first.nullifier2,
    second.nullifier2,
    'a repeated dummy nullifier is a double spend the pool will reject',
  );
  // The real input is identical across both, so this is genuinely the dummy
  // moving rather than the whole witness being re-randomised.
  assert.equal(first.nullifier1, second.nullifier1);
});

test('a two-note transfer still uses the caller-supplied blindness', async () => {
  // Guards the other branch of the same ternary: when a second real note IS
  // selected, its own blindness must be used, not a fresh dummy one.
  const base = await oneNoteTransfer();
  const blindness2 = randomScalar().toString();
  const amount2 = '200000000';
  const note2 = await deriveNote(base.privKey, amount2, blindness2);

  const input = await send({
    ...base,
    in2: { amountStroops: amount2, blindness: blindness2, leafIndex: 1 },
    leaves: [...base.leaves, note2.commitment],
  });

  assert.equal(input.in_blindness2, blindness2);
  assert.equal(input.in_amount2, amount2);
  assert.equal(input.nullifier2, note2.nullifier);
  assert.equal(input.isDummy2, '0');
});
