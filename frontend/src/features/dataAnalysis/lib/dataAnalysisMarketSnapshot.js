import {
  isMeaningfulMarketRecord,
  marketRecordKey,
  mergeMarketRecords,
  normalizeMarketRecord,
  resolveMarketDatasetId,
} from './dataAnalysisMarketRecordMapper.js';
import {
  buildMarketDatasetMetrics,
  buildMarketSectionMetrics,
  DATA_ANALYSIS_PUBLIC_MARKET_DATASETS,
  marketCaptureText,
  marketDatasetTitle,
} from './dataAnalysisMarketMetrics.js';

export const MARKET_SECTION_PROFILES = Object.freeze({
  competitor: {
    title: '竞品表现',
    datasets: ['product-performance', 'market-products', 'products', 'categories', 'brands', 'comparison', 'discovered-api'],
  },
  search: {
    title: '搜索趋势',
    datasets: ['keywords', 'traffic-conversion', 'trends'],
  },
  opportunity: {
    title: '市场机会',
    datasets: ['missing-items', 'categories', 'market-products', 'comparison', 'discovered-api'],
  },
});

const MAX_SECTION_RECORDS = 20_000;
const NON_MARKET_DATASETS = new Set(['subscription-status']);
const PUBLIC_MARKET_DATASETS = new Set(DATA_ANALYSIS_PUBLIC_MARKET_DATASETS);

function compactRecord(record = {}, dataset = '', sequence = 0, capturedAt = '', endpoint = '') {
  return normalizeMarketRecord(record, dataset, sequence, capturedAt, endpoint);
}

function recordKey(record = {}) {
  return marketRecordKey(record);
}
function collectSection(profile, datasets) {
  const accepted = new Set(profile.datasets);
  const selectedDatasets = datasets
    .filter((dataset) => accepted.has(marketCaptureText(dataset?.dataset)))
    .filter((dataset) => marketCaptureText(dataset?.quality) === 'confirmed-data')
    .filter((dataset) => Array.isArray(dataset?.records) && dataset.records.length > 0)
    .sort((left, right) => (Number(right?.sequence) || 0) - (Number(left?.sequence) || 0));
  const records = [];
  const positions = new Map();
  for (const dataset of selectedDatasets) {
    for (const sourceRecord of Array.isArray(dataset?.records) ? dataset.records : []) {
      const record = compactRecord(
        sourceRecord,
        dataset.dataset,
        dataset.sequence,
        dataset.capturedAt,
        dataset.endpoint,
      );
      if (!isMeaningfulMarketRecord(record)) continue;
      const key = recordKey(record);
      const position = positions.get(key);
      if (position === undefined) {
        positions.set(key, records.length);
        records.push(record);
      } else {
        records[position] = mergeMarketRecords(records[position], record);
      }
    }
  }
  return {
    id: Object.entries(MARKET_SECTION_PROFILES).find(([, item]) => item === profile)?.[0] || '',
    title: profile.title,
    status: records.length ? 'ready' : 'empty',
    statusLabel: records.length ? '已接入' : '暂无数据',
    datasetCount: selectedDatasets.length,
    recordCount: records.length,
    datasets: [...new Set(selectedDatasets.map((dataset) => marketCaptureText(dataset.dataset)).filter(Boolean))],
    newestCapturedAt: selectedDatasets
      .map((dataset) => marketCaptureText(dataset.capturedAt))
      .filter(Boolean)
      .sort()
      .at(-1) || '',
    metricRecords: records,
    records: records.slice(0, MAX_SECTION_RECORDS),
  };
}

