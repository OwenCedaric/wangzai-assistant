import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPerformanceDataSet,
  firstPerformanceBidRubles,
  firstPerformanceBudgetRubles,
  normalizeLowerText,
  normalizePerformanceBidRubles,
  normalizePerformanceBudgetRubles,
  normalizeText,
  pickArrayPayload,
  toFiniteNumber,
  toPerformancePayloadRows,
} from './performanceApiNormalization.js';

test('performance normalization keeps existing Ozon values and units after extraction', () => {
  assert.equal(normalizeText('  Ozon  '), 'Ozon');
  assert.equal(normalizeLowerText('  RUNNING  '), 'running');
  assert.equal(toFiniteNumber('1 234,56 ₽'), 1234.56);
  assert.equal(normalizePerformanceBudgetRubles(12_000_000), 12);
  assert.equal(firstPerformanceBudgetRubles({ weeklyBudget: 25_000_000 }, ['weeklyBudget']), 25);
  assert.equal(normalizePerformanceBidRubles(12), 12);
  assert.equal(normalizePerformanceBidRubles(12_000_000), 12);
  assert.equal(firstPerformanceBidRubles({ bid: 8_500_000 }, ['bid']), 8.5);
  assert.deepEqual(pickArrayPayload({ items: [{ id: 1 }] }), [{ id: 1 }]);
  assert.deepEqual(toPerformancePayloadRows({ status: 'ok' }), [{ status: 'ok' }]);
  assert.deepEqual(
    createPerformanceDataSet({ key: 'orders', label: '推广订单', endpoint: '/orders', rows: [] }),
    {
      key: 'orders',
      label: '推广订单',
      endpoint: '/orders',
      status: 'empty',
      count: 0,
      fields: [],
      rows: [],
      note: '',
    },
  );
});
