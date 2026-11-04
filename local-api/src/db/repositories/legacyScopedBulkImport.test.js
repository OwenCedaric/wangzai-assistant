import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductRepository } from './productRepository.js';
import { createPurchaseOrderOverrideRepository } from './purchaseOrderOverrideRepository.js';
import { createPurchaseSourceLinkRepository } from './purchaseSourceLinkRepository.js';
import { createSalesSourceLinkRepository } from './salesSourceLinkRepository.js';
import { createShopRepository } from './shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from '../../../test/testDb.js';

function sourceLinks(prefix) {
  return [
    { slotIndex: 0, isPrimary: true, link: `https://source.test/${prefix}/0`, productId: `${prefix}-0`, platform: '1688' },
    { slotIndex: 1, link: `https://source.test/${prefix}/1`, productId: `${prefix}-1`, platform: 'PDD' },
  ];
}

test('product source legacy bulk import validates all scoped slots before one transaction and exposes a cursor page', () => {
  const db = createMigratedTestDb();
  try {
    const shops = createShopRepository(db);
    saveUnitShop(shops, 'shop-product-bulk');
    const repository = createProductRepository(db);
    const result = repository.importLegacyProductSourceLinks([
      { shopId: 'shop-product-bulk', productKey: 'offer-a', primaryIndex: 0, links: sourceLinks('product-a') },
      { shopId: 'shop-product-bulk', productKey: 'offer-b', primaryIndex: 1, links: sourceLinks('product-b') },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.importedCount, 2);
    assert.equal(result.scopeCount, 1);
    assert.equal(typeof result.digest, 'string');

    const first = repository.listProductSourceLinksPage({ cursorMode: 'legacy-migration', limit: 1 });
    assert.equal(first.total, 4);
    assert.equal(first.rows.length, 1);
    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor);
    const second = repository.listProductSourceLinksPage({
      cursorMode: 'legacy-migration',
      limit: 10,
      cursor: first.nextCursor,
    });
    assert.equal(second.rows.length, 3);
    assert.equal(second.hasMore, false);
    assert.equal(second.nextCursor, '');

    assert.throws(
      () => repository.importLegacyProductSourceLinks([
        { shopId: 'shop-product-bulk', productKey: 'offer-c', links: sourceLinks('product-c') },
        {
          shopId: 'shop-product-bulk',
          productKey: 'offer-d',
          links: [{ slotIndex: 0, link: 'https://source.test/a' }, { slotIndex: 0, link: 'https://source.test/b' }],
        },
      ]),
      /SLOT_DUPLICATE/,
    );
    assert.equal(repository.listProductSourceLinksPage({ cursorMode: 'legacy-migration', limit: 10 }).total, 4);
  } finally {
    db.close();
  }
});

test('purchase and sales source legacy bulk imports reject scope conflicts atomically and retain slot identity', () => {
  const db = createMigratedTestDb();
  try {
    const shops = createShopRepository(db);
    saveUnitShop(shops, 'shop-sales-bulk');
    const purchase = createPurchaseSourceLinkRepository(db);
    const sales = createSalesSourceLinkRepository(db);

    const purchaseResult = purchase.importLegacyLinks([
      { shopId: 'shop-purchase-bulk', orderKey: 'purchase-1', primaryIndex: 1, links: sourceLinks('purchase-1') },
      { shopId: 'shop-purchase-bulk', orderKey: 'purchase-2', primaryIndex: 0, links: sourceLinks('purchase-2') },
    ]);
    assert.deepEqual(
      { ok: purchaseResult.ok, importedCount: purchaseResult.importedCount, scopeCount: purchaseResult.scopeCount },
      { ok: true, importedCount: 2, scopeCount: 1 },
    );
    const purchasePage = purchase.listLinks({ cursorMode: 'legacy-migration', limit: 1 });
    assert.equal(purchasePage.total, 4);
    assert.equal(purchasePage.hasMore, true);
    assert.ok(purchasePage.nextCursor);

    assert.throws(
      () => sales.importLegacyLinks([
        { shopId: 'shop-sales-bulk', orderKey: 'sales-1', links: sourceLinks('sales-1') },
        {
          shopId: 'shop-sales-bulk',
          orderKey: 'sales-2',
          links: [{ shopId: 'wrong-shop', slotIndex: 0, link: 'https://source.test/wrong' }],
        },
      ]),
      /SCOPE_MISMATCH/,
    );
    assert.equal(sales.listLinks({ cursorMode: 'legacy-migration', limit: 10 }).total, 0);

    const salesResult = sales.importLegacyLinks([
      { shopId: 'shop-sales-bulk', orderKey: 'sales-1', primaryIndex: 0, links: sourceLinks('sales-1') },
      { shopId: 'shop-sales-bulk', orderKey: 'sales-2', primaryIndex: 1, links: sourceLinks('sales-2') },
    ]);
    assert.equal(salesResult.importedCount, 2);
    const salesPage = sales.listLinks({ cursorMode: 'legacy-migration', limit: 10 });
    assert.equal(salesPage.total, 4);
    assert.equal(salesPage.rows.filter((row) => row.isPrimary).length, 2);
  } finally {
    db.close();
  }
});

