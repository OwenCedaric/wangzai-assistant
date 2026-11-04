const DOMAIN_LABELS = Object.freeze({
  products: '商品变化',
  orders: '订单进度',
  returns: '售后处理',
  purchase: '采购跟进',
  profit: '利润变化',
  performance: '推广变化',
  marketing: '营销变化',
  logistics: '物流进度',
  finance: '财务变化',
  customer: '买家消息',
  ozon: 'Ozon 通知',
});

const EVENT_LABELS = Object.freeze({
  product_status_changed: '商品状态',
  product_price_changed: '销售价格',
  product_stock_zero: '库存售罄',
  product_stock_low: '库存不足',
  order_new: '新订单',
  order_paid: '买家付款',
  order_status_changed: '订单进度',
  order_cancelled: '订单取消',
  fbo_order_new: 'FBO 新订单',
  fbo_order_cancelled: 'FBO 订单取消',
  fbo_order_status_changed: 'FBO 订单进度',
  order_cutoff_changed: '备货时限',
  order_delivery_date_changed: '送达时间',
  fbo_delivery_date_changed: 'FBO 送达时间',
  product_created: '商品创建',
  product_updated: '商品更新',
  product_created_or_updated: '商品更新',
  product_price_index_changed: '价格指数',
  product_stock_changed: '库存变化',
  fbo_stock_changed: 'FBO 库存',
  chat_message_new: '买家新消息',
  chat_message_updated: '消息更新',
  chat_message_read: '消息已读',
  chat_closed: '会话关闭',
  return_created: '新增售后',
  return_status_changed: '退款/售后',
  purchase_source_missing: '货源缺失',
  purchase_order_changed: '采购变化',
  profit_penalty_changed: '亏损变化',
  profit_finance_changed: '财务变化',
  performance_budget_exhausted: '推广预算用完',
  performance_moderation_rejected: '推广审核未通过',
});

const ORDER_STATUS_LABELS = new Map([
  ['order_payment_pending', '等待付款'],
  ['payment_pending', '等待付款'],
  ['order_paid', '买家已付款'],
  ['paid', '买家已付款'],
  ['order_verified', '订单已确认'],
  ['verified', '订单已确认'],
  ['order_created', '订单已创建'],
  ['order_new', '新订单'],
  ['order_cancelled', '订单已取消'],
  ['order_canceled', '订单已取消'],
  ['order_completed', '订单已完成'],
  ['awaiting_registration', '等待登记'],
  ['acceptance_in_progress', '正在接单'],
  ['awaiting_approve', '等待确认'],
  ['awaiting_packaging', '等待备货'],
  ['awaiting_deliver', '等待发货'],
  ['delivering', '已发货'],
  ['delivered', '已签收'],
  ['cancelled', '已取消'],
  ['canceled', '已取消'],
  ['arbitrage', '仲裁处理中'],
  ['client_arbitration', '买家仲裁处理中'],
  ['posting_created', '货件已创建'],
  ['posting_registered', '货件已登记'],
  ['posting_acceptance_in_progress', '货件接收中'],
  ['posting_in_arbitration', '货件仲裁处理中'],
  ['posting_transferring_to_delivery', '正在交接配送'],
  ['posting_transferring_to_courier', '正在交接快递'],
  ['posting_on_way_to_city', '运往收货城市'],
  ['posting_on_way_to_pickup_point', '运往提货点'],
  ['posting_in_pickup_point', '已到提货点'],
  ['posting_conditionally_delivered', '配送完成，等待确认'],
  ['posting_driver_pick_up', '配送员已取件'],
  ['posting_delivered', '已送达'],
  ['posting_received', '买家已签收'],
  ['posting_canceled', '货件已取消'],
  ['posting_cancelled', '货件已取消'],
  ['posting_not_accepted', '货件未被接收'],
  ['posting_in_carriage', '运输中'],
  ['posting_not_in_carriage', '尚未交运'],
  ['posting_transferred_to_courier_service', '已交给快递'],
  ['posting_in_courier_service', '快递配送中'],
  ['posting_awaiting_passport_data', '等待买家补充证件信息'],
]);

