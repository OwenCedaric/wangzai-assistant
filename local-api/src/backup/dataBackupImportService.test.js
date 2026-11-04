import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createExternalOzonIdentityHash } from '../db/repositories/shopIdentityRepository.js';
import { canonicalJson } from './recoveryChunkCodec.js';
import { createRecoveryKeyEnvelope } from './recoveryKeyEnvelope.js';
import { openDataBackupPackage } from './dataBackupPackage.js';
import { createDataBackupService } from './dataBackupService.js';
import { createDataBackupImportService } from './dataBackupImportService.js';
import { createRecoveryKeysetStore } from './recoveryKeysetStore.js';

const NOW = '2026-07-17T08:00:00.000Z';
const RECOVERY_PASSPHRASE = 'local-recovery-passphrase';
const CLIENT_ID = 'OZON-CLIENT-STABLE-001';
const COMMIT_CAPABILITY = Buffer.alloc(32, 4).toString('base64url');

const encryptBusinessSecret = (value) => value ? `box:${value}` : null;
const decryptBusinessSecret = (value) => {
  const text = String(value || '');
  return text.startsWith('box:') ? text.slice(4) : null;
};

function insertShop(db, {
  id,
  name,
  alias,
  clientId = CLIENT_ID,
  apiKey,
  profileId = 'default',
  incarnation,
}) {
  db.prepare(`
    INSERT INTO shops (
      id, name, alias, client_id, api_key_encrypted, status,
      profile_id, external_identity_hash, shop_incarnation,
      credential_revision, bound_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, 3, ?, ?, ?)
  `).run(
    id,
    name,
    alias ?? null,
    clientId,
    encryptBusinessSecret(apiKey),
    profileId,
    createExternalOzonIdentityHash(clientId),
    incarnation,
    NOW,
    NOW,
    NOW,
  );
}

function createBackupService(db, suffix, decryptShopSecret = decryptBusinessSecret) {
  const keysetStore = createRecoveryKeysetStore({
    db,
    encrypt: (value) => `vault:${value}`,
    decrypt: (value) => String(value || '').replace(/^vault:/u, ''),
    randomUuid: () => `00000000-0000-4000-8000-0000000000${suffix}`,
  });
  keysetStore.initialize({ passphrase: RECOVERY_PASSPHRASE });
  return createDataBackupService({
    db,
    keysetStore,
    decryptShopSecret,
    now: () => new Date(NOW),
    createBackupId: () => `data_backup_import_fixture_${suffix}`,
  });
}

function createPortablePackage({ withPurchaseHistory = false, selectedDomains } = {}) {
  const db = createMigratedTestDb();
  insertShop(db, {
    id: 'old-local-shop-id',
    name: '旧设备店铺',
    alias: '旧别名',
    apiKey: 'SOURCE-API-KEY-MUST-NOT-REPLACE-CURRENT',
    incarnation: 'source-incarnation',
  });
  db.prepare(`
    INSERT INTO product_source_links (
      id, shop_id, product_key, slot_index, platform, url, title,
      raw_json, created_at, updated_at
    ) VALUES (
      'link-source', 'old-local-shop-id', 'offer-001', 0, '1688',
      'https://source.invalid/item', '来源标题', '{"source":true}', ?, ?
    )
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
    VALUES ('ozon-shop-preferences', ?, ?, ?)
  `).run(JSON.stringify({
    version: 1,
    activeShopId: 'old-local-shop-id',
    shops: [{ id: 'old-local-shop-id', shopAlias: '来源设置别名', note: '来源补充值' }],
    defaultWarehouseIds: { 'old-local-shop-id': 'source-warehouse' },
  }), NOW, NOW);
  db.prepare(`
    INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
    VALUES ('purchase-plugin-context', ?, ?, ?)
  `).run(JSON.stringify({
    version: 1,
    context: {
      shopId: 'old-local-shop-id',
      orderKey: 'source-order',
      productName: '来源商品',
    },
    updatedAt: NOW,
  }), NOW, NOW);
  if (withPurchaseHistory) {
    db.prepare(`
      INSERT INTO purchase_accounts (id, name, created_at, updated_at)
      VALUES ('source-purchase-account', '来源采购账号', ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO purchase_browser_tasks (
        id, owner_id, owner_incarnation, shop_id, order_key, product_key,
        idempotency_key_hash, request_fingerprint, preview_encrypted,
        preview_fingerprint, status, attempt_count, receipt_id,
        created_at, updated_at, confirmed_at, completed_at
      ) VALUES (
        'source-task', 'source-purchase-account', ?, 'old-local-shop-id',
        'posting-source', 'offer-001', ?, ?, ?, ?, 'completed', 1,
        'source-receipt', ?, ?, ?, ?
      )
    `).run(
      NOW,
      '1'.repeat(64),
      '2'.repeat(64),
      encryptBusinessSecret(JSON.stringify({
        ownerId: 'source-purchase-account',
        ownerIncarnation: NOW,
        targetUrl: 'https://purchase.invalid/source',
      })),
      '3'.repeat(64),
      NOW,
      NOW,
      NOW,
      NOW,
    );
    db.prepare(`
      INSERT INTO purchase_browser_receipts (
        id, task_id, owner_id, shop_id, attempt_id, receipt_encrypted,
        receipt_hash, website_readback_hash, created_at
      ) VALUES (
        'source-receipt', 'source-task', 'source-purchase-account',
        'old-local-shop-id', 'source-attempt', ?, ?, ?, ?
      )
    `).run(
      encryptBusinessSecret(JSON.stringify({ status: 'completed', orderNumber: 'PDD-001' })),
      '4'.repeat(64),
      '5'.repeat(64),
      NOW,
    );
    db.prepare(`
      INSERT INTO purchase_completion_history (
        shop_id, source_task_id, source_receipt_id,
        source_account_ref_hash, order_number_hash, receipt_encrypted,
        receipt_hash, website_readback_hash, order_product_encrypted,
        order_product_hash, source_summary_encrypted, source_summary_hash,
        archive_origin, completed_at, archived_at, created_at, updated_at
      ) VALUES ('old-local-shop-id', 'source-task', 'source-receipt', ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'website-readback', ?, ?, ?, ?)
    `).run(
      '6'.repeat(64),
      '7'.repeat(64),
      encryptBusinessSecret(JSON.stringify({ orderNumber: 'PDD-001' })),
      '8'.repeat(64),
      '9'.repeat(64),
      encryptBusinessSecret(JSON.stringify({ orderKey: 'posting-source', productKey: 'offer-001' })),
      'a'.repeat(64),
      encryptBusinessSecret(JSON.stringify({ sourceKind: 'purchase-browser' })),
      'b'.repeat(64),
      NOW,
      NOW,
      NOW,
      NOW,
    );
  }
  const service = createBackupService(db, '11');
  const preview = service.previewShop('old-local-shop-id').shops[0];
  const prepared = service.prepareExport({
    shopId: 'old-local-shop-id',
    expectedDataFingerprint: preview.dataFingerprint,
    selectedDomains,
    commitCapability: COMMIT_CAPABILITY,
  });
  db.close();
  return prepared;
}

