import { readSplitAppSource } from '../test/appSource';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const appSource = readSplitAppSource();
const appEntrySource = readFileSync(join(process.cwd(), 'src', 'App.jsx'), 'utf8');
const mainSource = readFileSync(join(process.cwd(), 'src', 'main.jsx'), 'utf8');
const productMaterialProfileStoreSource = readFileSync(
  join(process.cwd(), 'src', 'services', 'productMaterialProfileStore.js'),
  'utf8'
);
const productSourceLinkStoreSource = readFileSync(
  join(process.cwd(), 'src', 'services', 'productSourceLinkStore.js'),
  'utf8'
);
const productBusMaterialServiceSource = readFileSync(
  join(process.cwd(), 'src', 'services', 'productBusMaterialService.js'),
  'utf8'
);
const productSyncStateSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'products', 'model', 'useProductSyncState.jsx'),
  'utf8'
);
const productBaseStateSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'products', 'model', 'useProductBaseState.jsx'),
  'utf8'
);
const synchronizedShopSelectionSource = readFileSync(
  join(process.cwd(), 'src', 'entities', 'order', 'useSynchronizedOzonShopSelection.jsx'),
  'utf8'
);
const productLocalMirrorSource = readFileSync(
  join(process.cwd(), 'src', 'entities', 'product', 'productLocalMirror.jsx'),
  'utf8'
);
const productSourceMaterialStateSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'products', 'model', 'useProductSourceMaterialState.jsx'),
  'utf8'
);
const productPaginationStateSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'products', 'model', 'useProductPaginationState.jsx'),
  'utf8'
);
const productListPageModelSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'products', 'model', 'useProductListPageModel.jsx'),
  'utf8'
);
const productBatchStateSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'products', 'model', 'useProductBatchState.jsx'),
  'utf8'
);
const productListPageViewSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'products', 'view', 'ProductListPageView.jsx'),
  'utf8'
);
const productTableRowsSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'products', 'view', 'ProductTableRows.jsx'),
  'utf8'
);
const productArchiveConfirmDialogSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'products', 'ui', 'ProductArchiveConfirmDialog.jsx'),
  'utf8'
);
const productAttributesSource = readFileSync(
  join(process.cwd(), 'src', 'entities', 'product', 'productAttributes.jsx'),
  'utf8'
);
const localDataFileClientSource = readFileSync(
  join(process.cwd(), 'src', 'services', 'localDataFileClient.js'),
  'utf8'
);
const productRowRuntimeSource = readFileSync(join(process.cwd(), 'src', 'services', 'productRowRuntime.js'), 'utf8');
const feeCalculationServiceSource = readFileSync(
  join(process.cwd(), 'src', 'services', 'feeCalculationService.js'),
  'utf8'
);
const productListStart = appSource.indexOf('function ProductListPage');
const productListEnd = appSource.indexOf('function AfterSalesOrdersPage', productListStart);
const productListSource = appSource.slice(productListStart, productListEnd);

function getBalancedSource(source, signature) {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf('{', start + signature.length);
  expect(bodyStart, signature).toBeGreaterThanOrEqual(start + signature.length);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  throw new Error(`Could not find balanced source for ${signature}`);
}