const PRODUCT_STATUS_LABELS = new Map([
  ['all', '全部商品'],
  ['visible', '销售中'],
  ['active', '销售中'],
  ['in_sale', '销售中'],
  ['invisible', '不可见'],
  ['empty_stock', '库存为 0'],
  ['empty_stocks', '库存为 0'],
  ['no_stocks', '无库存'],
  ['not_moderated', '待审核'],
  ['moderated', '审核完成'],
  ['validation_state_pending', '审核中'],
  ['validation_state_fail', '审核未通过'],
  ['validation_state_success', '审核通过'],
  ['premoderation', '预审核中'],
  ['waiting_for_service', '等待平台处理'],
  ['disabled', '已停用'],
  ['state_failed', '状态异常'],
  ['ready_to_supply', '待补货'],
  ['to_supply', '待补货'],
  ['archived', '已归档'],
  ['overpriced', '价格偏高'],
  ['critically_overpriced', '价格严重偏高'],
  ['removed_from_sale', '已下架'],
  ['not_for_sale', '已下架'],
  ['other', '其他商品状态'],
]);

const AFTER_SALES_STATUS_LABELS = new Map([
  ['onwaytoozon', '退货运输至 Ozon 中'],
  ['received', 'Ozon 已收到退货'],
  ['rejected', '退货申请已拒绝'],
  ['utilizing', '商品处置中'],
  ['utilizingbyozon', 'Ozon 处置中'],
  ['utilized', '商品已处置/销毁'],
  ['utilizedbyozon', 'Ozon 已处置/销毁'],
  ['moneyreturned', '已退款'],
  ['partialcompensationreturned', '已向买家部分补偿'],
  ['partialcompensationreturnedbyozon', 'Ozon 已向买家部分补偿'],
  ['returningtoseller', '退回卖家途中'],
  ['returnedtoseller', '已退回卖家'],
  ['onapproval', '等待卖家审核'],
  ['awaitingdecision', '等待卖家处理'],
  ['approved', '退货申请已同意'],
  ['onsellerclarification', '等待卖家说明'],
  ['onsellerclarificationafterpartialcompensation', '部分补偿后等待卖家说明'],
  ['offeredpartialcompensation', '已提出部分补偿方案'],
  ['awaitingreturn', '等待买家退货'],
  ['pending', '等待处理'],
  ['cancelled', '已取消'],
  ['canceled', '已取消'],
  ['delivering', '运输中'],
  ['returned', '已退回'],
  ['в пути', '运输中'],
  ['получен', '已收到退货'],
  ['отклонена', '退货申请已拒绝'],
  ['утилизирован', '商品已处置/销毁'],
  ['утилизирован ozon', 'Ozon 已处置/销毁'],
  ['на утилизации', '商品处置中'],
  ['на утилизации ozon', 'Ozon 处置中'],
  ['деньги возвращены', '已退款'],
  ['вы вернули часть денег', '已部分退款'],
  ['компенсировали покупателю', '已向买家部分补偿'],
]);

function normalizeText(value) {
  if (value === null || value === undefined || typeof value === 'object') return '';
  const text = String(value).trim();
  if (text.includes('\uFFFD')) return '';
  return text && !['未返回', '未知', 'unknown', '[object Object]'].includes(text.toLowerCase()) ? text : '';
}

function firstText(...values) {
  return values.map(normalizeText).find(Boolean) || '';
}

function containsUntranslatedForeignText(value) {
  const withoutAllowedNames = normalizeText(value).replace(/\b(?:Ozon|rFBS|FBS|FBO|SKU)\b/giu, '');
  return /[A-Za-z\u0400-\u04FF]/u.test(withoutAllowedNames);
}

