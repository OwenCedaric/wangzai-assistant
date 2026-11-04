import { firstFilled, getOzonShopForOrder } from '../../../../entities/order/orderShopScope.jsx';
import {
  findAfterSalesPurchaseOverride,
  getAfterSalesPurchaseSupport,
  getAfterSalesRefundStatus,
  getAfterSalesRefundTime,
  getAfterSalesResponsibilityParty,
  getAfterSalesSourceLabel,
} from '../../../../services/afterSalesPurchaseSupport';
import {
  getPurchaseInfoCrossBorderInfo,
  getPurchaseInfoSupport,
} from '../../../../services/purchaseInfoSupport';

function compactText(value) {
  const text = String(value ?? '').trim();
  return text && text !== 'undefined' && text !== 'null' ? text : '';
}

function isUsableDisplayId(value, row = {}, salesOrder = '') {
  const text = compactText(value);
  if (
    !text
    || text === '未返回'
    || text === '0'
    || text.startsWith('return_')
    || text.startsWith('posting:')
    || text.startsWith('order:')
  ) return false;
  const postingKeys = [
    salesOrder,
    row.salesOrder,
    row.posting,
    row.postingNumber,
    row.posting_number,
    row.order_id,
    row.orderId,
  ].map(compactText).filter(Boolean);
  return !postingKeys.includes(text);
}

export function getAfterSalesWorkbenchDisplayId(row = {}) {
  const salesOrder = firstFilled(row.salesOrder, row.posting, row.postingNumber, row.posting_number);
  const directId = firstFilled(row.returnId, row.return_id, row.afterSalesId, row.after_sales_id);
  if (isUsableDisplayId(directId, row, salesOrder)) return directId;
  return isUsableDisplayId(row.id, row, salesOrder) ? row.id : '未返回';
}

export function buildAfterSalesOzonProductWorkbenchContext({
  order = {},
  product = {},
  purchaseOverrideIndex = new Map(),
  readableShops = [],
} = {}) {
  const purchaseOverride = findAfterSalesPurchaseOverride(order, purchaseOverrideIndex, readableShops);
  const generalPurchaseInfo = getPurchaseInfoSupport(order, purchaseOverride);
  const afterSalesPurchaseInfo = getAfterSalesPurchaseSupport(order, purchaseOverrideIndex, readableShops);
  const purchaseInfo = {
    ...generalPurchaseInfo,
    platform: afterSalesPurchaseInfo.platform !== '未返回'
      ? afterSalesPurchaseInfo.platform
      : generalPurchaseInfo.platform,
    orderNumber: afterSalesPurchaseInfo.orderNumber !== '未返回'
      ? afterSalesPurchaseInfo.orderNumber
      : generalPurchaseInfo.orderNumber,
    orderUrl: afterSalesPurchaseInfo.orderUrl || generalPurchaseInfo.orderUrl,
  };
  return {
    order,
    product,
    // Never substitute the currently selected shop for an order whose owner
    // could not be resolved. Seller links must fail closed rather than opening
    // another shop's authenticated browser profile.
    sourceShop: getOzonShopForOrder(order, readableShops, null),
    purchaseInfo,
    crossBorderInfo: getPurchaseInfoCrossBorderInfo(order, purchaseOverride, order?.crossBorderInfo),
    sidebarKind: 'after-sales',
    title: '售后订单操作台',
    subtitle: '左侧固定当前售后订单卡片，右侧业务页面独立操作',
    afterSales: {
      originalOrderNo: firstFilled(order.salesOrder, order.posting, order.postingNumber) || '未返回',
      afterSalesId: getAfterSalesWorkbenchDisplayId(order),
      type: firstFilled(order.type, order.afterSalesType, order.returnType) || '未返回',
      status: order.status || '未返回',
      shop: order.shop || '未返回',
      logistics: order.logistics || '未返回',
      refundAmount: order.refundAmount || '未返回',
      refundStatus: getAfterSalesRefundStatus(order),
      refundTime: getAfterSalesRefundTime(order),
      responsibilityParty: getAfterSalesResponsibilityParty(order),
      sourceLabel: getAfterSalesSourceLabel(order),
      updatedAt: order.updated || order.updatedAt || '未返回',
      reason: order.reason || '未返回',
      purchasePlatform: purchaseInfo.platform,
      purchaseOrderNo: purchaseInfo.orderNumber,
    },
  };
}