function createLegacyPassphrasePackage({ passphrase = 'legacy-portable-backup-passphrase' } = {}) {
  const portable = createPortablePackage();
  const bytes = Buffer.from(portable.contentB64u, 'base64url');
  const opened = openDataBackupPackage({ bytes });
  const payload = JSON.parse(bytes.toString('utf8'));
  delete payload.unlock;
  payload.transport.keyEnvelope = createRecoveryKeyEnvelope({
    keyset: opened.keyset,
    passphrase,
    aad: opened.aad,
  });
  const legacyBytes = Buffer.from(canonicalJson(payload), 'utf8');
  return {
    contentB64u: legacyBytes.toString('base64url'),
    passphrase,
  };
}

function createPurchaseAccountPackage() {
  const db = createMigratedTestDb();
  db.prepare(`
    INSERT INTO purchase_accounts (
      id, name, platform_name, login_account, login_password_encrypted,
      default_usage, note, created_at, updated_at
    ) VALUES ('purchase-owner-a', '采购主账号', '1688', 'buyer-a', ?, '日常采购', '备份恢复测试', ?, ?)
  `).run(encryptBusinessSecret('purchase-password-a'), NOW, NOW);
  const service = createBackupService(db, '12');
  const owner = { ownerType: 'purchase_account', ownerId: 'purchase-owner-a' };
  const preview = service.previewOwner(owner).owner;
  const prepared = service.prepareExport({
    owner,
    expectedDataFingerprint: preview.dataFingerprint,
    commitCapability: COMMIT_CAPABILITY,
  });
  db.close();
  return prepared;
}

const sourceEncrypt = (value) => value ? `sourcebox:${value}` : null;
const sourceDecrypt = (value) => {
  const text = String(value || '');
  return text.startsWith('sourcebox:') ? text.slice('sourcebox:'.length) : null;
};
const targetEncrypt = (value) => value ? `targetbox:${value}` : null;
const targetDecrypt = (value) => {
  const text = String(value || '');
  return text.startsWith('targetbox:') ? text.slice('targetbox:'.length) : null;
};

