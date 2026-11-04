import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { initializeDatabase } from '../../db/database.js';
import { createPurchaseAccountRepository } from '../../db/repositories/purchaseAccountRepository.js';
import { createPurchaseBrowserTaskService } from '../purchaseBrowser/purchaseBrowserTaskService.js';
import {
  capturePreservedSqliteRows,
  createAccountRemovalEvidenceHash,
  observeAccountRemovalSqliteResource,
} from './accountRemovalEvidence.js';
import { createAccountRemovalSqliteExecutor } from './accountRemovalSqliteExecutor.js';
import { ACCOUNT_REMOVAL_SQLITE_RESOURCES } from './accountRemovalSqliteCatalog.js';

const OWNER_IDS = Object.freeze(['shop_iso_a', 'shop_iso_b', 'shop_iso_c']);
const FIXTURE_TIME = '2026-07-15T00:00:00.000Z';

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function fixtureValue(table, column, type, ownerId, catalogKey) {
  if (table === 'cross_border_account_shop_bindings' && column === 'account_id') {
    return `cross-border-account-for-${ownerId}`;
  }
  if (table === 'purchase_browser_tasks' && column === 'owner_id') return `purchase-for-${ownerId}`;
  if (table === 'purchase_browser_receipts' && column === 'owner_id') return `purchase-for-${ownerId}`;
  if (table === 'purchase_browser_receipts' && column === 'task_id') return `purchase_browser_tasks-id-${ownerId}`;
  if (table === 'purchase_browser_tasks' && column === 'status') return 'previewed';
  if (table === 'purchase_browser_plugin_state' && column === 'install_state') return 'active';
  if (column === 'profile_id' && (table === 'shop_bootstrap_runs' || table === 'shop_domain_sync_state')) return 'default';
  if (column === 'product_identity_id') return `product-identity-${ownerId}`;
  if (table === 'product_sync_runs' && column === 'id') return `product-sync-run-${ownerId}`;
  if (table.startsWith('product_sync_') && column === 'run_id') return `product-sync-run-${ownerId}`;
  if (table === 'historical_import_runs' && column === 'import_id') return `historical-import-${ownerId}`;
  if (table === 'historical_import_rows' && column === 'import_id') return `historical-import-${ownerId}`;
  if (table === 'historical_order_import_runs' && column === 'import_id') return `historical-order-import-${ownerId}`;
  if (table === 'historical_order_import_rows' && column === 'import_id') return `historical-order-import-${ownerId}`;
  if (table === 'follow_seller_patrol_runs' && column === 'id') return `follow-seller-patrol-${ownerId}`;
  if (table === 'follow_seller_patrol_runs' && column === 'mode') return 'shop';
  if (table === 'follow_seller_cases' && column === 'id') return `follow-seller-case-${ownerId}`;
  if (table === 'follow_seller_cases' && column === 'patrol_run_id') return `follow-seller-patrol-${ownerId}`;
  if (table === 'follow_seller_action_attempts' && column === 'case_id') return `follow-seller-case-${ownerId}`;
  if (table === 'data_backup_imports' && column === 'import_id') return `data-backup-import-${ownerId}`;
  if (table === 'data_backup_imports' && [
    'package_sha256',
    'source_data_fingerprint',
    'preflight_fingerprint',
    'result_data_fingerprint',
  ].includes(column)) return 'a'.repeat(64);
  if (table === 'data_backup_imports' && column === 'target_profile_id') return 'default';
  if (table === 'data_backup_imports' && column === 'strategy') return 'preserve';
  if (table === 'data_backup_imports' && column === 'status') return 'completed';
  if (table === 'shop_bootstrap_runs' && column === 'run_id') return `bootstrap-run-${ownerId}`;
  if (column === 'shop_id') return ownerId;
  if (column === 'cache_key' && table.startsWith('catalog_')) return catalogKey;
  if (column === 'merge_status') return 'inserted';
  if (column === 'catalog_type') return 'category_tree';
  if (column === 'phase') return 'finish';
  if (column === 'status' && table === 'product_sync_runs') return 'queued';
  if (column === 'status' && table === 'product_sync_stage_batches') return 'returned';
  if (column === 'status' && table === 'historical_import_runs') return 'previewed';
  if (column === 'status' && table === 'historical_order_import_runs') return 'previewed';
  if (column === 'status' && table === 'product_image_assets') return 'stored';
  if (column === 'status' && table.startsWith('product_') && table.endsWith('_facts')) return 'returned';
  if (column === 'status' && table === 'product_facet_observations') return 'returned';
  if (column === 'status') return 'success';
  if (column === 'mode' && table === 'product_sync_runs') return 'full';
  if (column === 'stage_kind' && table === 'product_sync_stage_batches') return 'list';
  if (column === 'event_type' && table === 'product_sync_outbox') return 'ProductSnapshotActivated';
  if (column === 'reason' && table === 'shop_bootstrap_runs') return 'initial_bind';
  if (column === 'source_type' && table === 'product_dimension_facts') return 'user';
  if (column === 'source_type' && table === 'product_manual_cost_profiles') return 'manual';
  if (column === 'source_type' && table === 'product_image_assets') return 'account-removal-fixture';
  if (column === 'source_type' && table.startsWith('historical_order_')) return 'historical_order_import';
  if (table === 'cross_border_charge_records' && column === 'direction') return 'expense';
  if (table === 'cross_border_charge_links' && column === 'match_status') return 'exact';
  if (column === 'currency_code' && table === 'product_manual_cost_profiles') return 'CNY';
  if (column === 'currency_code' && table === 'historical_order_facts') return 'CNY';
  if (column === 'conflict_mode' && table === 'historical_import_runs') return 'preserve';
  if (column === 'preview_status' && table === 'historical_import_rows') return 'ready_insert';
  if (column === 'preview_status' && table === 'historical_order_import_rows') return 'ready_insert';
  if (column === 'fulfillment_type' && table === 'product_commission_facts') return 'FBO';
  if (column === 'facet' && table === 'product_facet_observations') return 'detail';
  if (column === 'report_date') return '2026-07-15';
  if (table === 'product_image_assets' && column === 'sha256') return sha256(`${ownerId}:product-image`);
  if (table === 'product_image_assets' && column === 'mime_type') return 'image/png';
  if (table === 'product_image_assets' && column === 'storage_scope') return 'permanent';
  if (table === 'product_image_assets' && column === 'variant') return 'original';
  if (table === 'product_image_usage_events' && column === 'operation') return 'upload';
  if (/(?:_at|_date|date)$/u.test(column)) return FIXTURE_TIME;
  if (/json$/u.test(column)) return '{}';
  if (/(?:INT|REAL|NUM)/iu.test(type)) return 1;
  return `${table}-${column}-${ownerId}`;
}

