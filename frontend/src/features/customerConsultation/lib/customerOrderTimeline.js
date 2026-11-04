import { formatCustomerChatDateTime } from './customerOzonChatFormatter.js';

function normalizeText(value) {
  return String(value ?? '').trim();
}

function firstFilled(...values) {
  for (const value of values) {
    if (value === 0) return value;
    if (value !== undefined && value !== null && normalizeText(value)) return value;
  }
  return '';
}

function parseTime(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatCustomerTimelineTime(value, fallback = '时间待回读') {
  return parseTime(value) ? formatCustomerChatDateTime(value) : fallback;
}

function normalizeProductPageUrl(value) {
  const text = normalizeText(value);
  if (!/^https?:\/\//i.test(text)) return '';
  try {
    const url = new URL(text);
    return /(^|\.)ozon\.ru$/i.test(url.hostname) ? url.toString() : '';
  } catch {
    return '';
  }
}

export function buildCustomerOzonProductUrl(value) {
  const directUrl = normalizeProductPageUrl(value);
  if (directUrl) return directUrl;
  const productId = normalizeText(value);
  if (!/^\d{5,}$/.test(productId)) return '';
  return `https://www.ozon.ru/product/${encodeURIComponent(productId)}/`;
}

export function resolveCustomerProductContext(conversation = {}, orderRow = null) {
  const safeOrder = orderRow && typeof orderRow === 'object' ? orderRow : {};
  const rawOrder = safeOrder.raw && typeof safeOrder.raw === 'object' ? safeOrder.raw : {};
  const products = Array.isArray(safeOrder.products)
    ? safeOrder.products
    : Array.isArray(rawOrder.products)
      ? rawOrder.products
      : [];
  const product = products[0] || {};
  const rawProduct = product.raw && typeof product.raw === 'object' ? product.raw : {};
  const productId = firstFilled(
    product.sku,
    product.skuId,
    product.product_id,
    product.productId,
    rawProduct.sku,
    rawProduct.product_id,
    conversation.ozonSku,
    conversation.productId
  );
  const offerId = firstFilled(product.offer_id, product.offerId, rawProduct.offer_id, conversation.sku);
  const explicitUrl = firstFilled(
    product.ozonUrl,
    product.productUrl,
    product.product_url,
    rawProduct.ozon_url,
    conversation.productUrl
  );

  return {
    name: normalizeText(firstFilled(product.name, safeOrder.product, conversation.productName)) || '未关联商品',
    sku:
      normalizeText(firstFilled(productId, conversation.ozonSku, conversation.productId, conversation.sku)) || '未返回',
    offerId: normalizeText(offerId),
    imageUrl: normalizeText(
      firstFilled(
        product.primaryImage,
        product.primary_image,
        product.imageUrl,
        product.image,
        product.skuImage,
        product.sku_image,
        conversation.productImage
      )
    ),
    href: buildCustomerOzonProductUrl(firstFilled(explicitUrl, productId)),
  };
}

const ORDER_STATUS_EVENT_META = Object.freeze([
  {
    pattern: /awaiting_registration|registration|registered|forecast|declaration/i,
    type: 'forecasted',
    title: '完成订单预报',
    detail: '订单已进入卖家预报或登记流程。',
  },
  {
    pattern: /awaiting_packaging|packaging|packing/i,
    type: 'packaging',
    title: '开始备货',
    detail: '订单进入备货与打包阶段。',
  },
  {
    pattern: /awaiting_deliver|awaiting_delivery|shipment|shipped/i,
    type: 'shipment',
    title: '等待交付物流',
    detail: '卖家已处理订单，等待交付物流。',
  },
  {
    pattern: /delivering|driver_pickup|arbitration|in_transit|transport/i,
    type: 'in_transit',
    title: '运输中',
    detail: '订单已进入物流运输环节。',
  },
  {
    pattern: /delivered|completed/i,
    type: 'delivered',
    title: '配送完成',
    detail: 'Ozon 已回读订单配送完成。',
  },
  {
    pattern: /cancel|not_accepted|closed/i,
    type: 'closed',
    title: '订单已关闭',
    detail: '订单已取消或关闭。',
  },
  {
    pattern: /return|refund/i,
    type: 'after_sales',
    title: '进入售后',
    detail: '订单已进入退货或退款处理。',
  },
]);

function getStatusEventMeta(status) {
  const text = normalizeText(status);
  return ORDER_STATUS_EVENT_META.find((item) => item.pattern.test(text)) || null;
}

function normalizeTimelineEvent(event = {}, fallbackSource = 'Ozon') {
  const occurredAt = firstFilled(
    event.occurredAt,
    event.occurred_at,
    event.changedAt,
    event.changed_at,
    event.createdAt,
    event.created_at,
    event.updatedAt,
    event.updated_at,
    event.date,
    event.time
  );
  const parsed = parseTime(occurredAt);
  if (!parsed) return null;
  return {
    id: normalizeText(event.id),
    type: normalizeText(event.type || event.eventType || event.event_type) || 'ozon_event',
    title: normalizeText(event.title) || 'Ozon 状态更新',
    detail: normalizeText(event.detail || event.text || event.summary || event.message),
    source: normalizeText(event.source) || fallbackSource,
    occurredAt: parsed.toISOString(),
    timestamp: parsed.getTime(),
  };
}

function collectOrderStatusHistory(orderRow = {}) {
  const raw = orderRow.raw && typeof orderRow.raw === 'object' ? orderRow.raw : {};
  const histories = [
    orderRow.statusHistory,
    orderRow.status_history,
    orderRow.statusChanges,
    orderRow.status_changes,
    raw.statusHistory,
    raw.status_history,
    raw.statusChanges,
    raw.status_changes,
    raw.statuses,
  ].find(Array.isArray);
  if (!Array.isArray(histories)) return [];

  return histories
    .map((item, index) => {
      const status = firstFilled(item?.status, item?.state, item?.substatus, item?.eventType, item?.event_type);
      const meta = getStatusEventMeta(status);
      if (!meta) return null;
      return normalizeTimelineEvent(
        {
          ...item,
          id: item?.id || `history-${index}`,
          type: meta.type,
          title: meta.title,
          detail: item?.detail || item?.message || meta.detail,
          source: 'Ozon 状态回读',
        },
        'Ozon 状态回读'
      );
    })
    .filter(Boolean);
}

function collectOrderTimestampEvents(orderRow = {}) {
  if (!orderRow || typeof orderRow !== 'object') return [];
  const raw = orderRow.raw && typeof orderRow.raw === 'object' ? orderRow.raw : {};
  const candidates = [
    {
      id: 'order-created',
      type: 'ordered',
      title: '买家下单',
      detail: '订单进入 Ozon 处理流程。',
      source: 'Ozon 订单',
      occurredAt: firstFilled(
        orderRow.in_process_at,
        orderRow.inProcessAt,
        orderRow.created_at,
        orderRow.createdAt,
        raw.in_process_at,
        raw.created_at
      ),
    },
    {
      id: 'order-shipment-plan',
      type: 'shipment_plan',
      title: '计划发货',
      detail: '这是 Ozon 返回的计划发货时间，不代表已经实际交付物流。',
      source: 'Ozon 订单计划',
      occurredAt: firstFilled(orderRow.shipment_date, orderRow.shipmentDate, raw.shipment_date, raw.shipmentDate),
    },
    {
      id: 'order-delivering',
      type: 'delivering',
      title: '开始配送',
      detail: '订单已进入配送环节。',
      source: 'Ozon 物流',
      occurredAt: firstFilled(
        orderRow.delivering_date,
        orderRow.deliveringDate,
        raw.delivering_date,
        raw.deliveringDate
      ),
    },
    {
      id: 'order-delivered',
      type: 'delivered',
      title: '配送完成',
      detail: 'Ozon 已回读订单送达。',
      source: 'Ozon 物流',
      occurredAt: firstFilled(
        orderRow.delivered_at,
        orderRow.deliveredAt,
        raw.delivered_at,
        raw.deliveredAt,
        raw.delivery_date
      ),
    },
  ];
  return candidates.map((item) => normalizeTimelineEvent(item, item.source)).filter(Boolean);
}

function collectOrderRowsEvents(orderRows = [], fallbackOrderRow = null) {
  const rows = Array.isArray(orderRows) && orderRows.length ? orderRows : fallbackOrderRow ? [fallbackOrderRow] : [];
  return rows.flatMap((row) => {
    const postingNumber = normalizeText(row?.postingNumber || row?.posting_number || row?.id);
    const suffix = postingNumber ? ` · ${postingNumber}` : '';
    return [...collectOrderTimestampEvents(row), ...collectOrderStatusHistory(row)].map((event) => ({
      ...event,
      id: `${event.id || event.type}:${postingNumber || 'order'}`,
      detail: rows.length > 1 && event.detail ? `${event.detail}${suffix}` : event.detail,
    }));
  });
}

function collectHistoricalPurchaseEvents(orderRows = []) {
  return (Array.isArray(orderRows) ? orderRows : []).flatMap((orderRow, orderIndex) => {
    const fact = orderRow?.historicalOrderImport;
    if (!fact || typeof fact !== 'object') return [];
    const occurredAt = firstFilled(fact.updatedAt, orderRow.updatedAt);
    const pieces = [
      normalizeText(fact.sourcePlatform),
      normalizeText(fact.purchaseOrderNumber) ? `采购单 ${normalizeText(fact.purchaseOrderNumber)}` : '',
      normalizeText(fact.trackingNumber) ? `快递单 ${normalizeText(fact.trackingNumber)}` : '',
    ].filter(Boolean);
    if (!pieces.length) return [];
    return [
      normalizeTimelineEvent(
        {
          id: `historical-purchase-${orderIndex}`,
          type: 'domestic_purchase',
          title: fact.trackingNumber ? '国内采购与快递' : '国内采购已关联',
          detail: pieces.join(' · '),
          source: '历史采购记录',
          occurredAt,
        },
        '历史采购记录'
      ),
    ].filter(Boolean);
  });
}

function collectPurchaseOverrideEvents(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => {
      const platform = normalizeText(row?.purchasePlatform || row?.purchase_platform || row?.platform);
      const orderNumber = normalizeText(row?.purchaseOrderNumber || row?.purchase_order_number);
      const status = normalizeText(row?.manualStatus || row?.manual_status || row?.purchaseStatus);
      const trackingNumber = normalizeText(
        row?.trackingNumber || row?.tracking_number || row?.raw?.trackingNumber || row?.raw?.tracking_number
      );
      if (!platform && !orderNumber && !trackingNumber) return null;
      const details = [
        platform,
        orderNumber ? `采购单 ${orderNumber}` : '',
        trackingNumber ? `快递单 ${trackingNumber}` : '',
        status,
      ].filter(Boolean);
      return normalizeTimelineEvent(
        {
          id: `purchase-override-${row?.id || index}`,
          type: trackingNumber ? 'domestic_logistics' : 'domestic_purchase',
          title: trackingNumber ? '国内采购与快递' : '国内采购已关联',
          detail: details.join(' · '),
          source: '本地采购记录',
          occurredAt: firstFilled(row?.updatedAt, row?.updated_at, row?.createdAt, row?.created_at),
        },
        '本地采购记录'
      );
    })
    .filter(Boolean);
}

function collectPurchaseSourceEvents(rows = [], purchaseRows = []) {
  if (Array.isArray(purchaseRows) && purchaseRows.length) return [];
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => {
      const platform = normalizeText(row?.platform);
      const title = normalizeText(row?.title);
      if (!platform && !title) return null;
      return normalizeTimelineEvent(
        {
          id: `purchase-source-${row?.id || index}`,
          type: 'domestic_purchase_source',
          title: '国内货源已关联',
          detail: [platform, title].filter(Boolean).join(' · '),
          source: '本地货源记录',
          occurredAt: firstFilled(row?.updatedAt, row?.updated_at, row?.createdAt, row?.created_at),
        },
        '本地货源记录'
      );
    })
    .filter(Boolean);
}