const NON_OZON_RESTORE_CASES = [
  {
    ownerType: 'cross_border_bus',
    ownerId: 'bus-owner-a',
    otherId: 'bus-owner-b',
    identityDomain: 'cross-border-accounts',
    insertSource(db) {
      db.prepare(`
        INSERT INTO cross_border_accounts (
          id, name, status, user_name_encrypted, password_encrypted,
          company_secret_encrypted, access_token_encrypted, app_uid_encrypted,
          default_storehouse, default_section, default_service, note, created_at, updated_at
        ) VALUES (?, '跨境巴士主账号', 'active', ?, ?, ?, ?, ?, '义乌仓', 'A区', '提报服务', '跨境恢复', ?, ?)
      `).run(
        this.ownerId,
        sourceEncrypt('bus-user-a'),
        sourceEncrypt('bus-password-a'),
        sourceEncrypt('bus-company-secret-a'),
        sourceEncrypt('bus-token-a'),
        sourceEncrypt('bus-app-uid-a'),
        NOW,
        NOW,
      );
      db.prepare(`
        INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
        VALUES ('cross-border-preferences', ?, ?, ?)
      `).run(JSON.stringify({
        version: 1,
        crossBorderAccountId: this.ownerId,
        accountId: this.ownerId,
      }), NOW, NOW);
    },
    insertOther(db) {
      db.prepare(`
        INSERT INTO cross_border_accounts (
          id, name, status, password_encrypted, created_at, updated_at
        ) VALUES (?, '跨境保留账号', 'active', ?, ?, ?)
      `).run(this.otherId, targetEncrypt('bus-password-b'), NOW, NOW);
    },
    assertRestored(db) {
      const row = db.prepare('SELECT * FROM cross_border_accounts WHERE id = ?').get(this.ownerId);
      assert.equal(row.name, '跨境巴士主账号');
      assert.equal(targetDecrypt(row.password_encrypted), 'bus-password-a');
      assert.equal(targetDecrypt(row.access_token_encrypted), 'bus-token-a');
      const setting = JSON.parse(db.prepare(`
        SELECT value_json FROM profile_settings WHERE namespace = 'cross-border-preferences'
      `).get().value_json);
      assert.equal(setting.crossBorderAccountId, this.ownerId);
      assert.equal(setting.accountId, this.ownerId);
    },
    assertOther(db) {
      const row = db.prepare('SELECT name, password_encrypted FROM cross_border_accounts WHERE id = ?')
        .get(this.otherId);
      assert.equal(row.name, '跨境保留账号');
      assert.equal(targetDecrypt(row.password_encrypted), 'bus-password-b');
    },
  },
  {
    ownerType: 'promotion_account',
    ownerId: 'promotion-owner-a',
    otherId: 'promotion-owner-b',
    identityDomain: 'performance-accounts',
    insertSource(db) {
      db.prepare(`
        INSERT INTO performance_accounts (
          id, name, status, client_id, client_secret_encrypted, campaign_count,
          statistics_task_count, note, created_at, updated_at
        ) VALUES (?, '推广主账号', 'active', 'promotion-client-a', ?, 8, 3, '推广恢复', ?, ?)
      `).run(this.ownerId, sourceEncrypt('promotion-secret-a'), NOW, NOW);
    },
    insertOther(db) {
      db.prepare(`
        INSERT INTO performance_accounts (
          id, name, status, client_id, client_secret_encrypted, created_at, updated_at
        ) VALUES (?, '推广保留账号', 'active', 'promotion-client-b', ?, ?, ?)
      `).run(this.otherId, targetEncrypt('promotion-secret-b'), NOW, NOW);
    },
    assertRestored(db) {
      const row = db.prepare('SELECT * FROM performance_accounts WHERE id = ?').get(this.ownerId);
      assert.equal(row.client_id, 'promotion-client-a');
      assert.equal(targetDecrypt(row.client_secret_encrypted), 'promotion-secret-a');
      assert.equal(row.campaign_count, 8);
    },
    assertOther(db) {
      const row = db.prepare('SELECT name, client_secret_encrypted FROM performance_accounts WHERE id = ?')
        .get(this.otherId);
      assert.equal(row.name, '推广保留账号');
      assert.equal(targetDecrypt(row.client_secret_encrypted), 'promotion-secret-b');
    },
  },
  {
    ownerType: 'purchase_account',
    ownerId: 'purchase-matrix-a',
    otherId: 'purchase-matrix-b',
    identityDomain: 'purchase-accounts',
    insertSource(db) {
      db.prepare(`
        INSERT INTO purchase_accounts (
          id, name, platform_name, login_account, login_password_encrypted,
          default_usage, risk_note, note, is_default, created_at, updated_at
        ) VALUES (?, '采购主账号', '1688', 'buyer-a', ?, '日常采购', '需验证码', '采购恢复', 1, ?, ?)
      `).run(this.ownerId, sourceEncrypt('purchase-password-a'), NOW, NOW);
    },
    insertOther(db) {
      db.prepare(`
        INSERT INTO purchase_accounts (
          id, name, login_password_encrypted, created_at, updated_at
        ) VALUES (?, '采购保留账号', ?, ?, ?)
      `).run(this.otherId, targetEncrypt('purchase-password-b'), NOW, NOW);
    },
    assertRestored(db) {
      const row = db.prepare('SELECT * FROM purchase_accounts WHERE id = ?').get(this.ownerId);
      assert.equal(row.login_account, 'buyer-a');
      assert.equal(targetDecrypt(row.login_password_encrypted), 'purchase-password-a');
      assert.equal(row.is_default, 1);
    },
    assertOther(db) {
      const row = db.prepare('SELECT name, login_password_encrypted FROM purchase_accounts WHERE id = ?')
        .get(this.otherId);
      assert.equal(row.name, '采购保留账号');
      assert.equal(targetDecrypt(row.login_password_encrypted), 'purchase-password-b');
    },
  },
  {
    ownerType: 'model_api_account',
    ownerId: 'model-owner-a',
    otherId: 'model-owner-b',
    identityDomain: 'model-api-accounts',
    insertSource(db) {
      db.prepare(`
        INSERT INTO model_api_accounts (
          id, api_alias, provider, website_url, login_account, login_password_encrypted,
          base_url, api_key_encrypted, default_model, usage_scene, upscale, quality, style,
          detection_status, detected_source, detected_at, is_default, created_at, updated_at
        ) VALUES (?, '图片模型主账号', 'codesonline', 'https://image.example', 'model-user-a', ?,
          'https://image.example/v1', ?, 'gpt-image-2', '文生图', '2k', 'high', 'vivid',
          '已保存', 'manual', ?, 1, ?, ?)
      `).run(
        this.ownerId,
        sourceEncrypt('model-password-a'),
        sourceEncrypt('model-api-key-a'),
        NOW,
        NOW,
        NOW,
      );
    },
    insertOther(db) {
      db.prepare(`
        INSERT INTO model_api_accounts (
          id, api_alias, login_password_encrypted, api_key_encrypted, created_at, updated_at
        ) VALUES (?, '模型保留账号', ?, ?, ?, ?)
      `).run(
        this.otherId,
        targetEncrypt('model-password-b'),
        targetEncrypt('model-api-key-b'),
        NOW,
        NOW,
      );
    },
    assertRestored(db) {
      const row = db.prepare('SELECT * FROM model_api_accounts WHERE id = ?').get(this.ownerId);
      assert.equal(row.api_alias, '图片模型主账号');
      assert.equal(targetDecrypt(row.login_password_encrypted), 'model-password-a');
      assert.equal(targetDecrypt(row.api_key_encrypted), 'model-api-key-a');
    },
    assertOther(db) {
      const row = db.prepare('SELECT api_alias, api_key_encrypted FROM model_api_accounts WHERE id = ?')
        .get(this.otherId);
      assert.equal(row.api_alias, '模型保留账号');
      assert.equal(targetDecrypt(row.api_key_encrypted), 'model-api-key-b');
    },
  },
  {
    ownerType: 'integration_profile',
    ownerId: 'integration-owner-a',
    otherId: 'integration-owner-b',
    identityDomain: 'integration-profiles',
    insertSource(db) {
      db.prepare(`
        INSERT INTO integration_profiles (
          id, integration_type, platform_name, api_type, auth_mode, config_status,
          token_status, read_scope, write_scope, note, created_at, updated_at
        ) VALUES (?, 'custom', '外部工具主账号', '工具服务', '本机配置', '已保存',
          '有效', '配置读取', '人工确认', '外部服务恢复', ?, ?)
      `).run(this.ownerId, NOW, NOW);
      db.prepare(`
        INSERT INTO integration_credentials (
          profile_id, base_url, login_account, login_password_encrypted,
          api_key_encrypted, last_test_status, created_at, updated_at
        ) VALUES (?, 'https://integration.example', 'integration-user-a', ?, ?, 'connected', ?, ?)
      `).run(
        this.ownerId,
        sourceEncrypt('integration-password-a'),
        sourceEncrypt('integration-api-key-a'),
        NOW,
        NOW,
      );
    },
    insertOther(db) {
      db.prepare(`
        INSERT INTO integration_profiles (
          id, integration_type, platform_name, created_at, updated_at
        ) VALUES (?, 'custom', '外部工具保留账号', ?, ?)
      `).run(this.otherId, NOW, NOW);
      db.prepare(`
        INSERT INTO integration_credentials (
          profile_id, base_url, login_password_encrypted, api_key_encrypted, created_at, updated_at
        ) VALUES (?, 'https://keep.example', ?, ?, ?, ?)
      `).run(
        this.otherId,
        targetEncrypt('integration-password-b'),
        targetEncrypt('integration-api-key-b'),
        NOW,
        NOW,
      );
    },
    assertRestored(db) {
      const profile = db.prepare('SELECT * FROM integration_profiles WHERE id = ?').get(this.ownerId);
      const credential = db.prepare('SELECT * FROM integration_credentials WHERE profile_id = ?').get(this.ownerId);
      assert.equal(profile.platform_name, '外部工具主账号');
      assert.equal(credential.login_account, 'integration-user-a');
      assert.equal(targetDecrypt(credential.login_password_encrypted), 'integration-password-a');
      assert.equal(targetDecrypt(credential.api_key_encrypted), 'integration-api-key-a');
    },
    assertOther(db) {
      const profile = db.prepare('SELECT platform_name FROM integration_profiles WHERE id = ?').get(this.otherId);
      const credential = db.prepare('SELECT api_key_encrypted FROM integration_credentials WHERE profile_id = ?')
        .get(this.otherId);
      assert.equal(profile.platform_name, '外部工具保留账号');
      assert.equal(targetDecrypt(credential.api_key_encrypted), 'integration-api-key-b');
    },
  },
];

