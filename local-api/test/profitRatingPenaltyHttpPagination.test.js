import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/app/createApp.js';
import { createOzonScheduler } from '../src/ozon/ozonScheduler.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createMigratedTestDb } from './testDb.js';

// Synthetic credentials are confined to this test process and in-memory DB.
process.env.LOCAL_API_SECRET = 'isolated-pagination-unit-material';

async function withFixture(fn) {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = 'isolated-http-pagination';
  shopRepository.saveShop({ id: shopId, name: 'Isolated pagination', clientId: 'synthetic-client', apiKey: 'synthetic-key', status: 'active' });
  const calls = [];
  let rejectSecondPage = false;
  const raw = [1, 2, 3].map(id => ({ operation_id: `fee-${id}`, posting_number: `posting-${id}`, error_fee_cny: -id }));
  const scheduler = createOzonScheduler({ db, shopRepository, logger: () => {},
    ozonClient: { async requestReadOnly(request) {
      calls.push(request.payload.offset);
      if (rejectSecondPage && request.payload.offset === 2) {
        throw Object.assign(new Error('isolated later-page rejection'), { status: 400, code: 'FIXTURE_PAGE_REJECTED' });
      }
      return { ok: true, status: 200, data: { result: {
        postings: raw.slice(request.payload.offset, request.payload.offset + request.payload.limit),
        has_next: request.payload.offset + request.payload.limit < raw.length,
      } } };
    } },
  });
  const server = createApp({ db, config: { security: {} }, getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [], startedAt: new Date().toISOString(), ozonScheduler: scheduler });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function sync(extra = {}) {
    const response = await fetch(`${base}/api/sync/profit`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shopId, pageSize: 2, forceRefresh: true, ...extra }) });
    assert.equal(response.status, 202);
    const submitted = await response.json();
    assert.ok(submitted.jobId);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const payload = await (await fetch(`${base}/api/sync/jobs/${submitted.jobId}`)).json();
      const job = payload.job || payload;
      if (['success', 'partial', 'failed', 'canceled', 'blocked'].includes(job.status)) return job;
      await delay(20);
    }
    assert.fail('isolated pagination job did not complete within test deadline');
  }
  const cache = async () => (await fetch(`${base}/api/cache/profit?scope=rating-penalties&shopId=${shopId}&pageSize=1000`)).json();
  try { await fn({ db, calls, raw, sync, cache, failLaterPage: () => { rejectSecondPage = true; } }); }
  finally { await new Promise(resolve => server.close(resolve)); db.close(); }
}

test('real scheduler and HTTP routes fetch all pages and expose the durable complete cache', async () => {
  await withFixture(async ({ calls, raw, sync, cache, db }) => {
    const first = await sync();
    assert.equal(first.status, 'success', first.lastError);
    assert.deepEqual(calls, [0, 2]);
    const result = await cache();
    assert.equal(result.complete, true);
    assert.equal(result.total, 3);
    assert.deepEqual(result.rows.map(row => row.operation_id).sort(), raw.map(row => row.operation_id));
    assert.deepEqual(result.rows.map(row => row.error_fee_cny).sort(), [-1, -2, -3].sort());
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ozon_rating_penalties').get().n, 3);
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM ozon_request_attempts').get().n >= 2);
    assert.equal((await sync()).status, 'success');
    assert.equal((await cache()).total, 3, 'refresh must not duplicate fees');
  });
});

test('real scheduler later-page failure never becomes a successful HTTP fee snapshot', async () => {
  await withFixture(async ({ calls, sync, cache, failLaterPage }) => {
    failLaterPage();
    const failed = await sync();
    assert.equal(failed.status, 'partial', failed.lastError);
    assert.deepEqual(calls, [0, 2]);
    const result = await cache();
    assert.equal(result.total, 2);
    assert.equal(result.complete, false);
    assert.equal(result.partial, true);
  });
});