test('purchase override legacy bulk import preserves scoped updatedAt and never echoes raw source fields', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPurchaseOrderOverrideRepository(db);
    const imported = repository.importLegacyOverrides([
      {
        shopId: 'shop-override-bulk',
        orderKey: 'override-1',
        manualBuyerPlatform: 'PDD',
        updatedAt: '2026-07-13T01:02:03.000Z',
        raw: { manualCustomValue: 'keep-me', impossibleSecret: 'must-not-echo' },
      },
      {
        shopId: 'shop-override-bulk',
        orderKey: 'override-2',
        manualPurchaseOrderNo: 'purchase-2',
        updatedAt: '2026-07-13T01:02:04.000Z',
      },
    ]);
    assert.equal(imported.importedCount, 2);
    assert.equal(JSON.stringify(imported).includes('must-not-echo'), false);
    const first = repository.listOverrides({ cursorMode: 'legacy-migration', limit: 1 });
    assert.equal(first.total, 2);
    assert.equal(first.hasMore, true);
    const second = repository.listOverrides({ cursorMode: 'legacy-migration', limit: 10, cursor: first.nextCursor });
    assert.equal(second.rows.length, 1);
    const all = [...first.rows, ...second.rows];
    assert.equal(all.find((row) => row.orderKey === 'override-1').updatedAt, '2026-07-13T01:02:03.000Z');

    assert.throws(
      () => repository.importLegacyOverrides([
        { shopId: 'shop-override-bulk', orderKey: 'override-3' },
        { shopId: 'shop-override-bulk', orderKey: 'override-3' },
      ]),
      /RECORD_DUPLICATE/,
    );
    assert.equal(repository.listOverrides({ cursorMode: 'legacy-migration', limit: 10 }).total, 2);
  } finally {
    db.close();
  }
});

test('purchase override normal upsert clears all purchase columns and rejects unsafe shop scopes', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPurchaseOrderOverrideRepository(db);
    const identity = { shopId: 'shop-override-clear', orderKey: 'client-clear:posting-1' };
    repository.upsertOverride({
      ...identity,
      purchasePlatform: '1688',
      purchaseOrderNumber: 'purchase-old',
      purchaseOrderUrl: 'https://source.test/purchase-old',
      sourceCostCny: 25.8,
      manualStatus: '已付款',
    });
    repository.upsertOverride({
      ...identity,
      clearFields: [
        'purchasePlatform',
        'purchaseOrderNumber',
        'purchaseOrderUrl',
        'sourceCostCny',
        'manualStatus',
      ],
      forcePurchaseStatus: '待拍单',
    });

    const cleared = repository.getOverride(identity);
    assert.equal(cleared.purchasePlatform, '');
    assert.equal(cleared.purchaseOrderNumber, '');
    assert.equal(cleared.purchaseOrderUrl, '');
    assert.equal(cleared.sourceCostCny, null);
    assert.equal(cleared.manualStatus, '');
    assert.deepEqual(cleared.clearFields, [
      'purchasePlatform',
      'purchaseOrderNumber',
      'purchaseOrderUrl',
      'sourceCostCny',
      'manualStatus',
    ]);
    assert.equal(cleared.forcePurchaseStatus, '待拍单');

    assert.throws(
      () => repository.upsertOverride({ shopId: '', orderKey: 'posting-empty' }),
      /PURCHASE_OVERRIDE_SHOP_SCOPE_REQUIRED/,
    );
    assert.throws(
      () => repository.upsertOverride({ shopId: 'default', orderKey: 'posting-default' }),
      /PURCHASE_OVERRIDE_SHOP_SCOPE_REQUIRED/,
    );
  } finally {
    db.close();
  }
});

