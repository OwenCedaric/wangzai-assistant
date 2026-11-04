import { expect, it } from 'vitest';
import { buildRowsIndex, queryRowsIndex } from '../../../../services/localMirrorDataset';
import { createPurchaseOrderSearchIndex, purchaseOrderSearchIndexOptions } from './purchaseOrderSearchIndex.js';

const fixture = () => Array.from({ length: 200 }, (_, i) => ({
  id: `order-${i}`, shopId: `shop-${i % 3}`, shopClientId: ` client-${i % 3}`,
  shop: `店铺${i % 3}`, status: '待拍单', product: `商品 ${i % 9}`, sku: `SKU-${i}`, amount: '¥10.00',
  salesOrder: `order-${i}`, ozonOrderId: `ozon-${i}`, searchText: `order-${i} 商品`,
}));
function equivalent(actual, rows) {
  const expected = buildRowsIndex(rows, purchaseOrderSearchIndexOptions);
  expect(actual).toEqual(expected);
  for (const keyword of ['', 'order-18', 'SKU-77', '商品', 'missing']) {
    for (const shopScope of ['all', 'shop-1', ['shop-0', 'shop-2']]) {
      expect(queryRowsIndex(actual, { keyword, shopScope })).toEqual(queryRowsIndex(expected, { keyword, shopScope }));
    }
  }
}

it('reuses unchanged search structures while replacing every current image/money/detail row', () => {
  const read = createPurchaseOrderSearchIndex(), rows = fixture();
  const before = read(rows);
  equivalent(before, rows);
  const updated = rows.map(row => ({ ...row, image: 'new-image', amount: '¥123.45', raw: { newest: true } }));
  const after = read(updated);
  expect(after.keysByToken).toBe(before.keysByToken);
  expect(after.rowsByKey).not.toBe(before.rowsByKey);
  equivalent(after, updated);
  expect([...after.rowsByKey.values()][0]).toBe(updated[0]);
});

it('rebuilds on changed search, status, ownership, order, insertion, removal and duplicate identities', () => {
  const mutations = [
    rows => [{ ...rows[0], sku: 'replacement' }, ...rows.slice(1)],
    rows => [{ ...rows[0], forcePurchaseStatus: '关闭单', manualClassifiedAt: '2026-09-07' }, ...rows.slice(1)],
    rows => [{ ...rows[0], shopId: 'another-owner' }, ...rows.slice(1)],
    rows => rows.slice().reverse(), rows => rows.slice(1), rows => rows.concat({ ...rows[0], id: 'new-order' }),
    rows => rows.concat(rows[0]), rows => [],
  ];
  for (const mutate of mutations) {
    const read = createPurchaseOrderSearchIndex(), rows = fixture();
    read(rows);
    const changed = mutate(rows);
    equivalent(read(changed), changed);
  }
});
