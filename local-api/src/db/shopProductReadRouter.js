const AGGREGATE_SHOP_IDS = new Set(['*', 'all', '__all__', 'all-shops', 'all_shops']);

function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function splitIds(value) {
  const values = Array.isArray(value) ? value : normalizeText(value).split(',');
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

function resolveExactShopId(query = {}) {
  const shopId = normalizeText(query.shopId ?? query.shop_id);
  if (shopId && !AGGREGATE_SHOP_IDS.has(shopId.toLowerCase())) return shopId;
  const shopIds = splitIds(query.shopIds ?? query.shop_ids);
  if (shopIds.some((value) => AGGREGATE_SHOP_IDS.has(value.toLowerCase()))) return '';
  return shopIds.length === 1 ? shopIds[0] : '';
}

export function createShopProductReadRouter({ canonicalDb, shopProductStorage } = {}) {
  if (!canonicalDb?.prepare) throw new Error('SHOP_PRODUCT_READ_CANONICAL_DB_REQUIRED');
  if (!shopProductStorage?.resolveVerifiedReadSession) throw new Error('SHOP_PRODUCT_READ_STORAGE_REQUIRED');
  const counters = {
    canonicalSelections: 0,
    localSelections: 0,
    aggregateSelections: 0,
    disabledSelections: 0,
    safetyFallbacks: 0,
    queryFallbacks: 0,
    lastFallbackReason: '',
    lastShopId: '',
  };

  function resolve(query = {}) {
    const shopId = resolveExactShopId(query);
    counters.lastShopId = shopId;
    if (!shopId) {
      counters.canonicalSelections += 1;
      counters.aggregateSelections += 1;
      return Object.freeze({ db: canonicalDb, source: 'canonical', shopId: '', reason: 'aggregate_or_unscoped' });
    }
    if (!shopProductStorage.isEnabledShop?.(shopId)) {
      counters.canonicalSelections += 1;
      counters.disabledSelections += 1;
      return Object.freeze({ db: canonicalDb, source: 'canonical', shopId, reason: 'shop_not_enabled' });
    }
    const readiness = shopProductStorage.resolveVerifiedReadSession({ shopId });
    if (!readiness?.ready || !readiness.db?.prepare) {
      const reason = readiness?.reason || 'verified_product_database_unavailable';
      if (shopProductStorage.isDirectWriteShop?.(shopId)) {
        const error = new Error('SHOP_PRODUCT_DIRECT_READ_NOT_READY');
        error.code = 'SHOP_PRODUCT_DIRECT_READ_NOT_READY';
        error.reason = reason;
        throw error;
      }
      counters.canonicalSelections += 1;
      counters.safetyFallbacks += 1;
      counters.lastFallbackReason = reason;
      return Object.freeze({ db: canonicalDb, source: 'canonical', shopId, reason });
    }
    counters.localSelections += 1;
    return Object.freeze({ db: readiness.db, source: 'shop', shopId, reason: '',
      allowCanonicalFallback: readiness.writeMode !== 'direct' });
  }

  function recordQueryFallback(input = {}) {
    counters.queryFallbacks += 1;
    counters.lastShopId = normalizeText(input.shopId);
    counters.lastFallbackReason = normalizeText(input.errorCode) || 'shop_product_query_failed';
    return snapshot();
  }

  function snapshot() {
    return Object.freeze({
      mode: 'single-shop-verified-product-read-with-canonical-fallback',
      ...counters,
    });
  }

  return Object.freeze({ resolve, recordQueryFallback, snapshot });
}

export const shopProductReadRouterInternals = Object.freeze({ resolveExactShopId });
