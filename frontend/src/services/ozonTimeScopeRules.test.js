import { describe, expect, it } from 'vitest';
import { readProjectSource, readSplitAppSource } from '../test/appSource';
import { createSalesOrderPagedCacheQuery } from './salesOrderPagedCacheClient.js';

const appSource = readSplitAppSource();

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expectPageTimeScope(pageName, startState, endState, scopeName, { pagedCache = false } = {}) {
  expect(appSource).toContain(`page: '${pageName}'`);
  expect(appSource).toMatch(
    new RegExp(`(?:startDate:\\s*${escapeRegExp(startState)}|\\b${escapeRegExp(startState)},)`)
  );
  expect(appSource).toMatch(new RegExp(`(?:endDate:\\s*${escapeRegExp(endState)}|\\b${escapeRegExp(endState)},)`));
  expect(appSource).toContain(`timeScope: ${scopeName}`);
  if (pagedCache) {
    expect(appSource).toContain('timeScope?.since');
    expect(appSource).toContain('timeScope?.to');
  } else {
    expect(appSource).toContain(`dateRange: ${scopeName}.apiRange`);
  }
}

function getSourceBetween(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  expect(start, startMarker).toBeGreaterThanOrEqual(0);
  const end = appSource.indexOf(endMarker, start);
  expect(end, endMarker).toBeGreaterThan(start);
  return appSource.slice(start, end);
}

