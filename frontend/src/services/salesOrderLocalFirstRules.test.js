import { describe, expect, it } from 'vitest';
import { readProjectSource } from '../test/appSource';

function readProjectFile(relativePath) {
  return readProjectSource(relativePath);
}

function getFunctionBlock(source, functionName, nextFunctionName) {
  const start = source.indexOf(`function ${functionName}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = nextFunctionName ? source.indexOf(`\nfunction ${nextFunctionName}`, start) : -1;
  return source.slice(start, end > start ? end : undefined);
}

describe('sales order local-first rules', () => {
  it('keeps sales order page local-first but starts real background sync on page entry', () => {
    const salesOrdersPage = readProjectFile('src/features/orders/sales/model/useSalesOrdersSnapshotState.jsx');
    const pagedCacheState = readProjectFile('src/features/orders/sales/model/useSalesOrderPagedCacheState.jsx');
    const pagedCacheClient = readProjectFile('src/services/salesOrderPagedCacheClient.js');

    expect(salesOrdersPage).toMatch(/useSalesOrderPagedCacheState\(\{/u);
    expect(salesOrdersPage).not.toMatch(/useOzonRealtimeSnapshot\(/u);
    expect(pagedCacheState).toMatch(/readSalesOrderPagedCache\(/u);
    expect(pagedCacheState).toMatch(/startDomainRefresh\('orders'/u);
    expect(pagedCacheClient).toMatch(/getDomainCache\('orders'/u);
    expect(pagedCacheClient).not.toMatch(/fetch\(/u);
  });

  it('keeps purchase page entry on SQLite and reserves its precise loader for explicit refresh', () => {
    const purchaseOrdersPage = readProjectFile('src/features/orders/purchase/model/usePurchaseOrdersDatasetState.jsx');
    const preciseLoader = readProjectFile('src/features/orders/purchase/services/purchaseOrderPreciseSyncService.js');

    expect(purchaseOrdersPage).toMatch(
      /useOzonRealtimeSnapshot\(readableShops,\s*requestPurchaseOrdersPreciseSnapshotForShops,\s*\{/u
    );
    expect(purchaseOrdersPage).toMatch(/refreshOnMount:\s*true/u);
    expect(preciseLoader).toContain('if (options.forceRefresh !== true || options.preciseSync === false)');
    expect(preciseLoader).toContain('const snapshot = await readAllSalesOrderPagedCache({');
    expect(purchaseOrdersPage).not.toContain('localDataFileKey:');
    expect(purchaseOrdersPage).not.toContain('localDataSnapshotKey:');
    expect(purchaseOrdersPage).toContain('preciseSync: true');
    expect(purchaseOrdersPage).toMatch(/keepCurrentDataOnForceRefresh:\s*true/u);
  });

  it('passes force refresh from the UI refresh button down to local-api order sync jobs', () => {
    const profitOrderSnapshot = readProjectFile('src/entities/profit/profitOrderSnapshot.jsx');
    const pagedReader = getFunctionBlock(
      profitOrderSnapshot,
      'requestOzonPagedOffset',
      'requestOzonPagedOffsetVariants'
    );
    const salesSnapshot = getFunctionBlock(
      profitOrderSnapshot,
      'requestOzonSalesOrdersSnapshot',
      'enrichPurchaseRowsWithOzonImagesForShops'
    );

    expect(pagedReader).toMatch(/body\.forceRefresh\s*=\s*true/u);
    expect(pagedReader).toMatch(/if\s*\(page\s*===\s*0\)/u);
    expect(pagedReader).toMatch(/body\.autoSync\s*=\s*false/u);
    expect(salesSnapshot).toMatch(/forceRefresh:\s*options\.forceRefresh\s*===\s*true/u);
  });

  it('keeps order reads behind local-api SQLite cache and sync endpoints', () => {
    const localApiClient = readProjectFile('src/api/localApiClient.js');
    const profitOrderSnapshot = readProjectFile('src/entities/profit/profitOrderSnapshot.jsx');
    const pagedReader = getFunctionBlock(
      profitOrderSnapshot,
      'requestOzonPagedOffset',
      'requestOzonPagedOffsetVariants'
    );

    expect(localApiClient).toMatch(/readLocalOrderCacheForOzon/u);
    expect(localApiClient).toMatch(/getDomainCache\(\s*'orders'/u);
    expect(localApiClient).toMatch(/startDomainSync\(\s*'orders'/u);
    expect(localApiClient).toMatch(/waitForLocalOrderSyncJob/u);
    expect(localApiClient).toMatch(/getSyncJob\(jobId/u);
    expect(localApiClient).toMatch(/emitLocalOrderSyncProgress/u);
    expect(localApiClient).toMatch(/onSyncProgress/u);
    expect(localApiClient).toMatch(/LOCAL_ORDER_SYNC_TIMEOUT/u);
    expect(localApiClient).toMatch(/getLocalOrderSyncParams/u);
    expect(localApiClient).toMatch(/syncMaxPages/u);
    expect(pagedReader).toMatch(/body\.autoSync\s*=\s*true/u);
    expect(pagedReader).toMatch(/body\.syncMaxPages\s*=\s*syncMaxPages/u);
    expect(localApiClient).toMatch(/\/v3\/posting\/fbs\/list/u);
    expect(localApiClient).toMatch(/\/v3\/posting\/fbs\/unfulfilled\/list/u);
    expect(localApiClient).toMatch(/\/v2\/posting\/fbo\/list/u);
    expect(localApiClient).not.toMatch(/\/ozon-api/u);
  });

  it('shows explicit sales order refresh feedback without clearing current SQLite rows', () => {
    const salesOrdersSnapshot = readProjectFile('src/features/orders/sales/model/useSalesOrdersSnapshotState.jsx');
    const salesOrdersPageModel = readProjectFile('src/features/orders/sales/model/useSalesOrdersPageModel.jsx');
    const salesOrdersView = readProjectFile('src/features/orders/sales/view/SalesOrdersPageView.jsx');
    const salesFilters = readProjectFile('src/features/orders/sales/model/useSalesOrderFiltersPaginationState.jsx');
    const refreshBlock = salesFilters.slice(
      salesFilters.indexOf('const handleRefreshSalesOrders'),
      salesFilters.indexOf('React.useEffect', salesFilters.indexOf('const handleRefreshSalesOrders'))
    );

    const pagedCacheState = readProjectFile('src/features/orders/sales/model/useSalesOrderPagedCacheState.jsx');
    expect(salesOrdersSnapshot).toMatch(/useSalesOrderPagedCacheState\(\{/u);
    expect(pagedCacheState).toMatch(/startDomainRefresh\('orders'/u);
    expect(salesOrdersPageModel).toMatch(/setSalesNotice,/u);
    expect(salesOrdersPageModel).toMatch(/resetSalesOrderRefreshProgress,/u);
    expect(salesOrdersView).toMatch(
      /import \{ ReadProgressPanel \} from '..\/..\/..\/..\/shared\/ui\/ReadProgressPanel\.jsx'/u
    );
    expect(salesOrdersView).toMatch(/ariaLabel="销售订单读取进度"/u);
    expect(salesOrdersView).toMatch(/后台正在同步 Ozon 销售订单，当前缓存/u);
    expect(salesOrdersSnapshot).toMatch(/salesOrderRefreshProgress/u);
    expect(salesOrdersSnapshot).toMatch(/salesOrderRefreshProgress = orderSync\.progress/u);
    expect(salesOrdersPageModel).toMatch(/salesOrderRefreshProgress/u);
    expect(salesOrdersView).toMatch(/completed=\{salesOrderRefreshProgress\?\.completed\}/u);
    expect(salesOrdersView).toMatch(/total=\{salesOrderRefreshProgress\?\.total\}/u);
    expect(salesOrdersView).toMatch(/errors=\{salesOrderRefreshProgress\?\.errors\}/u);
    expect(salesOrdersView).toMatch(/disabled=\{!readableShops\.length \|\| salesOrderSyncRunning\}/u);
    expect(salesOrdersView).not.toMatch(/<LinearProgress className="order-sync-progress"/u);
    expect(refreshBlock).toMatch(/销售订单同步已提交 Ozon，页面先显示 SQLite 缓存，回读完成后会自动合并。/u);
    expect(refreshBlock).toMatch(/if\s*\(result\)\s*\{[\s\S]*销售订单回读成功，SQLite 已合并。/u);
    expect(refreshBlock).toMatch(/销售订单同步失败，已保留当前 SQLite 缓存，请稍后重试。/u);
    expect(refreshBlock).not.toMatch(/set(?:OrderRows|SalesOrderRows)\(\s*\[\s*\]\s*\)/u);
    expect(refreshBlock).not.toMatch(/销售订单刷新完成|销售订单同步完成/u);
  });

  it('passes after-sales syncMaxPages to returns background sync so 90-day data is not capped to one page', () => {
    const localApiClient = readProjectFile('src/api/localApiClient.js');
    const returnsReader = getFunctionBlock(localApiClient, 'readLocalReturnsCacheForOzon', 'getLogisticsEndpointMeta');

    expect(returnsReader).toMatch(/startDomainSync\(\s*'returns'/u);
    expect(returnsReader).toMatch(
      /maxPages:\s*meta\.detail\s*\?\s*1\s*:\s*body\.syncMaxPages\s*\|\|\s*body\.maxPages\s*\|\|\s*1/u
    );
    expect(returnsReader).toContain('recordNotifications: body.recordNotifications === true');
    expect(returnsReader).toContain('schedulerProfile: body.schedulerProfile');
    expect(returnsReader).toContain('syncSource: body.syncSource');
    expect(returnsReader).toContain("requestedBy: body.requestedBy || 'frontend-returns-legacy-adapter'");
  });

  it('routes protected Ozon order writes through the orders write guard instead of the legacy write adapter', () => {
    const protectedOrderOperations = readProjectFile('src/entities/order/orderShopScope.jsx');
    const marketingOrderFields = readProjectFile('src/entities/marketing/marketingOrderFields.jsx');
    const orderWriteClient = readProjectFile('src/services/orderWriteClient.js');
    const protectedWriter = getFunctionBlock(
      marketingOrderFields,
      'requestProtectedOzonOrderOperation',
      'getSalesPostingNumber'
    );

    expect(marketingOrderFields).toMatch(
      /import \{ requestOrderWriteOperation \} from '..\/..\/services\/orderWriteClient'/u
    );
    expect(marketingOrderFields).toMatch(
      /import \{ requestReturnsWriteOperation \} from '..\/..\/services\/returnsWriteClient'/u
    );
    expect(protectedWriter).toMatch(/requestOrderWriteOperation/u);
    expect(protectedWriter).toMatch(/requestReturnsWriteOperation/u);
    expect(protectedWriter).toMatch(/writeDomain\s*=\s*operation\.domain\s*\|\|\s*'orders'/u);
    expect(protectedWriter).not.toMatch(/requestOzonWrite\(/u);
    expect(protectedWriter).toMatch(/endpointKey:\s*operation\.endpointKey/u);
    expect(orderWriteClient).toMatch(/previewDomainWrite\('orders'/u);
    expect(orderWriteClient).toMatch(/confirmDomainWrite\('orders'/u);
    expect(protectedOrderOperations).toMatch(
      /shipFbsPosting:\s*\{\s*endpoint:\s*'\/v4\/posting\/fbs\/ship',\s*endpointKey:\s*'orders\.shipFbsPosting'/u
    );
  });

  it('keeps logistics out of the orders executor and routes returns to returns executor', () => {
    const orderShopScope = readProjectFile('src/entities/order/orderShopScope.jsx');
    const operationsStart = orderShopScope.indexOf('const ozonProtectedOrderOperations = {');
    const operationsEnd = orderShopScope.indexOf('const crossBorderProtectedOrderOperations', operationsStart);
    const operationsBlock = orderShopScope.slice(operationsStart, operationsEnd);

    expect(operationsBlock).toMatch(/createCarriage:\s*\{\s*endpoint:\s*'\/v1\/carriage\/create',\s*title:/u);
    expect(operationsBlock).toMatch(
      /setRfbsReturnAction:\s*\{[\s\S]*endpoint:\s*'\/v1\/returns\/rfbs\/action\/set'[\s\S]*domain:\s*'returns'[\s\S]*endpointKey:\s*'returns\.setRfbsReturnAction'/u
    );
    expect(operationsBlock).not.toMatch(/createCarriage:.*endpointKey:\s*'orders\./u);
    expect(operationsBlock).not.toMatch(/setRfbsReturnAction:.*endpointKey:\s*'orders\./u);
  });
});
