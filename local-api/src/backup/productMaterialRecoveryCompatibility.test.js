import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../test/testDb.js';
import { DATA_DOMAIN_REGISTRY, getDataDomain } from '../data/dataDomainRegistry.js';
import { createRecoveryExporter } from './recoveryExporter.js';
import { createRecoveryImporter } from './recoveryImporter.js';
import { decryptRecoveryChunk } from './recoveryChunkCodec.js';
import { createRecoveryProfileCore } from './recoveryProfileCore.js';
import { createRecoveryKeyEnvelope, generateRecoveryKeyset } from './recoveryKeyEnvelope.js';
import { createDataBackupPackage, openDataBackupPackage } from './dataBackupPackage.js';
import { createDataBackupWatermark } from './dataBackupWatermark.js';
import { createDataBackupService } from './dataBackupService.js';
import { createDataBackupImportService } from './dataBackupImportService.js';

const encryptionKey = Buffer.alloc(32, 35);
const dedupeKey = Buffer.alloc(32, 36);
const aad = 'synthetic-multisource-material-compatibility';
const now = '2026-07-11T00:00:00.000Z';
const domain = 'product-material-profiles';

function database(t) {
  const db = createMigratedTestDb();
  for (const shopId of ['shop-a', 'shop-b']) {
    db.prepare('INSERT INTO shops (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(shopId, shopId, 'active', now, now);
  }
  t.after(() => db.close());
  return db;
}

function material(db, { shopId = 'shop-a', source, weight }) {
  db.prepare(`INSERT INTO product_material_profiles (id, shop_id, product_key, source, weight_kg, created_at, updated_at)
    VALUES (?, ?, 'same-product', ?, ?, ?, ?)`)
    .run(`${shopId}-${source}`, shopId, source, weight, now, now);
}

function candidate(db, legacy = false) {
  const registry = legacy ? DATA_DOMAIN_REGISTRY.map((policy) => policy.domain === domain
    ? { ...policy, schemaVersion: 1, primaryKey: policy.legacyPrimaryKeys[1], legacyPrimaryKeys: undefined } : policy) : DATA_DOMAIN_REGISTRY;
  return createRecoveryExporter({ db, registry }).buildShopCandidate({
    shopId: 'shop-a', encryptionKey, dedupeKey, aad, mode: 'core-only', includeDomains: [domain],
  });
}

test('V2 material recovery keys represent all shop/product/source rows without collisions', (t) => {
  const source = database(t);
  const target = database(t);
  material(source, { source: 'ozon', weight: 3 });
  material(source, { source: 'user', weight: 2 });
  const exported = candidate(source);
  assert.equal(getDataDomain(domain).schemaVersion, 2);
  assert.deepEqual(getDataDomain(domain).primaryKey, ['shop_id', 'product_key', 'source']);
  assert.equal(exported.domains[0].recordCount, 2);
  const records = decryptRecoveryChunk({ encrypted: exported.chunks[0], encryptionKey, aad }).records;
  assert.equal(new Set(records.map((row) => row.key)).size, 2);
  assert.ok(records.every((row) => row.key.endsWith(`source:${row.value.source}`)));
  createRecoveryImporter({ db: target }).importShopCandidate({ candidate: exported, encryptionKey, aad });
  assert.deepEqual(target.prepare("SELECT source, weight_kg FROM product_material_profiles WHERE shop_id = 'shop-a' ORDER BY source").all()
    .map((row) => ({ ...row })), [{ source: 'ozon', weight_kg: 3 }, { source: 'user', weight_kg: 2 }]);
});

for (const strategy of ['preserve', 'overwrite']) {
  test(`V1 material package remains compatible with ${strategy} and cannot merge into another source/shop`, (t) => {
    const source = database(t);
    const target = database(t);
    material(source, { source: 'user', weight: 2 });
    material(target, { source: 'ozon', weight: 9 });
    material(target, { source: 'user', weight: 7 });
    material(target, { shopId: 'shop-b', source: 'user', weight: 13 });
    const exported = candidate(source, true);
    assert.equal(exported.domains[0].schemaVersion, 1);
    createRecoveryImporter({ db: target }).importShopCandidate({ candidate: exported, encryptionKey, aad, strategy });
    const read = target.prepare('SELECT weight_kg FROM product_material_profiles WHERE shop_id = ? AND source = ?');
    assert.equal(read.get('shop-a', 'ozon').weight_kg, 9);
    assert.equal(read.get('shop-a', 'user').weight_kg, strategy === 'preserve' ? 7 : 2);
    assert.equal(read.get('shop-b', 'user').weight_kg, 13);
  });
}

test('V1 material package inserts its source alongside an existing different source', (t) => {
  const source = database(t);
  const target = database(t);
  material(source, { source: 'user', weight: 2 });
  material(target, { source: 'ozon', weight: 9 });
  const exported = candidate(source, true);
  const result = createRecoveryImporter({ db: target }).importShopCandidate({ candidate: exported, encryptionKey, aad, strategy: 'overwrite' });
  assert.equal(result.domains[0].inserted, 1);
  assert.equal(target.prepare('SELECT COUNT(*) AS n FROM product_material_profiles').get().n, 2);
});

test('an encrypted legacy .wzb with V1 material records still passes package verification, preflight and confirm', (t) => {
  const source = database(t);
  const target = database(t);
  const encrypt = (value) => `fixture:${value}`;
  const decrypt = (value) => String(value || '').replace(/^fixture:/u, '');
  for (const db of [source, target]) {
    db.prepare("UPDATE shops SET client_id = 'legacy-fixture-client', api_key_encrypted = ? WHERE id = 'shop-a'")
      .run(encrypt('legacy-fixture-key'));
  }
  material(source, { source: 'user', weight: 2 });
  material(target, { source: 'ozon', weight: 9 });
  const owner = { ownerType: 'ozon_shop', ownerId: 'shop-a' };
  const keyset = { ...generateRecoveryKeyset(), chunkEncryptionKey: encryptionKey, dedupeKey };
  const passphrase = 'legacy material package passphrase';
  const profileCandidate = createRecoveryProfileCore({ db: source, decryptShopSecret: decrypt })
    .buildOwnerCandidate({ owner, encryptionKey, dedupeKey, aad });
  const shopCandidate = candidate(source, true);
  const dataWatermark = createDataBackupWatermark({ owner,
    ownerIncarnation: source.prepare("SELECT shop_incarnation FROM shops WHERE id = 'shop-a'").get().shop_incarnation,
    sqliteUserVersion: source.prepare('PRAGMA user_version').get().user_version,
    domains: [...profileCandidate.domains, ...shopCandidate.domains].filter((row) => row.recordCount > 0),
  });
  const packaged = createDataBackupPackage({ owner, profileCandidate, shopCandidate,
    keyEnvelope: createRecoveryKeyEnvelope({ keyset, passphrase, aad }),
    encryptionKey, dedupeKey, aad, backupId: 'synthetic-legacy-material-wzb', createdAt: now, dataWatermark,
  });
  const opened = openDataBackupPackage({ bytes: packaged.bytes, passphrase });
  assert.equal(opened.shopCandidate.domains[0].schemaVersion, 1);
  const importer = createDataBackupImportService({ db: target, profileId: 'default', encryptShopSecret: encrypt,
    decryptShopSecret: decrypt, dataBackupService: createDataBackupService({ db: target, decryptShopSecret: decrypt }) });
  const input = { contentB64u: packaged.bytes.toString('base64url'), passphrase, targetShopId: 'shop-a', strategy: 'overwrite' };
  const preflight = importer.preflight(input);
  assert.equal(importer.confirm({ ...input, preflightFingerprint: preflight.preflightFingerprint }).verified, true);
  assert.deepEqual(target.prepare("SELECT source, weight_kg FROM product_material_profiles WHERE shop_id = 'shop-a' ORDER BY source").all()
    .map((row) => ({ ...row })), [{ source: 'ozon', weight_kg: 9 }, { source: 'user', weight_kg: 2 }]);
});
