import {
  buildMarketDatasetMetrics,
  DATA_ANALYSIS_PUBLIC_MARKET_DATASETS,
} from './dataAnalysisMarketMetrics.js';
import {
  compactMarketCacheMetric,
  compactMarketCacheRecord,
  marketCacheCount,
  marketCacheText,
  marketSectionHasRecords,
} from './dataAnalysisMarketCacheValue.js';

const MAX_SECTION_RECORDS = 20_000;
const NON_MARKET_DATASETS = new Set(['subscription-status']);
const PUBLIC_MARKET_DATASETS = new Set(DATA_ANALYSIS_PUBLIC_MARKET_DATASETS);

export function compactMarketData(data = {}) {
  const sections = Object.fromEntries(Object.entries(data.sections || {})
    .filter(([, section]) => marketSectionHasRecords(section))
    .map(([id, section = {}]) => [id, {
    id: marketCacheText(section.id || id),
    title: marketCacheText(section.title),
    status: marketCacheText(section.status),
    statusLabel: marketCacheText(section.statusLabel),
    datasetCount: marketCacheCount(section.datasetCount),
    recordCount: marketCacheCount(section.recordCount),
    datasets: Array.isArray(section.datasets) ? section.datasets.map(marketCacheText).filter(Boolean).slice(0, 30) : [],
    newestCapturedAt: marketCacheText(section.newestCapturedAt),
    metrics: Array.isArray(section.metrics)
      ? section.metrics.slice(0, 12).map((metric = {}) => compactMarketCacheMetric(metric))
      : [],
    records: Array.isArray(section.records)
      ? section.records.slice(0, MAX_SECTION_RECORDS).map((record = {}) => compactMarketCacheRecord(record))
      : [],
    }]));
  const datasetViews = Array.isArray(data.datasetViews)
    ? data.datasetViews
      .filter((dataset) => (
        !NON_MARKET_DATASETS.has(marketCacheText(dataset?.dataset || dataset?.id))
        && marketCacheCount(dataset?.recordCount) > 0
        && Array.isArray(dataset?.records)
      ))
      .map((dataset) => {
        const sourceDataset = marketCacheText(dataset.dataset || dataset.id);
        const records = dataset.records.slice(0, MAX_SECTION_RECORDS).map((record = {}) => compactMarketCacheRecord(record, sourceDataset));
        const resolvedDataset = marketCacheText(records[0]?.dataset || sourceDataset);
        return {
          id: resolvedDataset,
          dataset: resolvedDataset,
          dataScope: marketCacheText(dataset.dataScope) || (PUBLIC_MARKET_DATASETS.has(resolvedDataset) ? 'market' : 'profile'),
          title: marketCacheText(dataset.title || resolvedDataset),
          status: 'ready',
          statusLabel: '已接入',
          datasetCount: marketCacheCount(dataset.datasetCount),
          recordCount: records.length,
          newestCapturedAt: marketCacheText(dataset.newestCapturedAt),
          endpoints: Array.isArray(dataset.endpoints) ? dataset.endpoints.map(marketCacheText).filter(Boolean).slice(0, 30) : [],
          metrics: buildMarketDatasetMetrics(resolvedDataset, records),
          records,
        };
      })
    : [];
  const pagination = data.pagination && Number(data.pagination.pagesFetched) > 0 ? {
    sourceCount: marketCacheCount(data.pagination.sourceCount),
    pagesFetched: marketCacheCount(data.pagination.pagesFetched),
    recordsFetched: marketCacheCount(data.pagination.recordsFetched),
    sources: Array.isArray(data.pagination.sources) ? data.pagination.sources.slice(0, 30).map((source = {}) => ({
      dataset: marketCacheText(source.dataset),
      sourceSequence: marketCacheCount(source.sourceSequence),
      pagesFetched: marketCacheCount(source.pagesFetched),
      recordsFetched: marketCacheCount(source.recordsFetched),
      totalRecordCount: marketCacheCount(source.totalRecordCount),
      stopReason: marketCacheText(source.stopReason),
    })) : [],
  } : null;
  return {
    status: marketCacheText(data.status) || 'empty',
    statusLabel: marketCacheText(data.statusLabel) || '暂无市场数据',
    updatedAt: marketCacheText(data.updatedAt),
    lastAttemptAt: marketCacheText(data.lastAttemptAt),
    lastCaptureAt: marketCacheText(data.lastCaptureAt || data.updatedAt),
    lastCompletedAt: marketCacheText(data.lastCompletedAt),
    refreshOutcome: marketCacheText(data.refreshOutcome),
    refreshOutcomeLabel: marketCacheText(data.refreshOutcomeLabel),
    refreshTrigger: marketCacheText(data.refreshTrigger),
    refreshInProgress: data.refreshInProgress === true,
    captureMode: marketCacheText(data.captureMode),
    observerVersion: marketCacheText(data.observerVersion),
    endpointCount: marketCacheCount(data.endpointCount),
    datasetCount: marketCacheCount(data.datasetCount),
    confirmedDatasetCount: marketCacheCount(data.confirmedDatasetCount),
    tabId: marketCacheText(data.tabId),
    profileId: marketCacheText(data.profileId),
    legacyGlobalMigration: data.legacyGlobalMigration && typeof data.legacyGlobalMigration === 'object' ? {
      sourceKey: marketCacheText(data.legacyGlobalMigration.sourceKey),
      sourceRowCount: marketCacheCount(data.legacyGlobalMigration.sourceRowCount),
      sourceUpdatedAt: marketCacheText(data.legacyGlobalMigration.sourceUpdatedAt),
    } : null,
    subscriptionStatus: data.subscriptionStatus?.recordCount ? {
      recordCount: marketCacheCount(data.subscriptionStatus.recordCount),
      newestCapturedAt: marketCacheText(data.subscriptionStatus.newestCapturedAt),
    } : null,
    captureIntegrity: data.captureIntegrity && typeof data.captureIntegrity === 'object' ? {
      schemaVersion: marketCacheCount(data.captureIntegrity.schemaVersion) || 1,
      refreshRunId: marketCacheText(data.captureIntegrity.refreshRunId),
      captureMode: marketCacheText(data.captureIntegrity.captureMode),
      complete: data.captureIntegrity.complete === true,
      completedAt: marketCacheText(data.captureIntegrity.completedAt),
      datasets: Object.fromEntries(Object.entries(data.captureIntegrity.datasets || {})
        .map(([id, count]) => [marketCacheText(id), marketCacheCount(count)])
        .filter(([id]) => Boolean(id))),
      failedRoutes: Array.isArray(data.captureIntegrity.failedRoutes)
        ? data.captureIntegrity.failedRoutes.map(marketCacheText).filter(Boolean).slice(0, 30)
        : [],
    } : null,
    routeResults: Array.isArray(data.routeResults) ? data.routeResults.slice(0, 30).map((route = {}) => ({
      routeId: marketCacheText(route.routeId),
      status: marketCacheText(route.status),
      source: marketCacheText(route.source),
      datasets: Array.isArray(route.datasets) ? route.datasets.map(marketCacheText).filter(Boolean).slice(0, 20) : [],
      recordCount: marketCacheCount(route.recordCount),
      pagesFetched: marketCacheCount(route.pagesFetched),
      stopReasons: Array.isArray(route.stopReasons) ? route.stopReasons.map(marketCacheText).filter(Boolean).slice(0, 20) : [],
      errorCode: marketCacheText(route.errorCode),
    })) : [],
    pagination,
    datasetViews,
    sections,
  };
}
