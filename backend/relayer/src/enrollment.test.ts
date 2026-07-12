import assert from 'node:assert/strict';
import test from 'node:test';

import { INITIAL_ASP_LEAVES, normalizeAspLeaf } from './enrollment.js';

test('normalizes valid ASP leaves and rejects invalid field values', () => {
    assert.equal(normalizeAspLeaf('00042'), '42');
    assert.equal(INITIAL_ASP_LEAVES.length, 6);
    assert.throws(() => normalizeAspLeaf('not-a-field'));
    assert.throws(() => normalizeAspLeaf('0'));
    assert.throws(() => normalizeAspLeaf('21888242871839275222246405745257275088548364400416034343698204186575808495617'));
});
