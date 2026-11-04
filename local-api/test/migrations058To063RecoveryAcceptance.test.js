import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  readFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createRecoveryBackupOrchestrator } from '../src/backup/recoveryBackupOrchestrator.js';
import { openRecoveryGeneration } from '../src/backup/recoveryGeneration.js';
import { createRecoveryKeysetStore } from '../src/backup/recoveryKeysetStore.js';
import { createRecoveryRestoreOrchestrator } from '../src/backup/recoveryRestoreOrchestrator.js';
import { createRecoverySqliteSnapshot } from '../src/backup/recoverySqliteSnapshot.js';
import { discoverAccountRemovalProtectionFamilies } from '../src/backup/accountRemovalProtectionService.js';
import { listMigrationFiles, runMigrations } from '../src/db/database.js';
import { createAccountRemovalSqliteExecutor } from '../src/domain/accountRemoval/accountRemovalSqliteExecutor.js';

const FIXTURE_TIME = '2026-07-16T00:30:00.000Z';
const RECOVERY_PASSPHRASE = 'acceptance portable recovery passphrase';

const secretCodec = {
  encrypt: (value) => `local:${Buffer.from(value).toString('base64url')}`,
  decrypt: (value) => String(value).startsWith('local:')
    ? Buffer.from(String(value).slice(6), 'base64url').toString('utf8')
    : null,
};

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function openMigratedProfile(root, fileName) {
  const filePath = join(root, fileName);
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.prepare('PRAGMA journal_mode = WAL;').get();
  db.exec('PRAGMA wal_autocheckpoint = 0;');
  runMigrations(db);
  return { db, filePath };
}

function openMigratedProfileThrough(root, fileName, maximumMigration) {
  const filePath = join(root, fileName);
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON;');
  for (const migration of listMigrationFiles()) {
    const migrationNumber = Number(migration.version.slice(0, 3));
    if (migrationNumber > maximumMigration) break;
    db.exec(readFileSync(migration.path, 'utf8').replace(/^\uFEFF/u, ''));
  }
  return { db, filePath };
}

function insertShop(db, label, { shopId = `shop-${label}` } = {}) {
  db.prepare(`
    INSERT INTO shops (
      id, name, client_id, api_key_encrypted, status,
      created_at, updated_at, profile_id, external_identity_hash,
      shop_incarnation, credential_revision, bound_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, 'default', ?, ?, 1, ?)
  `).run(
    shopId,
    `Profile ${label} shop`,
    `client-${label}`,
    `source:api-key-${label}`,
    FIXTURE_TIME,
    FIXTURE_TIME,
    sha256(`client-${label}`),
    `incarnation-${label}`,
    FIXTURE_TIME,
  );
  return shopId;
}

