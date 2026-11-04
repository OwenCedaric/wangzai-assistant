import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { canonicalJson } from './recoveryChunkCodec.js';
import { createRecoveryKeyEnvelope } from './recoveryKeyEnvelope.js';
import { createRecoveryKeysetStore } from './recoveryKeysetStore.js';
import { openDataBackupPackage } from './dataBackupPackage.js';
import { createRecoveryProfileCoreImporter } from './recoveryProfileCore.js';
import {
  createDataBackupService,
  DATA_BACKUP_SKIP_CONFIRMATION_CODE,
  getDataBackupDomainLabel,
} from './dataBackupService.js';

const NOW = '2026-07-17T00:00:00.000Z';
const RECOVERY_PASSPHRASE = 'different-primary-recovery-passphrase';
const COMMIT_CAPABILITY = Buffer.alloc(32, 7).toString('base64url');
const FORGED_COMMIT_CAPABILITY = Buffer.alloc(32, 8).toString('base64url');

test('data backup domain presentation never exposes internal English slugs', () => {
  assert.equal(getDataBackupDomainLabel('product-identities'), '商品识别信息');
  assert.equal(getDataBackupDomainLabel('product-dimension-facts'), '商品长宽高信息');
  assert.equal(getDataBackupDomainLabel('historical-order-facts'), '历史订单导入数据');
  assert.equal(getDataBackupDomainLabel('integration-profiles'), '外部服务配置');
  assert.equal(getDataBackupDomainLabel('cross-border-account-shop-bindings'), '跨境账号店铺绑定');
  assert.equal(getDataBackupDomainLabel('future-internal-domain'), '其他用户数据');
});

