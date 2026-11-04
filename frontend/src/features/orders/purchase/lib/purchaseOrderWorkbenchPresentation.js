import { firstFilled, getOzonShopLabel } from '../../../../entities/order/orderIdentityRules.jsx';
import {
  getPurchaseOrderDisplayOrderId,
  getPurchaseOrderProfitSummaryItems,
  getPurchaseOrderShortStatus,
  getPurchaseProductImageUrl,
  getPurchaseSourceCardAmount,
  getPurchaseSourceCardQty,
  getPurchaseSourceProductTitle,
} from './purchaseImageRules.jsx';

function text(value, fallback = '未返回') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

const EMPTY_DISPLAY_VALUES = new Set(['', '-', '--', '未返回', '待确认', '待补录', 'null', 'undefined']);

function firstMeaningful(...values) {
  return values.find((value) => {
    const normalized = String(value ?? '').trim();
    return normalized && !EMPTY_DISPLAY_VALUES.has(normalized.toLowerCase());
  });
}

function isTruthyFlag(value) {
  return value === true || value === 1 || ['true', '1'].includes(String(value ?? '').trim().toLowerCase());
}

function isVoidedPurchase(order = {}, purchaseInfo = {}) {
  const raw = order.raw && typeof order.raw === 'object' ? order.raw : {};
  const purchaseRaw = purchaseInfo.raw && typeof purchaseInfo.raw === 'object' ? purchaseInfo.raw : {};
  const refundConfirmed = [
    order.purchaseRefundConfirmed,
    raw.purchaseRefundConfirmed,
    purchaseInfo.purchaseRefundConfirmed,
    purchaseRaw.purchaseRefundConfirmed,
  ].some(isTruthyFlag);
  const forceStatus = String(firstFilled(
    order.forcePurchaseStatus,
    raw.forcePurchaseStatus,
    purchaseInfo.forcePurchaseStatus,
    purchaseRaw.forcePurchaseStatus,
  ) || '').trim();
  const voidedOrderNumber = firstFilled(
    order.voidedPurchaseOrderNo,
    raw.voidedPurchaseOrderNo,
    purchaseInfo.voidedPurchaseOrderNo,
    purchaseRaw.voidedPurchaseOrderNo,
  );
  return refundConfirmed || (forceStatus === '待拍单' && Boolean(voidedOrderNumber));
}

export function buildPurchaseOrderWorkbenchPresentation({
  order = {},
  product = {},
  sourceEntry = {},
  sourceShop = null,
  sourceLink = '',
  purchaseInfo = {},
  crossBorderInfo = {},
  profitItems = null,
} = {}) {
  order = order && typeof order === 'object' ? order : {};
  product = product && typeof product === 'object' ? product : {};
  sourceEntry = sourceEntry && typeof sourceEntry === 'object' ? sourceEntry : {};
  purchaseInfo = purchaseInfo && typeof purchaseInfo === 'object' ? purchaseInfo : {};
  crossBorderInfo = crossBorderInfo && typeof crossBorderInfo === 'object' ? crossBorderInfo : {};
  const link = text(sourceLink || sourceEntry.link, '');
  const purchaseVoided = isVoidedPurchase(order, purchaseInfo);
  const purchasePlatform = purchaseVoided ? '' : firstMeaningful(
    purchaseInfo.platform,
    order.purchasePlatform,
    order.buyerPlatform,
    order.supplier,
    sourceEntry.platform
  );
  const purchaseOrderNo = purchaseVoided ? '' : firstMeaningful(
    purchaseInfo.orderNumber,
    order.purchaseOrderNumber,
    order.purchaseOrderNo,
    order.manualPurchaseOrderNo
  );
  const packageWeight = firstMeaningful(crossBorderInfo.packageWeight, order.packageWeight);
  const packageSize = firstMeaningful(crossBorderInfo.packageSize, order.packageSize);
  const logisticsRoute = firstMeaningful(
    crossBorderInfo.logistics,
    crossBorderInfo.route,
    order.deliveryMethod,
    order.logistics,
    crossBorderInfo.warehouse
  );
  const resolvedProfitItems = Array.isArray(profitItems)
    ? profitItems
    : getPurchaseOrderProfitSummaryItems(order);
  return {
    version: 1,
    kind: 'purchase-order',
    displayMode: 'embedded',
    title: '订单操作台',
    order: {
      orderNo: text(firstFilled(order.salesOrder, order.postingNumber, order.posting, order.id)),
      goodsNo: text(firstFilled(order.productNo, order.offerId, product.offerId, product.offer_id)),
      ozonOrderId: text(firstFilled(
        order.ozonOrderId,
        order.softwareOrderId,
        order.orderId,
        order.ozonOrderID,
        order.raw?.order_number,
        order.raw?.order_id
      )),
      shop: text(firstFilled(order.shop, getOzonShopLabel(sourceShop))),
      status: text(getPurchaseOrderShortStatus(order.status)),
      salesAmount: text(firstFilled(order.amount, order.salesAmount)),
      purchasePlatform: text(purchasePlatform, '待补录'),
      purchaseOrderNo: text(purchaseOrderNo, '待补录'),
      ozonStatus: text(firstFilled(order.ozonStatusLabel, order.ozonStatus, order.statusLabel, order.status)),
      paymentTime: text(firstFilled(order.paymentTime, order.paymentDate, order.inProcessAt)),
    },
    product: {
      title: text(getPurchaseSourceProductTitle(product, sourceEntry), '暂无商品信息'),
      sku: text(firstFilled(product.sku, product.offerId, order.sku, order.productNo)),
      quantity: text(getPurchaseSourceCardQty(product, order, sourceEntry), 'x1'),
      imageUrl: text(getPurchaseProductImageUrl(product, sourceEntry), ''),
    },
    source: {
      platform: text(purchasePlatform, '待补录'),
      amount: purchaseVoided ? '待确认' : text(firstMeaningful(
        purchaseInfo.cost,
        getPurchaseSourceCardAmount(product, order, sourceEntry)
      ), '待确认'),
      url: link,
    },
    logistics: {
      orderId: text(firstMeaningful(crossBorderInfo.orderId, getPurchaseOrderDisplayOrderId(order))),
      weight: text(packageWeight),
      size: text(packageSize),
      route: text(logisticsRoute, '路线待确认'),
      readStatus: text(firstMeaningful(crossBorderInfo.readStatus, order.readStatus, order.crossBorderStatus)),
    },
    profitItems: resolvedProfitItems.map((item) => {
      const label = text(item.label, '');
      const invalidAfterRefund = purchaseVoided && ['货源', '利润'].includes(label);
      return {
        label,
        value: invalidAfterRefund ? '待确认' : text(item.value, '待确认'),
        tone: invalidAfterRefund ? '' : text(item.tone, ''),
      };
    }),
    notice: '左侧订单信息固定，右侧网页可以自由搜索、切换规格和下单。',
  };
}
