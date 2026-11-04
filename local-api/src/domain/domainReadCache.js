import { createHotCacheService } from '../cache/hotCacheService.js';
import { createStableHash } from '../utils/stableHash.js';

function parseShopIds(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(source.map((item) => String(item || '').trim()).filter(Boolean))]
    .filter((shopId) => !['all', '*', 'all-shops', '__all__', 'all_shops'].includes(shopId.toLowerCase()));
}

function resolveSingleShopId(query = {}) {
  const direct = String(query.shopId || query.shop_id || '').trim();
  if (direct && !['all', '*', 'all-shops', '__all__', 'all_shops'].includes(direct.toLowerCase())) return direct;
  const shopIds = parseShopIds(query.shopIds ?? query.shop_ids);
  return shopIds.length === 1 ? shopIds[0] : '';
}

function readKey(domain, query = {}, shopId = '') {
  const canonicalQuery = { ...query, shopId };
  delete canonicalQuery.shop_id;
  delete canonicalQuery.shopIds;
  delete canonicalQuery.shop_ids;
  return createStableHash({ domain, query: canonicalQuery }, { length: 32 });
}

function shouldBypassHotCache(query = {}) {
  const value = query._bypassHotCache ?? query.bypassHotCache;
  const normalized = String(value || '').trim().toLowerCase();
  return value === true || value === 1 || normalized === '1' || normalized === 'true';
}

function stripHotCacheControl(query = {}) {
  const normalized = { ...query };
  delete normalized._bypassHotCache;
  delete normalized.bypassHotCache;
  delete normalized._readOnlyScan;
  return normalized;
}

/**
 * Uniform L1 read-through cache for typed domain services.
 *
 * Domain services remain authoritative and their canonical SQLite read is the
 * automatic fallback. A per-shop DTO may be selected only after exact
 * reconciliation, freshness validation, payload hashing and aggregate-index
 * readback. This layer never contacts Ozon or invents a merged calculation.
 */