function createNonOzonOwnerPackage(spec, suffix) {
  const db = createMigratedTestDb();
  spec.insertSource(db);
  const owner = { ownerType: spec.ownerType, ownerId: spec.ownerId };
  const service = createBackupService(db, suffix, sourceDecrypt);
  const preview = service.previewOwner(owner).owner;
  const prepared = service.prepareExport({
    owner,
    expectedDataFingerprint: preview.dataFingerprint,
    commitCapability: COMMIT_CAPABILITY,
  });
  db.close();
  return prepared;
}

for (const [index, spec] of NON_OZON_RESTORE_CASES.entries()) {
  test(`portable backup import restores and isolates ${spec.ownerType}`, () => {
    const portable = createNonOzonOwnerPackage(spec, String(20 + index));
    const db = createMigratedTestDb();
    spec.insertOther(db);
    const backupService = createBackupService(db, String(30 + index), targetDecrypt);
    const service = createDataBackupImportService({
      db,
      dataBackupService: backupService,
      profileId: 'default',
      encryptShopSecret: targetEncrypt,
      decryptShopSecret: targetDecrypt,
      now: () => new Date(NOW),
      createImportId: () => `owner-import-${spec.ownerType}`,
    });
    const sourceOwner = { ownerType: spec.ownerType, ownerId: spec.ownerId };
    try {
      assert.throws(() => service.preflight({
        contentB64u: portable.contentB64u,
        targetOwner: { ownerType: spec.ownerType, ownerId: spec.otherId },
      }), /DATA_BACKUP_IMPORT_TARGET_OWNER_MISMATCH/u);
      assert.throws(() => service.preflight({
        contentB64u: portable.contentB64u,
        targetOwner: {
          ownerType: spec.ownerType === 'purchase_account' ? 'model_api_account' : 'purchase_account',
          ownerId: spec.ownerId,
        },
      }), /DATA_BACKUP_IMPORT_TARGET_OWNER_MISMATCH/u);

      const preflight = service.preflight({ contentB64u: portable.contentB64u });
      assert.deepEqual(
        { ownerType: preflight.sourceOwner.ownerType, ownerId: preflight.sourceOwner.ownerId },
        sourceOwner,
      );
      assert.equal(preflight.targetOwner.exists, false);
      assert.ok(preflight.domains.some((domain) => domain.domain === spec.identityDomain));
      const confirmed = service.confirm({
        contentB64u: portable.contentB64u,
        previewFingerprint: preflight.previewFingerprint,
        targetOwner: sourceOwner,
      });
      assert.equal(confirmed.verified, true);
      assert.deepEqual(
        { ownerType: confirmed.targetOwner.ownerType, ownerId: confirmed.targetOwner.ownerId },
        sourceOwner,
      );
      spec.assertRestored(db);
      spec.assertOther(db);
      const history = service.ownerHistory({ owner: sourceOwner });
      assert.equal(history.imports.length, 1);
      assert.equal(history.imports[0].verified, true);
      assert.equal(service.ownerHistory({
        owner: { ownerType: spec.ownerType, ownerId: spec.otherId },
      }).imports.length, 0);
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally {
      db.close();
    }
  });
}

test('portable backup import recreates a deleted non-Ozon account and records owner-scoped history', () => {
  const portable = createPurchaseAccountPackage();
  const db = createMigratedTestDb();
  const backupService = createBackupService(db, '13');
  const service = createDataBackupImportService({
    db,
    dataBackupService: backupService,
    profileId: 'default',
    encryptShopSecret: encryptBusinessSecret,
    decryptShopSecret: decryptBusinessSecret,
    now: () => new Date(NOW),
    createImportId: () => 'owner-import-purchase-a',
  });
  try {
    const preflight = service.preflight({ contentB64u: portable.contentB64u });
    assert.equal(preflight.sourceOwner.ownerType, 'purchase_account');
    assert.equal(preflight.targetOwner.ownerId, 'purchase-owner-a');
    assert.equal(preflight.targetOwner.exists, false);
    assert.equal(preflight.summary.added, 1);
    const confirmed = service.confirm({
      contentB64u: portable.contentB64u,
      previewFingerprint: preflight.previewFingerprint,
      targetOwner: { ownerType: 'purchase_account', ownerId: 'purchase-owner-a' },
    });
    assert.equal(confirmed.verified, true);
    assert.equal(confirmed.targetOwner.ownerType, 'purchase_account');
    const restored = db.prepare(`
      SELECT name, login_account, login_password_encrypted
      FROM purchase_accounts WHERE id = 'purchase-owner-a'
    `).get();
    assert.equal(restored.name, '采购主账号');
    assert.equal(restored.login_account, 'buyer-a');
    assert.equal(decryptBusinessSecret(restored.login_password_encrypted), 'purchase-password-a');
    const history = service.ownerHistory({
      owner: { ownerType: 'purchase_account', ownerId: 'purchase-owner-a' },
    });
    assert.equal(history.imports.length, 1);
    assert.equal(history.imports[0].verified, true);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    db.close();
  }
});

test('portable backup import rejects a corrupted package without creating account or history rows', () => {
  const portable = createPurchaseAccountPackage();
  const bytes = Buffer.from(portable.contentB64u, 'base64url');
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  const db = createMigratedTestDb();
  const backupService = createBackupService(db, '14');
  const service = createDataBackupImportService({
    db,
    dataBackupService: backupService,
    profileId: 'default',
    encryptShopSecret: encryptBusinessSecret,
    decryptShopSecret: decryptBusinessSecret,
    now: () => new Date(NOW),
    createImportId: () => 'must-not-be-created',
  });
  try {
    assert.throws(
      () => service.preflight({ contentB64u: bytes.toString('base64url') }),
      /DATA_BACKUP_|RECOVERY_/u,
    );
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM purchase_accounts WHERE id = 'purchase-owner-a'
    `).get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM data_backup_owner_imports').get().count, 0);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    db.close();
  }
});

test('portable backup import restores a selected-domain package without manufacturing unchecked data', () => {
  const portable = createPortablePackage({
    selectedDomains: ['shops', 'shop-credentials', 'product-source-links'],
  });
  const { db, service } = createTargetFixture({ withExistingLink: false });
  try {
    const beforeSettings = db.prepare(`
      SELECT namespace, value_json FROM profile_settings ORDER BY namespace
    `).all();
    const preflight = service.preflight({
      contentB64u: portable.contentB64u,
      targetShopId: 'new-local-shop-id',
    });
    assert.deepEqual(preflight.domains.map((domain) => domain.domain), [
      'product-source-links',
      'shop-credentials',
      'shops',
    ]);
    const confirmed = service.confirm({
      contentB64u: portable.contentB64u,
      targetShopId: 'new-local-shop-id',
      previewFingerprint: preflight.previewFingerprint,
    });
    assert.equal(confirmed.verified, true);
    assert.equal(db.prepare(`
      SELECT url FROM product_source_links
      WHERE shop_id = 'new-local-shop-id' AND product_key = 'offer-001'
    `).get().url, 'https://source.invalid/item');
    assert.deepEqual(db.prepare(`
      SELECT namespace, value_json FROM profile_settings ORDER BY namespace
    `).all(), beforeSettings);
  } finally {
    db.close();
  }
});

function createTargetFixture({ withExistingLink = true, stagingDirectory = '' } = {}) {
  const db = createMigratedTestDb();
  insertShop(db, {
    id: 'new-local-shop-id',
    name: '当前设备店铺',
    alias: '当前别名',
    apiKey: 'CURRENT-API-KEY-MUST-BE-PRESERVED',
    incarnation: 'target-incarnation',
  });
  if (withExistingLink) {
    db.prepare(`
      INSERT INTO product_source_links (
        id, shop_id, product_key, slot_index, platform, url, title,
        raw_json, created_at, updated_at
      ) VALUES (
        'link-source', 'new-local-shop-id', 'offer-001', 0, '1688',
        'https://current.invalid/item', NULL, NULL, ?, ?
      )
    `).run(NOW, NOW);
  }
  db.prepare(`
    INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
    VALUES ('ozon-shop-preferences', ?, ?, ?)
  `).run(JSON.stringify({
    version: 1,
    activeShopId: 'new-local-shop-id',
    shops: [{ id: 'new-local-shop-id', shopAlias: '当前设置别名', note: '' }],
    defaultWarehouseIds: { 'new-local-shop-id': '' },
    currentGlobalFlag: 'must-stay',
  }), NOW, NOW);
  db.prepare(`
    INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
    VALUES ('purchase-plugin-context', ?, ?, ?)
  `).run(JSON.stringify({
    version: 1,
    context: {
      shopId: 'new-local-shop-id',
      orderKey: 'current-order',
      productName: '',
    },
    updatedAt: NOW,
  }), NOW, NOW);
  const dataBackupService = createBackupService(db, '22');
  const service = createDataBackupImportService({
    db,
    dataBackupService,
    profileId: 'default',
    encryptShopSecret: encryptBusinessSecret,
    decryptShopSecret: decryptBusinessSecret,
    stagingDirectory,
    now: () => new Date(NOW),
    createImportId: () => 'data_backup_import_test',
  });
  return { db, service };
}

test('portable backup import preflights and confirms from an opaque staging reference', () => {
  const portable = createPortablePackage();
  const stagingDirectory = mkdtempSync(path.join(tmpdir(), 'wangzai-data-backup-import-staging-'));
  const stagingFileName = `data-backup-import-${'ab'.repeat(32)}.wzb`;
  const bytes = Buffer.from(portable.contentB64u, 'base64url');
  writeFileSync(path.join(stagingDirectory, stagingFileName), bytes, { mode: 0o600 });
  const { db, service } = createTargetFixture({ withExistingLink: false, stagingDirectory });
  const input = {
    stagingFileName,
    packageSha256: portable.packageSha256,
    packageBytes: portable.packageBytes,
    targetShopId: 'new-local-shop-id',
  };
  try {
    const preflight = service.preflight(input);
    assert.equal(preflight.target.shopId, 'new-local-shop-id');
    const confirmed = service.confirm({
      ...input,
      previewFingerprint: preflight.previewFingerprint,
    });
    assert.equal(confirmed.verified, true);
    assert.equal(db.prepare(`
      SELECT url FROM product_source_links
      WHERE shop_id = 'new-local-shop-id' AND product_key = 'offer-001'
    `).get().url, 'https://source.invalid/item');
  } finally {
    db.close();
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
});

test('legacy passphrase backup requires the passphrase and restores through preflight plus confirm', () => {
  const legacy = createLegacyPassphrasePackage();
  const { db, service } = createTargetFixture({ withExistingLink: false });
  try {
    assert.throws(
      () => service.preflight({
        contentB64u: legacy.contentB64u,
        targetShopId: 'new-local-shop-id',
      }),
      /DATA_BACKUP_LEGACY_PASSPHRASE_REQUIRED/u,
    );
    assert.throws(
      () => service.preflight({
        contentB64u: legacy.contentB64u,
        targetShopId: 'new-local-shop-id',
        passphrase: 'wrong-legacy-passphrase',
      }),
      /RECOVERY_ENVELOPE_DECRYPT_FAILED/u,
    );
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM product_source_links
      WHERE shop_id = 'new-local-shop-id'
    `).get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM data_backup_imports').get().count, 0);

    const preflight = service.preflight({
      contentB64u: legacy.contentB64u,
      targetShopId: 'new-local-shop-id',
      passphrase: legacy.passphrase,
    });
    assert.equal(preflight.target.shopId, 'new-local-shop-id');
    const confirmed = service.confirm({
      contentB64u: legacy.contentB64u,
      targetShopId: 'new-local-shop-id',
      passphrase: legacy.passphrase,
      previewFingerprint: preflight.previewFingerprint,
    });
    assert.equal(confirmed.verified, true);
    assert.equal(db.prepare(`
      SELECT url FROM product_source_links
      WHERE shop_id = 'new-local-shop-id' AND product_key = 'offer-001'
    `).get().url, 'https://source.invalid/item');
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM data_backup_imports
      WHERE import_id = 'data_backup_import_test' AND status = 'completed'
    `).get().count, 1);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    db.close();
  }
});

test('portable backup import maps by Ozon client id, merges under current shop id, and preserves credentials', () => {
  const portable = createPortablePackage();
  const { db, service } = createTargetFixture();
  try {
    const preflight = service.preflight({
      contentB64u: portable.contentB64u,
      targetShopId: 'new-local-shop-id',
      conflictMode: 'preserve',
    });
    assert.equal(preflight.target.shopId, 'new-local-shop-id');
    assert.equal(preflight.strategy, 'preserve');
    assert.equal(preflight.previewFingerprint, preflight.preflightFingerprint);
    assert.equal(preflight.domains.find((domain) => domain.domain === 'product-source-links')?.updated, 1);
    assert.equal(preflight.domains.find((domain) => domain.domain === 'shop-credentials')?.preserved, 1);

    const confirmed = service.confirm({
      contentB64u: portable.contentB64u,
      targetShopId: 'new-local-shop-id',
      conflictMode: 'preserve',
      previewFingerprint: preflight.previewFingerprint,
    });
    assert.equal(confirmed.status, 'completed');
    assert.equal(confirmed.importId, 'data_backup_import_test');
    const link = db.prepare(`
      SELECT shop_id, url, title, raw_json
      FROM product_source_links WHERE shop_id = ? AND product_key = ? AND slot_index = 0
    `).get('new-local-shop-id', 'offer-001');
    assert.equal(link.shop_id, 'new-local-shop-id');
    assert.equal(link.url, 'https://current.invalid/item');
    assert.equal(link.title, '来源标题');
    assert.equal(link.raw_json, '{"source":true}');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM product_source_links WHERE shop_id = ?').get('old-local-shop-id').count,
      0,
    );
    const shop = db.prepare(`
      SELECT client_id, api_key_encrypted, profile_id, shop_incarnation, credential_revision
      FROM shops WHERE id = 'new-local-shop-id'
    `).get();
    assert.equal(shop.client_id, CLIENT_ID);
    assert.equal(decryptBusinessSecret(shop.api_key_encrypted), 'CURRENT-API-KEY-MUST-BE-PRESERVED');
    assert.equal(shop.profile_id, 'default');
    assert.equal(shop.shop_incarnation, 'target-incarnation');
    assert.equal(shop.credential_revision, 3);
    const preferences = JSON.parse(db.prepare(`
      SELECT value_json FROM profile_settings WHERE namespace = 'ozon-shop-preferences'
    `).get().value_json);
    assert.equal(preferences.shops[0].id, 'new-local-shop-id');
    assert.equal(preferences.shops[0].shopAlias, '当前设置别名');
    assert.equal(preferences.shops[0].note, '来源补充值');
    assert.equal(preferences.defaultWarehouseIds['new-local-shop-id'], 'source-warehouse');
    assert.equal(preferences.currentGlobalFlag, 'must-stay');
    const purchaseContext = JSON.parse(db.prepare(`
      SELECT value_json FROM profile_settings WHERE namespace = 'purchase-plugin-context'
    `).get().value_json);
    assert.equal(purchaseContext.context.shopId, 'new-local-shop-id');
    assert.equal(purchaseContext.context.orderKey, 'current-order');
    assert.equal(purchaseContext.context.productName, '来源商品');
    const audit = db.prepare('SELECT * FROM data_backup_imports WHERE import_id = ?')
      .get('data_backup_import_test');
    assert.equal(audit.shop_id, 'new-local-shop-id');
    assert.equal(audit.package_sha256, portable.packageSha256);
    assert.equal(audit.status, 'completed');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    db.close();
  }
});

test('portable backup import rejects stale preflight without partial writes', () => {
  const portable = createPortablePackage();
  const { db, service } = createTargetFixture({ withExistingLink: false });
  try {
    const preflight = service.preflight({
      contentB64u: portable.contentB64u,
      targetShopId: 'new-local-shop-id',
    });
    db.prepare(`
      INSERT INTO product_source_links (
        id, shop_id, product_key, slot_index, url, created_at, updated_at
      ) VALUES ('concurrent-link', 'new-local-shop-id', 'concurrent', 0,
        'https://concurrent.invalid/item', ?, ?)
    `).run(NOW, NOW);
    assert.throws(() => service.confirm({
      contentB64u: portable.contentB64u,
      targetShopId: 'new-local-shop-id',
      previewFingerprint: preflight.previewFingerprint,
    }), /DATA_BACKUP_IMPORT_PREFLIGHT_STALE/u);
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM product_source_links WHERE product_key = 'offer-001'`).get().count,
      0,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM data_backup_imports').get().count, 0);
  } finally {
    db.close();
  }
});

