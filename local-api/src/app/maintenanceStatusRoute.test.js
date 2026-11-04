import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createApp } from './createApp.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('maintenance status route returns a read-only value-free summary', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)
    `).run(
      'shop-status-a', 'Status Shop A', 'active', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z',
      'shop-status-b', 'Status Shop B', 'active', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z',
    );
    db.prepare(`
      INSERT INTO purchase_order_overrides (id, shop_id, order_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'private-unscoped-status-row',
      '',
      'private-status-order',
      '2026-07-17T00:00:00.000Z',
      '2026-07-17T00:00:00.000Z',
    );
    const before = db.prepare('SELECT COUNT(*) AS count FROM purchase_order_overrides').get().count;
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/app/maintenance-status`);
    const status = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(status).sort(), [
      'emptyShopRows',
      'generatedAt',
      'manualAssignmentRows',
      'mode',
      'needsAttention',
      'ok',
      'reclaimableBytes',
      'safeRepairRows',
      'technicalCleanupRows',
      'unclassifiedTables',
      'userActionRequired',
    ]);
    assert.equal(status.ok, true);
    assert.equal(status.mode, 'read-only-maintenance-status');
    assert.match(status.generatedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(status.unclassifiedTables, 0);
    assert.equal(status.emptyShopRows, 1);
    assert.equal(status.manualAssignmentRows, 1);
    assert.equal(status.safeRepairRows, 0);
    assert.equal(status.needsAttention, true);
    assert.equal(status.userActionRequired, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM purchase_order_overrides').get().count, before);

    const serialized = JSON.stringify(status);
    for (const privateValue of [
      'purchase_order_overrides',
      'private-unscoped-status-row',
      'private-status-order',
      'previewFingerprint',
    ]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
