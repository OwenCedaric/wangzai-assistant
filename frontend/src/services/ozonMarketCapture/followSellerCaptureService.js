const DEFAULT_FOLLOW_SELLER_LIMIT = 1000;
const MAXIMUM_FOLLOW_SELLER_LIMIT = 1000;
const DEFAULT_FOLLOW_SELLER_CONCURRENCY = 6;
const DEFAULT_FOLLOW_SELLER_BATCH_SIZE = 250;
const MAXIMUM_FOLLOW_SELLER_BATCH_SIZE = 250;
const FOLLOW_SELLER_CACHE_TTL_MS = 30 * 60 * 1000;
const MAXIMUM_CACHE_ENTRIES = 2_000;

const followSellerMemoryCache = new Map();

function text(value) {
  return String(value ?? '').trim();
}

function responseResult(response = {}) {
  return response?.result ?? response?.data?.result ?? response?.data ?? response;
}

function productSku(record = {}) {
  const raw = record?.raw && typeof record.raw === 'object' ? record.raw : {};
  const value = [
    record.id,
    record.sku,
    record.skuId,
    record.productId,
    raw.sku,
    raw.skuId,
    raw.sku_id,
    raw.productId,
    raw.product_id,
  ].map(text).find((candidate) => /^\d{5,20}$/u.test(candidate));
  return value || '';
}

function hasFollowSellerCount(record = {}) {
  return [
    record.followSellerCount,
    record.follow_seller_count,
    record.followCount,
    record.follow_info?.count,
  ].some((value) => value !== undefined && value !== null && value !== '');
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source || {}, key);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveMoney(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function boundedRating(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 && parsed <= 5 ? parsed : null;
}

function nonNegativeInteger(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 && Number.isInteger(parsed) ? parsed : null;
}

function normalizedCurrency(value) {
  const currency = text(value).toUpperCase();
  return ['RUB', 'CNY', 'USD', 'KZT', 'AMD', 'BYN', 'EUR'].includes(currency) ? currency : '';
}

function meaningfulText(value) {
  const normalized = text(value);
  return normalized && !['--', '-', '暂无数据', '暂无', '未返回'].includes(normalized)
    ? normalized
    : '';
}

function structuredRate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) return meaningfulText(value) || null;
  const normalized = Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, finiteNumber(item)])
    .filter(([, item]) => item !== null));
  return Object.keys(normalized).length ? normalized : null;
}

function hasProductLogisticsFact(result = {}) {
  return ['packageDimensions', 'packageWeight', 'rfbsRate', 'fbpRate', 'categoryCommission']
    .some((key) => hasOwn(result, key) && result[key] !== null && result[key] !== '');
}

function isFollowSellerConfirmed(result = {}) {
  if (typeof result.followSellerConfirmed === 'boolean') return result.followSellerConfirmed;
  return result.confirmed === true && hasOwn(result, 'followSellerCount');
}

function isProductFactsConfirmed(result = {}) {
  if (typeof result.productFactsConfirmed === 'boolean') return result.productFactsConfirmed;
  return result.confirmed === true && ['cardPrice', 'rating', 'reviews', 'orders']
    .some((key) => hasOwn(result, key));
}

function isProductLogisticsConfirmed(result = {}) {
  if (typeof result.productLogisticsConfirmed === 'boolean') return result.productLogisticsConfirmed;
  return result.confirmed === true && hasProductLogisticsFact(result);
}

function isAnyCaptureConfirmed(result = {}) {
  return isFollowSellerConfirmed(result)
    || isProductFactsConfirmed(result)
    || isProductLogisticsConfirmed(result);
}

function isCompleteCapture(result = {}) {
  // Package and commission fields are optional enrichment. They must never
  // make the verified public product/follow-seller path look unfinished.
  return isFollowSellerConfirmed(result)
    && isProductFactsConfirmed(result);
}

