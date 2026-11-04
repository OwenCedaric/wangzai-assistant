import { getOzonRealtimeSnapshotLogSource } from '../../../../entities/marketing/marketingSnapshotRuntime.jsx';
import { firstFilled, normalizeOzonId } from '../../../../entities/order/orderShopScope.jsx';
import { getSalesOrderRecordKey } from '../../../../entities/order/orderRecordRules.jsx';
import {
  getProductSourceLinkKey,
  getProductSourceRecordFromLinks,
  normalizeProductSourceRecord,
  normalizeSavedSalesSourceEntry,
} from '../../../../entities/order/orderSourceLinks.jsx';
import { recordLocalMirrorReadLog } from '../../../../entities/product/productLocalData.jsx';
import { getOzonApiErrorMessage } from '../../../../entities/product/productOzonApi.jsx';
import { validatePageDatasetConsistency } from '../../../../services/localMirrorDataset';
import { getPurchaseOrderMaterialPresentation } from '../../../../services/purchaseLogisticsRuntime.js';
import { SOURCE_LINK_LIMIT } from '../../../../shared/config/appConfigCore.jsx';
import { countRowsImages, usePagePerformanceLog } from '../../../../shared/ozon/ozonRuntime.jsx';
import {
  getOrderPreviewImageUrls,
  useOzonOrderImagePreload,
} from '../../../../entities/order/orderImagePreviewRules.jsx';
import { getPurchaseOrderRecordKey } from '../lib/purchaseMarketingApi.jsx';
import { getPurchaseOrderSourceMapKey } from '../../../../entities/order/purchaseOrderRecordRules.jsx';
import { getManualPurchasePriceDisplay, getPurchaseOrderActionState } from '../lib/purchaseOrderNormalize.jsx';
import { getPurchaseOrderActionFlags, getPurchaseOrderPreviewImages } from '../lib/purchaseImageRules.jsx';
import { getPurchaseOrderShop } from '../../../../services/purchaseCrossBorderRuntime.js';
import React from 'react';

const DOMESTIC_LOGISTICS_EMPTY_VALUES = new Set(['', '-', '--', '未返回', '待补录', '待同步', 'null', 'undefined']);

function firstDomesticLogisticsValue(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text && !DOMESTIC_LOGISTICS_EMPTY_VALUES.has(text) && !DOMESTIC_LOGISTICS_EMPTY_VALUES.has(text.toLowerCase())) {
      return text;
    }
  }
  return '';
}

export function resolvePurchaseDomesticLogistics(order = {}, crossBorderRead = {}) {
  const crossBorderOrder = crossBorderRead.orderItem && typeof crossBorderRead.orderItem === 'object'
    ? crossBorderRead.orderItem
    : {};
  const orderOverride = order.purchaseOverride && typeof order.purchaseOverride === 'object'
    ? order.purchaseOverride
    : {};
  const carrier = firstDomesticLogisticsValue(
    crossBorderRead.carrierName,
    crossBorderRead.carrier_name,
    crossBorderRead.expressCompany,
    crossBorderRead.express_company,
    crossBorderRead.logisticsCompany,
    crossBorderRead.logistics_company,
    crossBorderRead.carrier,
    crossBorderOrder.carrierName,
    crossBorderOrder.carrier_name,
    crossBorderOrder.expressCompany,
    crossBorderOrder.express_company,
    crossBorderOrder.carrier,
    order.domesticCourierCompany,
    order.purchaseCourierCompany,
    order.carrierName,
    order.expressCompany,
    orderOverride.carrierName,
    orderOverride.expressCompany,
  );
  const trackingNumber = firstDomesticLogisticsValue(
    crossBorderRead.trackingNumber,
    crossBorderRead.tracking_number,
    crossBorderRead.logisticsOrder,
    crossBorderRead.logistics_order,
    crossBorderOrder.trackingNumber,
    crossBorderOrder.tracking_number,
    crossBorderOrder.logisticsOrder,
    crossBorderOrder.logistics_order,
    order.domesticTrackingNumber,
    order.purchaseTrackingNumber,
    order.manualTrackingNumber,
    orderOverride.trackingNumber,
    orderOverride.logisticsOrder,
  );
  const status = firstDomesticLogisticsValue(
    crossBorderRead.domesticLogisticsStatus,
    crossBorderRead.purchaseLogisticsStatus,
    crossBorderOrder.domesticLogisticsStatus,
    crossBorderOrder.purchaseLogisticsStatus,
    order.domesticLogisticsStatus,
    order.purchaseLogisticsStatus,
    orderOverride.domesticLogisticsStatus,
    orderOverride.purchaseLogisticsStatus,
  );
  return {
    carrier: carrier || '未返回',
    trackingNumber: trackingNumber || '未返回',
    status: status || (carrier && trackingNumber ? '已发货' : '未返回'),
  };
}

function hasPositiveMaterialValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

export function resolvePurchaseReturnedMaterial(crossBorderRead = {}) {
  return getPurchaseOrderMaterialPresentation({}, crossBorderRead);
}

export function resolvePurchaseMaterialReadStatus(_order = {}, crossBorderRead = {}, material = {}) {
  const hasMaterial = [
    material.weightKg,
    material.lengthCm,
    material.heightCm,
    material.widthCm,
  ].every(hasPositiveMaterialValue);
  if (hasMaterial) return '已返回';

  const forecastIdentity = firstDomesticLogisticsValue(
    crossBorderRead.orderId,
    crossBorderRead.order_id,
    crossBorderRead.orderNumber,
    crossBorderRead.order_number,
    crossBorderRead.packageOrderId,
    _order.packageOrderId,
    _order.crossBorderOrderId,
    _order.crossBorderOrderNumber,
  );
  const statusText = firstDomesticLogisticsValue(
    crossBorderRead.message,
    crossBorderRead.readStatus,
  );
  const hasPositiveStatus = Boolean(
    statusText
      && !/未查到|没有查到|未找到|无预报|未返回/u.test(statusText)
      && /已查到|已读取|已创建|预报|跨境巴士/u.test(statusText),
  );
  const hasForecast = Boolean(
    forecastIdentity
      || crossBorderRead.orderFound === true
      || crossBorderRead.crossBorderOrderFound === true
      || _order.crossBorderOrderFound === true
      || hasPositiveStatus,
  );
  return hasForecast ? '已读取' : '未返回';
}

