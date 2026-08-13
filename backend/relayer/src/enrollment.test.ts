import assert from 'node:assert/strict';
import test from 'node:test';

import { INITIAL_ASP_LEAVES, normalizeAspLeaf } from './enrollment.js';

test('normalizes valid ASP leaves and rejects invalid field values', () => {
    assert.equal(normalizeAspLeaf('00042'), '42');
    assert.throws(() => normalizeAspLeaf('not-a-field'));
    assert.throws(() => normalizeAspLeaf('0'));
    assert.throws(() => normalizeAspLeaf('21888242871839275222246405745257275088548364400416034343698204186575808495617'));
});

test('seed ASP leaves are well-formed and distinct', () => {
    // A bare length check used to stand here, and it is exactly what let a stale
    // sixth leaf survive: the count was pinned, the contents were never checked.
    // Every entry must survive normalisation (so it is a canonical in-field
    // decimal) and appear once, since duplicates would shift every later index.
    for (const leaf of INITIAL_ASP_LEAVES) {
        assert.equal(normalizeAspLeaf(leaf), leaf, `${leaf} is not canonical`);
    }
    assert.equal(
        new Set(INITIAL_ASP_LEAVES).size,
        INITIAL_ASP_LEAVES.length,
        'seed contains duplicate leaves',
    );
    // Pins the live tree this seed is meant to mirror (asp-membership
    // CD5DLTOI..., re-bootstrapped 2026-08-02, leaf_count = 5). The authoritative
    // check is AspEnrollmentService.verifyAgainstChain() at startup; this only
    // catches an edit that forgets the tree it has to match.
    assert.equal(INITIAL_ASP_LEAVES.length, 5);
});