function mergeVerifiedCaptureFields(target = {}, source = {}) {
  const merged = { ...target };
  if (isFollowSellerConfirmed(source)) {
    merged.followSellerConfirmed = true;
    merged.followSellerCount = Math.max(0, nonNegativeInteger(source.followSellerCount) ?? 0);
    merged.followMinPrice = finiteNumber(source.followMinPrice);
    merged.followMaxPrice = finiteNumber(source.followMaxPrice);
    merged.followSellers = Array.isArray(source.followSellers) ? source.followSellers : [];
    merged.followSellerSource = text(
      source.followSellerSource || source.source,
    ) || 'ozon-public-other-offers';
  }
  if (isProductFactsConfirmed(source)) {
    merged.productFactsConfirmed = true;
    const cardPrice = positiveMoney(source.cardPrice);
    const rating = boundedRating(source.rating);
    const reviews = nonNegativeInteger(source.reviews);
    const orders = nonNegativeInteger(source.orders);
    if (cardPrice !== null) {
      merged.cardPrice = cardPrice;
      merged.cardPriceCurrency = normalizedCurrency(source.cardPriceCurrency)
        || normalizedCurrency(merged.cardPriceCurrency);
    }
    if (rating !== null) merged.rating = rating;
    if (reviews !== null) merged.reviews = reviews;
    if (orders !== null) merged.orders = orders;
    merged.productFactsSource = text(
      source.productFactsSource || source.source,
    ) || 'ozon-public-product-page';
  }

  if (isProductLogisticsConfirmed(source)) {
    merged.productLogisticsConfirmed = true;
    const packageDimensions = meaningfulText(source.packageDimensions);
    const packageWeight = meaningfulText(source.packageWeight);
    const rfbsRate = structuredRate(source.rfbsRate);
    const fbpRate = structuredRate(source.fbpRate);
    if (packageDimensions) merged.packageDimensions = packageDimensions;
    if (packageWeight) merged.packageWeight = packageWeight;
    if (rfbsRate !== null) merged.rfbsRate = rfbsRate;
    if (fbpRate !== null) merged.fbpRate = fbpRate;
    if (source.categoryCommission && typeof source.categoryCommission === 'object') {
      merged.categoryCommission = structuredClone(source.categoryCommission);
    }
    merged.productLogisticsSource = text(
      source.productLogisticsSource || source.source,
    ) || 'verified-product-logistics';
  }
  return merged;
}

function mergeCaptureResult(current = {}, incoming = {}) {
  const sku = productSku(incoming) || productSku(current);
  const merged = mergeVerifiedCaptureFields({ ...current, sku }, incoming);
  merged.confirmed = isAnyCaptureConfirmed(merged);
  return merged;
}

function cacheKey(tabId, sku) {
  return `${text(tabId)}:${sku}`;
}

function pruneCache(now = Date.now()) {
  for (const [key, entry] of followSellerMemoryCache) {
    if (!entry || now - entry.cachedAt > FOLLOW_SELLER_CACHE_TTL_MS) {
      followSellerMemoryCache.delete(key);
    }
  }
  while (followSellerMemoryCache.size > MAXIMUM_CACHE_ENTRIES) {
    followSellerMemoryCache.delete(followSellerMemoryCache.keys().next().value);
  }
}

function cachedResult(tabId, sku, now = Date.now()) {
  const key = cacheKey(tabId, sku);
  const entry = followSellerMemoryCache.get(key);
  if (!entry || now - entry.cachedAt > FOLLOW_SELLER_CACHE_TTL_MS) {
    followSellerMemoryCache.delete(key);
    return null;
  }
  followSellerMemoryCache.delete(key);
  followSellerMemoryCache.set(key, entry);
  return entry.result;
}

function storeResult(tabId, result, now = Date.now()) {
  const sku = text(result?.sku);
  if (!sku || !isAnyCaptureConfirmed(result)) return;
  const key = cacheKey(tabId, sku);
  const previous = followSellerMemoryCache.get(key)?.result;
  const merged = mergeCaptureResult(previous, result);
  followSellerMemoryCache.delete(key);
  followSellerMemoryCache.set(key, { cachedAt: now, result: merged });
  pruneCache(now);
}

function mergeFollowResult(record = {}, result = null) {
  if (!result || !isAnyCaptureConfirmed(result)) return record;
  return mergeVerifiedCaptureFields(record, result);
}

