import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateSalesAnalysis } from '../src/domain/dataAnalysis/calculators/salesAnalysisCalculator.js';

function order({ id, status, date, price, quantity = 1, offerId = id }) {
  return {
    id,
    order_key: id,
    posting_number: id,
    status,
    in_process_at: `${date}T10:00:00Z`,
    products_json: JSON.stringify([
      { offer_id: offerId, sku: `sku-${offerId}`, name: `商品${offerId}`, price, quantity, currency_code: 'CNY' },
    ]),
  };
}

test('sales amount, units, average, trend and ranking exclude cancelled orders', () => {
  const result = calculateSalesAnalysis({
    rows: [
      order({ id: 'valid', status: 'delivering', date: '2026-07-01', price: 100, offerId: 'valid-offer' }),
      order({ id: 'cancelled', status: 'cancelled', date: '2026-07-01', price: 50, quantity: 3, offerId: 'cancelled-offer' }),
    ],
    range: { startDate: '2026-07-01', endDate: '2026-07-01' },
  });
  const metrics = new Map(result.metrics.map((metric) => [metric.id, metric]));

  assert.equal(metrics.get('orderCount').value, 2);
  assert.equal(metrics.get('effectiveOrderCount').value, 1);
  assert.equal(metrics.get('itemCount').value, 1);
  assert.equal(metrics.get('salesAmount').value, 100);
  assert.equal(metrics.get('averageOrderValue').value, 100);
  assert.equal(metrics.get('cancelledCount').value, 1);
  assert.equal(metrics.get('cancellationRate').value, 50);
  assert.equal(result.trend[0].orderCount, 2);
  assert.equal(result.trend[0].effectiveOrderCount, 1);
  assert.equal(result.trend[0].sales.value, 100);
  assert.deepEqual(result.productRanking.map((row) => row.offerId), ['valid-offer']);
});

test('sales keeps missing quantity unavailable instead of treating it as zero', () => {
  const missingQuantity = order({
    id: 'missing-quantity',
    status: 'delivering',
    date: '2026-07-01',
    price: 100,
  });
  const products = JSON.parse(missingQuantity.products_json);
  delete products[0].quantity;
  missingQuantity.products_json = JSON.stringify(products);

  const result = calculateSalesAnalysis({
    rows: [
      order({ id: 'known', status: 'delivering', date: '2026-07-01', price: 20, quantity: 2 }),
      missingQuantity,
    ],
    range: { startDate: '2026-07-01', endDate: '2026-07-01' },
  });
  const metrics = new Map(result.metrics.map((metric) => [metric.id, metric]));

  assert.equal(metrics.get('itemCount').value, 2);
  assert.equal(metrics.get('itemCount').status, 'partial');
  assert.equal(metrics.get('salesAmount').value, 40);
  assert.equal(metrics.get('salesAmount').status, 'partial');
  assert.equal(result.quality.quantityKnownCount, 1);
  assert.equal(result.quality.amountKnownCount, 1);
  assert.equal(result.productRanking.find((row) => row.offerId === 'missing-quantity').quantity, null);
});