test('portable backup import overwrite strategy replaces conflicting user fields but still preserves current credentials', () => {
  const portable = createPortablePackage();
  const { db, service } = createTargetFixture();
  try {
    const preflight = service.preflight({
      contentB64u: portable.contentB64u,
      targetShopId: 'new-local-shop-id',
      conflictMode: 'overwrite',
    });
    const confirmed = service.confirm({
      contentB64u: portable.contentB64u,
      targetShopId: 'new-local-shop-id',
      conflictMode: 'overwrite',
      previewFingerprint: preflight.previewFingerprint,
    });
    assert.equal(confirmed.verified, true);
    assert.equal(db.prepare(`
      SELECT url FROM product_source_links
      WHERE shop_id = 'new-local-shop-id' AND product_key = 'offer-001'
    `).get().url, 'https://source.invalid/item');
    assert.equal(decryptBusinessSecret(
      db.prepare(`SELECT api_key_encrypted FROM shops WHERE id = 'new-local-shop-id'`).get().api_key_encrypted,
    ), 'CURRENT-API-KEY-MUST-BE-PRESERVED');
  } finally {
    db.close();
  }
});

test('portable backup import fails closed when stored target identity hash disagrees with current client id', () => {
  const portable = createPortablePackage();
  const { db, service } = createTargetFixture();
  try {
    db.prepare(`UPDATE shops SET external_identity_hash = ? WHERE id = 'new-local-shop-id'`)
      .run('f'.repeat(64));
    assert.throws(() => service.preflight({
      contentB64u: portable.contentB64u,
      targetShopId: 'new-local-shop-id',
    }), /DATA_BACKUP_IMPORT_TARGET_IDENTITY_INCONSISTENT/u);
  } finally {
    db.close();
  }
});

