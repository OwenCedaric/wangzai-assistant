import { randomUUID } from 'node:crypto';
import { buildCatalogCacheKey, explainCatalogCacheKeyRule } from './catalogCacheKeys.js';
import { createCatalogCacheRepository } from '../../db/repositories/catalogCacheRepository.js';
import { createOzonClient } from '../../ozon/ozonClient.js';
import { createOzonScheduler } from '../../ozon/ozonScheduler.js';
import { createStableHash } from '../../utils/stableHash.js';
import { createSharedCatalogService } from '../../domain/catalog/sharedCatalogService.js';

function pickCatalogFilters(query = {}) {
  return {
    catalogType: query.catalogType || query.catalog_type || null,
    shopId: query.shopId || query.shop_id || null,
    cacheKey: query.cacheKey || query.cache_key || null,
    parentCategoryId: query.parentCategoryId || query.parent_category_id || null,
    limit: query.limit ? Number(query.limit) : undefined,
  };
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeLocale(value) {
  return (normalizeText(value) || 'DEFAULT').toUpperCase();
}

function normalizeNumberLike(value) {
  const text = normalizeText(value == null ? '' : String(value));
  if (!text) {
    return null;
  }
  const numberValue = Number(text);
  return Number.isFinite(numberValue) ? numberValue : text;
}

function normalizeBooleanFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value ?? '').trim().toLowerCase();
  return Boolean(normalized) && !['0', 'false', 'no', 'off', 'null', 'undefined'].includes(normalized);
}

function createCatalogSyncError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'CatalogSyncError';
  error.code = code;
  Object.assign(error, details);
  return error;
}

function createJobId() {
  return `catalog_sync_${randomUUID()}`;
}

function getOzonResultArray(data, fallbackKeys = []) {
  if (Array.isArray(data)) {
    return data;
  }
  if (Array.isArray(data?.result)) {
    return data.result;
  }
  for (const key of fallbackKeys) {
    if (Array.isArray(data?.[key])) {
      return data[key];
    }
  }
  return [];
}

function getCategoryChildren(item = {}) {
  if (Array.isArray(item.children)) return item.children;
  if (Array.isArray(item.items)) return item.items;
  if (Array.isArray(item.childs)) return item.childs;
  return [];
}

function normalizeCategoryNode(item = {}, { parentCategoryId = null, level = 0, index = 0 } = {}) {
  const categoryId = String(
    item.description_category_id ?? item.category_id ?? item.categoryId ?? item.id ?? '',
  ).trim();
  const typeId = item.type_id ?? item.typeId ?? item.description_type_id ?? null;
  const title = String(item.category_name ?? item.name ?? item.title ?? categoryId).trim();

  if (!categoryId || !title) {
    return null;
  }

  return {
    nodeId: String(item.nodeId ?? item.node_id ?? `${categoryId}:${typeId ?? 'none'}:${index}`).trim(),
    categoryId,
    parentCategoryId,
    typeId: typeId == null ? null : String(typeId),
    title,
    level,
    isDisabled: Boolean(item.disabled ?? item.is_disabled ?? item.isDisabled),
    remoteHash: createStableHash(item, { length: 32 }),
  };
}

function flattenCategoryTree(items = [], parentCategoryId = null, level = 0) {
  const output = [];
  items.forEach((item, index) => {
    const normalized = normalizeCategoryNode(item, { parentCategoryId, level, index });
    if (normalized) {
      output.push(normalized);
      output.push(...flattenCategoryTree(getCategoryChildren(item), normalized.categoryId, level + 1));
    }
  });
  return output;
}