const STATUS_TEXT_LABELS = new Map([
  ...ORDER_STATUS_LABELS,
  ...PRODUCT_STATUS_LABELS,
  ...AFTER_SALES_STATUS_LABELS,
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function translateKnownStatusCodesInText(value) {
  let translated = normalizeText(value);
  if (!translated) return '';
  [...STATUS_TEXT_LABELS.entries()]
    .sort(([left], [right]) => right.length - left.length)
    .forEach(([code, label]) => {
      const escaped = escapeRegExp(code);
      const pattern = /^[a-z0-9_]+$/iu.test(code)
        ? new RegExp(`\\b${escaped}\\b`, 'giu')
        : new RegExp(escaped, 'giu');
      translated = translated.replace(pattern, label);
    });
  return translated;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeHttpUrl(value) {
  const url = normalizeText(value);
  return /^https?:\/\//i.test(url) ? url : '';
}

function firstHttpUrl(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = value.map(normalizeHttpUrl).find(Boolean);
      if (nested) return nested;
      continue;
    }
    const url = normalizeHttpUrl(value);
    if (url) return url;
  }
  return '';
}

function formatNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return normalizeText(value);
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(number);
}

export function formatNotificationMoney(value, currencyCode = '') {
  const text = normalizeText(value);
  if (!text) return '';
  if (/[^\d.,+\-\s]/u.test(text)) return text;
  const number = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(number)) return text;
  const currency = normalizeText(currencyCode).toUpperCase();
  const amount = formatNumber(number);
  if (currency === 'CNY' || currency === 'RMB') return `¥${amount}`;
  if (currency === 'RUB' || currency === 'RUR') return `₽${amount}`;
  if (currency === 'USD') return `$${amount}`;
  if (currency === 'EUR') return `€${amount}`;
  return currency ? `${amount} ${currency}` : amount;
}

export function getNotificationDomainLabel(domain, fallback = '') {
  return DOMAIN_LABELS[domain] || normalizeText(fallback) || normalizeText(domain) || '其他变化';
}

export function getNotificationEventLabel(eventType, fallback = '') {
  return EVENT_LABELS[eventType] || normalizeText(fallback) || '信息变化';
}

function describeOrderStatus(value) {
  const original = normalizeText(value);
  const text = original.toLowerCase();
  if (!text) return '';
  const exact = ORDER_STATUS_LABELS.get(text);
  if (exact) return exact;
  if (/awaiting[_\s-]*(packaging|registration)|等待备货/.test(text)) return '等待备货';
  if (/awaiting[_\s-]*(deliver|delivery)|等待发货/.test(text)) return '等待发货';
  if (/delivering|driver[_\s-]*pickup|已经发货|已发货|运输中|派送中/.test(text)) return '已发货';
  if (/\bdelivered\b|posting[_\s-]*received|成功订单|已签收|已送达/.test(text)) return '已签收';
  if (/cancel|not[_\s-]*accepted|关闭订单|已取消|取消订单/.test(text)) return '已取消';
  if (/refund.*(complete|success|returned)|moneyreturned|已退款/.test(text)) return '已退款';
  if (/refund|退款处理中/.test(text)) return '退款处理中';
  return containsUntranslatedForeignText(original) ? 'Ozon 返回的其他订单状态' : original;
}

function describeProductStatus(value) {
  const original = normalizeText(value);
  const text = original.toLowerCase();
  if (!text) return '';
  const exact = PRODUCT_STATUS_LABELS.get(text);
  if (exact) return exact;
  if (/not[_\s-]*for[_\s-]*sale|archiv|disable|block|下架|不可售|停售|已关闭/.test(text)) return '已下架';
  if (/moderation|审核/.test(text) && /fail|reject|未通过|失败/.test(text)) return '审核未通过';
  if (/visible|active|on[_\s-]*sale|在售|销售中/.test(text)) return '销售中';
  return containsUntranslatedForeignText(original) ? 'Ozon 返回的其他商品状态' : original;
}

function describeAfterSalesStatus(value) {
  const original = normalizeText(value);
  if (!original) return '';
  const exact = AFTER_SALES_STATUS_LABELS.get(original.toLowerCase());
  if (exact) return exact;

  const orderStatus = describeOrderStatus(original);
  if (orderStatus !== original && orderStatus !== 'Ozon 返回的其他订单状态') return orderStatus;

  return containsUntranslatedForeignText(original) ? 'Ozon 返回的其他售后状态' : original;
}

function describeAfterSalesReason(value) {
  const original = translateKnownStatusCodesInText(value);
  if (!original) return '';
  return containsUntranslatedForeignText(original) ? 'Ozon 返回的其他售后原因' : original;
}

