import assert from 'node:assert/strict';
import test from 'node:test';

import { xlmToStroops } from './amount.ts';

test('converts XLM text to exact stroops', () => {
  assert.equal(xlmToStroops('1'), 10_000_000n);
  assert.equal(xlmToStroops('0.1'), 1_000_000n);
  assert.equal(xlmToStroops('0.0000001'), 1n);
  assert.throws(() => xlmToStroops('0'));
  assert.throws(() => xlmToStroops('0.00000001'));
});