function normalizeAttribute(item = {}, context = {}) {
  const attributeId = String(item.attribute_id ?? item.attributeId ?? item.id ?? '').trim();
  const name = String(item.name ?? item.title ?? attributeId).trim();
  if (!attributeId || !name) {
    return null;
  }

  return {
    attributeId,
    categoryId: String(context.categoryId ?? item.category_id ?? item.categoryId ?? '').trim() || null,
    typeId: String(context.typeId ?? item.type_id ?? item.typeId ?? '').trim() || null,
    name,
    description: item.description ?? null,
    groupName: item.group_name ?? item.groupName ?? item.group?.name ?? null,
    valueType: item.type ?? item.value_type ?? item.valueType ?? null,
    isRequired: normalizeBooleanFlag(item.is_required ?? item.isRequired),
    isCollection: normalizeBooleanFlag(item.is_collection ?? item.isCollection),
    isDictionary: normalizeBooleanFlag(item.is_dictionary ?? item.isDictionary ?? item.dictionary_id),
    dictionaryId: String(item.dictionary_id ?? item.dictionaryId ?? '').trim() || null,
    complexId: Number(item.complex_id ?? item.complexId ?? item.attribute_complex_id ?? item.attributeComplexId) || 0,
    groupId: String(item.group_id ?? item.groupId ?? item.group?.id ?? '').trim() || null,
    maxValueCount: Math.max(0, Number(item.max_value_count ?? item.maxValueCount ?? item.max_values_count ?? item.maxValuesCount) || 0),
    isAspect: normalizeBooleanFlag(item.is_aspect ?? item.isAspect),
    categoryDependent: normalizeBooleanFlag(item.category_dependent ?? item.categoryDependent),
    unit: String(item.unit ?? item.measurement_unit ?? item.measurementUnit ?? '').trim() || null,
    remoteHash: createStableHash(item, { length: 32 }),
  };
}

function normalizeAttributeValue(item = {}, context = {}) {
  const attributeId = String(context.attributeId ?? item.attribute_id ?? item.attributeId ?? '').trim();
  const valueId = String(item.value_id ?? item.valueId ?? item.id ?? item.attribute_value_id ?? item.value ?? '').trim();
  const valueText = String(item.value ?? item.value_text ?? item.valueText ?? item.name ?? item.title ?? '').trim();
  if (!attributeId || !valueId || !valueText) {
    return null;
  }

  return {
    attributeId,
    valueId,
    categoryId: String(context.categoryId ?? item.category_id ?? item.categoryId ?? '').trim() || null,
    typeId: String(context.typeId ?? item.type_id ?? item.typeId ?? '').trim() || null,
    valueText,
    info: item.info ?? item.description ?? null,
    remoteHash: createStableHash(item, { length: 32 }),
  };
}

function createCategoryTreePayload(input = {}) {
  return {
    language: normalizeLocale(input.locale),
  };
}

function createAttributesPayload(input = {}) {
  return {
    description_category_id: normalizeNumberLike(input.categoryId ?? input.category_id),
    type_id: normalizeNumberLike(input.typeId ?? input.type_id),
    language: normalizeLocale(input.locale),
  };
}

function createAttributeValuesListPayload(input = {}) {
  return {
    description_category_id: normalizeNumberLike(input.categoryId ?? input.category_id),
    type_id: normalizeNumberLike(input.typeId ?? input.type_id),
    attribute_id: normalizeNumberLike(input.attributeId ?? input.attribute_id),
    last_value_id: Math.max(0, Number(input.lastValueId ?? input.last_value_id) || 0),
    limit: Math.max(1, Math.min(Number(input.limit) || 200, 200)),
    language: normalizeLocale(input.locale),
  };
}

function makePublicJob(job) {
  return {
    jobId: job.jobId,
    module: 'catalog',
    status: job.status,
    shopId: job.shopId,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    error: job.error || null,
    endpoints: [...job.endpoints],
    cacheKeys: [...job.cacheKeys],
    changedCount: job.changedCount,
  };
}

