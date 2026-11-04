import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createDataConsistencyAuditService } from './dataConsistencyAuditService.js';

test('data consistency audit is read-only and reports registered scope gaps without row values', () => {
  const db = createMigratedTestDb();
  try {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.prepare(`
      INSERT INTO purchase_order_overrides (id, shop_id, order_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('unscoped-manual-row', '', 'order-1', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    const before = db.prepare('SELECT COUNT(*) AS count FROM purchase_order_overrides').get().count;

    const audit = createDataConsistencyAuditService(db).inspect();
    const overrides = audit.domains.find((domain) => domain.table === 'purchase_order_overrides');
    assert.equal(audit.mode, 'read-only-data-consistency-audit');
    assert.equal(audit.integrity.ok, true);
    assert.equal(audit.foreignKeys.ok, true);
    assert.equal(audit.structuralOk, true);
    assert.equal(audit.readyForMigration, false);
    assert.equal(audit.registry.unclassifiedTables.length, 0);
    assert.equal(audit.keys.duplicateKeyGroups, 0);
    assert.equal(audit.scopes.emptyShopRows, 1);
    assert.equal(audit.scopes.requiresExplicitResolution, true);
    assert.deepEqual({
      domain: overrides.domain,
      keyCheck: overrides.keyCheck,
      emptyShopRows: overrides.emptyShopRows,
      primaryKey: overrides.primaryKey,
    }, {
      domain: 'purchase-overrides',
      keyCheck: 'checked',
      emptyShopRows: 1,
      primaryKey: ['shop_id', 'order_key'],
    });
    assert.equal(JSON.stringify(audit).includes('unscoped-manual-row'), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM purchase_order_overrides').get().count, before);
  } finally {
    db.close();
  }
});

test('data consistency audit detects duplicate preserve keys from an injected registry', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE manual_facts (shop_id TEXT, fact_key TEXT, payload TEXT);');
    db.prepare('INSERT INTO manual_facts (shop_id, fact_key, payload) VALUES (?, ?, ?)').run('shop-a', 'same-key', 'first');
    db.prepare('INSERT INTO manual_facts (shop_id, fact_key, payload) VALUES (?, ?, ?)').run('shop-a', 'same-key', 'second');
    const audit = createDataConsistencyAuditService(db, {
      registry: [{
        domain: 'manual-facts',
        scopeType: 'shop',
        dataClass: 'fact',
        source: 'user',
        canonicalTable: 'manual_facts',
        primaryKey: ['shop_id', 'fact_key'],
        backup: 'required',
        rebuildable: false,
      }],
    }).inspect();

    assert.equal(audit.structuralOk, false);
    assert.equal(audit.readyForMigration, false);
    assert.equal(audit.keys.duplicateKeyGroups, 1);
    assert.equal(audit.domains[0].duplicateKeyGroups, 1);
    assert.equal(JSON.stringify(audit).includes('first'), false);
    assert.equal(JSON.stringify(audit).includes('same-key'), false);
  } finally {
    db.close();
  }
});