function createServiceFixture({ stagingDirectory = '' } = {}) {
  const db = createMigratedTestDb();
  db.prepare(`
    INSERT INTO shops (id, name, alias, status, shop_incarnation, created_at, updated_at)
    VALUES ('shop-a', 'Shop A', '一号店', 'active', 'incarnation-shop-a', ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO shops (id, name, alias, status, shop_incarnation, created_at, updated_at)
    VALUES ('shop-b', 'Shop B', '二号店', 'active', 'incarnation-shop-b', ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    UPDATE shops
    SET client_id = 'CLIENT_PRIVATE_SENTINEL',
        api_key_encrypted = 'encrypted:API_KEY_PRIVATE_SENTINEL'
    WHERE id = 'shop-a'
  `).run();
  db.prepare(`
    INSERT INTO purchase_order_overrides (
      id, shop_id, order_key, purchase_platform, purchase_order_number,
      source_cost_cny, manual_status, raw_json, created_at, updated_at
    ) VALUES ('override-a', 'shop-a', 'posting-a', 'pdd', 'PDD-001', 2.9, 'purchased',
      '{"manual":"PURCHASE_PRIVATE_SENTINEL"}', ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO purchase_source_links (
      id, shop_id, order_key, product_key, slot_index, platform, url, title,
      raw_json, created_at, updated_at
    ) VALUES ('purchase-link-a', 'shop-a', 'posting-a', 'product-a', 0, 'pdd',
      'https://example.invalid/purchase-a', '采购货源', '{"private":"purchase-link"}', ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO product_source_links (
      id, shop_id, product_key, slot_index, platform, url, title, raw_json,
      created_at, updated_at
    ) VALUES ('product-link-a', 'shop-a', 'product-a', 0, '1688',
      'https://example.invalid/product-a', '商品货源', '{"private":"product-link"}', ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO sales_source_links (
      id, shop_id, order_key, slot_index, platform, url, title, raw_json,
      created_at, updated_at
    ) VALUES ('sales-link-a', 'shop-a', 'posting-a', 0, 'pdd',
      'https://example.invalid/sales-a', '销售来源', '{"private":"sales-link"}', ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO cross_border_order_records (
      id, shop_id, record_key, order_id, purchase_order_number, sheet_order_sn,
      package_weight_kg, length_cm, width_cm, height_cm, raw_json, created_at, updated_at
    ) VALUES ('bus-a', 'shop-a', 'bus-record-a', '49774985', 'PDD-001', 'SHEET-001',
      0.07, 12, 8, 4, '{"sheet_info":{"private":"BUS_PRIVATE_SENTINEL"}}', ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO purchase_order_overrides (id, shop_id, order_key, note, created_at, updated_at)
    VALUES ('override-b', 'shop-b', 'posting-b', 'SHOP_B_PRIVATE_SENTINEL', ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO purchase_completion_history (
      shop_id, source_task_id, source_receipt_id,
      source_account_ref_hash, order_number_hash, receipt_encrypted,
      receipt_hash, website_readback_hash, order_product_encrypted,
      order_product_hash, source_summary_encrypted, source_summary_hash,
      archive_origin, completed_at, archived_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'shop-a',
    'purchase_task_data_backup',
    'purchase_receipt_data_backup',
    'a'.repeat(64),
    'b'.repeat(64),
    'encrypted:{"orderNumber":"PURCHASE_HISTORY_PRIVATE_SENTINEL"}',
    'c'.repeat(64),
    'd'.repeat(64),
    'encrypted:{"orderKey":"posting-a","productKey":"product-a"}',
    'e'.repeat(64),
    'encrypted:{"sourceKind":"purchase-browser"}',
    'f'.repeat(64),
    'website-readback',
    NOW,
    NOW,
    NOW,
    NOW,
  );
  db.prepare(`
    INSERT INTO purchase_accounts (id, name, created_at, updated_at)
    VALUES ('purchase-data-backup', '采购账号', ?, ?)
  `).run(NOW, NOW);
  for (const [suffix, shopId, privateValue] of [
    ['a', 'shop-a', 'SHOP_A_TASK_SENTINEL'],
    ['b', 'shop-b', 'SHOP_B_TASK_PRIVATE_SENTINEL'],
  ]) {
    const taskId = `purchase_task_shop_${suffix}`;
    const receiptId = `purchase_receipt_shop_${suffix}`;
    db.prepare(`
      INSERT INTO purchase_browser_tasks (
        id, owner_id, owner_incarnation, shop_id, order_key, product_key,
        idempotency_key_hash, request_fingerprint, preview_encrypted,
        preview_fingerprint, status, attempt_count, receipt_id,
        created_at, updated_at, confirmed_at, completed_at
      ) VALUES (?, 'purchase-data-backup', ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 1, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      NOW,
      shopId,
      `order-${suffix}`,
      `product-${suffix}`,
      (suffix === 'a' ? '1' : '2').repeat(64),
      (suffix === 'a' ? '3' : '4').repeat(64),
      `encrypted:${JSON.stringify({
        ownerId: 'purchase-data-backup',
        ownerIncarnation: NOW,
        targetUrl: `https://example.invalid/${privateValue}`,
      })}`,
      (suffix === 'a' ? '5' : '6').repeat(64),
      receiptId,
      NOW,
      NOW,
      NOW,
      NOW,
    );
    db.prepare(`
      INSERT INTO purchase_browser_receipts (
        id, task_id, owner_id, shop_id, attempt_id, receipt_encrypted,
        receipt_hash, website_readback_hash, created_at
      ) VALUES (?, ?, 'purchase-data-backup', ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId,
      taskId,
      shopId,
      `attempt-${suffix}`,
      `encrypted:${JSON.stringify({ status: 'completed', privateValue })}`,
      (suffix === 'a' ? '7' : '8').repeat(64),
      (suffix === 'a' ? '9' : 'a').repeat(64),
      NOW,
    );
  }
  db.prepare(`
    INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
    VALUES ('ozon-shop-preferences', ?, ?, ?)
  `).run(JSON.stringify({
    version: 1,
    activeShopId: 'shop-a',
    shops: [
      { id: 'shop-a', shopAlias: 'A店切片' },
      { id: 'shop-b', shopAlias: 'SHOP_B_PROFILE_PRIVATE_SENTINEL' },
    ],
    defaultWarehouseIds: { 'shop-a': 'warehouse-a', 'shop-b': 'warehouse-b-source' },
    globalFlag: 'SOURCE_GLOBAL_NOT_OWNER_SLICE',
  }), NOW, NOW);
  db.prepare(`
    INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
    VALUES ('purchase-plugin-context', ?, ?, ?)
  `).run(JSON.stringify({
    version: 1,
    context: { shopId: 'shop-a', orderKey: 'posting-a', productName: 'A店拍单上下文' },
    updatedAt: NOW,
  }), NOW, NOW);

  const keysetStore = createRecoveryKeysetStore({
    db,
    encrypt: (value) => `encrypted:${value}`,
    decrypt: (value) => String(value).replace(/^encrypted:/u, ''),
    randomUuid: () => '00000000-0000-4000-8000-000000000064',
  });
  keysetStore.initialize({ passphrase: RECOVERY_PASSPHRASE });
  const service = createDataBackupService({
    db,
    keysetStore,
    decryptShopSecret: (value) => String(value).replace(/^encrypted:/u, ''),
    stagingDirectory,
    now: () => new Date(NOW),
    createBackupId: () => 'data_backup_00000000-0000-4000-8000-000000000064',
  });
  return { db, keysetStore, service };
}

