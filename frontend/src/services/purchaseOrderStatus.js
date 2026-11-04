import { getSalesOrderPaymentDateKey } from "../entities/order/orderDateRules.jsx";
import { firstFilled, firstUsableOzonId } from "../entities/order/orderIdentityRules.jsx";
import { getOzonOrderBaseStatusLabel } from "../entities/order/orderStatusRules.jsx";
import { firstFiniteNumber } from "../entities/product/productAttributes.jsx";
import { formatOzonPrice } from "../entities/product/productPriceRules.jsx";
import { formatShopBindingTime } from "../shared/lib/dateTimeFormat.js";
import { attachSplitRelationFields } from "./orderSplitRelationRules";

export const purchaseOrderStatusTones = {
  待拍单: 'warning',
  '已拍单-待预报': 'warning',
  '已拍单-待发货': 'warning',
  '已拍单-已发货': 'primary',
  '已拍单-未操作': 'default',
  '已拍单-售后单': 'error',
  完结单: 'success',
  关闭单: 'default',
};

export function getPurchaseOrderKeys(order = {}) {
  return [
    order.shipmentNo,
    order.salesOrder,
    order.ozonOrderId,
    order.returnNo,
    order.purchaseOrderNo,
    order.packageOrderId,
    order.productNo,
    order.sku,
  ]
    .map((value) => String(value ?? '').trim())
    .filter((value, index, values) => value && value !== '未返回' && values.indexOf(value) === index);
}

export function getPurchaseOrderPaymentDateKey(order = {}) {
  return getSalesOrderPaymentDateKey({
    paymentDate: order.paymentDate || order.capturedAt,
    paymentTime: order.paymentTime || order.paymentDate || order.capturedAt,
  });
}

