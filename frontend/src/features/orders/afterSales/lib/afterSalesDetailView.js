import {
  translateAfterSalesLogisticsStatusToChinese,
  translateAfterSalesReasonToChinese,
} from '../../../../services/afterSalesReasonTranslate.js';

const STATUS_LABELS = new Map([
  ['OnWayToOzon', '退货运输至 Ozon 中'],
  ['Received', 'Ozon 已收到退货'],
  ['Rejected', '退货申请已拒绝'],
  ['Utilizing', '商品处置中'],
  ['UtilizingByOzon', 'Ozon 处置中'],
  ['Utilized', '商品已处置/销毁'],
  ['UtilizedByOzon', 'Ozon 已处置/销毁'],
  ['MoneyReturned', '已退款给买家'],
  ['PartialCompensationReturnedByOzon', 'Ozon 已部分补偿'],
  ['ReturningToSeller', '退回卖家途中'],
  ['ReturnedToSeller', '已退回卖家'],
  ['OnApproval', '等待卖家审核'],
  ['AwaitingDecision', '等待卖家处理'],
  ['Approved', '退货申请已同意'],
  ['Cancelled', '已取消'],
  ['Canceled', '已取消'],
  ['delivering', '运输中'],
  ['returned', '已退回'],
  ['В пути', '运输中'],
  ['Получен', '已收到退货'],
  ['Отклонена', '退货申请已拒绝'],
  ['Утилизирован', '商品已处置/销毁'],
  ['Утилизирован Ozon', 'Ozon 已处置/销毁'],
  ['На утилизации', '商品处置中'],
  ['На утилизации Ozon', 'Ozon 处置中'],
  ['Деньги возвращены', '已退款给买家'],
  ['Вы вернули часть денег', '已部分退款'],
]);

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function records(order = {}, raw = {}) {
  return [
    object(raw),
    object(raw.detail),
    object(raw.listItem),
    object(raw.return),
    object(raw.result),
    object(order),
    object(order.raw),
  ];
}