test('previewAll enumerates every real backup owner with isolated names, domains, and counts', () => {
  const { db, service } = createServiceFixture();
  try {
    db.prepare(`
      INSERT INTO cross_border_accounts (
        id, name, status, password_encrypted, created_at, updated_at
      ) VALUES ('bus-preview', '跨境预览账号', 'active', 'encrypted:bus-secret', ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
      VALUES ('cross-border-preferences', ?, ?, ?)
    `).run(JSON.stringify({
      version: 1,
      crossBorderAccountId: 'bus-preview',
      accountId: 'bus-preview',
    }), NOW, NOW);
    db.prepare(`
      INSERT INTO performance_accounts (
        id, name, status, client_id, client_secret_encrypted, created_at, updated_at
      ) VALUES ('promotion-preview', '推广预览账号', 'active', 'promotion-client',
        'encrypted:promotion-secret', ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO model_api_accounts (
        id, api_alias, provider, api_key_encrypted, created_at, updated_at
      ) VALUES ('model-preview', '模型预览账号', 'openai-compatible', 'encrypted:model-secret', ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO integration_profiles (
        id, integration_type, platform_name, created_at, updated_at
      ) VALUES ('integration-preview', 'custom', '外部服务预览账号', ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO integration_credentials (
        profile_id, base_url, api_key_encrypted, created_at, updated_at
      ) VALUES ('integration-preview', 'https://preview.example', 'encrypted:integration-secret', ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO follow_seller_login_preferences (
        preference_key, profile_id, created_at, updated_at
      ) VALUES ('global', 'integration-preview', ?, ?)
    `).run(NOW, NOW);

    const preview = service.previewAll();
    const owners = new Map(preview.owners.map((owner) => [
      `${owner.owner.ownerType}:${owner.owner.ownerId}`,
      owner,
    ]));
    assert.deepEqual([...owners.keys()].sort(), [
      'cross_border_bus:bus-preview',
      'integration_profile:integration-preview',
      'model_api_account:model-preview',
      'ozon_shop:shop-a',
      'ozon_shop:shop-b',
      'promotion_account:promotion-preview',
      'purchase_account:purchase-data-backup',
    ]);
    assert.deepEqual(preview.shops.map((shop) => shop.shopId).sort(), ['shop-a', 'shop-b']);
    assert.equal(
      preview.shops.find((shop) => shop.shopId === 'shop-a')?.clientId,
      'CLIENT_PRIVATE_SENTINEL',
    );
    assert.deepEqual(
      Object.fromEntries([...owners].map(([key, owner]) => [key, owner.displayName])),
      {
        'ozon_shop:shop-a': '一号店',
        'ozon_shop:shop-b': '二号店',
        'cross_border_bus:bus-preview': '跨境预览账号',
        'promotion_account:promotion-preview': '推广预览账号',
        'purchase_account:purchase-data-backup': '采购账号',
        'model_api_account:model-preview': '模型预览账号',
        'integration_profile:integration-preview': '外部服务预览账号',
      },
    );
    const domainCounts = (key) => Object.fromEntries(
      owners.get(key).domains.map((domain) => [domain.domain, domain.recordCount]),
    );
    assert.deepEqual(domainCounts('cross_border_bus:bus-preview'), {
      'cross-border-accounts': 1,
      'profile-settings': 1,
    });
    assert.deepEqual(domainCounts('promotion_account:promotion-preview'), {
      'performance-accounts': 1,
    });
    assert.equal(domainCounts('purchase_account:purchase-data-backup')['purchase-accounts'], 1);
    assert.deepEqual(domainCounts('model_api_account:model-preview'), {
      'model-api-accounts': 1,
    });
    assert.deepEqual(domainCounts('integration_profile:integration-preview'), {
      'follow-seller-login-preferences': 1,
      'integration-credentials': 1,
      'integration-profiles': 1,
    });
    assert.ok(preview.owners.every((owner) => owner.totalRecords > 0));
    assert.equal(preview.owners.some((owner) => owner.owner.ownerId === 'missing-owner'), false);
  } finally {
    db.close();
  }
});

