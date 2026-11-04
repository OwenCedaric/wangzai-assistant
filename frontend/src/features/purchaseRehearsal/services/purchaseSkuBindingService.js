import { getProfileSetting, saveProfileSetting } from '../../../api/localApiClient.js';
import { readProductSkuFamily } from '../../../services/productModuleClient.js';
import {
  collectCollectionProductFromLink,
  getCollectionBrowserErrorMessage,
} from '../../collectionPricing/services/collectionBrowserService.js';
import {
  createSkuNameBinding,
  createSkuNameCatalog,
  mergeSkuNameBinding,
  normalizeSkuNameBindingDocument,
  resolveExactSkuBinding,
} from '../lib/purchaseSkuNameBinding.js';

export const AUTO_ORDER_SKU_BINDING_NAMESPACE = 'auto-order-sku-bindings';
export const AUTO_ORDER_SKU_CATALOG_CACHE_NAMESPACE = 'auto-order-sku-catalog-cache';
const SKU_CATALOG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SKU_CATALOG_CACHE_MAX_ENTRIES = 200;

function clean(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function attributeRows(row = {}) {
  return (Array.isArray(row.attributes) ? row.attributes : []).flatMap((attribute) => {
    const id = clean(attribute?.id);
    if (!id || id === '9048') return [];
    const name = clean(attribute?.name) || `规格 ${id}`;
    const value = (Array.isArray(attribute?.values) ? attribute.values : [])
      .map((item) => clean(item?.value))
      .filter(Boolean)
      .join(' / ');
    return value ? [{ id, name, value }] : [];
  });
}

function varyingOzonAttributeIds(rows = []) {
  const values = new Map();
  rows.forEach((row) => attributeRows(row).forEach((attribute) => {
    if (!values.has(attribute.id)) values.set(attribute.id, new Set());
    values.get(attribute.id).add(attribute.value);
  }));
  return new Set([...values.entries()].filter(([, variants]) => variants.size > 1).map(([id]) => id));
}

function ozonFamilyProduct(url, payload = {}, scope = {}) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  if (!rows.length) return null;
  const varyingIds = varyingOzonAttributeIds(rows);
  const base = rows.find((row) => clean(row.sku) === clean(scope.sku)) || rows[0];
  return {
    sourceUrl: url,
    sourceProductId: clean(base.sku || scope.sku),
    productId: clean(scope.productId || base.productId),
    offerId: clean(scope.offerId || base.offerId),
    platform: 'Ozon卖家商品',
    platformCode: 'ozon-seller',
    title: clean(base.name) || clean(base.offerId || base.productId || base.sku) || 'Ozon商品',
    currency: clean(base.currencyCode) || 'CNY',
    skus: rows.map((row) => {
      const attributes = attributeRows(row)
        .filter((attribute) => varyingIds.has(attribute.id))
        .map(({ name, value }) => ({ name, value }));
      return {
        id: clean(row.sku || row.offerId || row.productId),
        productId: clean(row.productId),
        offerId: clean(row.offerId),
        name: attributes.length ? '' : clean(row.offerId || row.name || row.sku),
        attributes,
        price: row.priceValue,
        currency: clean(row.currencyCode) || clean(base.currencyCode) || 'CNY',
        imageUrl: clean(row.primaryImageUrl || row.images?.[0]),
        enabled: true,
        stock: row.stockValue,
      };
    }),
  };
}

