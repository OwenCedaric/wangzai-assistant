import assert from 'node:assert/strict';
import test from 'node:test';
import { DATA_DOMAIN_REGISTRY } from '../data/dataDomainRegistry.js';
import {
  createRecoveryProfileCore,
  createRecoveryProfileCoreImporter,
  listRecoveryProfileOwners,
  removeRecoveryProfileOwner,
  RECOVERY_PROFILE_CORE_DOMAINS,
} from './recoveryProfileCore.js';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createProfileAssetRepository } from '../db/repositories/profileAssetRepository.js';

const encryptionKey = Buffer.alloc(32, 51);
const dedupeKey = Buffer.alloc(32, 52);
const aad = 'wangzai-recovery:v1:account-opaque:profile-core';

test('profile core explicitly covers every SQLite-backed required profile domain in the ownership registry', () => {
  const requiredProfileDomains = DATA_DOMAIN_REGISTRY
    .filter((policy) => (
      (policy.scopeType === 'profile' || policy.recoveryChannel === 'profile-core')
      && policy.backup === 'required'
    ))
    .filter((policy) => policy.storageAdapter !== 'secret-vault')
    .map((policy) => policy.domain)
    .sort();
  assert.deepEqual(
    [...RECOVERY_PROFILE_CORE_DOMAINS].sort(),
    [...requiredProfileDomains, 'shop-credentials'].sort(),
  );
});

test('profile core ignores the encrypted internal local smart-reply envelope', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    source.prepare(`
      INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
      VALUES ('smart-reply-local-internal-v1', ?, ?, ?)
    `).run(
      JSON.stringify({ version: 1, envelope: 'encrypted-private-state' }),
      '2026-08-24T00:00:00.000Z',
      '2026-08-24T00:00:00.000Z',
    );

    const candidate = createRecoveryProfileCore({ db: source, decryptShopSecret: () => null })
      .buildCandidate({ encryptionKey, dedupeKey, aad });
    const result = createRecoveryProfileCoreImporter({
      db: staging,
      encryptShopSecret: (value) => `target:${value}`,
    }).importCandidate({ candidate, encryptionKey, aad });

    assert.equal(result.profileSettings, 0);
    assert.equal(
      staging.prepare(`
        SELECT COUNT(*) AS count FROM profile_settings
        WHERE namespace = 'smart-reply-local-internal-v1'
      `).get().count,
      0,
    );
  } finally {
    source.close();
    staging.close();
  }
});

test('profile core restores the global Ozon front patrol login preference and purges it with the selected profile', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  const purgedStaging = createMigratedTestDb();
  const createdAt = '2026-08-14T00:00:00.000Z';
  try {
    source.prepare(`
      INSERT INTO integration_profiles (
        id, integration_type, platform_name, api_type, auth_mode, config_status,
        token_status, read_scope, write_scope, note, created_at, updated_at
      ) VALUES (?, 'ozon-follow-seller-session', 'Ozon买家', '网页登录', '浏览器 Cookie',
        '已保存', 'connected', '公开商品页读取', '不写 Ozon', '全店铺共用', ?, ?)
    `).run('follow-front-profile-a', createdAt, createdAt);
    source.prepare(`
      INSERT INTO follow_seller_login_preferences (
        preference_key, profile_id, created_at, updated_at
      ) VALUES ('global', ?, ?, ?)
    `).run('follow-front-profile-a', createdAt, createdAt);

    const candidate = createRecoveryProfileCore({ db: source, decryptShopSecret: () => null })
      .buildCandidate({ encryptionKey, dedupeKey, aad });
    const result = createRecoveryProfileCoreImporter({
      db: staging,
      encryptShopSecret: (value) => `target:${value}`,
    }).importCandidate({ candidate, encryptionKey, aad });
    assert.equal(result.followSellerLoginPreferences, 1);
    assert.deepEqual(
      { ...staging.prepare(`
        SELECT preference_key, profile_id
        FROM follow_seller_login_preferences
      `).get() },
      { preference_key: 'global', profile_id: 'follow-front-profile-a' },
    );

    const rewritten = removeRecoveryProfileOwner({
      candidate,
      owner: { ownerType: 'integration_profile', ownerId: 'follow-front-profile-a' },
      encryptionKey,
      dedupeKey,
      aad,
    });
    createRecoveryProfileCoreImporter({
      db: purgedStaging,
      encryptShopSecret: (value) => `target:${value}`,
    }).importCandidate({ candidate: rewritten.candidate, encryptionKey, aad });
    assert.equal(
      purgedStaging.prepare('SELECT COUNT(*) AS total FROM follow_seller_login_preferences').get().total,
      0,
    );
  } finally {
    source.close();
    staging.close();
    purgedStaging.close();
  }
});