function getProductInfo(notification, oldValue, newValue) {
  const product = asObject(notification.product);
  const name = firstText(
    notification.productName,
    product.name,
    product.title,
    newValue.name,
    newValue.productName,
    oldValue.name,
    oldValue.productName
  );
  const sku = firstText(
    notification.productSku,
    notification.offerId,
    notification.sku,
    product.offerId,
    product.sku,
    newValue.offerId,
    newValue.sku,
    oldValue.offerId,
    oldValue.sku
  );
  const productId = firstText(notification.productId, product.productId, newValue.productId, oldValue.productId);
  const image = firstHttpUrl(
    notification.productImage,
    notification.imageUrl,
    product.image,
    product.imageUrl,
    product.images,
    newValue.primaryImageUrl,
    newValue.imageUrl,
    newValue.image,
    newValue.images,
    oldValue.primaryImageUrl,
    oldValue.imageUrl,
    oldValue.image,
    oldValue.images
  );
  const productCount = Math.max(0, Number(notification.productCount) || 0);
  return { name, sku, productId, image, productCount };
}

function getPostingNumber(notification) {
  return firstText(
    notification.postingNumber,
    notification.posting,
    notification.salesOrder,
    notification.orderNumber,
    notification.orderId,
    notification.orderKey,
    notification.entityType === 'order' || notification.entityType === 'after_sales_order' ? notification.entityId : ''
  );
}

function getRefundFacts(notification, oldValue, newValue) {
  const amount = firstText(
    notification.refundAmount,
    newValue.refundAmount,
    newValue.amount,
    oldValue.refundAmount,
    oldValue.amount
  );
  const currencyCode = firstText(notification.currencyCode, newValue.currencyCode, oldValue.currencyCode);
  const reason = firstText(
    notification.refundReason,
    notification.reason,
    newValue.refundReason,
    newValue.reason,
    oldValue.refundReason,
    oldValue.reason
  );
  return {
    amount: formatNotificationMoney(amount, currencyCode),
    reason: describeAfterSalesReason(reason),
  };
}

function getStatusChange(notification, oldValue, newValue) {
  const eventType = notification.eventType;
  if (eventType === 'product_price_changed') {
    const currencyCode = firstText(newValue.currencyCode, oldValue.currencyCode, notification.currencyCode);
    return {
      label: '销售价',
      oldText: formatNotificationMoney(oldValue.priceValue ?? oldValue.price, currencyCode),
      newText: formatNotificationMoney(newValue.priceValue ?? newValue.price, currencyCode),
    };
  }
  if (eventType === 'product_stock_zero' || eventType === 'product_stock_low') {
    const oldStock = firstText(oldValue.stockValue, oldValue.stock);
    const newStock = firstText(newValue.stockValue, newValue.stock);
    return {
      label: '库存',
      oldText: oldStock ? `${formatNumber(oldStock, 0)}件` : '',
      newText: newStock ? `${formatNumber(newStock, 0)}件` : '',
    };
  }
  if (eventType === 'product_status_changed') {
    return {
      label: '商品状态',
      oldText: describeProductStatus(firstText(oldValue.statusLabel, oldValue.status, oldValue.visibility)),
      newText: describeProductStatus(firstText(newValue.statusLabel, newValue.status, newValue.visibility)),
    };
  }
  if (eventType === 'return_created' || eventType === 'return_status_changed') {
    return {
      label: '售后状态',
      oldText: describeAfterSalesStatus(firstText(oldValue.refundStatus, oldValue.status, oldValue.substatus)),
      newText: describeAfterSalesStatus(firstText(newValue.refundStatus, newValue.status, newValue.substatus)),
    };
  }
  if (
    eventType === 'order_new' ||
    eventType === 'order_paid' ||
    eventType === 'order_status_changed' ||
    eventType === 'fbo_order_new' ||
    eventType === 'fbo_order_status_changed' ||
    eventType === 'order_cancelled' ||
    eventType === 'fbo_order_cancelled'
  ) {
    return {
      label: '订单状态',
      oldText: describeOrderStatus(firstText(oldValue.status, notification.previousStatus)),
      newText: describeOrderStatus(firstText(newValue.status, notification.nextStatus, notification.status)),
    };
  }
  return { label: '变化', oldText: '', newText: '' };
}

