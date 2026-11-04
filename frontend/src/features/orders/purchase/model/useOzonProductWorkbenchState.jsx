import React from 'react';
import { buildOzonProductWorkbenchOpenPayload } from '../lib/ozonProductWorkbenchPresentation.js';
import { buildPurchaseLinkWorkbenchPresentation } from '../lib/purchaseLinkWorkbenchPresentation.js';
import { resolveOzonSellerOrderWorkbenchTarget } from '../../../../services/ozonSellerOrderWorkbenchTarget.js';
import { usePurchaseOrderWorkbenchState } from './usePurchaseOrderWorkbenchState.jsx';

export function useOzonProductWorkbenchState({ showNotice } = {}) {
  const workbench = usePurchaseOrderWorkbenchState({ showPurchaseNotice: showNotice });
  const openOzonProduct = React.useCallback(({
    order = {},
    product = {},
    sourceEntry = {},
    sourceShop = null,
    purchaseInfo = {},
    crossBorderInfo = {},
    profitItems = null,
    sidebarKind = 'order',
    profit = null,
    afterSales = null,
    productAnalysis = null,
    title = '',
    subtitle = '',
  } = {}) => {
    const { target, presentation } = buildOzonProductWorkbenchOpenPayload({
      order,
      product,
      sourceEntry,
      sourceShop,
      purchaseInfo,
      crossBorderInfo,
      profitItems,
      sidebarKind,
      profit,
      afterSales,
      productAnalysis,
      title,
      subtitle,
    });
    if (!target.url) {
      showNotice?.('当前商品缺少可用的 Ozon 商品标识和标题。', 'warning');
      return null;
    }
    workbench.open(target.url, {
      presentation,
      shopId: String(sourceShop?.id || sourceShop?.shopId || '').trim(),
    });
    if (!target.exact) showNotice?.('当前记录缺少 Ozon SKU，已按商品标题打开 Ozon 搜索结果。', 'info');
    return target;
  }, [showNotice, workbench]);
  const openPurchaseLink = React.useCallback(({
    url = '',
    order = {},
    product = {},
    sourceEntry = {},
    sourceShop = null,
    purchaseInfo = {},
    crossBorderInfo = {},
    profitItems = null,
    sidebarKind = 'order',
    profit = null,
    afterSales = null,
    sellerOrderLookup = null,
    title = '',
    subtitle = '',
  } = {}) => {
    const normalizedUrl = String(url || '').trim();
    if (!/^https?:\/\//iu.test(normalizedUrl)) {
      showNotice?.('当前采购链接无效，无法打开订单操作台。', 'warning');
      return null;
    }
    workbench.open(normalizedUrl, {
      shopId: String(sourceShop?.id || sourceShop?.shopId || '').trim(),
      requireShopBinding: /^https?:\/\/seller\.ozon\.ru(?:\/|$)/iu.test(normalizedUrl),
      sellerOrderLookup,
      presentation: buildPurchaseLinkWorkbenchPresentation({
        url: normalizedUrl,
        order,
        product,
        sourceEntry,
        sourceShop,
        purchaseInfo,
        crossBorderInfo,
        profitItems,
        sidebarKind,
        profit,
        afterSales,
        title,
        subtitle,
      }),
    });
    return normalizedUrl;
  }, [showNotice, workbench]);
  const openOzonSellerOrder = React.useCallback((input = {}) => {
    const target = resolveOzonSellerOrderWorkbenchTarget(input.order || {});
    if (!target.orderLookup) {
      showNotice?.('当前记录缺少 Ozon 货件号，无法打开原订单。', 'warning');
      return null;
    }
    openPurchaseLink({
      ...input,
      url: target.url,
      sellerOrderLookup: target.orderLookup,
    });
    return target;
  }, [openPurchaseLink, showNotice]);

  return React.useMemo(() => ({
    ...workbench,
    openOzonProduct,
    openPurchaseLink,
    openOzonSellerOrder,
  }), [openOzonProduct, openOzonSellerOrder, openPurchaseLink, workbench]);
}