test('profile owner rewrite removes one owner and its preference slice while preserving every other profile record', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    for (const [id, name, createdAt] of [
      ['shop-delete', 'Delete Shop', '2026-07-11T00:00:00.000Z'],
      ['shop-keep', 'Keep Shop', '2026-07-12T00:00:00.000Z'],
    ]) {
      source.prepare(`
        INSERT INTO shops (id, name, status, created_at, updated_at)
        VALUES (?, ?, 'active', ?, ?)
      `).run(id, name, createdAt, createdAt);
    }
    source.prepare(`
      INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
      VALUES ('ozon-shop-preferences', ?, ?, ?)
    `).run(JSON.stringify({
      shops: [{ id: 'shop-delete', name: 'Delete Shop' }, { id: 'shop-keep', name: 'Keep Shop' }],
      activeShopId: 'shop-delete',
      defaultWarehouseIds: { 'shop-delete': 'w-delete', 'shop-keep': 'w-keep' },
      globalFlag: true,
    }), '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    const candidate = createRecoveryProfileCore({ db: source, decryptShopSecret: () => null })
      .buildCandidate({ encryptionKey, dedupeKey, aad });
    assert.deepEqual(listRecoveryProfileOwners({ candidate, encryptionKey, aad }), [
      { ownerType: 'ozon_shop', ownerId: 'shop-delete', ownerIncarnation: '2026-07-11T00:00:00.000Z' },
      { ownerType: 'ozon_shop', ownerId: 'shop-keep', ownerIncarnation: '2026-07-12T00:00:00.000Z' },
    ]);
    const rewritten = removeRecoveryProfileOwner({
      candidate,
      owner: { ownerType: 'ozon_shop', ownerId: 'shop-delete' },
      encryptionKey,
      dedupeKey,
      aad,
    });
    assert.equal(rewritten.changed, true);
    assert.deepEqual(rewritten.removedOwners, [
      { ownerType: 'ozon_shop', ownerId: 'shop-delete', ownerIncarnation: '2026-07-11T00:00:00.000Z' },
    ]);
    assert.deepEqual(listRecoveryProfileOwners({ candidate: rewritten.candidate, encryptionKey, aad }), [
      { ownerType: 'ozon_shop', ownerId: 'shop-keep', ownerIncarnation: '2026-07-12T00:00:00.000Z' },
    ]);
    createRecoveryProfileCoreImporter({ db: staging, encryptShopSecret: (value) => `target:${value}` })
      .importCandidate({ candidate: rewritten.candidate, encryptionKey, aad });
    assert.deepEqual(
      staging.prepare('SELECT id FROM shops ORDER BY id').all().map((row) => row.id),
      ['shop-keep'],
    );
    const preferences = JSON.parse(staging.prepare(
      "SELECT value_json FROM profile_settings WHERE namespace = 'ozon-shop-preferences'",
    ).get().value_json);
    assert.deepEqual(preferences, {
      shops: [{ id: 'shop-keep', name: 'Keep Shop' }],
      activeShopId: 'shop-keep',
      defaultWarehouseIds: { 'shop-keep': 'w-keep' },
      globalFlag: true,
    });
  } finally {
    source.close();
    staging.close();
  }
});