function seedEveryOzonOwnerTable(db, ownerId) {
  db.prepare('INSERT INTO shops (id, name, status) VALUES (?, ?, ?)').run(
    ownerId,
    `Shop ${ownerId}`,
    'active',
  );
  const catalogKey = `catalog-key-${ownerId}`;
  db.prepare(`
    INSERT INTO catalog_cache_key_registry (cache_key, scope, shop_id, catalog_type)
    VALUES (?, 'shop', ?, 'category_tree')
  `).run(catalogKey, ownerId);

  db.prepare(`
    INSERT INTO purchase_accounts (id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(`purchase-for-${ownerId}`, `Purchase ${ownerId}`, FIXTURE_TIME, FIXTURE_TIME);
  db.prepare(`
    INSERT INTO cross_border_accounts (id, name, status, created_at, updated_at)
    VALUES (?, ?, 'active', ?, ?)
  `).run(`cross-border-account-for-${ownerId}`, `Cross-border ${ownerId}`, FIXTURE_TIME, FIXTURE_TIME);
  db.prepare(`
    INSERT INTO integration_profiles (
      id, integration_type, platform_name, shop_id, config_status, token_status, created_at, updated_at
    ) VALUES (?, 'ozon-follow-seller-session', ?, NULL, '连接成功', 'Cookie 已保存', ?, ?)
  `).run(`follow-seller-login-${ownerId}`, `Ozon 前台巡查 ${ownerId}`, FIXTURE_TIME, FIXTURE_TIME);

  const descriptors = [...ACCOUNT_REMOVAL_SQLITE_RESOURCES.ozon_shop].sort((left, right) => {
    const order = {
      purchase_browser_tasks: 0,
      product_identities: 0,
      product_sync_runs: 0,
      historical_import_runs: 0,
      historical_order_import_runs: 0,
      shop_bootstrap_runs: 0,
      follow_seller_patrol_runs: 0,
      purchase_browser_receipts: 1,
      shop_domain_sync_state: 1,
      historical_import_rows: 1,
      historical_order_import_rows: 1,
      follow_seller_cases: 1,
      follow_seller_action_attempts: 2,
    };
    for (const table of [left.table, right.table]) {
      if (table.startsWith('product_sync_') && table !== 'product_sync_runs' && order[table] === undefined) order[table] = 1;
      if (table.startsWith('product_') && table.endsWith('_facts') && table !== 'product_identities' && order[table] === undefined) order[table] = 1;
      if (table === 'product_facet_observations') order[table] = 1;
    }
    return (order[left.table] ?? 2) - (order[right.table] ?? 2);
  });
  for (const descriptor of descriptors) {
    if (descriptor.table === 'shops' || descriptor.table === 'catalog_cache_key_registry') continue;
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(descriptor.table)})`).all();
    const selectedNames = [...new Set(columns
      .filter((column) => (
        column.name === descriptor.ownerField
        || (column.pk && !(/INTEGER/iu.test(column.type) && column.pk === 1))
        || (column.notnull && column.dflt_value === null && !(/INTEGER/iu.test(column.type) && column.pk === 1))
        || (descriptor.table === 'ozon_orders' && column.name === 'posting_number')
        || (descriptor.table === 'ozon_notification_settings' && column.name === 'shop_scope')
      ))
      .map((column) => column.name))];
    const values = selectedNames.map((name) => {
      const column = columns.find((entry) => entry.name === name);
      return name === descriptor.ownerField
        ? ownerId
        : fixtureValue(descriptor.table, name, column.type, ownerId, catalogKey);
    });
    db.prepare(`
      INSERT INTO ${quoteIdentifier(descriptor.table)} (${selectedNames.map(quoteIdentifier).join(', ')})
      VALUES (${selectedNames.map(() => '?').join(', ')})
    `).run(...values);
  }
}