export function mergeFollowSellerCapture(snapshot = {}, results = []) {
  const bySku = new Map();
  (Array.isArray(results) ? results : [])
    .filter((result) => isAnyCaptureConfirmed(result) && productSku(result))
    .forEach((result) => {
      const sku = productSku(result);
      bySku.set(sku, mergeCaptureResult(bySku.get(sku), result));
    });
  if (!bySku.size) return snapshot;
  return {
    ...snapshot,
    datasets: (Array.isArray(snapshot.datasets) ? snapshot.datasets : []).map((dataset) => {
      if (text(dataset?.dataset) !== 'product-performance') return dataset;
      return {
        ...dataset,
        records: (Array.isArray(dataset.records) ? dataset.records : [])
          .map((record) => mergeFollowResult(record, bySku.get(productSku(record)))),
      };
    }),
  };
}

function recordCaptureResult(record = {}) {
  const sku = productSku(record);
  const followSellerConfirmed = record.followSellerConfirmed === true || hasFollowSellerCount(record);
  const productFactsConfirmed = record.productFactsConfirmed === true;
  const productLogisticsConfirmed = record.productLogisticsConfirmed === true
    || hasProductLogisticsFact(record);
  const result = {
    sku,
    confirmed: followSellerConfirmed || productFactsConfirmed || productLogisticsConfirmed,
    followSellerConfirmed,
    productFactsConfirmed,
    productLogisticsConfirmed,
    ...(followSellerConfirmed ? {
      followSellerCount: record.followSellerCount
        ?? record.follow_seller_count
        ?? record.followCount
        ?? record.follow_info?.count,
      followMinPrice: record.followMinPrice ?? record.follow_min_price ?? null,
      followMaxPrice: record.followMaxPrice ?? record.follow_max_price ?? null,
      followSellers: record.followSellers ?? record.follow_info?.sellers ?? [],
      followSellerSource: record.followSellerSource || 'product-performance',
    } : {}),
    ...(productFactsConfirmed ? {
      productFactsSource: record.productFactsSource || 'product-performance',
    } : {}),
    ...(productLogisticsConfirmed ? {
      packageDimensions: meaningfulText(record.packageDimensions) || null,
      packageWeight: meaningfulText(record.packageWeight) || null,
      rfbsRate: structuredRate(record.rfbsRate),
      fbpRate: structuredRate(record.fbpRate),
      categoryCommission: record.categoryCommission && typeof record.categoryCommission === 'object'
        ? structuredClone(record.categoryCommission)
        : null,
      productLogisticsSource: record.productLogisticsSource || 'product-performance',
    } : {}),
  };
  const cardPrice = positiveMoney(
    record.cardPrice ?? record.ozonCardPrice ?? record.priceWithCard,
  );
  const rating = boundedRating(record.rating ?? record.score);
  const reviews = nonNegativeInteger(record.reviews ?? record.reviewCount);
  const orders = nonNegativeInteger(record.orders ?? record.orderCount ?? record.ordersCount);
  if (cardPrice !== null) {
    result.cardPrice = cardPrice;
    result.cardPriceCurrency = normalizedCurrency(record.cardPriceCurrency);
  }
  if (rating !== null) result.rating = rating;
  if (reviews !== null) result.reviews = reviews;
  if (orders !== null) result.orders = orders;
  return result;
}

