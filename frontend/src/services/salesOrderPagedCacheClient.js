import { getDomainCache } from '../api/localApiClient.js';
import { normalizeOzonSalesOrderRow } from '../entities/profit/profitOrderSnapshot.jsx';
import {
  getOzonReadableShops,
  resolveOzonShopSelectionId,
} from '../entities/order/orderShopScope.jsx';
import { getOzonSnapshotSourceKey } from '../entities/order/orderIdentityRules.jsx';
import { invalidateOrderDomainCacheForShop } from './orderCanonicalCacheRuntime.js';

const SALES_ORDER_PAGE_MEMORY_TTL_MS = 2 * 60 * 1000;
const SALES_ORDER_PAGE_MEMORY_MAX_ENTRIES = 48;
const salesOrderPagedMemoryCache = new Map();
const activeOrderReads = new Set();

function orderReadTicket(query, signal) {
  const ticket = { shopIds: queryShopIds(query), invalidated: false };
  activeOrderReads.add(ticket);
  return {
    check() {
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      if (ticket.invalidated) throw Object.assign(new DOMException('Order read was superseded', 'AbortError'), { codeName: 'SALES_ORDER_READ_SUPERSEDED' });
    },
    finish() { activeOrderReads.delete(ticket); },
  };
}

export function clearSalesOrderPagedMemoryCache() {
  for (const ticket of activeOrderReads) ticket.invalidated = true;
  salesOrderPagedMemoryCache.clear();
}

function queryShopIds(query = {}) {
  const direct = normalizeText(query.shopId);
  if (direct) return [direct];
  return [...new Set(normalizeText(query.shopIds).split(',').map(normalizeText).filter(Boolean))].sort();
}

export function invalidateSalesOrderPagedMemoryCache({ shopId } = {}) {
  const normalizedShopId = normalizeText(shopId);
  if (!normalizedShopId) return 0;
  for (const ticket of activeOrderReads) if (ticket.shopIds.includes(normalizedShopId)) ticket.invalidated = true;
  let removed = 0;
  for (const [key, entry] of salesOrderPagedMemoryCache.entries()) {
    if (!entry.shopIds?.includes(normalizedShopId)) continue;
    salesOrderPagedMemoryCache.delete(key);
    removed += 1;
  }
  return removed;
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

/**
 * Converts every supported renderer/shop-settings identity back to the
 * canonical SQLite owner id. Older persisted selections may be a client id,
 * display label or generation-aware source key; sending those values as
 * `shopId` makes a valid shop look as if it has no orders.
 *
 * Unknown values are deliberately returned unchanged. A stale single-shop
 * selection must never silently become an all-shop query.
 */
export function resolveSalesOrderShopId(shops = [], selectedShop = 'all') {
  return resolveOzonShopSelectionId(shops, selectedShop, { allValue: 'all', emptyValue: '' });
}

function normalizeCachedSalesOrder(row, shopsById) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const source = String(row?.fulfillment || row?.source || 'FBS').toUpperCase().includes('FBO') ? 'FBO' : 'FBS';
  const shop = shopsById.get(String(row?.shopId || '')) || null;
  return normalizeOzonSalesOrderRow(row, { source, shop });
}

function getQueryMemoryKey(query = {}, shops = []) {
  // Never reuse normalized rows across account generations or changed labels.
  // Public owner metadata only: no API keys enter this identity.
  return JSON.stringify([query, getOzonSnapshotSourceKey(shops), shops.map(shop => [
    shop.id, shop.clientId, shop.profileId, shop.shopAlias, shop.sellerName, shop.name,
  ])]);
}

function readMemoryPage(memoryKey, now = Date.now()) {
  const entry = salesOrderPagedMemoryCache.get(memoryKey);
  if (!entry) return null;
  if (now - entry.cachedAt > SALES_ORDER_PAGE_MEMORY_TTL_MS) {
    salesOrderPagedMemoryCache.delete(memoryKey);
    return null;
  }
  salesOrderPagedMemoryCache.delete(memoryKey);
  salesOrderPagedMemoryCache.set(memoryKey, entry);
  return entry.payload;
}

function writeMemoryPage(memoryKey, payload, query) {
  salesOrderPagedMemoryCache.set(memoryKey, {
    cachedAt: Date.now(),
    payload,
    shopIds: queryShopIds(query),
  });
  while (salesOrderPagedMemoryCache.size > SALES_ORDER_PAGE_MEMORY_MAX_ENTRIES) {
    const oldestKey = salesOrderPagedMemoryCache.keys().next().value;
    salesOrderPagedMemoryCache.delete(oldestKey);
  }
}