function insertPurchaseHistory(db, { label, shopId }) {
  const receipt = { orderNumber: `PDD-${label}-100`, amount: '88.00', status: 'completed' };
  const orderProduct = { orderKey: `ozon-order-${label}`, productKey: `ozon-product-${label}` };
  const sourceSummary = { platform: 'Pinduoduo', sourceAccountRef: `purchase-${label}` };
  db.prepare(`
    INSERT INTO purchase_completion_history (
      shop_id, source_task_id, source_receipt_id,
      source_account_ref_hash, order_number_hash, receipt_encrypted,
      receipt_hash, website_readback_hash, order_product_encrypted,
      order_product_hash, source_summary_encrypted, source_summary_hash,
      archive_origin, completed_at, archived_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    shopId,
    `task-${label}`,
    `receipt-${label}`,
    sha256(`purchase-${label}`),
    sha256(receipt.orderNumber),
    `source:${JSON.stringify(receipt)}`,
    sha256(JSON.stringify(receipt)),
    sha256(`readback-${label}`),
    `source:${JSON.stringify(orderProduct)}`,
    sha256(JSON.stringify(orderProduct)),
    `source:${JSON.stringify(sourceSummary)}`,
    sha256(JSON.stringify(sourceSummary)),
    'website-readback',
    FIXTURE_TIME,
    FIXTURE_TIME,
    FIXTURE_TIME,
    FIXTURE_TIME,
  );
}

function seedBusinessProfile(db, label, { shopId = `shop-${label}` } = {}) {
  insertShop(db, label, { shopId });
  db.prepare(`
    INSERT INTO purchase_accounts (
      id, name, platform_name, login_account, login_password_encrypted,
      created_at, updated_at
    ) VALUES (?, ?, 'Pinduoduo', ?, ?, ?, ?)
  `).run(
    `purchase-${label}`,
    `Purchase ${label}`,
    `buyer-${label}`,
    `source:purchase-password-${label}`,
    FIXTURE_TIME,
    FIXTURE_TIME,
  );
  db.prepare(`
    INSERT INTO cross_border_accounts (
      id, name, status, user_name_encrypted, password_encrypted,
      company_secret_encrypted, access_token_encrypted, app_uid_encrypted,
      default_storehouse, created_at, updated_at
    ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `bus-${label}`,
    `Cross-border ${label}`,
    `source:bus-user-${label}`,
    `source:bus-password-${label}`,
    `source:bus-company-${label}`,
    `source:bus-token-${label}`,
    `source:bus-uid-${label}`,
    `warehouse-${label}`,
    FIXTURE_TIME,
    FIXTURE_TIME,
  );
  db.prepare(`
    INSERT INTO cross_border_order_records (
      id, shop_id, record_key, order_id, platform_order,
      tracking_number, status, raw_json, remote_hash,
      last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
  `).run(
    `cross-record-${label}`,
    shopId,
    `record-${label}`,
    `cross-order-${label}`,
    `PDD-${label}-100`,
    `tracking-${label}`,
    JSON.stringify({ label, owner: shopId }),
    sha256(`cross-record-${label}`),
    FIXTURE_TIME,
    FIXTURE_TIME,
    FIXTURE_TIME,
  );
  insertPurchaseHistory(db, { label, shopId });
  db.prepare(`
    INSERT INTO product_identities (
      product_identity_id, shop_id, product_id, offer_id, sku, source,
      operation_id, contract_version, mapper_version, response_hash,
      observed_at, row_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'ozon', ?, 'products.info:v3', 'acceptance-mapper-v1', ?, ?, ?, ?, ?)
  `).run(
    `identity-${label}`,
    shopId,
    `product-id-${label}`,
    `offer-${label}`,
    `sku-${label}`,
    `operation-${label}`,
    sha256(`product-response-${label}`),
    FIXTURE_TIME,
    sha256(`identity-row-${label}`),
    FIXTURE_TIME,
    FIXTURE_TIME,
  );
  db.prepare(`
    INSERT INTO product_commission_facts (
      product_identity_id, shop_id, fulfillment_type, rate_ppm, status,
      operation_id, contract_version, mapper_version, response_hash,
      observed_at, source_reason, row_hash, updated_at
    ) VALUES (?, ?, 'FBO', 150000, 'returned', ?, 'products.prices:v5',
      'acceptance-mapper-v1', ?, ?, 'ozon-direct-commission', ?, ?)
  `).run(
    `identity-${label}`,
    shopId,
    `operation-${label}`,
    sha256(`commission-response-${label}`),
    FIXTURE_TIME,
    sha256(`commission-row-${label}`),
    FIXTURE_TIME,
  );
  db.prepare(`
    INSERT INTO shared_catalog_versions (
      catalog_id, platform, marketplace, locale, contract_version,
      mapper_version, source_kind, content_hash, active_snapshot_id,
      source_summary_json, created_at, updated_at
    ) VALUES (?, 'ozon', 'RU', 'ru-RU', ?, 'catalog-mapper-v1', 'test', ?, ?, '{}', ?, ?)
  `).run(
    `catalog-${label}`,
    `catalog-contract-${label}`,
    sha256(`catalog-${label}`),
    `catalog-snapshot-${label}`,
    FIXTURE_TIME,
    FIXTURE_TIME,
  );
  return shopId;
}

function assertHealthy(db) {
  const quickCheck = db.prepare('PRAGMA quick_check;').get();
  assert.equal(String(quickCheck.quick_check ?? Object.values(quickCheck)[0]), 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check;').all(), []);
}

test('current migrated schema survives active WAL: raw main-file copy misses commits while VACUUM INTO is complete and read-only', () => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-wal-snapshot-acceptance-'));
  const { db, filePath } = openMigratedProfile(root, 'active-profile.sqlite');
  const rawCopyPath = join(root, 'unsafe-main-only.sqlite');
  let pinnedReader = null;
  let snapshot = null;
  try {
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get();
    pinnedReader = new DatabaseSync(filePath, { readOnly: true });
    pinnedReader.exec('BEGIN;');
    assert.equal(pinnedReader.prepare('SELECT COUNT(*) AS count FROM shops').get().count, 0);

    db.exec('BEGIN IMMEDIATE;');
    try {
      const shopId = seedBusinessProfile(db, 'wal');
      const shop = db.prepare('SELECT shop_incarnation, credential_revision FROM shops WHERE id = ?').get(shopId);
      db.prepare(`
        INSERT INTO shop_bootstrap_runs (
          run_id, profile_id, shop_id, shop_incarnation, credential_revision,
          reason, status, required_domains_json, completed_domains_json,
          source_gaps_json, proof_hash, created_at, updated_at, completed_at
        ) VALUES ('bootstrap-wal', 'default', ?, ?, ?, 'initial_bind', 'completed',
          '["products"]', '["products"]', '[]', ?, ?, ?, ?)
      `).run(shopId, shop.shop_incarnation, shop.credential_revision, sha256('bootstrap-wal'), FIXTURE_TIME, FIXTURE_TIME, FIXTURE_TIME);
      db.prepare(`
        INSERT INTO product_sync_runs (
          id, shop_id, shop_incarnation, credential_revision, mode, visibility,
          request_fingerprint, status, contract_hash, mapper_version,
          activated_snapshot_id, expected_count, actual_count,
          staged_batch_count, source_gap_count, proof_json, proof_hash,
          created_at, updated_at, finished_at
        ) VALUES ('product-run-wal', ?, ?, ?, 'full', 'ALL', ?, 'completed', ?,
          'acceptance-mapper-v1', 'product-snapshot-wal', 1, 1, 1, 0, '{}', ?, ?, ?, ?)
      `).run(
        shopId,
        shop.shop_incarnation,
        shop.credential_revision,
        sha256('request-wal'),
        sha256('contract-wal'),
        sha256('proof-wal'),
        FIXTURE_TIME,
        FIXTURE_TIME,
        FIXTURE_TIME,
      );
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }

    const sourceUserVersion = db.prepare('PRAGMA user_version;').get().user_version;
    assert.equal(readdirSync(root).some((name) => name.endsWith('-wal')), true);
    copyFileSync(filePath, rawCopyPath);
    const rawCopy = new DatabaseSync(rawCopyPath, { readOnly: true });
    try {
      assert.equal(rawCopy.prepare('PRAGMA user_version;').get().user_version, sourceUserVersion);
      assert.equal(rawCopy.prepare("SELECT COUNT(*) AS count FROM shops WHERE id = 'shop-wal'").get().count, 0);
    } finally {
      rawCopy.close();
    }

    snapshot = createRecoverySqliteSnapshot({
      db,
      snapshotRoot: root,
      createId: () => 'active-wal-proof',
    });
    assert.deepEqual(
      {
        method: snapshot.evidence.method,
        quickCheck: snapshot.evidence.quickCheck,
        foreignKeyViolations: snapshot.evidence.foreignKeyViolations,
        userVersion: snapshot.evidence.userVersion,
        readOnly: snapshot.evidence.readOnly,
      },
      {
        method: 'vacuum-into',
        quickCheck: 'ok',
        foreignKeyViolations: 0,
        userVersion: sourceUserVersion,
        readOnly: true,
      },
    );
    assert.equal(snapshot.db.prepare("SELECT COUNT(*) AS count FROM shops WHERE id = 'shop-wal'").get().count, 1);
    assert.equal(snapshot.db.prepare("SELECT COUNT(*) AS count FROM shop_bootstrap_runs WHERE run_id = 'bootstrap-wal'").get().count, 1);
    assert.equal(snapshot.db.prepare("SELECT COUNT(*) AS count FROM shared_catalog_versions WHERE catalog_id = 'catalog-wal'").get().count, 1);
    assert.equal(snapshot.db.prepare("SELECT COUNT(*) AS count FROM product_sync_runs WHERE id = 'product-run-wal'").get().count, 1);
    assert.equal(snapshot.db.prepare("SELECT COUNT(*) AS count FROM product_commission_facts WHERE product_identity_id = 'identity-wal'").get().count, 1);
    assert.equal(snapshot.db.prepare("SELECT COUNT(*) AS count FROM purchase_completion_history WHERE source_receipt_id = 'receipt-wal'").get().count, 1);
    assert.equal(snapshot.db.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations
      WHERE CAST(substr(version, 1, 3) AS INTEGER) BETWEEN 58 AND 70
    `).get().count, 13);
    assert.equal(snapshot.db.prepare('SELECT COUNT(*) AS count FROM data_backup_exports').get().count, 0);
    assert.throws(
      () => snapshot.db.prepare("UPDATE shops SET name = 'forbidden' WHERE id = 'shop-wal'").run(),
      /readonly|read-only|query_only/iu,
    );
    assertHealthy(snapshot.db);
  } finally {
    if (snapshot) snapshot.dispose();
    if (pinnedReader) {
      try { pinnedReader.exec('ROLLBACK;'); } catch { /* already closed */ }
      pinnedReader.close();
    }
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('migration 063 repairs legacy zero/absent commission provenance instead of manufacturing a 0% fact', () => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-migration-063-provenance-'));
  const profile = openMigratedProfileThrough(root, 'migration-062.sqlite', 62);
  try {
    const shopId = insertShop(profile.db, 'legacy-provenance');
    profile.db.prepare(`
      INSERT INTO ozon_products (
        id, shop_id, product_key, offer_id, sku, price_json,
        commission_provenance_json, remote_hash, last_seen_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-product-row',
      shopId,
      'legacy-product-key',
      'legacy-offer',
      'legacy-sku',
      JSON.stringify({ commissions: { sales_percent_fbo: 0 } }),
      JSON.stringify({
        contractVersion: 'products.prices:v5',
        mapperVersion: 'prices-mapper-v5',
        responseHash: sha256('legacy-price-response'),
        observedAt: FIXTURE_TIME,
      }),
      sha256('legacy-product-row'),
      FIXTURE_TIME,
      FIXTURE_TIME,
      FIXTURE_TIME,
    );
    profile.db.prepare(`
      INSERT INTO product_identities (
        product_identity_id, shop_id, product_id, offer_id, sku,
        mapper_version, response_hash, observed_at, row_hash,
        created_at, updated_at
      ) VALUES ('legacy-product-row', ?, 'legacy-product-id', 'legacy-offer',
        'legacy-sku', 'legacy-product-identity-v1', ?, ?, ?, ?, ?)
    `).run(
      shopId,
      sha256('legacy-product-row'),
      FIXTURE_TIME,
      sha256('legacy-identity-row'),
      FIXTURE_TIME,
      FIXTURE_TIME,
    );
    for (const fulfillmentType of ['FBO', 'FBS']) {
      profile.db.prepare(`
        INSERT INTO product_commission_facts (
          product_identity_id, shop_id, fulfillment_type, rate_ppm, status,
          mapper_version, response_hash, observed_at, source_reason,
          row_hash, updated_at
        ) VALUES ('legacy-product-row', ?, ?, NULL, 'unavailable',
          'legacy-product-commission-v1', ?, ?, 'legacy-normalized-backfill', ?, ?)
      `).run(
        shopId,
        fulfillmentType,
        sha256('legacy-price-response'),
        FIXTURE_TIME,
        sha256(`legacy-commission-${fulfillmentType}`),
        FIXTURE_TIME,
      );
    }

    const migration063 = listMigrationFiles().find((migration) => migration.version.startsWith('063_'));
    profile.db.exec(readFileSync(migration063.path, 'utf8').replace(/^\uFEFF/u, ''));
    const commissions = profile.db.prepare(`
      SELECT fulfillment_type, rate_ppm, status, contract_version,
             mapper_version, source_reason
      FROM product_commission_facts
      WHERE product_identity_id = 'legacy-product-row'
      ORDER BY fulfillment_type
    `).all().map((row) => ({ ...row }));
    assert.deepEqual(commissions, [
      {
        fulfillment_type: 'FBO',
        rate_ppm: null,
        status: 'unavailable',
        contract_version: 'products.prices:v5',
        mapper_version: 'prices-mapper-v5',
        source_reason: 'legacy-ozon-zero-sentinel',
      },
      {
        fulfillment_type: 'FBS',
        rate_ppm: null,
        status: 'not_returned',
        contract_version: 'products.prices:v5',
        mapper_version: 'prices-mapper-v5',
        source_reason: 'ozon-contract-field-not-returned',
      },
    ]);
    assert.deepEqual(
      { ...profile.db.prepare(`
        SELECT status, source_reason FROM product_facet_observations
        WHERE product_identity_id = 'legacy-product-row' AND facet = 'commissions'
      `).get() },
      { status: 'unavailable', source_reason: 'legacy-ozon-zero-sentinel' },
    );
    assert.equal(profile.db.prepare('PRAGMA user_version;').get().user_version, 63);
    assertHealthy(profile.db);
  } finally {
    profile.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('formal recovery publication keeps profile-core and shop chunks on one physical snapshot during a concurrent source commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-recovery-publication-'));
  const { db, filePath } = openMigratedProfile(root, 'source.sqlite');
  const writer = new DatabaseSync(filePath);
  writer.exec('PRAGMA foreign_keys = ON;');
  writer.prepare('PRAGMA journal_mode = WAL;').get();
  try {
    const shopId = insertShop(db, 'concurrent');
    insertShop(db, 'concurrent-other');
    const keysetStore = createRecoveryKeysetStore({
      db,
      ...secretCodec,
      randomUuid: () => '00000000-0000-4000-8000-000000000063',
    });
    const transports = [];
    let generationSequence = 0;
    let concurrentCommitDone = false;
    let markFirstUploadStarted;
    let releaseFirstUpload;
    const firstUploadStarted = new Promise((resolve) => { markFirstUploadStarted = resolve; });
    const firstUploadGate = new Promise((resolve) => { releaseFirstUpload = resolve; });
    const orchestrator = createRecoveryBackupOrchestrator({
      db,
      keysetStore,
      decryptShopSecret(value) {
        if (!concurrentCommitDone) {
          concurrentCommitDone = true;
          writer.prepare(`
            INSERT INTO purchase_order_overrides (
              shop_id, order_key, source_cost_cny, created_at, updated_at
            ) VALUES (?, 'concurrent-order', 19.99, ?, ?)
          `).run(shopId, FIXTURE_TIME, FIXTURE_TIME);
        }
        return String(value).replace(/^source:/u, '');
      },
      createGenerationId: () => `generation-concurrent-${++generationSequence}`,
      now: () => new Date(FIXTURE_TIME),
    });
    const remoteClient = {
      async uploadGeneration({ transport }) {
        transports.push(transport);
        if (transports.length === 1) {
          markFirstUploadStarted();
          await firstUploadGate;
        }
        return { generation_id: `remote-${transports.length}` };
      },
    };

    const firstPromise = orchestrator.uploadAllShops({
      passphrase: RECOVERY_PASSPHRASE,
      remoteClient,
    });
    await firstUploadStarted;
    assert.equal(generationSequence, 1, 'the second shop transport must not be built while the first is uploading');
    assert.equal(transports.length, 1, 'peak retained shop publications must be bounded to one');
    releaseFirstUpload();
    const first = await firstPromise;
    assert.equal(concurrentCommitDone, true);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM purchase_order_overrides
      WHERE shop_id = ? AND order_key = 'concurrent-order'
    `).get(shopId).count, 1);
    assert.equal(first.snapshot.method, 'vacuum-into');
    assert.equal(first.snapshot.quickCheck, 'ok');
    assert.equal(first.shops.length, 2);
    const { keyset, recoveryAad } = keysetStore.readState();
    const openedBatch = transports.map((transport) => openRecoveryGeneration({
      transport,
      encryptionKey: keyset.chunkEncryptionKey,
      aad: recoveryAad,
    }));
    const openedFirst = openedBatch.find((entry) => entry.shopCandidate.shopId === shopId);
    assert.equal(
      openedFirst.shopCandidate.domains.some((domain) => domain.domain === 'purchase-overrides'),
      false,
      'a commit made after VACUUM INTO must not leak into only the shop half of the generation',
    );
    assert.deepEqual(
      openedBatch[0].profileCandidate.domains.map((domain) => [domain.domain, domain.recordsRootHash]),
      openedBatch[1].profileCandidate.domains.map((domain) => [domain.domain, domain.recordsRootHash]),
      'uploadAllShops must publish every shop with exactly one profile-core snapshot version',
    );

    await orchestrator.uploadShop({ shopId, remoteClient });
    const openedSecond = openRecoveryGeneration({
      transport: transports[2],
      encryptionKey: keyset.chunkEncryptionKey,
      aad: recoveryAad,
    });
    assert.equal(
      openedSecond.shopCandidate.domains.find((domain) => domain.domain === 'purchase-overrides')?.recordCount,
      1,
      'the next physical snapshot must see the committed row',
    );
    assert.equal(
      readdirSync(join(root, 'restore-staging')).length,
      0,
      'snapshot database and its private directory must be removed before upload returns',
    );
  } finally {
    writer.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('snapshot creation falls back to a separate SQLite read handle when the active handle is already transactional', () => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-recovery-snapshot-fallback-'));
  const profile = openMigratedProfile(root, 'source.sqlite');
  let snapshot = null;
  try {
    insertShop(profile.db, 'committed');
    profile.db.exec('BEGIN IMMEDIATE;');
    insertShop(profile.db, 'uncommitted');
    snapshot = createRecoverySqliteSnapshot({
      db: profile.db,
      snapshotRoot: root,
      createId: () => 'transaction-fallback',
    });
    assert.equal(snapshot.evidence.vacuumSource, 'separate-read-handle');
    assert.equal(snapshot.evidence.quickCheck, 'ok');
    assert.equal(snapshot.db.prepare("SELECT COUNT(*) AS count FROM shops WHERE id = 'shop-committed'").get().count, 1);
    assert.equal(snapshot.db.prepare("SELECT COUNT(*) AS count FROM shops WHERE id = 'shop-uncommitted'").get().count, 0);
  } finally {
    if (snapshot) snapshot.dispose();
    try { profile.db.exec('ROLLBACK;'); } catch { /* transaction already ended */ }
    profile.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('snapshot integrity failure removes the partial database family and private directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-recovery-snapshot-cleanup-'));
  const profile = openMigratedProfile(root, 'source.sqlite');
  try {
    profile.db.exec('PRAGMA foreign_keys = OFF;');
    insertPurchaseHistory(profile.db, { label: 'orphan', shopId: 'missing-shop' });
    profile.db.exec('PRAGMA foreign_keys = ON;');
    assert.throws(
      () => createRecoverySqliteSnapshot({
        db: profile.db,
        snapshotRoot: root,
        createId: () => 'failed-integrity-cleanup',
      }),
      /RECOVERY_SNAPSHOT_FOREIGN_KEY_CHECK_FAILED/u,
    );
    assert.equal(
      readdirSync(root).some((name) => name.startsWith('recovery-export-failed-integrity-cleanup-')),
      false,
    );
  } finally {
    profile.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an interrupted recovery snapshot uses the registered restore-staging family seen by permanent-delete protection', () => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-recovery-snapshot-registry-'));
  const profile = openMigratedProfile(root, 'source.sqlite');
  let snapshot = null;
  try {
    insertShop(profile.db, 'registered-snapshot');
    snapshot = createRecoverySqliteSnapshot({ db: profile.db });
    const families = discoverAccountRemovalProtectionFamilies(profile.filePath);
    assert.equal(families.length, 1);
    assert.equal(families[0].kind, 'staging');
    assert.equal(families[0].databasePath.endsWith(join('', 'restore.sqlite')), true);
    snapshot.dispose();
    snapshot = null;
    assert.deepEqual(discoverAccountRemovalProtectionFamilies(profile.filePath), []);
  } finally {
    if (snapshot) snapshot.dispose();
    profile.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a generation from Profile A restores into a genuinely empty new Profile without reading or overwriting Profile B', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-new-profile-recovery-'));
  const profileA = openMigratedProfile(root, 'profile-a.sqlite');
  const profileB = openMigratedProfile(root, 'profile-b.sqlite');
  const staging = openMigratedProfile(root, 'new-computer-staging.sqlite');
  const targetKeyset = openMigratedProfile(root, 'new-computer-keyset.sqlite');
  try {
    const sharedShopId = 'shop-same-external-slot';
    seedBusinessProfile(profileA.db, 'A', { shopId: sharedShopId });
    seedBusinessProfile(profileB.db, 'B', { shopId: sharedShopId });
    assert.equal(staging.db.prepare('SELECT COUNT(*) AS count FROM shops').get().count, 0);
    assert.equal(staging.db.prepare('SELECT COUNT(*) AS count FROM purchase_accounts').get().count, 0);

    const sourceStore = createRecoveryKeysetStore({
      db: profileA.db,
      ...secretCodec,
      randomUuid: () => '00000000-0000-4000-8000-0000000000a1',
    });
    let transport = null;
    const backup = createRecoveryBackupOrchestrator({
      db: profileA.db,
      keysetStore: sourceStore,
      decryptShopSecret: (value) => String(value).replace(/^source:/u, ''),
      createGenerationId: () => 'generation-profile-a-new-computer',
      now: () => new Date(FIXTURE_TIME),
    });
    await backup.uploadShop({
      shopId: sharedShopId,
      passphrase: RECOVERY_PASSPHRASE,
      remoteClient: {
        async uploadGeneration(input) {
          transport = input.transport;
          return { generation_id: 'remote-profile-a' };
        },
      },
    });

    const restore = createRecoveryRestoreOrchestrator({
      keysetStore: createRecoveryKeysetStore({ db: targetKeyset.db, ...secretCodec }),
      encryptShopSecret: (value) => `target:${value}`,
    });
    const restored = await restore.stageRemoteGeneration({
      remoteClient: { downloadGeneration: async () => transport },
      generationId: 'remote-profile-a',
      passphrase: RECOVERY_PASSPHRASE,
      stagingDb: staging.db,
    });

    assert.equal(restored.mode, 'staging-only');
    assert.equal(staging.db.prepare('SELECT COUNT(*) AS count FROM shops').get().count, 1);
    assert.deepEqual(
      { ...staging.db.prepare('SELECT id, name, client_id, api_key_encrypted FROM shops').get() },
      {
        id: sharedShopId,
        name: 'Profile A shop',
        client_id: 'client-A',
        api_key_encrypted: 'target:api-key-A',
      },
    );
    assert.deepEqual(
      { ...staging.db.prepare('SELECT id, name, login_password_encrypted FROM purchase_accounts').get() },
      {
        id: 'purchase-A',
        name: 'Purchase A',
        login_password_encrypted: 'target:purchase-password-A',
      },
    );
    assert.deepEqual(
      { ...staging.db.prepare('SELECT id, name, user_name_encrypted, password_encrypted FROM cross_border_accounts').get() },
      {
        id: 'bus-A',
        name: 'Cross-border A',
        user_name_encrypted: 'target:bus-user-A',
        password_encrypted: 'target:bus-password-A',
      },
    );
    assert.equal(staging.db.prepare(`
      SELECT COUNT(*) AS count FROM cross_border_order_records
      WHERE shop_id = ? AND record_key = 'record-A'
    `).get(sharedShopId).count, 1);
    assert.equal(staging.db.prepare(`
      SELECT COUNT(*) AS count FROM purchase_completion_history
      WHERE shop_id = ? AND source_receipt_id = 'receipt-A'
    `).get(sharedShopId).count, 1);
    assert.equal(staging.db.prepare(`
      SELECT rate_ppm FROM product_commission_facts
      WHERE shop_id = ? AND product_identity_id = 'identity-A' AND fulfillment_type = 'FBO'
    `).get(sharedShopId).rate_ppm, 150000);
    assert.equal(staging.db.prepare('SELECT COUNT(*) AS count FROM shared_catalog_versions').get().count, 0);
    assert.equal(profileB.db.prepare('SELECT name FROM shops WHERE id = ?').get(sharedShopId).name, 'Profile B shop');
    assert.equal(profileB.db.prepare("SELECT COUNT(*) AS count FROM purchase_accounts WHERE id = 'purchase-B'").get().count, 1);
    assert.equal(staging.db.prepare("SELECT COUNT(*) AS count FROM purchase_accounts WHERE id = 'purchase-B'").get().count, 0);
    assert.equal(
      staging.db.prepare('PRAGMA user_version;').get().user_version,
      profileA.db.prepare('PRAGMA user_version;').get().user_version,
    );
    assertHealthy(staging.db);
  } finally {
    profileA.db.close();
    profileB.db.close();
    staging.db.close();
    targetKeyset.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('deleting purchase/cross-border credentials preserves shop history; deleting only that Ozon shop removes it and keeps shared/profile data', () => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-account-removal-history-'));
  const profile = openMigratedProfile(root, 'profile.sqlite');
  try {
    const shopA = seedBusinessProfile(profile.db, 'delete-A');
    const shopB = seedBusinessProfile(profile.db, 'keep-B');
    const executor = createAccountRemovalSqliteExecutor({
      db: profile.db,
      now: () => FIXTURE_TIME,
    });

    executor.execute({ ownerType: 'purchase_account', ownerId: 'purchase-delete-A' });
    assert.equal(profile.db.prepare("SELECT COUNT(*) AS count FROM purchase_accounts WHERE id = 'purchase-delete-A'").get().count, 0);
    assert.equal(profile.db.prepare("SELECT COUNT(*) AS count FROM purchase_completion_history WHERE source_receipt_id = 'receipt-delete-A'").get().count, 1);

    executor.execute({ ownerType: 'cross_border_bus', ownerId: 'bus-delete-A' });
    assert.equal(profile.db.prepare("SELECT COUNT(*) AS count FROM cross_border_accounts WHERE id = 'bus-delete-A'").get().count, 0);
    assert.equal(profile.db.prepare("SELECT COUNT(*) AS count FROM cross_border_order_records WHERE record_key = 'record-delete-A'").get().count, 1);

    const deleted = executor.execute(
      { ownerType: 'ozon_shop', ownerId: shopA },
      { operationId: 'permanent-delete-acceptance-A' },
    );
    assert.equal(deleted.preservationVerified, true);
    assert.equal(deleted.physicalStorage.secureDelete, true);
    assert.equal(profile.db.prepare('SELECT COUNT(*) AS count FROM shops WHERE id = ?').get(shopA).count, 0);
    assert.equal(profile.db.prepare('SELECT COUNT(*) AS count FROM shops WHERE id = ?').get(shopB).count, 1);
    assert.equal(profile.db.prepare("SELECT COUNT(*) AS count FROM purchase_completion_history WHERE source_receipt_id = 'receipt-delete-A'").get().count, 0);
    assert.equal(profile.db.prepare("SELECT COUNT(*) AS count FROM cross_border_order_records WHERE record_key = 'record-delete-A'").get().count, 0);
    assert.equal(profile.db.prepare("SELECT COUNT(*) AS count FROM product_commission_facts WHERE product_identity_id = 'identity-delete-A'").get().count, 0);
    assert.equal(profile.db.prepare("SELECT COUNT(*) AS count FROM purchase_completion_history WHERE source_receipt_id = 'receipt-keep-B'").get().count, 1);
    assert.equal(profile.db.prepare("SELECT COUNT(*) AS count FROM cross_border_order_records WHERE record_key = 'record-keep-B'").get().count, 1);
    assert.equal(profile.db.prepare("SELECT COUNT(*) AS count FROM product_commission_facts WHERE product_identity_id = 'identity-keep-B'").get().count, 1);
    assert.equal(profile.db.prepare('SELECT COUNT(*) AS count FROM shared_catalog_versions').get().count, 2);
    assert.equal(profile.db.prepare(`
      SELECT COUNT(*) AS count FROM shop_identity_tombstones
      WHERE deletion_operation_id = 'permanent-delete-acceptance-A'
    `).get().count, 1);
    assertHealthy(profile.db);
  } finally {
    profile.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
