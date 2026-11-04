import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import {
  createShopScopeRepairPlan,
  createShopScopeRepairPreviewService,
  SHOP_SCOPE_MANUAL_RESOLUTION_CONFIRMATION,
  SHOP_SCOPE_REPAIR_CONFIRMATION,
  SHOP_SCOPE_REPAIR_POLICIES,
} from './shopScopeRepairPreview.js';

test('scope repair preview offers one-shop assignment only after confirmation', () => {
  const preview = createShopScopeRepairPlan({
    shopIds: ['shop-1'],
    tableCounts: [{ table: 'purchase_order_overrides', emptyRows: 21 }],
  });
  assert.equal(preview.automaticWriteAllowed, false);
  assert.equal(preview.requiredConfirmation, true);
  assert.equal(preview.tables[0].action, 'assign-after-confirmation');
  assert.equal(preview.tables[0].suggestedShopId, 'shop-1');
    assert.equal(preview.tables[0].scopeClass, 'user-owned');
    assert.match(preview.previewFingerprint, /^[A-Za-z0-9_-]{43}$/u);
});

test('scope repair writes only an exact confirmed single-shop manual preview and readbacks the assignment', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-a', 'Shop A', 'active', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    db.prepare(`
      INSERT INTO purchase_source_links (
        id, shop_id, order_key, slot_index, is_primary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('unscoped-link-a', '', 'order-a', 0, 0, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    const service = createShopScopeRepairPreviewService(db);
    const firstPreview = service.inspect();
    assert.equal(service.applyConfirmed({ previewFingerprint: firstPreview.previewFingerprint }).code, 'SHOP_SCOPE_REPAIR_CONFIRMATION_REQUIRED');
    assert.equal(db.prepare(`SELECT shop_id FROM purchase_source_links WHERE id = 'unscoped-link-a'`).get().shop_id, '');

    db.prepare(`
      INSERT INTO purchase_source_links (
        id, shop_id, order_key, slot_index, is_primary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('unscoped-link-b', '', 'order-b', 0, 0, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    const stale = service.applyConfirmed({
      confirmation: SHOP_SCOPE_REPAIR_CONFIRMATION,
      previewFingerprint: firstPreview.previewFingerprint,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'SHOP_SCOPE_REPAIR_PREVIEW_STALE');
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM purchase_source_links WHERE shop_id = ''`).get().count, 2);

    const freshPreview = service.inspect();
    const applied = service.applyConfirmed({
      confirmation: SHOP_SCOPE_REPAIR_CONFIRMATION,
      previewFingerprint: freshPreview.previewFingerprint,
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.mode, 'confirmed-transaction');
    assert.deepEqual(applied.applied.find((item) => item.table === 'purchase_source_links'), {
      table: 'purchase_source_links',
      action: 'assign-after-confirmation',
      operation: 'assign-shop',
      shopId: 'shop-a',
      changed: 2,
    });
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM purchase_source_links WHERE shop_id = 'shop-a'`).get().count, 2);
    assert.equal(applied.preview.tables.find((item) => item.table === 'purchase_source_links').emptyRows, 0);
  } finally {
    db.close();
  }
});

test('scope repair purges only confirmed unscoped runtime rows and leaves rehydratable rows deferred', () => {
  const db = createMigratedTestDb();
  try {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.prepare(`
      INSERT INTO ozon_write_audit_log (id, domain, shop_id, action, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('runtime-unscoped', 'products', '', 'preview', 'preview', '2026-07-12T00:00:00.000Z');
    db.prepare(`
      INSERT INTO ozon_products (id, shop_id, product_key, product_id, remote_hash, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('rehydrate-unscoped', '', 'product-1', '1', 'hash-1', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    const service = createShopScopeRepairPreviewService(db);
    const preview = service.inspect();
    const result = service.applyConfirmed({
      confirmation: SHOP_SCOPE_REPAIR_CONFIRMATION,
      previewFingerprint: preview.previewFingerprint,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.applied.find((item) => item.table === 'ozon_write_audit_log'), {
      table: 'ozon_write_audit_log',
      action: 'purge-runtime-after-confirmation',
      operation: 'purge-runtime',
      shopId: null,
      changed: 1,
    });
    assert.deepEqual(result.deferred, [{
      table: 'ozon_products',
      action: 'rehydrate-from-source-after-confirmation',
      emptyRows: 1,
    }]);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ozon_write_audit_log WHERE id = 'runtime-unscoped'`).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ozon_products WHERE id = 'rehydrate-unscoped'`).get().count, 1);
  } finally {
    db.close();
  }
});

test('scope repair preview isolates unresolved rows when multiple shops exist', () => {
  const preview = createShopScopeRepairPlan({
    shopIds: ['shop-a', 'shop-b'],
    tableCounts: [{ table: 'cross_border_order_records', emptyRows: 10 }],
  });
  assert.equal(preview.tables[0].action, 'isolate-for-manual-resolution');
  assert.equal(preview.tables[0].suggestedShopId, null);
});

test('scope repair rejects a same-count replacement of an unscoped user record', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-a', 'Shop A', 'active', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    db.prepare(`
      INSERT INTO purchase_source_links (
        id, shop_id, order_key, slot_index, is_primary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('old-unscoped-link', '', 'order-old', 0, 0, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    const service = createShopScopeRepairPreviewService(db);
    const preview = service.inspect();
    db.prepare(`DELETE FROM purchase_source_links WHERE id = 'old-unscoped-link'`).run();
    db.prepare(`
      INSERT INTO purchase_source_links (
        id, shop_id, order_key, slot_index, is_primary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('replacement-unscoped-link', '', 'order-replacement', 0, 0, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');

    const result = service.applyConfirmed({
      confirmation: SHOP_SCOPE_REPAIR_CONFIRMATION,
      previewFingerprint: preview.previewFingerprint,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'SHOP_SCOPE_REPAIR_PREVIEW_STALE');
    assert.equal(db.prepare(`SELECT shop_id FROM purchase_source_links WHERE id = 'replacement-unscoped-link'`).get().shop_id, '');
  } finally {
    db.close();
  }
});

test('manual multi-shop resolution assigns only the explicitly selected user records after a fresh preview', () => {
  const db = createMigratedTestDb();
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'link-a', '', 'order-a', 0, 0, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z',
      'link-b', '', 'order-b', 0, 0, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z',
    );
    const service = createShopScopeRepairPreviewService(db);
    const preview = service.inspectManualResolution();
    assert.equal(preview.ok, true);
    assert.equal(preview.totalCandidates, 2);
    assert.deepEqual(preview.shops.map((shop) => shop.id), ['shop-a', 'shop-b']);
    assert.equal(preview.candidates.every((candidate) => candidate.table === 'purchase_source_links'), true);
    assert.equal(JSON.stringify(preview).includes('rowId'), false);
    assert.equal(service.applyManualResolution({ previewFingerprint: preview.previewFingerprint }).code, 'SHOP_SCOPE_MANUAL_RESOLUTION_CONFIRMATION_REQUIRED');

    const result = service.applyManualResolution({
      confirmation: SHOP_SCOPE_MANUAL_RESOLUTION_CONFIRMATION,
      previewFingerprint: preview.previewFingerprint,
      assignments: [{ candidateId: preview.candidates[0].id, targetShopId: 'shop-a' }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.applied.length, 1);
    assert.equal(db.prepare(`SELECT shop_id FROM purchase_source_links WHERE id = 'link-a'`).get().shop_id, 'shop-a');
    assert.equal(db.prepare(`SELECT shop_id FROM purchase_source_links WHERE id = 'link-b'`).get().shop_id, '');
    assert.equal(result.preview.totalCandidates, 1);

    const second = service.applyManualResolution({
      confirmation: SHOP_SCOPE_MANUAL_RESOLUTION_CONFIRMATION,
      previewFingerprint: result.preview.previewFingerprint,
      assignments: [{ candidateId: result.preview.candidates[0].id, targetShopId: 'shop-b' }],
    });
    assert.equal(second.ok, true);
    assert.equal(db.prepare(`SELECT shop_id FROM purchase_source_links WHERE id = 'link-b'`).get().shop_id, 'shop-b');
    assert.equal(second.preview.totalCandidates, 0);
  } finally {
    db.close();
  }
});

test('manual multi-shop resolution rejects a same-count candidate replacement before assigning ownership', () => {
  const db = createMigratedTestDb();
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
    `).run('old-link', '', 'order-old', 0, 0, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    const service = createShopScopeRepairPreviewService(db);
    const preview = service.inspectManualResolution();
    db.prepare(`DELETE FROM purchase_source_links WHERE id = 'old-link'`).run();
    db.prepare(`
      INSERT INTO purchase_source_links (
        id, shop_id, order_key, slot_index, is_primary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('replacement-link', '', 'order-replacement', 0, 0, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');

    const result = service.applyManualResolution({
      confirmation: SHOP_SCOPE_MANUAL_RESOLUTION_CONFIRMATION,
      previewFingerprint: preview.previewFingerprint,
      assignments: [{ candidateId: preview.candidates[0].id, targetShopId: 'shop-a' }],
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'SHOP_SCOPE_MANUAL_RESOLUTION_PREVIEW_STALE');
    assert.equal(db.prepare(`SELECT shop_id FROM purchase_source_links WHERE id = 'replacement-link'`).get().shop_id, '');
  } finally {
    db.close();
  }
});

test('scope repair never guesses ownership for rebuildable or system rows', () => {
  const preview = createShopScopeRepairPlan({
    shopIds: ['shop-1'],
    tableCounts: [
      {
        table: 'ozon_orders',
        emptyRows: 3,
        policy: { domain: 'orders', dataClass: 'fact', source: 'ozon', backup: 'optional' },
      },
      {
        table: 'ozon_request_jobs',
        emptyRows: 2,
        policy: { domain: 'request-jobs', dataClass: 'runtime', source: 'system', backup: 'excluded' },
      },
    ],
  });
  assert.equal(preview.tables[0].scopeClass, 'rehydratable');
  assert.equal(preview.tables[0].action, 'rehydrate-from-source-after-confirmation');
  assert.equal(preview.tables[1].scopeClass, 'system-runtime');
  assert.equal(preview.tables[1].action, 'purge-runtime-after-confirmation');
  assert.equal(preview.tables.every((table) => table.suggestedShopId === null), true);
});

test('scope repair sweeps every registered physical shop table and reports schema drift without writing', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-a', 'Shop A', 'active', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    db.prepare(`
      INSERT INTO purchase_source_links (
        id, shop_id, order_key, slot_index, is_primary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('unscoped-manual-link', '', 'order-a', 0, 0, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    const service = createShopScopeRepairPreviewService(db);
    const preview = service.inspect();
    assert.equal(preview.ok, true);
    assert.equal(preview.registeredShopTables, SHOP_SCOPE_REPAIR_POLICIES.length);
    assert.deepEqual(preview.schemaIssues, []);
    assert.equal(JSON.stringify(preview).includes('candidateDigest'), false);
    const manual = preview.tables.find((table) => table.table === 'purchase_source_links');
    assert.equal(manual.emptyRows, 1);
    assert.equal(manual.action, 'assign-after-confirmation');
    assert.equal(manual.suggestedShopId, 'shop-a');

    db.exec('DROP TABLE ozon_response_cache');
    const drifted = service.inspect();
    assert.equal(drifted.ok, false);
    assert.deepEqual(drifted.schemaIssues, [
      { table: 'ozon_response_cache', schemaStatus: 'missing-table' },
    ]);
    assert.equal(
      drifted.tables.find((table) => table.table === 'ozon_response_cache').action,
      'schema-repair-required',
    );
  } finally {
    db.close();
  }
});
