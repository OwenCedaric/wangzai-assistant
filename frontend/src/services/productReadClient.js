import {
  getDomainCache,
  getSyncJob,
  readLocalOzonWarehouseList,
  requestLocalApi,
  startDomainSync,
} from '../api/localApiClient.js';

const PRODUCT_ATTRIBUTE_CATALOG_LOCALES = Object.freeze(['ZH_HANS', 'DEFAULT']);
const PRODUCT_ATTRIBUTE_SCHEMA_LOCALE = 'DEFAULT';
const CATALOG_SYNC_FINAL_STATUSES = new Set(['success', 'failed', 'canceled', 'cancelled']);
const OZON_ATTRIBUTE_VALUES_LIST_MAX_LIMIT = 200;

function queryString(query = {}) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    params.set(key, Array.isArray(value) ? value.join(',') : String(value));
  });
  const text = params.toString();
  return text ? `?${text}` : '';
}

function rowsOf(result = {}) {
  if (Array.isArray(result.rows)) return result.rows;
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.data?.rows)) return result.data.rows;
  return [];
}

function identity(value) {
  return String(value ?? '').trim();
}

function normalizeAttributeOptionSearch(value) {
  return identity(value)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function filterAttributeOptionsBySearch(values = [], search = '') {
  const query = normalizeAttributeOptionSearch(search);
  if (!query) return values;
  return (Array.isArray(values) ? values : []).filter((item) => {
    const text = normalizeAttributeOptionSearch(item?.label ?? item?.value);
    return text && (text.includes(query) || query.includes(text));
  });
}

function normalizeBooleanFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return false;
  return !['0', 'false', 'no', 'n', 'off', 'null', 'undefined'].includes(text);
}

export async function readProductLocalSnapshot(query = {}, options = {}) {
  const result = await getDomainCache('products', query, options);
  const rows = rowsOf(result);
  const productId = identity(query.productId ?? query.product_id);
  const offerId = identity(query.offerId ?? query.offer_id);
  return rows.find((row) => {
    const rowProductId = identity(row.productId ?? row.product_id ?? row.id);
    const rowOfferId = identity(row.offerId ?? row.offer_id ?? row.sku);
    return (productId && rowProductId === productId) || (offerId && rowOfferId === offerId);
  }) || rows[0] || null;
}

function mapAttributeDefinition(item = {}) {
  return {
    ...item,
    id: item.attributeId ?? item.attribute_id ?? item.id,
    categoryId: item.categoryId ?? item.category_id ?? item.descriptionCategoryId ?? item.description_category_id ?? '',
    typeId: item.typeId ?? item.type_id ?? '',
    name: item.name ?? item.title ?? item.attributeName ?? item.attribute_name ?? '',
    description: item.description ?? '',
    type: item.attributeType ?? item.attribute_type ?? item.type ?? '',
    valueType: item.valueType ?? item.value_type ?? item.attributeType ?? item.attribute_type ?? item.type ?? '',
    is_required: normalizeBooleanFlag(item.isRequired ?? item.is_required ?? item.required),
    isCollection: normalizeBooleanFlag(item.isCollection ?? item.is_collection),
    isDictionary: normalizeBooleanFlag(item.isDictionary ?? item.is_dictionary ?? item.dictionary_id),
    dictionary_id: item.dictionaryId ?? item.dictionary_id ?? null,
    dictionaryId: item.dictionaryId ?? item.dictionary_id ?? null,
    complexId: Math.max(0, Number(item.complexId ?? item.complex_id ?? item.attributeComplexId ?? item.attribute_complex_id) || 0),
    groupId: item.groupId ?? item.group_id ?? item.group?.id ?? null,
    groupName: item.groupName ?? item.group_name ?? item.group?.name ?? '',
    maxValueCount: Math.max(0, Number(item.maxValueCount ?? item.max_value_count ?? item.maxValuesCount ?? item.max_values_count) || 0),
    isAspect: normalizeBooleanFlag(item.isAspect ?? item.is_aspect),
    categoryDependent: normalizeBooleanFlag(item.categoryDependent ?? item.category_dependent),
    unit: item.unit ?? item.measurement_unit ?? item.measurementUnit ?? '',
  };
}

export function filterProductScopedAttributeDefinitions(items = [], scope = {}) {
  const categoryId = identity(scope.categoryId ?? scope.descriptionCategoryId);
  const typeId = identity(scope.typeId);
  if (!categoryId || !typeId) return [];
  const definitions = new Map();
  (Array.isArray(items) ? items : []).forEach((source) => {
    const item = mapAttributeDefinition(source);
    const itemCategoryId = identity(item.categoryId);
    const itemTypeId = identity(item.typeId);
    const itemId = identity(item.id);
    if (!itemId || itemCategoryId !== categoryId || itemTypeId !== typeId || definitions.has(itemId)) return;
    definitions.set(itemId, item);
  });
  return [...definitions.values()];
}

