import { createStableHash } from '../../utils/stableHash.js';

const VALID_CATALOG_TYPES = new Set(['category_tree', 'attributes', 'attribute_values', 'metadata']);
const VALID_SCOPES = new Set(['global', 'shop']);

function normalizePart(value, fallback = 'none') {
  if (value == null) {
    return fallback;
  }
  const text = String(value).trim();
  return text || fallback;
}

function normalizeLocale(value) {
  return normalizePart(value, 'DEFAULT').toUpperCase();
}

function normalizeScope(value, shopId) {
  if (value && VALID_SCOPES.has(String(value))) {
    return String(value);
  }
  return shopId ? 'shop' : 'global';
}

function normalizeCatalogType(value) {
  const catalogType = normalizePart(value, 'category_tree');
  if (!VALID_CATALOG_TYPES.has(catalogType)) {
    throw new Error(`不支持的分类缓存类型：${catalogType}`);
  }
  return catalogType;
}

export function hashCatalogQuery(value) {
  if (value == null || value === '') {
    return null;
  }
  return createStableHash(value, { length: 16 });
}

export function normalizeCatalogCacheKeyInput(input = {}) {
  const shopId = normalizePart(input.shopId ?? input.shop_id, '');
  const scope = normalizeScope(input.scope, shopId);
  const catalogType = normalizeCatalogType(input.catalogType ?? input.catalog_type);
  const locale = normalizeLocale(input.locale);
  const categoryId = normalizePart(input.categoryId ?? input.category_id, catalogType === 'category_tree' ? 'root' : 'none');
  const typeId = normalizePart(input.typeId ?? input.type_id, 'none');
  const attributeId = normalizePart(input.attributeId ?? input.attribute_id, 'none');
  const queryHash = normalizePart(input.queryHash ?? input.query_hash ?? hashCatalogQuery(input.query), 'none');

  if (scope === 'shop' && !shopId) {
    throw new Error('店铺级分类缓存必须提供 shopId。');
  }

  return {
    namespace: 'catalog',
    scope,
    shopId: scope === 'shop' ? shopId : null,
    catalogType,
    locale,
    categoryId,
    typeId,
    attributeId,
    queryHash,
    payloadVersion: 'catalog-cache-v1',
  };
}

export function buildCatalogCacheKey(input = {}) {
  const normalized = normalizeCatalogCacheKeyInput(input);
  const owner = normalized.scope === 'shop' ? `shop:${normalized.shopId}` : 'global';

  return [
    normalized.namespace,
    owner,
    normalized.catalogType,
    `locale:${normalized.locale}`,
    `category:${normalized.categoryId}`,
    `type:${normalized.typeId}`,
    `attribute:${normalized.attributeId}`,
    `query:${normalized.queryHash}`,
  ].join(':');
}

export function explainCatalogCacheKeyRule() {
  return {
    version: 'catalog-cache-v1',
    pattern: 'catalog:{global|shop:<shop_id>}:{catalog_type}:locale:<locale>:category:<category_id|root|none>:type:<type_id|none>:attribute:<attribute_id|none>:query:<query_hash|none>',
    examples: [
      'catalog:global:category_tree:locale:DEFAULT:category:root:type:none:attribute:none:query:none',
      'catalog:shop:shop_x:attributes:locale:DEFAULT:category:17000:type:971:attribute:none:query:none',
    ],
    security: [
      'cache_key 只允许使用内部 shop_id，不允许使用 Client ID、API Key 或 token。',
      'query_hash 只保存查询摘要，不保存原始敏感查询。',
    ],
  };
}