export function createCatalogCacheService(db, options = {}) {
  const repository = createCatalogCacheRepository(db);
  const sharedCatalogService = options.sharedCatalogService || createSharedCatalogService(db);
  const shopRepository = options.shopRepository || null;
  const ozonClient = options.ozonClient || createOzonClient();
  const ozonScheduler = options.ozonScheduler || (shopRepository
    ? createOzonScheduler({ db, shopRepository, ozonClient, logger: options.logger })
    : null);
  const backgroundRunner = options.backgroundRunner || ((task) => setImmediate(task));
  const jobs = new Map();
  const fencedShopIds = new Set();

  async function requestCatalogEndpoint({ endpointKey, shopId, params, cacheKey, jobId }) {
    if (!ozonScheduler?.executeReadOnly) {
      throw createCatalogSyncError('CATALOG_SYNC_SCHEDULER_MISSING', 'Catalog sync requires the unified Ozon scheduler.');
    }

    const scheduled = await ozonScheduler.executeReadOnly({
      shopId,
      domain: 'catalog',
      endpointKey,
      action: 'sync',
      priority: 'P1',
      params,
      cacheKey,
      idempotencyKey: `${jobId}:${endpointKey}:${createStableHash(params, { length: 16 })}`,
      requestedBy: 'catalog-cache-service',
      allowStale: true,
      forceRefresh: true,
    });

    if (!scheduled.ok) {
      const error = scheduled.errors?.[0] || {};
      throw createCatalogSyncError(
        error.code || 'CATALOG_SYNC_SCHEDULER_FAILED',
        error.message || `Catalog scheduler request failed for ${endpointKey}.`,
        { endpointKey, schedulerJob: scheduled.job },
      );
    }

    return scheduled;
  }

  async function runCatalogSyncJob(job, input = {}) {
    if (fencedShopIds.has(job.shopId)) {
      job.status = 'canceled';
      job.finishedAt = new Date().toISOString();
      job.error = { code: 'CATALOG_SYNC_OWNER_QUIESCED', message: 'Catalog sync owner is quiesced.' };
      return makePublicJob(job);
    }
    job.status = 'running';
    job.startedAt = new Date().toISOString();

    const locale = normalizeLocale(input.locale);
    const shopId = normalizeText(input.shopId ?? input.shop_id);
    const markFailed = (error) => {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.error = {
        code: error?.code || 'CATALOG_SYNC_FAILED',
        message: error instanceof Error ? error.message : String(error),
      };
      for (const cacheKey of job.cacheKeys) {
        repository.updateSyncState(cacheKey, {
          status: 'failed',
          lastAttemptAt: job.finishedAt,
          lastError: `${job.error.code}: ${job.error.message}`,
          snapshotVersion: job.jobId,
        });
      }
      return makePublicJob(job);
    };

    try {
      if (!shopRepository?.getShopCredentialsForInternalUse) {
        throw createCatalogSyncError('CATALOG_SYNC_SHOP_REPOSITORY_MISSING', 'Shop repository is not available for catalog sync.');
      }

      const shopCredentials = shopRepository.getShopCredentialsForInternalUse(shopId);
      if (!shopCredentials?.clientId || !shopCredentials?.apiKey) {
        throw createCatalogSyncError('CATALOG_SYNC_CREDENTIALS_MISSING', 'Catalog sync requires a shop with stored local credentials.', { shopId });
      }

      const attributeValuesOnly = input.attributeValuesOnly === true || input.syncMode === 'attribute-values';
      const attributesOnly = input.attributesOnly === true || input.syncMode === 'attributes';
      let categoryId = normalizeText(input.categoryId ?? input.category_id);
      let typeId = normalizeText(input.typeId ?? input.type_id);
      let attributeId = normalizeText(input.attributeId ?? input.attribute_id);
      if (attributeValuesOnly && (!categoryId || !typeId || !attributeId)) {
        throw createCatalogSyncError('CATALOG_SYNC_ATTRIBUTE_CONTEXT_MISSING', 'Attribute value sync requires categoryId, typeId and attributeId.');
      }

      if (!attributeValuesOnly) {
      if (!attributesOnly) {
      const categoryKey = repository.upsertCacheKey({
        catalogType: 'category_tree',
        scope: 'shop',
        shopId,
        locale,
      });
      job.cacheKeys.push(categoryKey.cacheKey);
      repository.updateSyncState(categoryKey.cacheKey, {
        status: 'syncing',
        lastAttemptAt: job.startedAt,
        lastError: null,
        snapshotVersion: job.jobId,
      });

      const categoryResponse = await requestCatalogEndpoint({
        endpointKey: 'catalog.categoryTree',
        shopId,
        params: createCategoryTreePayload({ locale }),
        cacheKey: categoryKey.cacheKey,
        jobId: job.jobId,
      });
      job.endpoints.push('catalog.categoryTree');

      const categoryItems = getOzonResultArray(categoryResponse.data, ['categories', 'items']);
      const categoryNodes = flattenCategoryTree(categoryItems);
      for (const node of categoryNodes) {
        repository.upsertCategoryNode(categoryKey.cacheKey, node);
      }
      job.changedCount += categoryNodes.length;
      repository.updateSyncState(categoryKey.cacheKey, {
        status: 'success',
        lastSuccessAt: new Date().toISOString(),
        lastAttemptAt: job.startedAt,
        lastError: null,
        remoteHash: createStableHash(categoryResponse.data, { length: 32 }),
        snapshotVersion: job.jobId,
        changedCount: categoryNodes.length,
      });
      if (sharedCatalogService.isAvailable()) {
        sharedCatalogService.importCategoryTree({
          platform: input.platform || 'ozon',
          marketplace: input.marketplace || options.marketplace || 'ozon',
          locale,
          contractVersion: input.contractVersion || 'ozon-description-category-v1',
          mapperVersion: 'shared-catalog-mapper-v1',
          sourceKind: 'remote',
          sourceShopId: shopId,
          sourceRef: `${job.jobId}:catalog.categoryTree`,
          endpointKey: 'catalog.categoryTree',
          treeData: categoryResponse.data,
        });
      }

      const contextNode = categoryNodes.find((node) => node.categoryId && node.typeId) || categoryNodes[0] || {};
      categoryId = categoryId || normalizeText(contextNode.categoryId);
      typeId = typeId || normalizeText(contextNode.typeId);
      if (!categoryId || !typeId) {
        throw createCatalogSyncError('CATALOG_SYNC_CATEGORY_CONTEXT_MISSING', 'Catalog attribute sync requires categoryId and typeId.');
      }
      } else if (!categoryId || !typeId) {
        throw createCatalogSyncError('CATALOG_SYNC_CATEGORY_CONTEXT_MISSING', 'Attribute sync requires categoryId and typeId.');
      }

      const attributesKey = repository.upsertCacheKey({
        catalogType: 'attributes',
        scope: 'shop',
        shopId,
        locale,
        categoryId,
        typeId,
      });
      job.cacheKeys.push(attributesKey.cacheKey);
      repository.updateSyncState(attributesKey.cacheKey, {
        status: 'syncing',
        lastAttemptAt: new Date().toISOString(),
        lastError: null,
        snapshotVersion: job.jobId,
      });

      const attributesResponse = await requestCatalogEndpoint({
        endpointKey: 'catalog.attributes',
        shopId,
        params: createAttributesPayload({ categoryId, typeId, locale }),
        cacheKey: attributesKey.cacheKey,
        jobId: job.jobId,
      });
      job.endpoints.push('catalog.attributes');

      const attributes = getOzonResultArray(attributesResponse.data, ['attributes', 'items'])
        .map((item) => normalizeAttribute(item, { categoryId, typeId }))
        .filter(Boolean);
      for (const attribute of attributes) {
        repository.upsertAttribute(attributesKey.cacheKey, attribute);
      }
      job.changedCount += attributes.length;
      repository.updateSyncState(attributesKey.cacheKey, {
        status: 'success',
        lastSuccessAt: new Date().toISOString(),
        lastAttemptAt: job.startedAt,
        lastError: null,
        remoteHash: createStableHash(attributesResponse.data, { length: 32 }),
        snapshotVersion: job.jobId,
        changedCount: attributes.length,
      });
      if (sharedCatalogService.isAvailable()) {
        sharedCatalogService.importAttributes({
          platform: input.platform || 'ozon',
          marketplace: input.marketplace || options.marketplace || 'ozon',
          locale,
          contractVersion: input.contractVersion || 'ozon-description-category-v1',
          mapperVersion: 'shared-catalog-mapper-v1',
          sourceKind: 'remote',
          sourceShopId: shopId,
          sourceRef: `${job.jobId}:catalog.attributes:${categoryId}:${typeId}`,
          endpointKey: 'catalog.attributes',
          categoryId,
          typeId,
          payload: attributesResponse.data,
          attributes,
        });
      }

      if (attributesOnly || !attributeId) {
        job.status = 'success';
        job.finishedAt = new Date().toISOString();
        jobs.set(job.jobId, job);
        return makePublicJob(job);
      }
      }

      const valuesKey = repository.upsertCacheKey({
        catalogType: 'attribute_values',
        scope: 'shop',
        shopId,
        locale,
        categoryId,
        typeId,
        attributeId,
        // The current Seller API exposes the paged attribute-values endpoint.
        // A text query is filtered locally after the complete dictionary has
        // been cached, so every spelling does not create a duplicate cache.
        query: '',
      });
      job.cacheKeys.push(valuesKey.cacheKey);
      repository.updateSyncState(valuesKey.cacheKey, {
        status: 'syncing',
        lastAttemptAt: new Date().toISOString(),
        lastError: null,
        snapshotVersion: job.jobId,
      });

      const endpointKey = 'catalog.attributeValues';
      const rawValues = [];
      const rawResponses = [];
      const limit = Math.max(1, Math.min(Number(input.limit) || 200, 200));
      const maxPages = Math.max(1, Math.min(Number(input.maxPages) || 25, 25));
      const seenLastValueIds = new Set();
      let lastValueId = 0;
      for (let page = 0; page < maxPages; page += 1) {
        const valuesResponse = await requestCatalogEndpoint({
          endpointKey,
          shopId,
          params: createAttributeValuesListPayload({ categoryId, typeId, attributeId, locale, lastValueId, limit }),
          cacheKey: valuesKey.cacheKey,
          jobId: job.jobId,
        });
        rawResponses.push(valuesResponse.data);
        const pageValues = getOzonResultArray(valuesResponse.data, ['values', 'items']);
        rawValues.push(...pageValues);
        if (pageValues.length < limit) break;
        const nextLastValueId = Number(pageValues.at(-1)?.id ?? pageValues.at(-1)?.value_id ?? pageValues.at(-1)?.valueId) || 0;
        if (!nextLastValueId || seenLastValueIds.has(nextLastValueId)) break;
        seenLastValueIds.add(nextLastValueId);
        lastValueId = nextLastValueId;
      }
      job.endpoints.push(endpointKey);

      const values = rawValues
        .map((item) => normalizeAttributeValue(item, { categoryId, typeId, attributeId }))
        .filter(Boolean)
        .filter((item, index, rows) => rows.findIndex((candidate) => candidate.valueId === item.valueId) === index);
      for (const value of values) {
        repository.upsertAttributeValue(valuesKey.cacheKey, value);
      }
      job.changedCount += values.length;
      repository.updateSyncState(valuesKey.cacheKey, {
        status: 'success',
        lastSuccessAt: new Date().toISOString(),
        lastAttemptAt: job.startedAt,
        lastError: null,
        remoteHash: createStableHash(rawResponses, { length: 32 }),
        snapshotVersion: job.jobId,
        changedCount: values.length,
      });
      if (sharedCatalogService.isAvailable()) {
        sharedCatalogService.importAttributeValues({
          platform: input.platform || 'ozon',
          marketplace: input.marketplace || options.marketplace || 'ozon',
          locale,
          contractVersion: input.contractVersion || 'ozon-description-category-v1',
          mapperVersion: 'shared-catalog-mapper-v1',
          sourceKind: 'remote',
          sourceShopId: shopId,
          sourceRef: `${job.jobId}:${endpointKey}:${categoryId}:${typeId}:${attributeId}`,
          endpointKey,
          categoryId,
          typeId,
          attributeId,
          payload: { result: rawValues },
          values,
        });
      }

      job.status = 'success';
      job.finishedAt = new Date().toISOString();
      jobs.set(job.jobId, job);
      return makePublicJob(job);
    } catch (error) {
      return markFailed(error);
    }
  }

  return {
    isSharedCatalogAvailable() {
      return sharedCatalogService.isAvailable();
    },

    getCacheKeyRule() {
      return explainCatalogCacheKeyRule();
    },

    previewCacheKey(input = {}) {
      return {
        cacheKey: buildCatalogCacheKey(input),
        rule: explainCatalogCacheKeyRule(),
      };
    },

    ensureCacheKey(input = {}) {
      return {
        cacheKey: repository.upsertCacheKey(input),
        rule: explainCatalogCacheKeyRule(),
      };
    },

    listCacheKeys(query = {}) {
      return repository.listCacheKeys(pickCatalogFilters(query));
    },

    listSyncState(query = {}) {
      return repository.listSyncState(pickCatalogFilters(query));
    },

    listCategoryNodes(query = {}) {
      return repository.listCategoryNodes(pickCatalogFilters(query));
    },

    listAttributes(query = {}) {
      return repository.listAttributes(pickCatalogFilters(query));
    },

    listAttributeValues(query = {}) {
      return repository.listAttributeValues(pickCatalogFilters(query));
    },

    listSharedCatalogs(query = {}) {
      return sharedCatalogService.listCatalogs(query);
    },

    listSharedCategoryNodes(input = {}) {
      return sharedCatalogService.listCategories(input.catalogId, input);
    },

    listSharedTypes(input = {}) {
      return sharedCatalogService.listTypes(input.catalogId, input);
    },

    listSharedAttributes(input = {}) {
      return sharedCatalogService.listAttributes(input.catalogId, input);
    },

    listSharedAttributeValues(input = {}) {
      return sharedCatalogService.listAttributeValues(input.catalogId, input);
    },

    seedSharedCatalogFromPackagedJson(input = {}) {
      return sharedCatalogService.seedFromPackagedJson(input);
    },

    migrateLegacyShopCatalogs(input = {}) {
      return sharedCatalogService.migrateLegacyShopCatalogs(input);
    },

    resolveSharedCatalogPath(input = {}) {
      return sharedCatalogService.resolvePath(input);
    },

    getCatalogSyncJob(jobId) {
      const job = jobs.get(jobId);
      return job ? makePublicJob(job) : null;
    },

    startCatalogSync(input = {}) {
      const shopId = normalizeText(input.shopId ?? input.shop_id);
      if (!shopId) {
        throw createCatalogSyncError('CATALOG_SYNC_SHOP_ID_REQUIRED', 'Catalog sync requires shopId.');
      }
      if (fencedShopIds.has(shopId)) {
        throw createCatalogSyncError('CATALOG_SYNC_OWNER_QUIESCED', 'Catalog sync owner is quiesced.', { shopId });
      }
      if (!shopRepository?.getShopCredentialsForInternalUse) {
        throw createCatalogSyncError('CATALOG_SYNC_SHOP_REPOSITORY_MISSING', 'Shop repository is not available for catalog sync.');
      }
      const credentialsCheck = shopRepository.getShopCredentialsForInternalUse(shopId);
      if (!credentialsCheck?.clientId || !credentialsCheck?.apiKey) {
        throw createCatalogSyncError('CATALOG_SYNC_CREDENTIALS_MISSING', 'Catalog sync requires a shop with stored local credentials.', { shopId });
      }

      const job = {
        jobId: createJobId(),
        shopId,
        status: 'queued',
        startedAt: null,
        finishedAt: null,
        error: null,
        endpoints: [],
        cacheKeys: [],
        changedCount: 0,
      };
      jobs.set(job.jobId, job);

      backgroundRunner(() => runCatalogSyncJob(job, { ...input, shopId }).catch((error) => {
        job.status = 'failed';
        job.finishedAt = new Date().toISOString();
        job.error = {
          code: error?.code || 'CATALOG_SYNC_BACKGROUND_ERROR',
          message: error instanceof Error ? error.message : String(error),
        };
      }));

      return {
        ok: true,
        accepted: true,
        job: makePublicJob(job),
        status: 'queued',
        message: 'Catalog sync job accepted. UI should poll /api/cache/catalog/status for SQLite cache state.',
      };
    },

    runCatalogSyncNow(input = {}) {
      const shopId = normalizeText(input.shopId ?? input.shop_id);
      if (fencedShopIds.has(shopId)) {
        throw createCatalogSyncError('CATALOG_SYNC_OWNER_QUIESCED', 'Catalog sync owner is quiesced.', { shopId });
      }
      const job = {
        jobId: createJobId(),
        shopId,
        status: 'queued',
        startedAt: null,
        finishedAt: null,
        error: null,
        endpoints: [],
        cacheKeys: [],
        changedCount: 0,
      };
      jobs.set(job.jobId, job);
      return runCatalogSyncJob(job, input);
    },

    createSyncNotConnectedPayload(input = {}) {
      const preview = this.previewCacheKey(input);
      return {
        ok: false,
        error: {
          code: 'CATALOG_SYNC_NOT_CONNECTED',
          message: '分类缓存同步尚未连接到可执行的 Ozon 调度链路。',
          next: '后续必须通过 local-api/src/ozon/ozonScheduler.js 调用 ozonClient，并只把结果写入 SQLite 分类缓存。',
        },
        cacheKey: preview.cacheKey,
        connected: false,
      };
    },
    getOwnerRuntimeStatus(shopId) {
      const ownerId = normalizeText(shopId);
      const activeJobs = [...jobs.values()].filter((job) => (
        job.shopId === ownerId && ['queued', 'running'].includes(job.status)
      ));
      return { fenced: fencedShopIds.has(ownerId), active: activeJobs.length };
    },
    async quiesceOwner(shopId, { timeoutMs = 30_000 } = {}) {
      const ownerId = normalizeText(shopId);
      fencedShopIds.add(ownerId);
      for (const job of jobs.values()) {
        if (job.shopId === ownerId && job.status === 'queued') {
          job.status = 'canceled';
          job.finishedAt = new Date().toISOString();
          job.error = { code: 'CATALOG_SYNC_OWNER_QUIESCED', message: 'Catalog sync owner is quiesced.' };
        }
      }
      const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 30_000);
      for (;;) {
        const status = this.getOwnerRuntimeStatus(ownerId);
        if (status.active === 0) return { ok: true, ...status };
        if (Date.now() >= deadline) throw createCatalogSyncError('CATALOG_SYNC_OWNER_DRAIN_TIMEOUT', 'Timed out draining catalog owner jobs.', { shopId: ownerId });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    releaseOwnerFence(shopId) {
      const ownerId = normalizeText(shopId);
      return { ok: true, released: fencedShopIds.delete(ownerId), shopId: ownerId };
    },
  };
}