export function createSalesOrderPagedCacheQuery({
  shops = [],
  timeScope,
  shop = 'all',
  status = 'all',
  fulfillment = 'all',
  keyword = '',
  postingNumbers = [],
  printShippingFilters = {},
  includePrintShippingFacets = false,
  page = 1,
  pageSize = 20,
  includeSummary = true,
  allHistory = false,
  includeProductImages = false,
  projection = '',
  readOnlyScan = false,
} = {}) {
  const readableShops = getOzonReadableShops(shops);
  const selectedShopId = resolveSalesOrderShopId(readableShops, shop);
  return {
    shopId: selectedShopId || undefined,
    shopIds: selectedShopId ? undefined : readableShops.map((item) => item.id).filter(Boolean).join(','),
    statusScope: status === 'all' ? undefined : status,
    fulfillment: fulfillment === 'all' ? undefined : fulfillment,
    keyword: normalizeText(keyword) || undefined,
    postingNumbers: Array.isArray(postingNumbers)
      ? postingNumbers.map(normalizeText).filter(Boolean).join(',') || undefined
      : normalizeText(postingNumbers) || undefined,
    warehouse: normalizeText(printShippingFilters.warehouse) || undefined,
    deliveryMethod: normalizeText(printShippingFilters.deliveryMethod) || undefined,
    deadlineScope: normalizeText(printShippingFilters.deadlineScope) || undefined,
    trackingState: normalizeText(printShippingFilters.trackingState) || undefined,
    carriageState: normalizeText(printShippingFilters.carriageState) || undefined,
    since: timeScope?.since || undefined,
    to: timeScope?.to || undefined,
    page: Math.max(Number(page) || 1, 1),
    pageSize: Math.max(Number(pageSize) || 20, 1),
    includeSummary: includeSummary ? 1 : undefined,
    allHistory: allHistory ? 1 : undefined,
    includeProductImages: includeProductImages ? 1 : undefined,
    projection: normalizeText(projection) || undefined,
    _readOnlyScan: readOnlyScan === true ? 1 : undefined,
    includePrintShippingFacets: includePrintShippingFacets ? 1 : undefined,
  };
}

/** Reads exactly one renderer page from the canonical SQLite order cache. */
export async function readSalesOrderPagedCache(input = {}, options = {}) {
  const readableShops = getOzonReadableShops(input.shops);
  const query = createSalesOrderPagedCacheQuery({ ...input, shops: readableShops });
  if (!readableShops.length) {
    return {
      rows: [],
      total: 0,
      page: query.page,
      pageSize: query.pageSize,
      summary: { total: 0, amountTotal: 0, salesStatusCounts: { all: 0 } },
      source: 'sqlite',
      durationMs: 0,
    };
  }
  if (options.signal?.aborted) throw options.signal.reason || new DOMException('Aborted', 'AbortError');
  const requestedOwners = new Set(queryShopIds(query));
  const memoryKey = getQueryMemoryKey(query, readableShops.filter(shop => requestedOwners.has(String(shop.id))));
  if (options.bypassMemory !== true) {
    const cached = readMemoryPage(memoryKey);
    if (cached) return { ...cached, memoryHit: true };
  }
  const ticket = orderReadTicket(query, options.signal);
  try {
    ticket.check();
    const payload = await getDomainCache('orders', query, options);
    ticket.check();
    if (payload?.partial === true) throw new Error('SALES_ORDER_PAGE_INCOMPLETE: 部分店铺订单未读取成功');
    const shopsById = new Map(readableShops.map((item) => [String(item.id), item]));
    const rows = Array.isArray(payload?.rows)
      ? payload.rows.map((row) => normalizeCachedSalesOrder(row, shopsById)).filter(Boolean)
      : [];
    const result = {
      ...payload,
      rows,
      page: Number(payload?.page) || query.page,
      pageSize: Number(payload?.pageSize) || query.pageSize,
      total: Number(payload?.total) || 0,
      summary: payload?.summary || { total: Number(payload?.total) || 0, amountTotal: 0, salesStatusCounts: { all: 0 } },
    };
    writeMemoryPage(memoryKey, result, query);
    return result;
  } finally { ticket.finish(); }
}

export async function readSalesOrderPagedCacheKeys(input = {}, options = {}) {
  const readableShops = getOzonReadableShops(input.shops);
  const query = { ...createSalesOrderPagedCacheQuery({ ...input, shops: readableShops }), projection: 'keys', includeSummary: undefined };
  if (!readableShops.length) return { rows: [], total: 0, page: query.page, pageSize: query.pageSize };
  return getDomainCache('orders', query, options);
}

// Same comparator inputs and numeric collation as the canonical multi-shop
// router, operating on the original DTO retained by normalization. The server
// supplies its locale, so the renderer's display language cannot change order.
export function createCanonicalOrderComparator(locale) {
  const collator = new Intl.Collator(locale, { numeric: true });
  const text = value => value == null ? '' : String(value).trim();
  const compare = (a, b) => collator.compare(text(a), text(b));
  const time = row => row.paymentAt ?? row.payment_at ?? row.inProcessAt ?? row.in_process_at ?? row.updatedAt ?? row.updated_at;
  return (left, right) => {
    const a = left.raw, b = right.raw;
    return compare(time(b), time(a)) || compare(a.postingNumber ?? a.posting_number, b.postingNumber ?? b.posting_number)
      || compare(a.orderId ?? a.order_id, b.orderId ?? b.order_id) || compare(a.id, b.id)
      || compare(a.shopId ?? a.shop_id, b.shopId ?? b.shop_id);
  };
}