describe('Ozon order time scope rules', () => {
  it('keeps the order default range at 90 days, not the old 30-day quick range or fixed lookback constant', () => {
    expect(appSource).toContain('const OZON_ORDER_DEFAULT_RANGE_DAYS = 90;');
    expect(appSource).toContain('const OZON_INITIAL_ORDER_QUICK_RANGE_DAYS = OZON_ORDER_DEFAULT_RANGE_DAYS;');
    expect(appSource).toContain('const OZON_AFTER_SALES_DEFAULT_RANGE_DAYS = OZON_ORDER_DEFAULT_RANGE_DAYS;');
    expect(appSource).not.toContain('OZON_ORDER_LOOKBACK_DAYS');
  });

  it('does not cap order and cross-border reads to the old fixed 10-page window', () => {
    const ozonPagedSource = getSourceBetween(
      'async function requestOzonPagedOffset',
      'async function requestOzonPagedOffsetVariants'
    );
    const crossBorderPagedSource = getSourceBetween(
      'async function requestCrossBorderOrderSearchPages',
      'function isCrossBorderArrayConversionError'
    );

    expect(appSource).not.toContain('const OZON_ORDER_MAX_PAGES = 10;');
    expect(appSource).not.toContain('const CROSS_BORDER_ORDER_MAX_PAGES = 10;');
    expect(ozonPagedSource).toContain('OZON_ORDER_PAGINATION_SAFETY_MAX_PAGES');
    expect(ozonPagedSource).toContain('options.maxPages');
    expect(ozonPagedSource).toContain('if (hasNext === false) break;');
    expect(ozonPagedSource).toContain('if (total !== null && items.length >= total) break;');
    expect(crossBorderPagedSource).toContain('CROSS_BORDER_ORDER_PAGINATION_SAFETY_MAX_PAGES');
    expect(crossBorderPagedSource).toContain('if (total !== null && items.length >= total) break;');
  });

  it('passes selected date ranges into sales, purchase, and profit loaders', () => {
    expectPageTimeScope('sales-orders', 'paymentStartDate', 'paymentEndDate', 'salesOrderTimeScope', { pagedCache: true });
    expectPageTimeScope('purchase-orders', 'paymentStartDate', 'paymentEndDate', 'purchaseOrderTimeScope');
    expectPageTimeScope('profit-calculation', 'paymentStartDate', 'paymentEndDate', 'profitOrderTimeScope');
    expect(appSource).toContain('const snapshot = await profitSync.refresh();');
    expect(appSource).toContain('await reloadProfitSnapshot({ silent: true });');
    expect(appSource).toContain('loaderForceRefresh: false');
    expect(appSource).toContain('autoSync: false');
    expect(appSource).toContain('forceOrderRefreshShopIds: profitDateRefreshRequest.shopIds');
    expect(appSource).toContain(
      'autoSync: forceRefreshShopIds ? shouldForceThisShop : options.autoSync'
    );
    expect(appSource).toContain('dateRange: profitOrderTimeScope.apiRange');
    expect(appSource).toContain('timeScope: profitOrderTimeScope');
  });

  it('keeps sales, purchase, and after-sales on 90 days while profit defaults to all history', () => {
    const salesSnapshotSource = readProjectSource('src/features/orders/sales/model/useSalesOrdersSnapshotState.jsx');
    const purchasePageSource = getSourceBetween('function PurchaseOrdersPage', 'function WarehouseLogisticsPage');
    const afterSalesPageSource = getSourceBetween('function AfterSalesOrdersPage', 'function SalesOrdersPage');

    expect(appSource).toContain('const OZON_ORDER_DEFAULT_RANGE_DAYS = 90;');
    expect(appSource).toContain('const OZON_AFTER_SALES_DEFAULT_RANGE_DAYS = OZON_ORDER_DEFAULT_RANGE_DAYS;');
    expect(salesSnapshotSource).toContain('defaultDays: OZON_ORDER_DEFAULT_RANGE_DAYS');
    expect(purchasePageSource).toContain('defaultDays: OZON_ORDER_DEFAULT_RANGE_DAYS');
    expect(appSource).toContain('allHistory: true');
    expect(appSource).toContain('range:all-history');
    expect(afterSalesPageSource).toContain('defaultDays: OZON_AFTER_SALES_DEFAULT_RANGE_DAYS');
    expect(afterSalesPageSource).toContain('`最近 ${OZON_AFTER_SALES_DEFAULT_RANGE_DAYS} 天`');
    expect(appSource).toContain('defaultDays: options.defaultDays ?? OZON_AFTER_SALES_DEFAULT_RANGE_DAYS');
  });

  it('isolates order-like snapshot memory, in-flight, manual refresh, and local file caches by page and selected range', () => {
    const timeScopeSource = getSourceBetween('function createOzonTimeRangeScope', 'function getExplicitOzonTimeRange');
    const realtimeHookSource = getSourceBetween('function useOzonRealtimeSnapshot', 'function firstMarketingValue');
    const purchasePageSource = getSourceBetween('function PurchaseOrdersPage', 'function WarehouseLogisticsPage');
    const afterSalesPageSource = getSourceBetween('function AfterSalesOrdersPage', 'function SalesOrdersPage');

    expect(timeScopeSource).toContain("options.page || options.module || 'shared'");
    expect(timeScopeSource).toContain("options.filterScope || 'all'");
    expect(timeScopeSource).toContain("options.version || 'time-v1'");
    expect(timeScopeSource).toContain('formatLocalDateKey(apiRange.since)');
    expect(timeScopeSource).toContain('formatLocalDateKey(apiRange.to)');
    expect(timeScopeSource).toContain(
      "cachePart: `${page}:range:${startDateKey || 'open'}_${endDateKey || 'open'}:filter:${filterScope}:v:${version}`"
    );

    expect(realtimeHookSource).toContain('const cacheKey = cacheTtlMs');
    expect(realtimeHookSource).toContain('const inFlightKey = cacheKey || `${snapshotGroup}:${sourceKey}`;');
    expect(realtimeHookSource).toContain(
      'const manualRefreshCooldownKey = `${options.manualRefreshCooldownKey || snapshotGroup}:${sourceKey}`;'
    );
    expect(realtimeHookSource).toContain(
      'const localDataSnapshotKey = options.localDataSnapshotKey || cacheKey || inFlightKey;'
    );
    expect(realtimeHookSource).toContain('ozonSnapshotInFlight.get(inFlightKey)');
    expect(realtimeHookSource).toContain('ozonSnapshotManualRefreshAt.set(manualRefreshCooldownKey, Date.now())');

    const salesSnapshotSource = readProjectSource('src/features/orders/sales/model/useSalesOrdersSnapshotState.jsx');
    const salesPagedStateSource = readProjectSource('src/features/orders/sales/model/useSalesOrderPagedCacheState.jsx');
    const salesCacheClientSource = readProjectSource('src/services/salesOrderPagedCacheClient.js');
    expect(salesSnapshotSource).toContain('useSalesOrderPagedCacheState({');
    expect(salesSnapshotSource).toContain('timeScope: salesOrderTimeScope');
    expect(salesSnapshotSource).toContain('sqlite:orders:');
    expect(salesPagedStateSource).toContain('readSalesOrderPagedCache(queryOverride || queryInput');
    expect(salesPagedStateSource).toContain('const refreshedQueryInput = { ...queryInput, timeScope: refreshedTimeScope };');
    expect(salesPagedStateSource).toContain("startDomainRefresh('orders'");
    expect(salesCacheClientSource).toContain('since: timeScope?.since');
    expect(salesCacheClientSource).toContain('to: timeScope?.to');
    expect(purchasePageSource).toContain('cacheGroup: purchaseOrderSnapshotGroup');
    const preciseLoader = readProjectSource('src/features/orders/purchase/services/purchaseOrderPreciseSyncService.js');
    const purchaseDataset = readProjectSource('src/features/orders/purchase/model/usePurchaseOrdersDatasetState.jsx');
    expect(purchaseDataset).toContain('requestPurchaseOrdersPreciseSnapshotForShops');
    expect(purchaseDataset).not.toContain('localDataSnapshotKey:');
    expect(purchaseDataset).not.toContain('localDataSnapshotKeys:');
    expect(preciseLoader).toContain('timeScope: options.timeScope || options.dateRange');
    expect(purchasePageSource).toContain("page: 'orders-shared-pool'");
    expect(purchasePageSource).toContain("version: 'orders-90d-v1'");
    expect(purchasePageSource).toContain(
      "getOzonSalesOrdersSnapshotCacheKey(readableShops, purchaseOrderPoolTimeScope, 'ozon-orders-shared')"
    );
    expect(afterSalesPageSource).toContain(
      'const afterSalesSnapshotGroup = createAfterSalesSnapshotGroup(afterSalesTimeScope);'
    );
    expect(afterSalesPageSource).toContain('cacheGroup: afterSalesSnapshotGroup');
    expect(afterSalesPageSource).toContain('manualRefreshCooldownKey: afterSalesSnapshotGroup');
    expect(afterSalesPageSource).toContain('snapshotIdentityKey: afterSalesCanonicalScopeKey');
    expect(afterSalesPageSource).not.toContain('localDataSnapshotKey:');
    expect(afterSalesPageSource).not.toContain('localDataSnapshotKeys:');
    expect(afterSalesPageSource).toContain('getOzonSnapshotRowActivityDateKey(order)');
    expect(appSource).toContain('localDataSnapshotKeys: getOzonAfterSalesSnapshotReadKeys(shop, snapshotScope)');
    expect(appSource).toContain('parsed.getFullYear() >= 2020');
    expect(appSource).toContain('return formatLocalDateKey(parsed);');
    expect(appSource).toContain('const normalizedDate = normalizeSalesOrderDateFilter(dateToken);');
  });

  it('carries exact owner/date/page scope into the canonical SQLite query', () => {
    const shops = [{ id: 'shop-1', clientId: 'client-1', apiKey: 'synthetic' }, { id: 'shop-2', clientId: 'client-2', apiKey: 'synthetic' }];
    const timeScope = { since: '2026-09-01T00:00:00.000Z', to: '2026-09-02T23:59:59.999Z' };
    const one = createSalesOrderPagedCacheQuery({ shops, shop: 'shop-1', timeScope, page: 2, pageSize: 20 });
    const two = createSalesOrderPagedCacheQuery({ shops, shop: 'shop-2', timeScope: { ...timeScope, to: '2026-09-05T00:00:00.000Z' }, page: 1 });
    expect(one).toMatchObject({ shopId: 'shop-1', since: timeScope.since, to: timeScope.to, page: 2, pageSize: 20 });
    expect(two).toMatchObject({ shopId: 'shop-2', since: timeScope.since, to: '2026-09-05T00:00:00.000Z', page: 1 });
  });

  it('connects after-sales filtering to the same time-scoped local snapshot and loader', () => {
    const afterSalesPageSource = getSourceBetween('function AfterSalesOrdersPage', 'function SalesOrdersPage');
    expect(appSource).toContain("const [afterSalesStartDate, setAfterSalesStartDate] = React.useState('');");
    expect(appSource).toContain("const [afterSalesEndDate, setAfterSalesEndDate] = React.useState('');");
    expectPageTimeScope('after-sales-orders', 'afterSalesStartDate', 'afterSalesEndDate', 'afterSalesTimeScope');
    expect(appSource).toContain('defaultDays: OZON_AFTER_SALES_DEFAULT_RANGE_DAYS');
    expect(afterSalesPageSource).toContain('dateRange: afterSalesTimeScope.apiRange');
    expect(afterSalesPageSource).toContain('timeScope: afterSalesTimeScope');
    expect(afterSalesPageSource).toContain('afterSalesCanonicalScopeKey');
    expect(appSource).toContain('setAfterSalesDateAnchorEl(event.currentTarget)');
  });

  it('records same-source consistency logs for after-sales, sales, and purchase order pages', () => {
    const afterSalesPageSource = getSourceBetween('function AfterSalesOrdersPage', 'function SalesOrdersPage');
    const purchasePageSource = getSourceBetween('function PurchaseOrdersPage', 'function WarehouseLogisticsPage');

    expect(appSource).toContain('function getOzonRealtimeSnapshotLogSource(snapshotState = {})');

    expect(afterSalesPageSource).toContain('const afterSalesDatasetConsistency = React.useMemo');
    expect(afterSalesPageSource).toContain('validatePageDatasetConsistency(');
    expect(afterSalesPageSource).toContain("domain: '09_after_sales'");
    expect(afterSalesPageSource).toContain(
      "status: afterSalesDatasetConsistency.ok ? 'consistency-ok' : 'consistency-failed'"
    );
    expect(afterSalesPageSource).toContain('canonicalScopeKey: afterSalesCanonicalScopeKey');
    expect(afterSalesPageSource).toContain('timeScope: afterSalesTimeScope.cachePart');
    expect(afterSalesPageSource).toContain('consistency: afterSalesDatasetConsistency');

    const salesSelectionSource = readProjectSource('src/features/orders/sales/model/useSalesOrderSelectionState.jsx');
    expect(salesSelectionSource).toContain("domain: '05_sales_orders'");
    expect(salesSelectionSource).toContain("source: orderSync.data?.source || 'sqlite'");
    expect(salesSelectionSource).toContain('localSnapshotKey: salesOrderLocalSnapshotKey');
    expect(salesSelectionSource).toContain('timeScope: salesOrderTimeScope.cachePart');
    expect(salesSelectionSource).toContain('pageTotalRows: orderSync.data?.total || 0');

    expect(purchasePageSource).toContain('const purchaseOrderDatasetConsistency = React.useMemo');
    expect(purchasePageSource).toContain('validatePageDatasetConsistency(');
    expect(purchasePageSource).toContain("domain: '07_purchase_orders'");
    expect(purchasePageSource).toContain(
      "status: purchaseOrderDatasetConsistency.ok ? 'consistency-ok' : 'consistency-failed'"
    );
    expect(purchasePageSource).toContain('localSnapshotKey: purchaseOrderLocalSnapshotKey');
    expect(purchasePageSource).toContain('timeScope: purchaseOrderTimeScope.cachePart');
    expect(purchasePageSource).toContain('consistency: purchaseOrderDatasetConsistency');
  });

  it('keeps SQLite profit ledgers date-scoped without the retired JSON order snapshot path', () => {
    const profitPageSource = getSourceBetween('function ProfitCalculationPage', 'function WarehouseLogisticsPage');

    expect(profitPageSource).toContain('createProfitOrderTimeScope(paymentStartDate, paymentEndDate)');
    expect(profitPageSource).toContain('dateRange: profitOrderTimeScope.apiRange');
    expect(profitPageSource).toContain('timeScope: profitOrderTimeScope');
    expect(profitPageSource).toContain('const profitOrderSnapshotGroup = React.useMemo');
    expect(profitPageSource).toContain('cacheGroup: profitOrderSnapshotGroup');
    expect(profitPageSource).toContain('createProfitRollingSnapshotScopes(profitOrderTimeScope, 7)');
    expect(profitPageSource).not.toContain('getOzonSalesOrdersSnapshotReadKeys');
    expect(profitPageSource).not.toContain('profitOrderLocalSnapshotKey');
    expect(profitPageSource).not.toContain('prepareLocalSnapshot');
    expect(profitPageSource).not.toContain('PROFIT_LEGACY_ORDER_SNAPSHOT_RUNTIME_FROZEN');
    expect(profitPageSource).not.toContain('profitLegacyOrderSnapshotOptions');
    expect(profitPageSource).toContain('manualRefreshCooldownKey: profitPageManualRefreshCooldownKey');
    expect(profitPageSource).toContain('profitRollingSnapshotScopes.flatMap((scope)');
    expect(profitPageSource).toContain('appendOzonSnapshotScopeKey(key, scope)');
    expect(profitPageSource).not.toContain('appendLegacyOzonDateRangeToSnapshotKey');
    expect(profitPageSource).not.toContain('legacyProfitLedgerSnapshotKeys');
    expect(profitPageSource).toContain('useProfitLedgerReadback({');
    expect(profitPageSource).toContain('fileKey: LOCAL_PROFIT_DATA_FILE_KEY, snapshotKeys: profitLedgerSnapshotKeys');
    expect(readProjectSource('src/features/profit/model/useProfitLedgerReadback.js'))
      .toContain('read(fileKey, snapshotKeys, { signal: controller.signal, onPartition })');
    expect(profitPageSource).toContain('writeProfitLedgerLocalSnapshot(');
    expect(profitPageSource).toContain('profitLedgerSnapshotKeys,');
  });

  it('does not expose finance operations as a standalone page while keeping profit finance reads scoped', () => {
    const profitPageSource = getSourceBetween('function ProfitCalculationPage', 'function WarehouseLogisticsPage');

    expect(appSource).not.toContain("label: '财务流水'");
    expect(appSource).not.toContain("pageId === 'finance'");
    expect(appSource).not.toContain('function FinanceOperationsPage');
    expect(appSource).not.toContain("page: 'finance-operations'");
    expect(appSource).not.toContain('requestOzonFinanceSnapshotForShops(');
    expect(appSource).not.toContain('getFinanceSnapshotReadKeys(');

    expect(appSource).toContain('async function requestOzonFinanceOperationsForPostingCached');
    expect(appSource).toContain('requestOzonFinanceOperationsForPosting(shop, postingNumber, dateRange, options)');
    expect(profitPageSource).toContain('const snapshot = await profitSync.refresh();');
    expect(profitPageSource).toContain('dateRange: profitOrderTimeScope.apiRange');
    expect(profitPageSource).toContain('timeScope: profitOrderTimeScope');
  });

  it('migrates readable legacy fallback snapshots into the primary scoped key before new writes', () => {
    const orderWriteSource = getSourceBetween(
      'async function writeOzonLocalDataSnapshot',
      'async function readOzonLocalDomainSnapshot'
    );
    const domainWriteSource = getSourceBetween(
      'async function writeOzonLocalDomainSnapshot',
      'async function readProfitLedgerLocalSnapshot'
    );
    const productWriteSource = getSourceBetween(
      'async function writeOzonLocalProductSnapshot',
      'function getOzonLocalUniqueValues'
    );

    [orderWriteSource, domainWriteSource, productWriteSource].forEach((source) => {
      expect(source).toContain('const snapshotKeys = getOzonLocalSnapshotKeyCandidates(snapshotKey);');
      expect(source).toContain('const primarySnapshotKey = snapshotKeys[0];');
      expect(source).toContain('const existingPrimarySnapshot =');
      expect(source).toContain('const legacySnapshot = existingPrimarySnapshot');
      expect(source).toContain("source: 'legacy-cache-migration'");
    });

    expect(orderWriteSource).toContain('readOzonSnapshotFromLocalStore(currentStore, snapshotKeys.slice(1))');
    expect(orderWriteSource).toContain(
      'mergeOzonSnapshotIntoLocalStore(currentStore, primarySnapshotKey, legacySnapshot'
    );
    expect(orderWriteSource).toContain('mergeOzonSnapshotIntoLocalStore(baseStore, primarySnapshotKey, snapshot, {');
    expect(orderWriteSource).toContain('afterSalesCompatibleSnapshotKeys: snapshotKeys');

    expect(domainWriteSource).toContain('readDomainSnapshotFromLocalStore(currentStore, snapshotKeys.slice(1))');
    expect(domainWriteSource).toContain(
      'mergeDomainSnapshotIntoLocalStore(currentStore, primarySnapshotKey, legacySnapshot'
    );
    expect(domainWriteSource).toContain(
      'mergeDomainSnapshotIntoLocalStore(baseStore, primarySnapshotKey, snapshot, options)'
    );

    expect(productWriteSource).toContain('readOzonProductSnapshotFromLocalStore(currentStore, snapshotKeys.slice(1))');
    expect(productWriteSource).toContain(
      'mergeOzonProductSnapshotIntoLocalStore(currentStore, primarySnapshotKey, legacySnapshot'
    );
    expect(productWriteSource).toContain(
      'mergeOzonProductSnapshotIntoLocalStore(baseStore, primarySnapshotKey, snapshot, options)'
    );
  });
});
