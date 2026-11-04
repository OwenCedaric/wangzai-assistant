import assert from 'node:assert/strict';
import test from 'node:test';
import { createPerformanceSnapshotRepository } from '../src/db/repositories/performanceSnapshotRepository.js';
import { createMigratedTestDb } from './testDb.js';

function request(readDepth, extra = {}) {
  return {
    values: {
      accountId: 'performance-a',
      shopId: 'shop-a',
      dateFrom: '2026-08-07',
      dateTo: '2026-08-13',
      readDepth,
      ...extra,
    },
  };
}

test('performance snapshots keep broad totals and independently merge object/search campaign details', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare(`
      INSERT INTO shops (id, name, status)
      VALUES (?, ?, ?)
    `).run('shop-a', '测试店铺', 'active');
    const repository = createPerformanceSnapshotRepository(db);
    repository.saveSnapshot(request('dashboard'), {
      ok: true,
      readDepth: 'dashboard',
      finishedAt: '2026-08-13T13:00:00.000Z',
      summary: { total: 39, spent: 72.65 },
      campaigns: [
        {
          id: 'c1',
          title: '计划一',
          products: [{ sku: 's1', clicks: 33, spent: 13.88 }],
          objects: [],
          statistics: { clicks: 33, spent: 13.88 },
        },
        { id: 'c2', title: '计划二', products: [], objects: [], statistics: { clicks: 8 } },
      ],
      dailyStats: [{ campaignId: 'c1', clicks: 33 }],
      dataSets: {
        dailyStatistics: { status: 'success', rows: [{ campaignId: 'c1' }] },
        campaignProducts: { status: 'success', count: 1, rows: [{ sku: 's1' }] },
      },
    });
    repository.saveSnapshot(request('detail', { campaignId: 'c1', includeCampaignObjects: true }), {
      ok: true,
      readDepth: 'detail',
      finishedAt: '2026-08-13T13:01:00.000Z',
      summary: { total: 1 },
      campaigns: [{
        id: 'c1',
        products: [{ sku: 's1', clicks: null, spent: null }],
        objects: [{ objectId: 's1' }],
        detailRead: { products: true, objects: true, bidInsights: false },
        detailAvailability: { objects: { status: 'success' } },
      }],
      dataSets: { campaignObjects: { status: 'success', rows: [{ objectId: 's1' }] } },
    });
    repository.saveSnapshot(request('detail', { campaignId: 'c1', includeBidInsights: true }), {
      ok: true,
      readDepth: 'detail',
      finishedAt: '2026-08-13T13:02:00.000Z',
      summary: { total: 1 },
      campaigns: [{
        id: 'c1',
        products: [{ sku: 's1', competitiveBid: 1.2 }],
        objects: [],
        detailRead: { products: true, objects: false, bidInsights: true },
        detailAvailability: { bidInsights: { status: 'success' } },
      }],
      dataSets: { campaignBidInsights: { status: 'success', rows: [{ sku: 's1' }] } },
    });

    const snapshot = repository.readBestSnapshot(request('dashboard'));
    assert.equal(snapshot.payload.summary.total, 39);
    assert.equal(snapshot.payload.summary.productCount, 1);
    assert.equal(snapshot.payload.campaigns.length, 2);
    const campaign = snapshot.payload.campaigns.find((row) => row.id === 'c1');
    assert.equal(campaign.objects.length, 1);
    assert.equal(campaign.products[0].competitiveBid, 1.2);
    assert.equal(campaign.products[0].clicks, 33);
    assert.equal(campaign.products[0].spent, 13.88);
    assert.equal(campaign.statistics.clicks, 33);
    assert.equal(campaign.statistics.spent, 13.88);
    assert.equal(campaign.detailRead.objects, true);
    assert.equal(campaign.detailRead.bidInsights, true);
    assert.equal(campaign.detailAvailability.objects.status, 'success');
    assert.equal(campaign.detailAvailability.bidInsights.status, 'success');
    assert.equal(snapshot.payload.dataSets.dailyStatistics.status, 'success');
    assert.equal(snapshot.payload.dataSets.campaignProducts.count, 1);
  } finally {
    db.close();
  }
});

test('performance snapshot merge accepts authoritative zero metrics', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare(`INSERT INTO shops (id, name, status) VALUES (?, ?, ?)`).run('shop-a', '测试店铺', 'active');
    const repository = createPerformanceSnapshotRepository(db);
    repository.saveSnapshot(request('products'), {
      ok: true,
      readDepth: 'products',
      finishedAt: '2026-08-13T13:00:00.000Z',
      summary: { total: 1, productCount: 1 },
      campaigns: [{
        id: 'c1',
        products: [{ sku: 's1', clicks: 8, spent: 4 }],
        objects: [],
        statistics: { clicks: 8, spent: 4 },
        detailRead: { products: true },
      }],
    });
    repository.saveSnapshot(request('detail', { campaignId: 'c1' }), {
      ok: true,
      readDepth: 'detail',
      finishedAt: '2026-08-13T13:01:00.000Z',
      summary: { total: 1 },
      campaigns: [{
        id: 'c1',
        products: [{ sku: 's1', clicks: 0, spent: 0 }],
        objects: [],
        statistics: { clicks: 0, spent: 0 },
        detailRead: { products: true },
      }],
    });
    const campaign = repository.readBestSnapshot(request('dashboard')).payload.campaigns[0];
    assert.equal(campaign.products[0].clicks, 0);
    assert.equal(campaign.products[0].spent, 0);
    assert.equal(campaign.statistics.clicks, 0);
    assert.equal(campaign.statistics.spent, 0);
  } finally {
    db.close();
  }
});
