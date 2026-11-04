import {
  enrichPurchaseRowsWithOzonImagesForShops,
  getOzonOrderScopedRecordKey,
  mergeOzonSalesOrderRows,
  requestOzonSalesOrdersSnapshotForShops,
} from '../../../../entities/profit/profitOrderSnapshot.jsx';
import { readAllSalesOrderPagedCache } from '../../../../services/salesOrderPagedCacheClient.js';

const MS_PER_HOUR = 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_OVERLAP_HOURS = 6;
const DEFAULT_MAX_PAGES = 10;

function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function firstFilled(...values) {
  return values.map(normalizeText).find(Boolean) || '';
}

function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function normalizeRange(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const filter = source.filter && typeof source.filter === 'object' ? source.filter : {};
  return {
    since: firstFilled(source.since, source.from, source.dateFrom, filter.since, filter.from),
    to: firstFilled(source.to, source.dateTo, filter.to),
  };
}

function clampPositiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), maximum);
}

export function createPurchaseOrderPreciseSyncRange({
  fullRange = {},
  previousFetchedAt = '',
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  overlapHours = DEFAULT_OVERLAP_HOURS,
  now = new Date(),
} = {}) {
  const normalized = normalizeRange(fullRange);
  const current = parseDate(now) || new Date();
  const rangeEnd = parseDate(normalized.to) || current;
  const rangeStart = parseDate(normalized.since);
  const lookbackStart = new Date(
    rangeEnd.getTime() - clampPositiveInteger(lookbackDays, DEFAULT_LOOKBACK_DAYS, 30) * 24 * MS_PER_HOUR,
  );
  const previous = parseDate(previousFetchedAt);
  const boundedPrevious = previous && previous < rangeEnd ? previous : null;
  const overlapStart = boundedPrevious
    ? new Date(
        boundedPrevious.getTime() - clampPositiveInteger(overlapHours, DEFAULT_OVERLAP_HOURS, 48) * MS_PER_HOUR,
      )
    : lookbackStart;
  const since = new Date(Math.max(
    rangeStart?.getTime() || Number.NEGATIVE_INFINITY,
    lookbackStart.getTime(),
    overlapStart.getTime(),
  ));
  return {
    since: since.toISOString(),
    to: rangeEnd.toISOString(),
  };
}

function isUsableImage(value) {
  const image = normalizeText(value);
  return Boolean(image && !['未返回', '待确认', '-', '—', 'null', 'undefined'].includes(image.toLowerCase()));
}

export function hasPurchaseOrderProductImage(order = {}) {
  const products = Array.isArray(order.products) ? order.products : [];
  return products.some((product = {}) => [
    product.image,
    product.skuImage,
    product.mainImage,
    product.productMainImage,
    product.primaryImage,
    product.primary_image,
    ...(Array.isArray(product.images) ? product.images : []),
    ...(Array.isArray(product.skuImages) ? product.skuImages : []),
    ...(Array.isArray(product.mainImages) ? product.mainImages : []),
  ].some(isUsableImage));
}

export function mergePurchasePreciseImageRows(fullRows = [], imageRows = []) {
  const imageRowsByKey = new Map(
    (Array.isArray(imageRows) ? imageRows : [])
      .map((row) => [getOzonOrderScopedRecordKey(row), row])
      .filter(([key]) => key),
  );
  return (Array.isArray(fullRows) ? fullRows : []).map((row) => {
    const enhanced = imageRowsByKey.get(getOzonOrderScopedRecordKey(row));
    return enhanced ? mergeOzonSalesOrderRows(row, enhanced) : row;
  });
}

/**
 * Manual refresh for purchase management: synchronize only the recent delta,
 * hydrate images only for delta rows that still miss them, then read the full
 * local SQLite range for display. Existing history never disappears.
 */
export async function requestPurchaseOrdersPreciseSnapshotForShops(shops = [], options = {}) {
  if (options.forceRefresh !== true || options.preciseSync === false) {
    const snapshot = await readAllSalesOrderPagedCache({
      shops,
      timeScope: options.timeScope || options.dateRange,
      page: 1,
      pageSize: 1000,
      includeSummary: false,
    }, {
      timeoutMs: options.timeoutMs ?? 8_000,
      signal: options.signal,
      bypassMemory: options.forceRefresh === true,
      onInitialSnapshot: options.onInitialSnapshot,
    });
    return {
      ...snapshot,
      rows: snapshot.rows || [],
      errors: [],
      fetchedAt: new Date().toISOString(),
      source: snapshot.source || 'sqlite',
    };
  }
  const fullRange = normalizeRange(options.dateRange || options.timeScope || options);
  const preciseRange = createPurchaseOrderPreciseSyncRange({
    fullRange,
    previousFetchedAt: options.previousFetchedAt,
    lookbackDays: options.preciseLookbackDays,
    overlapHours: options.preciseOverlapHours,
    now: options.now,
  });
  const preciseMaxPages = clampPositiveInteger(options.preciseMaxPages, DEFAULT_MAX_PAGES, 30);
  const preciseSnapshot = await requestOzonSalesOrdersSnapshotForShops(shops, {
    ...options,
    dateRange: preciseRange,
    maxPages: preciseMaxPages,
    syncMaxPages: preciseMaxPages,
    concurrentEndpoints: true,
    primaryOrderVariantOnly: true,
    shopConcurrency: clampPositiveInteger(options.shopConcurrency, 3, 6),
    requestedBy: 'frontend-purchase-orders-precise-refresh',
    syncSource: 'purchase-orders-precise-refresh',
    schedulerProfile: 'foreground',
    profile: 'foreground',
    priority: 'P1',
  });
  const rowsMissingImages = (Array.isArray(preciseSnapshot?.rows) ? preciseSnapshot.rows : [])
    .filter((row) => !hasPurchaseOrderProductImage(row));
  const imageResult = rowsMissingImages.length
    ? await enrichPurchaseRowsWithOzonImagesForShops(shops, rowsMissingImages, {
        signal: options.signal,
        includeSkuFallback: true,
      }).catch((error) => ({ rows: [], errors: [{ label: '精准补图', error }] }))
    : { rows: [], errors: [] };
  const fullSnapshot = await requestOzonSalesOrdersSnapshotForShops(shops, {
    ...options,
    dateRange: fullRange,
    forceRefresh: false,
    autoSync: false,
    maxPages: undefined,
    syncMaxPages: undefined,
    concurrentEndpoints: false,
    primaryOrderVariantOnly: false,
  });
  return {
    ...fullSnapshot,
    rows: mergePurchasePreciseImageRows(fullSnapshot?.rows, imageResult.rows),
    errors: [
      ...(Array.isArray(preciseSnapshot?.errors) ? preciseSnapshot.errors : []),
      ...(Array.isArray(fullSnapshot?.errors) ? fullSnapshot.errors : []),
      ...(Array.isArray(imageResult?.errors) ? imageResult.errors : []),
    ],
    fetchedAt: new Date().toISOString(),
    preciseSync: {
      since: preciseRange.since,
      to: preciseRange.to,
      deltaRows: Number(preciseSnapshot?.rows?.length) || 0,
      imageCandidates: rowsMissingImages.length,
      imageRows: Number(imageResult?.rows?.length) || 0,
      maxPages: preciseMaxPages,
    },
  };
}