test('profile core encrypts, restores, and owner-purges purchase browser tasks and receipts', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  const purgedStaging = createMigratedTestDb();
  const shopPurgedStaging = createMigratedTestDb();
  const createdAt = '2026-07-15T00:00:00.000Z';
  const taskId = 'purchase_task_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const receiptId = 'purchase_receipt_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const preview = {
    ownerId: 'purchase-backup-a',
    ownerIncarnation: createdAt,
    shopId: 'shop-backup-a',
    orderKey: 'order:backup-a',
    productKey: 'sku:backup-a',
    productTitle: 'Backup fixture product',
    variant: 'Blue',
    quantity: 1,
    address: 'Sensitive fixture address',
    expectedAmount: '88.60',
    targetUrl: 'http://127.0.0.1:49152/purchase-fixture',
  };
  const receipt = {
    orderNumber: 'FIXTURE-BACKUP-ORDER',
    amount: '88.60',
    status: 'submitted',
    pageUrl: preview.targetUrl,
    receivedAt: createdAt,
  };
  try {
    source.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES ('shop-backup-a', 'Backup shop A', 'active', ?, ?)
    `).run(createdAt, createdAt);
    source.prepare(`
      INSERT INTO purchase_accounts (id, name, is_default, created_at, updated_at)
      VALUES ('purchase-backup-a', 'Backup A', 1, ?, ?)
    `).run(createdAt, createdAt);
    source.prepare(`
      INSERT INTO purchase_browser_tasks (
        id, owner_id, owner_incarnation, shop_id, order_key, product_key,
        idempotency_key_hash, request_fingerprint, preview_encrypted,
        preview_fingerprint, status, attempt_count, receipt_id,
        created_at, updated_at, confirmed_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 1, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      'purchase-backup-a',
      createdAt,
      'shop-backup-a',
      'order:backup-a',
      'sku:backup-a',
      'a'.repeat(64),
      'b'.repeat(64),
      `source:${JSON.stringify(preview)}`,
      'c'.repeat(64),
      receiptId,
      createdAt,
      createdAt,
      createdAt,
      createdAt,
    );
    source.prepare(`
      INSERT INTO purchase_browser_receipts (
        id, task_id, owner_id, shop_id, attempt_id, receipt_encrypted,
        receipt_hash, website_readback_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId,
      taskId,
      'purchase-backup-a',
      'shop-backup-a',
      'purchase_attempt_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      `source:${JSON.stringify(receipt)}`,
      'd'.repeat(64),
      'e'.repeat(64),
      createdAt,
    );
    source.prepare(`
      INSERT INTO purchase_completion_history (
        shop_id, source_task_id, source_receipt_id,
        source_account_ref_hash, order_number_hash, receipt_encrypted,
        receipt_hash, website_readback_hash, order_product_encrypted,
        order_product_hash, source_summary_encrypted, source_summary_hash,
        archive_origin, completed_at, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'shop-backup-a',
      taskId,
      receiptId,
      'f'.repeat(64),
      '1'.repeat(64),
      `source:${JSON.stringify(receipt)}`,
      'd'.repeat(64),
      'e'.repeat(64),
      `source:${JSON.stringify({ orderKey: 'order:backup-a', productKey: 'sku:backup-a' })}`,
      '2'.repeat(64),
      `source:${JSON.stringify({ sourceKind: 'purchase-browser', accountRefHash: 'f'.repeat(64) })}`,
      '3'.repeat(64),
      'website-readback',
      createdAt,
      createdAt,
      createdAt,
      createdAt,
    );
    const decryptSource = (value) => String(value).replace(/^source:/u, '');
    const candidate = createRecoveryProfileCore({ db: source, decryptShopSecret: decryptSource })
      .buildCandidate({ encryptionKey, dedupeKey, aad });
    const encoded = JSON.stringify(candidate);
    assert.equal(encoded.includes(preview.address), false);
    assert.equal(encoded.includes(receipt.orderNumber), false);

    const restored = createRecoveryProfileCoreImporter({
      db: staging,
      encryptShopSecret: (value) => `target:${value}`,
    }).importCandidate({ candidate, encryptionKey, aad });
    assert.equal(restored.purchaseBrowserTasks, 1);
    assert.equal(restored.purchaseBrowserReceipts, 1);
    assert.equal(restored.purchaseCompletionHistory, 1);
    assert.equal(
      JSON.parse(staging.prepare('SELECT preview_encrypted FROM purchase_browser_tasks').get().preview_encrypted.slice(7)).address,
      preview.address,
    );
    assert.equal(
      JSON.parse(staging.prepare('SELECT receipt_encrypted FROM purchase_browser_receipts').get().receipt_encrypted.slice(7)).orderNumber,
      receipt.orderNumber,
    );
    assert.equal(
      JSON.parse(staging.prepare('SELECT receipt_encrypted FROM purchase_completion_history').get().receipt_encrypted.slice(7)).orderNumber,
      receipt.orderNumber,
    );

    const rewritten = removeRecoveryProfileOwner({
      candidate,
      owner: { ownerType: 'purchase_account', ownerId: 'purchase-backup-a' },
      encryptionKey,
      dedupeKey,
      aad,
    });
    assert.equal(rewritten.changed, true);
    createRecoveryProfileCoreImporter({
      db: purgedStaging,
      encryptShopSecret: (value) => `target:${value}`,
    }).importCandidate({ candidate: rewritten.candidate, encryptionKey, aad });
    assert.equal(purgedStaging.prepare('SELECT COUNT(*) AS count FROM purchase_accounts').get().count, 0);
    assert.equal(purgedStaging.prepare('SELECT COUNT(*) AS count FROM purchase_browser_tasks').get().count, 0);
    assert.equal(purgedStaging.prepare('SELECT COUNT(*) AS count FROM purchase_browser_receipts').get().count, 0);
    assert.equal(purgedStaging.prepare('SELECT COUNT(*) AS count FROM purchase_completion_history').get().count, 1);

    const shopRewritten = removeRecoveryProfileOwner({
      candidate,
      owner: { ownerType: 'ozon_shop', ownerId: 'shop-backup-a' },
      encryptionKey,
      dedupeKey,
      aad,
    });
    createRecoveryProfileCoreImporter({
      db: shopPurgedStaging,
      encryptShopSecret: (value) => `target:${value}`,
    }).importCandidate({ candidate: shopRewritten.candidate, encryptionKey, aad });
    assert.equal(shopPurgedStaging.prepare('SELECT COUNT(*) AS count FROM shops').get().count, 0);
    assert.equal(shopPurgedStaging.prepare('SELECT COUNT(*) AS count FROM purchase_completion_history').get().count, 0);
  } finally {
    source.close();
    staging.close();
    purgedStaging.close();
    shopPurgedStaging.close();
  }
});