async function readProductScopedAttributeDefinitions(categoryId, typeId, options = {}) {
  const definitions = new Map();
  // Ozon's attribute schema is stored under DEFAULT. The earlier implementation also
  // queried ZH_HANS and waited for both local-api calls even though that catalog only
  // contains the category tree, doubling every editor-open read for no additional fields.
  const catalog = await requestLocalApi(
    `/api/catalog/shared/attributes${queryString({
      categoryId,
      descriptionCategoryId: categoryId,
      typeId,
      locale: PRODUCT_ATTRIBUTE_SCHEMA_LOCALE,
      limit: 10000,
    })}`,
    { method: 'GET', timeoutMs: options.timeoutMs, signal: options.signal },
  ).catch((error) => {
    if (error?.name === 'AbortError') throw error;
    return { items: [] };
  });
  filterProductScopedAttributeDefinitions(rowsOf(catalog), { categoryId, typeId }).forEach((item) => {
    const id = identity(item.id);
    if (!definitions.has(id)) definitions.set(id, item);
  });
  return [...definitions.values()];
}

/**
 * Reads the exact Ozon attribute schema for one description category/type pair.
 * Feature services use this instead of knowing the shared-catalog endpoint.
 */
export function readProductAttributeDefinitions(categoryId, typeId, options = {}) {
  const normalizedCategoryId = identity(categoryId);
  const normalizedTypeId = identity(typeId);
  if (!normalizedCategoryId || !normalizedTypeId) return Promise.resolve([]);
  return readProductScopedAttributeDefinitions(normalizedCategoryId, normalizedTypeId, options);
}

/**
 * Returns a complete category/type attribute schema without leaking Ozon endpoint details
 * into feature services. SQLite is read first; a missing (or explicitly refreshed) scope is
 * synchronized through the catalog domain and then read back from SQLite.
 */
