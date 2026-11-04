import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createCatalogCacheService } from '../src/cache/catalog/catalogCacheService.js';
import { createCatalogCacheRepository } from '../src/db/repositories/catalogCacheRepository.js';
import {
  buildSharedCatalogId,
  createSharedCatalogRepository,
} from '../src/db/repositories/sharedCatalogRepository.js';
import { createSharedCatalogService } from '../src/domain/catalog/sharedCatalogService.js';

function createTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const migration of [
    '001_create_base_tables.sql',
    '002_create_catalog_cache_tables.sql',
    '003_create_catalog_attribute_tables.sql',
    '059_create_shared_catalog.sql',
  ]) {
    const sql = requireMigration(migration);
    db.exec(sql);
  }
  return db;
}

function requireMigration(fileName) {
  return readFileSync(resolve('src/db/migrations', fileName), 'utf8').replace(/^\uFEFF/u, '');
}

function saveShop(db, id) {
  db.prepare(`
    INSERT INTO shops (id, name, status) VALUES (?, ?, 'active')
  `).run(id, `Shop ${id}`);
}

const SEED_TREE = Object.freeze({
  source: 'Ozon Seller API POST /v1/description-category/tree',
  language: 'ZH_HANS',
  fetchedAt: '2026-07-01T00:00:00.000Z',
  nodeCount: 3,
  items: [
    {
      description_category_id: 10,
      category_name: '根类目',
      children: [
        {
          description_category_id: 20,
          category_name: '子类目',
          children: [{ type_id: 30, type_name: '商品类型' }],
        },
      ],
    },
  ],
});

test('migration 059 creates profile-shared versioned catalog tables without shop foreign keys', () => {
  const db = createTestDb();
  try {
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'shared_catalog_%'
      ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(tables, [
      'shared_catalog_attribute_values',
      'shared_catalog_attributes',
      'shared_catalog_categories',
      'shared_catalog_entity_sources',
      'shared_catalog_import_runs',
      'shared_catalog_quarantine',
      'shared_catalog_types',
      'shared_catalog_versions',
    ]);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 59);

    for (const table of tables) {
      const shopFk = db.prepare(`PRAGMA foreign_key_list(${table})`).all()
        .find((row) => row.table === 'shops');
      assert.equal(shopFk, undefined, `${table} must not cascade from shops`);
    }
  } finally {
    db.close();
  }
});

test('packaged JSON is consumed only by local-api as an offline seed and is idempotent', () => {
  const db = createTestDb();
  const tempRoot = mkdtempSync(join(tmpdir(), 'shared-catalog-seed-'));
  const seedPath = join(tempRoot, 'ozonCategoryTree.zh.json');
  writeFileSync(seedPath, JSON.stringify(SEED_TREE), 'utf8');
  try {
    const service = createSharedCatalogService(db);
    const first = service.seedFromPackagedJson({
      filePath: seedPath,
      platform: 'OZON',
      marketplace: 'RU',
    });

    assert.equal(first.ok, true);
    assert.equal(first.catalog.platform, 'ozon');
    assert.equal(first.catalog.marketplace, 'ru');
    assert.equal(first.catalog.locale, 'ZH_HANS');
    assert.equal(first.catalog.sourceKind, 'packaged_seed');
    assert.deepEqual(first.counters, {
      inserted: 3,
      deduplicated: 0,
      replaced: 0,
      quarantined: 0,
    });

    const catalogId = first.catalog.catalogId;
    assert.equal(service.listCategories(catalogId).length, 2);
    assert.equal(service.listTypes(catalogId).length, 1);
    assert.equal(service.resolvePath({ catalogId, typeId: '30' }).pathText, '根类目 > 子类目 > 商品类型');

    const second = service.seedFromPackagedJson({
      filePath: seedPath,
      platform: 'ozon',
      marketplace: 'ru',
    });
    assert.equal(second.catalog.catalogId, catalogId);
    assert.deepEqual(second.counters, {
      inserted: 0,
      deduplicated: 3,
      replaced: 0,
      quarantined: 0,
    });
    assert.equal(service.listQuarantine({ catalogId }).length, 0);
    assert.equal(service.listImportRuns({ catalogId }).length, 2);
    assert.equal(service.listEntitySources({ catalogId }).length, 3);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    db.close();
  }
});