test('purchase override partial writes never erase plugin-confirmed domestic logistics', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPurchaseOrderOverrideRepository(db);
    const identity = { shopId: 'shop-logistics-preserve', orderKey: '4097603:64720469-0563-1' };
    repository.upsertOverride({
      ...identity,
      purchaseOrderNumber: '3316981152254029783',
      domesticCourierCompany: '中通快递(ZTO)',
      domesticTrackingNumber: '79028134877723',
      domesticLogisticsStatus: '已发货',
      domesticLogisticsSource: 'cross-border-bus-plugin-original-v1.0.8',
    });
    repository.upsertOverride({
      ...identity,
      purchaseOrderNumber: '3316981152254029783',
      sourceCostCny: 5.69,
      manualStatus: '已发货',
    });

    const saved = repository.getOverride(identity);
    assert.equal(saved.domesticCourierCompany, '中通快递(ZTO)');
    assert.equal(saved.domesticTrackingNumber, '79028134877723');
    assert.equal(saved.domesticLogisticsStatus, '已发货');
    assert.equal(saved.domesticLogisticsSource, 'cross-border-bus-plugin-original-v1.0.8');
  } finally {
    db.close();
  }
});

test('purchase override legacy bulk import applies clearFields to existing rows atomically', () => {
  const db = createMigratedTestDb();
  try {
    const repository = createPurchaseOrderOverrideRepository(db);
    const shopId = 'shop-override-bulk-clear';
    repository.upsertOverride({
      shopId,
      orderKey: 'client-clear:posting-1',
      purchasePlatform: '1688',
      purchaseOrderNumber: 'purchase-old-1',
      purchaseOrderUrl: 'https://source.test/purchase-old-1',
      sourceCostCny: 36.5,
      manualStatus: '已发货',
    });
    repository.upsertOverride({
      shopId,
      orderKey: 'client-clear:posting-2',
      purchasePlatform: 'PDD',
      purchaseOrderNumber: 'purchase-old-2',
      sourceCostCny: 18,
    });

    const result = repository.importLegacyOverrides([
      {
        shopId,
        orderKey: 'client-clear:posting-1',
        clearFields: [
          'purchasePlatform',
          'purchaseOrderNumber',
          'purchaseOrderUrl',
          'sourceCostCny',
          'manualStatus',
        ],
        raw: { forcePurchaseStatus: '待拍单' },
        updatedAt: '2026-07-17T02:00:00.000Z',
      },
      {
        shopId,
        orderKey: 'client-clear:posting-2',
        raw: { manualProfitLogisticsFeeCny: 4.2 },
        updatedAt: '2026-07-17T02:00:01.000Z',
      },
    ]);

    assert.equal(result.importedCount, 2);
    const cleared = repository.getOverride({ shopId, orderKey: 'client-clear:posting-1' });
    assert.equal(cleared.purchasePlatform, '');
    assert.equal(cleared.purchaseOrderNumber, '');
    assert.equal(cleared.purchaseOrderUrl, '');
    assert.equal(cleared.sourceCostCny, null);
    assert.equal(cleared.manualStatus, '');
    assert.equal(cleared.forcePurchaseStatus, '待拍单');
    assert.equal(
      repository.getOverride({ shopId, orderKey: 'client-clear:posting-2' }).manualProfitLogisticsFeeCny,
      4.2,
    );
  } finally {
    db.close();
  }
});