function collectLogisticsEvents(rows = []) {
  return (Array.isArray(rows) ? rows : []).flatMap((row, index) => {
    const occurredAt = firstFilled(row?.lastSeenAt, row?.updatedAt, row?.createdAt);
    const purchaseOrderNumber = normalizeText(row?.purchaseOrderNumber || row?.fromOrder || row?.from_order);
    const trackingNumber = normalizeText(row?.trackingNumber || row?.tracking_number);
    const carrier = normalizeText(row?.carrierName || row?.carrier_name || row?.expressCompany || row?.express_company);
    const logisticsStatus = normalizeText(row?.readStatus || row?.read_status || row?.status);
    const warehouse = normalizeText(row?.warehouse);
    const routeName = normalizeText(row?.routeName || row?.route_name);
    const logisticsOrder = normalizeText(row?.logisticsOrder || row?.logistics_order);
    const events = [];
    if (purchaseOrderNumber || trackingNumber || carrier) {
      events.push(
        normalizeTimelineEvent(
          {
            id: `domestic-logistics-${row?.recordId || row?.id || index}`,
            type: 'domestic_logistics',
            title: trackingNumber ? '国内快递已同步' : '国内采购已同步',
            detail: [
              purchaseOrderNumber ? `采购单 ${purchaseOrderNumber}` : '',
              carrier,
              trackingNumber ? `快递单 ${trackingNumber}` : '',
              logisticsStatus,
            ]
              .filter(Boolean)
              .join(' · '),
            source: '跨境巴士同步记录',
            occurredAt,
          },
          '跨境巴士同步记录'
        )
      );
    }
    if (warehouse || routeName || logisticsOrder) {
      events.push(
        normalizeTimelineEvent(
          {
            id: `cross-border-route-${row?.recordId || row?.id || index}`,
            type: 'cross_border_route',
            title: '跨境物流路由',
            detail: [
              warehouse ? `仓库 ${warehouse}` : '',
              routeName,
              logisticsOrder ? `物流单 ${logisticsOrder}` : '',
              logisticsStatus,
            ]
              .filter(Boolean)
              .join(' · '),
            source: '跨境巴士同步记录',
            occurredAt,
          },
          '跨境巴士同步记录'
        )
      );
    }
    return events.filter(Boolean);
  });
}