test('platform + marketplace + locale + contract version is the only shared identity', () => {
  const db = createTestDb();
  try {
    const service = createSharedCatalogService(db);
    const first = service.importCategoryTree({
      platform: 'ozon',
      marketplace: 'ru',
      locale: 'DEFAULT',
      contractVersion: 'catalog-v1',
      sourceKind: 'remote',
      sourceShopId: 'shop-a',
      sourceRef: 'run-a',
      treeData: { items: [{ description_category_id: 10, category_name: 'Old' }] },
    });
    const second = service.importCategoryTree({
      platform: 'OZON',
      marketplace: 'RU',
      locale: 'default',
      contractVersion: 'catalog-v1',
      sourceKind: 'remote',
      sourceShopId: 'shop-b',
      sourceRef: 'run-b',
      treeData: { items: [{ description_category_id: 10, category_name: 'Current' }] },
    });
    const nextContract = service.importCategoryTree({
      platform: 'ozon',
      marketplace: 'ru',
      locale: 'DEFAULT',
      contractVersion: 'catalog-v2',
      sourceKind: 'remote',
      sourceShopId: 'shop-a',
      sourceRef: 'run-v2',
      treeData: { items: [{ description_category_id: 10, category_name: 'V2' }] },
    });

    assert.equal(first.catalog.catalogId, second.catalog.catalogId);
    assert.notEqual(first.catalog.catalogId, nextContract.catalog.catalogId);
    assert.equal(second.counters.replaced, 1);
    assert.equal(service.listCategories(second.catalog.catalogId)[0].name, 'Current');
    assert.equal(service.listQuarantine({ catalogId: second.catalog.catalogId }).length, 0);
    assert.equal(service.listCatalogs({ platform: 'ozon', marketplace: 'ru' }).length, 2);
    assert.equal(
      buildSharedCatalogId({ platform: 'OZON', marketplace: 'RU', locale: 'default', contractVersion: 'catalog-v1' }),
      first.catalog.catalogId,
    );
  } finally {
    db.close();
  }
});

test('shared catalog provenance rejects credential-shaped source summaries and hashes source references', () => {
  const db = createTestDb();
  try {
    const repository = createSharedCatalogRepository(db);
    assert.throws(
      () => repository.ensureCatalog({
        platform: 'ozon',
        marketplace: 'ru',
        locale: 'DEFAULT',
        contractVersion: 'secret-guard-v1',
        sourceKind: 'remote',
        sourceSummary: { apiKey: 'must-not-persist' },
      }),
      (error) => error?.code === 'SHARED_CATALOG_SOURCE_SUMMARY_SENSITIVE',
    );

    const service = createSharedCatalogService(db);
    service.importCategoryTree({
      platform: 'ozon',
      marketplace: 'ru',
      locale: 'DEFAULT',
      contractVersion: 'secret-guard-v1',
      sourceKind: 'remote',
      sourceRef: 'internal-source-reference-that-must-be-hashed',
      treeData: { items: [{ description_category_id: 1, category_name: 'Safe' }] },
    });
    const run = service.listImportRuns()[0];
    assert.equal(run.source_ref_hash.length, 64);
    assert.equal(run.source_ref_hash.includes('internal-source-reference'), false);
    assert.equal(JSON.stringify(run).includes('must-not-persist'), false);
  } finally {
    db.close();
  }
});

test('legacy per-shop catalogs deduplicate by stable key/hash and quarantine conflicts', () => {
  const db = createTestDb();
  try {
    saveShop(db, 'shop-a');
    saveShop(db, 'shop-b');
    const legacy = createCatalogCacheRepository(db);
    const keyA = legacy.upsertCacheKey({
      catalogType: 'category_tree',
      scope: 'shop',
      shopId: 'shop-a',
      locale: 'DEFAULT',
    });
    const keyB = legacy.upsertCacheKey({
      catalogType: 'category_tree',
      scope: 'shop',
      shopId: 'shop-b',
      locale: 'DEFAULT',
    });
    legacy.upsertCategoryNode(keyA.cacheKey, {
      categoryId: '100',
      title: 'Canonical from first stable owner',
      level: 0,
    });
    legacy.upsertCategoryNode(keyB.cacheKey, {
      categoryId: '100',
      title: 'Conflicting second title',
      level: 0,
    });

    db.prepare(`
      INSERT INTO catalog_category_mappings (
        id, shop_id, source_namespace, source_category_id,
        ozon_category_id, mapping_status, confidence
      ) VALUES ('mapping-a', 'shop-a', 'supplier', 'supplier-1', '100', 'confirmed', 100)
    `).run();

    const service = createSharedCatalogService(db);
    const result = service.migrateLegacyShopCatalogs({
      platform: 'ozon',
      marketplace: 'ru',
      contractVersion: 'legacy-catalog-v1',
    });

    assert.equal(result.migratedCacheKeys, 2);
    assert.deepEqual(result.counters, {
      inserted: 1,
      deduplicated: 0,
      replaced: 0,
      quarantined: 1,
    });
    const catalog = service.listCatalogs({ marketplace: 'ru' })[0];
    assert.equal(service.listCategories(catalog.catalogId)[0].name, 'Canonical from first stable owner');
    const quarantine = service.listQuarantine({ catalogId: catalog.catalogId });
    assert.equal(quarantine.length, 1);
    assert.equal(quarantine[0].reason, 'stable_key_content_conflict');
    assert.equal(quarantine[0].source_shop_id, 'shop-b');
    assert.equal(service.listEntitySources({ catalogId: catalog.catalogId }).length, 2);

    db.prepare('DELETE FROM shops WHERE id = ?').run('shop-a');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM catalog_category_mappings').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM catalog_category_nodes WHERE shop_id = ?').get('shop-a').count, 0);
    assert.equal(service.listCategories(catalog.catalogId).length, 1);
    assert.equal(service.listEntitySources({ catalogId: catalog.catalogId }).length, 2);

    db.prepare('DELETE FROM shops WHERE id = ?').run('shop-b');
    assert.equal(service.listCategories(catalog.catalogId).length, 1);
    assert.equal(service.listQuarantine({ catalogId: catalog.catalogId }).length, 1);
  } finally {
    db.close();
  }
});

