import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { createShopRepository } from '../db/repositories/shopRepository.js';
import { createExternalOzonIdentityHash } from '../db/repositories/shopIdentityRepository.js';
import { createProductRepository } from '../db/repositories/productRepository.js';
import { createShopDatabaseManager } from '../db/shopDatabaseManager.js';
import { createShopDatabaseRouter } from '../db/shopDatabaseRouter.js';
import { createShopProductStorage, shopProductStorageInternals } from '../db/shopProductStorage.js';
import { createShopProductRepositoryRouter } from '../db/shopProductRepositoryRouter.js';
import { createRecoveryStorageAdapter } from './recoveryStorageAdapter.js';
import { createDataBackupService } from './dataBackupService.js';
import { createDataBackupImportService } from './dataBackupImportService.js';
import { createRecoveryBackupPlanner } from './recoveryBackupPlanner.js';
import { openDataBackupPackage } from './dataBackupPackage.js';
import { createRecoveryKeysetStore } from './recoveryKeysetStore.js';
import { createRecoveryBackupOrchestrator } from './recoveryBackupOrchestrator.js';
import { createRecoveryRestoreOrchestrator } from './recoveryRestoreOrchestrator.js';
import { createRecoveryStagingService } from './recoveryStagingService.js';
import { createRecoveryExporter } from './recoveryExporter.js';
import { decryptRecoveryChunk } from './recoveryChunkCodec.js';

const now = '2026-09-05T00:00:00.000Z';
const profileId = '0af852b5-124b-4421-9608-7b232c07afe9';
const shopId = 'synthetic-storage-shop';
const clientId = 'SYNTHETIC_STORAGE_CLIENT';
const encrypt = (value) => value ? `fixture:${value}` : null;
const decrypt = (value) => String(value || '').replace(/^fixture:/u, '');
const commitCapability = Buffer.alloc(32, 29).toString('base64url');
const productTables = new Set(shopProductStorageInternals.PRODUCT_TABLES);

