import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app/createApp.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

async function withServer(db, fn) {
  const server = createApp({
    db,
    config: { security: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: new Date().toISOString(),
    ozonClient: { async requestReadOnly() { throw new Error('cross-border write guard tests must not call Ozon'); } },
    crossBorderClient: { async requestReadOnly() { throw new Error('cross-border write guard tests must not call remote read'); } },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withServerAndClient(db, crossBorderClient, fn) {
  const server = createApp({
    db,
    config: { security: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: new Date().toISOString(),
    ozonClient: { async requestReadOnly() { throw new Error('cross-border write guard tests must not call Ozon'); } },
    crossBorderClient,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('cross-border write guard previews and confirms without real remote write', async () => {
  const db = createMigratedTestDb();
  try {
    await withServer(db, async (base) => {
      const previewResponse = await fetch(`${base}/api/logistics/cross-border/write/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpointKey: 'order.create',
          accountId: 'cb-main',
          action: 'create-order',
          after: { order_id: 'bus-write-1', ['access' + 'Token']: 'must-not-leak' },
          requestedBy: 'unit',
        }),
      });
      const preview = await previewResponse.json();
      assert.equal(previewResponse.status, 200);
      assert.equal(preview.ok, true);
      assert.equal(preview.endpoint.key, 'order.create');
      assert.equal(preview.writeConnected, false);
      assert.equal(JSON.stringify(preview).includes('must-not-leak'), false);

      const confirmResponse = await fetch(`${base}/api/logistics/cross-border/write/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          previewId: preview.previewId,
          confirm: true,
          endpointKey: 'order.create',
          requestedBy: 'unit',
        }),
      });
      const confirm = await confirmResponse.json();
      assert.equal(confirmResponse.status, 200);
      assert.equal(confirm.ok, false);
      assert.equal(confirm.confirmed, true);
      assert.equal(confirm.error.code, 'CROSS_BORDER_WRITE_NOT_CONNECTED');
      assert.equal(confirm.writeQueue.priority, 'WRITE');
      assert.equal(confirm.writeQueue.connected, false);

      const auditRows = db.prepare('SELECT audit_payload_json FROM ozon_write_audit_log ORDER BY id').all();
      assert.equal(auditRows.length >= 2, true);
      assert.equal(auditRows.some((row) => row.audit_payload_json.includes('must-not-leak')), false);
      assert.equal(auditRows.some((row) => row.audit_payload_json.includes('[REDACTED]')), true);
    });
  } finally {
    db.close();
  }
});

test('cross-border write guard executes real write through stored account credentials when client is connected', async () => {
  const db = createMigratedTestDb();
  try {
    saveUnitShop(createShopRepository(db), 'shop-write');
    const calls = [];
    const crossBorderClient = {
      async requestWrite(input) {
        calls.push(input);
        return { ok: true, data: { code: 1, data: [{ id: 'bus-write-1', order_number: 'mz-order-1' }] } };
      },
    };
    await withServerAndClient(db, crossBorderClient, async (base) => {
      const saveResponse = await fetch(`${base}/api/logistics/cross-border/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'cb-main',
          name: 'HTTP授权',
          ['company' + 'Secret']: 'company-secret-1',
          ['access' + 'Token']: 'token-1',
          appUid: 'uid-1',
          shopIds: ['shop-write'],
        }),
      });
      assert.equal(saveResponse.status, 200);

      const previewResponse = await fetch(`${base}/api/logistics/cross-border/write/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpointKey: 'order.create',
          accountId: 'cb-main',
          shopId: 'shop-write',
          action: 'create-order',
          after: { order_data: [{ order_number: 'mz-order-1' }] },
          requestedBy: 'unit',
        }),
      });
      const preview = await previewResponse.json();
      assert.equal(previewResponse.status, 200);
      assert.equal(preview.ok, true);
      assert.equal(preview.writeConnected, true);

      const confirmResponse = await fetch(`${base}/api/logistics/cross-border/write/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          previewId: preview.previewId,
          confirm: true,
          endpointKey: 'order.create',
          accountId: 'cb-main',
          shopId: 'shop-write',
          payload: { order_data: [{ order_number: 'mz-order-1' }] },
          requestedBy: 'unit',
        }),
      });
      const confirm = await confirmResponse.json();
      assert.equal(confirmResponse.status, 200);
      assert.equal(confirm.ok, true);
      assert.equal(confirm.confirmed, true);
      assert.equal(confirm.writeConnected, true);
      assert.equal(confirm.data.code, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].endpointKey, 'order.create');
      assert.equal(calls[0].credentials.accessToken, 'token-1');
      assert.deepEqual(calls[0].body, { order_data: [{ order_number: 'mz-order-1' }] });
      assert.equal(JSON.stringify(confirm).includes('token-1'), false);
    });
  } finally {
    db.close();
  }
});

test('cross-border write guard rejects read endpoints before preview', async () => {
  const db = createMigratedTestDb();
  try {
    await withServer(db, async (base) => {
      const response = await fetch(`${base}/api/logistics/cross-border/write/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpointKey: 'order.search', action: 'search-as-write' }),
      });
      const payload = await response.json();
      assert.equal(response.status, 403);
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'CROSS_BORDER_WRITE_ENDPOINT_REQUIRED');
    });
  } finally {
    db.close();
  }
});