function resolveHeadline(notification, postingNumber, product, change, refundFacts) {
  const eventType = notification.eventType;
  const orderPrefix = postingNumber ? `订单 ${postingNumber}` : '订单';
  const productPrefix = product.name ? `商品“${product.name}”` : product.sku ? `商品 ${product.sku}` : '商品';

  if (eventType === 'product_price_changed') return `${productPrefix}销售价已调整`;
  if (eventType === 'product_stock_zero') return `${productPrefix}库存已降到 0`;
  if (eventType === 'product_stock_low') return `${productPrefix}库存不足`;
  if (eventType === 'product_status_changed') {
    return change.newText === '已下架'
      ? `${productPrefix}已下架`
      : `${productPrefix}状态变为“${change.newText || '已变化'}”`;
  }
  if (eventType === 'order_new') return `${orderPrefix} 已生成新订单`;
  if (eventType === 'order_paid') return `${orderPrefix} 买家已付款`;
  if (eventType === 'order_status_changed') {
    if (change.newText === '已发货') return `${orderPrefix} 已发货`;
    if (change.newText === '已签收') return `${orderPrefix} 已签收`;
    if (change.newText === '已取消') return `${orderPrefix} 已取消`;
    return `${orderPrefix} 状态变为“${change.newText || '已变化'}”`;
  }
  if (eventType === 'order_cancelled' || eventType === 'fbo_order_cancelled') return `${orderPrefix} 已取消`;
  if (eventType === 'fbo_order_new') return `${orderPrefix} 已生成 FBO 新订单`;
  if (eventType === 'fbo_order_status_changed') {
    return `${orderPrefix} FBO 状态变为“${change.newText || '已变化'}”`;
  }
  if (eventType === 'return_created') return `${orderPrefix} 新增退款/售后申请`;
  if (eventType === 'return_status_changed') {
    if (change.newText === '已退款' || /已退款/.test(firstText(notification.title, notification.summary))) {
      return `${orderPrefix} 已退款${refundFacts.amount ? ` ${refundFacts.amount}` : ''}`;
    }
    return `${orderPrefix} 售后状态变为“${change.newText || '已变化'}”`;
  }
  return firstText(notification.title, getNotificationEventLabel(eventType)) || '收到一条业务变化';
}

export function formatNotificationEvent(notification = {}) {
  const oldValue = asObject(notification.oldValue);
  const newValue = asObject(notification.newValue);
  const product = getProductInfo(notification, oldValue, newValue);
  const postingNumber = getPostingNumber(notification);
  const refundFacts = getRefundFacts(notification, oldValue, newValue);
  const change = getStatusChange(notification, oldValue, newValue);
  const headline = resolveHeadline(notification, postingNumber, product, change, refundFacts);
  const facts = [];

  if (product.name) {
    facts.push({
      label: '商品',
      value: `${product.name}${product.productCount > 1 ? ` 等 ${product.productCount} 件商品` : ''}`,
    });
  }
  if (refundFacts.amount) facts.push({ label: '退款金额', value: refundFacts.amount });
  if (refundFacts.reason) facts.push({ label: '退款原因', value: refundFacts.reason });

  const rawSummary = firstText(notification.summary, notification.message);
  const translatedSummary = translateKnownStatusCodesInText(rawSummary);
  const summaryFallback = containsUntranslatedForeignText(translatedSummary) && change.newText
    ? `${change.label}已更新为“${change.newText}”`
    : translatedSummary;
  if (!facts.length && summaryFallback && summaryFallback !== headline) {
    facts.push({ label: '说明', value: summaryFallback });
  }

  return {
    headline,
    eventLabel: getNotificationEventLabel(notification.eventType, notification.title),
    domainLabel: getNotificationDomainLabel(notification.domain),
    postingNumber,
    product,
    change,
    facts,
  };
}

export const notificationDomainLabels = DOMAIN_LABELS;
export const notificationEventLabels = EVENT_LABELS;