test('catalogCacheService exposes the shared SQLite compatibility entry', () => {
  const db = createTestDb();
  try {
    const service = createCatalogCacheService(db);
    const imported = service.seedSharedCatalogFromPackagedJson;
    assert.equal(typeof imported, 'function');

    const sharedRepository = createSharedCatalogRepository(db);
    const catalog = sharedRepository.ensureCatalog({
      platform: 'ozon',
      marketplace: 'ru',
      locale: 'DEFAULT',
      contractVersion: 'compat-v1',
      mapperVersion: 'shared-catalog-mapper-v1',
      sourceKind: 'test',
    });
    assert.equal(service.listSharedCatalogs({ marketplace: 'ru' }).length, 1);
    assert.deepEqual(service.listSharedCategoryNodes({ catalogId: catalog.catalogId }), []);
  } finally {
    db.close();
  }
});

test('existing catalogCacheService sync dual-writes the profile-shared canonical catalog', async () => {
  const db = createTestDb();
  try {
    saveShop(db, 'shop-sync-source');
    const shopRepository = {
      getShopCredentialsForInternalUse(shopId) {
        return shopId === 'shop-sync-source'
          ? { clientId: 'opaque-client', apiKey: 'opaque-key' }
          : null;
      },
    };
    const ozonScheduler = {
      async executeReadOnly(request) {
        if (request.endpointKey === 'catalog.categoryTree') {
          return {
            ok: true,
            data: {
              result: [{
                description_category_id: 100,
                category_name: '同步类目',
                type_id: 200,
                type_name: '同步类型',
              }],
            },
          };
        }
        if (request.endpointKey === 'catalog.attributes') {
          return { ok: true, data: { result: [{ id: 300, name: '颜色', dictionary_id: 9, complex_id: 4, is_aspect: true, max_value_count: 3 }] } };
        }
        if (request.endpointKey === 'catalog.attributeValues') {
          return { ok: true, data: { result: [{ id: 400, value: '红色' }] } };
        }
        throw new Error(`Unexpected endpoint ${request.endpointKey}`);
      },
    };
    const service = createCatalogCacheService(db, { shopRepository, ozonScheduler });
    const result = await service.runCatalogSyncNow({
      shopId: 'shop-sync-source',
      marketplace: 'ru',
      locale: 'ZH_HANS',
      categoryId: '100',
      typeId: '200',
      attributeId: '300',
    });

    assert.equal(result.status, 'success');
    const [catalog] = service.listSharedCatalogs({ marketplace: 'ru', locale: 'ZH_HANS' });
    assert.ok(catalog);
    assert.equal(service.listSharedCategoryNodes({ catalogId: catalog.catalogId }).length, 1);
    assert.equal(service.listSharedTypes({ catalogId: catalog.catalogId }).length, 1);
    assert.equal(service.listSharedAttributes({ catalogId: catalog.catalogId }).length, 1);
    const sharedAttribute = service.listSharedAttributes({ catalogId: catalog.catalogId })[0];
    assert.equal(sharedAttribute.complexId, 4);
    assert.equal(sharedAttribute.isAspect, true);
    assert.equal(sharedAttribute.maxValueCount, 3);
    assert.equal(service.listSharedAttributeValues({ catalogId: catalog.catalogId }).length, 1);

    const sources = createSharedCatalogRepository(db).listEntitySources({ catalogId: catalog.catalogId });
    assert.equal(sources.length, 4);
    assert.equal(sources.every((row) => row.source_shop_id === 'shop-sync-source'), true);
  } finally {
    db.close();
  }
});
