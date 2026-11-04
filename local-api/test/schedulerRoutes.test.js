import assert from 'node:assert/strict';
import test from 'node:test';
import { createCacheMergeService } from '../src/cache/cacheMergeService.js';
import { createApp } from '../src/app/createApp.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createSyncJobService } from '../src/sync/syncJobService.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

async function withServer(db, fn) {
  const server = createApp({
    db,
    config: { security: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: new Date().toISOString(),
    ozonClient: { async requestReadOnly() { throw new Error('route tests must not call Ozon'); } },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('scheduler routes expose cache, status, pause and resume controls', async () => {
  const db = createMigratedTestDb();
  try {
    const shopId = saveUnitShop(createShopRepository(db), 'shop-route-status-a');
    createCacheMergeService(db).mergeResponse({ domain: 'reports', endpointKey: 'reports.unit', cacheKey: 'reports:r1', payload: { a: 1 }, remoteHash: 'r1' });
    createSyncJobService(db).createJob({
      id: 'job-route-status-a',
      domain: 'products',
      shopId,
      endpointKey: 'products.list',
      action: 'sync-products-list',
      priority: 'P1',
      requestedBy: 'unit',
      cacheKey: 'products:list:shop-a',
      requestFingerprint: 'job-route-status-a',
    });
    await withServer(db, async (base) => {
      const cache = await (await fetch(`${base}/api/cache/reports?pageSize=10`)).json();
      assert.equal(cache.ok, true);
      assert.equal(cache.source, 'official-analytics-cache');
      assert.equal(cache.rows.length, 0);
      assert.equal(typeof cache.durationMs, 'number');

      const pauseShop = await (await fetch(`${base}/api/ozon/scheduler/pause-shop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shopId: 'shop-a' }) })).json();
      assert.equal(pauseShop.paused, true);
      const resumeShop = await (await fetch(`${base}/api/ozon/scheduler/resume-shop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shopId: 'shop-a' }) })).json();
      assert.equal(resumeShop.paused, false);

      const pauseEndpoint = await (await fetch(`${base}/api/ozon/scheduler/pause-endpoint`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpointKey: 'orders.fbsList' }) })).json();
      assert.equal(pauseEndpoint.paused, true);
      const resumeEndpoint = await (await fetch(`${base}/api/ozon/scheduler/resume-endpoint`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpointKey: 'orders.fbsList' }) })).json();
      assert.equal(resumeEndpoint.paused, false);

      const status = await (await fetch(`${base}/api/ozon/scheduler/status`)).json();
      assert.equal(status.ok, true);
      assert.ok(status.queue);
      assert.ok(status.traffic);
      assert.ok(status.traffic.profiles.foreground);
      assert.ok(Array.isArray(status.jobs));
      assert.ok(status.background);

      const batchJobs = await (await fetch(`${base}/api/sync/jobs/status?ids=job-route-status-a,missing-job`)).json();
      assert.equal(batchJobs.ok, true);
      assert.equal(batchJobs.jobs.length, 1);
      assert.equal(batchJobs.jobs[0].jobId, 'job-route-status-a');
      assert.deepEqual(batchJobs.missingIds, ['missing-job']);
    });
  } finally {
    db.close();
  }
});
