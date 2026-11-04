import { getOzonShopForOrder } from '../../../entities/order/orderShopScope.jsx';
import { buildProfitSourceRecordsForOrder } from '../../../entities/order/orderSourceLinks.jsx';
import {
  getProfitDetailActualFees,
  getProfitDetailEstimateSummary,
  getProfitDetailOrderInfo,
  getProfitDetailRealStatusLabel,
} from '../../../entities/profit/profitDisplayRules.jsx';
import {
  getProfitOrderActualValue,
  getProfitOrderProfitLossInfo,
  getProfitResultStatusLabel,
  getSignedProfitDisplay,
} from '../../../entities/profit/profitFinanceEvidence.jsx';
import { getPurchaseInfoCrossBorderInfo } from '../../../services/purchaseInfoSupport';

function getSourceEntry(sourceRecords = [], product = {}) {
  const productKeys = new Set([
    product.offerId,
    product.offer_id,
    product.sku,
    product.skuId,
    product.sku_id,
    product.productId,
    product.product_id,
  ].map((value) => String(value || '').trim()).filter(Boolean));
  return (Array.isArray(sourceRecords) ? sourceRecords : []).find((record) => [
    record.offerId,
    record.sku,
    record.skuId,
    record.productId,
  ].some((value) => productKeys.has(String(value || '').trim()))) || sourceRecords[0] || {};
}

export function buildProfitOzonProductWorkbenchContext({
  order = {},
  product = {},
  profitLocalInputs = {},
  readableShops = [],
} = {}) {
  const rowShop = getOzonShopForOrder(order, readableShops);
  const sourceRecords = buildProfitSourceRecordsForOrder(order, {
    purchaseLocalOverrides: profitLocalInputs.purchaseLocalOverrides,
    productSourceLinks: profitLocalInputs.productSourceLinks,
    shop: rowShop,
  });
  const detailInfo = getProfitDetailOrderInfo(order, {
    purchaseLocalOverrides: profitLocalInputs.purchaseLocalOverrides,
    sourceRecords,
    shop: rowShop,
  }) || {};
  const actualProfitValue = getProfitOrderActualValue(order);
  const profitLossInfo = getProfitOrderProfitLossInfo(order);
  const currencyCode = order.currencyCode || 'CNY';
  return {
    order,
    product,
    sourceEntry: getSourceEntry(sourceRecords, product),
    sourceShop: rowShop,
    purchaseInfo: {
      platform: detailInfo.purchasePlatform,
      orderNumber: detailInfo.purchaseOrderNo,
      cost: detailInfo.purchaseCost,
    },
    crossBorderInfo: getPurchaseInfoCrossBorderInfo(order, {}, order?.crossBorderInfo),
    sidebarKind: 'profit',
    title: '利润核算操作台',
    subtitle: '左侧固定当前订单的利润核算卡片，右侧 Ozon 商品页面独立操作',
    profit: {
      realStatus: getProfitDetailRealStatusLabel(order) || '未返回',
      resultStatus: getProfitResultStatusLabel(profitLossInfo?.value ?? null),
      actualProfit: actualProfitValue === null || actualProfitValue === undefined
        ? String(order.actualProfit || '').trim() || '待确认'
        : getSignedProfitDisplay(actualProfitValue, currencyCode),
      actualProfitTone: actualProfitValue > 0 ? 'profit' : actualProfitValue < 0 ? 'loss' : '',
      estimateItems: getProfitDetailEstimateSummary(order),
      actualFeeItems: getProfitDetailActualFees(order),
    },
  };
}
