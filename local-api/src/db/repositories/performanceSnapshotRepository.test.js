import assert from 'node:assert/strict';
import test from 'node:test';
import { createPerformanceSnapshotRepository } from './performanceSnapshotRepository.js';
import { createMigratedTestDb, saveUnitShop } from '../../../test/testDb.js';
import { createShopRepository } from './shopRepository.js';

test('performance snapshots stay isolated by shop, account and date range', () => {
  const db = createMigratedTestDb();
  try {
    const shops = createShopRepository(db);
    const shopOne = saveUnitShop(shops, 'performance-snapshot-shop-1');
    const shopTwo = saveUnitShop(shops, 'performance-snapshot-shop-2');
    const repository = createPerformanceSnapshotRepository(db);
    const request = (shopId, accountId = 'performance-account-1') => ({
      values: { shopId, accountId, dateFrom: '2026-08-06', dateTo: '2026-08-13', readDepth: 'dashboard' },
    });
    repository.saveSnapshot(request(shopOne), {
      ok: true,
      readDepth: 'dashboard',
      finishedAt: '2026-08-13T08:00:00.000Z',
      campaigns: [{ id: 'one' }],
    });

    assert.equal(repository.readBestSnapshot(request(shopOne)).payload.campaigns[0].id, 'one');
    assert.equal(repository.readBestSnapshot(request(shopTwo)), null);
    assert.equal(repository.readBestSnapshot(request(shopOne, 'another-account')), null);
    assert.equal(repository.readBestSnapshot({ values: { ...request(shopOne).values, dateFrom: '2026-08-07' } }), null);
  } finally {
    db.close();
  }
});

test('performance instant-open snapshot keeps latest metrics and richer product details together', () => {
  const db = createMigratedTestDb();
  try {
    const shopId = saveUnitShop(createShopRepository(db), 'performance-snapshot-merge-shop');
    const repository = createPerformanceSnapshotRepository(db);
    const request = (readDepth) => ({
      values: {
        shopId,
        accountId: 'performance-snapshot-merge-account',
        dateFrom: '2026-08-06',
        dateTo: '2026-08-13',
        readDepth,
      },
    });
    repository.saveSnapshot(request('products'), {
      ok: true,
      readDepth: 'products',
      finishedAt: '2026-08-13T07:59:00.000Z',
      summary: { spent: 10 },
      campaigns: [{ id: 'campaign-1', statistics: { spent: 10 }, products: [{ sku: 'sku-1' }] }],
      dataSets: { campaignProducts: { status: 'success', rows: [{ sku: 'sku-1' }] } },
    });
    repository.saveSnapshot(request('dashboard'), {
      ok: true,
      readDepth: 'dashboard',
      finishedAt: '2026-08-13T08:00:00.000Z',
      summary: { spent: 20 },
      campaigns: [{ id: 'campaign-1', statistics: { spent: 20 }, products: [] }],
      dataSets: { campaignProducts: { status: 'skipped', rows: [] } },
    });

    const snapshot = repository.readBestSnapshot(request('snapshot')).payload;
    assert.equal(snapshot.summary.spent, 20);
    assert.equal(snapshot.campaigns[0].statistics.spent, 20);
    assert.equal(snapshot.campaigns[0].products[0].sku, 'sku-1');
    assert.equal(snapshot.dataSets.campaignProducts.status, 'success');
  } finally {
    db.close();
  }
});
