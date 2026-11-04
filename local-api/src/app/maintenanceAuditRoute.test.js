import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createMigratedTestDb } from '../../test/testDb.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function waitForRetentionJob(baseUrl) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await (await fetch(`${baseUrl}/api/app/technical-retention/status`)).json();
    if (!status.active) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('technical retention background job did not settle');
}

test('maintenance storage audit exposes value-free owner and lifecycle classifications', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.prepare(`
      INSERT INTO purchase_order_overrides (id, shop_id, order_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('unscoped-manual-row', '', 'order-1', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    const before = db.prepare('SELECT COUNT(*) AS count FROM purchase_order_overrides').get().count;
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/app/storage-audit`);
    const audit = await response.json();

    assert.equal(response.status, 200);
    assert.equal(audit.mode, 'read-only');
    assert.equal(audit.classificationSummary.unclassifiedTables, 0);
    const overrides = audit.tables.find((table) => table.name === 'purchase_order_overrides');
    assert.deepEqual({
      domain: overrides.domain,
      ownerScope: overrides.ownerScope,
      lifecycle: overrides.lifecycle,
      backup: overrides.backup,
      emptyShopId: overrides.emptyShopId,
    }, {
      domain: 'purchase-overrides',
      ownerScope: 'shop',
      lifecycle: 'preserve',
      backup: 'required',
      emptyShopId: 1,
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM purchase_order_overrides').get().count, before);
    assert.equal(JSON.stringify(audit).includes('unscoped-manual-row'), false);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('maintenance data consistency audit is read-only and keeps business row values private', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.prepare(`
      INSERT INTO purchase_order_overrides (id, shop_id, order_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('unscoped-private-row', '', 'order-private', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    const before = db.prepare('SELECT COUNT(*) AS count FROM purchase_order_overrides').get().count;
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/app/data-consistency-audit`);
    const audit = await response.json();

    assert.equal(response.status, 200);
    assert.equal(audit.mode, 'read-only-data-consistency-audit');
    assert.equal(audit.integrity.ok, true);
    assert.equal(audit.scopes.emptyShopRows, 1);
    assert.equal(audit.structuralOk, true);
    assert.equal(audit.readyForMigration, false);
    assert.equal(JSON.stringify(audit).includes('unscoped-private-row'), false);
    assert.equal(JSON.stringify(audit).includes('order-private'), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM purchase_order_overrides').get().count, before);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('maintenance scope repair route requires the exact preview before writing', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    db.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-a', 'Shop A', 'active', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    db.prepare(`
      INSERT INTO purchase_order_overrides (id, shop_id, order_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('manual-unscoped', '', 'order-1', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const preview = await (await fetch(`${baseUrl}/api/app/shop-scope-preview`)).json();
    const denied = await fetch(`${baseUrl}/api/app/shop-scope-repair/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewFingerprint: preview.previewFingerprint }),
    });
    assert.equal(denied.status, 400);
    assert.equal((await denied.json()).code, 'SHOP_SCOPE_REPAIR_CONFIRMATION_REQUIRED');
    assert.equal(db.prepare(`SELECT shop_id FROM purchase_order_overrides WHERE id = 'manual-unscoped'`).get().shop_id, '');

    const confirmed = await fetch(`${baseUrl}/api/app/shop-scope-repair/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmation: 'APPLY_SHOP_SCOPE_REPAIR',
        previewFingerprint: preview.previewFingerprint,
      }),
    });
    const result = await confirmed.json();
    assert.equal(confirmed.status, 200);
    assert.equal(result.mode, 'confirmed-transaction');
    assert.equal(db.prepare(`SELECT shop_id FROM purchase_order_overrides WHERE id = 'manual-unscoped'`).get().shop_id, 'shop-a');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('maintenance technical retention route requires backup acknowledgement before deleting runtime rows', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    db.prepare(`
      INSERT INTO ozon_scheduler_trace_events (id, phase, status, created_at)
      VALUES (?, ?, ?, ?)
    `).run('old-trace', 'complete', 'success', '2020-01-01T00:00:00.000Z');
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const preview = await (await fetch(`${baseUrl}/api/app/technical-retention-preview`)).json();
    const denied = await fetch(`${baseUrl}/api/app/technical-retention/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmation: 'APPLY_TECHNICAL_RETENTION',
        previewFingerprint: preview.previewFingerprint,
      }),
    });
    assert.equal(denied.status, 400);
    assert.equal((await denied.json()).code, 'TECHNICAL_RETENTION_CONFIRMATION_REQUIRED');
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ozon_scheduler_trace_events WHERE id = 'old-trace'`).get().count, 1);

    const confirmed = await fetch(`${baseUrl}/api/app/technical-retention/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmation: 'APPLY_TECHNICAL_RETENTION',
        previewFingerprint: preview.previewFingerprint,
        backupAcknowledged: true,
      }),
    });
    assert.equal(confirmed.status, 200);
    const started = await confirmed.json();
    assert.equal(started.active, true);
    const status = await waitForRetentionJob(baseUrl);
    assert.equal(status.status, 'completed');
    assert.deepEqual(status.deleted, [{ table: 'ozon_scheduler_trace_events', rows: 1 }]);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ozon_scheduler_trace_events WHERE id = 'old-trace'`).get().count, 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('maintenance manual scope route only assigns an explicitly chosen candidate after the exact preview', async () => {
  const db = createMigratedTestDb();
  let server;
  try {
    db.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)
    `).run(
      'shop-a', 'Shop A', 'active', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z',
      'shop-b', 'Shop B', 'active', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z',
    );
    db.prepare(`
      INSERT INTO purchase_source_links (
        id, shop_id, order_key, slot_index, is_primary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('manual-link', '', 'order-a', 0, 0, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    server = createApp({
      db,
      config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const preview = await (await fetch(`${baseUrl}/api/app/shop-scope-manual-preview`)).json();
    assert.equal(preview.totalCandidates, 1);
    assert.equal(JSON.stringify(preview).includes('rowId'), false);
    const denied = await fetch(`${baseUrl}/api/app/shop-scope-manual-resolution/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewFingerprint: preview.previewFingerprint, assignments: [] }),
    });
    assert.equal(denied.status, 400);
    assert.equal((await denied.json()).code, 'SHOP_SCOPE_MANUAL_RESOLUTION_CONFIRMATION_REQUIRED');

    const confirmed = await fetch(`${baseUrl}/api/app/shop-scope-manual-resolution/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmation: 'APPLY_MANUAL_SHOP_SCOPE_RESOLUTION',
        previewFingerprint: preview.previewFingerprint,
        assignments: [{ candidateId: preview.candidates[0].id, targetShopId: 'shop-b' }],
      }),
    });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).applied.length, 1);
    assert.equal(db.prepare(`SELECT shop_id FROM purchase_source_links WHERE id = 'manual-link'`).get().shop_id, 'shop-b');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('maintenance compaction route requires backup acknowledgement before a physical SQLite operation', async () => {
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
    const baseUrl = `http://127.0.0.1:${port}`;
    const previewResponse = await fetch(`${baseUrl}/api/app/database-compaction-preview`);
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 200);
    assert.equal(preview.mode, 'read-only-compaction-preview');
    const denied = await fetch(`${baseUrl}/api/app/database-compaction/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmation: 'APPLY_DATABASE_COMPACTION',
        previewFingerprint: preview.previewFingerprint,
      }),
    });
    assert.equal(denied.status, 400);
    assert.equal((await denied.json()).code, 'DATABASE_COMPACTION_CONFIRMATION_REQUIRED');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
