const DATASET_LABELS = Object.freeze({
  'market-products': '市场商品',
  'product-performance': '商品表现',
  products: '商品明细',
  categories: '类目机会',
  brands: '品牌机会',
  keywords: '关键词机会',
  'keyword-groups': '搜索类目目录',
  trends: '趋势数据',
  comparison: '竞品对比',
  'price-segments': '价格带分布',
  inventory: '库存数据',
  'missing-items': '缺货机会',
  'traffic-conversion': '流量转化',
  reports: '报表数据',
  'subscription-status': '订阅状态',
  'discovered-api': '已发现接口',
});

export const DATA_ANALYSIS_PUBLIC_MARKET_DATASETS = Object.freeze([
  'keywords',
  'missing-items',
  'price-segments',
  'market-products',
  'product-performance',
  'categories',
  'brands',
]);

export function marketCaptureText(value) {
  return String(value ?? '').trim();
}

export function marketCaptureNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;
  const match = marketCaptureText(value).replace(/,/gu, '').match(/-?\d+(?:\.\d+)?/u);
  const parsed = match ? Number(match[0]) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function marketDatasetTitle(id) {
  return DATASET_LABELS[id] || id;
}

export function uniqueMarketTextCount(records, field) {
  return new Set(records.map((record) => marketCaptureText(record[field])).filter(Boolean)).size;
}

export function countMarketNumbers(records, field) {
  return records.filter((record) => marketCaptureNumber(record[field]) !== null).length;
}

