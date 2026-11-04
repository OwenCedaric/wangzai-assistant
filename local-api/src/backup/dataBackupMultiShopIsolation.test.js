import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createExternalOzonIdentityHash } from '../db/repositories/shopIdentityRepository.js';
import { createDataBackupImportService } from './dataBackupImportService.js';
import { createDataBackupService } from './dataBackupService.js';
import { openDataBackupPackage } from './dataBackupPackage.js';
import { createRecoveryKeysetStore } from './recoveryKeysetStore.js';

const NOW = '2026-07-29T02:30:00.000Z';
const SHOP_COUNT = 10;

const sourceEncrypt = (value) => value ? `source:${value}` : null;
const sourceDecrypt = (value) => String(value || '').replace(/^source:/u, '');
const targetEncrypt = (value) => value ? `target:${value}` : null;
const targetDecrypt = (value) => String(value || '').replace(/^target:/u, '');

function shopNumber(index) {
  return String(index + 1).padStart(2, '0');
}

function insertShop(db, {
  id,
  name,
  alias,
  clientId,
  apiKey,
  incarnation,
  encryptSecret,
}) {
  db.prepare(`
    INSERT INTO shops (
      id, name, alias, client_id, api_key_encrypted, status,
      profile_id, external_identity_hash, shop_incarnation,
      credential_revision, bound_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', 'default', ?, ?, 1, ?, ?, ?)
  `).run(
    id,
    name,
    alias,
    clientId,
    encryptSecret(apiKey),
    createExternalOzonIdentityHash(clientId),
    incarnation,
    NOW,
    NOW,
    NOW,
  );
}

function insertSourceFacts(db, shop) {
  db.prepare(`
    INSERT INTO product_source_links (
      id, shop_id, product_key, slot_index, platform, url, title,
      raw_json, created_at, updated_at
    ) VALUES (?, ?, ?, 0, '1688', ?, ?, ?, ?, ?)
  `).run(
    `source-link-${shop.number}`,
    shop.sourceId,
    shop.productKey,
    `https://source.invalid/item/${shop.number}`,
    `店铺${shop.number}货源`,
    JSON.stringify({ owner: shop.sourceId, marker: `SOURCE-${shop.number}` }),
    NOW,
    NOW,
  );
  db.prepare(`
    INSERT INTO purchase_order_overrides (
      id, shop_id, order_key, note, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    `source-override-${shop.number}`,
    shop.sourceId,
    shop.orderKey,
    `SOURCE-NOTE-${shop.number}`,
    NOW,
    NOW,
  );
}

function insertTargetSentinels(db, shop) {
  db.prepare(`
    INSERT INTO product_source_links (
      id, shop_id, product_key, slot_index, platform, url, title,
      raw_json, created_at, updated_at
    ) VALUES (?, ?, ?, 0, 'pdd', ?, ?, ?, ?, ?)
  `).run(
    `target-sentinel-link-${shop.number}`,
    shop.targetId,
    `target-sentinel-${shop.number}`,
    `https://target.invalid/keep/${shop.number}`,
    `目标保留数据${shop.number}`,
    JSON.stringify({ owner: shop.targetId, marker: `TARGET-${shop.number}` }),
    NOW,
    NOW,
  );
}

function createBackupService({ db, keysetStore, decryptShopSecret, nextBackupId }) {
  return createDataBackupService({
    db,
    keysetStore,
    decryptShopSecret,
    now: () => new Date(NOW),
    createBackupId: nextBackupId,
  });
}

