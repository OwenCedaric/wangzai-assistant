import assert from 'node:assert/strict';
import test from 'node:test';
import { toDateKey, toFiniteNumber } from '../src/domain/dataAnalysis/lib/dataAnalysisUtils.js';

test('data analysis keeps missing numbers null and preserves real zero', () => {
  assert.equal(toFiniteNumber(null), null);
  assert.equal(toFiniteNumber(undefined), null);
  assert.equal(toFiniteNumber(''), null);
  assert.equal(toFiniteNumber(0), 0);
  assert.equal(toFiniteNumber('0'), 0);
});

test('data analysis converts timezone timestamps to Asia Shanghai business dates', () => {
  assert.equal(toDateKey('2026-06-11T20:30:00Z'), '2026-06-12');
  assert.equal(toDateKey('2026-06-11T01:00:00Z'), '2026-06-11');
  assert.equal(toDateKey('2026-06-11'), '2026-06-11');
  assert.equal(toDateKey('2026-06-11 00:00:00'), '2026-06-11');
});
