import { describe, expect, it } from 'vitest';
import { formatOzonOrderDateTime } from '../entities/order/orderShopScope.jsx';
import { readProjectSource, readSplitAppSource } from '../test/appSource';

const appSource = readSplitAppSource();
const salesOrderViewSource = readProjectSource('src/features/orders/sales/view/SalesOrdersPageView.jsx');
const salesOrderSnapshotSource = readProjectSource('src/features/orders/sales/model/useSalesOrdersSnapshotState.jsx');
const salesOrderFilterSource = readProjectSource('src/features/orders/sales/model/useSalesOrderFiltersPaginationState.jsx');
const salesOrderSelectionSource = readProjectSource('src/features/orders/sales/model/useSalesOrderSelectionState.jsx');
const salesOrderPagedCacheSource = readProjectSource('src/features/orders/sales/model/useSalesOrderPagedCacheState.jsx');
const salesOrderCacheClientSource = readProjectSource('src/services/salesOrderPagedCacheClient.js');

function getPageSource(startSignature, endSignature) {
  const start = appSource.indexOf(startSignature);
  const end = appSource.indexOf(endSignature, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return appSource.slice(start, end);
}

describe('sales order detail same-source rules', () => {
  it('does not fetch a separate sales detail when selecting a row', () => {
    const salesSources = [salesOrderSnapshotSource, salesOrderFilterSource, salesOrderSelectionSource, salesOrderPagedCacheSource];
    salesSources.forEach((source) => {
      expect(source).not.toContain('shouldLoadSelectedDetail');
      expect(source).not.toContain('setShouldLoadSelectedDetail');
      expect(source).not.toContain('requestOzonSalesOrderDetail(selectedOrderShop');
    });
    expect(salesOrderSelectionSource).toContain('detailOrder: selectedOrder,');
  });

  it('keeps the sales detail derived from the visible list dataset', () => {
    expect(salesOrderSnapshotSource).toContain('const orderRows = React.useMemo(');
    expect(salesOrderSnapshotSource).toContain('mergeSalesOrderVisibleSupplement(order, enhancedOrder)');
    expect(salesOrderFilterSource).toContain('const visibleOrders = React.useMemo(');
    expect(salesOrderSelectionSource).toMatch(
      /const selectedOrder\s*=\s*visibleOrders\.find\(\(order\) => getSalesOrderRecordKey\(order\) === selectedOrderId\)\s*\?\?\s*visibleOrders\[0\]\s*\?\?\s*filteredOrders\[0\]\s*\?\?\s*null;/u
    );
    expect(salesOrderSelectionSource).not.toContain('const [detailOrder, setDetailOrder]');
  });

  it('keeps sales status counts, list, pagination, and detail on the same filtered dataset', () => {
    expect(salesOrderCacheClientSource).toContain("getDomainCache('orders'");
    expect(salesOrderCacheClientSource).toContain('includeSummary: includeSummary ? 1 : undefined');
    expect(salesOrderPagedCacheSource).toContain('readSalesOrderPagedCache(queryOverride || queryInput');
    expect(salesOrderPagedCacheSource).toContain('data: { ...data, fetchedAt:');
    expect(salesOrderPagedCacheSource).toContain('queryOverride: refreshedQueryInput');
    expect(salesOrderFilterSource).toContain('const filteredOrderTotal = Math.max(Number(orderSync.data?.total) || 0, 0);');
    expect(salesOrderFilterSource).toContain('const salesOrderStatusCounts = React.useMemo');
    expect(salesOrderFilterSource).toContain('salesOrderSummary.salesStatusCounts');
    expect(salesOrderFilterSource).toContain('const salesOrderPagination = React.useMemo');
    expect(salesOrderFilterSource).toContain('rows: visibleOrders, totalRows: filteredOrderTotal');
    expect(salesOrderSelectionSource).toContain('detailOrder: selectedOrder,');
    expect(salesOrderFilterSource).not.toContain('queryRowsIndex(salesOrderRowsIndex');
    expect(salesOrderFilterSource).not.toContain('paginateRows(filteredOrders, salesOrderPage, salesOrderPageSize)');
  });

  it('dedupes sales order snapshots by shop-scoped record keys', () => {
    const scopedKeySource = getPageSource('function getOzonOrderScopedRecordKey', 'function dedupeRowsById');
    const dedupeSource = getPageSource('function dedupeRowsById', 'function mergeSalesOrderVisibleSupplement');

    expect(scopedKeySource).toContain('firstFilled(row.recordKey, row.entityId)');
    expect(scopedKeySource).toContain('firstFilled(row.id, row.posting, row.salesOrder, row.ozonOrderId, row.orderId)');
    expect(scopedKeySource).toMatch(
      /firstFilled\(row\.shopClientId,\s*row\.clientId,\s*row\.shopId,\s*row\.shop,\s*row\.shopName,\s*row\.storeName,\s*'unknown'\s*\)/u
    );
    expect(scopedKeySource).toContain('return `${shopKey}:${orderKey}`;');
    expect(dedupeSource).toContain(
      'mergeOzonRowsByKeySafe(rows, getOzonOrderScopedRecordKey, mergeOzonSalesOrderRows)'
    );
    expect(dedupeSource).not.toContain('(row) => row.id || row.posting || row.salesOrder');
  });

  it('keeps the purchase detail derived from the visible list dataset', () => {
    expect(appSource).toContain('const orderRowsWithImages = React.useMemo(');
    expect(appSource).toContain('const basePurchaseOrders = React.useMemo(');
    expect(appSource.includes('rowMappers.current.products(orderRowsWithImages')).toBe(true);
    expect(appSource.includes('applyOzonLocalProductEntitiesToRows([order], productSummaryEntityMap, getSalesOrderRecordKey)[0]')).toBe(true);
    expect(appSource).toContain('const orderRowsForPurchase = React.useMemo(');
    expect(appSource.includes('rowMappers.current.normalized(orderRowsForPurchase')).toBe(true);
    expect(appSource).toContain('const visibleOrders = purchaseOrderPagination.rows;');
    expect(appSource).toMatch(
      /const selectedOrder\s*=\s*visibleOrders\.find\(\(order\) => order\.id === selectedOrderId\)\s*\?\?\s*visibleOrders\[0\]\s*\?\?\s*filteredOrders\[0\]\s*\?\?\s*emptyPurchaseOrder;/u
    );
    expect(appSource).toContain('const preferredDetailRows = visibleOrders.length ? visibleOrders : filteredOrders;');
  });

  it('keeps purchase stage counts, list, pagination, and detail on the same filtered dataset', () => {
    const purchasePageSource = getPageSource('function PurchaseOrdersPage', 'function MarketingActivityPage');

    expect(purchasePageSource).toContain('const purchaseOrdersIndex = React.useMemo');
    expect(purchasePageSource).toContain('const purchaseOrderCountRows = purchaseOrderRange.rows;');
    expect(purchasePageSource).toContain('rangeReaderRef.current(purchaseOrdersIndex');
    expect(purchasePageSource).toContain('queryRowsIndex(index, { shopScope: selectedShopScope, keyword })');
    expect(purchasePageSource).toContain('const filteredOrders = React.useMemo');
    expect(purchasePageSource).toContain('sortOrderRowsByNewestPaymentTime(');
    expect(purchasePageSource).toContain('filterRowsByStatus(purchaseOrderCountRows, status');
    expect(purchasePageSource).toContain('const purchaseOrderStageCounts = purchaseOrderRange.stageCounts;');
    expect(purchasePageSource).toContain('const purchaseOrderModuleCounts = purchaseOrderRange.moduleCounts;');
    expect(purchasePageSource).toContain('const result = { rows, stageCounts, moduleCounts };');
    expect(purchasePageSource).toContain('const purchaseOrderPagination = React.useMemo');
    expect(purchasePageSource).toContain('paginateRows(filteredOrders, purchaseOrderPage, purchaseOrderPageSize)');
    expect(purchasePageSource).toContain('const visibleOrders = purchaseOrderPagination.rows;');
    expect(purchasePageSource).toContain(
      'const preferredDetailRows = visibleOrders.length ? visibleOrders : filteredOrders;'
    );
    expect(purchasePageSource).not.toContain('orderSync.data?.statusCounts');
    expect(purchasePageSource).not.toContain('orderSync.statusCounts');
  });

  it('keeps Ozon detail reads available only for explicit order operations', () => {
    expect(appSource).toContain("onClick={() => openSalesOperation('cancel', detailOrder)}");
    expect(appSource).toContain("onClick={() => openSalesOperation('ship', detailOrder)}");
    expect(appSource).toContain(
      'const detailOrder = await requestOzonSalesOrderDetail(shop, { ...order, posting: postingNumber });'
    );
  });

  it('shows payment facts, source link and shared hover preview in the sales order detail card', () => {
    expect(salesOrderViewSource).toContain('const detailPaymentTime = detailOrder?.paymentTime ||');
    expect(salesOrderViewSource).toContain('const detailPaymentAmount = detailOrder?.amount ||');
    expect(salesOrderViewSource).toContain('付款时间');
    expect(salesOrderViewSource).toContain('{detailPaymentTime}');
    expect(salesOrderViewSource).toContain('付款金额');
    expect(salesOrderViewSource).toContain('{detailPaymentAmount}');
    expect(salesOrderViewSource).toContain('const detailSourceLinkText =');
    expect(salesOrderViewSource).toContain('链接 {detailSourceLinkText}');
    expect(salesOrderViewSource).not.toContain("单号 {detailPurchaseInfoSupport.orderNumber || '未返回'}");
    expect(salesOrderViewSource).toContain('<LazyHoverImagePreview');
    expect(salesOrderViewSource).toContain('className="detail-product-image-hover sales-order-image-hover"');
    expect(salesOrderViewSource).toContain('previewClassName="sales-order-image-preview"');
  });

  it('formats sales order payment time with the year in order cards', () => {
    expect(formatOzonOrderDateTime('2026-06-24T13:02:03')).toBe('2026/06/24 13:02:03');
  });

  it('does not keep deprecated remote supplement placeholders in sales or purchase visible-row effects', () => {
    expect(appSource).not.toContain('function enrichSalesRowsWithVisibleSupplements');
    expect(appSource).not.toContain('function enrichSalesRowsWithVisibleSupplementsForShops');
    expect(appSource).not.toContain('function enrichSalesRowsWithVisibleCommissions');
    expect(appSource).not.toContain('function enrichSalesRowsWithVisibleCommissionsForShops');
    expect(appSource).not.toContain('function applyOzonRealFbsCommissionToSalesRows');
    expect(appSource).not.toContain('function getOzonRealFbsProductCommission');
    expect(appSource).not.toContain('function getOzonSalesOrderCommissionPercent');

    const salesPageSource = getPageSource('function SalesOrdersPage', 'function PurchaseOrdersPage');
    const purchasePageSource = getPageSource('function PurchaseOrdersPage', 'function MarketingActivityPage');
    const localProductEntitySource = getPageSource(
      'async function readOzonLocalProductEntityRows',
      'async function requestPurchasePluginBridge'
    );
    expect(localProductEntitySource).toContain('readSalesOrderProductSummaryEntities(rows, shops, {');
    expect(localProductEntitySource).toContain('getRecordKey,');
    expect(localProductEntitySource).toContain('signal: options.signal');
    expect(localProductEntitySource.indexOf('readSalesOrderProductSummaryEntities')).toBeLessThan(
      localProductEntitySource.indexOf('readLocalDataFile(fileKey)')
    );
    const salesLocalSupplementStart = salesPageSource.indexOf('readOzonLocalProductEntityRows(');
    const purchaseLocalSupplementStart = purchasePageSource.indexOf('readOzonLocalProductEntityRows(');
    expect(salesLocalSupplementStart).toBeGreaterThanOrEqual(0);
    expect(purchaseLocalSupplementStart).toBeGreaterThanOrEqual(0);

    const salesLocalSupplementSource = salesPageSource.slice(
      salesLocalSupplementStart - 900,
      salesLocalSupplementStart + 1800
    );
    const purchaseLocalSupplementSource = purchasePageSource.slice(
      purchaseLocalSupplementStart - 900,
      purchaseLocalSupplementStart + 1800
    );

    [salesLocalSupplementSource, purchaseLocalSupplementSource].forEach((source) => {
      expect(source).toContain('readOzonLocalProductEntityRows(');
      expect(source).not.toContain('let requestRows = rowsToEnhance');
      expect(source).not.toContain('rowsWithoutLocal');
      expect(source).not.toContain('new AbortController()');
      expect(source).not.toContain('controller.signal.aborted');
      expect(source).not.toContain('controller.abort()');
      expect(source).not.toContain('orderSync.data?.source');
      expect(source).not.toContain('requestOzonOrderImageSupplementRows');
      expect(source).not.toContain('requestOzonSalesOrderDetail(');
    });
  });
});
