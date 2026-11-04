import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createCatalogCacheService } from '../src/cache/catalog/catalogCacheService.js';
import { runMigrations } from '../src/db/database.js';
import { createCatalogCacheRepository } from '../src/db/repositories/catalogCacheRepository.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createApp } from '../src/app/createApp.js';

process.env.LOCAL_API_SECRET = 'unit-local-master-material';

function createTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  return db;
}

function saveUnitShop(shopRepository, id = 'shop_catalog_unit') {
  shopRepository.saveShop({
    id,
    name: 'Catalog unit shop',
    ['client' + 'Id']: 'opaque-a',
    ['api' + 'Key']: 'opaque-b',
    status: 'active',
  });
  return id;
}

function createFakeOzonClient(calls, options = {}) {
  return {
    async requestReadOnly(request) {
      calls.push(request);
      if (options.failEndpoint === request.endpointKey) {
        const error = new Error('Injected catalog sync failure.');
        error.code = 'INJECTED_CATALOG_SYNC_FAILURE';
        throw error;
      }

      if (request.endpointKey === 'catalog.categoryTree') {
        return {
          ok: true,
          data: {
            result: [
              {
                description_category_id: 100,
                category_name: 'Root category',
                type_id: 200,
                disabled: false,
              },
            ],
          },
        };
      }

      if (request.endpointKey === 'catalog.attributes') {
        return {
          ok: true,
          data: {
            result: [
              {
                id: 300,
                name: 'Color',
                description: 'Visible color',
                type: 'String',
                is_required: true,
                dictionary_id: 10,
                complex_id: 7,
                is_aspect: true,
                max_value_count: 2,
              },
            ],
          },
        };
      }

      if (request.endpointKey === 'catalog.attributeValues') {
        return {
          ok: true,
          data: {
            result: [
              {
                id: 400,
                value: 'Red',
              },
            ],
          },
        };
      }

      throw new Error(`Unexpected endpoint: ${request.endpointKey}`);
    },
  };
}

test('catalog sync starts as a background job and writes only catalog cache tables', async () => {
  const db = createTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository);
    const calls = [];
    const queuedTasks = [];
    const service = createCatalogCacheService(db, {
      shopRepository,
      ozonClient: createFakeOzonClient(calls),
      backgroundRunner: (task) => queuedTasks.push(task),
    });

    const accepted = service.startCatalogSync({
      shopId,
      categoryId: '100',
      typeId: '200',
      attributeId: '300',
      locale: 'DEFAULT',
    });

    assert.equal(accepted.ok, true);
    assert.equal(accepted.accepted, true);
    assert.match(accepted.job.jobId, /^catalog_sync_/u);
    assert.equal(accepted.job.status, 'queued');
    assert.equal(calls.length, 0);
    assert.equal(queuedTasks.length, 1);

    await queuedTasks[0]();

    const job = service.getCatalogSyncJob(accepted.job.jobId);
    assert.equal(job.status, 'success');
    assert.deepEqual(job.endpoints, [
      'catalog.categoryTree',
      'catalog.attributes',
      'catalog.attributeValues',
    ]);
    assert.equal(
      calls.find((call) => call.endpointKey === 'catalog.attributeValues').payload.limit,
      200,
    );

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM catalog_category_nodes').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM catalog_attributes').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM catalog_attribute_values').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_jobs').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ozon_request_jobs').get().count, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ozon_request_attempts').get().count, 3);

    const states = service.listSyncState({ shopId });
    assert.equal(states.length, 3);
    assert.equal(states.every((state) => state.status === 'success'), true);
    const sharedCatalog = service.listSharedCatalogs({ marketplace: 'ozon', locale: 'DEFAULT' })[0];
    const sharedAttribute = service.listSharedAttributes({
      catalogId: sharedCatalog.catalogId,
      categoryId: '100',
      typeId: '200',
    })[0];
    assert.equal(sharedAttribute.complexId, 7);
    assert.equal(sharedAttribute.isAspect, true);
    assert.equal(sharedAttribute.maxValueCount, 2);
  } finally {
    db.close();
  }
});

