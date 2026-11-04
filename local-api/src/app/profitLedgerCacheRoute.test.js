import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createMigratedTestDb } from '../../test/testDb.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('profit ledger snapshot route writes and reads the canonical SQLite cache only', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const key = 'ozon-profit-ledger-v1:shop-a:range:2026-04-13_2026-07-12:filter:all';
    const write = await fetch(`http://127.0.0.1:${port}/api/profit/ledger-snapshot`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        snapshotKey: key,
        snapshot: {
          cacheGroup: 'ozon-profit-ledger-v1',
          calculationVersion: 'profit-ledger-v2',
          rows: [{ ledgerKey: 'ledger-1', calculationVersion: 'profit-ledger-v2' }],
          fetchedAt: '2026-07-12T00:00:00.000Z',
        },
      }),
    });
    const writePayload = await write.json();
    assert.equal(write.status, 200);
    assert.equal(writePayload.source, 'sqlite');
    assert.equal(writePayload.snapshot.rows[0].ledgerKey, 'ledger-1');

    const read = await fetch(
      `http://127.0.0.1:${port}/api/profit/ledger-snapshot?keys=${encodeURIComponent(`missing,${key}`)}`,
    );
    const readPayload = await read.json();
    assert.equal(read.status, 200);
    assert.equal(readPayload.snapshotKey, key);
    assert.deepEqual(readPayload.snapshot.rows.map((row) => row.ledgerKey), ['ledger-1']);
    assert.equal(JSON.stringify(readPayload).includes('missing'), false);

    const deleted = await fetch(`http://127.0.0.1:${port}/api/profit/ledger-snapshot`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshotKeys: [key] }),
    });
    const deletePayload = await deleted.json();
    assert.equal(deleted.status, 200);
    assert.deepEqual(deletePayload.stats, { changed: true, removedSnapshots: 1 });
    const afterDelete = await fetch(
      `http://127.0.0.1:${port}/api/profit/ledger-snapshot?keys=${encodeURIComponent(key)}`,
    );
    assert.equal((await afterDelete.json()).snapshot, null);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('profit ledger snapshot route rejects a payload without a snapshot key', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/profit/ledger-snapshot`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot: { rows: [] } }),
    });
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.ok, false);
    assert.match(payload.error.message, /PROFIT_LEDGER_SNAPSHOT_KEY_REQUIRED/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('profit ledger snapshot route accepts one compact restart payload above eight MiB', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const payload = 'x'.repeat(9 * 1024 * 1024);
    const response = await fetch(`http://127.0.0.1:${port}/api/profit/ledger-snapshot`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        snapshotKey: 'ozon-profit-ledger-v1:all-shops:range:current',
        snapshot: { rows: [{ ledgerKey: 'all-orders', compactRows: payload }] },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.snapshot.rows[0].compactRows.length, payload.length);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('profit order review route reads a saved ledger by order number', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const key = 'ozon-profit-ledger-v1:shop-a:range:2026-05-01_2026-07-31:filter:all';
    await fetch(`http://127.0.0.1:${port}/api/profit/ledger-snapshot`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        snapshotKey: key,
        snapshot: {
          sourceKey: 'shop-a',
          calculationVersion: 'profit-ledger-v8',
          rows: [{
            ledgerKey: 'shop-a:ORDER-100',
            shopId: 'shop-a',
            orderSnapshot: { posting: 'ORDER-100', shopId: 'shop-a', sku: '998877' },
            results: { actualProfitCny: { status: 'ready', value: 12 } },
          }],
        },
      }),
    });

    const response = await fetch(
      `http://127.0.0.1:${port}/api/profit/order-review?orderNumber=ORDER-100&shopIds=shop-a`,
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.found, true);
    assert.equal(payload.ledgerRow.orderSnapshot.sku, '998877');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