test('profile core rewraps every registered profile credential domain through encrypted chunks into the target staging vault', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    source.prepare(`
      INSERT INTO shops (id, name, alias, client_id, api_key_encrypted, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('shop-a', 'Source Shop', 'Alias', 'client-a', 'source:api-key-a', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    source.prepare(`
      INSERT INTO cross_border_accounts (
        id, name, status, user_name_encrypted, password_encrypted,
        company_secret_encrypted, access_token_encrypted, app_uid_encrypted,
        default_storehouse, default_section, default_service, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'cross-border-a', 'Cross Border Source', 'active', 'source:cross-border-user', 'source:cross-border-password',
      'source:company-secret', 'source:access-token', 'source:app-uid',
      'Warehouse A', 'Section A', 'Service A', 'cross-border note', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z',
    );
    source.prepare(`
      INSERT INTO performance_accounts (
        id, name, status, client_id, client_secret_encrypted, last_test_at,
        last_test_message, campaign_count, statistics_task_count, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'performance-a', 'Performance Source', 'active', 'performance-client', 'source:performance-secret',
      '2026-07-11T00:00:00.000Z', 'test passed', 3, 2, 'performance note',
      '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z',
    );
    source.prepare(`
      INSERT INTO purchase_accounts (
        id, name, platform_name, login_account, login_password_encrypted,
        default_usage, risk_note, note, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'purchase-a', 'Purchase Source', '1688', 'buyer-a', 'source:purchase-password',
      '普通拍单', '验证码', 'purchase note', 1, '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z',
    );
    source.prepare(`
      INSERT INTO integration_profiles (
        id, integration_type, platform_name, api_type, auth_mode, config_status,
        token_status, read_scope, write_scope, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'integration-a', 'custom', 'Internal Tool', '工具服务', '本机配置', '已保存',
      '不适用', '配置读取', '人工确认', 'integration note',
      '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z',
    );
    source.prepare(`
      INSERT INTO integration_credentials (
        profile_id, base_url, login_account, login_password_encrypted,
        api_key_encrypted, last_test_status, last_test_message, last_test_at,
        last_test_metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'integration-a', 'https://api.seerfar.cn', 'integration-user',
      'source:integration-password', 'source:integration-api-key',
      'connected', 'test passed', '2026-07-11T00:00:00.000Z',
      JSON.stringify({ quota: 100 }),
      '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z',
    );
    source.prepare(`
      INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(
      'fee-settings',
      JSON.stringify({ version: 1, activeId: 'plan-a', plans: [{ id: 'plan-a', name: '默认方案' }] }),
      '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z',
    );
    const sourceAsset = createProfileAssetRepository(source).saveAsset({
      mimeType: 'image/png',
      dataBase64: Buffer.from('profile-watermark-asset').toString('base64'),
    }).asset;
    source.prepare(`
      INSERT INTO model_api_accounts (
        id, api_alias, provider, website_url, login_account, login_password_encrypted,
        base_url, api_key_encrypted, default_model, usage_scene, upscale, quality, style,
        detection_status, detected_source, detected_at, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'model-a', 'Image Source', 'codesonline', 'https://image.example', 'model-user', 'source:model-password',
      'https://image.example/v1', 'source:model-api-key', 'gpt-image-2', '文生图', '2k', 'high', 'vivid',
      '已保存', '规则', '2026-07-11T00:00:00.000Z', 1,
      '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z',
    );
    const candidate = createRecoveryProfileCore({
      db: source,
      decryptShopSecret: (value) => value.startsWith('source:') ? value.slice(7) : null,
    }).buildCandidate({ encryptionKey, dedupeKey, aad });
    const encodedCandidate = JSON.stringify(candidate);
    for (const secret of [
       'api-key-a', 'cross-border-user', 'cross-border-password', 'company-secret', 'access-token', 'app-uid', 'performance-secret', 'purchase-password',
      'model-password', 'model-api-key', 'integration-password', 'integration-api-key',
    ]) {
      assert.equal(encodedCandidate.includes(secret), false, `candidate leaked ${secret}`);
    }
    const result = createRecoveryProfileCoreImporter({
      db: staging,
      encryptShopSecret: (value) => `target:${value}`,
    }).importCandidate({ candidate, encryptionKey, aad });
    assert.deepEqual(result, {
      ok: true,
      mode: 'staging-only',
      shops: 1,
      credentials: 1,
      crossBorderAccounts: 1,
      performanceAccounts: 1,
      purchaseAccounts: 1,
      modelApiAccounts: 1,
      integrationProfiles: 1,
      followSellerLoginPreferences: 0,
      profileSettings: 1,
      profileAssets: 1,
      purchaseBrowserTasks: 0,
      purchaseBrowserReceipts: 0,
      purchaseCompletionHistory: 0,
    });
    assert.deepEqual(Object.assign({}, staging.prepare('SELECT id, name, alias, client_id, api_key_encrypted, status FROM shops WHERE id = ?').get('shop-a')), {
      id: 'shop-a', name: 'Source Shop', alias: 'Alias', client_id: 'client-a', api_key_encrypted: 'target:api-key-a', status: 'active',
    });
    assert.deepEqual(Object.assign({}, staging.prepare(`
      SELECT id, name, user_name_encrypted, password_encrypted,
        company_secret_encrypted, access_token_encrypted, app_uid_encrypted,
        default_storehouse, default_section, default_service, note
      FROM cross_border_accounts WHERE id = ?
    `).get('cross-border-a')), {
      id: 'cross-border-a',
      name: 'Cross Border Source',
      user_name_encrypted: 'target:cross-border-user',
      password_encrypted: 'target:cross-border-password',
      company_secret_encrypted: 'target:company-secret',
      access_token_encrypted: 'target:access-token',
      app_uid_encrypted: 'target:app-uid',
      default_storehouse: 'Warehouse A',
      default_section: 'Section A',
      default_service: 'Service A',
      note: 'cross-border note',
    });
    assert.deepEqual(Object.assign({}, staging.prepare(`
      SELECT id, name, client_id, client_secret_encrypted, campaign_count, statistics_task_count, note
      FROM performance_accounts WHERE id = ?
    `).get('performance-a')), {
      id: 'performance-a',
      name: 'Performance Source',
      client_id: 'performance-client',
      client_secret_encrypted: 'target:performance-secret',
      campaign_count: 3,
      statistics_task_count: 2,
      note: 'performance note',
    });
    assert.deepEqual(Object.assign({}, staging.prepare(`
      SELECT id, platform_name, login_account, login_password_encrypted, default_usage, risk_note, note, is_default
      FROM purchase_accounts WHERE id = ?
    `).get('purchase-a')), {
      id: 'purchase-a',
      platform_name: '1688',
      login_account: 'buyer-a',
      login_password_encrypted: 'target:purchase-password',
      default_usage: '普通拍单',
      risk_note: '验证码',
      note: 'purchase note',
      is_default: 1,
    });
    assert.deepEqual(Object.assign({}, staging.prepare(`
      SELECT id, api_alias, login_account, login_password_encrypted, base_url, api_key_encrypted,
        default_model, is_default
      FROM model_api_accounts WHERE id = ?
    `).get('model-a')), {
      id: 'model-a',
      api_alias: 'Image Source',
      login_account: 'model-user',
      login_password_encrypted: 'target:model-password',
      base_url: 'https://image.example/v1',
      api_key_encrypted: 'target:model-api-key',
      default_model: 'gpt-image-2',
      is_default: 1,
    });
    assert.deepEqual(Object.assign({}, staging.prepare(`
      SELECT id, integration_type, platform_name, api_type, auth_mode, config_status,
        token_status, read_scope, write_scope, note
      FROM integration_profiles WHERE id = ?
    `).get('integration-a')), {
      id: 'integration-a',
      integration_type: 'custom',
      platform_name: 'Internal Tool',
      api_type: '工具服务',
      auth_mode: '本机配置',
      config_status: '已保存',
      token_status: '不适用',
      read_scope: '配置读取',
      write_scope: '人工确认',
      note: 'integration note',
    });
    assert.deepEqual(Object.assign({}, staging.prepare(`
      SELECT profile_id, base_url, login_account, login_password_encrypted,
        api_key_encrypted, last_test_status, last_test_message, last_test_metadata_json
      FROM integration_credentials WHERE profile_id = ?
    `).get('integration-a')), {
      profile_id: 'integration-a',
      base_url: 'https://api.seerfar.cn',
      login_account: 'integration-user',
      login_password_encrypted: 'target:integration-password',
      api_key_encrypted: 'target:integration-api-key',
      last_test_status: 'connected',
      last_test_message: 'test passed',
      last_test_metadata_json: JSON.stringify({ quota: 100 }),
    });
    const recoveredProfileSetting = staging.prepare(
      'SELECT namespace, value_json FROM profile_settings WHERE namespace = ?'
    ).get('fee-settings');
    assert.equal(recoveredProfileSetting.namespace, 'fee-settings');
    assert.deepEqual(JSON.parse(recoveredProfileSetting.value_json), {
      version: 1, activeId: 'plan-a', plans: [{ id: 'plan-a', name: '默认方案' }],
    });
    assert.deepEqual(Object.assign({}, staging.prepare(
      'SELECT id, sha256, mime_type, byte_length, data_base64 FROM profile_assets WHERE id = ?'
    ).get(sourceAsset.id)), {
      id: sourceAsset.id,
      sha256: sourceAsset.sha256,
      mime_type: 'image/png',
      byte_length: sourceAsset.byteLength,
      data_base64: Buffer.from('profile-watermark-asset').toString('base64'),
    });
  } finally {
    source.close();
    staging.close();
  }
});

test('profile core restores the complete fixed purchase-plugin-context envelope through the required profile-settings domain', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    const value = {
      version: 1,
      context: {
        shopName: '夹具店铺',
        shopId: 'shop-plugin',
        shopClientId: 'client-plugin',
        orderId: 'order-plugin',
        orderKey: 'posting-plugin',
        productKey: 'product-plugin',
        legacyProductKey: 'legacy-plugin',
        offerId: 'offer-plugin',
        sku: 'sku-plugin',
        productName: '夹具商品',
        ozonOrderId: 'ozon-plugin',
        salesAmount: '12.50',
        productImageUrl: 'https://image.example/plugin.jpg',
        lockedAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:01.000Z',
        productIndex: 15,
      },
      updatedAt: '2026-07-13T00:00:02.000Z',
    };
    source.prepare(`
      INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(
      'purchase-plugin-context',
      JSON.stringify(value),
      '2026-07-13T00:00:02.000Z',
      '2026-07-13T00:00:02.000Z',
    );

    const candidate = createRecoveryProfileCore({ db: source, decryptShopSecret: () => null })
      .buildCandidate({ encryptionKey, dedupeKey, aad });
    const profileSettingsManifest = candidate.domains.find((domain) => domain.domain === 'profile-settings');
    assert.ok(profileSettingsManifest);
    const result = createRecoveryProfileCoreImporter({ db: staging, encryptShopSecret: (secret) => `target:${secret}` })
      .importCandidate({ candidate, encryptionKey, aad });
    assert.equal(result.profileSettings, 1);
    assert.deepEqual(
      JSON.parse(staging.prepare('SELECT value_json FROM profile_settings WHERE namespace = ?')
        .get('purchase-plugin-context').value_json),
      value,
    );
  } finally {
    source.close();
    staging.close();
  }
});

test('profile core keeps older two-chunk profile candidates restorable without manufacturing new accounts', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    source.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-a', 'Source Shop', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    const candidate = createRecoveryProfileCore({ db: source, decryptShopSecret: () => null })
      .buildCandidate({ encryptionKey, dedupeKey, aad });
    const legacyCandidate = {
      ...candidate,
      version: 1,
      domains: candidate.domains.filter((domain) => ['shops', 'shop-credentials'].includes(domain.domain)),
      chunks: candidate.chunks.filter((chunk) => candidate.domains
        .filter((domain) => ['shops', 'shop-credentials'].includes(domain.domain))
        .some((domain) => domain.chunkId === chunk.chunkId)),
    };
    const result = createRecoveryProfileCoreImporter({ db: staging, encryptShopSecret: (value) => `target:${value}` })
      .importCandidate({ candidate: legacyCandidate, encryptionKey, aad });
    assert.deepEqual(result, {
      ok: true,
      mode: 'staging-only',
      shops: 1,
      credentials: 0,
      crossBorderAccounts: 0,
      performanceAccounts: 0,
      purchaseAccounts: 0,
      modelApiAccounts: 0,
      integrationProfiles: 0,
      profileSettings: 0,
      profileAssets: 0,
      purchaseBrowserTasks: 0,
      purchaseBrowserReceipts: 0,
    });
    assert.equal(staging.prepare('SELECT count(*) AS count FROM cross_border_accounts').get().count, 0);
    assert.equal(staging.prepare('SELECT count(*) AS count FROM performance_accounts').get().count, 0);
  } finally {
    source.close();
    staging.close();
  }
});

test('profile core keeps the previous v3 five-domain candidate restorable without manufacturing later profile domains', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    source.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-a', 'Source Shop', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    const candidate = createRecoveryProfileCore({ db: source, decryptShopSecret: () => null })
      .buildCandidate({ encryptionKey, dedupeKey, aad });
    const legacyDomains = candidate.domains.filter((domain) =>
      ![
        'integration-profiles',
        'integration-credentials',
        'follow-seller-login-preferences',
        'model-api-accounts',
        'profile-settings',
        'profile-assets',
        'purchase-browser-tasks',
        'purchase-browser-receipts',
        'purchase-completion-history',
      ].includes(domain.domain)
    );
    const legacyCandidate = {
      ...candidate,
      version: 3,
      domains: legacyDomains,
      chunks: candidate.chunks.filter((chunk) => legacyDomains.some((domain) => domain.chunkId === chunk.chunkId)),
    };
    const result = createRecoveryProfileCoreImporter({ db: staging, encryptShopSecret: (value) => `target:${value}` })
      .importCandidate({ candidate: legacyCandidate, encryptionKey, aad });
    assert.equal(result.integrationProfiles, 0);
    assert.equal(result.modelApiAccounts, 0);
    assert.equal(result.profileSettings, 0);
    assert.equal(result.profileAssets, 0);
    assert.equal(staging.prepare('SELECT count(*) AS count FROM integration_profiles').get().count, 0);
    assert.equal(staging.prepare('SELECT count(*) AS count FROM model_api_accounts').get().count, 0);
    assert.equal(staging.prepare('SELECT count(*) AS count FROM profile_settings').get().count, 0);
  } finally {
    source.close();
    staging.close();
  }
});

test('profile core keeps the previous v4 six-domain candidate restorable without manufacturing model API accounts', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    source.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-a', 'Source Shop', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    source.prepare(`
      INSERT INTO integration_profiles (
        id, integration_type, platform_name, api_type, auth_mode, config_status,
        token_status, read_scope, write_scope, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'integration-a', 'custom', 'Internal Tool', '工具服务', '本机配置', '已保存',
      '不适用', '配置读取', '人工确认', 'integration note',
      '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z',
    );
    const candidate = createRecoveryProfileCore({ db: source, decryptShopSecret: () => null })
      .buildCandidate({ encryptionKey, dedupeKey, aad });
    const legacyDomains = candidate.domains.filter((domain) =>
      ![
        'integration-credentials',
        'follow-seller-login-preferences',
        'model-api-accounts',
        'profile-settings',
        'profile-assets',
        'purchase-browser-tasks',
        'purchase-browser-receipts',
        'purchase-completion-history',
      ].includes(domain.domain)
    );
    const legacyCandidate = {
      ...candidate,
      version: 4,
      domains: legacyDomains,
      chunks: candidate.chunks.filter((chunk) => legacyDomains.some((domain) => domain.chunkId === chunk.chunkId)),
    };
    const result = createRecoveryProfileCoreImporter({ db: staging, encryptShopSecret: (value) => `target:${value}` })
      .importCandidate({ candidate: legacyCandidate, encryptionKey, aad });
    assert.equal(result.integrationProfiles, 1);
    assert.equal(result.modelApiAccounts, 0);
    assert.equal(result.profileSettings, 0);
    assert.equal(result.profileAssets, 0);
    assert.equal(staging.prepare('SELECT count(*) AS count FROM integration_profiles').get().count, 1);
    assert.equal(staging.prepare('SELECT count(*) AS count FROM model_api_accounts').get().count, 0);
    assert.equal(staging.prepare('SELECT count(*) AS count FROM profile_settings').get().count, 0);
  } finally {
    source.close();
    staging.close();
  }
});

test('profile core keeps the previous v5 seven-domain candidate restorable without manufacturing profile settings', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    source.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-a', 'Source Shop', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    const candidate = createRecoveryProfileCore({ db: source, decryptShopSecret: () => null })
      .buildCandidate({ encryptionKey, dedupeKey, aad });
    const legacyDomains = candidate.domains.filter((domain) =>
      ![
        'integration-credentials',
        'follow-seller-login-preferences',
        'profile-settings',
        'profile-assets',
        'purchase-browser-tasks',
        'purchase-browser-receipts',
        'purchase-completion-history',
      ].includes(domain.domain)
    );
    const legacyCandidate = {
      ...candidate,
      version: 5,
      domains: legacyDomains,
      chunks: candidate.chunks.filter((chunk) => legacyDomains.some((domain) => domain.chunkId === chunk.chunkId)),
    };
    const result = createRecoveryProfileCoreImporter({ db: staging, encryptShopSecret: (value) => `target:${value}` })
      .importCandidate({ candidate: legacyCandidate, encryptionKey, aad });
    assert.equal(result.profileSettings, 0);
    assert.equal(result.profileAssets, 0);
    assert.equal(staging.prepare('SELECT count(*) AS count FROM profile_settings').get().count, 0);
  } finally {
    source.close();
    staging.close();
  }
});