function collectConversationSystemEvents(conversation = {}) {
  return (conversation.messages || [])
    .filter((message) => message?.role === 'system')
    .map((message) =>
      normalizeTimelineEvent(
        {
          ...message,
          occurredAt: firstFilled(message.occurredAt, message.createdAt),
          detail: message.text,
        },
        message.source || 'Ozon'
      )
    )
    .filter(Boolean);
}

function collectNotificationEvents(notifications = [], orderNumbers = []) {
  const normalizedOrderNumbers = new Set(
    (Array.isArray(orderNumbers) ? orderNumbers : [orderNumbers]).map(normalizeText).filter(Boolean)
  );
  if (!normalizedOrderNumbers.size) return [];
  return notifications
    .filter((notification) => {
      const notificationNumber = normalizeText(notification?.postingNumber || notification?.posting_number);
      return [...normalizedOrderNumbers].some(
        (orderNumber) =>
          notificationNumber === orderNumber ||
          notificationNumber.startsWith(`${orderNumber}-`) ||
          orderNumber.startsWith(`${notificationNumber}-`)
      );
    })
    .map((notification) =>
      normalizeTimelineEvent(
        {
          ...notification,
          type: notification.eventType || notification.event_type,
          detail: notification.summary || notification.message,
          source: notification.source || 'Ozon 后台同步',
        },
        'Ozon 后台同步'
      )
    )
    .filter(Boolean);
}