export async function enrichProductPerformanceFollowSellers({
  command,
  tabId,
  snapshot,
  limit = DEFAULT_FOLLOW_SELLER_LIMIT,
  concurrency = DEFAULT_FOLLOW_SELLER_CONCURRENCY,
  batchSize = DEFAULT_FOLLOW_SELLER_BATCH_SIZE,
  now = Date.now(),
} = {}) {
  if (typeof command !== 'function' || !text(tabId)) return snapshot;
  const boundedLimit = Math.max(1, Math.min(
    MAXIMUM_FOLLOW_SELLER_LIMIT,
    Number(limit) || DEFAULT_FOLLOW_SELLER_LIMIT,
  ));
  const boundedBatchSize = Math.max(1, Math.min(
    MAXIMUM_FOLLOW_SELLER_BATCH_SIZE,
    Number(batchSize) || DEFAULT_FOLLOW_SELLER_BATCH_SIZE,
  ));
  const boundedConcurrency = Math.max(
    1,
    Math.min(8, Number(concurrency) || DEFAULT_FOLLOW_SELLER_CONCURRENCY),
  );
  const records = (Array.isArray(snapshot?.datasets) ? snapshot.datasets : [])
    .filter((dataset) => text(dataset?.dataset) === 'product-performance')
    .flatMap((dataset) => (Array.isArray(dataset.records) ? dataset.records : []));
  const uniqueSkus = [...new Set(records.map(productSku).filter(Boolean))];
  const resultsBySku = new Map();
  records.forEach((record) => {
    const result = recordCaptureResult(record);
    if (!result.sku || resultsBySku.has(result.sku)) return;
    resultsBySku.set(result.sku, result);
  });
  const cachedResults = [];
  const requestCandidates = [];
  for (const sku of uniqueSkus) {
    const cached = cachedResult(tabId, sku, now);
    if (cached) {
      cachedResults.push(cached);
      resultsBySku.set(sku, mergeCaptureResult(resultsBySku.get(sku), cached));
      // A branch-level miss has already been verified for this SKU. Keep the
      // short-lived negative result too, otherwise every UI refresh hammers
      // the same unavailable product page while valid seller facts are cached.
      continue;
    }
    if (!isCompleteCapture(resultsBySku.get(sku))) requestCandidates.push(sku);
  }
  const requestSkus = requestCandidates.slice(0, boundedLimit);
  const completedBeforeRequest = uniqueSkus.filter((sku) => isCompleteCapture(resultsBySku.get(sku)));

  let failed = 0;
  let attemptedCount = 0;
  let errorCode = '';
  for (let offset = 0; offset < requestSkus.length; offset += boundedBatchSize) {
    const batch = requestSkus.slice(offset, offset + boundedBatchSize);
    attemptedCount += batch.length;
    try {
      const response = responseResult(await command({
        command: 'ozon-data-follow-sellers',
        tabId,
        skus: batch,
        concurrency: boundedConcurrency,
      }));
      const batchResults = Array.isArray(response?.results) ? response.results : [];
      batchResults.forEach((result) => {
        const sku = productSku(result);
        if (!sku) return;
        resultsBySku.set(sku, mergeCaptureResult(resultsBySku.get(sku), result));
        storeResult(tabId, result, now);
      });
      failed += Math.max(0, Number(response?.failed) || 0);
    } catch (error) {
      failed += batch.length;
      errorCode = text(error?.code || error?.message || 'OZON_FOLLOW_SELLERS_BATCH_FAILED');
      break;
    }
  }

  const allResults = [...resultsBySku.values()].filter(isAnyCaptureConfirmed);
  const fullyConfirmedSkus = uniqueSkus.filter((sku) => isCompleteCapture(resultsBySku.get(sku)));
  const followSellerConfirmedSkus = uniqueSkus
    .filter((sku) => isFollowSellerConfirmed(resultsBySku.get(sku)));
  const productFactsConfirmedSkus = uniqueSkus
    .filter((sku) => isProductFactsConfirmed(resultsBySku.get(sku)));
  const productLogisticsConfirmedSkus = uniqueSkus
    .filter((sku) => isProductLogisticsConfirmed(resultsBySku.get(sku)));
  const coveredSkuCount = new Set([
    ...completedBeforeRequest,
    ...cachedResults.map(productSku).filter(Boolean),
    ...requestSkus.slice(0, attemptedCount),
  ]).size;
  const limited = uniqueSkus.length > coveredSkuCount;
  return {
    ...mergeFollowSellerCapture(snapshot, allResults),
    followSellerCoverage: {
      source: 'ozon-public-product-page',
      status: failed > 0 || limited || fullyConfirmedSkus.length < uniqueSkus.length
        ? 'partial'
        : 'ready',
      totalProductCount: uniqueSkus.length,
      requestedCount: attemptedCount,
      confirmedCount: fullyConfirmedSkus.length,
      followSellerConfirmedCount: followSellerConfirmedSkus.length,
      productFactsConfirmedCount: productFactsConfirmedSkus.length,
      productLogisticsConfirmedCount: productLogisticsConfirmedSkus.length,
      cachedCount: cachedResults.length,
      failedCount: failed,
      limited,
      ...(errorCode ? { errorCode } : {}),
    },
  };
}

export function clearFollowSellerCaptureMemoryCache() {
  followSellerMemoryCache.clear();
}