function firstRecordValue(rows = [], keys = []) {
  for (const row of rows) {
    for (const key of keys) {
      const value = row[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return '';
}

function readableObjectValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return value.name ?? value.title ?? value.text ?? value.message ?? value.state_name ?? value.state ?? value.id ?? '';
}

function chineseStatus(value) {
  const normalized = text(readableObjectValue(value));
  if (!normalized) return '';
  const exact = STATUS_LABELS.get(normalized);
  if (exact) return exact;
  const translated = translateAfterSalesLogisticsStatusToChinese(normalized);
  return /[\u0400-\u04FFA-Za-z]/u.test(translated.replace(/\b(?:Ozon|rFBS|FBS|FBO|SKU)\b/giu, ''))
    ? 'Ozon 返回的其他状态'
    : translated;
}

function chineseReason(value) {
  const normalized = text(readableObjectValue(value));
  if (!normalized) return '';
  const translated = translateAfterSalesReasonToChinese(normalized);
  return /[\u0400-\u04FFA-Za-z]/u.test(translated.replace(/\b(?:Ozon|rFBS|FBS|FBO|SKU)\b/giu, ''))
    ? 'Ozon 返回的其他售后原因'
    : translated;
}

function dateTime(value) {
  const normalized = text(value);
  if (!normalized) return '';
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : normalized;
}

function collectImages(value, result = []) {
  if (!value) return result;
  if (typeof value === 'string') {
    if (/^https?:\/\//iu.test(value) && !result.includes(value)) result.push(value);
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectImages(item, result));
    return result;
  }
  if (typeof value === 'object') {
    ['url', 'src', 'href', 'link', 'image', 'image_url', 'imageUrl', 'original', 'preview'].forEach(
      (key) => collectImages(value[key], result)
    );
  }
  return result;
}

function valueOrEmpty(value) {
  const normalized = text(value);
  return normalized && normalized !== '未返回' ? normalized : '';
}

export function getAfterSalesDetailView(order = {}, plan = null) {
  const raw = object(plan?.raw && Object.keys(plan.raw).length ? plan.raw : order.raw);
  const rows = records(order, raw);
  const state = object(firstRecordValue(rows, ['state']));
  const product = object(firstRecordValue(rows, ['product'])) || {};
  const fallbackProduct = object(order.products?.[0]);
  const returnReason = firstRecordValue(rows, ['return_reason', 'returnReason', 'reason']);
  const translatedOrderReason = valueOrEmpty(firstRecordValue(
    [object(order), object(order.raw)],
    ['reasonZh', 'reason_zh', 'return_reason_zh']
  ));
  const refundStatus = firstRecordValue(rows, [
    'refundStatus',
    'refund_status',
    'money_return_state_name',
    'moneyReturnStateName',
  ]) || state.money_return_state_name || state.moneyReturnStateName;
  const status = firstRecordValue(rows, ['status', 'return_status']) || state.state || state.state_name;
  const clientPhotos = [];
  rows.forEach((row) => {
    collectImages(row.client_photo, clientPhotos);
    collectImages(row.clientPhotos, clientPhotos);
    collectImages(row.customer_photos, clientPhotos);
    collectImages(row.customerPhotos, clientPhotos);
    collectImages(row.client_images, clientPhotos);
    collectImages(row.clientImages, clientPhotos);
    collectImages(row.evidence_photos, clientPhotos);
    collectImages(row.evidencePhotos, clientPhotos);
  });

  const fields = [
    ['售后申请号', valueOrEmpty(plan?.returnId || plan?.cancellationId || firstRecordValue(rows, ['return_id', 'returnId', 'cancellation_id', 'cancellationId']))],
    ['原订单号', valueOrEmpty(firstRecordValue(rows, ['order_number', 'orderNumber', 'salesOrder', 'order_id', 'orderId']))],
    ['货件号', valueOrEmpty(firstRecordValue(rows, ['posting_number', 'postingNumber', 'posting', 'salesOrder']))],
    ['售后状态', chineseStatus(status) || valueOrEmpty(order.status)],
    ['退款状态', chineseStatus(refundStatus) || valueOrEmpty(refundStatus)],
    ['售后原因', translatedOrderReason || chineseReason(returnReason) || valueOrEmpty(order.reason)],
    ['申请时间', dateTime(firstRecordValue(rows, ['created_at', 'createdAt', 'created']))],
    ['更新时间', dateTime(firstRecordValue(rows, ['updated_at', 'updatedAt', 'updated']))],
    ['退货物流单号', valueOrEmpty(firstRecordValue(rows, ['ru_post_tracking_number', 'tracking_number', 'trackingNumber']))],
    ['退货方式', chineseReason(firstRecordValue(rows, ['return_method_description', 'returnMethodDescription', 'client_return_method_type']))],
    ['仓库编号', valueOrEmpty(firstRecordValue(rows, ['warehouse_id', 'warehouseId']))],
    ['拒绝说明', chineseReason(firstRecordValue(rows, ['rejection_comment', 'rejectionComment']))],
  ].filter(([, value]) => value);

  return {
    fields,
    product: {
      name: valueOrEmpty(product.name || fallbackProduct.name || order.product),
      offerId: valueOrEmpty(product.offer_id || product.offerId || fallbackProduct.offerId || order.sku),
      sku: valueOrEmpty(product.sku || fallbackProduct.skuId || fallbackProduct.sku),
      price: valueOrEmpty(product.price || order.refundAmount),
      currency: valueOrEmpty(product.currency_code || product.currencyCode || order.currency),
      image: valueOrEmpty(product.image || product.image_url || fallbackProduct.image || fallbackProduct.imageUrl),
    },
    buyerComment: valueOrEmpty(firstRecordValue(rows, ['comment', 'buyer_comment', 'buyerComment', 'customer_comment', 'customerComment'])),
    clientPhotos,
    actionCount: Array.isArray(plan?.actions) ? plan.actions.length : 0,
  };
}

export { chineseReason as translateAfterSalesDetailReason, chineseStatus as translateAfterSalesDetailStatus };
