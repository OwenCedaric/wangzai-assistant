import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createMigratedTestDb } from '../../test/testDb.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('purchase account list exposes login accounts, masks passwords, and manages the default account', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    server = createApp({
      db,
      config: { security: {}, sync: {}, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const save = async (payload) => {
      const response = await fetch(`${baseUrl}/api/purchase/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 200);
      return response.json();
    };

    const first = await save({
      name: '1688 主账号',
      loginAccount: 'seller-a',
      loginPassword: 'purchase-route-secret-a',
      isDefault: true,
    });
    const second = await save({
      name: '淘宝备用账号',
      loginPassword: 'purchase-route-secret-b',
      isDefault: true,
    });
    assert.equal(first.account.hasLoginPassword, true);
    assert.equal(second.account.hasLoginPassword, true);
    assert.equal(JSON.stringify(first).includes('purchase-route-secret-a'), false);
    assert.equal(JSON.stringify(second).includes('purchase-route-secret-b'), false);

    const listResponse = await fetch(`${baseUrl}/api/purchase/accounts`);
    const list = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(list.total, 2);
    assert.equal(list.accounts.find((account) => account.id === first.account.id).isDefault, false);
    assert.equal(list.accounts.find((account) => account.id === second.account.id).isDefault, true);
    assert.equal(JSON.stringify(list).includes('purchase-route-secret-'), false);

    assert.equal(list.accounts.find((account) => account.id === first.account.id).loginAccount, 'seller-a');
    assert.equal(list.accounts.find((account) => account.id === first.account.id).loginPasswordHint, '••••••••••');

    const deleteResponse = await fetch(`${baseUrl}/api/purchase/accounts/${encodeURIComponent(first.account.id)}`, {
      method: 'DELETE',
    });
    assert.equal(deleteResponse.status, 409);
    const deleted = await deleteResponse.json();
    assert.equal(deleted.ok, false);
    assert.equal(deleted.completed, false);
    assert.equal(deleted.error.code, 'ACCOUNT_REMOVAL_LEGACY_ROUTE_PREVIEW_REQUIRED');
    assert.equal(deleted.canonicalRoute, '/api/account-removal/preview');
    const afterLegacyDelete = await (await fetch(`${baseUrl}/api/purchase/accounts`)).json();
    assert.ok(afterLegacyDelete.accounts.some((account) => account.id === first.account.id));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('purchase account no longer exposes the retired browser-migration import route', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    server = createApp({
      db,
      config: { security: {}, sync: {}, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const retiredRouteResponse = await fetch(`${baseUrl}/api/purchase/accounts/legacy-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accounts: [{ id: 'retired-account', name: 'Retired account' }] }),
    });
    assert.equal(retiredRouteResponse.status, 404);

    const normalListResponse = await fetch(`${baseUrl}/api/purchase/accounts`);
    assert.equal(normalListResponse.status, 200);
    const normalList = await normalListResponse.json();
    assert.deepEqual(normalList.accounts, []);
    assert.deepEqual(normalList.rows, []);
    assert.equal(normalList.hasMore, false);
    assert.equal(normalList.nextCursor, '');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