test('portable backup import explicitly skips browser tasks whose purchase account is absent and still restores completion history', () => {
  const portable = createPortablePackage({ withPurchaseHistory: true });
  const { db, service } = createTargetFixture({ withExistingLink: false });
  try {
    const preflight = service.preflight({
      contentB64u: portable.contentB64u,
      targetShopId: 'new-local-shop-id',
    });
    assert.equal(preflight.skipped.missingDependencies, 2);
    const confirmed = service.confirm({
      contentB64u: portable.contentB64u,
      targetShopId: 'new-local-shop-id',
      previewFingerprint: preflight.previewFingerprint,
    });
    assert.equal(confirmed.status, 'completed_with_skips');
    assert.equal(confirmed.profileResult.skippedPurchaseTasks, 1);
    assert.equal(confirmed.profileResult.skippedPurchaseReceipts, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM purchase_browser_tasks`).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM purchase_browser_receipts`).get().count, 0);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM purchase_completion_history
      WHERE shop_id = 'new-local-shop-id' AND source_receipt_id = 'source-receipt'
    `).get().count, 1);
  } finally {
    db.close();
  }
});

test('portable backup import rolls back profile and shop merges together when a later shop-domain write fails', () => {
  const portable = createPortablePackage({ withPurchaseHistory: true });
  const { db, service } = createTargetFixture({ withExistingLink: false });
  try {
    db.exec(`
      CREATE TRIGGER fail_portable_product_source_insert
      BEFORE INSERT ON product_source_links
      WHEN NEW.shop_id = 'new-local-shop-id' AND NEW.product_key = 'offer-001'
      BEGIN
        SELECT RAISE(ABORT, 'forced portable import failure');
      END;
    `);
    const preflight = service.preflight({
      contentB64u: portable.contentB64u,
      targetShopId: 'new-local-shop-id',
    });
    assert.throws(() => service.confirm({
      contentB64u: portable.contentB64u,
      targetShopId: 'new-local-shop-id',
      previewFingerprint: preflight.previewFingerprint,
    }));
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM purchase_completion_history
      WHERE shop_id = 'new-local-shop-id'
    `).get().count, 0);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM product_source_links
      WHERE shop_id = 'new-local-shop-id' AND product_key = 'offer-001'
    `).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM data_backup_imports`).get().count, 0);
  } finally {
    db.close();
  }
});

test('portable backup import refuses an unbound target identity and never reveals package credentials', () => {
  const portable = createPortablePackage();
  const db = createMigratedTestDb();
  insertShop(db, {
    id: 'different-shop',
    name: '其他店铺',
    apiKey: 'CURRENT-OTHER-KEY',
    clientId: 'DIFFERENT-OZON-CLIENT',
    incarnation: 'different-incarnation',
  });
  const dataBackupService = createBackupService(db, '33');
  const service = createDataBackupImportService({
    db,
    dataBackupService,
    profileId: 'default',
    encryptShopSecret: encryptBusinessSecret,
    decryptShopSecret: decryptBusinessSecret,
  });
  try {
    assert.throws(() => service.preflight({
      contentB64u: portable.contentB64u,
    }), /DATA_BACKUP_IMPORT_TARGET_NOT_FOUND/u);
  } finally {
    db.close();
  }
});