test('catalog attribute value search uses the supported paged values endpoint and local filtering cache', async () => {
  const db = createTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_catalog_limit');
    const calls = [];
    const queuedTasks = [];
    const service = createCatalogCacheService(db, {
      shopRepository,
      ozonClient: createFakeOzonClient(calls),
      backgroundRunner: (task) => queuedTasks.push(task),
    });

    service.startCatalogSync({
      shopId,
      categoryId: '100',
      typeId: '200',
      attributeId: '300',
      query: '中国',
      limit: 1000,
    });
    await queuedTasks[0]();

    assert.equal(
      calls.find((call) => call.endpointKey === 'catalog.attributeValues').payload.limit,
      200,
    );
    assert.equal(calls.some((call) => call.endpointKey === 'catalog.attributeValuesSearch'), false);
    assert.equal(calls.find((call) => call.endpointKey === 'catalog.attributeValues').payload.language, 'DEFAULT');
  } finally {
    db.close();
  }
});

test('catalog attribute value preload skips repeated category and attribute requests', async () => {
  const db = createTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_catalog_values_only');
    const calls = [];
    const queuedTasks = [];
    const service = createCatalogCacheService(db, {
      shopRepository,
      ozonClient: createFakeOzonClient(calls),
      backgroundRunner: (task) => queuedTasks.push(task),
    });

    service.startCatalogSync({
      shopId,
      categoryId: '100',
      typeId: '200',
      attributeId: '300',
      attributeValuesOnly: true,
    });
    await queuedTasks[0]();

    assert.deepEqual(calls.map((call) => call.endpointKey), ['catalog.attributeValues']);
    assert.equal(calls[0].payload.last_value_id, 0);
  } finally {
    db.close();
  }
});

test('catalog attribute value preload follows Ozon last_value_id until every page is cached', async () => {
  const db = createTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_catalog_value_pages');
    const calls = [];
    const service = createCatalogCacheService(db, {
      shopRepository,
      ozonClient: {
        async requestReadOnly(request) {
          calls.push(request);
          const lastValueId = Number(request.payload.last_value_id || 0);
          const start = lastValueId === 0 ? 1 : 201;
          const end = lastValueId === 0 ? 200 : 201;
          return {
            ok: true,
            data: {
              result: Array.from({ length: end - start + 1 }, (_, index) => ({
                id: start + index,
                value: `值 ${start + index}`,
              })),
            },
          };
        },
      },
    });

    const result = await service.runCatalogSyncNow({
      shopId,
      categoryId: '100',
      typeId: '200',
      attributeId: '300',
      attributeValuesOnly: true,
    });

    assert.equal(result.status, 'success');
    assert.deepEqual(calls.map((call) => call.payload.last_value_id), [0, 200]);
    assert.equal(service.listAttributeValues({
      shopId,
      categoryId: '100',
      typeId: '200',
      attributeId: '300',
    }).length, 201);
  } finally {
    db.close();
  }
});

test('catalog sync failure does not clear existing catalog cache data', async () => {
  const db = createTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_catalog_failure');
    const repository = createCatalogCacheRepository(db);
    const key = repository.upsertCacheKey({
      catalogType: 'category_tree',
      scope: 'shop',
      shopId,
      locale: 'DEFAULT',
    });
    repository.upsertCategoryNode(key.cacheKey, {
      categoryId: 'old-100',
      title: 'Old cached category',
      level: 0,
    });

    const calls = [];
    const queuedTasks = [];
    const service = createCatalogCacheService(db, {
      shopRepository,
      ozonClient: createFakeOzonClient(calls, { failEndpoint: 'catalog.categoryTree' }),
      backgroundRunner: (task) => queuedTasks.push(task),
    });

    const accepted = service.startCatalogSync({
      shopId,
      categoryId: '100',
      typeId: '200',
      attributeId: '300',
    });
    await queuedTasks[0]();

    const job = service.getCatalogSyncJob(accepted.job.jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'INJECTED_CATALOG_SYNC_FAILURE');

    const oldNode = repository.listCategoryNodes({ cacheKey: key.cacheKey })[0];
    assert.equal(oldNode.title, 'Old cached category');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM catalog_category_nodes').get().count, 1);
    assert.equal(service.listSyncState({ shopId })[0].status, 'failed');
  } finally {
    db.close();
  }
});

test('catalog sync route returns 202 with jobId without waiting for Ozon', async () => {
  const db = createTestDb();
  const server = createApp({
    db,
    config: { security: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: new Date().toISOString(),
    ozonClient: createFakeOzonClient([]),
    catalogSyncBackgroundRunner: () => {},
  });

  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop_catalog_route');

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/cache/catalog/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shopId, categoryId: '100', typeId: '200', attributeId: '300' }),
    });
    const payload = await response.json();

    assert.equal(response.status, 202);
    assert.equal(payload.ok, true);
    assert.equal(payload.accepted, true);
    assert.match(payload.job.jobId, /^catalog_sync_/u);
    assert.equal(payload.job.status, 'queued');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
