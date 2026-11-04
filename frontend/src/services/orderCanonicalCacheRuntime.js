const ORDER_DOMAIN_CACHE_TTL_MS = 2 * 60 * 1000;
const ORDER_DOMAIN_CACHE_MAX_ENTRIES = 96;
const CACHEABLE_ORDER_DOMAINS = new Set(['orders', 'returns']);

const orderDomainCache = new Map();
const orderDomainRequests = new Map();
const orderDomainGenerations = new Map();

function normalizeDomain(domain) {
  return String(domain || '').trim().toLowerCase();
}

function parseShopIds(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(source.map((item) => String(item || '').trim()).filter(Boolean))]
    .filter((shopId) => !['all', '*', 'all-shops'].includes(shopId.toLowerCase()))
    .sort();
}

function orderQueryShopIds(query = {}) {
  const direct = String(query?.shopId || query?.shop_id || '').trim();
  if (direct && !['all', '*', 'all-shops'].includes(direct.toLowerCase())) return [direct];
  return parseShopIds(query?.shopIds ?? query?.shop_ids);
}

function getDomainGeneration(domain) {
  return Number(orderDomainGenerations.get(domain)) || 0;
}

function cloneCachePayload(payload) {
  if (payload === undefined || payload === null) return payload;
  if (typeof globalThis.structuredClone === 'function') {
    try {
      return globalThis.structuredClone(payload);
    } catch {
      // Local API cache payloads are JSON data. Fall through for older runtimes.
    }
  }
  return JSON.parse(JSON.stringify(payload));
}

function normalizeCacheKeyValue(value) {
  if (Array.isArray(value)) return value.map(normalizeCacheKeyValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      const nextValue = value[key];
      if (nextValue !== undefined && nextValue !== null && nextValue !== '') {
        result[key] = normalizeCacheKeyValue(nextValue);
      }
      return result;
    }, {});
}

export function createOrderDomainCacheKey(domain, query = {}) {
  const canonicalQuery = { ...query };
  const shopIds = orderQueryShopIds(canonicalQuery);
  delete canonicalQuery.shop_id;
  delete canonicalQuery.shop_ids;
  if (shopIds.length > 1) {
    delete canonicalQuery.shopId;
    canonicalQuery.shopIds = shopIds;
  } else if (shopIds.length === 1) {
    canonicalQuery.shopId = shopIds[0];
    delete canonicalQuery.shopIds;
  }
  return `${normalizeDomain(domain)}:${JSON.stringify(normalizeCacheKeyValue(canonicalQuery))}`;
}

function pruneOrderDomainCache() {
  while (orderDomainCache.size > ORDER_DOMAIN_CACHE_MAX_ENTRIES) {
    const oldestKey = orderDomainCache.keys().next().value;
    orderDomainCache.delete(oldestKey);
  }
}

function readOrderDomainMemory(key, ttlMs, now) {
  const entry = orderDomainCache.get(key);
  if (!entry) return null;
  if (now - entry.cachedAt > ttlMs) {
    orderDomainCache.delete(key);
    return null;
  }
  orderDomainCache.delete(key);
  orderDomainCache.set(key, entry);
  return cloneCachePayload(entry.payload);
}

/**
 * Shares exact SQLite order/return reads across renderer pages. The payload is
 * cloned at the boundary so page-specific normalization and calculations can
 * never mutate another page's raw cache view.
 */
export async function readOrderDomainCache(domain, query = {}, options = {}, loader) {
  const normalizedDomain = normalizeDomain(domain);
  if (typeof loader !== 'function') throw new TypeError('订单缓存读取缺少数据加载器。');
  if (!CACHEABLE_ORDER_DOMAINS.has(normalizedDomain)) return loader();
  const shopIds = orderQueryShopIds(query);
  // Ownerless reads cannot be invalidated precisely. Explicit single-shop and
  // multi-shop sets are both safe because every cache entry keeps all owners.
  if (!shopIds.length) return loader();

  const ttlMs = Math.max(Number(options.cacheTtlMs) || ORDER_DOMAIN_CACHE_TTL_MS, 1);
  const key = createOrderDomainCacheKey(normalizedDomain, query);
  if (options.bypassMemory !== true) {
    const cached = readOrderDomainMemory(key, ttlMs, Date.now());
    if (cached !== null) return cached;
  }

  // An AbortSignal belongs to one caller. Never let that caller cancel a
  // request already shared by another page.
  if (!options.signal && options.bypassMemory !== true) {
    const pending = orderDomainRequests.get(key);
    if (pending) return cloneCachePayload(await pending.request);
  }

  const generation = getDomainGeneration(normalizedDomain);
  const request = Promise.resolve()
    .then(loader)
    .then((payload) => {
      if (generation === getDomainGeneration(normalizedDomain)) {
        orderDomainCache.delete(key);
        orderDomainCache.set(key, {
          domain: normalizedDomain,
          shopIds,
          cachedAt: Date.now(),
          payload: cloneCachePayload(payload),
        });
        pruneOrderDomainCache();
      }
      return payload;
    });

  if (!options.signal && options.bypassMemory !== true) {
    orderDomainRequests.set(key, { domain: normalizedDomain, shopIds, request });
  }
  try {
    return await request;
  } finally {
    if (orderDomainRequests.get(key)?.request === request) orderDomainRequests.delete(key);
  }
}

export function clearOrderDomainCache(domain = '', options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const shopId = String(options?.shopId || '').trim();
  const domains = normalizedDomain ? [normalizedDomain] : [...CACHEABLE_ORDER_DOMAINS];

  domains.forEach((item) => {
    orderDomainGenerations.set(item, getDomainGeneration(item) + 1);
  });
  for (const [key, entry] of orderDomainCache.entries()) {
    const domainMatches = !normalizedDomain || entry.domain === normalizedDomain;
    const ownerMatches = !shopId || entry.shopIds?.includes(shopId);
    if (domainMatches && ownerMatches) orderDomainCache.delete(key);
  }
  for (const [key, entry] of orderDomainRequests.entries()) {
    const domainMatches = !normalizedDomain || entry.domain === normalizedDomain;
    const ownerMatches = !shopId || entry.shopIds?.includes(shopId);
    if (domainMatches && ownerMatches) orderDomainRequests.delete(key);
  }
}

export function invalidateOrderDomainCacheForShop(domain, shopId) {
  const normalizedShopId = String(shopId || '').trim();
  if (!normalizedShopId) return;
  clearOrderDomainCache(domain, { shopId: normalizedShopId });
}

export function getOrderDomainCacheStats() {
  const entries = [...orderDomainCache.values()];
  return {
    entries: entries.length,
    inFlight: orderDomainRequests.size,
    orders: entries.filter((entry) => entry.domain === 'orders').length,
    returns: entries.filter((entry) => entry.domain === 'returns').length,
  };
}

export function isSharedOrderCacheDomain(domain) {
  return CACHEABLE_ORDER_DOMAINS.has(normalizeDomain(domain));
}