test('profile core keeps the previous v6 eight-domain candidate restorable without manufacturing profile assets', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    source.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-a', 'Source Shop', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    const candidate = createRecoveryProfileCore({ db: source, decryptShopSecret: () => null })
      .buildCandidate({ encryptionKey, dedupeKey, aad });
    const legacyDomains = candidate.domains.filter((domain) =>
      ![
        'integration-credentials',
        'follow-seller-login-preferences',
        'profile-assets',
        'purchase-browser-tasks',
        'purchase-browser-receipts',
        'purchase-completion-history',
      ].includes(domain.domain)
    );
    const legacyCandidate = {
      ...candidate,
      version: 6,
      domains: legacyDomains,
      chunks: candidate.chunks.filter((chunk) => legacyDomains.some((domain) => domain.chunkId === chunk.chunkId)),
    };
    const result = createRecoveryProfileCoreImporter({ db: staging, encryptShopSecret: (value) => `target:${value}` })
      .importCandidate({ candidate: legacyCandidate, encryptionKey, aad });
    assert.equal(result.profileAssets, 0);
    assert.equal(staging.prepare('SELECT count(*) AS count FROM profile_assets').get().count, 0);
  } finally {
    source.close();
    staging.close();
  }
});

test('profile core keeps the previous v7 nine-domain candidate restorable without manufacturing browser execution history', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    source.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-a', 'Source Shop', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    const candidate = createRecoveryProfileCore({ db: source, decryptShopSecret: () => null })
      .buildCandidate({ encryptionKey, dedupeKey, aad });
    const legacyDomains = candidate.domains.filter((domain) =>
      ![
        'integration-credentials',
        'follow-seller-login-preferences',
        'purchase-browser-tasks',
        'purchase-browser-receipts',
        'purchase-completion-history',
      ].includes(domain.domain)
    );
    const legacyCandidate = {
      ...candidate,
      version: 7,
      domains: legacyDomains,
      chunks: candidate.chunks.filter((chunk) => legacyDomains.some((domain) => domain.chunkId === chunk.chunkId)),
    };
    const result = createRecoveryProfileCoreImporter({ db: staging, encryptShopSecret: (value) => `target:${value}` })
      .importCandidate({ candidate: legacyCandidate, encryptionKey, aad });
    assert.equal(result.purchaseBrowserTasks, 0);
    assert.equal(result.purchaseBrowserReceipts, 0);
    assert.equal(staging.prepare('SELECT count(*) AS count FROM purchase_browser_tasks').get().count, 0);
    assert.equal(staging.prepare('SELECT count(*) AS count FROM purchase_browser_receipts').get().count, 0);
  } finally {
    source.close();
    staging.close();
  }
});