describe('product list local-first rules', () => {
  it('does not keep the deprecated remote full-filter loop', () => {
    expect(appSource).not.toContain('PRODUCT_FULL_FILTER');
    expect(appSource).not.toContain('requestOzonProductFullFilterList');
    expect(appSource).not.toContain('requestOzonProductFullFilterPage');
    expect(appSource).not.toContain('waitForProductFullFilterRetry');
    expect(appSource).not.toContain('getProductListFullFilterCacheKey');
    expect(appSource).not.toContain("console.info('[鍟嗗搧绛涢€夊叏閲廬'");
  });

  it('keeps page performance console output dev-only', () => {
    const logSource = getBalancedSource(appSource, 'function logPagePerformanceReport(report = {})');
    expect(logSource).toContain('if (!import.meta.env.DEV) return;');
    expect(logSource).toContain('safeInfo(');
    expect(logSource).not.toContain('console.info');
    expect(logSource.indexOf('if (!import.meta.env.DEV) return;')).toBeLessThan(logSource.indexOf('safeInfo'));
  });

  it('keeps product page entry SQLite-only and manual refresh behind the typed sync client', () => {
    expect(productSyncStateSource).not.toContain('allowRemote');
    expect(productSyncStateSource).not.toContain('requestOzonProductPage');
    expect(productSyncStateSource).not.toContain('requestOzonOtherStatusPages');
    expect(productSyncStateSource).toContain('if (!cachedRows) {');
    expect(appSource).toContain('readProductListCache({');
    expect(appSource).toContain('loadOzonProducts({ localOnly: true });');
    expect(productSyncStateSource).toContain('startProductListSync(');
    expect(appSource).not.toContain('loadOzonProducts({ force: true, autoSync: false });');
  });

  it('dedupes short-lived local data file reads and invalidates the cache on writes', () => {
    const requestSource = getBalancedSource(
      localDataFileClientSource,
      'async function requestLocalDataFile(key, options = {})'
    );

    expect(appSource).toContain('const LOCAL_DATA_FILE_READ_CACHE_TTL_MS = 8_000;');
    expect(appSource).toContain('const localDataFileReadCache = new Map();');
    expect(requestSource).toContain("const method = options.method || 'GET';");
    expect(requestSource).toContain("if (method === 'GET' && cacheKey)");
    expect(requestSource).toContain('return cached.promise;');
    expect(requestSource).toContain('localDataFileReadCache.delete(cacheKey);');
    expect(requestSource).toContain(
      'localDataFileReadCache.set(cacheKey, { savedAt: Date.now(), promise: requestPromise });'
    );
  });

  it('removes renderer Ozon list reads and leaves remote refresh to the typed local-api client', () => {
    expect(productListStart).toBeGreaterThanOrEqual(0);
    expect(productListEnd).toBeGreaterThan(productListStart);

    expect(productSyncStateSource).not.toContain('/v3/product/list');
    expect(productLocalMirrorSource).not.toContain('/v3/product/list');
    expect(productSyncStateSource).not.toContain('requestOzonReadOnly');
    expect(productLocalMirrorSource).not.toContain('requestOzonReadOnly');
    expect(productSyncStateSource).toContain("requestedBy: 'frontend-product-refresh-current-foreground'");
    expect(productSyncStateSource).toContain('startProductListSync(');
  });

  it('queries one SQLite page on entry and delegates full pagination to local-api sync contracts', () => {
    const loadSource = getBalancedSource(
      productListSource,
      'const loadOzonProducts = React.useCallback(async (options = {}) =>'
    );

    expect(loadSource).toContain('readLocalApiProductPage(localApiTargets, selectedTab, {');
    expect(loadSource).toContain('pageSize,');
    expect(loadSource).toContain('page,');
    expect(loadSource).toContain('filters: normalizedProductListQueryFilters');
    expect(loadSource).not.toContain('collectAllPages');
    expect(loadSource).not.toContain('lastId');
    expect(productSyncStateSource).toContain('maxPages: PRODUCT_MANUAL_REFRESH_SYNC_MAX_PAGES');
  });

  it('refreshes the current product shop scope instead of only the globally active shop', () => {
    const loadSource = getBalancedSource(
      productListSource,
      'const loadOzonProducts = React.useCallback(async (options = {}) =>'
    );
    const refreshSource = getBalancedSource(productListSource, 'const handleRefreshProducts = React.useCallback(() =>');

    expect(productBaseStateSource).toContain('const [shop, setShop] = useSynchronizedOzonShopSelection({');
    expect(productBaseStateSource).toContain('activeShopId,');
    expect(productBaseStateSource).toContain('onScopeChange: () => {');
    expect(synchronizedShopSelectionSource).toContain(
      'const effectiveSelection = scopeChanged ? desiredSelection : selection;'
    );
    expect(productListPageViewSource).toContain('<MenuItem key={item.id} value={item.id}>');
    expect(productListPageViewSource).not.toContain('value={getOzonShopFilterValue(item)}');
    expect(loadSource).toContain('const localApiTargets = productMirrorScopeShops.filter((item) => item?.id);');
    expect(loadSource).toContain('readLocalApiProductPage(localApiTargets, selectedTab, {');
    expect(loadSource).not.toContain('localApiTargets.map');
    expect(loadSource).not.toContain('remoteReadShops');
    expect(refreshSource).toContain('startProductListSync({');
    expect(refreshSource).toContain('allStatuses: true');
    expect(refreshSource).toContain('hydrate: true');
    expect(refreshSource).toContain('maxPages: PRODUCT_MANUAL_REFRESH_SYNC_MAX_PAGES');
    expect(refreshSource).toContain("requestedBy: 'frontend-product-refresh-current-foreground'");
    expect(refreshSource).toContain("requestedBy: 'frontend-product-refresh-full-background'");
    expect(productListSource).toContain('const PRODUCT_MANUAL_REFRESH_CURRENT_HYDRATION_CONCURRENCY = 8;');
    expect(productListSource).toContain('const PRODUCT_MANUAL_REFRESH_FULL_HYDRATION_CONCURRENCY = 12;');
    expect(productListSource).toContain('const PRODUCT_MANUAL_REFRESH_ENRICH_HYDRATION_CONCURRENCY = 2;');
    expect(productListSource).toContain('const PRODUCT_MANUAL_REFRESH_SYNC_PAGE_SIZE = 1000;');
    expect(productListSource).toContain('const PRODUCT_MANUAL_REFRESH_CORE_HYDRATION_BATCH_SIZE = 1000;');
    expect(productListSource).toContain("const PRODUCT_MANUAL_REFRESH_FAST_HYDRATION_MODE = 'fast';");
    expect(productListSource).toContain('const PRODUCT_MANUAL_REFRESH_FOREGROUND_WAIT_TIMEOUT_MS = 30_000;');
    expect(productListSource).toContain("const PRODUCT_MANUAL_REFRESH_FULL_PRIORITY = 'P1';");
    expect(productListSource).toContain("const PRODUCT_MANUAL_REFRESH_FULL_PROFILE = 'foreground';");
    expect(productListSource).toContain("const PRODUCT_MANUAL_REFRESH_ENRICH_PRIORITY = 'P4';");
    expect(productListSource).toContain("const PRODUCT_MANUAL_REFRESH_ENRICH_PROFILE = 'background';");
    expect(productListSource).toContain("const PRODUCT_MANUAL_REFRESH_ARCHIVED_VISIBILITY = 'ARCHIVED';");
    expect(productListSource).toContain('const PRODUCT_MANUAL_REFRESH_FOREGROUND_VISIBILITIES = Object.freeze([');
    expect(productListSource).toContain("'REMOVED_FROM_SALE'");
    expect(productListSource).toContain("const PRODUCT_MANUAL_REFRESH_ARCHIVED_PRIORITY = 'P4';");
    expect(productListSource).toContain("const PRODUCT_MANUAL_REFRESH_ARCHIVED_PROFILE = 'background';");
    expect(refreshSource).toContain('const foregroundVisibilities =');
    expect(refreshSource).toContain("const shouldSubmitCurrentViewRefresh = currentVisibility !== 'ALL';");
    expect(refreshSource).toContain('if (shouldSubmitCurrentViewRefresh) {');
    expect(refreshSource).toContain('visibilities: foregroundVisibilities');
    expect(refreshSource).toContain("profile: 'foreground'");
    expect(refreshSource).toContain('profile: PRODUCT_MANUAL_REFRESH_FULL_PROFILE');
    expect(refreshSource).toContain('schedulerProfile: PRODUCT_MANUAL_REFRESH_FULL_PROFILE');
    expect(refreshSource).toContain('priority: PRODUCT_MANUAL_REFRESH_FULL_PRIORITY');
    expect(refreshSource).toContain('hydrationConcurrency: PRODUCT_MANUAL_REFRESH_CURRENT_HYDRATION_CONCURRENCY');
    expect(refreshSource).toContain('hydrationConcurrency: PRODUCT_MANUAL_REFRESH_FULL_HYDRATION_CONCURRENCY');
    expect(refreshSource).toContain('hydrationMode: PRODUCT_MANUAL_REFRESH_FAST_HYDRATION_MODE');
    expect(refreshSource).toContain('hydrationBatchSize: PRODUCT_MANUAL_REFRESH_CORE_HYDRATION_BATCH_SIZE');
    expect(refreshSource).toContain('pageSize: PRODUCT_MANUAL_REFRESH_SYNC_PAGE_SIZE');
    expect(refreshSource).not.toContain("profile: 'background'");
    expect(refreshSource).not.toContain("priority: 'P4'");
    expect(refreshSource).not.toContain('hydrationConcurrency: 2');
    expect(refreshSource).not.toContain('pageSize: PRODUCT_MANUAL_REFRESH_PAGE_SIZE');
    expect(refreshSource).toContain('maxHydrateProducts: foregroundHydrateLimit');
    expect(refreshSource).not.toContain('const stockResult = await startProductListSync(');
    expect(refreshSource).toContain('Promise.allSettled(');
    expect(refreshSource).toContain('collectProductRefreshJobIds(item.value?.result)');
    expect(refreshSource).toContain('waitForProductRefreshJobs({');
    expect(refreshSource).toContain('timeoutMs: PRODUCT_MANUAL_REFRESH_FOREGROUND_WAIT_TIMEOUT_MS');
    expect(refreshSource).toContain('pendingAsFailed: false');
    expect(refreshSource).toContain('Ozon 慢任务已转后台继续校准，页面已按当前 SQLite 最新快照刷新。');
    expect(refreshSource).toContain('const startBackgroundArchivedStatusSync = () =>');
    expect(refreshSource).toContain("requestedBy: 'frontend-product-refresh-archived-background'");
    expect(refreshSource).not.toContain("hydrationMode: 'details'");
    expect(refreshSource).toContain("hydrationMode: 'full'");
    expect(refreshSource).toContain('正在补齐已下架商品的详情、图片、价格库存、属性与材积');
    expect(refreshSource).toContain('priority: PRODUCT_MANUAL_REFRESH_ARCHIVED_PRIORITY');
    expect(refreshSource).toContain('profile: PRODUCT_MANUAL_REFRESH_ARCHIVED_PROFILE');
    expect(refreshSource).toContain('schedulerProfile: PRODUCT_MANUAL_REFRESH_ARCHIVED_PROFILE');
    expect(refreshSource).toContain('const startBackgroundProductEnrichment = () =>');
    expect(refreshSource).toContain("requestedBy: 'frontend-product-refresh-enrich-background'");
    expect(refreshSource).toContain("hydrationMode: 'full'");
    expect(refreshSource).toContain('priority: PRODUCT_MANUAL_REFRESH_ENRICH_PRIORITY');
    expect(refreshSource).toContain('profile: PRODUCT_MANUAL_REFRESH_ENRICH_PROFILE');
    expect(refreshSource).toContain('schedulerProfile: PRODUCT_MANUAL_REFRESH_ENRICH_PROFILE');
    expect(refreshSource).toContain('startBackgroundArchivedStatusSync();');
    expect(refreshSource).toContain('startBackgroundProductEnrichment();');
    expect(refreshSource).toContain('loadOzonProducts({ localOnly: true });');
    expect(refreshSource).toContain('blocking: true');
    expect(refreshSource).toContain('blocking: false');
    expect(productListSource).toContain('disabled={loading || productRefreshProgress.blocking}');
    expect(productListSource).not.toContain('disabled={loading || productRefreshProgress.running}');
    expect(refreshSource).not.toContain('delayedReload(5_000)');
    expect(refreshSource).not.toContain('delayedReload(15_000, { refreshMirrorIndex: true })');
    expect(refreshSource).not.toContain('delayedReload(60_000, { refreshMirrorIndex: true })');
    expect(refreshSource).not.toContain(
      'if (options.refreshMirrorIndex) setProductRefreshToken((value) => value + 1);'
    );
    expect(loadSource).not.toContain('writeOzonLocalProductSnapshot');
    expect(loadSource).not.toContain('setProductHydrationAllowed');
    expect(loadSource).toContain('productMirrorScopeShops');
    expect(refreshSource).toContain('productMirrorScopeShops.forEach(clearProductListCacheForShop)');
    expect(refreshSource).not.toContain('clearProductListCacheForShop(activeShop);');
    expect(appSource).toContain('observe: options.observe');
    expect(appSource).toContain('observe: false');
    const refreshTasksIndex = refreshSource.indexOf('const refreshTasks =');
    const firstLocalReadIndex = refreshSource.indexOf('loadOzonProducts({ localOnly: true });', refreshTasksIndex);
    const progressStartIndex = refreshSource.indexOf('setProductRefreshProgress({', refreshTasksIndex);
    const waitJobsIndex = refreshSource.lastIndexOf('waitForProductRefreshJobs({');
    const waitThenIndex = refreshSource.indexOf('.then(async (waitResult)', waitJobsIndex);
    const firstCacheClearIndex = refreshSource.lastIndexOf(
      'productMirrorScopeShops.forEach(clearProductListCacheForShop)'
    );
    expect(firstLocalReadIndex).toBeGreaterThanOrEqual(0);
    expect(firstLocalReadIndex).toBeLessThan(waitJobsIndex);
    expect(waitJobsIndex).toBeGreaterThan(progressStartIndex);
    expect(firstCacheClearIndex).toBeGreaterThan(progressStartIndex);
    expect(firstCacheClearIndex).toBeGreaterThan(waitThenIndex);
  });

  it('only treats a product as live hydrated after all five product facets are covered', () => {
    expect(productLocalMirrorSource).toContain('export function isProductFullyHydrated(row = {})');
    expect(productLocalMirrorSource).toContain("['detail', 'detailSyncedAt', 'detail_synced_at']");
    expect(productLocalMirrorSource).toContain("['pictures', 'picturesSyncedAt', 'pictures_synced_at']");
    expect(productLocalMirrorSource).toContain("['prices', 'pricesSyncedAt', 'prices_synced_at']");
    expect(productLocalMirrorSource).toContain("['stocks', 'stocksSyncedAt', 'stocks_synced_at']");
    expect(productLocalMirrorSource).toContain("['attributes', 'attributesSyncedAt', 'attributes_synced_at']");
    expect(productLocalMirrorSource).toContain('liveHydrated: isProductFullyHydrated(row)');
    expect(productSyncStateSource).not.toContain('liveHydrated: isProductFullyHydrated(item)');
    expect(productSourceMaterialStateSource).toContain('setEditingProduct(product);');
    expect(productSourceMaterialStateSource).toContain('opening a dialog never performs an Ozon read');
    expect(productSourceMaterialStateSource).not.toContain('requestSingleOzonProductSnapshot');
    expect(productSourceMaterialStateSource).not.toContain('requestOzonProductSnapshotByOfferId');
  });

  it('keeps refreshed product rows and local mirror rows on the same stable shop identity', () => {
    const normalizeSource = getBalancedSource(appSource, 'function normalizeOzonProductRow(');
    const snapshotRecordsSource = getBalancedSource(
      appSource,
      'function getProductListSnapshotRecordsForShop(store = {}, shop = {}, options = {})'
    );

    expect(normalizeSource).toContain('const localShopKey = getOzonLocalProductPrimaryShopKey(safeShop);');
    expect(normalizeSource).toContain('shopClientId: shopClientId || localShopKey');
    expect(normalizeSource).toContain('localShopKey,');
    expect(snapshotRecordsSource).toContain('const fullSnapshotVisibilities = new Set');
    expect(snapshotRecordsSource).toContain('key.endsWith(`:${visibility}:full`)');
    expect(snapshotRecordsSource).toContain(
      '!fullSnapshotVisibilities.has(matchedVisibility) || key.endsWith(`:${matchedVisibility}:full`)'
    );
  });

  it('uses the shared exchange-rate reader for product list mileage fee without a fixed fallback rate', () => {
    expect(productListSource).toContain('readRubCnyExchangeRateContext([], {');
    expect(productListSource).toContain('const PRODUCT_FEE_EXCHANGE_RATE_TIMEOUT_MS = 8000;');
    expect(productListSource).toContain('setProductFeeRubToCnyRate(context?.realtime?.rubToCnyRate)');
    expect(productListSource).toContain('queueProductFeeExchangeRateMerge');
    expect(productListSource).toContain('applyProductFeeExchangeRateToRows(currentRows, rubToCnyRate)');
    const feeMergeStart = productListSource.indexOf('const queueProductFeeExchangeRateMerge');
    const feeMergeEnd = productListSource.indexOf('const localStart', feeMergeStart);
    const feeMergeSource = productListSource.slice(feeMergeStart, feeMergeEnd);
    expect(feeMergeSource.indexOf('setProducts((currentRows) => applyProductFeeExchangeRateToRows')).toBeLessThan(
      feeMergeSource.indexOf('if (!isCurrentRequest()) return;')
    );
    expect(productRowRuntimeSource).toContain('getProductFeeRubToCnyRate(rubToCnyRate)');
    expect(productRowRuntimeSource).toContain('rubToCnyRate: normalizeOptions.rubToCnyRate');
    expect(productRowRuntimeSource).toContain('getOzonMileageFeeCny(normalizedRubToCnyRate)');
    expect(feeCalculationServiceSource).toContain('return rate === null ? null : amount * rate;');
    expect(feeCalculationServiceSource).not.toContain('DEFAULT_RUB_TO_CNY_RATE');
  });

  it('does not trigger product remote refresh from page-entry effects', () => {
    const productLines = productListSource.split('\n');
    const forceRefreshLines = productLines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes('loadOzonProducts({ force: true });'));

    expect(productListSource).toContain('loadOzonProducts({ localOnly: true });');

    forceRefreshLines.forEach(({ index }) => {
      const previousEffectIndex = productLines
        .slice(0, index)
        .findLastIndex((line) => line.includes('React.useEffect'));
      const previousHandlerIndex = productLines
        .slice(0, index)
        .findLastIndex(
          (line) =>
            line.startsWith('  const handle') ||
            line.startsWith('  const submit') ||
            line.startsWith('  const batch') ||
            line.startsWith('  const save')
        );

      expect(previousHandlerIndex).toBeGreaterThan(previousEffectIndex);
    });
  });

  it('never performs renderer-side product hydration from pagination or page entry', () => {
    expect(productSyncStateSource).not.toContain('setProductHydrationAllowed');
    expect(productPaginationStateSource).not.toContain('requestHydratedOzonProductRows');
    expect(productPaginationStateSource).not.toContain('writeOzonLocalProductSnapshot');
    expect(productPaginationStateSource).not.toContain('saveProductMaterialProfilesFromOzonRows');
    expect(productSyncStateSource).toContain('startProductListSync(');
  });

  it('keeps advanced product filters on the current SQLite query page without browser mirror fallback', () => {
    expect(productListSource).not.toContain('fullFilterProducts');
    expect(productListSource).not.toContain('fullFilterState');
    expect(productListSource).not.toContain('fullFilterRequestRef');
    expect(productListSource).not.toContain('shouldUseFullProductFilterScope');
    expect(productListSource).not.toContain('阶段 2 已暂停自动全量筛选');
    expect(productListSource).not.toContain('requestOzonProductFullFilter');
    expect(productPaginationStateSource).toContain('() => (hasLocalApiServerRowsForCurrentPage ? products : [])');
    expect(productPaginationStateSource).not.toContain('mergeProductSearchMirrorRows');
    expect(productPaginationStateSource).not.toContain('localProductSearchRows');
  });

  it('uses only SQLite-query rows for product filtering before pagination', () => {
    expect(productListStart).toBeGreaterThanOrEqual(0);
    expect(productListEnd).toBeGreaterThan(productListStart);

    expect(productPaginationStateSource).not.toContain('buildRowsIndex');
    expect(productPaginationStateSource).not.toContain('queryRowsIndex');
    expect(productPaginationStateSource).not.toContain('paginateRows');
    expect(productPaginationStateSource).not.toContain('.filter(productMatchesCurrentIndexedBaseFilters)');
    expect(productPaginationStateSource).not.toContain('.filter(productMatchesCurrentAdvancedFilters)');
    expect(productPaginationStateSource).toContain('const filteredProducts = serverPageRows;');
    expect(productListPageModelSource).toContain('createProductListQueryFilters({');
    expect(productListPageModelSource).toContain('productListQueryFilters,');
    expect(productSyncStateSource).toContain('filters: normalizedProductListQueryFilters');
    expect(productLocalMirrorSource).toContain('...filters,');
  });

  it('keeps product pagination bound to SQLite server-page metadata', () => {
    expect(productListSource).not.toContain('usesRemoteProductPaging');
    expect(productListSource).not.toContain('productTotalForPagination');
    expect(productPaginationStateSource).toContain('const productPagination = React.useMemo');
    expect(productPaginationStateSource).toContain('const pageProducts = productPagination.rows');
    expect(productPaginationStateSource).not.toContain('localProductMirrorAllStatusRows');
    expect(productPaginationStateSource).toContain('Number(localProductServerPageMeta?.page) === Number(page)');
    expect(productPaginationStateSource).toContain('Number(localProductServerPageMeta?.total) >= products.length');
    expect(productPaginationStateSource).not.toContain('productMatchesStatusTabForCounts');
    expect(productPaginationStateSource).not.toContain('productCountSourceProducts');
  });

  it('keeps server-backed product total while changing pages so pagination does not snap back to page 1', () => {
    const paginationSource = getBalancedSource(
      productPaginationStateSource,
      'const productPagination = React.useMemo(() =>'
    );

    expect(paginationSource).toContain('const totalRows = Math.max(0, Number(localProductServerPageMeta.total) || 0);');
    expect(paginationSource).toContain('const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));');
    expect(paginationSource).toContain('rows: serverPageRows,');
    expect(paginationSource).not.toContain('products.length');
    expect(paginationSource).not.toContain('sortedProducts');
    expect(productListSource).toContain('共 {productPagination.totalRows} 条');
  });

  it('uses only the matching local-api server page rows for display so page 2 is not polluted by page 1 mirror rows', () => {
    expect(productPaginationStateSource).toContain('const hasLocalApiServerRowsForCurrentPage =');
    expect(productPaginationStateSource).toContain('Number(localProductServerPageMeta?.page) === Number(page)');
    expect(productPaginationStateSource).toContain("(localProductServerPageMeta?.sort || 'stable') === serverSort");
    expect(productPaginationStateSource).toContain('const isWaitingForLocalApiServerPage =');
    expect(productPaginationStateSource).toContain('() => (hasLocalApiServerRowsForCurrentPage ? products : [])');
    expect(productPaginationStateSource).toContain('const filteredProducts = serverPageRows;');
    expect(productPaginationStateSource).not.toContain('mergeProductSearchMirrorRows');
  });

  it('updates current page metadata when a prefetched product page hits memory cache', () => {
    const cachedRowsBranchStart = productListSource.indexOf('if (cachedRows) {');
    const localRowsBranchStart = productListSource.indexOf('} else if (localRows) {', cachedRowsBranchStart);
    const cachedRowsBranchSource = productListSource.slice(cachedRowsBranchStart, localRowsBranchStart);

    expect(cachedRowsBranchStart).toBeGreaterThanOrEqual(0);
    expect(localRowsBranchStart).toBeGreaterThan(cachedRowsBranchStart);
    expect(appSource).toContain('const productListPageMetaMemoryCache = new Map();');
    expect(appSource).toContain('function writeProductListPageMemoryCache(cacheKey, rows = [], meta = {})');
    expect(appSource).toContain('productListPageMetaMemoryCache.delete(key)');
    expect(cachedRowsBranchSource).toContain('const cachedProfileRows = cachedRows;');
    expect(productSyncStateSource).toContain('const cachedPageMeta = cachedRows');
    expect(cachedRowsBranchSource).toContain('const hasMatchingCachedPageMeta = Boolean(');
    expect(cachedRowsBranchSource).toContain('const cachedTotal = hasMatchingCachedPageMeta');
    expect(cachedRowsBranchSource).toContain('setLocalProductServerPageMeta({');
    expect(cachedRowsBranchSource).toContain("source: 'memory-cache'");
    expect(cachedRowsBranchSource).toContain('page,');
    expect(cachedRowsBranchSource).toContain('pageSize,');
  });

  it('keeps previous product status totals while re-reading mirrors so status cards do not flash page-size counts', () => {
    expect(productSyncStateSource).toContain("if (localApiPage?.counts && typeof localApiPage.counts === 'object') {");
    expect(productSyncStateSource).toContain(
      'setLocalProductMirrorStatusCounts({ scopeKey: productMirrorScopeKey, counts: localApiStatusCounts });'
    );
    expect(productSyncStateSource).toContain(
      "if (cachedPageMeta?.statusCounts && typeof cachedPageMeta.statusCounts === 'object') {"
    );
    expect(productPaginationStateSource).toContain('const visibleProductStatusCounts = scopedStatusCounts;');
    expect(productPaginationStateSource).not.toContain('buildProductStatusCountsFromRows');
  });

  it('normalizes product list price currency to CNY display instead of leaking RUB into the price column', () => {
    const currencySource = getBalancedSource(appSource, 'function normalizeProductListPriceCurrencyCode(currencyCode)');
    expect(currencySource).toContain("normalized === 'RUB'");
    expect(currencySource).toContain("normalized === 'RUR'");
    expect(currencySource).toContain("normalized === 'RMB'");
    expect(currencySource).toContain("return 'CNY';");
    expect(appSource).toContain(
      'currency_code: normalizeProductListPriceCurrencyCode(row.currencyCode || row.currency_code)'
    );
  });

  it('uses Ozon marketing price before seller and base prices in product display helpers', () => {
    const priceSource = getBalancedSource(
      productAttributesSource,
      'export function getOzonPriceValue(detail, priceInfo)'
    );
    const commissionBaseSource = getBalancedSource(
      productAttributesSource,
      'export function getOzonCommissionBasePrice(detail, priceInfo)'
    );

    expect(priceSource.indexOf('priceInfo?.price?.marketing_price')).toBeLessThan(
      priceSource.indexOf('priceInfo?.price?.marketing_seller_price')
    );
    expect(priceSource.indexOf('priceInfo?.price?.marketing_seller_price')).toBeLessThan(
      priceSource.indexOf('priceInfo?.price?.price')
    );
    expect(commissionBaseSource.indexOf('priceInfo?.price?.marketing_price')).toBeLessThan(
      commissionBaseSource.indexOf('priceInfo?.price?.marketing_seller_price')
    );
  });

  it('counts all products across every Ozon status for the software all-products card', () => {
    const countMatchSource = getBalancedSource(
      appSource,
      'function productMatchesStatusTabForCounts(product = {}, tab = {})'
    );
    const catalogReadSource = getBalancedSource(
      appSource,
      'function readLocalProductCatalogRowsFromStore(store = {}, shops = [], options = {})'
    );

    expect(appSource).toContain("function getProductVisibilityFromSnapshotKey(snapshotKey = '')");
    expect(countMatchSource).toContain("if (visibility === 'ALL')");
    expect(countMatchSource).toContain('return true;');
    expect(countMatchSource).toContain("normalizeProductStatusLabel(product?.status || '') === tab.label");
    expect(catalogReadSource).toContain('const snapshotVisibility = getProductVisibilityFromSnapshotKey(snapshotKey);');
    expect(catalogReadSource).toContain('productSnapshotVisibility: snapshotVisibility');
    expect(catalogReadSource).toContain('productSnapshotVisibilities: getOzonLocalUniqueValues([snapshotVisibility])');
  });

  it('reads one canonical SQLite page for the complete shop scope without a renderer full-mirror fallback', () => {
    const canonicalPageSource = getBalancedSource(
      productLocalMirrorSource,
      'export async function readLocalApiProductPage(shopOrShops, selectedTab, options = {})'
    );

    expect(canonicalPageSource).toContain('const shopIds = shops');
    expect(canonicalPageSource).toContain('shopIds,');
    expect(canonicalPageSource).toContain('const filters = normalizeProductListQueryFilters(options.filters);');
    expect(canonicalPageSource).toContain('const cache = await readProductListCache(');
    expect(canonicalPageSource).toContain('...filters,');
    expect(canonicalPageSource).not.toContain('readOzonProductRowsFromLocalStore');
    expect(canonicalPageSource).not.toContain('readLocalDataFile');
    expect(productSyncStateSource).toContain('readLocalApiProductPage(localApiTargets, selectedTab, {');
    expect(productSyncStateSource).not.toContain('readLocalProductMirrorRowsForShops');
    expect(productSyncStateSource).not.toContain('readLocalProductSearchMirrorRows');
    expect(productPaginationStateSource).not.toContain('localProductMirrorRows');
    expect(productPaginationStateSource).not.toContain('localProductSearchRows');
  });

  it('prefers complete product snapshot status totals over partial local row counts', () => {
    expect(productSyncStateSource).toContain(
      'const pageCounts = mapProductCacheCountsToStatusLabels(localApiPage?.counts);'
    );
    expect(productSyncStateSource).toContain('localApiStatusCounts[tab.label] = Number(pageCounts[tab.label]) || 0;');
    expect(productSyncStateSource).toContain('statusCounts: localApiStatusCounts,');
    expect(productPaginationStateSource).toContain('const scopedStatusCounts =');
    expect(productPaginationStateSource).toContain('const visibleProductStatusCounts = scopedStatusCounts;');
    expect(productPaginationStateSource).not.toContain('products.reduce');
    expect(productPaginationStateSource).not.toContain('setStatusCounts');
    expect(productPaginationStateSource).not.toContain('productRemoteTotal');
    expect(productPaginationStateSource).toContain('visibleProductStatusCounts,');
  });

  it('repairs partially overwritten local product fee rows from consistent fee totals', () => {
    const normalizeSource = getBalancedSource(
      appSource,
      'function normalizeLocalMirrorProductRow(entity = {}, shop = {})'
    );

    expect(appSource).toContain('function roundLocalMirrorMoney(value)');
    expect(normalizeSource).toContain('const derivedCommissionAmountValue');
    expect(normalizeSource).toContain('feeTotalValue - acquiringFeeValue - mileageFeeValue');
    expect(normalizeSource).toContain('const shouldUseDerivedCommission');
    expect(normalizeSource).toContain('const shouldUseDerivedPrice');
    expect(normalizeSource).toContain('formatOzonPrice(commissionAmountValue, currencyCode)');
  });

  it('restores local mirror product category names from Ozon category ids', () => {
    const normalizeSource = getBalancedSource(
      appSource,
      'function normalizeLocalMirrorProductRow(entity = {}, shop = {})'
    );
    const categorySource = getBalancedSource(appSource, 'function getLocalMirrorProductCategoryName(entity = {})');

    expect(appSource).toContain('function isPlaceholderProductCategory(value)');
    expect(categorySource).toContain(
      'const descriptionCategoryId = firstFilled(entity.descriptionCategoryId, entity.description_category_id);'
    );
    expect(categorySource).toContain('const typeId = firstFilled(entity.typeId, entity.type_id);');
    expect(categorySource).toContain('getOzonCategoryPathByIds({ typeId, descriptionCategoryId })');
    expect(categorySource).toContain(
      'if (indexedCategoryPath && isPlaceholderProductCategory(cachedCategory)) return indexedCategoryPath;'
    );
    expect(normalizeSource).toContain('category: getLocalMirrorProductCategoryName(entity)');
  });

  it('does not reread the product mirror just because visible rows change', () => {
    expect(productSyncStateSource).not.toContain('productRefreshToken, products.length');
    expect(productSyncStateSource).not.toContain('readLocalProductMirrorRowsForShops');
    expect(productSyncStateSource).not.toContain('readLocalProductMirrorStatusCountsForShops');
    expect(productSyncStateSource).not.toContain('readLocalProductSearchMirrorRows');
    expect(productSyncStateSource).not.toContain('products.length');
    expect(productSyncStateSource).not.toContain('renderedPageProducts');
    expect(productSyncStateSource).toContain('productListQueryFilterSignature,');
    expect(productSyncStateSource).toContain('productRefreshToken,');
  });

  it('keeps the current local product page hot across workspace hide and reactivation', () => {
    expect(productSyncStateSource).toContain("const productPageLoadKeyRef = React.useRef('');");
    expect(productSyncStateSource).toContain("const productPageLoadPendingKeyRef = React.useRef('');");
    expect(productSyncStateSource).toContain(
      'if (activityRuntime?.subscribe) return activityRuntime.subscribe(applyActivity);'
    );
    expect(productSyncStateSource).toContain("].join('\\u0001');");
    expect(productSyncStateSource).toContain('if (!nextActive) {');
    expect(productSyncStateSource).toContain('productPageLoadAttemptRef.current += 1;');
    expect(productSyncStateSource).toContain('loadAbortRef.current?.abort();');
    expect(productSyncStateSource).toContain('if (productPageLoadKeyRef.current === productPageLoadKey) return;');
    expect(productSyncStateSource).toContain(
      'if (productPageLoadPendingKeyRef.current === productPageLoadKey) return;'
    );
    expect(productSyncStateSource).toContain(
      'if (productPageLoadAttemptRef.current !== attemptId || !isActiveRef.current) return;'
    );
    expect(productSyncStateSource).not.toContain('if (!localResult?.hasLocalData && canReadOzon) {');
    expect(productSyncStateSource).toContain('Opening the page is a pure SQLite query.');
  });

  it('keeps product editing and the category tree out of the list cold path', () => {
    expect(productListPageViewSource).toContain('const ProductEditDialog = React.lazy(() =>');
    expect(productListPageViewSource).toContain("import('../ui/ProductEditDialog.jsx')");
    expect(productListPageViewSource).toContain('{editingProduct ? (');
    expect(productListPageViewSource).not.toContain("import { ProductEditDialog } from '../ui/ProductEditDialog.jsx';");
  });

  it('does not keep deprecated page-level product supplement snapshot writers', () => {
    expect(appSource).not.toContain('function writeOzonLocalProductSupplementRowsForShops');
    expect(appSource).not.toContain('function getOzonLocalProductSupplementSnapshotKey');
    expect(appSource).not.toContain('ozon-product-supplements:');
  });

  it('does not warn for aborted partial product detail reads', () => {
    const functionIndex = appSource.indexOf('async function requestOzonProductInfoListSafely');
    const abortGuardIndex = appSource.indexOf(
      'if (allowPartial && isOzonAbortReadError(error)) return;',
      functionIndex
    );
    const singleItemWarnIndex = appSource.indexOf('safeWarn(`Ozon 商品详情单项读取失败', functionIndex);

    expect(appSource).toContain('function isOzonAbortReadError(error)');
    expect(appSource).toContain("classifyOzonRequestError(error).type === 'abort'");
    expect(functionIndex).toBeGreaterThanOrEqual(0);
    expect(abortGuardIndex).toBeGreaterThanOrEqual(0);
    expect(singleItemWarnIndex).toBeGreaterThan(abortGuardIndex);
  });

  it('does not keep unused product attribute wrapper helpers after the edit rows path took over', () => {
    expect(appSource).toContain('function buildProductAttributeEditRows');
    expect(appSource).not.toContain('function buildProductAttributeDefinitionMap');
    expect(appSource).not.toContain('function getProductAttributeRows');
  });

  it('keeps SQLite-primary product material and source links out of browser writes and retries canonical writes', () => {
    const materialSaveSource = getBalancedSource(
      productMaterialProfileStoreSource,
      'export function saveProductMaterialProfiles(profiles)'
    );
    const sourceLinkSaveSource = getBalancedSource(
      productSourceLinkStoreSource,
      'export function saveProductSourceLinkRecord({ key, record, product = {}, timeoutMs = 3000 } = {})'
    );
    const sourceLinkLegacyWriteSource = getBalancedSource(
      productSourceLinkStoreSource,
      'async function writeLegacyFallback(records = {}, task)'
    );

    expect(materialSaveSource).not.toContain(
      'writeLocalDataFileAdapter(LOCAL_PRODUCT_MATERIAL_FILE_KEY, safeProfiles)'
    );
    expect(productMaterialProfileStoreSource).toContain('retryTransientLocalApiWrite');
    expect(productMaterialProfileStoreSource).not.toContain('if (result.failedKeys.length) {');
    expect(materialSaveSource).not.toContain('window.localStorage.setItem(PRODUCT_MATERIAL_PROFILE_STORAGE_KEY');
    expect(sourceLinkSaveSource).toContain('saveProductSourceLinksToLocalApi(payload, { timeoutMs })');
    expect(sourceLinkSaveSource).toContain('retryTransientLocalApiWrite');
    expect(sourceLinkSaveSource).toContain("if (!result?.ok) throw new Error('PRODUCT_SOURCE_LINK_SAVE_FAILED');");
    expect(sourceLinkSaveSource).not.toContain('writeLegacyFallback');
    expect(sourceLinkSaveSource).not.toContain('writeLocalDataFile');
    expect(productSourceLinkStoreSource).toContain('await writeLegacyFallback({}, task);');
    expect(sourceLinkLegacyWriteSource).toContain('if (task.excludedOwnerIds.size) return;');
    expect(sourceLinkLegacyWriteSource).toContain('await writeLocalDataFile(LOCAL_PRODUCT_SOURCE_FILE_KEY, records);');
    expect(sourceLinkLegacyWriteSource.indexOf('if (task.excludedOwnerIds.size) return;')).toBeLessThan(
      sourceLinkLegacyWriteSource.indexOf('await writeLocalDataFile(')
    );
    expect(productSourceLinkStoreSource).not.toContain('window.localStorage.setItem');
    expect(mainSource).not.toContain('BROWSER_LOCAL_STORAGE_MIRROR_KEYS');
  });

  it('migrates legacy product material during App bootstrap without waiting for the products page', () => {
    expect(appEntrySource).toContain(
      "import { hydrateProductMaterialProfilesFromLocalFile } from './services/productMaterialProfileStore';"
    );
    expect(appEntrySource).toContain('return Promise.all([');
    expect(appEntrySource).toContain('hydrateProductMaterialProfilesFromLocalFile().catch((error) => {');
    expect(appEntrySource).toContain("safeWarn('[商品材积] 本地迁移失败，已保留旧副本', error);");
    expect(appEntrySource).toContain(
      "import { migrateLegacyProductSourceLinksAtStartup } from './services/productSourceLinkStore.js';"
    );
    expect(appEntrySource).toContain('migrateLegacyProductSourceLinksAtStartup(store.shops)');
    expect(appEntrySource).toContain("safeWarn('[商品来源链接] 本地迁移失败，已保留旧副本', error);");
    expect(appEntrySource).toContain(
      "import { migrateLegacyPurchaseOrderOverridesAtStartup } from './services/purchaseOrderRuntime.js';"
    );
    expect(appEntrySource).toContain('migrateLegacyPurchaseOrderOverridesAtStartup()');
    expect(appEntrySource).toContain("safeWarn('[采购订单手工覆盖] 本地迁移失败，已保留旧副本', error);");
    const shopHydrationIndex = appEntrySource.indexOf('hydrateOzonShopSettingsWithRetry({');
    const materialHydrationIndex = appEntrySource.indexOf(
      'hydrateProductMaterialProfilesFromLocalFile().catch((error) => {'
    );
    const sourceLinkHydrationIndex = appEntrySource.indexOf('migrateLegacyProductSourceLinksAtStartup(store.shops)');
    const purchaseOverrideHydrationIndex = appEntrySource.indexOf('migrateLegacyPurchaseOrderOverridesAtStartup()');
    expect(shopHydrationIndex).toBeGreaterThanOrEqual(0);
    expect(materialHydrationIndex).toBeGreaterThan(shopHydrationIndex);
    expect(sourceLinkHydrationIndex).toBeGreaterThan(shopHydrationIndex);
    expect(purchaseOverrideHydrationIndex).toBeGreaterThan(shopHydrationIndex);
  });

  it('saves cross-border bus material canonically without automatic Ozon write', () => {
    const busReadStart = productBusMaterialServiceSource.indexOf(
      'export async function saveProductBusMaterialFromRead'
    );
    const busReadEnd = productBusMaterialServiceSource.indexOf(
      'export async function readAndSaveProductBusMeasurement',
      busReadStart
    );
    const busReadSource = productBusMaterialServiceSource.slice(busReadStart, busReadEnd);
    const busMeasurementSource = productBusMaterialServiceSource.slice(busReadEnd);

    expect(busReadStart).toBeGreaterThanOrEqual(0);
    expect(busReadEnd).toBeGreaterThan(busReadStart);
    expect(busReadSource).toContain('saveProductBusMaterialFromRead');
    expect(busReadSource).toContain("status: 'saved-local'");
    expect(busMeasurementSource).toContain('readAndSaveProductBusMeasurement');
    expect(productListSource).not.toContain('syncSavedProductBusMaterialToOzon');
    expect(productListSource).toContain('本次读取不会自动写入 Ozon');
    expect(productListSource).toContain('本次读取未自动写入 Ozon');
    expect(busReadSource).toContain('await saveCrossBorderProductMaterialProfileCanonical');
    expect(appSource).toContain('export async function syncSavedProductBusMaterialToOzon');
    expect(appSource).toContain('humanConfirmed: false');
    expect(appSource).toContain("status: 'preview-ready'");
    expect(appSource).not.toContain('requestOzonImportInfo');
    expect(appSource).not.toContain('requestSingleOzonProductSnapshot');

    expect(productBusMaterialServiceSource).not.toContain('readAndSyncProductBusMeasurement');
    expect(productBusMaterialServiceSource).not.toContain('syncPurchaseOrderMaterialToProduct');
    expect(productBusMaterialServiceSource).not.toContain('resolvePurchaseMaterialTarget');
    expect(productBusMaterialServiceSource).not.toContain('getProductMaterialDifference');
    expect(busReadSource).not.toContain('submitProductInfoWrite');
    expect(busReadSource).not.toContain('宸蹭繚瀛樻湰鍦板苟鍥炰紶 Ozon');
    expect(busReadSource).not.toContain('宸叉彁浜?Ozon');
  });

  it('keeps a single human confirmation and waits for local-api readback before completion', () => {
    expect(productListSource).toContain('options.humanConfirmed !== true');
    expect(productListSource).toContain('submitProductInfoWrite');
    expect(productListSource).toContain('submitProductPriceWrite');
    expect(productListSource).toContain('submitProductStockWrite');
    expect(productListSource).toContain('isProductWriteReadbackComplete');
    expect(productListSource).toContain('await loadOzonProducts({ localOnly: true, force: true })');
    expect(productListSource).not.toContain('fastAck: true');
    expect(productListSource).not.toContain('pollProductListSyncJob');
    expect(productListSource).not.toContain('requestOzonProductArchive');
    expect(productListSource).not.toContain('requestOzonProductUnarchive');
    expect(productListSource).not.toContain('window.confirm');
    expect(productListPageViewSource).toContain('<ProductArchiveConfirmDialog');

    const legacyFastAckContractStillEnabled = appSource.includes('__LEGACY_PRODUCT_FAST_ACK_CONTRACT__');
    if (legacyFastAckContractStillEnabled) {
      const productWriteHelpers = [
        'async function requestOzonProductImport(shop, product, form, options = {})',
        'async function requestOzonPriceUpdate(shop, product, form, options = {})',
        'async function requestOzonStockBatchUpdate(shop, stockItems, options = {})',
        'async function requestOzonProductArchive(shop, product, options = {})',
        'async function requestOzonProductUnarchive(shop, product, options = {})',
      ];
      const marketingWriteHelpers = [
        'async function requestOzonMarketingActivateProducts(shop, activity, products, percent, options = {})',
        'async function requestOzonMarketingDeactivateProducts(shop, activity, products, options = {})',
      ];

      for (const signature of productWriteHelpers) {
        const helperSource = getBalancedSource(appSource, signature);
        expect(helperSource).toContain('runProductWriteGuard');
        expect(helperSource).not.toContain('requestOzonWrite(');
        expect(helperSource).not.toContain('{ confirmed: true }');
      }

      for (const signature of marketingWriteHelpers) {
        const helperSource = getBalancedSource(appSource, signature);
        expect(helperSource).toContain('confirmed: options.confirmed === true');
        expect(helperSource).not.toContain('{ confirmed: true }');
      }

      const stockSubmitSource = getBalancedSource(
        appSource,
        'async function submitOzonStockBatches(shop, rows, options = {})'
      );
      const stockUpdateSource = getBalancedSource(
        appSource,
        'async function requestOzonStockUpdate(shop, product, form, options = {})'
      );
      const saveProductSource = getBalancedSource(
        productListSource,
        'const handleSaveProduct = async (form, options = {}) =>'
      );

      expect(stockSubmitSource).toContain(
        'requestOzonStockBatchUpdate(shop, chunk.map((row) => row.stockItem), options)'
      );
      expect(stockSubmitSource).toContain('requestOzonStockBatchUpdate(shop, [row.stockItem], options)');
      expect(stockSubmitSource).not.toContain('{ confirmed: true }');
      expect(stockUpdateSource).toContain(
        'requestOzonStockBatchUpdate(shop, [buildOzonStockUpdateItem(product, stock)], options)'
      );
      expect(saveProductSource).toContain('const writeOptions = createProductFastWriteOptions(options);');
      expect(saveProductSource).toContain('requestOzonProductImport(activeShop, editingProduct, form, writeOptions)');
      expect(saveProductSource).toContain('requestOzonPriceUpdate(activeShop, editingProduct, form, writeOptions)');
      expect(saveProductSource).toContain('requestOzonStockUpdate(activeShop, editingProduct, form, writeOptions)');
      expect(saveProductSource).not.toContain('await loadOzonProducts({ force: true })');
      expect(saveProductSource).not.toContain('await requestSingleOzonProductSnapshot');
      expect(saveProductSource).toContain('void runProductSaveBackgroundConfirmation');
      expect(productListSource).not.toContain('window.confirm');
      expect(productListSource).toContain('archiveConfirmDialog.open');
      expect(productListPageViewSource).toContain('<ProductArchiveConfirmDialog');
      expect(productArchiveConfirmDialogSource).toContain('确认${actionText}');
      expect(appSource).toContain('fastAck: true');
      expect(appSource).toContain('asyncWrite: true');
      expect(appSource).toContain('waitForResult: false');
      expect(productListSource).toContain(
        'submitOzonStockBatches(activeShop, stockRows, createProductFastWriteOptions())'
      );
      expect(productListSource).toContain(
        'void executeBatchStockWrite({ action, products: productsForBatch, stockValue, warehouseId })'
      );
      expect(productListSource).toMatch(
        /const writeOptions\s*=\s*\{\s*confirmed:\s*true,\s*realWrite:\s*true,\s*dryRun:\s*false,\s*fastAck:\s*true,\s*asyncWrite:\s*true,\s*waitForResult:\s*false,?\s*\};/u
      );
      expect(productListSource).toContain('requestOzonProductArchive(writeShop, writableProduct, writeOptions)');
      expect(productListSource).toContain('requestOzonProductUnarchive(writeShop, writableProduct, writeOptions)');

      const archiveConfirmSource = getBalancedSource(
        productListSource,
        'const handleConfirmProductArchiveAction = () =>'
      );
      const archiveActionSource = getBalancedSource(
        productListSource,
        'const handleProductArchiveAction = (product, action) =>'
      );
      const archiveFastFlowSource = getBalancedSource(
        productListSource,
        'const startProductArchiveFastFlow = (writableProduct, action) =>'
      );
      const archiveExecuteSource = getBalancedSource(
        productListSource,
        'const executeSingleProductArchiveWrite = async ({ action, writableProduct, writeShop, actionText, operationKey }) =>'
      );
      expect(archiveActionSource).toContain('setArchiveConfirmDialog({');
      expect(archiveActionSource).toContain('open: true');
      expect(archiveActionSource).toContain('product: { ...product, productId }');
      expect(archiveActionSource).not.toContain('startProductArchiveFastFlow({ ...product, productId }, action)');
      expect(archiveConfirmSource).not.toContain('await loadOzonProducts({ force: true })');
      expect(archiveConfirmSource).not.toContain('await requestOzonProductArchive');
      expect(archiveConfirmSource).not.toContain('await requestOzonProductUnarchive');
      expect(archiveConfirmSource).toContain("setArchiveConfirmDialog({ open: false, action: '', product: null });");
      expect(archiveConfirmSource).toContain('startProductArchiveFastFlow(writableProduct, action)');
      expect(archiveFastFlowSource).toContain('applyProductArchiveOptimisticState(writableProduct, action)');
      expect(archiveFastFlowSource).toContain(
        'void executeSingleProductArchiveWrite({ action, writableProduct, writeShop, actionText, operationKey })'
      );
      expect(archiveExecuteSource).toContain('waitForResult: false');
      expect(archiveExecuteSource).not.toContain('await loadOzonProducts({ force: true })');
      expect(archiveExecuteSource).toContain('writeAccepted');
      expect(appSource).toContain('const PRODUCT_ARCHIVE_WRITE_FAILED_STATUSES = new Set');
      expect(appSource).toContain('function getProductArchiveWriteJobId(writeResult = {})');
      expect(archiveExecuteSource).toContain('const writeJobId = getProductArchiveWriteJobId(writeResult);');
      expect(archiveExecuteSource).toMatch(
        /pollProductListSyncJob\(writeJobId,\s*\{\s*intervalMs:\s*700,\s*timeoutMs:\s*20_000,?\s*\}\)/u
      );
      expect(archiveExecuteSource).toContain('PRODUCT_ARCHIVE_WRITE_FAILED_STATUSES.has(jobStatus)');
      expect(archiveExecuteSource).toContain("if (jobStatus === 'timeout')");
      expect(archiveExecuteSource).toContain('restoreProductArchiveOriginalState(writableProduct, action);');
      expect(archiveExecuteSource).toContain('已提交或请求超时，正在等待 Ozon 回读，不能标记为完成。');
      expect(archiveExecuteSource).not.toContain(
        'pollProductListSyncJob(writeJobId, { intervalMs: 500, timeoutMs: 90_000 })'
      );
      expect(productTableRowsSource).toContain('pendingProductArchiveKeys.has(productArchiveOperationKey)');
      expect(productTableRowsSource).toContain('const productWritePending = Boolean(product.optimisticWritePending);');
      expect(productTableRowsSource).toContain('productWritePending ||');
      expect(productTableRowsSource).toContain(
        'className="product-status-chip tone-warning">\u5f85\u56de\u8bfb</span>'
      );
      expect(productTableRowsSource).toContain(
        "productArchiveOperationPending || productWritePending ? '\u5904\u7406\u4e2d'"
      );
    }
  });

  it('drops stale batch warehouse reads before they can refill the stock dialog', () => {
    const batchWarehouseStart = productBatchStateSource.indexOf('const loadBatchWarehouses = React.useCallback');
    const batchWarehouseEnd = productBatchStateSource.indexOf(
      'const openBatchDialog = (action) =>',
      batchWarehouseStart
    );
    const batchWarehouseSource = productBatchStateSource.slice(batchWarehouseStart, batchWarehouseEnd);
    const openBatchDialogSource = getBalancedSource(productBatchStateSource, 'const openBatchDialog = (action) =>');

    expect(batchWarehouseStart).toBeGreaterThanOrEqual(0);
    expect(batchWarehouseEnd).toBeGreaterThan(batchWarehouseStart);
    expect(productBatchStateSource).toContain('getSingleProductOwnerShop(selectedProducts, shops)');
    expect(productBatchStateSource).toContain('const batchOwnerShopIdRef = React.useRef(batchOwnerShopId);');
    expect(productBatchStateSource).toContain('batchOwnerShopIdRef.current = batchOwnerShopId;');
    expect(batchWarehouseSource).toContain('const requestId = batchWarehouseRequestRef.current + 1;');
    expect(batchWarehouseSource).toContain('batchWarehouseRequestRef.current === requestId');
    expect(batchWarehouseSource).toContain('batchOwnerShopIdRef.current === batchOwnerShopId');
    expect(batchWarehouseSource).toContain('if (!isCurrentBatchWarehouseRequest()) return [];');
    expect(batchWarehouseSource).toContain('readProductWarehouseOptions(batchOwnerShopId)');
    expect(batchWarehouseSource).not.toContain('activeShop');

    expect(openBatchDialogSource).toContain('void loadBatchWarehouses().then((warehouses) => {');
    expect(openBatchDialogSource).toContain('if (!warehouseId) return;');
    expect(openBatchDialogSource).not.toContain('requestOzonWarehouseConfigSnapshot(activeShop)');
  });

  it('uses cached SQLite warehouse stock and typed writes for batch stock changes', () => {
    const batchStockSource = getBalancedSource(
      productBatchStateSource,
      'const executeBatchStockWrite = async (action, products, stockValue, warehouseId) =>'
    );

    expect(batchStockSource).not.toContain('requestOzonProductStocksForBatchWarehouse');
    expect(batchStockSource).toContain('const ownerShop = getSingleProductOwnerShop(products, shops);');
    expect(batchStockSource).toContain('getLocalProductStockForWarehouse(product, warehouseId)');
    expect(batchStockSource).toContain('buildProductStockWriteCommand(ownerShop, chunk');
    expect(batchStockSource).toContain('submitProductStockWrite(command, strictWriteOptions())');
    expect(batchStockSource).toContain('isProductWriteReadbackComplete(result)');
    expect(batchStockSource).not.toContain('activeShop');
  });

  it('keeps warehouse reads exact and never substitutes the v4 all-channel total', () => {
    const exactWarehouseReadSource = getBalancedSource(
      productAttributesSource,
      "export async function requestOzonProductStocksForBatchWarehouse(shop, products = [], warehouseId = '')"
    );
    const cachedWarehouseReadSource = getBalancedSource(
      productBatchStateSource,
      "export function getLocalProductStockForWarehouse(product = {}, warehouseId = '')"
    );

    expect(exactWarehouseReadSource).toContain('requestOzonProductStocksByWarehouse(shop, products, warehouseId)');
    expect(exactWarehouseReadSource).not.toContain('requestOzonProductStocks(shop');
    expect(exactWarehouseReadSource).not.toContain('fallbackStocks');
    expect(cachedWarehouseReadSource).toContain('COMPLETE_WAREHOUSE_STOCK_STATUSES.has(observationStatus)');
    expect(cachedWarehouseReadSource).toContain('getOzonWarehouseStockQuantity(stockInfo, safeWarehouseId)');
    expect(cachedWarehouseReadSource).not.toContain('product.stock ?? product.stockValue');
  });
});
