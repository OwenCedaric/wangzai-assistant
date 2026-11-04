import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import {
  inspectRequiredAccountOwnerBackupRows,
  selectRequiredAccountOwnerBackupDescriptors,
} from './accountOwnerBackupPolicy.js';

test('purchase account backup policy is derived from the deletion catalog and data registry', () => {
  assert.deepEqual(
    selectRequiredAccountOwnerBackupDescriptors('purchase_account')
      .map(({ policy }) => policy.domain),
    ['profile-settings', 'purchase-accounts', 'purchase-browser-receipts', 'purchase-browser-tasks'],
  );
});

test('purchase account inspection counts only the exact owner required rows', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare(`
      INSERT INTO purchase_accounts (id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `).run(
      'purchase-a', 'A', '2026-07-17T01:00:00.000Z', '2026-07-17T01:00:00.000Z',
      'purchase-b', 'B', '2026-07-17T02:00:00.000Z', '2026-07-17T02:00:00.000Z',
    );
    db.prepare(`
      INSERT INTO purchase_browser_tasks (
        id, owner_id, owner_incarnation, shop_id, order_key, product_key,
        idempotency_key_hash, request_fingerprint, preview_encrypted,
        preview_fingerprint, status, created_at, updated_at
      ) VALUES
        ('task-a', 'purchase-a', 'inc-a', 'shop-a', 'order-a', 'product-a',
          'idem-a', 'request-a', 'encrypted-a', 'preview-a', 'previewed', ?, ?),
        ('task-b', 'purchase-b', 'inc-b', 'shop-b', 'order-b', 'product-b',
          'idem-b', 'request-b', 'encrypted-b', 'preview-b', 'previewed', ?, ?)
    `).run(
      '2026-07-17T03:00:00.000Z', '2026-07-17T03:00:00.000Z',
      '2026-07-17T04:00:00.000Z', '2026-07-17T04:00:00.000Z',
    );
    db.prepare(`
      INSERT INTO purchase_browser_receipts (
        id, task_id, owner_id, shop_id, attempt_id, receipt_encrypted,
        receipt_hash, website_readback_hash, created_at
      ) VALUES (
        'receipt-a', 'task-a', 'purchase-a', 'shop-a', 'attempt-a', 'encrypted-a',
        'receipt-hash-a', 'readback-hash-a', ?
      )
    `).run('2026-07-17T05:00:00.000Z');

    const inspected = inspectRequiredAccountOwnerBackupRows(db, {
      ownerType: 'purchase_account',
      ownerId: 'purchase-a',
    });
    assert.equal(inspected.ownerIncarnation, '2026-07-17T01:00:00.000Z');
    assert.equal(inspected.totalRecords, 3);
    assert.deepEqual(
      Object.fromEntries(inspected.domains.map((domain) => [domain.domain, domain.recordCount])),
      {
        'profile-settings': 0,
        'purchase-accounts': 1,
        'purchase-browser-receipts': 1,
        'purchase-browser-tasks': 1,
      },
    );
  } finally {
    db.close();
  }
});

test('cross-border backup policy includes an exact logical profile-settings slice from the ownership catalog', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare(`
      INSERT INTO cross_border_accounts (id, name, status, created_at, updated_at)
      VALUES ('bus-a', 'Bus A', 'active', ?, ?), ('bus-b', 'Bus B', 'active', ?, ?)
    `).run(
      '2026-07-17T01:00:00.000Z', '2026-07-17T01:00:00.000Z',
      '2026-07-17T02:00:00.000Z', '2026-07-17T02:00:00.000Z',
    );
    db.prepare(`
      INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
      VALUES ('cross-border-preferences', ?, ?, ?)
    `).run(
      JSON.stringify({ crossBorderAccountId: 'bus-a', accountId: 'bus-b', globalDefault: 'preserve' }),
      '2026-07-17T03:00:00.000Z',
      '2026-07-17T03:00:00.000Z',
    );
    const inspected = inspectRequiredAccountOwnerBackupRows(db, {
      ownerType: 'cross_border_bus', ownerId: 'bus-a',
    });
    assert.deepEqual(
      Object.fromEntries(inspected.domains.map((domain) => [domain.domain, domain.recordCount])),
      { 'cross-border-accounts': 1, 'profile-settings': 1 },
    );
    const other = inspectRequiredAccountOwnerBackupRows(db, {
      ownerType: 'cross_border_bus', ownerId: 'bus-b',
    });
    assert.equal(other.totalRecords, 2);
  } finally {
    db.close();
  }
});

test('integration-profile backup counts its exact global follow-seller login preference', () => {
  const db = createMigratedTestDb();
  try {
    const now = '2026-08-19T00:00:00.000Z';
    db.prepare(`
      INSERT INTO integration_profiles (id, integration_type, platform_name, created_at, updated_at)
      VALUES ('integration-follow', 'ozon-follow-seller-session', '跟卖登录', ?, ?),
             ('integration-other', 'custom', '其他接入', ?, ?)
    `).run(now, now, now, now);
    db.prepare(`
      INSERT INTO follow_seller_login_preferences (preference_key, profile_id, created_at, updated_at)
      VALUES ('global', 'integration-follow', ?, ?)
    `).run(now, now);

    const follow = inspectRequiredAccountOwnerBackupRows(db, {
      ownerType: 'integration_profile', ownerId: 'integration-follow',
    });
    const other = inspectRequiredAccountOwnerBackupRows(db, {
      ownerType: 'integration_profile', ownerId: 'integration-other',
    });
    const counts = (inspection) => Object.fromEntries(
      inspection.domains.map((domain) => [domain.domain, domain.recordCount]),
    );

    assert.equal(counts(follow)['follow-seller-login-preferences'], 1);
    assert.equal(counts(other)['follow-seller-login-preferences'], 0);
  } finally {
    db.close();
  }
});