test('profile core keeps the previous v8 eleven-domain candidate restorable without manufacturing canonical completion history', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    source.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-a', 'Source Shop', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    const candidate = createRecoveryProfileCore({ db: source, decryptShopSecret: () => null })
      .buildCandidate({ encryptionKey, dedupeKey, aad });
    const legacyDomains = candidate.domains.filter(
      (domain) => ![
        'integration-credentials',
        'follow-seller-login-preferences',
        'purchase-completion-history',
      ].includes(domain.domain),
    );
    const legacyCandidate = {
      ...candidate,
      version: 8,
      domains: legacyDomains,
      chunks: candidate.chunks.filter((chunk) => legacyDomains.some((domain) => domain.chunkId === chunk.chunkId)),
    };
    const result = createRecoveryProfileCoreImporter({ db: staging, encryptShopSecret: (value) => `target:${value}` })
      .importCandidate({ candidate: legacyCandidate, encryptionKey, aad });
    assert.equal(Object.hasOwn(result, 'purchaseCompletionHistory'), false);
    assert.equal(staging.prepare('SELECT count(*) AS count FROM purchase_completion_history').get().count, 0);
  } finally {
    source.close();
    staging.close();
  }
});

test('owner-scoped cross-border profile settings restore only the selected account slice', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    for (const id of ['cross-border-a', 'cross-border-b']) {
      source.prepare(`
        INSERT INTO cross_border_accounts (id, name, status, created_at, updated_at)
        VALUES (?, ?, 'active', ?, ?)
      `).run(id, id, '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
    }
    source.prepare(`
      INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
      VALUES ('cross-border-preferences', ?, ?, ?)
    `).run(JSON.stringify({
      version: 1,
      crossBorderAccountId: 'cross-border-a',
      accountId: 'cross-border-b',
      cooperationWarehouse: 'SOURCE_GLOBAL_MUST_NOT_LEAK',
    }), '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
    staging.prepare(`
      INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
      VALUES ('cross-border-preferences', ?, ?, ?)
    `).run(JSON.stringify({
      version: 1,
      accountId: 'cross-border-b',
      cooperationWarehouse: 'TARGET_GLOBAL_MUST_SURVIVE',
    }), '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');

    const candidate = createRecoveryProfileCore({ db: source, decryptShopSecret: () => null })
      .buildOwnerCandidate({
        owner: { ownerType: 'cross_border_bus', ownerId: 'cross-border-a' },
        encryptionKey,
        dedupeKey,
        aad,
      });
    assert.equal(
      candidate.domains.find((domain) => domain.domain === 'profile-settings').recordCount,
      1,
    );
    const imported = createRecoveryProfileCoreImporter({
      db: staging,
      encryptShopSecret: (value) => `target:${value}`,
    }).importCandidate({ candidate, encryptionKey, aad });
    assert.equal(imported.profileSettingsMergeMode, 'owner-slice-merge');
    assert.deepEqual(
      staging.prepare('SELECT id FROM cross_border_accounts ORDER BY id').all().map((row) => row.id),
      ['cross-border-a'],
    );
    assert.deepEqual(
      JSON.parse(staging.prepare(`
        SELECT value_json FROM profile_settings WHERE namespace = 'cross-border-preferences'
      `).get().value_json),
      {
        version: 1,
        accountId: 'cross-border-b',
        cooperationWarehouse: 'TARGET_GLOBAL_MUST_SURVIVE',
        crossBorderAccountId: 'cross-border-a',
      },
    );
  } finally {
    source.close();
    staging.close();
  }
});

