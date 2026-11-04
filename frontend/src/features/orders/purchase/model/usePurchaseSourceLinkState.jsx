import { firstFilled, getOzonShopForOrder } from '../../../../entities/order/orderShopScope.jsx';
import { usePurchaseOrderSupplement } from './usePurchaseOrderSupplement.js';
import {
  buildProductSourceStorageRecord,
  buildSourceEntryForLink,
  detectSourcePlatformFromLink,
  getProductSourceRecordFromLinks,
  normalizeProductSourceEntry,
  normalizeSalesSourceLinkValue,
  normalizeSourcePlatformName,
} from '../../../../entities/order/orderSourceLinks.jsx';
import {
  hydrateProductSourceLinksFromLocalFile,
  saveProductSourceLinkRecord,
} from '../../../../services/productSourceLinkStore';
import {
  migrateLegacyPurchaseSourceLinksAtStartup,
  readPurchaseSourceLinksFromLocalApi,
  savePurchaseSourceLinkRecord,
} from '../../../../services/purchaseSourceLinkStore';
import {
  hydratePurchasePluginSourceContextFromLocalFile,
  mergeLocalRecordMaps,
  requestPurchasePluginBridge,
  savePurchasePluginSourceContext,
  sendPurchasePluginContext,
} from '../../../../entities/product/productLocalMirror.jsx';
import {
  getPurchaseInfoCrossBorderInfo,
  getPurchaseInfoSupport,
} from '../../../../services/purchaseInfoSupport';
import {
  PRODUCT_SOURCE_LINK_STORAGE_KEY,
  SOURCE_LINK_LIMIT,
} from '../../../../shared/config/appConfigCore.jsx';
import { getPurchaseOrderRecordKey } from '../lib/purchaseMarketingApi.jsx';
import {
  createManualPurchaseDraftFromOrder,
  findPurchaseOrderLocalOverride,
  hydratePurchaseOrderLocalOverridesFromLocalFile,
  removePurchaseSourceRecordsFromLocalOverride,
  writePurchaseOrderLocalOverrideUpsert,
} from '../lib/purchaseOrderNormalize.jsx';
import {
  getAbsolutePurchaseSearchImageUrl,
  getPurchaseOrderOzonMainImageUrl,
  getPurchaseOrderSkuImageUrl,
  getPurchaseProductImageUrl,
  getPurchaseSearchHomeUrl,
  getPurchaseSearchPlatformKey,
  getPurchaseSourceCardQty,
  getPurchaseSourceProductTitle,
  getPurchaseSourceSearchErrorMessage,
  normalizePurchaseSourceSearchResult,
} from '../lib/purchaseImageRules.jsx';
import React from 'react';
import { lockPurchaseBrowserTarget } from '../services/purchaseBrowserTargetBridge.js';
import { usePurchaseOrderWorkbenchState } from './usePurchaseOrderWorkbenchState.jsx';
import { buildOzonProductWorkbenchOpenPayload } from '../lib/ozonProductWorkbenchPresentation.js';

function usablePurchaseContextText(value) {
  const normalized = String(value ?? '').trim();
  return normalized && !['未返回', '待确认', '待补录', '-', '—'].includes(normalized)
    ? normalized
    : '';
}

export function buildPurchasePluginSourceContextValue({
  product = null,
  productIndex = 0,
  selectedOrder = {},
  selectedOrderSourceShop = null,
  selectedSourceEntry = {},
} = {}) {
  if (!selectedOrder?.id) return null;
  const targetProduct = product && typeof product === 'object' && !Array.isArray(product)
    ? product
    : {};
  const productKey = targetProduct.sourceKey
    || targetProduct.productKey
    || targetProduct.offerId
    || targetProduct.sku
    || selectedOrder.productNo
    || selectedOrder.offerId
    || selectedOrder.sku
    || '';
  const sourceProductTitle = usablePurchaseContextText(
    getPurchaseSourceProductTitle(targetProduct, selectedSourceEntry),
  );
  return {
    shopName: selectedOrder.shop || '',
    shopId: selectedOrderSourceShop?.id
      || selectedOrder.shopId
      || selectedOrder.shop_id
      || selectedOrder.shopClientId
      || selectedOrder.shop_client_id
      || '',
    shopClientId: selectedOrder.shopClientId || selectedOrder.shop_client_id || '',
    ...(selectedOrder.shopIncarnation && Number(selectedOrder.credentialRevision) > 0
      ? {
          shopIncarnation: selectedOrder.shopIncarnation,
          credentialRevision: Number(selectedOrder.credentialRevision),
        }
      : {}),
    orderKey: getPurchaseOrderRecordKey(selectedOrder),
    offerId: targetProduct.offerId
      || targetProduct.offer_id
      || targetProduct.sku
      || selectedOrder.productNo
      || selectedOrder.offerId
      || '',
    sku: targetProduct.sku || selectedOrder.sku || selectedOrder.productNo || '',
    orderId: selectedOrder.id,
    ozonOrderId: selectedOrder.ozonOrderId || selectedOrder.salesOrder || selectedOrder.id,
    salesAmount: selectedOrder.amount || '',
    productIndex,
    productKey,
    legacyProductKey: targetProduct.legacyProductKey || '',
    productName: sourceProductTitle
      || targetProduct.name || targetProduct.title || selectedOrder.product || '',
    quantity: getPurchaseSourceCardQty(targetProduct, selectedOrder, selectedSourceEntry),
    productImageUrl:
      getPurchaseOrderOzonMainImageUrl(targetProduct) || getPurchaseOrderSkuImageUrl(targetProduct) || '',
    lockedAt: new Date().toISOString(),
  };
}