export async function readProductAttributeSchema(query = {}, options = {}) {
  const shopId = identity(query.shopId ?? query.shop_id);
  const categoryId = identity(
    query.categoryId ?? query.descriptionCategoryId ?? query.description_category_id,
  );
  const typeId = identity(query.typeId ?? query.type_id);
  if (!categoryId || !typeId) {
    return {
      definitions: [],
      source: 'missing-scope',
      warning: '',
      sync: null,
    };
  }

  let definitions = await readProductScopedAttributeDefinitions(categoryId, typeId, options);
  let sync = null;
  let warning = '';
  const shouldRefresh = Boolean(shopId) && (options.refresh === true || definitions.length === 0);
  if (shouldRefresh) {
    try {
      sync = await refreshProductScopedAttributeDefinitions({ shopId, categoryId, typeId }, options);
      if (sync?.status === 'failed') {
        warning = sync?.error?.message || 'Ozon 类目字段读取失败，请重新读取。';
      } else if (sync?.status === 'timeout') {
        warning = 'Ozon 类目字段读取超时，请重新读取。';
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      warning = error instanceof Error ? error.message : String(error || 'Ozon 类目字段读取失败，请重新读取。');
    }
    definitions = await readProductScopedAttributeDefinitions(categoryId, typeId, options);
  }

  if (!definitions.length && !warning) {
    warning = shopId
      ? 'Ozon 暂未返回这个类目的字段，请重新读取。'
      : '请先选择已配置的 Ozon 店铺，再读取类目字段。';
  }
  return {
    definitions,
    source: definitions.length
      ? (sync ? 'ozon-scoped-sync' : 'sqlite-scoped-catalog')
      : 'empty',
    warning,
    sync,
  };
}

function mapAttributeOption(item = {}, scope = {}) {
  const attributeId = identity(item.attributeId ?? item.attribute_id ?? item.id);
  const categoryId = identity(item.categoryId ?? item.category_id ?? scope.categoryId);
  const typeId = identity(item.typeId ?? item.type_id ?? scope.typeId);
  const valueId = identity(item.valueId ?? item.value_id ?? item.id);
  const valueText = String(item.valueText ?? item.value_text ?? item.value ?? item.name ?? item.title ?? '').trim();
  if (!attributeId || !valueId || !valueText) return null;
  if (attributeId !== identity(scope.attributeId)) return null;
  if (categoryId && categoryId !== identity(scope.categoryId)) return null;
  if (typeId && typeId !== identity(scope.typeId)) return null;
  return {
    id: valueId,
    value: valueText,
    label: valueText,
    info: item.info ?? item.description ?? '',
  };
}

async function readCachedProductAttributeOptions(query = {}, options = {}) {
  const values = new Map();
  const catalogs = await Promise.all(PRODUCT_ATTRIBUTE_CATALOG_LOCALES.map((locale) => (
    requestLocalApi(
      `/api/catalog/shared/values${queryString({
        categoryId: query.categoryId,
        descriptionCategoryId: query.categoryId,
        typeId: query.typeId,
        attributeId: query.attributeId,
        locale,
        limit: 10_000,
      })}`,
      { method: 'GET', timeoutMs: options.timeoutMs, signal: options.signal },
    ).catch((error) => {
      if (error?.name === 'AbortError') throw error;
      return { items: [] };
    })
  )));
  catalogs.forEach((catalog) => {
    rowsOf(catalog)
      .map((item) => mapAttributeOption(item, query))
      .filter(Boolean)
      .forEach((item) => values.set(`${item.id}:${item.value}`, item));
  });
  return [...values.values()];
}

export async function readProductAttributeOptions(query = {}, options = {}) {
  const categoryId = identity(query.categoryId ?? query.descriptionCategoryId ?? query.description_category_id);
  const typeId = identity(query.typeId ?? query.type_id);
  const attributeId = identity(query.attributeId ?? query.attribute_id);
  const shopId = identity(query.shopId ?? query.shop_id);
  const searchText = identity(query.search ?? query.query ?? query.value);
  if (!categoryId || !typeId || !attributeId) return [];

  let values = await readCachedProductAttributeOptions(
    { ...query, categoryId, typeId, attributeId },
    options,
  );
  const cachedMatches = filterAttributeOptionsBySearch(values, searchText);
  if (
    (!searchText && values.length > 0 && options.refresh !== true)
    || (searchText && cachedMatches.length > 0 && options.refresh !== true)
    || options.refresh === false
    || !shopId
  ) return searchText ? cachedMatches : values;

  const maximumLimit = OZON_ATTRIBUTE_VALUES_LIST_MAX_LIMIT;

  const syncPayload = await startDomainSync('catalog', {
    shopId,
    categoryId,
    typeId,
    attributeId,
    locale: 'DEFAULT',
    query: searchText,
    attributeValuesOnly: true,
    limit: Math.max(1, Math.min(Number(options.limit) || maximumLimit, maximumLimit)),
  }, {
    timeoutMs: Math.min(Number(options.timeoutMs) || 10_000, 10_000),
    signal: options.signal,
  });
  await waitForCatalogAttributeSync(syncPayload, options);
  values = await readCachedProductAttributeOptions(
    { ...query, categoryId, typeId, attributeId },
    options,
  );
  return searchText ? filterAttributeOptionsBySearch(values, searchText) : values;
}

function isDictionaryDefinition(definition = {}) {
  return normalizeBooleanFlag(definition.isDictionary ?? definition.is_dictionary ?? definition.dictionary_id);
}

export async function preloadProductAttributeOptions(query = {}, definitions = [], options = {}) {
  const dictionaryDefinitions = (Array.isArray(definitions) ? definitions : [])
    .filter(isDictionaryDefinition)
    .map((definition) => identity(definition.id ?? definition.attributeId ?? definition.attribute_id))
    .filter(Boolean);
  const uniqueIds = [...new Set(dictionaryDefinitions)];
  const result = {};
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 3, 6));
  let cursor = 0;

  async function worker() {
    while (cursor < uniqueIds.length) {
      const index = cursor;
      cursor += 1;
      const attributeId = uniqueIds[index];
      try {
        result[attributeId] = await readProductAttributeOptions(
          { ...query, attributeId },
          options,
        );
      } catch {
        result[attributeId] = [];
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueIds.length) }, worker));
  return result;
}

function catalogJob(payload = {}) {
  return payload?.job && typeof payload.job === 'object' ? payload.job : payload;
}

async function waitForCatalogAttributeSync(syncPayload = {}, options = {}) {
  const jobId = identity(catalogJob(syncPayload)?.jobId ?? syncPayload?.jobId);
  if (!jobId) return { status: '', error: null };
  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 45_000, 60_000));
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const payload = await getSyncJob(jobId, {
      timeoutMs: Math.min(5000, Math.max(1000, timeoutMs - (Date.now() - startedAt))),
      signal: options.signal,
    });
    const job = catalogJob(payload);
    const status = identity(job?.status).toLowerCase();
    if (CATALOG_SYNC_FINAL_STATUSES.has(status)) {
      return { status, error: job?.error || null };
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 350));
  }
  return { status: 'timeout', error: null };
}