function collectDatasetViews(datasets = []) {
  const grouped = new Map();
  for (const dataset of datasets) {
    const sourceId = marketCaptureText(dataset?.dataset);
    const id = resolveMarketDatasetId(sourceId, dataset?.endpoint, dataset?.records?.[0]);
    if (!id || NON_MARKET_DATASETS.has(sourceId) || marketCaptureText(dataset?.quality) !== 'confirmed-data') continue;
    const sourceRecords = Array.isArray(dataset?.records) ? dataset.records : [];
    if (!sourceRecords.length) continue;
    const current = grouped.get(id) || {
      id,
      dataset: id,
      title: marketDatasetTitle(id),
      datasetCount: 0,
      recordCount: 0,
      records: [],
      positions: new Map(),
      capturedAt: [],
      endpoints: new Set(),
    };
    current.datasetCount += 1;
    current.capturedAt.push(marketCaptureText(dataset?.capturedAt));
    if (marketCaptureText(dataset?.endpoint)) current.endpoints.add(marketCaptureText(dataset.endpoint));
    for (const sourceRecord of sourceRecords) {
      const record = compactRecord(sourceRecord, sourceId, dataset.sequence, dataset.capturedAt, dataset.endpoint);
      record.dataset = id;
      if (!isMeaningfulMarketRecord(record)) continue;
      const key = recordKey(record);
      const position = current.positions.get(key);
      if (position === undefined) {
        current.positions.set(key, current.records.length);
        current.records.push(record);
      } else {
        current.records[position] = mergeMarketRecords(current.records[position], record);
      }
    }
    grouped.set(id, current);
  }
  return [...grouped.values()]
    .map((item) => {
      const records = item.records;
      return {
        id: item.id,
        dataset: item.dataset,
        dataScope: PUBLIC_MARKET_DATASETS.has(item.dataset) ? 'market' : 'profile',
        title: item.title,
        status: records.length ? 'ready' : 'empty',
        statusLabel: records.length ? '已接入' : '已移除',
        datasetCount: item.datasetCount,
        recordCount: records.length,
        records: records.slice(0, MAX_SECTION_RECORDS),
        newestCapturedAt: item.capturedAt.filter(Boolean).sort().at(-1) || '',
        endpoints: [...item.endpoints].slice(0, 30),
        metrics: buildMarketDatasetMetrics(item.id, records),
      };
    })
    .filter((item) => item.recordCount > 0)
    .sort((left, right) => (right.recordCount - left.recordCount) || left.title.localeCompare(right.title));
}


function attachSectionMetrics(section) {
  const records = section.metricRecords || section.records;
  const publicSection = { ...section };
  delete publicSection.metricRecords;
  return {
    ...publicSection,
    metrics: buildMarketSectionMetrics(section.id, records, section),
  };
}

export function normalizeDataAnalysisMarketBrowserSnapshot(snapshot = {}) {
  const datasets = Array.isArray(snapshot.datasets) ? snapshot.datasets : [];
  const datasetViews = collectDatasetViews(datasets);
  const subscriptionDatasets = datasets.filter((dataset) => (
    marketCaptureText(dataset?.dataset) === 'subscription-status'
      && marketCaptureText(dataset?.quality) === 'confirmed-data'
      && Array.isArray(dataset?.records)
      && dataset.records.length > 0
  ));
  const subscriptionStatus = subscriptionDatasets.length ? {
    recordCount: subscriptionDatasets.reduce((total, dataset) => total + dataset.records.length, 0),
    newestCapturedAt: subscriptionDatasets.map((dataset) => marketCaptureText(dataset.capturedAt)).filter(Boolean).sort().at(-1) || '',
  } : null;
  const allSections = Object.fromEntries(
    Object.entries(MARKET_SECTION_PROFILES).map(([id, profile]) => {
      const section = collectSection(profile, datasets);
      return [id, attachSectionMetrics({ ...section, id })];
    }),
  );
  const sections = Object.fromEntries(
    Object.entries(allSections).filter(([, section]) => section.status === 'ready' && section.recordCount > 0),
  );
  const confirmedDatasetCount = datasetViews.length;
  return {
    status: confirmedDatasetCount ? 'ready' : 'empty',
    statusLabel: confirmedDatasetCount
      ? `已接入 ${confirmedDatasetCount} 个真实数据集`
      : '暂无市场数据',
    updatedAt: snapshot.capturedAt || '',
    observerVersion: marketCaptureText(snapshot.observerVersion),
    endpointCount: Math.max(0, Number(snapshot.catalog?.endpointCount) || 0),
    datasetCount: datasetViews.length,
    confirmedDatasetCount,
    tabId: marketCaptureText(snapshot.tabId),
    profileId: marketCaptureText(snapshot.profileId || snapshot.tab?.accountId),
    subscriptionStatus,
    datasetViews,
    sections,
  };
}
