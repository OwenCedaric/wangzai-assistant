import { expect, it } from 'vitest';
import { buildRowsIndex, queryRowsIndex, buildStatusCounts, filterRowsByStatus, paginateRows } from '../../../../services/localMirrorDataset';
import { shouldIncludeOrderInBusinessFlow } from '../../../../services/orderSplitRelationRules';
import { doesAssociatedOrderMatchKeyword } from '../../../../entities/profit/profitSearchRules.jsx';
import { sortOrderRowsByNewestPaymentTime } from '../../../../services/orderTimeSortRules';
import { getPurchaseOrderPaymentDateKey, getPurchaseOrderRecordKey, purchaseOrderStageTabs } from '../lib/purchaseMarketingApi.jsx';
import { countPurchaseOrderModule, isPurchaseOrderStageMatch } from '../lib/purchaseOrderNormalize.jsx';
import { createPurchaseOrderSearchIndex, purchaseOrderSearchIndexOptions } from './purchaseOrderSearchIndex.js';
import { createPurchaseOrderRangeReader } from './purchaseOrderRangeReadModel.js';

const fixture = () => Array.from({ length: 500 }, (_, i) => ({
  id: `ORDER-${i}`, shopId: `shop-${i % 5}`, shopClientId: `client-${i % 5}`, shop: `店铺${i % 5}`,
  salesOrder: `ORDER-${i}`, ozonOrderId: `OZON-${i}`, product: `商品 ${i % 7}`, sku: `SKU-${i}`,
  fulfillment: i % 2 ? 'FBS' : 'FBO', amount: String(i),
  ozonStatus: ['awaiting_packaging', 'awaiting_deliver', 'delivering', 'delivered', 'cancelled', 'returned', 'unknown'][i % 7],
  forcePurchaseStatus: i % 4 ? '' : purchaseOrderStageTabs[i % purchaseOrderStageTabs.length].value,
  paymentDate: i % 11 ? `2026-09-0${i % 6 + 1}T12:00:00Z` : '',
  purchaseManagementStartedAt: i % 3 ? '' : '2026-09-04T00:00:00Z',
  raw: i % 11 ? { paid_at: `2026-09-0${i % 6 + 1}T12:00:00Z` } : {},
  purchaseOrderNo: i % 2 ? `BUY-${i}` : '', buyerPlatform: '拼多多', purchasePrice: '20', purchaseOrderStatus: '已付款',
  packageOrderId: i % 5 ? '' : `BUS-${i}`, purchaseRecordStatus: i % 13 ? 'valid' : 'voided',
  purchaseRefundConfirmed: i % 17 === 0, afterSaleClosed: i % 19 === 0, afterSaleStatus: i % 23 === 0,
  isSplitParent: i % 29 === 0, splitDefaultBusinessHidden: i % 29 === 0, splitBusinessLocked: i % 29 === 0,
}));
const legacyIndex = rows => buildRowsIndex(rows, { ...purchaseOrderSearchIndexOptions,
  getRowStatuses: order => purchaseOrderStageTabs.filter(tab => isPurchaseOrderStageMatch(order, tab.value)).map(tab => tab.value),
});
function legacyRange(index, q) {
  return queryRowsIndex(index, { shopScope: q.selectedShopScope, keyword: q.keyword }).filter(order => {
    const date = getPurchaseOrderPaymentDateKey(order);
    return shouldIncludeOrderInBusinessFlow(order) && (q.fulfillment === 'all' || order.fulfillment === q.fulfillment)
      && doesAssociatedOrderMatchKeyword(order, q.keyword, [order.shop, order.supplier, order.product, order.sku,
        order.searchText, order.purchaseOrderNo, order.packageOrderId])
      && (!q.paymentStartKey || !date || date >= q.paymentStartKey)
      && (!q.paymentEndKey || !date || date <= q.paymentEndKey);
  });
}
const baseQuery = { selectedShopScope: 'all', keyword: '', fulfillment: 'all', paymentStartKey: '', paymentEndKey: '' };

it('matches the previous full-range filtering, all stage/module counts, page order and cross-page key selection', () => {
  const rows = fixture(), oldIndex = legacyIndex(rows), index = createPurchaseOrderSearchIndex()(rows);
  expect(index).toEqual(oldIndex);
  const read = createPurchaseOrderRangeReader();
  for (const selectedShopScope of ['all', 'shop-1', ['shop-0', 'shop-3'], 'missing']) {
    for (const keyword of ['', 'ORDER-18', 'SKU-77', 'BUY-35', 'BUS-10', '商品', 'missing']) {
      for (const extras of [{}, { fulfillment: 'FBS' }, { paymentStartKey: '2026-09-03', paymentEndKey: '2026-09-05' }]) {
        const q = { ...baseQuery, selectedShopScope, keyword, ...extras };
        const expected = legacyRange(oldIndex, q), result = read(index, q);
        expect(result.rows).toEqual(expected);
        expect(result.stageCounts).toEqual(buildStatusCounts(expected, purchaseOrderStageTabs, { allValue: 'all', matchesStatus: isPurchaseOrderStageMatch }));
        expect(result.moduleCounts).toEqual(Object.fromEntries(['all', '待拍单', 'exception', 'afterSales'].map(key => [key, countPurchaseOrderModule(expected, key)])));
        for (const { value: status } of purchaseOrderStageTabs) {
          const filtered = input => sortOrderRowsByNewestPaymentTime(filterRowsByStatus(input, status, { allValue: 'all', matchesStatus: isPurchaseOrderStageMatch }));
          const actualRows = filtered(result.rows), expectedRows = filtered(expected);
          expect(actualRows.map(getPurchaseOrderRecordKey)).toEqual(expectedRows.map(getPurchaseOrderRecordKey));
          expect(paginateRows(actualRows, 2, 20)).toEqual(paginateRows(expectedRows, 2, 20));
        }
      }
    }
  }
});

it('reuses only the exact current snapshot and bounded query range, never stale rows or old owner generations', () => {
  const rows = fixture(), build = createPurchaseOrderSearchIndex(), read = createPurchaseOrderRangeReader();
  const index = build(rows), all = read(index, baseQuery);
  read(index, { ...baseQuery, keyword: 'ORDER-18' });
  expect(read(index, baseQuery)).toBe(all);
  for (let i = 0; i < 13; i++) read(index, { ...baseQuery, keyword: `unique-${i}` });
  expect(read(index, baseQuery)).not.toBe(all);
  const updated = rows.map(row => ({ ...row, amount: '999', image: 'new-image', shopIncarnation: 'new' }));
  const next = read(build(updated), baseQuery);
  expect(next.rows.find(row => row.id === updated[1].id)).toBe(updated[1]);
  expect(next.rows.every(row => row.amount === '999')).toBe(true);
  const changed = updated.map(row => ({ ...row, forcePurchaseStatus: '关闭单' }));
  const closed = read(build(changed), baseQuery);
  expect(closed.stageCounts).toEqual(buildStatusCounts(closed.rows, purchaseOrderStageTabs, { matchesStatus: isPurchaseOrderStageMatch }));
  expect(read(build([]), baseQuery).moduleCounts).toEqual({ all: 0, '待拍单': 0, exception: 0, afterSales: 0 });
});
