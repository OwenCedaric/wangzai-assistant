import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOrderLikeCacheQueryWithDefaultRange } from './orderTimeRange.js';

test('all-history cache reads remain unbounded', () => {
  const query = normalizeOrderLikeCacheQueryWithDefaultRange(
    { allHistory: '1', shopIds: 'shop-a,shop-b' },
    { now: '2026-08-30T12:00:00.000Z' }
  );

  assert.equal(query.allHistory, '1');
  assert.equal(query.since, '');
  assert.equal(query.to, '');
});

test('ordinary cache reads keep the existing 90-day default', () => {
  const query = normalizeOrderLikeCacheQueryWithDefaultRange(
    { shopIds: 'shop-a,shop-b' },
    { now: '2026-08-30T12:00:00.000Z' }
  );

  assert.equal(query.since, '2026-06-01T12:00:00.000Z');
  assert.equal(query.to, '2026-08-30T12:00:00.000Z');
});

test('an explicit range still wins over the all-history flag', () => {
  const query = normalizeOrderLikeCacheQueryWithDefaultRange({
    allHistory: '1',
    since: '2026-08-01T00:00:00.000Z',
    to: '2026-08-02T00:00:00.000Z',
  });

  assert.equal(query.since, '2026-08-01T00:00:00.000Z');
  assert.equal(query.to, '2026-08-02T00:00:00.000Z');
});