function seedSingleAccountTable(db, descriptor, ownerId) {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(descriptor.table)})`).all();
  const selectedNames = [...new Set(columns
    .filter((column) => (
      column.name === descriptor.ownerField
      || (column.pk && !(/INTEGER/iu.test(column.type) && column.pk === 1))
      || (column.notnull && column.dflt_value === null && !(/INTEGER/iu.test(column.type) && column.pk === 1))
    ))
    .map((column) => column.name))];
  const values = selectedNames.map((name) => {
    const column = columns.find((entry) => entry.name === name);
    return name === descriptor.ownerField
      ? ownerId
      : fixtureValue(descriptor.table, name, column.type, ownerId, `catalog-key-${ownerId}`);
  });
  db.prepare(`
    INSERT INTO ${quoteIdentifier(descriptor.table)} (${selectedNames.map(quoteIdentifier).join(', ')})
    VALUES (${selectedNames.map(() => '?').join(', ')})
  `).run(...values);
}

function ownerEvidence(db, descriptor, ownerId) {
  const rows = db.prepare(`
    SELECT * FROM ${quoteIdentifier(descriptor.table)}
    WHERE ${quoteIdentifier(descriptor.ownerField)} = ?
  `).all(ownerId);
  return {
    count: rows.length,
    hash: createAccountRemovalEvidenceHash(rows),
  };
}

function everyOwnerEvidence(db, ownerId) {
  return Object.fromEntries(ACCOUNT_REMOVAL_SQLITE_RESOURCES.ozon_shop.map((descriptor) => [
    descriptor.resourceId,
    ownerEvidence(db, descriptor, ownerId),
  ]));
}

test('full-row account evidence is hashed through bounded row iteration', () => {
  let iterateCalls = 0;
  const db = {
    prepare(sql) {
      assert.match(sql, /ORDER BY rowid/u);
      return {
        iterate(ownerId) {
          iterateCalls += 1;
          assert.equal(ownerId, 'shop-a');
          return [
            { id: 'row-1', shop_id: 'shop-b', payload: 'first' },
            { id: 'row-2', shop_id: 'shop-c', payload: 'second' },
          ];
        },
      };
    },
  };
  const descriptor = {
    resourceId: 'registry:bounded-evidence-fixture',
    table: 'bounded_evidence_fixture',
    ownerField: 'shop_id',
    accountRow: false,
  };

  const preserved = capturePreservedSqliteRows(db, [descriptor], 'shop-a');
  const observed = observeAccountRemovalSqliteResource(db, descriptor, 'shop-a');

  assert.equal(preserved.bounded_evidence_fixture.count, 2);
  assert.match(preserved.bounded_evidence_fixture.hash, /^[a-f0-9]{64}$/u);
  assert.equal(observed.count, 2);
  assert.match(observed.hash, /^[a-f0-9]{64}$/u);
  assert.equal(iterateCalls, 2);
});

test('high-volume Ozon request jobs use bounded summary evidence and still delete only the selected shop', () => {
  const descriptor = ACCOUNT_REMOVAL_SQLITE_RESOURCES.ozon_shop
    .find((entry) => entry.table === 'ozon_request_jobs');
  assert.equal(descriptor.evidenceMode, 'rowid-summary');

  const db = createMigratedTestDb();
  try {
    db.prepare('INSERT INTO shops (id, name, status) VALUES (?, ?, ?)')
      .run('shop-request-a', 'Request A', 'active');
    db.prepare('INSERT INTO shops (id, name, status) VALUES (?, ?, ?)')
      .run('shop-request-b', 'Request B', 'active');
    const insert = db.prepare(`
      INSERT INTO ozon_request_jobs (id, domain, shop_id)
      VALUES (?, 'products', ?)
    `);
    for (let index = 0; index < 2_000; index += 1) {
      insert.run(`request-a-${index}`, 'shop-request-a');
      insert.run(`request-b-${index}`, 'shop-request-b');
    }

    const result = createAccountRemovalSqliteExecutor({ db }).execute({
      ownerType: 'ozon_shop',
      ownerId: 'shop-request-a',
    }, { operationId: 'delete-high-volume-request-shop-a' });

    assert.equal(result.deletedRows['registry:request-jobs'], 2_000);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ozon_request_jobs WHERE shop_id = ?')
      .get('shop-request-a').count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ozon_request_jobs WHERE shop_id = ?')
      .get('shop-request-b').count, 2_000);
    assert.equal(result.preservationVerified, true);
  } finally {
    db.close();
  }
});

test('Ozon A/B/C fixture deletes A from every allowlisted table while preserving B, C, and system rows byte-for-byte', () => {
  const db = createMigratedTestDb();
  try {
    for (const ownerId of OWNER_IDS) seedEveryOzonOwnerTable(db, ownerId);
    db.prepare(`
      INSERT INTO follow_seller_login_preferences (
        preference_key, profile_id, created_at, updated_at
      ) VALUES ('global', ?, ?, ?)
    `).run(`follow-seller-login-${OWNER_IDS[0]}`, FIXTURE_TIME, FIXTURE_TIME);
    const preferenceValue = {
      shops: OWNER_IDS.map((id) => ({ id, label: id })),
      activeShopId: OWNER_IDS[0],
      defaultWarehouseIds: Object.fromEntries(OWNER_IDS.map((id) => [id, `warehouse-${id}`])),
      globalFlag: true,
    };
    const saveSetting = db.prepare(`
      INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    saveSetting.run('ozon-shop-preferences', JSON.stringify(preferenceValue), FIXTURE_TIME, FIXTURE_TIME);
    saveSetting.run('purchase-plugin-context', JSON.stringify({
      version: 1,
      context: { shopId: OWNER_IDS[0], orderKey: 'order-a', productKey: 'product-a' },
      updatedAt: FIXTURE_TIME,
    }), FIXTURE_TIME, FIXTURE_TIME);
    saveSetting.run('fee-settings', JSON.stringify({ version: 1, keep: true }), FIXTURE_TIME, FIXTURE_TIME);

    const beforeB = everyOwnerEvidence(db, OWNER_IDS[1]);
    const beforeC = everyOwnerEvidence(db, OWNER_IDS[2]);
    const systemBefore = db.prepare("SELECT * FROM profile_settings WHERE namespace = 'fee-settings'").get();
    const executor = createAccountRemovalSqliteExecutor({ db, now: () => '2026-07-15T00:01:00.000Z' });
    const preservationBefore = executor.capturePreservation({ ownerType: 'ozon_shop', ownerId: OWNER_IDS[0] });

    const result = executor.execute(
      { ownerType: 'ozon_shop', ownerId: OWNER_IDS[0] },
      { operationId: 'delete-operation-shop-iso-a' },
    );

    for (const descriptor of ACCOUNT_REMOVAL_SQLITE_RESOURCES.ozon_shop) {
      assert.equal(
        ownerEvidence(db, descriptor, OWNER_IDS[0]).count,
        0,
        `${descriptor.table} must not retain target owner rows`,
      );
      assert.equal(
        result.deletedRows[descriptor.resourceId],
        1,
        `${descriptor.resourceId} must report its explicit deletion`,
      );
    }
    assert.deepEqual(everyOwnerEvidence(db, OWNER_IDS[1]), beforeB);
    assert.deepEqual(everyOwnerEvidence(db, OWNER_IDS[2]), beforeC);
    assert.deepEqual(
      db.prepare("SELECT * FROM profile_settings WHERE namespace = 'fee-settings'").get(),
      systemBefore,
    );
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM integration_profiles
      WHERE id = ? AND shop_id IS NULL
    `).get(`follow-seller-login-${OWNER_IDS[0]}`).count, 1);
    assert.equal(db.prepare(`
      SELECT profile_id
      FROM follow_seller_login_preferences
      WHERE preference_key = 'global'
    `).get().profile_id, `follow-seller-login-${OWNER_IDS[0]}`);
    assert.deepEqual(
      executor.capturePreservation({ ownerType: 'ozon_shop', ownerId: OWNER_IDS[0] }),
      preservationBefore,
    );

    const preferenceReadback = JSON.parse(db.prepare(`
      SELECT value_json FROM profile_settings WHERE namespace = 'ozon-shop-preferences'
    `).get().value_json);
    assert.deepEqual(preferenceReadback.shops.map((shop) => shop.id), OWNER_IDS.slice(1));
    assert.equal(preferenceReadback.activeShopId, OWNER_IDS[1]);
    assert.deepEqual(preferenceReadback.defaultWarehouseIds, {
      [OWNER_IDS[1]]: `warehouse-${OWNER_IDS[1]}`,
      [OWNER_IDS[2]]: `warehouse-${OWNER_IDS[2]}`,
    });
    assert.equal(preferenceReadback.globalFlag, true);
    const purchasePluginReadback = JSON.parse(db.prepare(`
      SELECT value_json FROM profile_settings WHERE namespace = 'purchase-plugin-context'
    `).get().value_json);
    assert.deepEqual(purchasePluginReadback.context, {});

    assert.equal(result.deletedRows['registry:shop-credentials'], 1);
    assert.equal(result.identityTombstone.deletionOperationId, 'delete-operation-shop-iso-a');
    assert.deepEqual(result.removedOwnerGeneration, {
      ownerId: OWNER_IDS[0],
      clientId: null,
      profileId: 'default',
      shopIncarnation: result.removedOwnerGeneration.shopIncarnation,
      credentialRevision: 1,
    });
    assert.match(result.removedOwnerGeneration.shopIncarnation, /^inc_/u);
    const tombstone = db.prepare(`
      SELECT profile_id, former_shop_id, former_shop_incarnation,
             final_credential_revision, deletion_operation_id, metadata_json
      FROM shop_identity_tombstones WHERE deletion_operation_id = ?
    `).get('delete-operation-shop-iso-a');
    assert.equal(tombstone.profile_id, 'default');
    assert.equal(tombstone.former_shop_id, OWNER_IDS[0]);
    assert.match(tombstone.former_shop_incarnation, /^inc_/u);
    assert.equal(tombstone.final_credential_revision, 1);
    assert.deepEqual(JSON.parse(tombstone.metadata_json), {
      source: 'account-removal-orchestrator',
      canonicalFactsDeleted: true,
      sharedCatalogPreserved: true,
    });
    assert.equal(result.deletedRows['logical:profile-settings-ozon-shop-preferences'], 3);
    assert.equal(result.deletedRows['logical:profile-settings-purchase-plugin-context'], 1);
    assert.equal(
      result.totalDeletedRows,
      ACCOUNT_REMOVAL_SQLITE_RESOURCES.ozon_shop.length + 4,
    );
    assert.equal(result.preservationVerified, true);
    assert.equal(result.physicalStorage.secureDelete, true);
    assert.equal(result.physicalStorage.checkpoint.busy, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check;').all(), []);
  } finally {
    db.close();
  }
});

for (const ownerType of ['cross_border_bus', 'promotion_account', 'purchase_account', 'model_api_account', 'integration_profile']) {
  test(`${ownerType} A/B/C fixture deletes only A and preserves B, C, and system state`, () => {
    const db = createMigratedTestDb();
    try {
      const descriptors = ACCOUNT_REMOVAL_SQLITE_RESOURCES[ownerType];
      const ownerIds = [`${ownerType}_iso_a`, `${ownerType}_iso_b`, `${ownerType}_iso_c`];
      if (ownerType === 'purchase_account') {
        const seedOrder = [
          'purchase_accounts',
          'purchase_browser_tasks',
          'purchase_browser_plugin_state',
          'purchase_browser_receipts',
        ];
        ownerIds.forEach((ownerId) => {
          for (const table of seedOrder) {
            seedSingleAccountTable(db, descriptors.find((entry) => entry.table === table), ownerId);
          }
        });
      } else if (ownerType === 'integration_profile') {
        const seedOrder = ['integration_profiles', 'integration_credentials'];
        ownerIds.forEach((ownerId) => {
          for (const table of seedOrder) {
            seedSingleAccountTable(db, descriptors.find((entry) => entry.table === table), ownerId);
          }
        });
      } else {
        assert.equal(descriptors.length, 1);
        ownerIds.forEach((ownerId) => seedSingleAccountTable(db, descriptors[0], ownerId));
      }
      db.prepare(`
        INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
        VALUES ('fee-settings', '{"keep":true}', ?, ?)
      `).run(FIXTURE_TIME, FIXTURE_TIME);

      const beforeB = Object.fromEntries(descriptors.map((descriptor) => [
        descriptor.resourceId,
        ownerEvidence(db, descriptor, ownerIds[1]),
      ]));
      const beforeC = Object.fromEntries(descriptors.map((descriptor) => [
        descriptor.resourceId,
        ownerEvidence(db, descriptor, ownerIds[2]),
      ]));
      const systemBefore = db.prepare("SELECT * FROM profile_settings WHERE namespace = 'fee-settings'").get();
      const result = createAccountRemovalSqliteExecutor({ db }).execute({
        ownerType,
        ownerId: ownerIds[0],
      });

      for (const descriptor of descriptors) {
        assert.equal(ownerEvidence(db, descriptor, ownerIds[0]).count, 0);
        assert.deepEqual(ownerEvidence(db, descriptor, ownerIds[1]), beforeB[descriptor.resourceId]);
        assert.deepEqual(ownerEvidence(db, descriptor, ownerIds[2]), beforeC[descriptor.resourceId]);
        assert.equal(result.deletedRows[descriptor.resourceId], 1);
      }
      assert.deepEqual(
        db.prepare("SELECT * FROM profile_settings WHERE namespace = 'fee-settings'").get(),
        systemBefore,
      );
      assert.equal(result.totalDeletedRows, descriptors.length);
      assert.equal(result.preservationVerified, true);
    } finally {
      db.close();
    }
  });
}

test('removing a selected global follow-seller front profile cascades its global preference', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare(`
      INSERT INTO integration_profiles (
        id, integration_type, platform_name, shop_id, config_status, token_status, created_at, updated_at
      ) VALUES ('follow-front-global', 'ozon-follow-seller-session', 'Ozon 前台巡查 1', NULL,
                '连接成功', 'Cookie 已保存', ?, ?)
    `).run(FIXTURE_TIME, FIXTURE_TIME);
    db.prepare(`
      INSERT INTO follow_seller_login_preferences (
        preference_key, profile_id, created_at, updated_at
      ) VALUES ('global', 'follow-front-global', ?, ?)
    `).run(FIXTURE_TIME, FIXTURE_TIME);

    createAccountRemovalSqliteExecutor({ db }).execute({
      ownerType: 'integration_profile',
      ownerId: 'follow-front-global',
    });

    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM follow_seller_login_preferences
    `).get().count, 0);
  } finally {
    db.close();
  }
});