test('profile core rejects a partial current profile candidate before staging writes', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    source.prepare(`
      INSERT INTO shops (id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('shop-a', 'Source Shop', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    const candidate = createRecoveryProfileCore({ db: source, decryptShopSecret: () => null })
      .buildCandidate({ encryptionKey, dedupeKey, aad });
    const incomplete = {
      ...candidate,
      domains: candidate.domains.filter((domain) => domain.domain !== 'performance-accounts'),
      chunks: candidate.chunks.filter((chunk) => candidate.domains
        .filter((domain) => domain.domain !== 'performance-accounts')
        .some((domain) => domain.chunkId === chunk.chunkId)),
    };
    assert.throws(
      () => createRecoveryProfileCoreImporter({ db: staging, encryptShopSecret: (value) => `target:${value}` })
        .importCandidate({ candidate: incomplete, encryptionKey, aad }),
      /RESTORE_PROFILE_CANDIDATE_INVALID/,
    );
    assert.equal(staging.prepare('SELECT count(*) AS count FROM shops').get().count, 0);
  } finally {
    source.close();
    staging.close();
  }
});

test('profile core export rejects a credential that cannot be decrypted from the source vault', () => {
  const source = createMigratedTestDb();
  try {
    source.prepare(`
      INSERT INTO shops (id, name, api_key_encrypted, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('shop-a', 'Source Shop', 'unreadable', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    assert.throws(
      () => createRecoveryProfileCore({ db: source, decryptShopSecret: () => null }).buildCandidate({ encryptionKey, dedupeKey, aad }),
      /BACKUP_SECRET_DECRYPT_FAILED:shop-a/,
    );
  } finally {
    source.close();
  }
});