function fixture(t, { direct = true, wal = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-authoritative-backup-test-'));
  const db = createMigratedTestDb(join(root, 'central.sqlite'));
  if (wal) db.exec('PRAGMA journal_mode = WAL');
  db.prepare(`INSERT INTO shops (
    id, name, client_id, api_key_encrypted, status, profile_id,
    external_identity_hash, shop_incarnation, credential_revision, bound_at, created_at, updated_at
  ) VALUES (?, 'Synthetic storage shop', ?, ?, 'active', ?, ?, ?, 1, ?, ?, ?)`)
    .run(shopId, clientId, encrypt('SYNTHETIC_KEY'), profileId,
      createExternalOzonIdentityHash(clientId), `fixture-${direct ? 'direct' : 'legacy'}`, now, now, now);
  const shops = createShopRepository(db, { profileId });
  const manager = createShopDatabaseManager({ root: join(root, 'shops'), profileId, enableWal: wal });
  const databaseRouter = createShopDatabaseRouter({ shopRepository: shops, shopDatabaseManager: manager });
  const storage = createShopProductStorage({
    canonicalDb: db, shopDatabaseRouter: databaseRouter,
    directWriteShopIds: direct ? [shopId] : [],
  });
  const canonical = createProductRepository(db);
  const products = createShopProductRepositoryRouter({ canonicalDb: db, canonicalRepository: canonical,
    shopProductStorage: storage, listShopIds: () => [shopId] });
  if (direct) storage.initializeDirectShop({ shopId });
  const authoritativeDb = direct ? databaseRouter.open(shopId).db : db;
  const adapter = createRecoveryStorageAdapter({ db, resolveShopDomainDatabase({ shopId: id, policy }) {
    return direct && productTables.has(policy.canonicalTable)
      ? storage.resolveDirectWriteSession({ shopId: id }) : { db };
  } });
  const backup = createDataBackupService({ db, storageAdapter: adapter, decryptShopSecret: decrypt });
  const importer = createDataBackupImportService({ db, storageAdapter: adapter,
    dataBackupService: backup, profileId, encryptShopSecret: encrypt, decryptShopSecret: decrypt });
  t.after(() => {
    products.closeProductReadConnections();
    manager.closeAll();
    db.close();
    // root is an exclusively-created test directory; never a runtime profile.
    rmSync(root, { recursive: true, force: true });
  });
  function writeUserFacts(suffix = 'source') {
    products.upsertProducts({ shopId, rows: [{ product_id: 'fixture-product', offer_id: 'fixture-offer',
      sku: 'fixture-sku', name: 'Synthetic product', visibility: 'IN_SALE', price: 100,
      stocks: [], images: [], attributes: [] }] });
    products.upsertProductSourceLinks({ shopId, productId: 'fixture-product', links: [{
      platform: '1688', url: `https://example.invalid/${suffix}`, title: suffix,
    }] });
    products.upsertProductMaterialProfile({ shopId, productId: 'fixture-product', weight: '2', source: 'user' });
  }
  function exportPackage() {
    return backup.prepareExport({ shopId, commitCapability,
      expectedDataFingerprint: backup.previewShop(shopId).shops[0].dataFingerprint });
  }
  return { root, db, authoritativeDb, shops, storage, products, adapter, backup, importer, writeUserFacts, exportPackage };
}

function decodedDomain(opened, domain) {
  const manifest = opened.shopCandidate.domains.find((item) => item.domain === domain);
  assert.ok(manifest, `missing ${domain}`);
  return decryptRecoveryChunk({ encrypted: opened.shopCandidate.chunks.find((chunk) => chunk.chunkId === manifest.chunkId),
    encryptionKey: opened.keyset.chunkEncryptionKey, aad: opened.aad }).records;
}

test('direct-shop portable backup, planner and freshness fingerprint all include authoritative user facts', (t) => {
  const f = fixture(t);
  const before = f.backup.previewShop(shopId).shops[0];
  f.writeUserFacts();
  f.products.upsertProductMaterialProfile({ shopId, productId: 'fixture-product', weight: '3', source: 'ozon' });
  const after = f.backup.previewShop(shopId).shops[0];
  assert.notEqual(before.dataFingerprint, after.dataFingerprint);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM product_source_links').get().n, 0);
  for (const domain of ['product-source-links', 'product-material-profiles']) {
    const expected = domain === 'product-material-profiles' ? 2 : 1;
    assert.equal(after.domains.find((item) => item.domain === domain)?.recordCount, expected);
    const plan = createRecoveryBackupPlanner({ db: f.db, storageAdapter: f.adapter }).previewShop(shopId);
    assert.equal(plan.domains.find((item) => item.domain === domain)?.recordCount, expected);
  }
  assert.throws(() => f.backup.prepareExport({ shopId, commitCapability, expectedDataFingerprint: before.dataFingerprint }), /DATA_BACKUP_PREVIEW_STALE/);
  const prepared = f.exportPackage();
  const opened = openDataBackupPackage({ bytes: Buffer.from(prepared.contentB64u, 'base64url') });
  assert.equal(decodedDomain(opened, 'product-source-links')[0].value.url, 'https://example.invalid/source');
  assert.equal(decodedDomain(opened, 'product-material-profiles').length, 2);
  assert.equal(opened.dataFingerprint, after.dataFingerprint);
});

test('every authoritative source stays immutable after backup snapshots have been collected', (t) => {
  const f = fixture(t);
  f.writeUserFacts('snapshot-before');
  const encryptionKey = randomBytes(32);
  f.adapter.withSnapshot({ shopIds: [shopId] }, (snapshotDb, evidence) => {
    assert.equal(evidence.databaseCount, 2);
    f.writeUserFacts('snapshot-after');
    const candidate = createRecoveryExporter({ db: snapshotDb, resolveDomainDatabase: f.adapter.resolveDatabase })
      .buildShopCandidate({ shopId, encryptionKey, dedupeKey: randomBytes(32), aad: 'fixture', mode: 'core-only' });
    const manifest = candidate.domains.find((row) => row.domain === 'product-source-links');
    const records = decryptRecoveryChunk({ encrypted: candidate.chunks.find((chunk) => chunk.chunkId === manifest.chunkId),
      encryptionKey, aad: 'fixture' }).records;
    assert.equal(records[0].value.url, 'https://example.invalid/snapshot-before');
  });
});

for (const directSource of [false, true]) {
  for (const directTarget of [false, true]) {
    test(`${directSource ? 'September direct' : 'July canonical'} package restores to ${directTarget ? 'direct shop' : 'legacy single database'} authority`, (t) => {
      const source = fixture(t, { direct: directSource });
      const target = fixture(t, { direct: directTarget });
      source.writeUserFacts('restored');
      const prepared = source.exportPackage();
      const input = { contentB64u: prepared.contentB64u, targetShopId: shopId, strategy: 'overwrite' };
      const preview = target.importer.preflight(input);
      assert.equal(preview.restoreSafety.writeAllowed, true);
      const restored = target.importer.confirm({ ...input, preflightFingerprint: preview.preflightFingerprint });
      assert.equal(restored.verified, true);
      assert.equal(restored.restored, true);
      assert.equal(target.authoritativeDb.prepare('SELECT COUNT(*) AS n FROM product_source_links').get().n, 1);
      assert.ok(JSON.stringify(target.products.listProductSourceLinks({ shopId })).includes('https://example.invalid/restored'));
      if (directTarget) {
        assert.equal(target.db.prepare('SELECT COUNT(*) AS n FROM product_source_links').get().n, 0);
        assert.equal(target.authoritativeDb.prepare('SELECT direct_write_revision AS n FROM shop_product_storage_state').get().n, 1);
      }
      assert.equal(target.db.prepare('PRAGMA database_list').all().filter((row) => row.name.startsWith('recovery_import_')).length, 0, 'all recovery attachment handles released');
    });
  }
}

test('a late central audit failure rolls back direct-shop facts and direct revision in the same attached transaction', (t) => {
  const source = fixture(t, { direct: false });
  const target = fixture(t);
  source.writeUserFacts('must-rollback');
  const prepared = source.exportPackage();
  const before = target.backup.previewShop(shopId).shops[0].dataFingerprint;
  const input = { contentB64u: prepared.contentB64u, targetShopId: shopId, strategy: 'overwrite' };
  const preview = target.importer.preflight(input);
  target.db.exec("CREATE TRIGGER fixture_reject_import BEFORE INSERT ON data_backup_imports BEGIN SELECT RAISE(ABORT, 'FIXTURE_AUDIT_FAILURE'); END");
  assert.throws(() => target.importer.confirm({ ...input, preflightFingerprint: preview.preflightFingerprint }), /FIXTURE_AUDIT_FAILURE/);
  assert.equal(target.authoritativeDb.prepare('SELECT COUNT(*) AS n FROM product_source_links').get().n, 0);
  assert.equal(target.authoritativeDb.prepare('SELECT COUNT(*) AS n FROM product_material_profiles').get().n, 0);
  assert.equal(target.authoritativeDb.prepare('SELECT direct_write_revision AS n FROM shop_product_storage_state').get().n, 0);
  assert.equal(target.db.prepare('SELECT COUNT(*) AS n FROM data_backup_imports').get().n, 0);
  assert.equal(target.backup.previewShop(shopId).shops[0].dataFingerprint, before);
  assert.equal(target.db.prepare('PRAGMA database_list').all().filter((row) => row.name.startsWith('recovery_import_')).length, 0);
});

test('online multi-WAL import is explicitly refused before writing, not falsely presented as crash-atomic', (t) => {
  const source = fixture(t, { direct: false });
  const target = fixture(t, { wal: true });
  source.writeUserFacts('must-not-write');
  const prepared = source.exportPackage();
  const input = { contentB64u: prepared.contentB64u, targetShopId: shopId, strategy: 'overwrite' };
  const preview = target.importer.preflight(input);
  assert.deepEqual(preview.restoreSafety, { writeAllowed: false, atomicity: 'safe-offline-restore-required', errorCode: 'DATA_BACKUP_IMPORT_SAFE_RESTORE_REQUIRED' });
  assert.throws(() => target.importer.confirm({ ...input, preflightFingerprint: preview.preflightFingerprint }), { code: 'DATA_BACKUP_IMPORT_SAFE_RESTORE_REQUIRED' });
  assert.equal(target.authoritativeDb.prepare('SELECT COUNT(*) AS n FROM product_source_links').get().n, 0);
  assert.equal(target.db.prepare('SELECT COUNT(*) AS n FROM data_backup_imports').get().n, 0);
  assert.equal(target.db.prepare('PRAGMA database_list').all().filter((row) => row.name.startsWith('recovery_import_')).length, 0);
});

test('direct recovery generation restores user facts into the explicit desktop profile, never the default profile', async (t) => {
  const f = fixture(t);
  f.writeUserFacts('cloud-roundtrip');
  const keysetStore = createRecoveryKeysetStore({ db: f.db, encrypt, decrypt });
  let transport;
  await createRecoveryBackupOrchestrator({ db: f.db, storageAdapter: f.adapter, keysetStore, decryptShopSecret: decrypt }).uploadShop({
    shopId, passphrase: 'synthetic recovery passphrase',
    remoteClient: { async uploadGeneration(input) { transport = input.transport; return { generation_id: 'fixture-generation' }; } },
  });
  const stagedDb = createMigratedTestDb();
  t.after(() => stagedDb.close());
  const result = await createRecoveryRestoreOrchestrator({ keysetStore: { saveState() {} }, encryptShopSecret: encrypt,
    targetProfileId: profileId }).stageRemoteGeneration({
    remoteClient: { async downloadGeneration() { return transport; } }, generationId: 'fixture-generation',
    passphrase: 'synthetic recovery passphrase', stagingDb: stagedDb,
  });
  assert.equal(result.ok, true);
  assert.equal(stagedDb.prepare('SELECT profile_id FROM shops').get().profile_id, profileId);
  assert.equal(createShopRepository(stagedDb, { profileId }).listShops().length, 1);
  assert.equal(stagedDb.prepare('SELECT url FROM product_source_links').get().url, 'https://example.invalid/cloud-roundtrip');
  // Exercise the production config -> staging -> orchestrator injection too.
  // This test-only override prevents the default keyset store from opening a
  // developer or desktop secret file. No real remote client is constructed.
  const priorSecret = process.env.LOCAL_API_SECRET;
  process.env.LOCAL_API_SECRET = 'synthetic-staging-secret-never-a-runtime-key';
  try {
    const staged = await createRecoveryStagingService({
      config: { runtime: { profileId }, database: { path: join(f.root, 'active-placeholder.sqlite'), enableWal: true } },
      encryptShopSecret: encrypt,
    }).stageRemoteGeneration({
      remoteClient: { async downloadGeneration() { return transport; } }, generationId: 'fixture-generation',
      passphrase: 'synthetic recovery passphrase',
    });
    const readback = new DatabaseSync(staged.stagingDatabasePath, { readOnly: true });
    try {
      assert.equal(readback.prepare('SELECT profile_id FROM shops').get().profile_id, profileId);
      assert.equal(readback.prepare('SELECT url FROM product_source_links').get().url, 'https://example.invalid/cloud-roundtrip');
    } finally { readback.close(); }
  } finally {
    if (priorSecret === undefined) delete process.env.LOCAL_API_SECRET;
    else process.env.LOCAL_API_SECRET = priorSecret;
  }
});

test('a profile-only package remains restorable when the target has unrelated direct WAL facts', (t) => {
  const source = fixture(t, { direct: false });
  const target = fixture(t, { wal: true });
  target.writeUserFacts('keep-existing-direct-facts');
  const before = target.backup.previewShop(shopId).shops[0].dataFingerprint;
  const prepared = source.exportPackage();
  const input = { contentB64u: prepared.contentB64u, targetShopId: shopId, strategy: 'overwrite' };
  const preflight = target.importer.preflight(input);
  assert.equal(preflight.restoreSafety.writeAllowed, true);
  assert.equal(target.importer.confirm({ ...input, preflightFingerprint: preflight.preflightFingerprint }).verified, true);
  assert.equal(target.backup.previewShop(shopId).shops[0].dataFingerprint, before);
  assert.equal(target.authoritativeDb.prepare('SELECT url FROM product_source_links').get().url, 'https://example.invalid/keep-existing-direct-facts');
});

test('unready authoritative shop stores fail closed for previews and exports', (t) => {
  const f = fixture(t);
  f.writeUserFacts();
  f.authoritativeDb.exec("UPDATE shop_product_storage_state SET status = 'failed'");
  assert.throws(() => f.backup.previewShop(shopId), /SHOP_PRODUCT_DIRECT_WRITE_NOT_READY/);
  assert.throws(() => f.backup.prepareExport({ shopId, commitCapability }), /SHOP_PRODUCT_DIRECT_WRITE_NOT_READY/);
  assert.throws(() => createRecoveryBackupPlanner({ db: f.db, storageAdapter: f.adapter }).previewShop(shopId), /SHOP_PRODUCT_DIRECT_WRITE_NOT_READY/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM data_backup_exports').get().n, 0);
});
