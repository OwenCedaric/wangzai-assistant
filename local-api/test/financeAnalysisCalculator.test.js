import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateFinanceAnalysis } from '../src/domain/dataAnalysis/calculators/financeAnalysisCalculator.js';

test('purchase cost coverage excludes cancelled orders and de-duplicates prefixed legacy identities', () => {
  const result = calculateFinanceAnalysis({
    currentOrderRows: [
      { posting_number: 'active-1', status: 'delivering' },
      { posting_number: 'cancelled-1', status: 'cancelled' },
    ],
    purchaseOverrides: [
      { posting_number: 'active-1', source_cost_cny: 12, updated_at: '2026-07-01' },
      { posting_number: 'client:active-1', source_cost_cny: null, updated_at: '2026-07-02' },
      { posting_number: 'cancelled-1', source_cost_cny: 99, updated_at: '2026-07-01' },
    ],
  });
  const metrics = new Map(result.metrics.map((metric) => [metric.id, metric]));
  assert.equal(metrics.get('confirmedPurchaseCost').value, 12);
  assert.equal(metrics.get('purchaseCostCoverage').value, 100);
  assert.equal(result.purchaseCost.orderCount, 1);
  assert.equal(result.purchaseCost.confirmedCount, 1);
});

test('finance analysis distinguishes official currency fields from settlement-rule inference', () => {
  const result = calculateFinanceAnalysis({
    rows: [
      { operation_key: '1', amount_total: 10, currency_code: '', operation_date: '2026-07-01' },
      { operation_key: '2', amount_total: -2, currency_code: 'RUB', operation_date: '2026-07-01' },
    ],
  });
  assert.equal(result.currencyCoverage.totalRows, 2);
  assert.equal(result.currencyCoverage.officialCurrencyRows, 1);
  assert.equal(result.currencyCoverage.inferredCurrencyRows, 1);
  assert.equal(result.currencyCoverage.percent, 100);
});

test('confirmed purchase cost is partial until every non-cancelled order has a cost', () => {
  const result = calculateFinanceAnalysis({
    currentOrderRows: [
      { posting_number: 'active-1', status: 'delivering' },
      { posting_number: 'active-2', status: 'delivering' },
    ],
    purchaseOverrides: [{ posting_number: 'active-1', source_cost_cny: 12 }],
  });
  const metrics = new Map(result.metrics.map((metric) => [metric.id, metric]));
  assert.equal(metrics.get('confirmedPurchaseCost').value, 12);
  assert.equal(metrics.get('confirmedPurchaseCost').status, 'partial');
  assert.equal(metrics.get('purchaseCostCoverage').value, 50);
});
