import {
  buildMarketDatasetMetrics,
  buildMarketSectionMetrics,
  DATA_ANALYSIS_PUBLIC_MARKET_DATASETS,
} from './dataAnalysisMarketMetrics.js';
import {
  compactMarketCacheRecord,
  marketCacheCount,
  marketCacheText,
  marketRowCount,
  marketSectionHasRecords,
} from './dataAnalysisMarketCacheValue.js';

const MAX_SECTION_RECORDS = 20_000;
const PUBLIC_MARKET_DATASETS = new Set(DATA_ANALYSIS_PUBLIC_MARKET_DATASETS);

function stableKeyPart(value) {
  return marketCacheText(value).toLocaleLowerCase().replace(/\s+/gu, ' ');
}

function stableMarketRecordKey(record = {}, fallbackDataset = '') {
  const dataset = stableKeyPart(record.dataset || fallbackDataset) || 'unknown';
  const title = stableKeyPart(record.title);
  if (dataset === 'keywords' || dataset === 'keyword-groups') {
    if (title) return `${dataset}|query:${title}`;
  }
  if (dataset === 'trends') {
    const date = stableKeyPart(record.date);
    if (date) return `${dataset}|date:${date}`;
  }
  if (dataset === 'price-segments') {
    const from = marketCacheText(record.priceFrom);
    const to = marketCacheText(record.priceTo);
    if (from || to) return `${dataset}|range:${from}:${to}`;
  }
  if (dataset === 'brands') {
    const brand = stableKeyPart(record.brand) || title;
    if (brand) return `${dataset}|brand:${brand}`;
  }
  if (dataset === 'categories') {
    const categoryPath = [record.category1, record.category2, record.category3, record.category, record.title]
      .map(stableKeyPart)
      .filter(Boolean)
      .join('>');
    if (categoryPath) return `${dataset}|category:${categoryPath}`;
  }
  const id = stableKeyPart(record.id);
  if (id) return `${dataset}|id:${id}`;
  const article = stableKeyPart(record.article);
  if (article) return `${dataset}|article:${article}`;
  const link = stableKeyPart(record.link);
  if (link) return `${dataset}|link:${link}`;
  return title ? `${dataset}|title:${title}` : '';
}

function mergePreferredRecord(preferred = {}, fallback = {}) {
  // A partial live row is authoritative for every value it returned, while
  // the complete cache only fills fields that were absent from that row.
  return compactMarketCacheRecord({ ...fallback, ...preferred }, preferred.dataset || fallback.dataset);
}

function mergeMarketRecords(liveRecords = [], cachedRecords = [], fallbackDataset = '') {
  const records = [];
  const positions = new Map();
  for (const sourceRecord of liveRecords) {
    const record = compactMarketCacheRecord(sourceRecord, fallbackDataset);
    const key = stableMarketRecordKey(record, fallbackDataset);
    if (!key) continue;
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, records.length);
      records.push(record);
      continue;
    }
    records[position] = mergePreferredRecord(record, records[position]);
  }
  for (const sourceRecord of cachedRecords) {
    const record = compactMarketCacheRecord(sourceRecord, fallbackDataset);
    const key = stableMarketRecordKey(record, fallbackDataset);
    if (!key) continue;
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, records.length);
      records.push(record);
      continue;
    }
    records[position] = mergePreferredRecord(records[position], record);
  }
  return records.slice(0, MAX_SECTION_RECORDS);
}

function mergeMarketSection(liveSection = {}, cachedSection = {}, id = '') {
  const records = mergeMarketRecords(
    Array.isArray(liveSection.records) ? liveSection.records : [],
    Array.isArray(cachedSection.records) ? cachedSection.records : [],
  );
  const datasets = [...new Set([
    ...(Array.isArray(liveSection.datasets) ? liveSection.datasets : []),
    ...(Array.isArray(cachedSection.datasets) ? cachedSection.datasets : []),
  ].map(marketCacheText).filter(Boolean))];
  const datasetCount = Math.max(
    datasets.length,
    marketCacheCount(liveSection.datasetCount),
    marketCacheCount(cachedSection.datasetCount),
  );
  return {
    ...cachedSection,
    ...liveSection,
    id: marketCacheText(liveSection.id || cachedSection.id || id),
    status: records.length ? 'ready' : marketCacheText(liveSection.status || cachedSection.status || 'empty'),
    statusLabel: records.length ? '已接入' : marketCacheText(liveSection.statusLabel || cachedSection.statusLabel || '暂无数据'),
    datasetCount,
    recordCount: records.length,
    datasets,
    newestCapturedAt: [marketCacheText(liveSection.newestCapturedAt), marketCacheText(cachedSection.newestCapturedAt)]
      .filter(Boolean)
      .sort()
      .at(-1) || '',
    metrics: buildMarketSectionMetrics(id, records, { recordCount: records.length, datasetCount }),
    records,
  };
}

