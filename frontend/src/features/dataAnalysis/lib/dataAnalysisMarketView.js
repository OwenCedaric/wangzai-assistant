const MARKET_DATASET_LABELS = Object.freeze({
  keywords: '关键词机会',
  'product-performance': '商品表现',
  comparison: '竞品对比',
  categories: '类目机会',
  brands: '品牌机会',
  'missing-items': '缺货机会',
  'traffic-conversion': '流量转化',
  reports: '报表数据',
});

const PRIMARY_MARKET_DATASET_ORDER = Object.freeze([
  'keywords',
  'product-performance',
  'comparison',
  'categories',
  'brands',
  'missing-items',
  'traffic-conversion',
  'reports',
]);

const PRIMARY_MARKET_DATASET_IDS = new Set(PRIMARY_MARKET_DATASET_ORDER);
const KEYWORD_METRIC_FIELDS = Object.freeze([
  'searches',
  'views',
  'orders',
  'revenue',
  'conversion',
  'uniqueSellers',
]);

export const EMPTY_MARKET_DATASETS = Object.freeze([]);

export function marketText(value, fallback = '—') {
  const result = String(value ?? '').trim();
  return result || fallback;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatMarketNumber(value, fallback = '—') {
  const parsed = finiteNumber(value);
  return parsed === null ? fallback : parsed.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

export function formatMarketMoney(value, fallback = '—') {
  const parsed = finiteNumber(value);
  return parsed === null ? fallback : `￥${parsed.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
}

export function formatMarketPercent(value, fallback = '—') {
  const parsed = finiteNumber(value);
  return parsed === null ? fallback : `${parsed.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`;
}

export function formatMarketTime(value) {
  if (!value) return '尚未返回';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? String(value)
    : parsed.toLocaleString('zh-CN', { hour12: false });
}

export function marketDatasetId(dataset) {
  return String(dataset?.dataset || dataset?.id || '').trim();
}

export function marketDatasetLabel(dataset) {
  const id = marketDatasetId(dataset);
  return MARKET_DATASET_LABELS[id] || dataset?.title || id || '市场数据';
}

export function rawMarketDatasetRecords(dataset) {
  return Array.isArray(dataset?.records) ? dataset.records : EMPTY_MARKET_DATASETS;
}

export function marketDatasetRecords(dataset) {
  const rows = rawMarketDatasetRecords(dataset);
  if (marketDatasetId(dataset) !== 'keywords') return rows;
  const measurableRows = rows.filter((row) => KEYWORD_METRIC_FIELDS.some((field) => {
    const value = row?.[field];
    return value !== null && value !== undefined && value !== '';
  }));
  return measurableRows.length ? measurableRows : rows;
}

export function marketDatasetRecordCount(dataset) {
  const rows = marketDatasetRecords(dataset);
  return rows.length || Number(dataset?.recordCount || 0) || 0;
}

export function getPrimaryMarketDatasetViews(datasets = EMPTY_MARKET_DATASETS) {
  const order = new Map(PRIMARY_MARKET_DATASET_ORDER.map((id, index) => [id, index]));
  return datasets
    .filter((dataset) => marketDatasetRecordCount(dataset) > 0 && PRIMARY_MARKET_DATASET_IDS.has(marketDatasetId(dataset)))
    .sort((left, right) => (
      order.get(marketDatasetId(left)) - order.get(marketDatasetId(right))
      || marketDatasetRecordCount(right) - marketDatasetRecordCount(left)
    ));
}

export function countHiddenMarketDatasets(datasets = EMPTY_MARKET_DATASETS) {
  return datasets.filter((dataset) => (
    marketDatasetRecordCount(dataset) > 0
    && !PRIMARY_MARKET_DATASET_IDS.has(marketDatasetId(dataset))
  )).length;
}

function hasRecordValue(rows, field) {
  return rows.some((row) => {
    const value = row?.[field];
    if (value === null || value === undefined || value === '') return false;
    return typeof value === 'number' ? Number.isFinite(value) : String(value).trim() !== '';
  });
}

export function getVisibleMarketColumns(rows, columns) {
  return columns.filter((column) => {
    if (column.alwaysVisible || !column.field) return true;
    const fields = Array.isArray(column.field) ? column.field : [column.field];
    return fields.some((field) => hasRecordValue(rows, field));
  });
}

export function buildMarketSourceSummary(sources = []) {
  return [
    ['products', '全部缓存商品', '包含当前商品与归档商品缓存'],
    ['orders', '订单数据', '店铺订单与商品明细'],
    ['analytics', '流量快照', '平台官方日粒度流量'],
  ].map(([id, label, detail]) => {
    const source = sources.find((item) => item.id === id) || {};
    const value = Number(source.rowCount)
      ? `${Number(source.rowCount).toLocaleString('zh-CN')} ${id === 'analytics' ? '天' : '条'}`
      : '暂未同步';
    return { label, value, detail };
  });
}