async function refreshProductScopedAttributeDefinitions(query = {}, options = {}) {
  const syncPayload = await startDomainSync('catalog', {
    shopId: query.shopId,
    categoryId: query.categoryId,
    typeId: query.typeId,
    locale: 'DEFAULT',
    attributesOnly: true,
  }, {
    timeoutMs: Math.min(Number(options.timeoutMs) || 10_000, 10_000),
    signal: options.signal,
  });
  return waitForCatalogAttributeSync(syncPayload, options);
}

export async function readProductEditorContext(query = {}, options = {}) {
  const product = await readProductLocalSnapshot(query, options);
  const shopId = identity(query.shopId ?? query.shop_id ?? product?.shopId ?? product?.shop_id);
  const categoryId = identity(
    query.categoryId
      ?? query.descriptionCategoryId
      ?? query.description_category_id
      ?? product?.descriptionCategoryId
      ?? product?.description_category_id,
  );
  const typeId = identity(query.typeId ?? query.type_id ?? product?.typeId ?? product?.type_id);
  let definitions = [];
  let definitionSync = null;
  let definitionWarning = '';
  if (categoryId && typeId) {
    definitions = await readProductScopedAttributeDefinitions(categoryId, typeId, options);
    if (!definitions.length && shopId && options.refreshAttributeDefinitions !== false) {
      try {
        definitionSync = await refreshProductScopedAttributeDefinitions({ shopId, categoryId, typeId }, options);
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        definitionWarning = error instanceof Error ? error.message : String(error || '当前商品属性定义同步失败');
      }
      definitions = await readProductScopedAttributeDefinitions(categoryId, typeId, options);
      if (!definitions.length && !definitionWarning) {
        definitionWarning = definitionSync?.error?.message || 'Ozon 暂未返回当前商品类目的可填写字段定义。';
      }
    }
  }
  return {
    product,
    attributes: product?.attributes ?? product?.raw?.attributes ?? [],
    attributeDefinitions: definitions,
    attributeScope: { shopId, categoryId, typeId },
    attributeDefinitionSource: definitions.length
      ? (definitionSync ? 'ozon-scoped-sync' : 'sqlite-scoped-catalog')
      : 'product-filled-values',
    attributeDefinitionWarning: definitionWarning,
    source: 'sqlite',
  };
}

function normalizeWarehouse(item = {}, index = 0) {
  const rawId = identity(item.warehouse_id ?? item.warehouseId ?? item.id ?? item.warehouse?.id);
  const archived = item.is_archived === true || item.archived === true;
  return {
    id: rawId || `warehouse-${index + 1}`,
    rawId,
    name: identity(item.name ?? item.warehouse_name ?? item.warehouseName ?? item.title) || `未命名仓库 ${index + 1}`,
    status: archived ? '已归档' : identity(item.status ?? item.state) || '可选择',
    address: identity(item.address ?? item.location ?? item.city) || '未返回',
    raw: item,
  };
}

function warehouseRowsOf(result = {}) {
  const directCandidates = [
    result?.warehouses,
    result?.result,
    result?.items,
    result?.data?.warehouses,
    result?.data?.result,
    result?.data?.items,
  ];
  const direct = directCandidates.find(Array.isArray);
  if (direct) return direct;
  return rowsOf(result).flatMap((row) => {
    const payload = row?.payload && typeof row.payload === 'object' ? row.payload : row;
    return [
      payload?.warehouses,
      payload?.result,
      payload?.items,
      payload?.result?.warehouses,
      payload?.result?.items,
    ].find(Array.isArray) || [];
  });
}

export async function readProductWarehouseOptions(shopId, options = {}) {
  const normalizedShopId = identity(shopId);
  if (!normalizedShopId) return [];
  const result = await readLocalOzonWarehouseList(normalizedShopId, options);
  return warehouseRowsOf(result)
    .map(normalizeWarehouse)
    .filter((warehouse) => warehouse.rawId && !/归档|停用|禁用/i.test(warehouse.status));
}

export function selectDefaultProductWarehouse(warehouses = [], preferredWarehouseId = '') {
  const preferred = identity(preferredWarehouseId);
  return warehouses.find((item) => identity(item.rawId) === preferred)
    || warehouses.find((item) => item.raw?.is_default === true || item.raw?.isDefault === true)
    || warehouses[0]
    || null;
}
