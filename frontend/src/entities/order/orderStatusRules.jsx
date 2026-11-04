import { firstFilled } from './orderIdentityRules.jsx';

export const OZON_ORDER_RAW_STATUS = Object.freeze({
  awaitingPackaging: 'awaiting_packaging',
  awaitingDeliver: 'awaiting_deliver',
  delivering: 'delivering',
  delivered: 'delivered',
  cancelled: 'cancelled',
});

export const OZON_ORDER_STATUS_TEXT_COLORS = Object.freeze({
  未返回: '#667085',
  等待备货: '#8a6414',
  等待发货: '#3f6793',
  已经发货: '#62558a',
  成功订单: '#3f745d',
  关闭订单: '#805c5c',
  售后订单: '#8a5263',
  未知状态: '#5f6b7a',
});

const OZON_ORDER_RAW_STATUS_ALIASES = Object.freeze({
  // Older local fixtures and a few historical drafts used this non-canonical
  // spelling.  Ozon FBS currently returns `awaiting_deliver`; accept the old
  // value at the boundary but never emit it as the canonical state.
  awaiting_delivery: OZON_ORDER_RAW_STATUS.awaitingDeliver,
});

export function normalizeOzonOrderRawStatus(rawStatus = '') {
  const status = String(rawStatus || '').trim().toLowerCase();
  return OZON_ORDER_RAW_STATUS_ALIASES[status] || status.replace(/\bawaiting_delivery\b/gu, OZON_ORDER_RAW_STATUS.awaitingDeliver);
}

export function isOzonAwaitingPackagingRawStatus(rawStatus = '') {
  const status = normalizeOzonOrderRawStatus(rawStatus);
  return status === OZON_ORDER_RAW_STATUS.awaitingPackaging || status === 'awaiting_registration';
}

export function isOzonAwaitingDeliveryRawStatus(rawStatus = '') {
  return normalizeOzonOrderRawStatus(rawStatus) === OZON_ORDER_RAW_STATUS.awaitingDeliver;
}

export function getOzonOrderBaseStatusLabel(rawStatus) {
  const text = normalizeOzonOrderRawStatus(rawStatus);
  return text.includes('awaiting_packaging') || text.includes('awaiting_registration')
    ? '等待备货'
    : text.includes('awaiting_deliver')
      ? '等待发货'
      : text.includes('delivering') ||
          text.includes('driver_pickup') ||
          text.includes('arbitration') ||
          text.includes('client_arbitration')
        ? '已经发货'
        : text.includes('delivered')
          ? '成功订单'
          : text.includes('cancel') || text.includes('not_accepted')
            ? '关闭订单'
            : text.includes('return')
              ? '售后订单'
              : '未知状态';
}

export function getOzonOrderDisplayStatusLabel(rawStatus) {
  const normalized = normalizeOzonOrderRawStatus(rawStatus);
  if (!normalized) return '未返回';
  const label = getOzonOrderBaseStatusLabel(normalized);
  return label === '未知状态' ? `未识别状态：${normalized}` : label;
}

export function getOzonOrderStatusTextColor(rawStatus) {
  const normalized = normalizeOzonOrderRawStatus(rawStatus);
  if (!normalized) return OZON_ORDER_STATUS_TEXT_COLORS.未返回;
  const label = getOzonOrderBaseStatusLabel(normalized);
  return OZON_ORDER_STATUS_TEXT_COLORS[label] || OZON_ORDER_STATUS_TEXT_COLORS.未知状态;
}

export function getOzonOrderDeadlineRiskStatus(baseStatus, item = {}) {
  const deadlineRaw = firstFilled(
    item.cutoff_at,
    item.shipment_date,
    item.delivering_date,
    item.delivery_date_begin,
    item.delivery_date
  );
  const deadline = deadlineRaw ? new Date(deadlineRaw) : null;
  const needShip = ['等待备货', '等待发货'].includes(baseStatus);
  if (!needShip || !deadline || Number.isNaN(deadline.getTime())) return '';

  const delta = deadline.getTime() - Date.now();
  if (delta < 0) return '发货超时';
  if (delta <= 6 * 60 * 60 * 1000) return '即将超时';
  return '';
}

export function getOzonOrderStatusTags(rawStatus, item = {}) {
  const baseStatus = getOzonOrderBaseStatusLabel(rawStatus);
  const riskStatus = getOzonOrderDeadlineRiskStatus(baseStatus, item);
  return [baseStatus, riskStatus].filter(Boolean);
}

export function getOzonOrderStatusLabel(rawStatus, item = {}) {
  const tags = getOzonOrderStatusTags(rawStatus, item);
  return tags.includes('发货超时') ? '发货超时' : tags.includes('即将超时') ? '即将超时' : tags[0] || '未知状态';
}

export function getSalesOrderTone(status) {
  return status === '成功订单'
    ? 'success'
    : status === '关闭订单'
      ? 'default'
      : status === '发货超时'
        ? 'error'
        : 'warning';
}

export const afterSalesOrderStatusTabs = [
  { label: '全部订单', value: 'all', tone: 'primary' },
  { label: '发货前取消', value: '发货前取消', tone: 'warning' },
  { label: '发货后取消', value: '发货后取消', tone: 'error' },
  { label: '拒收后退款', value: '拒收后退款', tone: 'success' },
  { label: '签收后退款', value: '签收后退款', tone: 'error' },
];

export const salesOrderStatusTabs = [
  { label: '全部订单', value: 'all', tone: 'primary' },
  { label: '等待备货', value: '等待备货', tone: 'warning' },
  { label: '等待发货', value: '等待发货', tone: 'warning' },
  { label: '即将超时', value: '即将超时', tone: 'warning' },
  { label: '发货超时', value: '发货超时', tone: 'error' },
  { label: '已经发货', value: '已经发货', tone: 'primary' },
  { label: '售后订单', value: '售后订单', tone: 'error' },
  { label: '成功订单', value: '成功订单', tone: 'success' },
  { label: '关闭订单', value: '关闭订单', tone: 'default' },
  { label: '未知状态', value: '未知状态', tone: 'default' },
];
