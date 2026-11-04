import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import {
  applyReboundShopDataRecovery,
  previewReboundShopDataRecovery,
  REBOUND_SHOP_RECOVERY_CONFIRMATION,
} from './reboundShopDataRecovery.js';

const OLD_SHOP_ID = 'ozon-shop-old';
const NEW_SHOP_ID = 'ozon-shop-new';
const CLIENT_ID = 'client-1';
const PROFILE_ID = 'default';
const TARGET_PROFILE_ID = 'profile-new-incarnation';
const EXTERNAL_HASH = 'external-identity-hash-fixture';
const CREATED_AT = '2026-07-01T00:00:00.000Z';
const UPDATED_AT = '2026-07-15T00:00:00.000Z';
const SCREENSHOT_ORDER_KEY = '06477778-0475-1';

function postingForIndex(index) {
  return index === 1 ? SCREENSHOT_ORDER_KEY : `posting-${String(index).padStart(2, '0')}`;
}

function insertShop(db, {
  id,
  clientId,
  incarnation,
  credentialRevision,
  credential,
  profileId = PROFILE_ID,
}) {
  db.prepare(`
    INSERT INTO shops (
      id, name, alias, client_id, api_key_encrypted, status,
      created_at, updated_at, profile_id, external_identity_hash,
      shop_incarnation, credential_revision, bound_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `Shop ${id}`,
    `Alias ${id}`,
    clientId,
    credential,
    CREATED_AT,
    UPDATED_AT,
    profileId,
    EXTERNAL_HASH,
    incarnation,
    credentialRevision,
    CREATED_AT,
  );
}

function insertTargetOrder(db, index) {
  const orderKey = postingForIndex(index);
  db.prepare(`
    INSERT INTO ozon_orders (
      id, shop_id, order_key, posting_number, order_id, source,
      products_json, remote_hash, is_stale, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'FBS', ?, ?, 0, ?, ?, ?)
  `).run(
    `target-order-${index}`,
    NEW_SHOP_ID,
    orderKey,
    orderKey,
    `remote-order-${index}`,
    JSON.stringify([{
      offer_id: `offer-${((index - 1) % 3) + 1}`,
      sku: `sku-${((index - 1) % 3) + 1}`,
    }]),
    `order-hash-${index}`,
    UPDATED_AT,
    CREATED_AT,
    UPDATED_AT,
  );
}

function insertTargetProduct(db, index) {
  db.prepare(`
    INSERT INTO ozon_products (
      id, shop_id, product_key, product_id, offer_id, sku, name,
      visibility, sort_index, remote_hash, is_stale, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ALL', ?, ?, 0, ?, ?, ?)
  `).run(
    `target-product-${index}`,
    NEW_SHOP_ID,
    `current-product-${index}`,
    `remote-product-${index}`,
    `offer-${index}`,
    `sku-${index}`,
    `Product ${index}`,
    index,
    `product-hash-${index}`,
    UPDATED_AT,
    CREATED_AT,
    UPDATED_AT,
  );
}

function insertSourcePurchaseOverrides(db) {
  const insert = db.prepare(`
    INSERT INTO purchase_order_overrides (
      id, shop_id, order_key, posting_number, purchase_platform,
      purchase_order_number, source_cost_cny, manual_status, raw_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let index = 1; index <= 20; index += 1) {
    const canonical = postingForIndex(index);
    const storedKey = index <= 19 ? `${CLIENT_ID}:${canonical}` : canonical;
    const enriched = index <= 8;
    insert.run(
      `source-override-${index}`,
      OLD_SHOP_ID,
      storedKey,
      storedKey,
      enriched ? 'PDD' : null,
      enriched ? `purchase-${index}` : null,
      enriched ? index + 0.25 : null,
      index <= 4 ? 'paid' : null,
      JSON.stringify({
        order: enriched
          ? {
              crossBorderOrderFound: true,
              packageOrderId: `bus-${index}`,
              packageWeight: `${index / 10} kg`,
              packageSize: '10 x 9 x 8 cm',
              volumeItems: [{ length: 10, width: 9, height: 8 }],
            }
          : {},
      }),
      CREATED_AT,
      UPDATED_AT,
    );
  }
  // The real source contains one unscoped empty placeholder beside the richer
  // client-prefixed row. Recovery must merge it, not create a 21st order.
  insert.run(
    'source-override-empty-duplicate',
    OLD_SHOP_ID,
    SCREENSHOT_ORDER_KEY,
    SCREENSHOT_ORDER_KEY,
    null,
    null,
    null,
    null,
    JSON.stringify({ order: { crossBorderOrderFound: true } }),
    CREATED_AT,
    '2026-07-14T00:00:00.000Z',
  );
}

function insertSourceProductLinks(db) {
  const insert = db.prepare(`
    INSERT INTO product_source_links (
      id, shop_id, product_key, product_id, offer_id, sku,
      slot_index, is_primary, platform, url, source_product_id,
      title, image_url, preview_image_url, original_image_url,
      price_value, currency_code, qty, raw_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PDD', ?, ?, ?, ?, ?, ?, ?, 'CNY', '1', ?, ?, ?)
  `);
  for (let productIndex = 1; productIndex <= 3; productIndex += 1) {
    for (let slotIndex = 0; slotIndex <= 1; slotIndex += 1) {
      insert.run(
        `source-product-link-${productIndex}-${slotIndex}`,
        OLD_SHOP_ID,
        `legacy-product-${productIndex}`,
        `legacy-remote-product-${productIndex}`,
        `offer-${productIndex}`,
        `legacy-sku-${productIndex}`,
        slotIndex,
        slotIndex === 0 ? 1 : 0,
        `https://example.invalid/product/${productIndex}/${slotIndex}`,
        `source-product-${productIndex}-${slotIndex}`,
        `Source ${productIndex}-${slotIndex}`,
        `https://example.invalid/image/${productIndex}/${slotIndex}`,
        `https://example.invalid/preview/${productIndex}/${slotIndex}`,
        `https://example.invalid/original/${productIndex}/${slotIndex}`,
        productIndex + slotIndex / 10,
        JSON.stringify({ fixture: true }),
        CREATED_AT,
        UPDATED_AT,
      );
    }
  }
}

function insertSourcePurchaseLink(db) {
  db.prepare(`
    INSERT INTO purchase_source_links (
      id, shop_id, order_key, product_key, offer_id, sku,
      slot_index, is_primary, platform, url, source_product_id,
      title, image_url, preview_image_url, original_image_url,
      price_value, currency_code, qty, raw_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 'PDD', ?, ?, ?, ?, ?, ?, 2.5, 'CNY', '1', ?, ?, ?)
  `).run(
    'source-purchase-link-1',
    OLD_SHOP_ID,
    SCREENSHOT_ORDER_KEY,
    'legacy-order-product',
    'offer-1',
    'sku-1',
    'https://example.invalid/purchase/1',
    'source-purchase-product-1',
    'Purchase source 1',
    'https://example.invalid/purchase/image/1',
    'https://example.invalid/purchase/preview/1',
    'https://example.invalid/purchase/original/1',
    JSON.stringify({ fixture: true }),
    CREATED_AT,
    UPDATED_AT,
  );
}

function insertCrossBorderRows(sourceDb, targetDb) {
  const insertSource = sourceDb.prepare(`
    INSERT INTO cross_border_order_records (
      id, shop_id, record_key, order_id, platform_order, status,
      package_weight_kg, length_cm, width_cm, height_cm,
      status_json, out_info_json, raw_json, remote_hash,
      is_stale, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `);
  const insertTarget = targetDb.prepare(`
    INSERT INTO cross_border_order_records (
      id, shop_id, record_key, order_id, platform_order, status,
      package_weight_kg, length_cm, width_cm, height_cm,
      status_json, out_info_json, raw_json, remote_hash,
      is_stale, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, 0, ?, ?, ?)
  `);
  for (let index = 1; index <= 10; index += 1) {
    const key = `bus-${index}`;
    const platformOrder = index === 1
      ? 'E362-20260623091940793387009'
      : index === 2
        ? null
        : `platform-${index}`;
    const currentRaw = index <= 2
      ? {
          source: 'current-raw',
          index,
          sheet_info: {
            ...(index === 1 ? { sheet_order_sn: SCREENSHOT_ORDER_KEY } : {}),
            ...(index === 2 ? { section_order: postingForIndex(index) } : {}),
          },
          ...(index === 1
            ? { body: { section_code: 'transport-section-noise' } }
            : {}),
        }
      : { source: 'current-raw', index };
    insertSource.run(
      `source-old-cross-${index}`,
      OLD_SHOP_ID,
      key,
      key,
      platformOrder,
      `old-status-${index}`,
      index / 10,
      10 + index,
      9 + index,
      8 + index,
      JSON.stringify({ source: 'old-status', index }),
      JSON.stringify({ source: 'old-out', index }),
      JSON.stringify(index === 1
        ? { source: 'old-raw', index, sheet_info: { section_order: SCREENSHOT_ORDER_KEY } }
        : { source: 'old-raw', index }),
      `old-hash-${index}`,
      UPDATED_AT,
      CREATED_AT,
      UPDATED_AT,
    );
    insertSource.run(
      `source-client-cross-${index}`,
      CLIENT_ID,
      key,
      key,
      platformOrder,
      `current-status-${index}`,
      null,
      null,
      null,
      null,
      null,
      null,
      JSON.stringify(currentRaw),
      `current-hash-${index}`,
      UPDATED_AT,
      CREATED_AT,
      UPDATED_AT,
    );
    insertTarget.run(
      `target-client-cross-${index}`,
      CLIENT_ID,
      key,
      key,
      platformOrder,
      `current-status-${index}`,
      JSON.stringify(currentRaw),
      `current-hash-${index}`,
      UPDATED_AT,
      CREATED_AT,
      UPDATED_AT,
    );
  }
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'wangzai-rebound-recovery-'));
  const sourcePath = join(directory, 'source.sqlite');
  const dataRoot = join(directory, 'profile');
  const targetPath = join(dataRoot, 'local-api-data', 'wangzai-local-api.sqlite');
  const profileLockPath = join(dataRoot, 'runtime', 'profile.lock');
  const backupDirectory = join(dataRoot, 'backups', 'rebound-shop-data-recovery');
  const snapshotRoot = join(dataRoot, 'restore-staging');
  mkdirSync(join(dataRoot, 'local-api-data'), { recursive: true });
  const sourceDb = createMigratedTestDb(sourcePath);
  const targetDb = createMigratedTestDb(targetPath);
  insertShop(sourceDb, {
    id: OLD_SHOP_ID,
    clientId: CLIENT_ID,
    incarnation: 'old-incarnation',
    credentialRevision: 1,
    credential: 'source-credential-ciphertext',
  });
  insertShop(targetDb, {
    id: NEW_SHOP_ID,
    clientId: CLIENT_ID,
    incarnation: 'new-incarnation',
    credentialRevision: 2,
    credential: 'target-credential-ciphertext',
    profileId: TARGET_PROFILE_ID,
  });
  targetDb.prepare(`
    INSERT INTO shop_identity_tombstones (
      tombstone_id, profile_id, former_shop_id, external_identity_hash,
      former_shop_incarnation, final_credential_revision,
      deletion_operation_id, deletion_reason, metadata_json,
      deleted_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, 'permanent_delete', '{}', ?, ?)
  `).run(
    'fixture-tombstone',
    PROFILE_ID,
    OLD_SHOP_ID,
    EXTERNAL_HASH,
    'old-incarnation',
    'fixture-removal-operation',
    UPDATED_AT,
    UPDATED_AT,
  );
  for (let index = 1; index <= 20; index += 1) insertTargetOrder(targetDb, index);
  for (let index = 1; index <= 3; index += 1) insertTargetProduct(targetDb, index);
  insertSourcePurchaseOverrides(sourceDb);
  insertSourceProductLinks(sourceDb);
  insertSourcePurchaseLink(sourceDb);
  insertCrossBorderRows(sourceDb, targetDb);
  sourceDb.close();
  targetDb.close();
  const options = {
    dataRoot,
    sourcePath,
    targetPath,
    profileLockPath,
    backupDirectory,
    snapshotRoot,
    oldShopId: OLD_SHOP_ID,
    newShopId: NEW_SHOP_ID,
    clientId: CLIENT_ID,
  };
  return {
    directory,
    sourcePath,
    targetPath,
    profileLockPath,
    backupDirectory,
    options,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function count(db, tableName, where = '', params = []) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${tableName} ${where}`).get(...params).count);
}

function listBackupFiles(directory) {
  return existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith('.sqlite'))
    : [];
}

test('preview is read-only and apply restores exact canonical counts idempotently', () => {
  const fixture = createFixture();
  try {
    const preview = previewReboundShopDataRecovery(fixture.options);
    assert.equal(preview.safeToApply, true);
    assert.equal(preview.profileLockPresent, false);
    assert.deepEqual(preview.issues, []);
    assert.deepEqual(preview.counts.purchaseOverrides, {
      sourcePhysical: 21,
      canonical: 20,
      duplicateRowsMerged: 1,
      mappedToCurrentOrders: 20,
      enriched: 8,
      insert: 20,
      rekey: 0,
      deleteLegacyUnscoped: 0,
      unchanged: 0,
      conflicts: 0,
    });
    assert.equal(preview.counts.productSourceLinks.source, 6);
    assert.equal(preview.counts.productSourceLinks.mappedProducts, 3);
    assert.equal(preview.counts.purchaseSourceLinks.source, 1);
    assert.equal(preview.counts.crossBorder.source, 10);
    assert.equal(preview.counts.crossBorder.insert, 10);
    assert.equal(preview.counts.crossBorder.deleteClientScope, 10);
    assert.equal(existsSync(fixture.profileLockPath), false);
    assert.equal(existsSync(fixture.backupDirectory), false);

    const applied = applyReboundShopDataRecovery({
      ...fixture.options,
      confirmation: REBOUND_SHOP_RECOVERY_CONFIRMATION,
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.alreadyApplied, false);
    assert.equal(applied.backup.quickCheck, 'ok');
    assert.equal(applied.counts.purchaseOverrides, 20);
    assert.equal(applied.counts.productSourceLinks, 6);
    assert.equal(applied.counts.purchaseSourceLinks, 1);
    assert.equal(applied.counts.crossBorderInserted, 10);
    assert.equal(applied.counts.crossBorderClientScopeDeleted, 10);

    const db = new DatabaseSync(fixture.targetPath, { readOnly: true });
    try {
      assert.equal(count(db, 'purchase_order_overrides', 'WHERE shop_id = ?', [NEW_SHOP_ID]), 20);
      assert.equal(count(db, 'product_source_links', 'WHERE shop_id = ?', [NEW_SHOP_ID]), 6);
      assert.equal(count(db, 'purchase_source_links', 'WHERE shop_id = ?', [NEW_SHOP_ID]), 1);
      assert.equal(count(db, 'cross_border_order_records', 'WHERE shop_id = ?', [NEW_SHOP_ID]), 10);
      assert.equal(count(db, 'cross_border_order_records', 'WHERE shop_id = ?', [CLIENT_ID]), 0);
      assert.equal(count(db, 'shops'), 1);
      assert.equal(count(db, 'shops', 'WHERE id = ?', [OLD_SHOP_ID]), 0);
      assert.equal(
        db.prepare('SELECT api_key_encrypted FROM shops WHERE id = ?').get(NEW_SHOP_ID).api_key_encrypted,
        'target-credential-ciphertext',
      );

      const mergedOverride = db.prepare(`
        SELECT order_key, posting_number, purchase_platform, purchase_order_number, source_cost_cny
        FROM purchase_order_overrides WHERE shop_id = ? AND order_key = ?
      `).get(NEW_SHOP_ID, `${CLIENT_ID}:${SCREENSHOT_ORDER_KEY}`);
      assert.deepEqual({ ...mergedOverride }, {
        order_key: `${CLIENT_ID}:${SCREENSHOT_ORDER_KEY}`,
        posting_number: `${CLIENT_ID}:${SCREENSHOT_ORDER_KEY}`,
        purchase_platform: 'PDD',
        purchase_order_number: 'purchase-1',
        source_cost_cny: 1.25,
      });
      assert.deepEqual(
        db.prepare(`
          SELECT DISTINCT product_key FROM product_source_links
          WHERE shop_id = ? ORDER BY product_key
        `).all(NEW_SHOP_ID).map((row) => row.product_key),
        ['current-product-1', 'current-product-2', 'current-product-3'],
      );
      assert.equal(
        db.prepare('SELECT product_key FROM purchase_source_links WHERE shop_id = ?').get(NEW_SHOP_ID).product_key,
        'current-product-1',
      );
      const cross = db.prepare(`
        SELECT platform_order, sheet_order_sn, status, package_weight_kg,
               status_json, out_info_json, raw_json, remote_hash
        FROM cross_border_order_records WHERE shop_id = ? AND record_key = 'bus-1'
      `).get(NEW_SHOP_ID);
      assert.equal(cross.platform_order, 'E362-20260623091940793387009');
      assert.equal(cross.sheet_order_sn, SCREENSHOT_ORDER_KEY);
      assert.equal(cross.status, 'current-status-1');
      assert.equal(cross.package_weight_kg, 0.1);
      assert.deepEqual(JSON.parse(cross.status_json), { source: 'old-status', index: 1 });
      assert.deepEqual(JSON.parse(cross.out_info_json), { source: 'old-out', index: 1 });
      assert.deepEqual(JSON.parse(cross.raw_json), {
        source: 'current-raw',
        index: 1,
        sheet_info: { sheet_order_sn: SCREENSHOT_ORDER_KEY },
        body: { section_code: 'transport-section-noise' },
      });
      assert.equal(cross.remote_hash, 'current-hash-1');
      const crossWithBothMissing = db.prepare(`
        SELECT platform_order, sheet_order_sn
        FROM cross_border_order_records WHERE shop_id = ? AND record_key = 'bus-2'
      `).get(NEW_SHOP_ID);
      assert.deepEqual({ ...crossWithBothMissing }, {
        platform_order: postingForIndex(2),
        sheet_order_sn: postingForIndex(2),
      });
      assert.equal(db.prepare('PRAGMA quick_check;').get().quick_check, 'ok');
    } finally {
      db.close();
    }
    assert.equal(existsSync(fixture.profileLockPath), false);
    assert.equal(listBackupFiles(fixture.backupDirectory).length, 1);

    const second = applyReboundShopDataRecovery({
      ...fixture.options,
      confirmation: REBOUND_SHOP_RECOVERY_CONFIRMATION,
    });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyApplied, true);
    assert.equal(second.backup, null);
    assert.equal(listBackupFiles(fixture.backupDirectory).length, 1);
    assert.equal(existsSync(fixture.profileLockPath), false);
  } finally {
    fixture.cleanup();
  }
});

test('a prior unscoped recovery is rekeyed in place without leaving forty logical rows', () => {
  const fixture = createFixture();
  try {
    applyReboundShopDataRecovery({
      ...fixture.options,
      confirmation: REBOUND_SHOP_RECOVERY_CONFIRMATION,
    });
    const legacyDb = new DatabaseSync(fixture.targetPath);
    try {
      const rows = legacyDb.prepare(`
        SELECT id, order_key FROM purchase_order_overrides
        WHERE shop_id = ? ORDER BY order_key
      `).all(NEW_SHOP_ID);
      for (const [index, row] of rows.entries()) {
        const unscoped = String(row.order_key).slice(`${CLIENT_ID}:`.length);
        legacyDb.prepare(`
          UPDATE purchase_order_overrides
          SET id = ?, order_key = ?, posting_number = ?
          WHERE id = ?
        `).run(`legacy-unscoped-${index + 1}`, unscoped, unscoped, row.id);
      }
    } finally {
      legacyDb.close();
    }

    const preview = previewReboundShopDataRecovery(fixture.options);
    assert.equal(preview.safeToApply, true);
    assert.equal(preview.counts.purchaseOverrides.insert, 0);
    assert.equal(preview.counts.purchaseOverrides.rekey, 20);
    assert.equal(preview.counts.purchaseOverrides.deleteLegacyUnscoped, 20);
    assert.equal(preview.counts.purchaseOverrides.unchanged, 0);
    assert.equal(preview.counts.purchaseOverrides.conflicts, 0);
    assert.equal(preview.counts.plannedWrites, 20);

    const repaired = applyReboundShopDataRecovery({
      ...fixture.options,
      confirmation: REBOUND_SHOP_RECOVERY_CONFIRMATION,
    });
    assert.equal(repaired.alreadyApplied, false);
    assert.equal(repaired.counts.purchaseOverrides, 20);
    assert.equal(repaired.counts.purchaseOverridesInserted, 0);
    assert.equal(repaired.counts.purchaseOverridesRekeyed, 20);
    assert.equal(repaired.counts.purchaseOverrideLegacyKeysDeleted, 20);

    const db = new DatabaseSync(fixture.targetPath, { readOnly: true });
    try {
      assert.equal(count(db, 'purchase_order_overrides', 'WHERE shop_id = ?', [NEW_SHOP_ID]), 20);
      assert.equal(
        count(
          db,
          'purchase_order_overrides',
          'WHERE shop_id = ? AND order_key LIKE ?',
          [NEW_SHOP_ID, `${CLIENT_ID}:%`],
        ),
        20,
      );
      assert.equal(
        count(
          db,
          'purchase_order_overrides',
          'WHERE shop_id = ? AND order_key = ?',
          [NEW_SHOP_ID, SCREENSHOT_ORDER_KEY],
        ),
        0,
      );
    } finally {
      db.close();
    }

    const secondPreview = previewReboundShopDataRecovery(fixture.options);
    assert.equal(secondPreview.safeToApply, true);
    assert.equal(secondPreview.counts.plannedWrites, 0);
    const second = applyReboundShopDataRecovery({
      ...fixture.options,
      confirmation: REBOUND_SHOP_RECOVERY_CONFIRMATION,
    });
    assert.equal(second.alreadyApplied, true);
  } finally {
    fixture.cleanup();
  }
});

test('cross-border raw order references fail closed when they map to multiple current orders', () => {
  const fixture = createFixture();
  try {
    const targetDb = new DatabaseSync(fixture.targetPath);
    try {
      insertTargetOrder(targetDb, 21);
      targetDb.prepare(`
        UPDATE cross_border_order_records SET raw_json = ?
        WHERE shop_id = ? AND record_key = 'bus-1'
      `).run(JSON.stringify({
        sheet_info: {
          sheet_order_sn: SCREENSHOT_ORDER_KEY,
          section_order: postingForIndex(21),
        },
      }), CLIENT_ID);
    } finally {
      targetDb.close();
    }
    const preview = previewReboundShopDataRecovery(fixture.options);
    assert.equal(preview.safeToApply, false);
    assert.equal(preview.issues.includes('CROSS_BORDER_RAW_ORDER_MAPPING_AMBIGUOUS'), true);
  } finally {
    fixture.cleanup();
  }
});

test('cross-border request body section_code is ignored even when it names another current order', () => {
  const fixture = createFixture();
  try {
    const targetDb = new DatabaseSync(fixture.targetPath);
    try {
      targetDb.prepare(`
        UPDATE cross_border_order_records SET raw_json = ?
        WHERE shop_id = ? AND record_key = 'bus-1'
      `).run(JSON.stringify({
        sheet_info: { sheet_order_sn: SCREENSHOT_ORDER_KEY },
        body: { section_code: postingForIndex(2) },
      }), CLIENT_ID);
    } finally {
      targetDb.close();
    }
    const preview = previewReboundShopDataRecovery(fixture.options);
    assert.equal(preview.safeToApply, true);
    assert.equal(preview.issues.includes('CROSS_BORDER_RAW_ORDER_MAPPING_CONFLICT'), false);
    assert.equal(preview.counts.crossBorder.insert, 10);
  } finally {
    fixture.cleanup();
  }
});

test('cross-border authoritative raw candidate groups fail closed when they map to different orders', () => {
  const fixture = createFixture();
  try {
    const targetDb = new DatabaseSync(fixture.targetPath);
    try {
      targetDb.prepare(`
        UPDATE cross_border_order_records SET raw_json = ?
        WHERE shop_id = ? AND record_key = 'bus-1'
      `).run(JSON.stringify({
        sheet_info: { sheet_order_sn: SCREENSHOT_ORDER_KEY },
        section_order: postingForIndex(2),
      }), CLIENT_ID);
    } finally {
      targetDb.close();
    }
    const preview = previewReboundShopDataRecovery(fixture.options);
    assert.equal(preview.safeToApply, false);
    assert.equal(preview.issues.includes('CROSS_BORDER_RAW_ORDER_MAPPING_CONFLICT'), true);
  } finally {
    fixture.cleanup();
  }
});

test('cross-border raw references fail closed when base and source map to different current orders', () => {
  const fixture = createFixture();
  try {
    const sourceDb = new DatabaseSync(fixture.sourcePath);
    try {
      sourceDb.prepare(`
        UPDATE cross_border_order_records SET raw_json = ?
        WHERE shop_id = ? AND record_key = 'bus-1'
      `).run(JSON.stringify({
        sheet_info: { section_order: postingForIndex(2) },
      }), OLD_SHOP_ID);
    } finally {
      sourceDb.close();
    }
    const preview = previewReboundShopDataRecovery(fixture.options);
    assert.equal(preview.safeToApply, false);
    assert.equal(preview.issues.includes('CROSS_BORDER_RAW_ORDER_MAPPING_CONFLICT'), true);
  } finally {
    fixture.cleanup();
  }
});

test('cross-border raw mapping never overwrites a structured reference to another current order', () => {
  const fixture = createFixture();
  try {
    const targetDb = new DatabaseSync(fixture.targetPath);
    try {
      targetDb.prepare(`
        UPDATE cross_border_order_records SET platform_order = ?
        WHERE shop_id = ? AND record_key = 'bus-1'
      `).run(postingForIndex(2), CLIENT_ID);
    } finally {
      targetDb.close();
    }
    const preview = previewReboundShopDataRecovery(fixture.options);
    assert.equal(preview.safeToApply, false);
    assert.equal(preview.issues.includes('CROSS_BORDER_STRUCTURED_ORDER_MAPPING_CONFLICT'), true);
  } finally {
    fixture.cleanup();
  }
});

test('apply rechecks conflicts after the backup under the SQLite write lock', () => {
  const fixture = createFixture();
  try {
    assert.throws(
      () => applyReboundShopDataRecovery({
        ...fixture.options,
        confirmation: REBOUND_SHOP_RECOVERY_CONFIRMATION,
        testHooks: {
          afterBackup() {
            const racingDb = new DatabaseSync(fixture.targetPath);
            try {
              racingDb.prepare(`
                INSERT INTO purchase_order_overrides (
                  id, shop_id, order_key, posting_number, purchase_platform,
                  created_at, updated_at
                ) VALUES ('racing-conflict', ?, 'posting-02', 'posting-02', 'OTHER', ?, ?)
              `).run(NEW_SHOP_ID, CREATED_AT, UPDATED_AT);
            } finally {
              racingDb.close();
            }
          },
        },
      }),
      (error) => error?.code === 'REBOUND_RECOVERY_CONFLICT',
    );
    const db = new DatabaseSync(fixture.targetPath, { readOnly: true });
    try {
      assert.equal(count(db, 'purchase_order_overrides', 'WHERE shop_id = ?', [NEW_SHOP_ID]), 1);
      assert.equal(count(db, 'product_source_links', 'WHERE shop_id = ?', [NEW_SHOP_ID]), 0);
      assert.equal(count(db, 'purchase_source_links', 'WHERE shop_id = ?', [NEW_SHOP_ID]), 0);
      assert.equal(count(db, 'cross_border_order_records', 'WHERE shop_id = ?', [CLIENT_ID]), 10);
      assert.equal(count(db, 'cross_border_order_records', 'WHERE shop_id = ?', [NEW_SHOP_ID]), 0);
    } finally {
      db.close();
    }
    assert.equal(listBackupFiles(fixture.backupDirectory).length, 1);
    assert.equal(existsSync(fixture.profileLockPath), false);
  } finally {
    fixture.cleanup();
  }
});

test('one forced failure rolls back every recovery domain in the single transaction', () => {
  const fixture = createFixture();
  try {
    assert.throws(
      () => applyReboundShopDataRecovery({
        ...fixture.options,
        confirmation: REBOUND_SHOP_RECOVERY_CONFIRMATION,
        testHooks: {
          afterWrites() {
            const error = new Error('forced fixture rollback');
            error.code = 'TEST_FORCED_ROLLBACK';
            throw error;
          },
        },
      }),
      (error) => error?.code === 'TEST_FORCED_ROLLBACK',
    );
    const db = new DatabaseSync(fixture.targetPath, { readOnly: true });
    try {
      assert.equal(count(db, 'purchase_order_overrides', 'WHERE shop_id = ?', [NEW_SHOP_ID]), 0);
      assert.equal(count(db, 'product_source_links', 'WHERE shop_id = ?', [NEW_SHOP_ID]), 0);
      assert.equal(count(db, 'purchase_source_links', 'WHERE shop_id = ?', [NEW_SHOP_ID]), 0);
      assert.equal(count(db, 'cross_border_order_records', 'WHERE shop_id = ?', [CLIENT_ID]), 10);
      assert.equal(count(db, 'cross_border_order_records', 'WHERE shop_id = ?', [NEW_SHOP_ID]), 0);
      assert.equal(count(db, 'shops'), 1);
      assert.equal(db.prepare('PRAGMA quick_check;').get().quick_check, 'ok');
    } finally {
      db.close();
    }
    assert.equal(listBackupFiles(fixture.backupDirectory).length, 1);
    assert.equal(existsSync(fixture.profileLockPath), false);
  } finally {
    fixture.cleanup();
  }
});

test('apply refuses an existing profile lock before backup or database writes', () => {
  const fixture = createFixture();
  try {
    mkdirSync(join(fixture.options.dataRoot, 'runtime'), { recursive: true });
    writeFileSync(fixture.profileLockPath, '{"pid":1}\n', 'utf8');
    assert.throws(
      () => applyReboundShopDataRecovery({
        ...fixture.options,
        confirmation: REBOUND_SHOP_RECOVERY_CONFIRMATION,
      }),
      (error) => error?.code === 'REBOUND_RECOVERY_PROFILE_LOCK_PRESENT',
    );
    const db = new DatabaseSync(fixture.targetPath, { readOnly: true });
    try {
      assert.equal(count(db, 'purchase_order_overrides', 'WHERE shop_id = ?', [NEW_SHOP_ID]), 0);
      assert.equal(count(db, 'product_source_links', 'WHERE shop_id = ?', [NEW_SHOP_ID]), 0);
      assert.equal(count(db, 'purchase_source_links', 'WHERE shop_id = ?', [NEW_SHOP_ID]), 0);
      assert.equal(count(db, 'cross_border_order_records', 'WHERE shop_id = ?', [CLIENT_ID]), 10);
    } finally {
      db.close();
    }
    assert.equal(existsSync(fixture.backupDirectory), false);
  } finally {
    fixture.cleanup();
  }
});

test('target database must be the canonical database bound to the same data root and lock', () => {
  const fixture = createFixture();
  try {
    assert.throws(
      () => previewReboundShopDataRecovery({
        ...fixture.options,
        targetPath: join(fixture.directory, 'other-target.sqlite'),
      }),
      (error) => error?.code === 'REBOUND_RECOVERY_TARGET_NOT_BOUND_TO_DATA_ROOT',
    );
  } finally {
    fixture.cleanup();
  }
});

test('preview fails closed instead of dropping a cross-border row with an empty natural key', () => {
  const fixture = createFixture();
  try {
    const sourceDb = new DatabaseSync(fixture.sourcePath);
    const targetDb = new DatabaseSync(fixture.targetPath);
    try {
      sourceDb.prepare(`
        UPDATE cross_border_order_records SET record_key = ''
        WHERE shop_id = ? AND record_key = 'bus-1'
      `).run(OLD_SHOP_ID);
      targetDb.prepare(`
        UPDATE cross_border_order_records SET record_key = ''
        WHERE shop_id = ? AND record_key = 'bus-1'
      `).run(CLIENT_ID);
    } finally {
      sourceDb.close();
      targetDb.close();
    }
    const preview = previewReboundShopDataRecovery(fixture.options);
    assert.equal(preview.safeToApply, false);
    assert.equal(preview.issues.includes('CROSS_BORDER_SOURCE_RECORD_KEY_EMPTY'), true);
    assert.equal(preview.issues.includes('CROSS_BORDER_CURRENT_RECORD_KEY_EMPTY'), true);
    assert.equal(preview.issues.includes('CROSS_BORDER_EXPECTED_ROW_COUNT_MISMATCH'), true);
  } finally {
    fixture.cleanup();
  }
});

test('preview rejects non-empty conflicts in a duplicate purchase override group', () => {
  const fixture = createFixture();
  try {
    const sourceDb = new DatabaseSync(fixture.sourcePath);
    try {
      sourceDb.prepare(`
        UPDATE purchase_order_overrides SET purchase_platform = 'OTHER'
        WHERE id = 'source-override-empty-duplicate'
      `).run();
    } finally {
      sourceDb.close();
    }
    const preview = previewReboundShopDataRecovery(fixture.options);
    assert.equal(preview.safeToApply, false);
    assert.equal(preview.issues.includes('PURCHASE_OVERRIDE_DUPLICATE_SHAPE_UNSAFE'), true);
    assert.equal(preview.issues.includes('PURCHASE_OVERRIDE_DUPLICATE_NONEMPTY_CONFLICT'), true);
  } finally {
    fixture.cleanup();
  }
});

test('purchase source mapping requires the resolved product to belong to the resolved order', () => {
  const fixture = createFixture();
  try {
    const targetDb = new DatabaseSync(fixture.targetPath);
    try {
      targetDb.prepare(`
        UPDATE ozon_orders SET products_json = ? WHERE shop_id = ? AND order_key = ?
      `).run(
        JSON.stringify([{ offer_id: 'offer-2', sku: 'sku-2' }]),
        NEW_SHOP_ID,
        SCREENSHOT_ORDER_KEY,
      );
    } finally {
      targetDb.close();
    }
    const preview = previewReboundShopDataRecovery(fixture.options);
    assert.equal(preview.safeToApply, false);
    assert.equal(preview.issues.includes('PURCHASE_SOURCE_PRODUCT_MAPPING_FAILED'), true);
    assert.equal(preview.counts.purchaseSourceLinks.insert, 0);
  } finally {
    fixture.cleanup();
  }
});
