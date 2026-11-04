import { normalizeMarketRecord } from './dataAnalysisMarketRecordMapper.js';

export function marketCacheText(value) {
  return String(value ?? '').trim();
}

export function marketCacheCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function marketCacheFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function compactMarketCacheMetric(metric = {}) {
  const compacted = {
    label: marketCacheText(metric.label),
    value: metric.value ?? null,
    unit: marketCacheText(metric.unit),
    kind: marketCacheText(metric.kind),
  };
  const status = marketCacheText(metric.status);
  const aggregation = marketCacheText(metric.aggregation);
  const detail = marketCacheText(metric.detail);
  if (status) compacted.status = status;
  if (aggregation) compacted.aggregation = aggregation;
  if (detail) compacted.detail = detail;
  if (marketCacheCount(metric.sourceConflictRows)) {
    compacted.sourceConflictRows = marketCacheCount(metric.sourceConflictRows);
  }
  if (metric.coverage && typeof metric.coverage === 'object') {
    const coverage = {
      totalRows: marketCacheCount(metric.coverage.totalRows),
      returnedRows: marketCacheCount(metric.coverage.returnedRows),
      missingRows: marketCacheCount(metric.coverage.missingRows),
    };
    for (const field of ['percent', 'totalWeight', 'coveredWeight']) {
      const value = marketCacheFiniteNumber(metric.coverage[field]);
      if (value !== null) coverage[field] = value;
    }
    const weightField = marketCacheText(metric.coverage.weightField);
    if (weightField) coverage.weightField = weightField;
    compacted.coverage = coverage;
  }
  return compacted;
}

export function marketSectionHasRecords(section = {}) {
  return marketCacheCount(section.recordCount) > 0
    || Array.isArray(section.records) && section.records.length > 0;
}

export function compactMarketCacheRecord(record = {}, fallbackDataset = '') {
  return normalizeMarketRecord(
    record,
    marketCacheText(record.dataset || fallbackDataset),
    marketCacheCount(record.sequence),
    marketCacheText(record.capturedAt),
  );
}

export function marketRowCount(data = {}) {
  const sectionCount = Object.values(data.sections || {}).reduce(
    (total, section) => total + marketCacheCount(section?.recordCount),
    0,
  );
  const datasetCount = Array.isArray(data.datasetViews)
    ? data.datasetViews.reduce(
      (total, dataset) => total + marketCacheCount(dataset?.recordCount),
      0,
    )
    : 0;
  return Math.max(sectionCount, datasetCount);
}