function catalogCacheKey(url, role) {
  try {
    const parsed = new URL(String(url || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.hash = '';
    return `${role}:${parsed.toString()}`;
  } catch {
    return '';
  }
}

function normalizeCatalogCache(value = {}) {
  const rows = Array.isArray(value?.entries) ? value.entries : [];
  return {
    version: 1,
    entries: rows.flatMap((row) => {
      const key = String(row?.key || '').trim();
      const catalog = row?.catalog && typeof row.catalog === 'object' ? row.catalog : null;
      const expiresAt = String(row?.expiresAt || '').trim();
      if (
        !key || !catalog?.url || !catalog?.title || !Array.isArray(catalog.skus) || !catalog.skus.length
        || catalog.skus.some((sku) => !clean(sku?.id))
      ) return [];
      return [{ key, catalog, capturedAt: String(row?.capturedAt || ''), expiresAt }];
    }).slice(0, SKU_CATALOG_CACHE_MAX_ENTRIES),
  };
}

async function readCachedSkuCatalog(url, role, options = {}) {
  const key = catalogCacheKey(url, role);
  if (!key || options.forceRefresh === true) return null;
  const read = options.readCache || getProfileSetting;
  try {
    const result = await read(AUTO_ORDER_SKU_CATALOG_CACHE_NAMESPACE, options);
    const document = normalizeCatalogCache(result?.setting?.value || result?.value || {});
    const row = document.entries.find((entry) => entry.key === key);
    if (!row || (Date.parse(row.expiresAt || '') || 0) <= (options.now?.() || Date.now())) return null;
    return { ...row.catalog, cacheHit: true, capturedAt: row.capturedAt };
  } catch {
    return null;
  }
}

async function saveCachedSkuCatalog(url, role, catalog, options = {}) {
  const key = catalogCacheKey(url, role);
  if (!key || !catalog?.skus?.length) return;
  const read = options.readCache || getProfileSetting;
  const save = options.saveCache || saveProfileSetting;
  try {
    const current = await read(AUTO_ORDER_SKU_CATALOG_CACHE_NAMESPACE, options).catch(() => null);
    const document = normalizeCatalogCache(current?.setting?.value || current?.value || {});
    const nowMs = options.now?.() || Date.now();
    const row = {
      key,
      catalog: { ...catalog, cacheHit: undefined },
      capturedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + SKU_CATALOG_CACHE_TTL_MS).toISOString(),
    };
    await save(AUTO_ORDER_SKU_CATALOG_CACHE_NAMESPACE, {
      version: 1,
      entries: [row, ...document.entries.filter((entry) => entry.key !== key)]
        .slice(0, SKU_CATALOG_CACHE_MAX_ENTRIES),
    }, options);
  } catch {
    // Cache persistence is an optimization. A verified live result remains usable.
  }
}

export async function readSkuCatalogFromLink(url, role, options = {}) {
  const cached = await readCachedSkuCatalog(url, role, options);
  if (cached) return cached;
  if (role === 'ozon' && clean(options.scope?.shopId)) {
    const readFamily = options.readOzonFamily || readProductSkuFamily;
    const family = await readFamily({
      shopId: options.scope.shopId,
      sku: options.scope.sku,
      productId: options.scope.productId,
      offerId: options.scope.offerId,
    }, options);
    const localProduct = ozonFamilyProduct(url, family, options.scope);
    if (localProduct) {
      const localCatalog = createSkuNameCatalog(localProduct, { role });
      await saveCachedSkuCatalog(url, role, localCatalog, options);
      return { ...localCatalog, cacheHit: false, localSellerData: true, capturedAt: new Date(options.now?.() || Date.now()).toISOString() };
    }
  }
  const collect = options.collect || collectCollectionProductFromLink;
  const result = await collect(url, options.captureOptions);
  const catalog = createSkuNameCatalog(result.product, { role });
  await saveCachedSkuCatalog(url, role, catalog, options);
  return { ...catalog, cacheHit: false, capturedAt: new Date(options.now?.() || Date.now()).toISOString() };
}

export async function loadSkuNameBindings(options = {}) {
  const read = options.read || getProfileSetting;
  const result = await read(AUTO_ORDER_SKU_BINDING_NAMESPACE, options);
  return normalizeSkuNameBindingDocument(result?.setting?.value || result?.value || {});
}

export async function saveSkuNameBinding(input = {}, options = {}) {
  const current = await loadSkuNameBindings(options);
  const binding = createSkuNameBinding(input);
  const document = mergeSkuNameBinding(current, binding);
  const save = options.save || saveProfileSetting;
  const result = await save(AUTO_ORDER_SKU_BINDING_NAMESPACE, document, options);
  return {
    binding,
    document: normalizeSkuNameBindingDocument(result?.setting?.value || result?.value || document),
  };
}

export async function resolveSavedSkuBindingForOrder(order = {}, options = {}) {
  const document = await loadSkuNameBindings(options);
  return resolveExactSkuBinding(document, order);
}

export function purchaseSkuBindingErrorMessage(error) {
  const code = String(error?.code || error?.message || '').trim();
  const messages = {
    AUTO_ORDER_PRODUCT_INFORMATION_INCOMPLETE: '链接没有返回完整商品信息，请确认是商品详情页。',
    AUTO_ORDER_OZON_LINK_REQUIRED: 'Ozon商品栏必须粘贴 www.ozon.ru 的商品详情链接。',
    AUTO_ORDER_SOURCE_LINK_REQUIRED: '货源商品栏必须粘贴货源平台的商品详情链接。',
    AUTO_ORDER_SOURCE_PLATFORM_UNSUPPORTED: '目前支持1688、淘宝、天猫、拼多多、京东、Wildberries、Amazon、Temu和AliExpress商品链接。',
    AUTO_ORDER_SKU_NAMES_MISSING: '商品链接没有读取到具名 SKU，已停止绑定。',
    AUTO_ORDER_SKU_IDS_MISSING: '商品没有返回真实SKU ID，不能用于自动拍单绑定。',
    AUTO_ORDER_SKU_IDS_DUPLICATE: String(error?.message || '商品存在重复SKU ID，无法安全绑定。'),
    AUTO_ORDER_SKU_NAMES_DUPLICATE: String(error?.message || '商品存在重复 SKU 名称，无法安全绑定。'),
    AUTO_ORDER_SKU_CATALOGS_REQUIRED: '请先读取 Ozon 商品和货源商品。',
    AUTO_ORDER_SKU_BINDING_INCOMPLETE: String(error?.message || '请为每个 Ozon SKU 选择货源 SKU。'),
    AUTO_ORDER_SOURCE_SKU_ALREADY_BOUND: String(error?.message || '同一个货源 SKU 不能重复绑定。'),
    AUTO_ORDER_SKU_BINDING_INVALID: 'SKU绑定内容不完整，未保存。',
  };
  return messages[code] || getCollectionBrowserErrorMessage(error) || 'SKU信息读取失败。';
}