function getCustomerRouteStage(event = {}) {
  const type = normalizeText(event.type);
  if (type === 'ordered') return 100;
  if (['domestic_purchase', 'domestic_purchase_source', 'domestic_logistics'].includes(type)) return 200;
  if (type === 'cross_border_route') return 300;
  return 400;
}

export function buildCustomerOrderTimeline({
  conversation = {},
  orderRow = null,
  orderRows = [],
  purchaseRows = [],
  purchaseLinks = [],
  logisticsRows = [],
  notifications = [],
} = {}) {
  const explicitEvents = (conversation.orderTimeline || [])
    .map((event) => normalizeTimelineEvent(event, event.source || 'Ozon'))
    .filter(Boolean);
  const matchedOrderRows = Array.isArray(orderRows) && orderRows.length ? orderRows : orderRow ? [orderRow] : [];
  const orderNumbers = [
    conversation.orderNumber,
    ...matchedOrderRows.flatMap((row) => [
      row?.postingNumber,
      row?.posting_number,
      row?.orderNumber,
      row?.order_number,
      row?.raw?.order_number,
    ]),
  ];
  const rows = [
    ...explicitEvents,
    ...collectOrderRowsEvents(matchedOrderRows, orderRow),
    ...collectHistoricalPurchaseEvents(matchedOrderRows),
    ...collectPurchaseOverrideEvents(purchaseRows),
    ...collectPurchaseSourceEvents(purchaseLinks, purchaseRows),
    ...collectLogisticsEvents(logisticsRows),
    ...collectConversationSystemEvents(conversation),
    ...collectNotificationEvents(notifications, orderNumbers),
  ];
  const seen = new Set();
  return rows
    .sort((left, right) => {
      const stageDifference = getCustomerRouteStage(right) - getCustomerRouteStage(left);
      return stageDifference || right.timestamp - left.timestamp;
    })
    .filter((event) => {
      const key = `${event.type}:${event.occurredAt}:${event.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((event, index) => ({
      ...event,
      id: event.id || `${event.type}-${event.timestamp}-${index}`,
      timeLabel: formatCustomerTimelineTime(event.occurredAt),
    }));
}

export function resolveCustomerOrderContext(conversation = {}, orderRow = null) {
  const rawStatus = normalizeText(firstFilled(orderRow?.status, orderRow?.substatus, conversation.orderStatus));
  const normalizedStatus = rawStatus.toLowerCase();
  const statusLabel =
    normalizedStatus.includes('delivered') || normalizedStatus.includes('completed')
      ? '已送达'
      : normalizedStatus.includes('delivering') || normalizedStatus.includes('driver_pickup')
        ? '运输中'
        : normalizedStatus.includes('awaiting_packaging') || normalizedStatus.includes('awaiting_registration')
          ? '等待备货'
          : normalizedStatus.includes('awaiting_deliver') || normalizedStatus.includes('awaiting_delivery')
            ? '等待发货'
            : normalizedStatus.includes('cancel') || normalizedStatus.includes('not_accepted')
              ? '已关闭'
              : normalizedStatus.includes('return') || normalizedStatus.includes('refund')
                ? '售后处理中'
                : rawStatus || '未返回';
  return {
    orderNumber:
      normalizeText(firstFilled(orderRow?.postingNumber, orderRow?.posting_number, conversation.orderNumber)) ||
      '未关联订单',
    orderStatus: statusLabel,
  };
}