test('purchase-account profile context deletes exact A and preserves B until B itself is removed', () => {
  const db = createMigratedTestDb();
  try {
    const descriptors = ACCOUNT_REMOVAL_SQLITE_RESOURCES.purchase_account;
    const ownerIds = ['purchase_context_a', 'purchase_context_b', 'purchase_context_c'];
    const seedOrder = [
      'purchase_accounts',
      'purchase_browser_tasks',
      'purchase_browser_plugin_state',
      'purchase_browser_receipts',
    ];
    ownerIds.forEach((ownerId) => {
      for (const table of seedOrder) {
        seedSingleAccountTable(db, descriptors.find((entry) => entry.table === table), ownerId);
      }
    });
    const contextB = {
      version: 1,
      context: {
        purchaseAccountId: ownerIds[1],
        shopId: 'shop-context-b',
        orderKey: 'order-context-b',
        productKey: 'product-context-b',
      },
      updatedAt: FIXTURE_TIME,
    };
    db.prepare(`
      INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
      VALUES ('purchase-plugin-context', ?, ?, ?)
    `).run(JSON.stringify(contextB), FIXTURE_TIME, FIXTURE_TIME);
    const executor = createAccountRemovalSqliteExecutor({ db });

    const resultA = executor.execute({ ownerType: 'purchase_account', ownerId: ownerIds[0] });
    const afterA = JSON.parse(db.prepare(`
      SELECT value_json FROM profile_settings WHERE namespace = 'purchase-plugin-context'
    `).get().value_json);
    assert.deepEqual(afterA, contextB);
    assert.equal(resultA.deletedRows['logical:profile-settings-purchase-account-context'], 0);

    const resultB = executor.execute({ ownerType: 'purchase_account', ownerId: ownerIds[1] });
    const afterB = JSON.parse(db.prepare(`
      SELECT value_json FROM profile_settings WHERE namespace = 'purchase-plugin-context'
    `).get().value_json);
    assert.deepEqual(afterB.context, {});
    assert.equal(resultB.deletedRows['logical:profile-settings-purchase-account-context'], 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM purchase_accounts WHERE id = ?').get(ownerIds[2]).count, 1);
  } finally {
    db.close();
  }
});

test('purchase-account removal archives legacy completed receipts under the shop and shop removal deletes that history', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare(`INSERT INTO shops (id, name, status) VALUES ('shop-history', 'History shop', 'active')`).run();
    createPurchaseAccountRepository(db).saveAccount({
      id: 'purchase-history-owner',
      name: 'Disposable purchase login',
      platformName: 'Pinduoduo',
    });
    const service = createPurchaseBrowserTaskService(db, {
      createCapability: () => 'history-capability',
      createAttemptId: () => 'purchase_attempt_history',
      createReceiptId: () => 'purchase_receipt_history',
    });
    const preview = service.previewTask({
      ownerId: 'purchase-history-owner',
      shopId: 'shop-history',
      orderKey: 'ozon-order-history',
      productKey: 'ozon-product-history',
      productTitle: 'History product',
      variant: 'Black / L',
      quantity: 1,
      address: 'Encrypted delivery address',
      expectedAmount: '66.80',
      targetUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=100',
      idempotencyKey: 'purchase-history-idempotency-0001',
    }).task;
    const confirmation = service.confirmTask(preview.id, {
      confirm: true,
      previewFingerprint: preview.previewFingerprint,
      confirmation: {
        productTitle: preview.preview.productTitle,
        variant: preview.preview.variant,
        quantity: preview.preview.quantity,
        address: preview.preview.address,
        expectedAmount: preview.preview.expectedAmount,
      },
    });
    const claim = service.claimTask(preview.id, {
      executionCapability: confirmation.executionCapability,
    });
    const receipt = {
      orderNumber: 'PDD-HISTORY-100',
      amount: '66.80',
      status: 'submitted',
      pageUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=100',
    };
    const receiptHash = sha256(JSON.stringify(receipt));
    service.completeTask(preview.id, {
      attemptId: claim.attemptId,
      receipt,
      receiptHash,
      websiteReadbackVerified: true,
      websiteReadbackHash: sha256('history-readback'),
    });

    // Simulate a completion written before migration 062/dual-write existed.
    db.prepare('DELETE FROM purchase_completion_history WHERE shop_id = ?').run('shop-history');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM purchase_completion_history').get().count, 0);

    const purchaseDeletion = createAccountRemovalSqliteExecutor({
      db,
      now: () => '2026-07-16T01:00:00.000Z',
    }).execute({
      ownerType: 'purchase_account',
      ownerId: 'purchase-history-owner',
    });
    assert.equal(purchaseDeletion.deletedRows['registry:purchase-accounts'], 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM purchase_accounts`).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM purchase_browser_tasks`).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM purchase_browser_receipts`).get().count, 0);
    const history = db.prepare('SELECT * FROM purchase_completion_history').get();
    assert.equal(history.shop_id, 'shop-history');
    assert.equal(history.source_receipt_id, 'purchase_receipt_history');
    assert.equal(history.archive_origin, 'purchase-account-removal');
    assert.equal(JSON.stringify(history).includes('purchase-history-owner'), false);

    const shopDeletion = createAccountRemovalSqliteExecutor({ db }).execute(
      { ownerType: 'ozon_shop', ownerId: 'shop-history' },
      { operationId: 'delete-shop-history-operation' },
    );
    assert.equal(shopDeletion.deletedRows['registry:purchase-completion-history'], 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM purchase_completion_history').get().count, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check;').all(), []);
  } finally {
    db.close();
  }
});

test('cross-owner mutation during deletion is detected and the complete SQLite transaction rolls back', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare('INSERT INTO shops (id, name, status) VALUES (?, ?, ?)').run('shop_rollback_a', 'A', 'active');
    db.prepare('INSERT INTO shops (id, name, status) VALUES (?, ?, ?)').run('shop_rollback_b', 'B', 'active');
    db.prepare('INSERT INTO sync_jobs (id, shop_id, module) VALUES (?, ?, ?)').run(
      'job-rollback-a',
      'shop_rollback_a',
      'orders-a',
    );
    db.prepare('INSERT INTO sync_jobs (id, shop_id, module) VALUES (?, ?, ?)').run(
      'job-rollback-b',
      'shop_rollback_b',
      'orders-b',
    );
    db.exec(`
      CREATE TRIGGER inject_cross_owner_mutation
      AFTER DELETE ON sync_jobs
      WHEN OLD.shop_id = 'shop_rollback_a'
      BEGIN
        UPDATE sync_jobs SET module = 'tampered' WHERE shop_id = 'shop_rollback_b';
      END;
    `);

    const executor = createAccountRemovalSqliteExecutor({ db });
    assert.throws(
      () => executor.execute({ ownerType: 'ozon_shop', ownerId: 'shop_rollback_a' }),
      /ACCOUNT_REMOVAL_PRESERVATION_MISMATCH/u,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shops WHERE id = 'shop_rollback_a'").get().count, 1);
    assert.equal(db.prepare("SELECT module FROM sync_jobs WHERE shop_id = 'shop_rollback_a'").get().module, 'orders-a');
    assert.equal(db.prepare("SELECT module FROM sync_jobs WHERE shop_id = 'shop_rollback_b'").get().module, 'orders-b');
  } finally {
    db.close();
  }
});

test('contradictory cross-border preference owner ids fail closed before account deletion', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare(`
      INSERT INTO cross_border_accounts (id, name, status, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)
    `).run('bus_scope_a', 'A', FIXTURE_TIME, FIXTURE_TIME);
    db.prepare(`
      INSERT INTO cross_border_accounts (id, name, status, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)
    `).run('bus_scope_b', 'B', FIXTURE_TIME, FIXTURE_TIME);
    db.prepare(`
      INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
      VALUES ('cross-border-preferences', ?, ?, ?)
    `).run(JSON.stringify({ crossBorderAccountId: 'bus_scope_a', accountId: 'bus_scope_b' }), FIXTURE_TIME, FIXTURE_TIME);

    const executor = createAccountRemovalSqliteExecutor({ db });
    assert.throws(
      () => executor.execute({ ownerType: 'cross_border_bus', ownerId: 'bus_scope_a' }),
      /ACCOUNT_REMOVAL_CROSS_OWNER_SCOPE/u,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM cross_border_accounts").get().count, 2);
  } finally {
    db.close();
  }
});

test('file-backed deletion enables secure_delete, truncates WAL, and leaves no raw owner id in SQLite sidecars', () => {
  const tempRoot = mkdtempSync(resolve('.tmp-account-removal-'));
  const databasePath = join(tempRoot, 'account-removal.sqlite');
  const ownerId = 'purchase_physical_erase_unique_marker_01';
  let db;
  try {
    ({ db } = initializeDatabase({
      database: { path: databasePath, enableWal: true, busyTimeoutMs: 5000 },
    }));
    createPurchaseAccountRepository(db).saveAccount({
      id: ownerId,
      name: 'Physical erase fixture',
      loginPassword: 'physical-erase-secret-never-plaintext',
    });
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get();
    assert.notEqual(readFileSync(databasePath).indexOf(Buffer.from(ownerId, 'utf8')), -1);

    const result = createAccountRemovalSqliteExecutor({ db }).execute({
      ownerType: 'purchase_account',
      ownerId,
    });
    assert.equal(result.physicalStorage.secureDelete, true);
    assert.equal(result.physicalStorage.checkpoint.busy, 0);
    db.close();
    db = null;

    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      if (!existsSync(path)) continue;
      const bytes = readFileSync(path);
      assert.equal(bytes.indexOf(Buffer.from(ownerId, 'utf8')), -1, `${path} retained the raw owner id`);
      assert.equal(bytes.indexOf(Buffer.from('physical-erase-secret-never-plaintext', 'utf8')), -1, `${path} retained a raw secret`);
    }
    if (existsSync(`${databasePath}-wal`)) assert.equal(statSync(`${databasePath}-wal`).size, 0);
  } finally {
    if (db) db.close();
    const resolvedTempRoot = resolve(tempRoot);
    assert.ok(resolvedTempRoot.startsWith(`${resolve('.')}`));
    rmSync(resolvedTempRoot, { recursive: true, force: true });
  }
});
