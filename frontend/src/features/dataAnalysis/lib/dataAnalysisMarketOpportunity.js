function text(value) {
  return String(value ?? '').trim();
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sumFiniteOrNull(records, field) {
  const values = records.map((record) => finiteNumber(record?.[field])).filter((value) => value !== null);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function weightedAverageFinite(records, valueField, weightField) {
  let weightedTotal = 0;
  let totalWeight = 0;
  for (const record of records) {
    const value = finiteNumber(record?.[valueField]);
    const weight = finiteNumber(record?.[weightField]);
    if (value === null || weight === null || weight <= 0) continue;
    weightedTotal += value * weight;
    totalWeight += weight;
  }
  return totalWeight ? weightedTotal / totalWeight : null;
}

function buildDerivedOpportunityDataset(source, { id, field, title }) {
  const sourceRecords = Array.isArray(source?.records) ? source.records : [];
  const grouped = new Map();
  for (const record of sourceRecords) {
    const groupName = text(record?.[field]);
    if (!groupName) continue;
    const records = grouped.get(groupName) || [];
    records.push(record);
    grouped.set(groupName, records);
  }
  const records = [...grouped.entries()].map(([groupName, groupRecords]) => ({
    dataset: id,
    title: groupName,
    [field]: groupName,
    sourceRecordCount: groupRecords.length,
    sales: sumFiniteOrNull(groupRecords, 'sales'),
    averagePrice: weightedAverageFinite(groupRecords, 'averagePrice', 'sales'),
    revenue: sumFiniteOrNull(groupRecords, 'revenue'),
    growth: weightedAverageFinite(groupRecords, 'growth', 'revenue'),
  })).sort((left, right) => (
    (finiteNumber(right.revenue) || 0) - (finiteNumber(left.revenue) || 0)
    || right.sourceRecordCount - left.sourceRecordCount
    || left.title.localeCompare(right.title)
  ));
  if (!records.length) return null;
  return {
    id,
    dataset: id,
    dataScope: 'market',
    title,
    status: 'ready',
    statusLabel: '由真实机会记录汇总',
    derivedFrom: source.dataset || source.id || 'missing-items',
    datasetCount: 1,
    recordCount: records.length,
    newestCapturedAt: source.newestCapturedAt || '',
    endpoints: Array.isArray(source.endpoints) ? source.endpoints : [],
    metrics: [
      { label: title, value: records.length, unit: '个' },
      { label: '机会商品', value: sourceRecords.length, unit: '个' },
      { label: '市场销量', value: sumFiniteOrNull(sourceRecords, 'sales'), unit: '件' },
      { label: '市场 GMV', value: sumFiniteOrNull(sourceRecords, 'revenue'), unit: '', kind: 'money' },
    ],
    records,
  };
}

export function augmentMarketOpportunityDatasetViews(datasets = []) {
  const available = datasets.filter((dataset) => Number(dataset?.recordCount || dataset?.records?.length || 0) > 0);
  const ids = new Set(available.map((dataset) => text(dataset?.dataset || dataset?.id)).filter(Boolean));
  const missingItems = available.find((dataset) => text(dataset?.dataset || dataset?.id) === 'missing-items');
  if (!missingItems) return available;
  const derived = [];
  if (!ids.has('categories')) {
    const categories = buildDerivedOpportunityDataset(missingItems, {
      id: 'categories',
      field: 'category',
      title: '类目机会',
    });
    if (categories) derived.push(categories);
  }
  if (!ids.has('brands')) {
    const brands = buildDerivedOpportunityDataset(missingItems, {
      id: 'brands',
      field: 'brand',
      title: '品牌机会',
    });
    if (brands) derived.push(brands);
  }
  return [...available, ...derived];
}