test('ten simulated shops survive backup, deletion, rebinding, and isolated restore', () => {
  const db = createMigratedTestDb();
  let backupSequence = 0;
  let importSequence = 0;
  const keysetStore = createRecoveryKeysetStore({
    db,
    encrypt: (value) => `vault:${value}`,
    decrypt: (value) => String(value || '').replace(/^vault:/u, ''),
    randomUuid: () => '00000000-0000-4000-8000-000000000099',
  });
  keysetStore.initialize({ passphrase: 'multi-shop-isolation-recovery-passphrase' });

  const shops = Array.from({ length: SHOP_COUNT }, (_value, index) => {
    const number = shopNumber(index);
    return {
      number,
      sourceId: `source-shop-${number}`,
      targetId: `target-shop-${number}`,
      clientId: `OZON-MULTI-CLIENT-${number}`,
      productKey: `product-${number}`,
      orderKey: `order-${number}`,
      sourceApiKey: `SOURCE-API-KEY-${number}`,
      targetApiKey: `TARGET-API-KEY-${number}`,
      partial: index % 2 === 1,
    };
  });

  try {
    for (const shop of shops) {
      insertShop(db, {
        id: shop.sourceId,
        name: `模拟源店铺 ${shop.number}`,
        alias: `源店${shop.number}`,
        clientId: shop.clientId,
        apiKey: shop.sourceApiKey,
        incarnation: `source-incarnation-${shop.number}`,
        encryptSecret: sourceEncrypt,
      });
      insertSourceFacts(db, shop);
    }

    const sourceBackupService = createBackupService({
      db,
      keysetStore,
      decryptShopSecret: sourceDecrypt,
      nextBackupId: () => `multi_shop_backup_${shopNumber(backupSequence++)}`,
    });

    const packages = shops.map((shop, index) => {
      const preview = sourceBackupService.previewShop(shop.sourceId).shops[0];
      assert.ok(preview.totalRecords >= 4, `店铺 ${shop.number} 预览数据不完整`);
      const selectedDomains = shop.partial
        ? ['shops', 'shop-credentials', 'product-source-links']
        : undefined;
      const commitCapability = Buffer.alloc(32, index + 1).toString('base64url');
      const prepared = sourceBackupService.prepareExport({
        shopId: shop.sourceId,
        expectedDataFingerprint: preview.dataFingerprint,
        selectedDomains,
        commitCapability,
      });
      assert.equal(openDataBackupPackage({
        bytes: Buffer.from(prepared.contentB64u, 'base64url'),
      }).shopId, shop.sourceId);
      assert.equal(sourceBackupService.commitExport({
        backupId: prepared.backupId,
        packageSha256: prepared.packageSha256,
        packageBytes: prepared.packageBytes,
        commitCapability,
      }).verified, true);
      return prepared;
    });

    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM data_backup_exports WHERE status = 'verified'
    `).get().count, SHOP_COUNT);

    // 模拟账号删除：用户事实和旧本地店铺身份全部清空，内存中的 .wzb 包保留。
    db.prepare('DELETE FROM product_source_links').run();
    db.prepare('DELETE FROM purchase_order_overrides').run();
    db.prepare('DELETE FROM shops').run();
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shops').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM product_source_links').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM purchase_order_overrides').get().count, 0);

    // 模拟重新绑定：同一个 Ozon client id，使用新的本地 shop id 和当前凭证。
    for (const shop of shops) {
      insertShop(db, {
        id: shop.targetId,
        name: `模拟重绑店铺 ${shop.number}`,
        alias: `目标店${shop.number}`,
        clientId: shop.clientId,
        apiKey: shop.targetApiKey,
        incarnation: `target-incarnation-${shop.number}`,
        encryptSecret: targetEncrypt,
      });
      insertTargetSentinels(db, shop);
    }

    const targetBackupService = createBackupService({
      db,
      keysetStore,
      decryptShopSecret: targetDecrypt,
      nextBackupId: () => `unused_target_backup_${shopNumber(backupSequence++)}`,
    });
    const importService = createDataBackupImportService({
      db,
      dataBackupService: targetBackupService,
      profileId: 'default',
      encryptShopSecret: targetEncrypt,
      decryptShopSecret: targetDecrypt,
      now: () => new Date(NOW),
      createImportId: () => `multi_shop_import_${shopNumber(importSequence++)}`,
    });

    for (const [index, shop] of shops.entries()) {
      const portable = packages[index];
      const wrongTarget = shops[(index + 1) % shops.length].targetId;
      assert.throws(() => importService.preflight({
        contentB64u: portable.contentB64u,
        targetShopId: wrongTarget,
      }), /DATA_BACKUP_IMPORT_TARGET_MISMATCH/u);

      const preflight = importService.preflight({
        contentB64u: portable.contentB64u,
        targetShopId: shop.targetId,
        conflictMode: 'preserve',
      });
      assert.equal(preflight.target.shopId, shop.targetId);
      const confirmed = importService.confirm({
        contentB64u: portable.contentB64u,
        targetShopId: shop.targetId,
        conflictMode: 'preserve',
        previewFingerprint: preflight.previewFingerprint,
      });
      assert.equal(confirmed.verified, true);
    }

    for (const shop of shops) {
      const restoredProducts = db.prepare(`
        SELECT product_key, url FROM product_source_links
        WHERE shop_id = ? ORDER BY product_key
      `).all(shop.targetId).map((row) => ({ ...row }));
      assert.deepEqual(restoredProducts, [
        { product_key: shop.productKey, url: `https://source.invalid/item/${shop.number}` },
        { product_key: `target-sentinel-${shop.number}`, url: `https://target.invalid/keep/${shop.number}` },
      ]);

      const restoredOverrides = db.prepare(`
        SELECT order_key, note FROM purchase_order_overrides WHERE shop_id = ?
      `).all(shop.targetId).map((row) => ({ ...row }));
      assert.deepEqual(
        restoredOverrides,
        shop.partial ? [] : [{ order_key: shop.orderKey, note: `SOURCE-NOTE-${shop.number}` }],
      );

      const targetShop = db.prepare(`
        SELECT api_key_encrypted, shop_incarnation FROM shops WHERE id = ?
      `).get(shop.targetId);
      assert.equal(targetDecrypt(targetShop.api_key_encrypted), shop.targetApiKey);
      assert.equal(targetShop.shop_incarnation, `target-incarnation-${shop.number}`);
      assert.equal(importService.history({ shopId: shop.targetId }).imports.length, 1);

      for (const otherShop of shops) {
        if (otherShop.targetId === shop.targetId) continue;
        assert.equal(db.prepare(`
          SELECT COUNT(*) AS count FROM product_source_links
          WHERE shop_id = ? AND product_key = ?
        `).get(otherShop.targetId, shop.productKey).count, 0);
        assert.equal(db.prepare(`
          SELECT COUNT(*) AS count FROM purchase_order_overrides
          WHERE shop_id = ? AND order_key = ?
        `).get(otherShop.targetId, shop.orderKey).count, 0);
      }
    }

    assert.equal(db.prepare(`
      SELECT COUNT(DISTINCT shop_id) AS count FROM data_backup_imports WHERE status = 'completed'
    `).get().count, SHOP_COUNT);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM shops WHERE id LIKE 'source-shop-%'
    `).get().count, 0);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    db.close();
  }
});
