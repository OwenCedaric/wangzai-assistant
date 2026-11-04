export const SMART_REPLY_SCENES = Object.freeze({
  passport: 'passportRequired',
  pickup: 'pickupReminder',
  shipment: 'shipmentNotice',
  review: 'reviewRequest',
});

export const SMART_REPLY_SCENE_VALUES = new Set(Object.values(SMART_REPLY_SCENES));

const PASSPORT_STATUSES = new Set(['posting_awaiting_passport_data']);
const PICKUP_STATUSES = new Set(['posting_in_pickup_point']);
const DELIVERED_STATUSES = new Set(['delivered', 'posting_delivered', 'posting_received']);
const CANCELLED_STATUSES = new Set([
  'cancelled',
  'canceled',
  'posting_canceled',
  'posting_cancelled',
  'posting_not_accepted',
]);
const SHIPMENT_SUBSTATUSES = new Set([
  'posting_transferring_to_delivery',
  'posting_transferring_to_courier',
  'posting_driver_pick_up',
  'posting_in_carriage',
  'posting_transferred_to_courier_service',
  'posting_in_courier_service',
  'posting_on_way_to_city',
  'posting_on_way_to_pickup_point',
]);

const VARIABLE_PLACEHOLDERS = Object.freeze({
  '{{买家昵称}}': 'buyerName',
  '{{产品名称}}': 'productName',
  '{{下单日期}}': 'orderedAt',
  '{{货件编号}}': 'postingNumber',
  '{{运单号}}': 'trackingNumber',
});

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function text(...values) {
  for (const value of values) {
    if (value === null || value === undefined || typeof value === 'object') continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return '';
}

function lower(...values) {
  return text(...values).toLowerCase();
}

export function unwrapPosting(payload) {
  const source = object(payload);
  return object(source.result && !Array.isArray(source.result) ? source.result : source);
}

export function postingNumber(posting = {}) {
  const source = object(posting);
  const raw = object(source.raw);
  return text(
    source.posting_number,
    source.postingNumber,
    raw.posting_number,
    raw.postingNumber,
    source.order_number,
  ).slice(0, 160);
}

export function postingStatus(posting = {}) {
  const raw = object(posting.raw);
  return {
    status: lower(posting.status, raw.status),
    substatus: lower(posting.substatus, raw.substatus),
  };
}

export function postingIsCancelled(posting = {}) {
  const { status, substatus } = postingStatus(posting);
  if (CANCELLED_STATUSES.has(status) || CANCELLED_STATUSES.has(substatus)) return true;
  const cancellation = object(posting.cancellation);
  if (Object.values(cancellation).some((value) => ![null, '', false, 0].includes(value))) return true;
  return Boolean(posting.cancel_reason || posting.cancellation_reason);
}

export function detectTriggerScene(posting = {}) {
  const { status, substatus } = postingStatus(posting);
  const triggerStatus = substatus || status;
  if (postingIsCancelled(posting)) return { scene: '', triggerStatus };
  if (DELIVERED_STATUSES.has(status) || DELIVERED_STATUSES.has(substatus)) {
    return { scene: SMART_REPLY_SCENES.review, triggerStatus };
  }
  if (PICKUP_STATUSES.has(status) || PICKUP_STATUSES.has(substatus)) {
    return { scene: SMART_REPLY_SCENES.pickup, triggerStatus };
  }
  if (PASSPORT_STATUSES.has(status) || PASSPORT_STATUSES.has(substatus)) {
    return { scene: SMART_REPLY_SCENES.passport, triggerStatus };
  }
  if (status === 'delivering' && (!substatus || SHIPMENT_SUBSTATUSES.has(substatus))) {
    return { scene: SMART_REPLY_SCENES.shipment, triggerStatus: triggerStatus || status };
  }
  if (SHIPMENT_SUBSTATUSES.has(substatus)) {
    return { scene: SMART_REPLY_SCENES.shipment, triggerStatus };
  }
  return { scene: '', triggerStatus };
}

function dateOnly(value) {
  const normalized = text(value);
  if (!normalized) return '';
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : normalized.slice(0, 10);
}

export function postingVariables(posting = {}, fallbackPostingNumber = '') {
  const analytics = object(posting.analytics_data);
  const customer = object(posting.customer);
  const products = Array.isArray(posting.products) ? posting.products : [];
  const productNames = [];
  for (const item of products) {
    const row = object(item);
    const name = text(row.name, row.product_name, row.title);
    if (name && !productNames.includes(name)) productNames.push(name);
  }
  const trackingNumbers = Array.isArray(posting.tracking_numbers) ? posting.tracking_numbers : [];
  return {
    buyerName: text(
      analytics.buyer_name,
      analytics.buyerName,
      customer.name,
      posting.customer_name,
      'покупатель',
    ),
    productName: productNames.slice(0, 3).join(', ') || 'товар',
    orderedAt: dateOnly(posting.in_process_at || posting.created_at || posting.order_date),
    postingNumber: text(fallbackPostingNumber, posting.posting_number),
    trackingNumber: text(
      posting.tracking_number,
      posting.trackingNumber,
      trackingNumbers[0],
    ),
  };
}

export function renderTemplate(template, variables = {}) {
  let rendered = text(template);
  for (const [placeholder, variable] of Object.entries(VARIABLE_PLACEHOLDERS)) {
    rendered = rendered.replaceAll(placeholder, text(variables[variable]));
  }
  return rendered.replaceAll(/\s+/gu, ' ').trim();
}

export function missingTemplateVariables(template, variables = {}) {
  const source = String(template || '');
  return Object.entries(VARIABLE_PLACEHOLDERS)
    .filter(([placeholder, variable]) => source.includes(placeholder) && !text(variables[variable]))
    .map(([placeholder]) => placeholder);
}

export function postingObservedAt(posting = {}) {
  return text(
    posting.updated_at,
    posting.status_changed_at,
    posting.delivering_date,
    posting.shipment_date,
    posting.in_process_at,
    posting.created_at,
    posting.order_date,
  );
}
