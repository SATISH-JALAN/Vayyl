// Note-selection policy tests.
//
// The selection rule decides which notes a payment consumes, and getting it
// wrong is expensive in ways types cannot catch: pick badly and a wallet
// fragments into dust it can never spend, because only two inputs fit in one
// transfer. The failure is also delayed — the user discovers it after waiting
// out a proof — so the boundary cases matter more than usual.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectNotes,
  totalSpendable,
  maxSendableInOneTransfer,
  InsufficientNotesError,
} from './note-selection.ts';

const XLM = 10_000_000n;
const note = (id: string, xlm: bigint) => ({ id, amountStroops: (xlm * XLM).toString() });

test('an exact single note leaves no change', () => {
  const s = selectNotes([note('a', 100n), note('b', 37n)], 37n * XLM);
  assert.deepEqual(s.inputs.map((n) => n.id), ['b']);
  assert.equal(s.needsDummy, true);
  assert.equal(s.change, 0n);
});

test('prefers the smallest single note that covers the amount', () => {
  // Spending the 100 would work but strands 63 as change; the 50 is tighter.
  const s = selectNotes([note('big', 100n), note('mid', 50n), note('small', 5n)], 37n * XLM);
  assert.deepEqual(s.inputs.map((n) => n.id), ['mid']);
  assert.equal(s.change, 13n * XLM);
});

test('a one-note wallet still transacts, via a dummy input', () => {
  const s = selectNotes([note('only', 100n)], 37n * XLM);
  assert.equal(s.needsDummy, true);
  assert.equal(s.inputs.length, 1);
  assert.equal(s.change, 63n * XLM);
});

test('falls back to the tightest pair when no single note covers it', () => {
  const s = selectNotes([note('a', 20n), note('b', 30n), note('c', 5n)], 37n * XLM);
  assert.equal(s.needsDummy, false);
  assert.deepEqual(s.inputs.map((n) => n.id).sort(), ['a', 'b']);
  assert.equal(s.total, 50n * XLM);
  assert.equal(s.change, 13n * XLM);
});

test('picks the pair with the least excess, not the first that fits', () => {
  // No single note reaches 80, so the pair rule is genuinely exercised.
  // Candidates: 10+70 = 80 exact, 40+45 = 85, 40+70 = 110, 45+70 = 115.
  // A two-pointer scan that stops at its first covering pair would take 40+45.
  const s = selectNotes([note('a', 10n), note('b', 70n), note('c', 40n), note('d', 45n)], 80n * XLM);
  assert.equal(s.total, 80n * XLM, 'should choose the exact 10 + 70, not 40 + 45');
  assert.deepEqual(s.inputs.map((n) => n.id).sort(), ['a', 'b']);
  assert.equal(s.change, 0n);
});

test('prefers one input over two even when a pair fits tighter', () => {
  // 20+18 = 38 is tighter than the single 40, but spending two notes retires
  // two and creates two, so it does nothing for fragmentation. One input does.
  const s = selectNotes([note('single', 40n), note('a', 20n), note('b', 18n)], 37n * XLM);
  assert.deepEqual(s.inputs.map((n) => n.id), ['single']);
  assert.equal(s.needsDummy, true);
});

test('rejects an amount no two notes can cover, even with the balance for it', () => {
  // 4 x 20 = 80 total, but the biggest two only reach 40. This is a real limit
  // of a 2-input circuit and must surface as such, not as a silent under-pay.
  const notes = [note('a', 20n), note('b', 20n), note('c', 20n), note('d', 20n)];
  assert.equal(totalSpendable(notes), 80n * XLM);
  assert.throws(
    () => selectNotes(notes, 50n * XLM),
    (err: unknown) => {
      assert.ok(err instanceof InsufficientNotesError);
      assert.equal(err.spendable, 80n * XLM);
      assert.equal(err.bestPair, 40n * XLM);
      assert.match(err.message, /largest two together hold/);
      return true;
    },
  );
});

test('reports plain insufficiency differently from fragmentation', () => {
  assert.throws(
    () => selectNotes([note('a', 5n)], 50n * XLM),
    /Not enough shielded balance/,
  );
});

test('maxSendableInOneTransfer is the top two, not the balance', () => {
  const notes = [note('a', 20n), note('b', 20n), note('c', 20n), note('d', 20n)];
  assert.equal(totalSpendable(notes), 80n * XLM);
  assert.equal(maxSendableInOneTransfer(notes), 40n * XLM);
});

test('ignores zero-amount notes', () => {
  // Exact payments emit a zero change note; it is a real leaf but worth nothing
  // and must never be chosen as an input.
  const s = selectNotes([note('zero', 0n), note('real', 40n)], 37n * XLM);
  assert.deepEqual(s.inputs.map((n) => n.id), ['real']);
  assert.equal(maxSendableInOneTransfer([note('zero', 0n), note('real', 40n)]), 40n * XLM);
});

test('rejects a non-positive amount', () => {
  assert.throws(() => selectNotes([note('a', 10n)], 0n), /greater than zero/);
});

test('handles amounts that exceed Number.MAX_SAFE_INTEGER', () => {
  // Stroops are i128 on-chain. Any arithmetic that round-trips through a JS
  // number silently loses precision above 2^53, which would mis-price a note.
  const huge = (2n ** 60n).toString();
  const s = selectNotes([{ id: 'huge', amountStroops: huge }], 2n ** 59n);
  assert.equal(s.total, 2n ** 60n);
  assert.equal(s.change, 2n ** 60n - 2n ** 59n);
});