function mergeMarketDatasetView(liveDataset = {}, cachedDataset = {}, id = '') {
  const sourceDataset = marketCacheText(liveDataset.dataset || cachedDataset.dataset || id);
  const records = mergeMarketRecords(
    Array.isArray(liveDataset.records) ? liveDataset.records : [],
    Array.isArray(cachedDataset.records) ? cachedDataset.records : [],
    sourceDataset,
  );
  const dataset = marketCacheText(records[0]?.dataset || sourceDataset);
  return {
    ...cachedDataset,
    ...liveDataset,
    id: dataset,
    dataset,
    dataScope: marketCacheText(liveDataset.dataScope || cachedDataset.dataScope)
      || (PUBLIC_MARKET_DATASETS.has(dataset) ? 'market' : 'profile'),
    title: marketCacheText(liveDataset.title || cachedDataset.title || dataset),
    status: records.length ? 'ready' : 'empty',
    statusLabel: records.length ? '已接入' : '已移除',
    datasetCount: Math.max(
      marketCacheCount(liveDataset.datasetCount),
      marketCacheCount(cachedDataset.datasetCount),
    ),
    recordCount: records.length,
    newestCapturedAt: [marketCacheText(liveDataset.newestCapturedAt), marketCacheText(cachedDataset.newestCapturedAt)]
      .filter(Boolean)
      .sort()
      .at(-1) || '',
    endpoints: [...new Set([
      ...(Array.isArray(liveDataset.endpoints) ? liveDataset.endpoints : []),
      ...(Array.isArray(cachedDataset.endpoints) ? cachedDataset.endpoints : []),
    ].map(marketCacheText).filter(Boolean))].slice(0, 30),
    metrics: buildMarketDatasetMetrics(dataset, records),
    records,
  };
}

export function mergeLiveMarketDataWithCache(liveData = {}, cachedData = null, {
  replaceUnavailable = false,
  replaceLiveDatasets = false,
  preserveLiveDatasetIds = [],
} = {}) {
  if (replaceUnavailable) {
    return { data: liveData, fallbackSections: [], skipPersist: false };
  }
  if (!cachedData?.sections) {
    return { data: liveData, fallbackSections: [], skipPersist: false };
  }
  const liveRowCount = marketRowCount(liveData);
  const cachedRowCount = marketRowCount(cachedData);
  if (liveRowCount === 0 && cachedRowCount > 0) {
    return {
      data: {
        ...cachedData,
        statusLabel: '当前未捕获新数据，已保留上次热缓存',
        cacheState: 'cached',
        isCached: true,
        liveRefreshStatus: 'empty',
      },
      fallbackSections: Object.keys(cachedData.sections),
      skipPersist: true,
    };
  }

  const sectionIds = new Set([
    ...Object.keys(cachedData.sections || {}),
    ...Object.keys(liveData.sections || {}),
  ]);
  const fallbackSections = [];
  const sections = {};
  for (const id of sectionIds) {
    const liveSection = liveData.sections?.[id];
    const cachedSection = cachedData.sections?.[id];
    if (marketSectionHasRecords(liveSection) && marketSectionHasRecords(cachedSection)) {
      sections[id] = mergeMarketSection(liveSection, cachedSection, id);
    } else if (!marketSectionHasRecords(liveSection) && marketSectionHasRecords(cachedSection)) {
      sections[id] = cachedSection;
      fallbackSections.push(id);
    } else {
      sections[id] = liveSection || cachedSection;
    }
  }
  const liveDatasets = new Map((liveData.datasetViews || []).map(
    (dataset) => [marketCacheText(dataset.id || dataset.dataset), dataset],
  ));
  const cachedDatasets = new Map((cachedData.datasetViews || []).map(
    (dataset) => [marketCacheText(dataset.id || dataset.dataset), dataset],
  ));
  const preservedDatasets = new Set(
    (Array.isArray(preserveLiveDatasetIds) ? preserveLiveDatasetIds : [])
      .map(marketCacheText)
      .filter(Boolean),
  );
  const datasetViews = [];
  for (const id of new Set([...liveDatasets.keys(), ...cachedDatasets.keys()])) {
    const liveDataset = liveDatasets.get(id);
    const cachedDataset = cachedDatasets.get(id);
    if (liveDataset?.records?.length && cachedDataset?.records?.length) {
      datasetViews.push(mergeMarketDatasetView(
        liveDataset,
        replaceLiveDatasets && !preservedDatasets.has(id) ? {} : cachedDataset,
        id,
      ));
    } else if (!liveDataset?.records?.length && cachedDataset?.records?.length) {
      datasetViews.push(cachedDataset);
      fallbackSections.push(`dataset:${id}`);
    } else if (liveDataset?.records?.length) {
      datasetViews.push(liveDataset);
    }
  }
  const readyCount = Object.values(sections).filter((section) => marketSectionHasRecords(section)).length;
  return {
    data: {
      ...liveData,
      sections,
      datasetViews,
      status: readyCount >= 3 ? 'ready' : readyCount ? 'partial' : liveData.status,
      statusLabel: fallbackSections.length
        ? `最新数据已刷新，${fallbackSections.length} 类沿用热缓存`
        : liveData.statusLabel,
      cacheState: fallbackSections.length ? 'mixed' : 'live',
      isCached: fallbackSections.length > 0,
      cacheFallbackSections: fallbackSections,
    },
    fallbackSections,
    skipPersist: false,
  };
}