/** Materializes workflows that require a complete range, preserving first paint. */
export async function readAllSalesOrderPagedCache(input = {}, options = {}) {
  const pageSize = 1000;
  const ticket = orderReadTicket(createSalesOrderPagedCacheQuery(input), options.signal);
  try {
    const first = await readSalesOrderPagedCache({ ...input, page: 1, pageSize, includeSummary: false }, options);
    ticket.check();
    const knownTotal = Number(first.total) > 0 ? Number(first.total) : null;
    const invalidateRange = code => {
      const query = createSalesOrderPagedCacheQuery(input);
      for (const shopId of queryShopIds(query)) {
        invalidateSalesOrderPagedMemoryCache({ shopId });
        invalidateOrderDomainCacheForShop('orders', shopId);
      }
      throw new Error(`${code}: 订单范围在读取期间发生变化，请重试`);
    };
    // An opt-in first-paint notification is not a complete dataset/cache write.
    // Keep the full-read promise pending until every page has been materialized.
    if (first.rows.length === pageSize && (knownTotal === null || first.rows.length < knownTotal)
      && !options.signal?.aborted && typeof options.onInitialSnapshot === 'function') {
      try { options.onInitialSnapshot({ ...first, rows: [...first.rows], complete: false, partial: true, loadedRows: first.rows.length }); }
      catch { /* an optional first-paint observer cannot invalidate the full data read */ }
    }
    const rows = [...first.rows];
    const rowKey = (row, fallback) => JSON.stringify([
      row?.shopId || row?.shopClientId || '',
      row?.recordKey || row?.posting || row?.posting_number || row?.id || fallback,
    ]);
    const requestedIds = queryShopIds(createSalesOrderPagedCacheQuery(input));
    const readableOwners = getOzonReadableShops(input.shops);
    const ownerShops = requestedIds.map(id => readableOwners.find(shop => String(shop.id) === id)).filter(Boolean);
    // Deep federated pages repeatedly re-read/sort an ever-growing prefix.
    // Complete-range consumers can scan each exact owner once, then perform
    // the same global ordering once. Old servers keep the previous path.
    if (ownerShops.length > 1 && knownTotal > pageSize * ownerShops.length && first.orderSortLocale
      && Intl.Collator.supportedLocalesOf([first.orderSortLocale]).length) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) controller.abort();
      const batches = Array(ownerShops.length);
      let cursor = 0;
      const workers = Array.from({ length: Math.min(2, ownerShops.length) }, async () => {
        while (cursor < ownerShops.length) {
          ticket.check();
          const index = cursor++, owner = ownerShops[index];
          batches[index] = await readAllSalesOrderPagedCache({ ...input, shops: [owner], shop: owner.id, readOnlyScan: true },
            { ...options, signal: controller.signal, onInitialSnapshot: undefined });
          ticket.check();
          if (batches[index].rows.some(row => String(row.shopId) !== String(owner.id))) invalidateRange('SALES_ORDER_SHOP_MISMATCH');
        }
      });
      try {
        try { await Promise.all(workers); } catch (error) {
          controller.abort(); await Promise.allSettled(workers); throw error;
        }
        ticket.check();
        const completeRows = [], keys = new Set();
        for (const batch of batches) for (const row of batch.rows) {
          const key = rowKey(row, `owner:${completeRows.length}`);
          if (keys.has(key)) invalidateRange('SALES_ORDER_PAGE_REPEATED');
          keys.add(key); completeRows.push(row);
        }
        if (completeRows.length !== knownTotal) invalidateRange('SALES_ORDER_TOTAL_CHANGED');
        completeRows.sort(createCanonicalOrderComparator(first.orderSortLocale));
        ticket.check();
        return { ...first, rows: completeRows, page: 1, pageSize, total: knownTotal,
          complete: true, partial: false, readStrategy: 'exact-owner-full-range' };
      } finally { options.signal?.removeEventListener('abort', abort); }
    }
    const seenKeys = new Set(first.rows.map((row, index) => rowKey(row, `1:${index}`)));
    let previousPage = first;
    let page = 2;
    while (previousPage.rows.length === pageSize && (knownTotal === null || rows.length < knownTotal)) {
      ticket.check();
      const next = await readSalesOrderPagedCache({ ...input, page, pageSize, includeSummary: false }, options);
      ticket.check();
      if (knownTotal !== null && Number(next.total) !== knownTotal) invalidateRange('SALES_ORDER_TOTAL_CHANGED');
      let added = 0;
      next.rows.forEach((row, index) => {
        const key = rowKey(row, `${page}:${index}`);
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        rows.push(row);
        added += 1;
      });
      if (next.rows.length && !added) invalidateRange('SALES_ORDER_PAGE_REPEATED');
      if (!next.rows.length) break;
      previousPage = next;
      page += 1;
    }
    ticket.check();
    if (knownTotal !== null && rows.length !== knownTotal) invalidateRange('SALES_ORDER_RANGE_INCOMPLETE');
    return { ...first, rows, page: 1, pageSize, total: Math.max(Number(first.total) || 0, rows.length), complete: true, partial: false };
  } finally { ticket.finish(); }
}
