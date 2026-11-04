import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createStorageAuditService } from './storageAuditService.js';

test('storage audit separates manual, business, technical tables and empty shop ids without writes', () => {
  const db = createMigratedTestDb();
  try {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.prepare(`INSERT INTO ozon_products (id, shop_id, product_key, product_id, remote_hash, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('product-1', '', 'product-1', '1', 'hash-1', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    db.prepare(`INSERT INTO purchase_order_overrides (id, shop_id, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('override-1', null, 'order-1', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    db.prepare(`INSERT INTO ozon_scheduler_trace_events (id, phase, status, created_at) VALUES (?, ?, ?, ?)`)
      .run('trace-1', 'complete', 'success', '2026-07-11T00:00:00.000Z');

    const audit = createStorageAuditService(db).inspect();
    const products = audit.tables.find((table) => table.name === 'ozon_products');
    const overrides = audit.tables.find((table) => table.name === 'purchase_order_overrides');
    const traces = audit.tables.find((table) => table.name === 'ozon_scheduler_trace_events');
    assert.equal(audit.mode, 'read-only');
    assert.equal(products.category, 'canonical_fact');
    assert.equal(products.ownerScope, 'shop');
    assert.equal(products.lifecycle, 'preserve');
    assert.equal(products.backup, 'optional');
    assert.equal(products.emptyShopId, 1);
    assert.equal(overrides.category, 'manual_account');
    assert.equal(overrides.ownerScope, 'shop');
    assert.equal(overrides.lifecycle, 'preserve');
    assert.equal(overrides.backup, 'required');
    assert.equal(overrides.emptyShopId, 1);
    assert.equal(traces.category, 'technical_runtime');
    assert.equal(traces.ownerScope, 'system');
    assert.equal(traces.lifecycle, 'runtime');
    assert.equal(audit.classificationSummary.registeredTables, audit.tables.length);
    assert.equal(audit.classificationSummary.unclassifiedTables, 0);
    assert.equal(audit.classificationSummary.byOwnerScope.shop.emptyShopId, 2);
    assert.equal(audit.classificationSummary.byLifecycle.preserve.tables > 0, true);
    assert.equal(audit.classificationSummary.byBackup.required.tables > 0, true);
    assert.equal(audit.actions.automaticDeletionAllowed, false);
    assert.deepEqual(audit.actions.requiredBeforeCompaction, [
      '生成可恢复保护副本',
      '按保留策略生成删除预览',
      '人工确认后才执行清理',
      '单独预览并确认本机 SQLite 物理压缩（WAL checkpoint 后执行 VACUUM）',
    ]);
  } finally {
    db.close();
  }
});