export function withDomainReadCache(domain, service, options = {}) {
  if (!service?.readCache) return service;
  const hotCacheTtlMs = options.ttlMs || 10_000;
  const shopCacheMaxAgeMs = Number.isFinite(Number(options.shopCacheMaxAgeMs))
    ? Math.max(0, Number(options.shopCacheMaxAgeMs))
    : hotCacheTtlMs;
  const hotCache = options.hotCache || createHotCacheService({
    maxEntries: options.maxEntries || 240,
    ttlMs: hotCacheTtlMs,
    maxPayloadBytes: options.maxPayloadBytes || 2 * 1024 * 1024,
    maxBytes: options.maxBytes || 64 * 1024 * 1024,
  });
  const originalCount = service.countOwnerHotCache?.bind(service);
  const originalInvalidate = service.invalidateOwnerHotCache?.bind(service);
  const originalStatus = service.getHotCacheStatus?.bind(service);
  const profileId = String(options.profileId || 'current').trim();
  const fencedOwners = new Set();
  const shopStore = options.shopCacheCompatibilityStore || null;
  const resolveShopScopeToken = typeof options.resolveShopScopeToken === 'function'
    ? options.resolveShopScopeToken
    : null;
  const shopReadStatus = {
    verifiedHits: 0,
    verifiedMisses: 0,
    authoritativeVerifications: 0,
    canonicalFallbacks: 0,
    failures: 0,
    bypasses: 0,
    lastErrorCode: '',
  };

  function shopCacheInput(shopId, query, payload) {
    return {
      scopeToken: resolveShopScopeToken(shopId),
      domain,
      query,
      ...(payload === undefined ? {} : { payload }),
    };
  }

  function readVerifiedShopCache(shopId, query) {
    if (!shopStore?.readVerified || !resolveShopScopeToken) return null;
    try {
      const cached = shopStore.readVerified({
        ...shopCacheInput(shopId, query),
        maxAgeMs: shopCacheMaxAgeMs,
      });
      if (!cached) {
        shopReadStatus.verifiedMisses += 1;
        return null;
      }
      shopReadStatus.verifiedHits += 1;
      shopReadStatus.lastErrorCode = '';
      return cached;
    } catch (error) {
      shopReadStatus.failures += 1;
      shopReadStatus.canonicalFallbacks += 1;
      shopReadStatus.lastErrorCode = String(error?.code || 'SHOP_CACHE_VERIFIED_READ_FAILED');
      return null;
    }
  }

  function commitVerifiedShopCache(shopId, query, payload) {
    if (!shopStore?.commit || !resolveShopScopeToken || payload?.ok === false) return null;
    try {
      const input = shopCacheInput(shopId, query, payload);
      shopStore.commit(input);
      const reconciliation = shopStore.reconcile?.(input);
      if (reconciliation && reconciliation.matched !== true) {
        const error = new Error('shop cache shadow reconciliation mismatch');
        error.code = 'SHOP_CACHE_RECONCILIATION_MISMATCH';
        throw error;
      }
      if (!shopStore.readVerified || reconciliation?.matched !== true) return null;
      const verified = shopStore.readVerified({ ...input, maxAgeMs: shopCacheMaxAgeMs });
      if (!verified) return null;
      shopReadStatus.authoritativeVerifications += 1;
      shopReadStatus.lastErrorCode = '';
      return verified;
    } catch (error) {
      // The canonical shared read stays available as an automatic fallback.
      shopReadStatus.failures += 1;
      shopReadStatus.canonicalFallbacks += 1;
      shopReadStatus.lastErrorCode = String(error?.code || 'SHOP_CACHE_COMMIT_FAILED');
      return null;
    }
  }

  return {
    ...service,

    readCache(query = {}) {
      const bypassHotCache = shouldBypassHotCache(query);
      const normalizedQuery = stripHotCacheControl(query);
      const readOnlyScan = domain === 'orders' && [true, 1, '1', 'true'].includes(query._readOnlyScan);
      const shopId = resolveSingleShopId(normalizedQuery);
      const requestedOwners = shopId ? [shopId] : parseShopIds(normalizedQuery.shopIds ?? normalizedQuery.shop_ids);
      const effectiveOwners = requestedOwners.length ? requestedOwners : options.resolveActiveShopIds?.();
      if (Array.isArray(effectiveOwners) ? effectiveOwners.some(id => fencedOwners.has(id)) : fencedOwners.size > 0) {
        throw Object.assign(new Error('该账号正在准备删除，已暂停会生成缓存的读取。'), { code: 'ACCOUNT_REMOVAL_OWNER_QUIESCED', statusCode: 409 });
      }
      if (!shopId) {
        const payload = service.readCache(normalizedQuery);
        return {
          ...payload,
          runtimeCache: {
            tier: 'sqlite-l2',
            hit: false,
            domain,
            shopId: null,
            scope: 'aggregate-from-shop-rows',
            aggregationMode: 'canonical-domain-aggregate',
          },
        };
      }
      if (readOnlyScan) {
        // A complete-range scan already reads the authoritative store. Do not
        // serialize/hash/duplicate each transient page into another SQLite
        // cache. This is not a cache-validation bypass: no cache is selected.
        const payload = service.readCache(normalizedQuery);
        return { ...payload, runtimeCache: { tier: 'sqlite-l2', hit: false, domain, shopId, scope: 'authoritative-read-only-scan' } };
      }
      const cacheKey = hotCache.buildKey({
        profileId,
        operation: domain,
        shopId,
        queryKey: readKey(domain, normalizedQuery, shopId),
        contractVersion: 'typed-domain-v1',
      });
      const cached = bypassHotCache ? null : hotCache.get(cacheKey);
      if (cached) {
        return {
          ...cached,
          runtimeCache: { tier: 'memory-l1', hit: true, domain, shopId },
        };
      }

      if (bypassHotCache) {
        shopReadStatus.bypasses += 1;
      } else {
        const shopCached = readVerifiedShopCache(shopId, normalizedQuery);
        if (shopCached) {
          hotCache.set(cacheKey, shopCached.payload, {
            tags: [`domain:${domain}`, `shop:${shopId}`],
          });
          return {
            ...shopCached.payload,
            runtimeCache: {
              tier: 'shop-sqlite-l2',
              hit: true,
              verified: true,
              domain,
              shopId,
              ageMs: shopCached.ageMs,
            },
          };
        }
      }

      const payload = service.readCache(normalizedQuery);
      let selectedPayload = payload;
      let selectedTier = 'sqlite-l2';
      let verified = false;
      if (payload?.ok !== false) {
        const readback = commitVerifiedShopCache(shopId, normalizedQuery, payload);
        if (readback) {
          selectedPayload = readback.payload;
          selectedTier = 'shop-sqlite-l2';
          verified = true;
        }
        hotCache.set(cacheKey, selectedPayload, {
          tags: [`domain:${domain}`, `shop:${shopId}`],
        });
      }
      return {
        ...selectedPayload,
        runtimeCache: {
          tier: selectedTier,
          hit: false,
          verified,
          domain,
          shopId,
          fallback: selectedTier === 'sqlite-l2' && Boolean(shopStore),
        },
      };
    },

    fenceOwnerCache(shopId) { fencedOwners.add(String(shopId)); },
    releaseOwnerCacheFence(shopId) { fencedOwners.delete(String(shopId)); },
    countOwnerHotCache(shopId) {
      const normalized = String(shopId || '').trim();
      if (!normalized) return Number(originalCount?.(shopId) || 0);
      return Number(originalCount?.(shopId) || 0)
        + hotCache.count({ tags: [`shop:${normalized}`] });
    },

    invalidateOwnerHotCache(shopId) {
      const normalized = String(shopId || '').trim();
      if (!normalized) return originalInvalidate?.(shopId) || { ok: true, removed: 0 };
      const own = hotCache.invalidate({ tags: [`shop:${normalized}`] });
      const nested = originalInvalidate?.(shopId) || { removed: 0 };
      let durable = { removed: 0 };
      if (shopStore?.invalidate && resolveShopScopeToken) {
        try {
          durable = shopStore.invalidate({
            scopeToken: resolveShopScopeToken(normalized),
            domain,
          }) || durable;
        } catch (error) {
          shopReadStatus.failures += 1;
          shopReadStatus.lastErrorCode = String(error?.code || 'SHOP_CACHE_INVALIDATION_FAILED');
        }
      }
      return {
        ok: true,
        removed: Number(own.removed || 0)
          + Number(nested.removed || 0)
          + Number(durable.removed || 0),
      };
    },

    getHotCacheStatus() {
      return {
        domain,
        readThrough: hotCache.getStatus(),
        shopReadThrough: Object.freeze({
          mode: 'verified-shop-l2-with-canonical-fallback',
          maxAgeMs: shopCacheMaxAgeMs,
          ...shopReadStatus,
        }),
        nested: originalStatus?.() || null,
      };
    },
  };
}