export function sumMarketNumbers(records, field) {
  const values = records.map((record) => marketCaptureNumber(record[field])).filter((value) => value !== null);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function sumMarketNumbersOrNull(records, field) {
  return sumMarketNumbers(records, field);
}

function metricCoverage(records, returnedRows, extra = {}) {
  const totalRows = records.length;
  const safeReturnedRows = Math.max(0, Math.min(Number(returnedRows) || 0, totalRows));
  return {
    totalRows,
    returnedRows: safeReturnedRows,
    missingRows: Math.max(0, totalRows - safeReturnedRows),
    percent: totalRows ? (safeReturnedRows / totalRows) * 100 : 0,
    ...extra,
  };
}

function coverageStatus(coverage = {}) {
  if (!coverage.totalRows || !coverage.returnedRows) return 'not_returned';
  return coverage.returnedRows < coverage.totalRows ? 'partial' : 'confirmed';
}

function sumMarketMetric(records, field, { label, unit = '', kind = '' } = {}) {
  const returnedRows = countMarketNumbers(records, field);
  const coverage = metricCoverage(records, returnedRows);
  return {
    label,
    value: sumMarketNumbersOrNull(records, field),
    unit,
    kind,
    status: coverageStatus(coverage),
    aggregation: 'sum-returned',
    coverage,
    detail: returnedRows === records.length
      ? `覆盖全部 ${records.length.toLocaleString('zh-CN')} 条真实记录`
      : `覆盖 ${returnedRows.toLocaleString('zh-CN')}/${records.length.toLocaleString('zh-CN')} 条真实记录`,
  };
}

function weightedAverageMarketMetric(records, valueField, weightField, { label, kind = '' } = {}) {
  const totalWeightRows = records.filter((record) => {
    const weight = marketCaptureNumber(record[weightField]);
    return weight !== null && weight > 0;
  });
  const weightedRows = totalWeightRows.filter((record) => marketCaptureNumber(record[valueField]) !== null);
  const totalWeight = totalWeightRows.reduce((total, record) => total + marketCaptureNumber(record[weightField]), 0);
  const coveredWeight = weightedRows.reduce((total, record) => total + marketCaptureNumber(record[weightField]), 0);
  const weightedTotal = weightedRows.reduce((total, record) => (
    total + marketCaptureNumber(record[valueField]) * marketCaptureNumber(record[weightField])
  ), 0);
  const coverage = metricCoverage(records, weightedRows.length, {
    totalWeight,
    coveredWeight,
    weightField,
  });
  const status = !totalWeight || !coveredWeight
    ? 'not_returned'
    : coveredWeight < totalWeight
      ? 'partial'
      : 'confirmed';
  return {
    label,
    value: coveredWeight ? weightedTotal / coveredWeight : null,
    unit: '',
    kind,
    status,
    aggregation: 'weighted-average',
    coverage,
    detail: coveredWeight
      ? `按 ${coveredWeight.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 件已返回销量加权`
      : '没有可用于加权的销量与价格',
  };
}

export function isProductPerformanceZeroAmountConflict(record = {}) {
  const amount = marketCaptureNumber(record.orderAmount);
  const orderedProducts = marketCaptureNumber(record.orderedProducts);
  const averagePurchasePrice = marketCaptureNumber(record.averagePurchasePrice);
  return amount === 0 && orderedProducts !== null && orderedProducts > 0
    && averagePurchasePrice !== null && averagePurchasePrice > 0;
}

export function buildMarketDatasetMetrics(id, records) {
  if (id === 'keywords') {
    return [
      { label: '搜索词', value: records.length, unit: '个' },
      sumMarketMetric(records, 'searches', { label: '搜索量', unit: '次' }),
      sumMarketMetric(records, 'orders', { label: '下单量', unit: '单' }),
      sumMarketMetric(records, 'revenue', { label: '搜索 GMV', kind: 'money' }),
    ];
  }
  if (id === 'missing-items') {
    return [
      { label: '机会商品', value: records.length, unit: '个' },
      sumMarketMetric(records, 'sales', { label: '市场销量', unit: '件' }),
      weightedAverageMarketMetric(records, 'averagePrice', 'sales', { label: '销量加权均价', kind: 'money' }),
      sumMarketMetric(records, 'revenue', { label: '市场 GMV', kind: 'money' }),
    ];
  }
  if (id === 'trends') {
    const dated = records
      .filter((record) => record.date)
      .sort((left, right) => String(left.date).localeCompare(String(right.date)));
    return [
      { label: '趋势日期', value: uniqueMarketTextCount(records, 'date'), unit: '天' },
      { label: '有成交日期', value: records.filter((record) => (marketCaptureNumber(record.revenue) || 0) > 0).length, unit: '天' },
      sumMarketMetric(records, 'revenue', { label: '周期 GMV', kind: 'money' }),
      { label: '最近日 GMV', value: marketCaptureNumber(dated.at(-1)?.revenue), unit: '', kind: 'money' },
    ];
  }
  if (id === 'price-segments') {
    const fromValues = records.map((record) => marketCaptureNumber(record.priceFrom)).filter((value) => value !== null);
    const toValues = records.map((record) => marketCaptureNumber(record.priceTo)).filter((value) => value !== null);
    return [
      { label: '价格带', value: records.length, unit: '档' },
      { label: '最低起价', value: fromValues.length ? Math.min(...fromValues) : null, unit: '', kind: 'money' },
      { label: '最高止价', value: toValues.length ? Math.max(...toValues) : null, unit: '', kind: 'money' },
      { label: '数据来源', value: 1, unit: '个 Ozon 价格接口' },
    ];
  }
  if (id === 'market-products' || id === 'products') {
    return [
      { label: '市场商品', value: records.length, unit: '个' },
      { label: '品牌', value: uniqueMarketTextCount(records, 'brand'), unit: '个' },
      { label: '卖家', value: uniqueMarketTextCount(records, 'seller'), unit: '个' },
      sumMarketMetric(records, 'revenue', { label: '返回 GMV', kind: 'money' }),
    ];
  }
  if (id === 'product-performance') {
    const orderAmountMetric = sumMarketMetric(records, 'orderAmount', { label: '订购金额', kind: 'money' });
    const zeroAmountConflicts = records.filter(isProductPerformanceZeroAmountConflict).length;
    if (zeroAmountConflicts) {
      orderAmountMetric.status = 'partial';
      orderAmountMetric.sourceConflictRows = zeroAmountConflicts;
      orderAmountMetric.detail = `${zeroAmountConflicts.toLocaleString('zh-CN')} 条记录由 Ozon 返回零金额，保留原值且未自行推算`;
    }
    return [
      { label: '商品', value: records.length, unit: '个' },
      sumMarketMetric(records, 'orderedProducts', { label: '已订购商品', unit: '件' }),
      orderAmountMetric,
      weightedAverageMarketMetric(records, 'averagePurchasePrice', 'orderedProducts', {
        label: '成交加权均价',
        kind: 'money',
      }),
    ];
  }
  return [
    { label: '有效记录', value: records.length, unit: '条' },
    { label: '类目', value: uniqueMarketTextCount(records, 'category'), unit: '个' },
    { label: '品牌', value: uniqueMarketTextCount(records, 'brand'), unit: '个' },
    sumMarketMetric(records, 'revenue', { label: '返回 GMV', kind: 'money' }),
  ];
}

export function buildMarketSectionMetrics(id, records, {
  recordCount = Array.isArray(records) ? records.length : 0,
  datasetCount = 0,
} = {}) {
  const safeRecords = Array.isArray(records) ? records : [];
  if (id === 'competitor') {
    return [
      { label: '竞品/市场记录', value: recordCount, unit: '条' },
      { label: '类目', value: uniqueMarketTextCount(safeRecords, 'category'), unit: '个' },
      { label: '品牌', value: uniqueMarketTextCount(safeRecords, 'brand'), unit: '个' },
      {
        label: '含销量/GMV',
        value: Math.max(countMarketNumbers(safeRecords, 'sales'), countMarketNumbers(safeRecords, 'revenue')),
        unit: '条',
      },
    ];
  }
  if (id === 'search') {
    return [
      { label: '搜索词/趋势记录', value: recordCount, unit: '条' },
      { label: '含曝光/浏览', value: countMarketNumbers(safeRecords, 'views'), unit: '条' },
      { label: '含转化', value: countMarketNumbers(safeRecords, 'conversion'), unit: '条' },
      { label: '趋势数据集', value: datasetCount, unit: '组' },
    ];
  }
  const missingItems = safeRecords.filter((record) => record.dataset === 'missing-items').length;
  const zeroStock = safeRecords.filter((record) => marketCaptureNumber(record.stock) === 0).length;
  return [
    { label: '机会记录', value: recordCount, unit: '条' },
    { label: '缺货机会', value: missingItems, unit: '条' },
    { label: '零库存记录', value: zeroStock, unit: '条' },
    sumMarketMetric(safeRecords, 'revenue', { label: '返回 GMV', kind: 'money' }),
  ];
}