export function usePurchaseSourceLinkState({
  isActive,
  shops,
  setLegacyPurchaseSourceLinks,
  productSourceLinks,
  setProductSourceLinks,
  setSelectedProductIndex,
  setSelectedSourceSlot,
  setPurchasePlatformExpanded,
  setManualPurchaseAnchorEl,
  selectedOrder,
  setManualPurchaseDraft,
  selectedProducts,
  selectedProductIndex,
  selectedSourceSlot,
  selectedProduct,
  shop,
  safeSelectedProductIndex,
  selectedProductSourceKey,
  selectedProductLegacyKey,
  setPurchaseImageMap,
  setPurchaseImageErrorText,
  setSelectedPurchaseOrderKeys,
  orderSync,
  filteredPurchaseOrderKeys,
  visiblePurchaseOrderKeys,
  setPurchaseOrderPage,
  purchaseOrderTotalPages,
  visibleOrders,
  readableShops,
  purchaseImageMap,
  purchaseImageOrderKey,
  readableShopsSourceKey,
  hasSelectedOrder,
  selectedSourceLink,
  selectedOrderSourceShop,
  selectedSourceRecord,
  safeSelectedSourceSlot,
  selectedSourceEntry,
  setPurchaseLocalOverrides,
  status,
  selectedSearchImageUrl,
  setSourceSearchDialog,
  sourceSearchDialog,
  setPurchaseNotice,
} = {}) {
  const showPurchaseNotice = React.useCallback(
    (message, severity = 'info') => {
      setPurchaseNotice({ open: true, message, severity });
    },
    [setPurchaseNotice]
  );
  React.useEffect(() => {
    let isActive = true;
    hydratePurchasePluginSourceContextFromLocalFile().catch(() => undefined);
    migrateLegacyPurchaseSourceLinksAtStartup(shops)
      .then(({ canonicalLinks, unresolvedLegacyLinks }) => {
        if (!isActive) return;
        setLegacyPurchaseSourceLinks({ ...unresolvedLegacyLinks, ...canonicalLinks });
      })
      .catch(() => undefined);
    hydrateProductSourceLinksFromLocalFile(undefined, shops)
      .then((links) => {
        if (!isActive) return;
        setProductSourceLinks(links && typeof links === 'object' && !Array.isArray(links) ? links : {});
      })
      .catch(() => undefined);
    return () => {
      isActive = false;
    };
  }, [setLegacyPurchaseSourceLinks, setProductSourceLinks, shops]);
  React.useEffect(() => {
    setSelectedProductIndex(0);
    setSelectedSourceSlot(0);
    setPurchasePlatformExpanded(false);
    setManualPurchaseAnchorEl(null);
  }, [
    selectedOrder.id,
    setManualPurchaseAnchorEl,
    setPurchasePlatformExpanded,
    setSelectedProductIndex,
    setSelectedSourceSlot,
  ]);
  React.useEffect(() => {
    setManualPurchaseDraft(createManualPurchaseDraftFromOrder(selectedOrder));
  }, [
    selectedOrder,
    selectedOrder.id,
    selectedOrder.manualBuyerPlatform,
    selectedOrder.manualPurchaseOrderNo,
    selectedOrder.manualPurchasePrice,
    selectedOrder.manualPurchasePriceValue,
    setManualPurchaseDraft,
  ]);
  React.useEffect(() => {
    if (!selectedProducts.length || selectedProductIndex < selectedProducts.length) return;
    setSelectedProductIndex(0);
  }, [selectedProductIndex, selectedProducts.length, setSelectedProductIndex]);
  React.useEffect(() => {
    if (selectedSourceSlot < SOURCE_LINK_LIMIT) return;
    setSelectedSourceSlot(0);
  }, [selectedSourceSlot, setSelectedSourceSlot]);
  const buildPurchasePluginSourceContextForProduct = React.useCallback((product, productIndex = 0) => {
    if (!isActive || typeof window === 'undefined') return null;
    return buildPurchasePluginSourceContextValue({
      product,
      productIndex,
      selectedOrder,
      selectedOrderSourceShop,
      selectedSourceEntry,
    });
  }, [
    isActive,
    selectedOrder,
    selectedOrderSourceShop,
    selectedSourceEntry,
  ]);
  const buildPurchasePluginSourceContext = React.useCallback(
    () => buildPurchasePluginSourceContextForProduct(selectedProduct, safeSelectedProductIndex),
    [buildPurchasePluginSourceContextForProduct, safeSelectedProductIndex, selectedProduct]
  );
  const applyCapturedPurchaseOrder = React.useCallback(async (payload = {}) => {
    const expected = buildPurchasePluginSourceContext();
    const target = payload.target || {};
    if (
      !expected
      || String(target.shopId || '').trim() !== String(expected.shopId || expected.shopClientId || '').trim()
      || String(target.orderKey || '').trim() !== String(expected.orderKey || expected.orderId || '').trim()
    ) return;
    const captured = payload.purchaseContext || payload.capture || {};
    const readbackOverride = payload.readback?.override || {};
    const platform = String(readbackOverride.purchasePlatform || captured.purchasePlatform || captured.platform || '').trim();
    const orderNumber = String(readbackOverride.purchaseOrderNumber || captured.purchaseOrderNumber || '').trim();
    const amountValue = Number(readbackOverride.sourceCostCny ?? captured.sourceCostCny ?? captured.purchasePrice);
    if (!platform || !orderNumber || !Number.isFinite(amountValue) || amountValue <= 0) {
      const error = new Error('PURCHASE_BROWSER_READBACK_FAILED');
      error.code = 'PURCHASE_BROWSER_READBACK_FAILED';
      throw error;
    }
    const overrides = await hydratePurchaseOrderLocalOverridesFromLocalFile();
    const canonical = findPurchaseOrderLocalOverride(
      overrides,
      selectedOrder,
      selectedOrderSourceShop,
    );
    const canonicalPlatform = String(canonical?.purchasePlatform || canonical?.manualBuyerPlatform || '').trim();
    const canonicalOrderNumber = String(canonical?.purchaseOrderNumber || canonical?.manualPurchaseOrderNo || '').trim();
    const canonicalAmount = Number(canonical?.sourceCostCny ?? canonical?.manualPurchasePriceValue ?? canonical?.manualPurchasePrice);
    if (
      canonicalPlatform !== platform
      || canonicalOrderNumber !== orderNumber
      || !Number.isFinite(canonicalAmount)
      || Math.abs(canonicalAmount - amountValue) > 0.001
    ) {
      const error = new Error('PURCHASE_BROWSER_READBACK_FAILED');
      error.code = 'PURCHASE_BROWSER_READBACK_FAILED';
      throw error;
    }
    // The native controller already saved the exact 1688 source row in SQLite.
    // Refresh the purchase-source state as part of the same successful action;
    // refreshing only purchase_order_overrides leaves the visible source slots
    // stuck at “待补录” until the whole page is reopened.
    const canonicalSourceLinks = await readPurchaseSourceLinksFromLocalApi();
    const canonicalSourceKey = `${expected.shopId || expected.shopClientId}:${expected.orderKey || expected.orderId}`;
    const capturedSourceUrl = String(
      payload.capture?.sourceUrl
      || payload.readback?.sourceLinks?.[0]?.url
      || '',
    ).trim();
    const sourceEntries = (Array.isArray(canonicalSourceLinks?.[canonicalSourceKey]?.links)
      ? canonicalSourceLinks[canonicalSourceKey].links
      : []).map((entry) => normalizeProductSourceEntry(entry));
    const exactSourceEntry = capturedSourceUrl
      ? sourceEntries.find((entry) => entry.link === capturedSourceUrl)
      : sourceEntries.find((entry) => entry.link);
    if (!exactSourceEntry?.link) {
      const error = new Error('PURCHASE_BROWSER_READBACK_FAILED');
      error.code = 'PURCHASE_BROWSER_READBACK_FAILED';
      throw error;
    }
    setPurchaseLocalOverrides(
      overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {},
    );
    setLegacyPurchaseSourceLinks((current) => ({
      ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
      ...canonicalSourceLinks,
    }));
    const operation = String(payload.operation || '').trim();
    if (operation === 'save-payment-info') {
      showPurchaseNotice(`${platform} 采购信息已保存并绑定到当前订单。`, 'success');
    } else if (operation === 'refresh-order-status') {
      showPurchaseNotice(`${platform} 订单状态已保存。`, 'success');
    } else {
      showPurchaseNotice(`${platform} 付款信息已自动读取并绑定到当前订单。`, 'success');
    }
  }, [
    buildPurchasePluginSourceContext,
    selectedOrder,
    selectedOrderSourceShop,
    setLegacyPurchaseSourceLinks,
    setPurchaseLocalOverrides,
    showPurchaseNotice,
  ]);
  const applyCapturedPurchaseRefund = React.useCallback(async (payload = {}) => {
    const expected = buildPurchasePluginSourceContext();
    const target = payload.target || {};
    const expectedProductKeys = new Set([
      expected?.productKey,
      expected?.offerId,
      expected?.sku,
    ].map((value) => String(value || '').trim()).filter(Boolean));
    const actualProductKeys = [target.sku, target.offerId]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    if (
      !expected
      || payload.readbackVerified !== true
      || String(target.shopId || '').trim() !== String(expected.shopId || expected.shopClientId || '').trim()
      || String(target.orderKey || '').trim() !== String(expected.orderKey || expected.orderId || '').trim()
      || (
        expectedProductKeys.size > 0
        && actualProductKeys.length > 0
        && !actualProductKeys.some((value) => expectedProductKeys.has(value))
      )
    ) return;
    try {
      const overrides = await hydratePurchaseOrderLocalOverridesFromLocalFile();
      setPurchaseLocalOverrides(
        overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {},
      );
      const platform = String(
        payload.capture?.platform
        || payload.capture?.purchasePlatform
        || payload.readback?.override?.voidedPurchasePlatform
        || '采购平台'
      ).trim();
      showPurchaseNotice(`已回读${platform}退款，原采购记录已作废并转回待拍单。`, 'success');
    } catch {
      showPurchaseNotice('退款已确认，但本地订单刷新失败，请重新进入拍单管理。', 'warning');
    }
  }, [buildPurchasePluginSourceContext, setPurchaseLocalOverrides, showPurchaseNotice]);
  const lockOpenedPurchaseBrowserTarget = React.useCallback(async ({ browserState, targetContext } = {}) => {
    if (!targetContext) {
      const error = new Error('PURCHASE_BROWSER_TARGET_REQUIRED');
      error.code = 'PURCHASE_BROWSER_TARGET_REQUIRED';
      throw error;
    }
    const activeTabId = String(browserState?.activeTabId || '').trim();
    const result = await lockPurchaseBrowserTarget(targetContext, { tabId: activeTabId });
    if (result?.ok !== true) {
      const error = new Error(result?.code || 'PURCHASE_BROWSER_TARGET_LOCK_FAILED');
      error.code = result?.code || 'PURCHASE_BROWSER_TARGET_LOCK_FAILED';
      throw error;
    }
    const state = browserState?.state && typeof browserState.state === 'object'
      ? browserState.state
      : browserState;
    const activeTab = Array.isArray(state?.tabs)
      ? state.tabs.find((tab) => String(tab?.tabId || '') === String(state?.activeTabId || ''))
      : null;
    const purchaseAccountId = activeTab?.ownerType === 'purchase_account'
      ? String(activeTab?.accountId || '').trim()
      : '';
    if (purchaseAccountId) {
      const ownedContext = { ...targetContext, purchaseAccountId };
      savePurchasePluginSourceContext(ownedContext);
      await sendPurchasePluginContext(ownedContext);
    }
    return result;
  }, []);
  const purchaseOrderWorkbench = usePurchaseOrderWorkbenchState({
    selectedOrder,
    selectedProduct,
    selectedSourceEntry,
    selectedOrderSourceShop,
    setSourceSearchDialog,
    showPurchaseNotice,
    onBrowserReady: lockOpenedPurchaseBrowserTarget,
    onPurchaseCaptured: applyCapturedPurchaseOrder,
    onPurchaseRefundCaptured: applyCapturedPurchaseRefund,
  });
  const purchaseOrderWorkbenchDialog = purchaseOrderWorkbench.dialog;
  const openPurchaseOrderWorkbenchDialog = purchaseOrderWorkbench.open;
  const openPurchaseOrderWorkbench = React.useCallback(
    (url) => openPurchaseOrderWorkbenchDialog(url, {
      browserTargetContext: buildPurchasePluginSourceContext(),
    }),
    [buildPurchasePluginSourceContext, openPurchaseOrderWorkbenchDialog]
  );
  const startPurchaseOrderWorkbenchBrowser = purchaseOrderWorkbench.startBrowser;
  const minimizePurchaseOrderWorkbench = purchaseOrderWorkbench.minimize;
  const closePurchaseOrderWorkbench = purchaseOrderWorkbench.close;
  const retryPurchaseOrderWorkbench = purchaseOrderWorkbench.retry;
  const navigatePurchaseOrderWorkbench = purchaseOrderWorkbench.navigate;
  const runPurchaseOrderWorkbenchToolbarAction = purchaseOrderWorkbench.runToolbarAction;
  const readPurchaseOrderWorkbenchPaymentInfo = purchaseOrderWorkbench.readPaymentInfo;
  const refreshPurchaseOrderWorkbenchStatus = purchaseOrderWorkbench.refreshOrderStatus;
  const savePurchaseOrderWorkbenchInfo = purchaseOrderWorkbench.savePurchaseInfo;
  const openPurchaseOzonProduct = React.useCallback((order = {}, product = {}) => {
    const isSelectedOrder = getPurchaseOrderRecordKey(order) === getPurchaseOrderRecordKey(selectedOrder);
    const { target, presentation } = buildOzonProductWorkbenchOpenPayload({
      order,
      product,
      sourceEntry: isSelectedOrder ? selectedSourceEntry : {},
      sourceShop: getOzonShopForOrder(order, shops, selectedOrderSourceShop) || selectedOrderSourceShop,
      purchaseInfo: getPurchaseInfoSupport(order),
      crossBorderInfo: getPurchaseInfoCrossBorderInfo(order, {}, order?.crossBorderInfo),
    });
    if (!target.url) {
      showPurchaseNotice('当前商品缺少可用的 Ozon 商品标识和标题。', 'warning');
      return null;
    }
    openPurchaseOrderWorkbenchDialog(target.url, { presentation });
    if (!target.exact) showPurchaseNotice('当前记录缺少 Ozon SKU，已按商品标题打开 Ozon 搜索结果。', 'info');
    return target;
  }, [
    openPurchaseOrderWorkbenchDialog,
    selectedOrder,
    selectedOrderSourceShop,
    selectedSourceEntry,
    shops,
    showPurchaseNotice,
  ]);
  React.useEffect(() => {
    const context = buildPurchasePluginSourceContext();
    if (!context) return;
    savePurchasePluginSourceContext(context);
    sendPurchasePluginContext(context).catch(() => undefined);
  }, [buildPurchasePluginSourceContext]);
  React.useEffect(() => {
    if (!buildPurchasePluginSourceContext()) return undefined;
    const publishContext = () => {
      const context = buildPurchasePluginSourceContext();
      if (!context) return;
      sendPurchasePluginContext(context).catch(() => undefined);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') publishContext();
    };
    const browserOnEvent = globalThis.window?.wangzaiDesktop?.purchaseBrowser?.onEvent;
    const unsubscribeBrowser = typeof browserOnEvent === 'function'
      ? browserOnEvent((payload = {}) => {
          if (!['opened', 'activated', 'recovered', 'target-recovered', 'target-changed', 'closed'].includes(payload.event)) return;
          publishContext();
        })
      : null;
    window.addEventListener('focus', publishContext);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', publishContext);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (typeof unsubscribeBrowser === 'function') unsubscribeBrowser();
    };
  }, [buildPurchasePluginSourceContext]);
  React.useEffect(() => {
    setPurchaseImageMap(new Map());
    setPurchaseImageErrorText('');
    setSelectedPurchaseOrderKeys(new Set());
  }, [orderSync.data?.fetchedAt, setPurchaseImageErrorText, setPurchaseImageMap, setSelectedPurchaseOrderKeys]);
  React.useEffect(() => {
    setSelectedPurchaseOrderKeys((current) => {
      const allowed = new Set(filteredPurchaseOrderKeys);
      const next = new Set([...current].filter((key) => allowed.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [filteredPurchaseOrderKeys, setSelectedPurchaseOrderKeys]);
  const togglePurchaseOrderSelection = React.useCallback(
    (order) => {
      const key = getPurchaseOrderRecordKey(order);
      if (!key) return;
      setSelectedPurchaseOrderKeys((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
    },
    [setSelectedPurchaseOrderKeys]
  );
  const togglePurchaseOrderPageSelection = React.useCallback(() => {
    setSelectedPurchaseOrderKeys((current) => {
      const next = new Set(current);
      const shouldClearPage = visiblePurchaseOrderKeys.every((key) => next.has(key));
      visiblePurchaseOrderKeys.forEach((key) => {
        if (shouldClearPage) {
          next.delete(key);
        } else {
          next.add(key);
        }
      });
      return next;
    });
  }, [visiblePurchaseOrderKeys, setSelectedPurchaseOrderKeys]);
  const selectAllFilteredPurchaseOrders = React.useCallback(() => {
    if (orderSync?.data?.complete === false) {
      showPurchaseNotice('订单尚未完整读取，完整后可全选所有页。', 'info');
      return;
    }
    setSelectedPurchaseOrderKeys(new Set(filteredPurchaseOrderKeys));
  }, [filteredPurchaseOrderKeys, orderSync?.data?.complete, setSelectedPurchaseOrderKeys, showPurchaseNotice]);
  const clearPurchaseOrderSelection = React.useCallback(() => {
    setSelectedPurchaseOrderKeys(new Set());
  }, [setSelectedPurchaseOrderKeys]);
  const resetPurchaseOrderListState = React.useCallback(() => {
    setPurchaseOrderPage(1);
    setSelectedPurchaseOrderKeys(new Set());
  }, [setPurchaseOrderPage, setSelectedPurchaseOrderKeys]);
  React.useEffect(() => {
    setPurchaseOrderPage((current) => Math.min(current, purchaseOrderTotalPages));
  }, [purchaseOrderTotalPages, setPurchaseOrderPage]);
  usePurchaseOrderSupplement({
    isActive, loading: orderSync.loading, refreshing: orderSync.refreshing,
    snapshotAt: orderSync.data?.fetchedAt, scopeKey: readableShopsSourceKey, orderKey: purchaseImageOrderKey,
    visibleOrders, readableShops, imageMap: purchaseImageMap,
    setImageMap: setPurchaseImageMap, setError: setPurchaseImageErrorText,
  });
  const handleOpenSourceLink = () => {
    if (!hasSelectedOrder) return;
    const link = selectedSourceLink.trim();
    if (!link) return;
    const normalizedLink = /^https?:\/\//i.test(link) ? link : `https://${link}`;
    openPurchaseOrderWorkbench(normalizedLink);
  };
  const handleQuickOrderSourceLink = () => {
    if (!hasSelectedOrder) return;
    const link = selectedSourceLink.trim();
    if (!link) {
      showPurchaseNotice('请先粘贴货源链接，再进行一键下单。', 'warning');
      return;
    }
    handleOpenSourceLink();
  };
  const getSelectedPurchaseSourceShopId = () =>
    String(selectedOrderSourceShop?.id || selectedOrder.shopId || selectedOrder.shop_id || selectedOrder.shopClientId || '').trim();
  const persistSelectedSourceRecord = async (record) => {
    const purchaseShopId = getSelectedPurchaseSourceShopId();
    await Promise.all([
      saveProductSourceLinkRecord({
        key: selectedProductSourceKey,
        record,
        product: selectedProduct ?? {},
        timeoutMs: 3000,
      }),
      savePurchaseSourceLinkRecord({
        order: selectedOrder,
        record,
        shopId: purchaseShopId,
        productKey: selectedProductSourceKey,
        timeoutMs: 3000,
      }),
    ]);
  };
  const handleSaveSourceLink = async () => {
    if (typeof window === 'undefined' || !hasSelectedOrder || !selectedProductSourceKey) return;
    const link = selectedSourceLink.trim();
    if (!link) {
      showPurchaseNotice('请先填写货源链接。', 'warning');
      return;
    }
    const parsed = normalizeSalesSourceLinkValue(/^https?:\/\//i.test(link) ? link : `https://${link}`);
    const nextEntry = parsed.ok
      ? {
          link: parsed.link,
          productId: parsed.productId,
          platform: normalizeSourcePlatformName(parsed.platform),
          savedAt: new Date().toISOString(),
        }
      : {
          link,
          productId: '',
          platform: detectSourcePlatformFromLink(link),
          savedAt: new Date().toISOString(),
        };
    const currentRecord = getProductSourceRecordFromLinks(productSourceLinks, selectedProduct ?? {}, selectedOrderSourceShop, {
      productNo: selectedOrder.productNo,
      sku: selectedOrder.sku,
    });
    const baseRecord = currentRecord.links.length ? currentRecord : selectedSourceRecord;
    const nextLinks = [...baseRecord.links];
    const duplicateIndex = nextLinks.findIndex((item) => item.link === nextEntry.link);
    const targetIndex = duplicateIndex >= 0 ? duplicateIndex : safeSelectedSourceSlot;
    if (
      duplicateIndex < 0 &&
      !nextLinks[targetIndex]?.link &&
      nextLinks.filter((item) => item.link).length >= SOURCE_LINK_LIMIT
    ) {
      showPurchaseNotice(`最多保存 ${SOURCE_LINK_LIMIT} 条货源链接。`, 'warning');
      return;
    }
    const currentEntry = nextLinks[targetIndex] ?? {};
    const selectedEntry = normalizeProductSourceEntry(selectedSourceEntry);
    nextLinks[targetIndex] = {
      ...currentEntry,
      ...(selectedEntry.link === nextEntry.link ? selectedEntry : {}),
      ...nextEntry,
      title: nextEntry.title || currentEntry.title || selectedEntry.title || '',
      imageUrl: nextEntry.imageUrl || currentEntry.imageUrl || selectedEntry.imageUrl || '',
      previewImageUrl: nextEntry.previewImageUrl || currentEntry.previewImageUrl || selectedEntry.previewImageUrl || '',
      originalImageUrl: nextEntry.originalImageUrl || currentEntry.originalImageUrl || selectedEntry.originalImageUrl || '',
      price: nextEntry.price || currentEntry.price || selectedEntry.price || '',
      priceValue: nextEntry.priceValue ?? currentEntry.priceValue ?? selectedEntry.priceValue,
      qty: nextEntry.qty || currentEntry.qty || selectedEntry.qty || '',
    };
    const nextRecord = buildProductSourceStorageRecord({
      ...baseRecord,
      links: nextLinks.filter((item) => item?.link).slice(0, SOURCE_LINK_LIMIT),
      primaryIndex: baseRecord.links.length ? baseRecord.primaryIndex : 0,
    });
    setProductSourceLinks({ ...productSourceLinks, [selectedProductSourceKey]: nextRecord });
    setPurchaseLocalOverrides((current) => {
      const result = writePurchaseOrderLocalOverrideUpsert(
        current,
        selectedOrder,
        selectedOrderSourceShop,
        (existing) => {
          const cleaned = removePurchaseSourceRecordsFromLocalOverride(existing, [
            selectedProductSourceKey,
            selectedProductLegacyKey,
          ]);
          return cleaned.changed ? cleaned.override : null;
        }
      );
      return result?.overrides ?? current;
    });
    try {
      await persistSelectedSourceRecord(nextRecord);
      showPurchaseNotice(
        parsed.ok ? `${nextEntry.platform}货源已保存。` : '货源链接已保存，请后续人工核对平台。',
        parsed.ok ? 'success' : 'warning'
      );
    } catch (error) {
      showPurchaseNotice(`货源已暂存本机，SQLite 写入失败：${error instanceof Error ? error.message : String(error)}`, 'warning');
    }
  };
  const updateSelectedSourceLink = (value, slotIndex, sourceEntry) => {
    if (!selectedProductSourceKey) return;
    setProductSourceLinks((current) => {
      const currentRecord = getProductSourceRecordFromLinks(current, selectedProduct ?? {}, selectedOrderSourceShop, {
        productNo: selectedOrder.productNo,
        sku: selectedOrder.sku,
      });
      const safeSlotIndex = Number(slotIndex);
      const targetIndex = Number.isInteger(safeSlotIndex)
        ? Math.max(0, Math.min(safeSlotIndex, SOURCE_LINK_LIMIT - 1))
        : safeSelectedSourceSlot;
      const nextLinks = [...currentRecord.links];
      nextLinks[targetIndex] = buildSourceEntryForLink(value, nextLinks[targetIndex], sourceEntry);
      return {
        ...current,
        [selectedProductSourceKey]: {
          ...currentRecord,
          links: nextLinks,
          updatedAt: currentRecord.updatedAt,
        },
      };
    });
  };
  const setSelectedSourceAsPrimary = async () => {
    if (!selectedProductSourceKey || !selectedSourceLink.trim()) return;
    const currentRecord = getProductSourceRecordFromLinks(productSourceLinks, selectedProduct ?? {}, selectedOrderSourceShop, {
      productNo: selectedOrder.productNo,
      sku: selectedOrder.sku,
    });
    const nextRecord = buildProductSourceStorageRecord({ ...currentRecord, primaryIndex: safeSelectedSourceSlot });
    setProductSourceLinks({ ...productSourceLinks, [selectedProductSourceKey]: nextRecord });
    try {
      await persistSelectedSourceRecord(nextRecord);
      showPurchaseNotice('已设为主货源。', 'success');
    } catch (error) {
      showPurchaseNotice(`主货源已暂存本机，SQLite 写入失败：${error instanceof Error ? error.message : String(error)}`, 'warning');
    }
  };
  // PURCHASE_PDD_1688_FRONTEND_ROUTE_FREEZE:BEGIN
  const buildPurchaseSourceSearchPayload = (platform, imageUrl) => ({
    platform: getPurchaseSearchPlatformKey(platform),
    launchMode: 'default',
    imageUrl,
    maxItems: platform === 'PDD' ? 120 : 720,
    order: {
      key: selectedOrder.id || selectedOrder.salesOrder || '',
      productName: selectedProduct?.name || selectedOrder.product || '',
      offerId: selectedProduct?.offerId || selectedProduct?.sku || selectedOrder.productNo || '',
      sku: selectedProduct?.sku || selectedOrder.sku || '',
      postingNumber: selectedOrder.id || selectedOrder.salesOrder || '',
    },
  });
  const requestPurchaseSourceSearch = async (platform, imageUrl) => {
    const path =
      platform === 'PDD'
        ? '/api/purchase/pdd-title-search'
        : '/api/purchase/image-search';
    return requestPurchasePluginBridge(path, {
      method: 'POST',
      data: buildPurchaseSourceSearchPayload(platform, imageUrl),
      force: true,
    });
  };
  const buildPurchaseSearchSuccessDialog = (platform, payload, imageUrl) => {
    const results = (Array.isArray(payload.results) ? payload.results : []).map(normalizePurchaseSourceSearchResult);
    const searchUrl =
      platform === 'PDD'
        ? firstFilled(
            payload.targetUrl,
            payload.searchTitle ? payload.searchUrl : '',
            getPurchaseSearchHomeUrl(platform)
          )
        : firstFilled(payload.searchUrl, payload.sourceSearch?.searchUrl, getPurchaseSearchHomeUrl(platform));
    const title =
      platform === 'PDD'
        ? payload.searchTitle
          ? `已通过 1688 以图搜款回读同款标题，并打开 PDD 搜索：${payload.searchTitle}`
          : '已按商品图进入 PDD 搜款流程，等待人工核对。'
        : payload.externalOnly
          ? payload.message
          : `已用商品图完成 ${platform} 同款结果读取，请人工核对规格和价格。`;
    return {
      open: true,
      platform,
      imageUrl,
      searchUrl,
      title: payload.message || title,
      results,
      loading: false,
      externalOnly: Boolean(payload.externalOnly),
      severity:
        results.length || payload.titleSearchAvailable || payload.ok || payload.sourceSearch?.imageVerified
          ? 'success'
          : 'warning',
    };
  };
  const openSourceSearchDialog = async (platform) => {
    if (!hasSelectedOrder || !selectedProduct) {
      showPurchaseNotice('请先选择需要拍单的商品。', 'warning');
      return;
    }
    const imageUrl = getAbsolutePurchaseSearchImageUrl(
      selectedSearchImageUrl || getPurchaseProductImageUrl(selectedProduct, selectedSourceEntry)
    );
    if (!imageUrl) {
      setSourceSearchDialog({
        open: true,
        platform,
        imageUrl: '',
        searchUrl: getPurchaseSearchHomeUrl(platform),
        title: '当前商品没有可用于以图搜款的图片，已停止，不使用标题搜索。',
        results: [],
        loading: false,
        severity: 'warning',
      });
      showPurchaseNotice('当前商品没有可用于以图搜款的图片。', 'warning');
      return;
    }
    setSourceSearchDialog({
      open: true,
      platform,
      imageUrl,
      searchUrl: getPurchaseSearchHomeUrl(platform),
      title:
        platform === 'PDD'
          ? '正在通过 1688 以图搜款读取同款标题，完成后直接打开 PDD。相同商品再次打开会使用缓存。'
          : `正在用商品图进行 ${platform} 以图搜款；不会使用 Ozon 标题。`,
      results: [],
      loading: true,
      severity: 'info',
    });
    try {
      const payload = await requestPurchaseSourceSearch(platform, imageUrl);
      const nextDialog = buildPurchaseSearchSuccessDialog(platform, payload, imageUrl);
      setSourceSearchDialog(nextDialog);
      const autoOpenUrl =
        platform === 'PDD'
          ? payload.titleSearchAvailable
            ? firstFilled(payload.targetUrl, payload.searchUrl)
            : ''
          : firstFilled(payload.searchUrl, payload.sourceSearch?.searchUrl);
      if (autoOpenUrl) {
        openSourceSearchUrl(autoOpenUrl);
      }
      showPurchaseNotice(
        platform === 'PDD'
          ? '已从 1688 以图搜款回读同款标题，并打开 PDD 搜索。'
          : `${platform} 已按商品图完成搜款请求，请人工核对和付款。`,
        'success'
      );
    } catch (error) {
      const message = getPurchaseSourceSearchErrorMessage(error, error?.status);
      setSourceSearchDialog({
        open: true,
        platform,
        imageUrl,
        searchUrl: getPurchaseSearchHomeUrl(platform),
        title: message,
        results: [],
        loading: false,
        severity: 'error',
      });
      showPurchaseNotice(message, 'error');
    }
  };
  const closeSourceSearchDialog = () => {
    setSourceSearchDialog((current) => ({ ...current, open: false }));
  };
  const openSourceSearchUrl = (url) => {
    if (!url) return;
    openPurchaseOrderWorkbench(url);
  };
  // PURCHASE_PDD_1688_FRONTEND_ROUTE_FREEZE:END
  const copySourceSearchImageUrl = async () => {
    const imageUrl = sourceSearchDialog.imageUrl || '';
    if (!imageUrl) return;
    try {
      await navigator.clipboard.writeText(imageUrl);
      showPurchaseNotice('商品图链接已复制。', 'success');
    } catch {
      showPurchaseNotice('复制失败，请手动复制图片链接。', 'warning');
    }
  };
  const downloadSourceSearchImage = () => {
    const imageUrl = sourceSearchDialog.imageUrl || '';
    if (!imageUrl) return;
    const link = document.createElement('a');
    link.href = imageUrl;
    link.download = `${selectedOrder.id || selectedProduct?.sku || 'purchase-search-image'}.jpg`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    showPurchaseNotice('已尝试下载商品图。', 'info');
  };
  return {
    togglePurchaseOrderSelection,
    togglePurchaseOrderPageSelection,
    selectAllFilteredPurchaseOrders,
    clearPurchaseOrderSelection,
    resetPurchaseOrderListState,
    handleOpenSourceLink,
    handleQuickOrderSourceLink,
    handleSaveSourceLink,
    updateSelectedSourceLink,
    setSelectedSourceAsPrimary,
    openSourceSearchDialog,
    closeSourceSearchDialog,
    openSourceSearchUrl,
    copySourceSearchImageUrl,
    downloadSourceSearchImage,
    showPurchaseNotice,
    openPurchaseOrderWorkbench,
    openPurchaseOzonProduct,
    purchaseOrderWorkbenchDialog,
    startPurchaseOrderWorkbenchBrowser,
    minimizePurchaseOrderWorkbench,
    closePurchaseOrderWorkbench,
    retryPurchaseOrderWorkbench,
    navigatePurchaseOrderWorkbench,
    runPurchaseOrderWorkbenchToolbarAction,
    readPurchaseOrderWorkbenchPaymentInfo,
    refreshPurchaseOrderWorkbenchStatus,
    savePurchaseOrderWorkbenchInfo,
  };
}
