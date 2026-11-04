import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLocalApiProxy, requiredPermissionForLocalApi } from './localApiProxy.js';
import { createApp } from '../../../local-api/src/app/createApp.js';
import { createMigratedTestDb, saveUnitShop } from '../../../local-api/test/testDb.js';
import { createShopRepository } from '../../../local-api/src/db/repositories/shopRepository.js';
import { createShopLicenseGrantRegistry } from '../../../local-api/src/domain/licensing/shopLicenseGrantRegistry.js';
import { createFinanceRepository } from '../../../local-api/src/db/repositories/financeRepository.js';
const body = { endpointKey: 'finance.transactionList', shopId: 'shop-1', access: 'read', forceRefresh: true, allowStale: false };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('official finance verification has an exact read-only profit permission mapping', () => {
  assert.equal(requiredPermissionForLocalApi('/api/ozon/request', body, 'POST'), 'profit.view');
  assert.equal(requiredPermissionForLocalApi('/api/ozon/request', { ...body, endpointKey: '/v3/finance/transaction/list' }, 'POST'), 'profit.view');
  for (const input of [{ ...body, access: 'write' }, { ...body, endpointKey: 'finance.unknown' }]) {
    assert.equal(requiredPermissionForLocalApi('/api/ozon/request', input, 'POST'), null);
  }
  assert.equal(requiredPermissionForLocalApi('/api/ozon/request', body, 'DELETE'), null);
});

test('desktop finance verification still requires profit permission and the exact shop card', async () => {
  for (const [permissions, validCard, expectedOk] of [[['profit.view'], true, true], [[], true, false], [['profit.view'], false, false]]) {
    const calls = [], entitlementChecks = [];
    const proxy = createLocalApiProxy({ baseUrl: 'http://127.0.0.1:3790', authToken: 'test-only-capability',
      licenseRuntime: {
        getRuntime: async () => ({ mode: 'enforce' }),
        getSession: async () => ({ authorized: true, entitlement: { permissions } }),
        getOzonShopEntitlementGrants: async () => [{ clientId: '10001', expireAt: '2099-01-01T00:00:00Z' }],
        assertOzonShopEntitled: async id => { entitlementChecks.push(id); if (!validCard) throw new Error('shop card expired'); },
      },
      fetchImpl: async url => {
        const pathname = new URL(url).pathname; calls.push(pathname);
        if (pathname === '/api/shops') return json({ ok: true, shops: [{ id: 'shop-1', clientId: '10001', status: 'active' }] });
        return json({ ok: true, schedulerResult: { status: 'success' }, data: { result: { operations: [], row_count: 0, page_count: 0 } } });
      },
    });
    const result = await proxy({ method: 'POST', path: '/api/ozon/request', body });
    assert.equal(result.ok, expectedOk, JSON.stringify(result));
    assert.equal(calls.includes('/api/ozon/request'), expectedOk);
    if (permissions.length) assert.deepEqual(entitlementChecks, ['10001']);
    if (!expectedOk) assert.equal(result.status, 403);
  }
});

test('licensed desktop proxy, real HTTP route and scheduler complete one official empty read end to end', async () => {
  const previousCwd = process.cwd();
  let db;
  try {
    process.chdir(fileURLToPath(new URL('../../../local-api/', import.meta.url)));
    db = createMigratedTestDb();
  } finally { process.chdir(previousCwd); }
  const repository = createShopRepository(db);
  const shopId = saveUnitShop(repository, 'shop-1');
  const clientId = repository.getPublicShopById(shopId).clientId;
  const readPostings = Array.from({ length: 250 }, (_, index) => `98765432-${String(index).padStart(4, '0')}-1`);
  createFinanceRepository(db).upsertOperations({ shopId, rows: readPostings.map((posting_number, index) => ({
    operation_id: String(index + 1), posting_number, operation_type: 'read-test', operation_date: '2026-09-04', amount: -1,
  })) });
  const registry = createShopLicenseGrantRegistry({ enforce: true });
  const capability = 'isolated-test-capability-'.repeat(3);
  let remoteCalls = 0;
  const server = createApp({ db, config: { security: { authToken: capability }, sync: { continuousEnabled: false }, ozon: {} },
    getDatabaseStatus: () => ({ ok: true }), listAppliedMigrations: () => [], startedAt: Date.now(), shopLicenseGrantRegistry: registry,
    ozonClient: { requestReadOnly: async input => {
      registry.assertActive(input.shopCredentials.clientId);
      assert.equal(input.shopCredentials.clientId, clientId);
      assert.equal(input.endpointKey, 'finance.transactionList');
      remoteCalls++;
      return { ok: true, status: 200, data: { result: { operations: [], row_count: 0, page_count: 0 } } };
    } },
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const proxy = createLocalApiProxy({ baseUrl: `http://127.0.0.1:${server.address().port}`, authToken: capability,
      fetchImpl: async (url, options) => {
        const response = await fetch(url, options);
        assert.equal(response.ok, true, `${new URL(url).pathname}: ${await response.clone().text()}`);
        return response;
      },
      licenseRuntime: {
        getRuntime: async () => ({ mode: 'enforce' }),
        getSession: async () => ({ authorized: true, entitlement: { permissions: ['profit.view'] } }),
        getOzonShopEntitlementGrants: async () => [{ clientId, expireAt: '2099-01-01T00:00:00Z' }],
        assertOzonShopEntitled: async id => { assert.equal(id, clientId); },
      },
    });
    const to = new Date(), from = new Date(to); from.setUTCHours(0, 0, 0, 0);
    const result = await proxy({ method: 'POST', path: '/api/ozon/request', body: { ...body, shopId,
      params: { filter: { posting_number: '98765432-0001-1', transaction_type: 'all', operation_type: [],
        date: { from: from.toISOString(), to: to.toISOString() } }, page: 1, page_size: 1000 } } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.schedulerResult.status, 'success');
    assert.equal(result.data.data.result.row_count, 0);
    assert.equal(remoteCalls, 1);
    const batch = await proxy({ method: 'POST', path: '/api/ozon/request', body: { ...body, shopId,
      postingNumbers: ['98765432-0001-1', '98765432-0001'] } });
    assert.equal(batch.ok, true, JSON.stringify(batch));
    assert.equal(batch.data.data.postingResults.length, 2);
    assert.ok(batch.data.data.postingResults.every(row => row.ok && row.data.result.row_count === 0));
    assert.equal(remoteCalls, 3);
    const query = new URLSearchParams({ shopId, postingNumbers: readPostings.join(','), page: '1', pageSize: '1000' });
    const local = await proxy({ method: 'GET', path: `/api/cache/finance?${query}` });
    assert.equal(local.ok, true, JSON.stringify(local));
    assert.equal(local.data.total, 250);
    assert.equal(local.data.rows.length, 250);
    assert.deepEqual(new Set(local.data.rows.map(row => row.postingNumber)), new Set(readPostings));
  } finally { await new Promise(resolve => server.close(resolve)); db.close(); }
});
