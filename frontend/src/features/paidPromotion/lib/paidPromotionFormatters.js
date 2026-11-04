import {
  getPaidPromotionMetricStateLabel,
  resolvePaidPromotionMetric,
} from './paidPromotionMetrics.js';

export function normalizeText(value) {
  return String(value ?? '').trim();
}

export function isMissingMetricValue(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

export function formatCnyAmount(value) {
  if (isMissingMetricValue(value)) return '未返回';
  const number = Number(value);
  if (!Number.isFinite(number)) return '未返回';
  return `¥ ${number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatRubAmount(value) {
  if (isMissingMetricValue(value)) return '未返回';
  const number = Number(value);
  if (!Number.isFinite(number)) return '未返回';
  return `${number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 卢布`;
}

export function formatMoney(value, rubToCnyRate) {
  if (isMissingMetricValue(value)) return '未返回';
  const number = Number(value);
  if (!Number.isFinite(number)) return '未返回';
  if (number === 0) return formatCnyAmount(0);
  const rate = Number(rubToCnyRate);
  // Ozon Performance always returns monetary fields in RUB. A delayed CNY
  // rate must not hide a valid bid/spend value or make it look unreturned.
  if (!Number.isFinite(rate) || rate <= 0) return formatRubAmount(number);
  return formatCnyAmount(number * rate);
}

export function formatPlainNumber(value) {
  if (isMissingMetricValue(value)) return '未返回';
  const number = Number(value);
  if (!Number.isFinite(number)) return '未返回';
  return number.toLocaleString('zh-CN');
}

export function formatMetric(value, suffix = '') {
  if (isMissingMetricValue(value)) return '未返回';
  const number = Number(value);
  if (!Number.isFinite(number)) return '未返回';
  return `${number.toLocaleString('zh-CN')}${suffix}`;
}

export function formatPercent(value) {
  if (isMissingMetricValue(value)) return '未返回';
  const number = Number(value);
  if (!Number.isFinite(number)) return '未返回';
  return `${number.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`;
}

export function getStatusTone(campaign = {}) {
  if (campaign.alerts?.moderationRejected) return 'error';
  if (campaign.alerts?.budgetExhausted) return 'warning';
  if (campaign.statusLabel === '运行中') return 'success';
  if (campaign.statusLabel === '已暂停' || campaign.statusLabel === '已停止') return 'default';
  return 'primary';
}

export function formatPromotionMetric(record = {}, key, formatter, ...formatterArgs) {
  const resolved = resolvePaidPromotionMetric(record, key);
  if (!isMissingMetricValue(resolved.value)) return formatter(resolved.value, ...formatterArgs);
  const stateLabel = getPaidPromotionMetricStateLabel(resolved.state);
  if (stateLabel) return stateLabel;
  const status = normalizeText(record.statistics?.availability?.status);
  if (status === 'empty') return '统计期无记录';
  if (status === 'failed') return '读取失败';
  if (status === 'skipped') return '未读取';
  return '未读取';
}

export function formatCampaignMetric(campaign = {}, key, formatter, ...formatterArgs) {
  return formatPromotionMetric(campaign, key, formatter, ...formatterArgs);
}