test('user data export writes an opaque staging file without returning package bytes', () => {
  const stagingDirectory = mkdtempSync(path.join(tmpdir(), 'wangzai-data-backup-export-staging-'));
  const stagingFileName = `data-backup-export-${'ef'.repeat(32)}.wzb`;
  const { db, service } = createServiceFixture({ stagingDirectory });
  try {
    const preview = service.previewShop('shop-a').shops[0];
    const prepared = service.prepareExport({
      shopId: 'shop-a',
      expectedDataFingerprint: preview.dataFingerprint,
      commitCapability: COMMIT_CAPABILITY,
      stagingFileName,
    });
    assert.equal(prepared.stagingFileName, stagingFileName);
    assert.equal(prepared.contentB64u, undefined);
    const stagedPath = path.join(stagingDirectory, stagingFileName);
    assert.equal(existsSync(stagedPath), true);
    const bytes = readFileSync(stagedPath);
    assert.equal(bytes.byteLength, prepared.packageBytes);
    assert.equal(openDataBackupPackage({ bytes }).packageSha256, prepared.packageSha256);
  } finally {
    db.close();
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
});

test('user data export includes only selected domains while keeping restore identity mandatory', () => {
  const { db, service } = createServiceFixture();
  try {
    const preview = service.previewShop('shop-a').shops[0];
    const selectedDomains = ['shops', 'shop-credentials', 'purchase-overrides'];
    const prepared = service.prepareExport({
      shopId: 'shop-a',
      expectedDataFingerprint: preview.dataFingerprint,
      selectedDomains,
      commitCapability: COMMIT_CAPABILITY,
    });
    const opened = openDataBackupPackage({
      bytes: Buffer.from(prepared.contentB64u, 'base64url'),
    });
    assert.deepEqual(opened.domains.map((domain) => domain.domain), [
      'purchase-overrides',
      'shop-credentials',
      'shops',
    ]);
    assert.equal(opened.domains.some((domain) => domain.domain === 'product-source-links'), false);
    assert.notEqual(opened.dataFingerprint, preview.dataFingerprint);
    assert.equal(prepared.totalRecords, 3);
    assert.equal(service.listHistory('shop-a').backups[0].coverageMode, 'partial');
    assert.throws(
      () => service.prepareExport({
        shopId: 'shop-a',
        expectedDataFingerprint: preview.dataFingerprint,
        selectedDomains: ['purchase-overrides'],
        commitCapability: FORGED_COMMIT_CAPABILITY,
      }),
      /DATA_BACKUP_REQUIRED_DOMAIN_NOT_SELECTED/u,
    );
    assert.throws(
      () => service.prepareExport({
        shopId: 'shop-a',
        expectedDataFingerprint: preview.dataFingerprint,
        selectedDomains: [...selectedDomains, 'unknown-domain'],
        commitCapability: FORGED_COMMIT_CAPABILITY,
      }),
      /DATA_BACKUP_SELECTED_DOMAINS_INVALID/u,
    );
  } finally {
    db.close();
  }
});

test('user data export includes required shop facts, verifies the portable package, and stores no path', () => {
  const { db, keysetStore, service } = createServiceFixture();
  const staging = createMigratedTestDb();
  const conflictStaging = createMigratedTestDb();
  try {
    staging.prepare(`
      INSERT INTO purchase_accounts (id, name, created_at, updated_at)
      VALUES ('purchase-data-backup', '采购账号', ?, ?)
    `).run(NOW, NOW);
    staging.prepare(`
      INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
      VALUES ('ozon-shop-preferences', ?, ?, ?)
    `).run(JSON.stringify({
      version: 1,
      activeShopId: 'shop-b',
      shops: [{ id: 'shop-b', shopAlias: 'B店保留切片' }],
      defaultWarehouseIds: { 'shop-b': 'warehouse-b-target' },
      globalFlag: 'TARGET_GLOBAL_MUST_SURVIVE',
    }), NOW, NOW);
    const preview = service.previewShop('shop-a').shops[0];
    const counts = Object.fromEntries(preview.domains.map((domain) => [domain.domain, domain.recordCount]));
    assert.equal(counts['purchase-overrides'], 1);
    assert.equal(counts['purchase-source-links'], 1);
    assert.equal(counts['product-source-links'], 1);
    assert.equal(counts['sales-source-links'], 1);
    assert.equal(counts['cross-border-order-records'], 1);
    assert.equal(counts.shops, 1);
    assert.equal(counts['shop-credentials'], 1);
    assert.equal(counts['purchase-completion-history'], 1);
    assert.equal(counts['purchase-browser-tasks'], 1);
    assert.equal(counts['purchase-browser-receipts'], 1);
    assert.equal(counts['profile-settings'], 2);
    assert.equal(preview.totalRecords, 12);
    assert.equal(preview.domains.every((domain) => Number.isSafeInteger(domain.schemaVersion)), true);
    assert.equal(JSON.stringify(preview).includes('purchase_order_overrides'), false);

    const primaryEnvelopeId = keysetStore.readState().envelope.keyEnvelopeId;

    const prepared = service.prepareExport({
      shopId: 'shop-a',
      expectedDataFingerprint: preview.dataFingerprint,
      commitCapability: COMMIT_CAPABILITY,
    });
    assert.equal(prepared.suggestedFileName.includes('一号店'), false);
    assert.equal(prepared.suggestedFileName.includes('Shop A'), false);
    assert.equal(prepared.suggestedFileName.includes('shop-a'), false);
    const persistedFileName = db.prepare(`
      SELECT suggested_file_name FROM data_backup_exports WHERE backup_id = ?
    `).get(prepared.backupId).suggested_file_name;
    assert.equal(persistedFileName, prepared.suggestedFileName);
    assert.equal(/一号店|Shop A|shop-a/u.test(persistedFileName), false);
    const bytes = Buffer.from(prepared.contentB64u, 'base64url');
    const wire = bytes.toString('utf8');
    assert.equal(wire.includes('PURCHASE_PRIVATE_SENTINEL'), false);
    assert.equal(wire.includes('BUS_PRIVATE_SENTINEL'), false);
    assert.equal(wire.includes('SHOP_B_PRIVATE_SENTINEL'), false);
    assert.equal(wire.includes('CLIENT_PRIVATE_SENTINEL'), false);
    assert.equal(wire.includes('API_KEY_PRIVATE_SENTINEL'), false);
    assert.equal(wire.includes('PURCHASE_HISTORY_PRIVATE_SENTINEL'), false);
    assert.equal(wire.includes('SHOP_B_TASK_PRIVATE_SENTINEL'), false);
    assert.equal(wire.includes('SHOP_B_PROFILE_PRIVATE_SENTINEL'), false);
    const opened = openDataBackupPackage({ bytes });
    assert.equal(opened.passwordProtected, false);
    assert.equal(opened.unlockMode, 'self-contained-local');
    const changedUnlockPayload = JSON.parse(bytes.toString('utf8'));
    changedUnlockPayload.unlock.secretB64u = Buffer.alloc(32, 1).toString('base64url');
    assert.throws(
      () => openDataBackupPackage({
        bytes: Buffer.from(canonicalJson(changedUnlockPayload), 'utf8'),
      }),
      /RECOVERY_ENVELOPE_DECRYPT_FAILED/u,
    );
    assert.equal(opened.shopId, 'shop-a');
    assert.equal(opened.packageSha256, prepared.packageSha256);
    assert.equal(opened.dataFingerprint, preview.dataFingerprint);
    assert.equal(opened.domains.some((domain) => domain.domain === 'purchase-overrides'), true);
    assert.equal(opened.domains.some((domain) => domain.domain === 'shop-credentials'), true);
    assert.equal(opened.domains.some((domain) => domain.domain === 'purchase-completion-history'), true);
    assert.equal(opened.domains.find((domain) => domain.domain === 'purchase-browser-tasks').recordCount, 1);
    assert.equal(opened.domains.find((domain) => domain.domain === 'purchase-browser-receipts').recordCount, 1);
    assert.equal(opened.domains.find((domain) => domain.domain === 'profile-settings').recordCount, 2);
    assert.deepEqual(opened.owner, { ownerType: 'ozon_shop', ownerId: 'shop-a' });
    conflictStaging.prepare(`
      INSERT INTO purchase_accounts (id, name, created_at, updated_at)
      VALUES ('purchase-data-backup', '采购账号', ?, ?)
    `).run(NOW, NOW);
    const conflictingPluginContext = {
      version: 1,
      context: { shopId: 'shop-b', orderKey: 'posting-b' },
      updatedAt: NOW,
    };
    conflictStaging.prepare(`
      INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
      VALUES ('purchase-plugin-context', ?, ?, ?)
    `).run(JSON.stringify(conflictingPluginContext), NOW, NOW);
    assert.throws(
      () => createRecoveryProfileCoreImporter({
        db: conflictStaging,
        encryptShopSecret: (value) => `target:${value}`,
      }).importCandidate({
        candidate: opened.profileCandidate,
        encryptionKey: opened.keyset.chunkEncryptionKey,
        aad: opened.aad,
      }),
      /RESTORE_PROFILE_OWNER_SETTING_CONFLICT/u,
    );
    assert.deepEqual(
      JSON.parse(conflictStaging.prepare(`
        SELECT value_json FROM profile_settings WHERE namespace = 'purchase-plugin-context'
      `).get().value_json),
      conflictingPluginContext,
    );
    const imported = createRecoveryProfileCoreImporter({
      db: staging,
      encryptShopSecret: (value) => `target:${value}`,
    }).importCandidate({
      candidate: opened.profileCandidate,
      encryptionKey: opened.keyset.chunkEncryptionKey,
      aad: opened.aad,
    });
    assert.equal(imported.shops, 1);
    assert.equal(imported.credentials, 1);
    assert.equal(imported.purchaseCompletionHistory, 1);
    assert.equal(imported.purchaseBrowserTasks, 1);
    assert.equal(imported.purchaseBrowserReceipts, 1);
    assert.equal(imported.profileSettings, 2);
    assert.equal(imported.profileSettingsMergeMode, 'owner-slice-merge');
    assert.deepEqual(
      { ...staging.prepare(`SELECT client_id, api_key_encrypted FROM shops WHERE id = 'shop-a'`).get() },
      {
        client_id: 'CLIENT_PRIVATE_SENTINEL',
        api_key_encrypted: 'target:API_KEY_PRIVATE_SENTINEL',
      },
    );
    assert.equal(
      staging.prepare(`
        SELECT receipt_encrypted FROM purchase_completion_history
        WHERE shop_id = 'shop-a'
      `).get().receipt_encrypted,
      'target:{"orderNumber":"PURCHASE_HISTORY_PRIVATE_SENTINEL"}',
    );
    assert.deepEqual(
      staging.prepare('SELECT id FROM purchase_browser_tasks ORDER BY id').all().map((row) => row.id),
      ['purchase_task_shop_a'],
    );
    assert.deepEqual(
      staging.prepare('SELECT id FROM purchase_browser_receipts ORDER BY id').all().map((row) => row.id),
      ['purchase_receipt_shop_a'],
    );
    const restoredPreferences = JSON.parse(staging.prepare(`
      SELECT value_json FROM profile_settings WHERE namespace = 'ozon-shop-preferences'
    `).get().value_json);
    assert.deepEqual(restoredPreferences.shops, [
      { id: 'shop-b', shopAlias: 'B店保留切片' },
      { id: 'shop-a', shopAlias: 'A店切片' },
    ]);
    assert.deepEqual(restoredPreferences.defaultWarehouseIds, {
      'shop-b': 'warehouse-b-target',
      'shop-a': 'warehouse-a',
    });
    assert.equal(restoredPreferences.globalFlag, 'TARGET_GLOBAL_MUST_SURVIVE');
    assert.equal(restoredPreferences.activeShopId, 'shop-a');
    assert.deepEqual(
      JSON.parse(staging.prepare(`
        SELECT value_json FROM profile_settings WHERE namespace = 'purchase-plugin-context'
      `).get().value_json).context,
      { shopId: 'shop-a', orderKey: 'posting-a', productName: 'A店拍单上下文' },
    );
    assert.equal(openDataBackupPackage({ bytes, passphrase: RECOVERY_PASSPHRASE }).packageSha256, prepared.packageSha256);
    assert.equal(keysetStore.readState().envelope.keyEnvelopeId, primaryEnvelopeId);

    const legacyPayload = JSON.parse(bytes.toString('utf8'));
    delete legacyPayload.unlock;
    legacyPayload.transport.keyEnvelope = createRecoveryKeyEnvelope({
      keyset: opened.keyset,
      passphrase: 'legacy-portable-backup-passphrase',
      aad: opened.aad,
    });
    const legacyBytes = Buffer.from(canonicalJson(legacyPayload), 'utf8');
    assert.throws(
      () => openDataBackupPackage({ bytes: legacyBytes }),
      /DATA_BACKUP_LEGACY_PASSPHRASE_REQUIRED/u,
    );
    assert.equal(
      openDataBackupPackage({
        bytes: legacyBytes,
        passphrase: 'legacy-portable-backup-passphrase',
      }).passwordProtected,
      true,
    );

    const committed = service.commitExport({
      backupId: prepared.backupId,
      packageSha256: prepared.packageSha256,
      packageBytes: prepared.packageBytes,
      commitCapability: COMMIT_CAPABILITY,
    });
    assert.equal(committed.verified, true);
    assert.equal(committed.survivesAccountRemoval, true);
    const history = service.listHistory('shop-a');
    assert.equal(history.backups.length, 1);
    assert.equal(history.backups[0].status, 'verified');
    assert.equal(history.backups[0].totalRecords, 12);
    assert.ok(history.backups[0].logicalBytes > 0);
    assert.equal(history.backups[0].packageVersion, 1);
    assert.equal(history.backups[0].suggestedFileName, prepared.suggestedFileName);
    assert.equal(JSON.stringify(history).includes('C:\\'), false);
    assert.equal(JSON.stringify(history).includes('/tmp/'), false);
  } finally {
    conflictStaging.close();
    staging.close();
    db.close();
  }
});

test('user data export handles more than ten thousand manual rows in one verified package', () => {
  const { db, service } = createServiceFixture();
  try {
    const insert = db.prepare(`
      INSERT INTO product_source_links (
        id, shop_id, product_key, slot_index, platform, url, title,
        raw_json, created_at, updated_at
      ) VALUES (?, 'shop-a', ?, 0, '1688', ?, ?, NULL, ?, ?)
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let index = 0; index < 10_000; index += 1) {
        const suffix = String(index).padStart(5, '0');
        insert.run(
          `bulk-product-link-${suffix}`,
          `bulk-product-${suffix}`,
          `https://example.invalid/bulk/${suffix}`,
          `批量货源 ${suffix}`,
          NOW,
          NOW,
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const preview = service.previewShop('shop-a').shops[0];
    assert.equal(
      preview.domains.find((domain) => domain.domain === 'product-source-links')?.recordCount,
      10_001,
    );
    assert.ok(preview.totalRecords > 10_000);
    const prepared = service.prepareExport({
      shopId: 'shop-a',
      expectedDataFingerprint: preview.dataFingerprint,
      commitCapability: COMMIT_CAPABILITY,
    });
    const opened = openDataBackupPackage({
      bytes: Buffer.from(prepared.contentB64u, 'base64url'),
    });
    assert.equal(
      opened.domains.find((domain) => domain.domain === 'product-source-links')?.recordCount,
      10_001,
    );
    assert.equal(opened.dataFingerprint, preview.dataFingerprint);
    assert.equal(opened.packageSha256, prepared.packageSha256);
  } finally {
    db.close();
  }
});

test('data fingerprint is deterministic and changes with SQLite schema generation or shop incarnation', () => {
  const { db, service } = createServiceFixture();
  try {
    const first = service.previewShop('shop-a').shops[0];
    const repeated = service.previewShop('shop-a').shops[0];
    assert.equal(repeated.dataFingerprint, first.dataFingerprint);

    db.prepare(`
      UPDATE shops SET api_key_encrypted = 'encrypted:API_KEY_PRIVATE_SENTINEL_NEXT'
      WHERE id = 'shop-a'
    `).run();
    const credentialChanged = service.previewShop('shop-a').shops[0];
    assert.notEqual(credentialChanged.dataFingerprint, first.dataFingerprint);

    db.prepare(`
      UPDATE purchase_completion_history
      SET source_summary_encrypted = 'encrypted:{"sourceKind":"purchase-browser-next"}'
      WHERE shop_id = 'shop-a'
    `).run();
    const completionHistoryChanged = service.previewShop('shop-a').shops[0];
    assert.notEqual(completionHistoryChanged.dataFingerprint, credentialChanged.dataFingerprint);

    db.prepare(`
      UPDATE purchase_browser_tasks SET order_key = 'order-a-next'
      WHERE id = 'purchase_task_shop_a'
    `).run();
    const purchaseTaskChanged = service.previewShop('shop-a').shops[0];
    assert.notEqual(purchaseTaskChanged.dataFingerprint, completionHistoryChanged.dataFingerprint);

    const preferences = JSON.parse(db.prepare(`
      SELECT value_json FROM profile_settings WHERE namespace = 'ozon-shop-preferences'
    `).get().value_json);
    preferences.defaultWarehouseIds['shop-a'] = 'warehouse-a-next';
    db.prepare(`
      UPDATE profile_settings SET value_json = ? WHERE namespace = 'ozon-shop-preferences'
    `).run(JSON.stringify(preferences));
    const profileSliceChanged = service.previewShop('shop-a').shops[0];
    assert.notEqual(profileSliceChanged.dataFingerprint, purchaseTaskChanged.dataFingerprint);
    const nextUserVersion = first.sqliteUserVersion + 1;

    db.exec(`PRAGMA user_version = ${nextUserVersion};`);
    const schemaChanged = service.previewShop('shop-a').shops[0];
    assert.notEqual(schemaChanged.dataFingerprint, profileSliceChanged.dataFingerprint);
    assert.equal(schemaChanged.sqliteUserVersion, nextUserVersion);

    db.prepare(`UPDATE shops SET shop_incarnation = 'incarnation-shop-a-next' WHERE id = 'shop-a'`).run();
    const incarnationChanged = service.previewShop('shop-a').shops[0];
    assert.notEqual(incarnationChanged.dataFingerprint, schemaChanged.dataFingerprint);
  } finally {
    db.close();
  }
});

test('account removal backup gate accepts only a matching verified export or an explicit independent skip', () => {
  const { db, service } = createServiceFixture();
  try {
    const previewFingerprint = 'a'.repeat(64);
    const review = service.reviewAccountRemoval({
      owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' },
      previewFingerprint,
    });
    assert.equal(review.required, true);
    assert.equal(review.totalRecords, 12);
    assert.throws(() => service.authorizeAccountRemoval({
      owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' },
      previewFingerprint,
    }), /ACCOUNT_REMOVAL_BACKUP_REVIEW_REQUIRED/u);

    const prepared = service.prepareExport({
      shopId: 'shop-a',
      expectedDataFingerprint: review.dataFingerprint,
      commitCapability: COMMIT_CAPABILITY,
    });
    service.commitExport({
      backupId: prepared.backupId,
      packageSha256: prepared.packageSha256,
      packageBytes: prepared.packageBytes,
      commitCapability: COMMIT_CAPABILITY,
    });
    const authorized = service.authorizeAccountRemoval({
      owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' },
      previewFingerprint,
      authorization: {
        outcome: 'exported',
        backupId: prepared.backupId,
        previewFingerprint,
        dataFingerprint: review.dataFingerprint,
      },
    });
    assert.equal(authorized.outcome, 'exported');

    db.prepare(`UPDATE purchase_order_overrides SET note = 'changed' WHERE id = 'override-a'`).run();
    assert.throws(() => service.authorizeAccountRemoval({
      owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' },
      previewFingerprint,
      authorization: {
        outcome: 'recent-verified',
        backupId: prepared.backupId,
        previewFingerprint,
        dataFingerprint: review.dataFingerprint,
      },
    }), /ACCOUNT_REMOVAL_BACKUP_STALE/u);

    const current = service.reviewAccountRemoval({
      owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' },
      previewFingerprint,
    });
    assert.throws(() => service.authorizeAccountRemoval({
      owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' },
      previewFingerprint,
      authorization: {
        outcome: 'explicitly-skipped',
        previewFingerprint,
        dataFingerprint: current.dataFingerprint,
        skipConfirmationCode: 'DELETE_ACCOUNT_PERMANENTLY',
      },
    }), /ACCOUNT_REMOVAL_BACKUP_SKIP_CONFIRMATION_REQUIRED/u);
    assert.equal(service.authorizeAccountRemoval({
      owner: { ownerType: 'ozon_shop', ownerId: 'shop-a' },
      previewFingerprint,
      authorization: {
        outcome: 'explicitly-skipped',
        previewFingerprint,
        dataFingerprint: current.dataFingerprint,
        skipConfirmationCode: DATA_BACKUP_SKIP_CONFIRMATION_CODE,
      },
    }).outcome, 'explicitly-skipped');
  } finally {
    db.close();
  }
});

test('verified export requires one unforgeable commit capability and consumes it exactly once', () => {
  const { db, service } = createServiceFixture();
  try {
    const preview = service.previewShop('shop-a').shops[0];
    const prepared = service.prepareExport({
      shopId: 'shop-a',
      expectedDataFingerprint: preview.dataFingerprint,
      commitCapability: COMMIT_CAPABILITY,
    });

    assert.throws(() => service.commitExport({
      backupId: prepared.backupId,
      packageSha256: prepared.packageSha256,
      packageBytes: prepared.packageBytes,
      commitCapability: FORGED_COMMIT_CAPABILITY,
    }), /DATA_BACKUP_COMMIT_CAPABILITY_INVALID/u);
    assert.throws(() => service.commitExport({
      backupId: prepared.backupId,
      packageSha256: 'f'.repeat(64),
      packageBytes: prepared.packageBytes,
      commitCapability: COMMIT_CAPABILITY,
    }), /DATA_BACKUP_FILE_READBACK_MISMATCH/u);

    assert.equal(service.commitExport({
      backupId: prepared.backupId,
      packageSha256: prepared.packageSha256,
      packageBytes: prepared.packageBytes,
      commitCapability: COMMIT_CAPABILITY,
    }).verified, true);
    assert.throws(() => service.commitExport({
      backupId: prepared.backupId,
      packageSha256: prepared.packageSha256,
      packageBytes: prepared.packageBytes,
      commitCapability: COMMIT_CAPABILITY,
    }), /DATA_BACKUP_COMMIT_CAPABILITY_CONSUMED/u);
    assert.throws(() => service.failExport({
      backupId: prepared.backupId,
      failureCode: 'FORGED_REPLAY',
      commitCapability: COMMIT_CAPABILITY,
    }), /DATA_BACKUP_COMMIT_CAPABILITY_CONSUMED/u);
  } finally {
    db.close();
  }
});

test('purchase account preview, encrypted export, and deletion authorization bind the exact owner fingerprint', () => {
  const { db, service } = createServiceFixture();
  const owner = { ownerType: 'purchase_account', ownerId: 'purchase-private-a' };
  try {
    db.prepare(`
      INSERT INTO purchase_accounts (
        id, name, login_password_encrypted, created_at, updated_at
      ) VALUES (?, '采购账号 A', ?, ?, ?)
    `).run(
      owner.ownerId,
      'encrypted:PURCHASE_ACCOUNT_SECRET_SENTINEL',
      '2026-07-17T03:00:00.000Z',
      '2026-07-17T03:00:00.000Z',
    );
    db.prepare(`
      INSERT INTO purchase_browser_tasks (
        id, owner_id, owner_incarnation, shop_id, order_key, product_key,
        idempotency_key_hash, request_fingerprint, preview_encrypted,
        preview_fingerprint, status, created_at, updated_at
      ) VALUES (
        'purchase-task-private-a', ?, 'purchase-incarnation-a', 'shop-a',
        'order-private-a', 'product-private-a', 'idem-private-a',
        'request-private-a', ?, 'preview-private-a', 'previewed', ?, ?
      )
    `).run(
      owner.ownerId,
      'encrypted:{"address":"PURCHASE_TASK_PII_SENTINEL"}',
      '2026-07-17T03:10:00.000Z',
      '2026-07-17T03:10:00.000Z',
    );
    db.prepare(`
      INSERT INTO purchase_browser_receipts (
        id, task_id, owner_id, shop_id, attempt_id, receipt_encrypted,
        receipt_hash, website_readback_hash, created_at
      ) VALUES (
        'purchase-receipt-private-a', 'purchase-task-private-a', ?, 'shop-a',
        'attempt-private-a', ?, 'receipt-private-a', 'readback-private-a', ?
      )
    `).run(
      owner.ownerId,
      'encrypted:{"orderNumber":"PURCHASE_RECEIPT_PII_SENTINEL"}',
      '2026-07-17T03:20:00.000Z',
    );

    const removalPreviewFingerprint = 'd'.repeat(64);
    const review = service.reviewAccountRemoval({ owner, previewFingerprint: removalPreviewFingerprint });
    assert.equal(review.required, true);
    assert.equal(review.totalRecords, 3);
    assert.deepEqual(
      Object.fromEntries(review.domains.map((domain) => [domain.domain, domain.recordCount])),
      {
        'purchase-accounts': 1,
        'purchase-browser-receipts': 1,
        'purchase-browser-tasks': 1,
      },
    );
    assert.throws(
      () => service.authorizeAccountRemoval({ owner, previewFingerprint: removalPreviewFingerprint }),
      /ACCOUNT_REMOVAL_BACKUP_REVIEW_REQUIRED/u,
    );

    const prepared = service.prepareExport({
      owner,
      expectedDataFingerprint: review.dataFingerprint,
      commitCapability: COMMIT_CAPABILITY,
    });
    const bytes = Buffer.from(prepared.contentB64u, 'base64url');
    const wire = bytes.toString('utf8');
    for (const sentinel of [
      'PURCHASE_ACCOUNT_SECRET_SENTINEL',
      'PURCHASE_TASK_PII_SENTINEL',
      'PURCHASE_RECEIPT_PII_SENTINEL',
      owner.ownerId,
    ]) assert.equal(wire.includes(sentinel), false);
    const opened = openDataBackupPackage({ bytes });
    assert.deepEqual(opened.owner, owner);
    assert.equal(opened.shopId, null);
    assert.equal(opened.dataFingerprint, review.dataFingerprint);
    assert.deepEqual(
      opened.domains.map((domain) => domain.domain).sort(),
      ['purchase-accounts', 'purchase-browser-receipts', 'purchase-browser-tasks'],
    );

    const committed = service.commitExport({
      backupId: prepared.backupId,
      packageSha256: prepared.packageSha256,
      packageBytes: prepared.packageBytes,
      commitCapability: COMMIT_CAPABILITY,
    });
    assert.equal(committed.verified, true);
    assert.equal(service.listOwnerHistory(owner).backups[0].backupId, prepared.backupId);
    assert.equal(service.authorizeAccountRemoval({
      owner,
      previewFingerprint: removalPreviewFingerprint,
      authorization: {
        outcome: 'exported',
        backupId: prepared.backupId,
        previewFingerprint: removalPreviewFingerprint,
        dataFingerprint: review.dataFingerprint,
      },
    }).backupId, prepared.backupId);

    const otherOwner = { ownerType: 'purchase_account', ownerId: 'purchase-private-b' };
    db.prepare(`
      INSERT INTO purchase_accounts (id, name, created_at, updated_at)
      VALUES (?, '采购账号 B', ?, ?)
    `).run(otherOwner.ownerId, '2026-07-17T04:00:00.000Z', '2026-07-17T04:00:00.000Z');
    const otherReview = service.reviewAccountRemoval({
      owner: otherOwner,
      previewFingerprint: removalPreviewFingerprint,
    });
    assert.throws(() => service.authorizeAccountRemoval({
      owner: otherOwner,
      previewFingerprint: removalPreviewFingerprint,
      authorization: {
        outcome: 'exported',
        backupId: prepared.backupId,
        previewFingerprint: removalPreviewFingerprint,
        dataFingerprint: otherReview.dataFingerprint,
      },
    }), /ACCOUNT_REMOVAL_BACKUP_NOT_VERIFIED/u);

    db.prepare(`
      UPDATE purchase_browser_tasks
      SET preview_encrypted = 'encrypted:{"address":"changed"}',
          preview_fingerprint = 'preview-private-a-changed'
      WHERE id = 'purchase-task-private-a'
    `).run();
    const changed = service.reviewAccountRemoval({ owner, previewFingerprint: removalPreviewFingerprint });
    assert.notEqual(changed.dataFingerprint, review.dataFingerprint);
    assert.throws(() => service.authorizeAccountRemoval({
      owner,
      previewFingerprint: removalPreviewFingerprint,
      authorization: {
        outcome: 'recent-verified',
        backupId: prepared.backupId,
        previewFingerprint: removalPreviewFingerprint,
        dataFingerprint: review.dataFingerprint,
      },
    }), /ACCOUNT_REMOVAL_BACKUP_STALE/u);
  } finally {
    db.close();
  }
});