export function parsePurchaseOrderDateMs(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : time;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').trim();
  if (!text || text === '未返回' || text === '待确认') return null;

  const shortDateMatch = text.match(/^(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (shortDateMatch) {
    const [, month, day, hour, minute, second = '0'] = shortDateMatch;
    const date = new Date(
      new Date().getFullYear(),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
    const time = date.getTime();
    return Number.isNaN(time) ? null : time;
  }

  const nativeTime = Date.parse(text);
  if (!Number.isNaN(nativeTime)) return nativeTime;

  return null;
}

export function getPurchaseOrderPaymentTimeRaw(order = {}) {
  const raw = order.raw ?? order.sourceOrder?.raw ?? {};
  const sourceOrder = order.sourceOrder ?? {};

  const rawPayment = firstFilled(
    raw.paid_at,
    raw.paidAt,
    raw.payment_date,
    raw.paymentDate,
    raw.financial_data?.payment_date,
    raw.financialData?.paymentDate
  );
  if (rawPayment) return rawPayment;

  return firstFilled(
    order.paid_at,
    order.paidAt,
    order.payment_date,
    order.paymentDate,
    sourceOrder.paid_at,
    sourceOrder.paidAt,
    sourceOrder.payment_date,
    sourceOrder.paymentDate
  );
}

export function formatPurchaseOrderPaymentTime(order = {}) {
  const paymentTimeRaw = getPurchaseOrderPaymentTimeRaw(order);
  return paymentTimeRaw ? formatShopBindingTime(paymentTimeRaw, '未返回') : '未返回';
}

export function getPurchaseOrderPaymentTimeMs(order = {}) {
  return parsePurchaseOrderDateMs(getPurchaseOrderPaymentTimeRaw(order));
}

export function isPurchaseOrderBeforeShopBinding(order = {}) {
  const startedAt = parsePurchaseOrderDateMs(order.purchaseManagementStartedAt);
  if (startedAt === null) return false;
  const orderTime = getPurchaseOrderPaymentTimeMs(order);
  if (orderTime === null) return false;
  return orderTime < startedAt;
}

export function normalizeOzonSalesRowToPurchaseOrder(order = {}) {
  const raw = order.raw ?? {};
  const rawDeliveryMethod =
    raw.delivery_method && typeof raw.delivery_method === 'object'
      ? raw.delivery_method
      : raw.deliveryMethod && typeof raw.deliveryMethod === 'object'
        ? raw.deliveryMethod
        : order.delivery_method && typeof order.delivery_method === 'object'
          ? order.delivery_method
          : {};
  const ozonLogistics = firstFilled(
    order.logistics,
    rawDeliveryMethod.name,
    raw.delivery_method_name,
    raw.deliveryMethodName,
    rawDeliveryMethod.tpl_provider,
    rawDeliveryMethod.tplProvider,
    raw.tpl_provider_name,
    raw.provider_name,
    raw.delivery_schema
  );
  const ozonWarehouse = firstFilled(
    rawDeliveryMethod.warehouse,
    rawDeliveryMethod.warehouse_name,
    raw.analytics_data?.warehouse_name,
    raw.analyticsData?.warehouseName
  );
  const rawStatus = firstFilled(raw.status, raw.posting_status, raw.state, order.ozonRawStatus, order.rawStatus);
  const firstProduct = order.products?.[0] ?? {};
  const productNo = firstUsableOzonId(firstProduct.offerId, firstProduct.sku, order.sku);
  const sku = firstUsableOzonId(firstProduct.skuId, firstProduct.sku, order.sku);
  const crossBorderInfo = order.crossBorderInfo ?? {};
  const crossBorderOrderId = firstUsableOzonId(
    crossBorderInfo.orderId,
    order.packageOrderId,
    order.crossBorderOrderId,
    order.crossBorderOrderNumber,
    order.packageOrderIds?.[0]
  );
  const products =
    Array.isArray(order.products) && order.products.length
      ? order.products.map((product, index) => {
          const image =
            firstFilled(
              product.image,
              product.mainImage,
              product.skuImage,
              Array.isArray(product.images) ? product.images[0] : '',
              Array.isArray(product.mainImages) ? product.mainImages[0] : ''
            ) || '';
          return {
            name: product.name || `商品 ${index + 1}`,
            sku: firstUsableOzonId(product.offerId, product.sku, product.skuId) || '未返回',
            qty: product.qty || 1,
            price: product.price || '未返回',
            image,
            images: Array.isArray(product.images) ? product.images : image ? [image] : [],
            skuImage: product.skuImage || product.sku_image || '',
            skuImages: Array.isArray(product.skuImages) ? product.skuImages : [],
            mainImage:
              product.mainImage || product.primaryImage || product.primary_image || product.productMainImage || '',
            mainImages: Array.isArray(product.mainImages) ? product.mainImages : [],
            productMainImage:
              product.productMainImage || product.mainImage || product.primaryImage || product.primary_image || '',
            productMainImages: Array.isArray(product.productMainImages) ? product.productMainImages : [],
            offerId: firstUsableOzonId(product.offerId, product.sku),
            productId: firstUsableOzonId(product.productId, product.product_id, product.id),
            ozonSku: firstUsableOzonId(product.ozonSku, product.skuId, product.sku),
            salesAmountValue: product.salesAmountValue,
            priceValue: product.priceValue,
            currencyCode: product.currencyCode,
            commissionPercent: product.commissionPercent,
            commissionPercentText: product.commissionPercentText,
            commissionAmountValue: product.commissionAmountValue,
            commissionAmount: product.commissionAmount,
            weight: product.weight,
            length: product.length,
            width: product.width,
            height: product.height,
            materialSource: product.materialSource,
            materialProfile: product.materialProfile,
            raw: product.raw ?? product,
          };
        })
      : [{ name: order.product || '未返回', sku: productNo || sku || '未返回', qty: 1, price: '未返回', image: '' }];
  const orderId = firstUsableOzonId(order.posting, order.id, order.salesOrder, order.softwareOrderId);
  const softwareOrderId = firstUsableOzonId(order.softwareOrderId, raw.order_number, raw.orderNumber, raw.order_id);
  const paymentTimeRaw = getPurchaseOrderPaymentTimeRaw({ ...order, raw });
  const paymentTimeText = formatPurchaseOrderPaymentTime({ ...order, raw });
  const manualBuyerPlatform = String(
    firstFilled(order.manualBuyerPlatform, order.buyerPlatform, order.supplier) || ''
  ).trim();
  const manualPurchaseOrderNo = String(firstFilled(order.manualPurchaseOrderNo, order.purchaseOrderNo) || '').trim();
  const manualPurchasePrice = firstFilled(order.manualPurchasePrice, order.purchasePrice);
  const manualPurchasePriceValue = firstFiniteNumber(
    order.manualPurchasePriceValue,
    order.purchasePriceValue,
    manualPurchasePrice
  );
  const manualPurchaseOrderStatus = String(
    firstFilled(order.manualPurchaseOrderStatus, order.purchaseOrderStatus, order.purchaseStatus) || ''
  ).trim();
  const usableReturnedValue = (value) => {
    const text = String(value ?? '').trim();
    return text && text !== '未返回' ? value : '';
  };
  const crossBorderReadStatus = firstFilled(
    usableReturnedValue(crossBorderInfo.readStatus),
    usableReturnedValue(order.crossBorderStatus),
    usableReturnedValue(order.readStatus)
  );
  const warehouse = firstFilled(
    usableReturnedValue(crossBorderInfo.warehouse),
    usableReturnedValue(order.warehouse),
    usableReturnedValue(ozonWarehouse),
    usableReturnedValue(ozonLogistics),
    '未返回'
  );
  const packageWeight = firstFilled(
    usableReturnedValue(crossBorderInfo.packageWeight),
    usableReturnedValue(order.packageWeight),
    '未返回'
  );
  const packageSize = firstFilled(
    usableReturnedValue(crossBorderInfo.packageSize),
    usableReturnedValue(order.packageSize),
    '未返回'
  );

  return attachSplitRelationFields(
    {
      id: orderId || '未返回',
      recordKey: order.recordKey || orderId || '',
      salesOrder: orderId || '未返回',
      shipmentNo: orderId || '未返回',
      ozonOrderId: softwareOrderId || orderId || '未返回',
      shopId: order.shopId || '',
      shopClientId: order.shopClientId || '',
      shop: order.shop || order.shopName || 'Ozon 店铺',
      supplier: '待拍单',
      product: order.product || firstProduct.name || '未返回',
      productNo: productNo || '未返回',
      sku: sku || productNo || '未返回',
      items:
        order.items || products.reduce((sum, product) => sum + (Number(product.qty) || 0), 0) || products.length || 1,
      amount: order.amount || '未返回',
      commissionMode: order.commissionMode || 'rFBS',
      commissionPercent: order.commissionPercent || '未返回',
      commissionAmount: order.commissionAmount || '未返回',
      rubToCnyRate: order.rubToCnyRate ?? order.exchangeRate?.rubToCnyRate ?? null,
      exchangeRate: order.exchangeRate || null,
      estimatedExchangeRate: order.estimatedExchangeRate || order.exchangeRates?.estimated || null,
      actualExchangeRate: order.actualExchangeRate || order.exchangeRates?.actual || null,
      exchangeRates: order.exchangeRates || null,
      profitLedger: order.profitLedger,
      purchaseOrderNo: '',
      purchasePrice: '待确认',
      purchaseOrderStatus: manualPurchaseOrderStatus,
      manualBuyerPlatform,
      manualPurchaseOrderNo,
      manualPurchasePrice,
      manualPurchasePriceValue,
      manualPurchaseOrderStatus,
      ozonStatus: rawStatus || order.status || 'unknown',
      ozonRawStatus: rawStatus || '',
      purchaseRecordStatus: 'none',
      crossBorderOrderFound: Boolean(order.crossBorderOrderFound || crossBorderOrderId),
      crossBorderStatus: crossBorderReadStatus,
      channel: order.channel || 'Ozon',
      buyerPlatform: '待拍单',
      warehouse,
      logistics: ozonLogistics || '未返回',
      packageOrderId: crossBorderOrderId,
      packageOrderIds: Array.isArray(order.packageOrderIds)
        ? order.packageOrderIds
        : crossBorderOrderId
          ? [crossBorderOrderId]
          : [],
      crossBorderOrderId: crossBorderOrderId,
      crossBorderOrderNumber: firstUsableOzonId(order.crossBorderOrderNumber, crossBorderInfo.orderNumber),
      returnNo: orderId || '未返回',
      deliveryMethod: firstFilled(
        order.deliveryMethod,
        rawDeliveryMethod.name,
        rawDeliveryMethod.tpl_provider,
        rawDeliveryMethod.tplProvider,
        raw.delivery_method_name,
        order.fulfillment,
        order.channel,
        'Ozon'
      ),
      packageWeight,
      packageSize,
      readStatus: crossBorderReadStatus || crossBorderInfo.readStatus || order.readStatus || '未返回',
      cargoStatus: order.status || getOzonOrderBaseStatusLabel(rawStatus),
      deadline: order.deadline || '未返回',
      updated: order.updated || '未返回',
      paymentDate: paymentTimeRaw || '',
      paymentTime: paymentTimeText,
      capturedAt: paymentTimeRaw || '',
      note: order.note || 'Ozon 真实订单只读读取。',
      products,
      timeline: [
        `Ozon 状态：${order.status || getOzonOrderBaseStatusLabel(rawStatus)}`,
        `履约方式：${order.fulfillment || '未返回'}`,
        `最后更新：${order.updated || '未返回'}`,
      ],
      raw,
      sourceOrder: order,
    },
    order
  );
}

export function hasValidPurchaseOrderNumber(order = {}) {
  const number = String(order.purchaseOrderNo ?? '').trim();
  if (!number || number === '未返回' || number === '-') return false;
  return !['void', 'invalid', 'refunded', 'conflict'].includes(String(order.purchaseRecordStatus || '').toLowerCase());
}

export function hasConfirmedPurchasePlacement(order = {}) {
  const platform = firstFilled(order.buyerPlatform, order.manualBuyerPlatform, order.supplier);
  const purchaseOrderNo = firstFilled(order.purchaseOrderNo, order.manualPurchaseOrderNo);
  const purchasePrice = firstFilled(
    order.purchasePriceValue,
    order.purchasePrice,
    order.manualPurchasePriceValue,
    order.manualPurchasePrice
  );
  const purchasePriceValue = firstFiniteNumber(purchasePrice);
  const purchaseStatus = firstFilled(order.purchaseOrderStatus, order.manualPurchaseOrderStatus, order.purchaseStatus);
  return Boolean(
    isFilledPurchasePlatformValue(platform) &&
    isFilledPurchaseOrderNoValue(purchaseOrderNo) &&
    isFilledPurchasePriceValue(purchasePrice) &&
    purchasePriceValue !== null &&
    purchasePriceValue > 0 &&
    isConfirmedPurchasePlatformStatus(purchaseStatus) &&
    !hasPurchaseOrderConflict(order)
  );
}

export function hasConfirmedCrossBorderOrder(order = {}) {
  const crossBorderText = firstFilled(
    order.crossBorderStatus,
    order.readStatus,
    order.crossBorderInfo?.readStatus,
    order.crossBorderInfo?.status
  );
  const hasPositiveCrossBorderStatus =
    /已创建预报|已查到|待打包|已读取材积|回查|预报成功|已提交/.test(String(crossBorderText || '')) &&
    !/未查到|失败|未提交|未返回|废弃|取消|已取消/.test(String(crossBorderText || ''));
  return Boolean(
    order.crossBorderOrderFound ||
    order.packageOrderId ||
    (Array.isArray(order.packageOrderIds) && order.packageOrderIds.length > 0) ||
    order.crossBorderOrderId ||
    order.crossBorderOrderNumber ||
    order.sheetOrderSn ||
    order.sheetUrl ||
    order.crossBorderInfo?.orderId ||
    order.crossBorderInfo?.orderNumber ||
    hasPositiveCrossBorderStatus
  );
}

export function isPurchaseOrderPreparedWithoutCrossBorder(order = {}) {
  return (
    getPurchaseOrderOzonBaseStatus(order) === '等待发货' &&
    hasConfirmedPurchasePlacement(order) &&
    !hasConfirmedCrossBorderOrder(order) &&
    !hasPurchaseOrderConflict(order)
  );
}

export function hasPurchaseOrderConflict(order = {}) {
  return Boolean(
    order.purchaseException ||
    order.crossBorderStatusConflict ||
    Number(order.crossBorderOrderCount || 0) > 1 ||
    (Array.isArray(order.packageOrderIds) && order.packageOrderIds.length > 1) ||
    ['conflict', 'duplicate', 'voided', 'refunded'].includes(String(order.purchaseRecordStatus || '').toLowerCase())
  );
}

export function getPurchaseOrderOzonBaseStatus(order = {}) {
  const statusTags = Array.isArray(order.statusTags) ? order.statusTags : [];
  const workflowText = [
    order.note,
    order.rawStatus,
    order.ozonRawStatus,
    order.raw?.status,
    order.raw?.posting_status,
    order.raw?.postingStatus,
    order.raw?.state,
    order.sourceOrder?.note,
    order.sourceOrder?.rawStatus,
    order.sourceOrder?.ozonRawStatus,
    order.sourceOrder?.raw?.status,
    order.sourceOrder?.raw?.posting_status,
    order.sourceOrder?.raw?.postingStatus,
    order.sourceOrder?.raw?.state,
  ]
    .map((value) => String(value || '').toLowerCase())
    .filter(Boolean)
    .join(' ');
  if (/posting_created|awaiting_packaging|awaiting_registration/.test(workflowText)) return '等待备货';
  if (/posting_registered|awaiting_deliver|awaiting_delivery/.test(workflowText)) return '等待发货';
  if (statusTags.includes('等待发货')) return '等待发货';
  if (statusTags.includes('等待备货')) return '等待备货';
  if (statusTags.includes('已经发货')) return '已经发货';
  if (statusTags.includes('成功订单')) return '成功订单';
  if (statusTags.includes('关闭订单')) return '关闭订单';
  if (statusTags.includes('售后订单')) return '售后订单';

  const rawStatus = order.ozonStatus || order.ozonRawStatus || order.rawStatus || order.status;
  const baseStatus = getOzonOrderBaseStatusLabel(rawStatus);
  if (baseStatus !== '未知状态') return baseStatus;
  const text = String(rawStatus || '').toLowerCase();
  if (text.includes('等待备货')) return '等待备货';
  if (text.includes('等待发货')) return '等待发货';
  if (text.includes('发货超时') || text.includes('配送超时') || text.includes('shipment overdue')) return '等待发货';
  if (text.includes('运输中') || text.includes('已经发货') || text.includes('已发货')) return '已经发货';
  if (text.includes('已完成') || text.includes('已送达') || text.includes('成功订单')) return '成功订单';
  if (text.includes('取消') || text.includes('关闭')) return '关闭订单';
  if (text.includes('refund') || text.includes('退款') || text.includes('售后')) return '售后订单';
  return baseStatus;
}

export function deriveLegacyPurchaseOrderStatusByOzon(order = {}) {
  if (order.afterSaleClosed) return '关闭单';
  if (order.afterSaleStatus) return '已拍单-售后单';
  const ozonStatus = getPurchaseOrderOzonBaseStatus(order);
  if (ozonStatus === '等待备货') return '待拍单';
  if (ozonStatus === '等待发货') return '已拍单-待发货';
  if (ozonStatus === '已经发货') return '已拍单-已发货';
  if (ozonStatus === '成功订单') {
    return '完结单';
  }
  if (ozonStatus === '关闭订单') return '关闭单';
  if (ozonStatus === '售后订单') return '已拍单-售后单';
  return '已拍单-未操作';
}

export function derivePurchaseOrderStatus(order = {}) {
  const hasPurchase = hasConfirmedPurchasePlacement(order);
  const ozonStatus = getPurchaseOrderOzonBaseStatus(order);
  const hasCrossBorder = hasConfirmedCrossBorderOrder(order);
  const shouldIgnoreManualStatus =
    // “转待拍单”只描述采购单取消后的当前动作，不是可以永久覆盖
    // Ozon 履约事实的状态。Ozon 一旦离开等待备货，旧人工覆盖立即
    // 失效，由最新 Ozon 状态和采购/跨境记录重新派生订单阶段。
    (order.forcePurchaseStatus === '待拍单' && (hasPurchase || ozonStatus !== '等待备货')) ||
    (order.forcePurchaseStatus === '已拍单-未操作' &&
      ((ozonStatus === '等待发货' && hasCrossBorder) || ozonStatus === '已经发货'));
  if (order.forcePurchaseStatus && purchaseOrderStatusTones[order.forcePurchaseStatus]) {
    if (!shouldIgnoreManualStatus) {
      return order.forcePurchaseStatus;
    }
  }
  // 店铺绑定前的订单只有在尚未形成真实采购凭证时才沿用历史分类。
  // 一旦采购平台、采购单号、实付金额和付款状态已经完整回填，就必须
  // 进入当前拍单流程，不能再被“绑定前历史订单”规则压回待拍单。
  if (isPurchaseOrderBeforeShopBinding(order) && !hasPurchase) {
    return deriveLegacyPurchaseOrderStatusByOzon(order);
  }

  if (ozonStatus === '成功订单') return '完结单';
  if (ozonStatus === '关闭订单' || order.afterSaleClosed) return '关闭单';
  if (ozonStatus === '售后订单' || order.afterSaleStatus) {
    if (!hasPurchase && !hasCrossBorder) return '关闭单';
    return order.purchaseRefundConfirmed || order.afterSaleClosed ? '关闭单' : '已拍单-售后单';
  }
  if (ozonStatus === '已经发货') return '已拍单-已发货';
  if (hasPurchaseOrderConflict(order) || ozonStatus === '未知状态') return '已拍单-未操作';
  if (ozonStatus === '等待备货') return hasPurchase ? '已拍单-待预报' : '待拍单';
  if (ozonStatus === '等待发货') return hasCrossBorder ? '已拍单-待发货' : '已拍单-未操作';
  return order.status || '已拍单-未操作';
}

export function isConfirmedPurchasePlatformStatus(value = '') {
  const text = String(value || '').trim();
  return Boolean(
    text &&
    /已付款|支付成功|交易成功|待发货|等待卖家发货|买家已付款|已发货|待收货|已完成/.test(text) &&
    !/待付款|退款|已退款|退款成功|关闭|订单关闭|取消|已取消|未识别|未返回/.test(text)
  );
}

export function isPurchaseOrderRefundPending(order = {}) {
  const ozonStatus = getPurchaseOrderOzonBaseStatus(order);
  const rawStatus = String(order.ozonStatus || order.ozonRawStatus || order.rawStatus || '').toLowerCase();
  const hasOzonAfterSales =
    ozonStatus === '关闭订单' ||
    ozonStatus === '售后订单' ||
    Boolean(order.afterSaleStatus) ||
    rawStatus.includes('refund') ||
    rawStatus.includes('return') ||
    rawStatus.includes('cancel');

  return Boolean(hasOzonAfterSales && !order.purchaseRefundConfirmed && !order.afterSaleClosed);
}

export function isPurchaseOrderModuleMatch(order = {}, module = 'all') {
  const status = derivePurchaseOrderStatus(order);
  if (module === 'all') return true;
  if (module === '待拍单') return status === '待拍单';
  if (module === 'exception') return status === '已拍单-未操作';
  if (module === 'afterSales') return status === '已拍单-售后单' || isPurchaseOrderRefundPending(order);
  return true;
}

export function countPurchaseOrderModule(orders = [], module = 'all') {
  return orders.filter((order) => isPurchaseOrderModuleMatch(order, module)).length;
}

export function isPurchaseOrderStageMatch(order = {}, stage = 'all') {
  const status = derivePurchaseOrderStatus(order);
  if (stage === 'all') return true;
  return status === stage;
}

export function getPurchaseOrderStatusReason(order = {}, status = derivePurchaseOrderStatus(order)) {
  const ozonStatus = getPurchaseOrderOzonBaseStatus(order);
  if (order.forcePurchaseStatus === '待拍单' && ozonStatus !== '等待备货') {
    return `Ozon 已变为${ozonStatus}，旧的“转待拍单”状态已失效，按最新 Ozon 状态重新归类。`;
  }
  if (isPurchaseOrderBeforeShopBinding(order)) {
    if (status === '待拍单') return '店铺绑定前的历史订单，Ozon 仍在等待备货，按待拍单归类。';
    if (status === '已拍单-待发货') return '店铺绑定前的历史订单，Ozon 已到等待发货，按待发货归类。';
    if (status === '已拍单-已发货') return '店铺绑定前的历史订单，Ozon 已发货，按已发货归类。';
    if (status === '关闭单') return '店铺绑定前的历史订单，Ozon 已取消或售后关闭，按关闭单归类。';
    if (status === '完结单') return '店铺绑定前的历史订单，Ozon 已完成、取消或售后，按完结归类。';
    return '店铺绑定前的历史订单，只按 Ozon 状态归类。';
  }
  if (status === '待拍单' && order.crossBorderOrderFound) return '跨境巴士已有疑似订单，请人工核对后再拍单。';
  if (status === '已拍单-待预报') return '采购平台已付款成功，Ozon 仍在等待备货，等待预报。';
  if (status === '已拍单-待发货' && !hasValidPurchaseOrderNumber(order) && hasConfirmedCrossBorderOrder(order)) {
    return '历史已预报，待补采购信息。';
  }
  if (status === '已拍单-待发货') return 'Ozon 等待发货，采购或跨境巴士订单已确认。';
  if (status === '已拍单-已发货') return '订单已进入运输中，不支持继续编辑。';
  if (status === '已拍单-未操作') {
    if (ozonStatus === '已经发货') return 'Ozon 已发货，但缺少采购或跨境巴士确认，请人工核对。';
    if (isPurchaseOrderPreparedWithoutCrossBorder(order))
      return 'Ozon 已备货，但未确认跨境巴士预报，请补录预报或人工核对。';
    return order.purchaseException || '订单状态或采购/跨境巴士记录存在冲突，请人工核对。';
  }
  if (status === '已拍单-售后单') return 'Ozon 售后中，采购平台未确认退款或关闭。';
  if (status === '完结单' && ozonStatus === '已经发货') return 'Ozon 已发货，需按采购或跨境巴士记录核对，不自动归档。';
  if (status === '完结单') return '订单已完成或售后已关闭，仅保留归档信息。';
  if (status === '关闭单') return 'Ozon 订单已取消/关闭或售后已关闭，仅保留归档与成本核对信息。';
  return '按 Ozon 状态和采购记录归类。';
}

export function annotatePurchaseOrder(order = {}) {
  const derivedStatus = derivePurchaseOrderStatus(order);
  return {
    ...order,
    status: derivedStatus,
    sourceStatus: order.status,
    tone: purchaseOrderStatusTones[derivedStatus] || order.tone || 'default',
    statusReason: getPurchaseOrderStatusReason(order, derivedStatus),
    ozonStatusLabel: getPurchaseOrderOzonBaseStatus(order),
    manualClassified: Boolean(order.manualClassifiedAt && order.forcePurchaseStatus),
    searchText: getPurchaseOrderKeys(order).join(' '),
  };
}

export function getPurchaseOrderActionState(order = {}) {
  const status = order.status || derivePurchaseOrderStatus(order);
  const hasCrossBorder = hasConfirmedCrossBorderOrder(order);
  const canRepairForecast = isPurchaseOrderPreparedWithoutCrossBorder(order);
  const canPurchase = status === '待拍单' && !hasCrossBorder && !hasPurchaseOrderConflict(order);
  const canForecast =
    (status === '已拍单-待预报' || canRepairForecast) &&
    hasConfirmedPurchasePlacement(order) &&
    !hasCrossBorder &&
    !hasPurchaseOrderConflict(order);

  return {
    canPurchase,
    canForecast,
    forecastMode: canRepairForecast ? 'repair' : 'create',
    purchaseReason: canPurchase ? '' : hasCrossBorder ? '已查到跨境巴士订单，请人工核对。' : '当前状态不支持拍单。',
    forecastReason: canForecast
      ? ''
      : hasCrossBorder
        ? '已查到跨境巴士订单，不允许重复预报。'
        : status === '已拍单-待发货'
          ? '已确认待发货，不需要重复预报。'
          : '预报需要单独确认后执行。',
  };
}

export const PURCHASE_EMPTY_ORDER_NO_VALUES = new Set(['-', '未返回', '待确认', '待补录', '待拍单']);

export const PURCHASE_EMPTY_PLATFORM_VALUES = new Set(['-', '未返回', '待确认', '待补录', '待拍单']);

export const PURCHASE_EMPTY_PRICE_VALUES = new Set(['-', '未返回', '待确认', '待补录', '待拍单']);

export function isFilledPurchaseTextValue(value, emptyValues) {
  const text = String(value ?? '').trim();
  return Boolean(text) && !emptyValues.has(text);
}

export function isFilledPurchaseOrderNoValue(value) {
  return isFilledPurchaseTextValue(value, PURCHASE_EMPTY_ORDER_NO_VALUES);
}

export function isFilledPurchasePlatformValue(value) {
  return isFilledPurchaseTextValue(value, PURCHASE_EMPTY_PLATFORM_VALUES);
}

export function isFilledPurchasePriceValue(value) {
  const text = String(value ?? '').trim();
  if (!text || PURCHASE_EMPTY_PRICE_VALUES.has(text)) return false;
  return firstFiniteNumber(text) !== null || Boolean(text);
}

export function getManualPurchasePriceDisplay(order = {}) {
  const manualText = String(firstFilled(order.manualPurchasePrice, order.manualPurchasePriceText) || '').trim();
  const manualValue = firstFiniteNumber(order.manualPurchasePriceValue, manualText);
  if (manualValue !== null) return formatOzonPrice(manualValue, 'CNY');
  return isFilledPurchasePriceValue(manualText) ? manualText : '';
}

export function applyPurchaseManualFallbacks(order = {}) {
  const manualBuyerPlatform = String(order.manualBuyerPlatform || '').trim();
  const manualPurchaseOrderNo = String(order.manualPurchaseOrderNo || '').trim();
  const manualPriceDisplay = getManualPurchasePriceDisplay(order);
  const manualPriceValue = firstFiniteNumber(order.manualPurchasePriceValue, order.manualPurchasePrice);
  const primaryPriceValue = firstFiniteNumber(order.purchasePriceValue);
  const hasPrimaryPlatform = isFilledPurchasePlatformValue(order.buyerPlatform);
  const hasPrimarySupplier = isFilledPurchasePlatformValue(order.supplier);
  const hasPrimaryOrderNo = isFilledPurchaseOrderNoValue(order.purchaseOrderNo);
  const hasPrimaryPrice = isFilledPurchasePriceValue(order.purchasePrice) || primaryPriceValue !== null;
  const fallbackPriceValue = firstFiniteNumber(order.purchasePriceValue, manualPriceValue);
  const purchasePrice = isFilledPurchasePriceValue(order.purchasePrice)
    ? order.purchasePrice
    : primaryPriceValue !== null
      ? formatOzonPrice(primaryPriceValue, 'CNY')
      : manualPriceDisplay || order.purchasePrice;

  return {
    ...order,
    purchaseOrderStatus: String(firstFilled(order.purchaseOrderStatus, order.manualPurchaseOrderStatus) || '').trim(),
    buyerPlatform: hasPrimaryPlatform
      ? order.buyerPlatform
      : isFilledPurchasePlatformValue(manualBuyerPlatform)
        ? manualBuyerPlatform
        : order.buyerPlatform,
    supplier: hasPrimarySupplier
      ? order.supplier
      : isFilledPurchasePlatformValue(manualBuyerPlatform)
        ? manualBuyerPlatform
        : order.supplier,
    purchaseOrderNo: hasPrimaryOrderNo
      ? order.purchaseOrderNo
      : isFilledPurchaseOrderNoValue(manualPurchaseOrderNo)
        ? manualPurchaseOrderNo
        : order.purchaseOrderNo,
    purchasePrice,
    purchasePriceValue: hasPrimaryPrice
      ? (primaryPriceValue ?? order.purchasePriceValue)
      : (fallbackPriceValue ?? order.purchasePriceValue),
  };
}
