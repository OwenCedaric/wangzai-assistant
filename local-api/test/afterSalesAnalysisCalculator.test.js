import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateAfterSalesAnalysis } from '../src/domain/dataAnalysis/calculators/afterSalesAnalysisCalculator.js';

test('after-sales reasons keep official ids and expose verified Chinese labels', () => {
  const result = calculateAfterSalesAnalysis({
    rows: [
      {
        return_id: 'r1',
        posting_number: 'p1',
        status: 'Utilizing',
        return_reason: 'Вы не отгрузили заказ вовремя',
        raw_json: JSON.stringify({ return_reason: { id: 686, name: 'Вы не отгрузили заказ вовремя', is_defect: false } }),
        product_json: JSON.stringify({ name: '商品', price: 10, currency_code: 'CNY' }),
      },
      {
        return_id: 'r2',
        posting_number: 'p2',
        status: 'Utilized',
        return_reason: 'Привезли не тот товар',
        raw_json: JSON.stringify({ return_reason: { id: 22, name: 'Привезли не тот товар', is_defect: true } }),
        product_json: JSON.stringify({ name: '商品', price: 20, currency_code: 'CNY' }),
      },
    ],
  });
  const byId = new Map(result.reasonCodeBreakdown.map((row) => [row.reasonId, row]));
  assert.equal(byId.get('686').reasonLabel, '未按时发货');
  assert.equal(byId.get('22').reasonLabel, '发错商品');
  assert.equal(byId.get('22').isDefect, true);
  assert.equal(result.dataQuality.reasonTextStatus, 'confirmed');
});

test('after-sales amount reports partial coverage instead of treating a missing price as zero', () => {
  const result = calculateAfterSalesAnalysis({
    rows: [
      { return_id: 'r1', product_json: JSON.stringify({ price: 10, currency_code: 'CNY' }) },
      { return_id: 'r2', product_json: JSON.stringify({ currency_code: 'CNY' }) },
    ],
  });
  const metric = result.metrics.find((item) => item.id === 'returnProductAmount');
  assert.equal(metric.value, 10);
  assert.equal(metric.status, 'partial');
  assert.equal(result.dataQuality.amountKnownCount, 1);
  assert.equal(result.dataQuality.amountExpectedCount, 2);
});