export function usePurchaseSelectionDetailState({
  visibleOrders,
  selectedOrderId,
  filteredOrders,
  emptyPurchaseOrder,
  selectedProductIndex,
  shops,
  activeShop,
  shop,
  productSourceLinks,
  legacyPurchaseSourceLinks,
  selectedSourceSlot,
  crossBorderReadByOrderId,
  selectedPurchaseSearchImage,
  manualPurchaseAnchorEl,
  orderSync,
  purchaseOrderCountRows,
  purchaseOrderStageCounts,
  purchaseOrderPagination,
  isActive,
  purchaseOrderLocalSnapshotKey,
  purchaseOrderTimeScope,
  status,
  keyword,
  purchaseOrderPage,
  purchaseOrderPageSize,
  purchaseOrders,
} = {}) {
  const selectedOrder =
    visibleOrders.find((order) => order.id === selectedOrderId) ??
    visibleOrders[0] ??
    filteredOrders[0] ??
    emptyPurchaseOrder;
  const hasSelectedOrder = Boolean(selectedOrder.id);
  const selectedProducts = Array.isArray(selectedOrder.products) ? selectedOrder.products : [];
  const safeSelectedProductIndex = selectedProducts.length
    ? Math.min(selectedProductIndex, selectedProducts.length - 1)
    : 0;
  const selectedProduct = selectedProducts[safeSelectedProductIndex] ?? null;
  const selectedOrderSourceShop = getPurchaseOrderShop(shops, selectedOrder, activeShop) ?? {
    id: selectedOrder.shopId || selectedOrder.shopClientId || selectedOrder.shop || 'default',
    clientId: selectedOrder.shopClientId,
  };
  const selectedProductSourceKey = selectedProduct
    ? getProductSourceLinkKey(selectedProduct, selectedOrderSourceShop, {
        productNo: selectedOrder.productNo,
        sku: selectedOrder.sku,
      })
    : '';
  const selectedProductLegacyKey = selectedProduct
    ? normalizeOzonId(selectedProduct.offerId || selectedProduct.sku || selectedOrder.productNo || selectedOrder.sku)
    : '';
  const selectedPurchaseSourceKey = getPurchaseOrderSourceMapKey(selectedOrder, selectedOrderSourceShop);
  const selectedOrderSourceRecords =
    selectedOrder.manualSourceRecords && typeof selectedOrder.manualSourceRecords === 'object'
      ? selectedOrder.manualSourceRecords
      : {};
  const selectedOrderSourceRecord = normalizeProductSourceRecord(
    selectedOrderSourceRecords[selectedProductSourceKey] ??
      selectedOrderSourceRecords[selectedProductLegacyKey] ??
      selectedOrder.manualSourceRecord ??
      {}
  );
  const selectedSharedProductSourceRecord = selectedProduct
    ? getProductSourceRecordFromLinks(productSourceLinks, selectedProduct, selectedOrderSourceShop, {
        productNo: selectedOrder.productNo,
        sku: selectedOrder.sku,
      })
    : normalizeProductSourceRecord({});
  const selectedSharedSourceRecord = normalizeProductSourceRecord(
    selectedSharedProductSourceRecord.links.length
      ? selectedSharedProductSourceRecord
      : (productSourceLinks[selectedProductSourceKey] ??
          productSourceLinks[selectedProductLegacyKey] ??
          legacyPurchaseSourceLinks[selectedPurchaseSourceKey] ??
          legacyPurchaseSourceLinks[selectedOrder.id] ??
          {})
  );
  const selectedSourceRecord = normalizeProductSourceRecord(
    selectedSharedSourceRecord.links.length ? selectedSharedSourceRecord : selectedOrderSourceRecord
  );
  const selectedSourceSlots = Array.from(
    { length: SOURCE_LINK_LIMIT },
    (_, index) =>
      selectedSourceRecord.links[index] ?? { link: '', productId: '', platform: index === 0 ? '待补录' : '备用' }
  );
  const safeSelectedSourceSlot = Math.min(selectedSourceSlot, SOURCE_LINK_LIMIT - 1);
  const selectedSourceEntry = selectedSourceSlots[safeSelectedSourceSlot] ?? selectedSourceSlots[0] ?? {};
  const selectedSourceLink = normalizeSavedSalesSourceEntry(selectedSourceEntry).link;
  const selectedActionState = getPurchaseOrderActionState(selectedOrder);
  const selectedActionFlags = getPurchaseOrderActionFlags(selectedOrder, selectedActionState);
  const selectedCrossBorderRead = crossBorderReadByOrderId[selectedOrder.id] ?? {};
  const selectedVolumeItems = selectedCrossBorderRead.volumeItems ?? selectedOrder.volumeItems ?? [];
  const selectedMaterial = getPurchaseOrderMaterialPresentation(selectedOrder, selectedCrossBorderRead);
  const selectedReturnedMaterial = resolvePurchaseReturnedMaterial(selectedCrossBorderRead);
  const selectedPackageSize = selectedMaterial.sizeText;
  const selectedPackageWeight = selectedMaterial.weightText;
  const selectedPackageLength = selectedMaterial.lengthText;
  const selectedPackageWidth = selectedMaterial.widthText;
  const selectedPackageHeight = selectedMaterial.heightText;
  const selectedLogisticsRoute = firstFilled(
    selectedCrossBorderRead.deliveryMethod,
    selectedCrossBorderRead.logistics,
    selectedOrder.deliveryMethod,
    selectedOrder.logistics
  );
  const selectedLogisticsRouteRawText = String(selectedLogisticsRoute || '').trim();
  const selectedLogisticsRouteIsGeneric = /^(ozon|fbs|rfbs|ozon\s+fbs|ozon\s+rfbs)$/i.test(
    selectedLogisticsRouteRawText
  );
  const selectedLogisticsRouteText =
    selectedLogisticsRouteRawText && selectedLogisticsRouteRawText !== '未返回' && !selectedLogisticsRouteIsGeneric
      ? selectedLogisticsRouteRawText
      : '路线待确认';
  const selectedReadStatus = resolvePurchaseMaterialReadStatus(
    selectedOrder,
    selectedCrossBorderRead,
    selectedReturnedMaterial,
  );
  const selectedDomesticLogistics = resolvePurchaseDomesticLogistics(selectedOrder, selectedCrossBorderRead);
  const selectedSearchImageUrl =
    selectedPurchaseSearchImage.orderId === selectedOrder.id ? selectedPurchaseSearchImage.imageUrl : '';
  const manualPurchaseEditorOpen = Boolean(manualPurchaseAnchorEl);
  const manualPurchaseSummaryPlatform = selectedOrder.buyerPlatform || '待补录';
  const manualPurchaseSummaryOrderNo = selectedOrder.purchaseOrderNo || '待补录';
  const manualPurchaseSummaryPrice =
    firstFilled(selectedOrder.purchasePrice, getManualPurchasePriceDisplay(selectedOrder)) || '待确认';
  const purchaseImageOrderKey = React.useMemo(
    () =>
      visibleOrders
        .map((order) => getSalesOrderRecordKey(order))
        .filter(Boolean)
        .join('|'),
    [visibleOrders]
  );
  const visiblePurchaseImageCount = React.useMemo(() => countRowsImages(visibleOrders), [visibleOrders]);
  const visiblePurchaseImageUrls = React.useMemo(
    () => getOrderPreviewImageUrls(visibleOrders, getPurchaseOrderPreviewImages, 80),
    [visibleOrders]
  );
  useOzonOrderImagePreload(visiblePurchaseImageUrls, 80);
  usePagePerformanceLog('拍单管理', orderSync.performance, {
    loading: orderSync.loading,
    rows: visibleOrders.length,
    imageCount: visiblePurchaseImageCount,
  });
  const purchaseOrderDatasetConsistency = React.useMemo(
    () =>
      validatePageDatasetConsistency(
        {
          countRows: purchaseOrderCountRows,
          filteredRows: filteredOrders,
          statusCounts: purchaseOrderStageCounts,
          pageRows: visibleOrders,
          page: purchaseOrderPagination,
          detailRow: hasSelectedOrder ? selectedOrder : null,
          detailSourceRows: filteredOrders,
        },
        {
          allStatusValue: 'all',
          getRowKey: getPurchaseOrderRecordKey,
        }
      ),
    [
      filteredOrders,
      hasSelectedOrder,
      purchaseOrderCountRows,
      purchaseOrderPagination,
      purchaseOrderStageCounts,
      selectedOrder,
      visibleOrders,
    ]
  );
  const purchaseOrderConsistencyLogKeyRef = React.useRef('');
  React.useEffect(() => {
    if (!isActive || orderSync.loading) return;
    const consistencyLogKey = [
      purchaseOrderLocalSnapshotKey,
      orderSync.performance?.eventId || '',
      purchaseOrderTimeScope.cachePart,
      shop,
      status,
      keyword,
      purchaseOrderPage,
      purchaseOrderPageSize,
      purchaseOrderCountRows.length,
      filteredOrders.length,
      purchaseOrderPagination.totalRows,
      purchaseOrderDatasetConsistency.ok
        ? 'ok'
        : purchaseOrderDatasetConsistency.issues.map((issue) => issue.code).join(','),
    ].join('|');
    if (purchaseOrderConsistencyLogKeyRef.current === consistencyLogKey) return;
    purchaseOrderConsistencyLogKeyRef.current = consistencyLogKey;
    recordLocalMirrorReadLog({
      domain: '07_purchase_orders',
      source: getOzonRealtimeSnapshotLogSource(orderSync),
      status: purchaseOrderDatasetConsistency.ok ? 'consistency-ok' : 'consistency-failed',
      rows: purchaseOrders.length,
      failures: purchaseOrderDatasetConsistency.issues.length,
      partial: !purchaseOrderDatasetConsistency.ok,
      refreshedAt: orderSync.data?.fetchedAt || orderSync.data?.updatedAt || new Date().toISOString(),
      details: {
        localSnapshotKey: purchaseOrderLocalSnapshotKey,
        timeScope: purchaseOrderTimeScope.cachePart,
        shopScope: shop,
        selectedStatus: status,
        keyword,
        filteredRows: filteredOrders.length,
        countRows: purchaseOrderCountRows.length,
        pageRows: visibleOrders.length,
        pageTotalRows: purchaseOrderPagination.totalRows,
        consistency: purchaseOrderDatasetConsistency,
      },
    }).catch(() => undefined);
  }, [
    filteredOrders.length,
    isActive,
    keyword,
    orderSync,
    purchaseOrderCountRows.length,
    purchaseOrderDatasetConsistency,
    purchaseOrderLocalSnapshotKey,
    purchaseOrderPage,
    purchaseOrderPageSize,
    purchaseOrderPagination.totalRows,
    purchaseOrders.length,
    purchaseOrderTimeScope.cachePart,
    shop,
    status,
    visibleOrders.length,
  ]);
  const purchaseOrderPartialErrorText = React.useMemo(
    () =>
      (orderSync.data?.errors ?? [])
        .map((item) => {
          const message = item.error ? getOzonApiErrorMessage(item.error) : '请求失败';
          return `${item.label || '订单接口'} ${message}`;
        })
        .join('；'),
    [orderSync.data?.errors]
  );

  return {
    selectedOrder,
    hasSelectedOrder,
    selectedProducts,
    safeSelectedProductIndex,
    selectedProduct,
    selectedOrderSourceShop,
    selectedProductSourceKey,
    selectedProductLegacyKey,
    selectedSourceRecord,
    safeSelectedSourceSlot,
    selectedSourceEntry,
    selectedSourceLink,
    selectedActionState,
    selectedActionFlags,
    selectedCrossBorderRead,
    selectedVolumeItems,
    selectedPackageSize,
    selectedPackageWeight,
    selectedPackageLength,
    selectedPackageWidth,
    selectedPackageHeight,
    selectedLogisticsRouteText,
    selectedReadStatus,
    selectedDomesticCarrier: selectedDomesticLogistics.carrier,
    selectedDomesticTrackingNumber: selectedDomesticLogistics.trackingNumber,
    selectedDomesticLogisticsStatus: selectedDomesticLogistics.status,
    selectedSearchImageUrl,
    manualPurchaseEditorOpen,
    manualPurchaseSummaryPlatform,
    manualPurchaseSummaryOrderNo,
    manualPurchaseSummaryPrice,
    purchaseImageOrderKey,
    purchaseOrderPartialErrorText,
  };
}
