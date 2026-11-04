import {
  isMeaningfulMarketRecord,
  marketRecordKey,
  mergeMarketRecords,
  normalizeMarketRecord,
  resolveMarketDatasetId,
} from './dataAnalysisMarketRecordMapper.js';
import { marketCaptureText } from './dataAnalysisMarketMetrics.js';
import { normalizeDataAnalysisMarketBrowserSnapshot } from './dataAnalysisMarketSnapshot.js';

function compactRecord(record = {}, dataset = '', sequence = 0, capturedAt = '', endpoint = '') {
  return normalizeMarketRecord(record, dataset, sequence, capturedAt, endpoint);
}

function recordKey(record = {}) {
  return marketRecordKey(record);
}
export function createDataAnalysisMarketCaptureAccumulator() {
  const grouped = new Map();
  let latestSnapshot = null;
  let current = null;

  const stateFor = (dataset) => {
    const id = marketCaptureText(dataset);
    const existing = grouped.get(id);
    if (existing) return existing;
    const created = {
      dataset: id,
      records: new Map(),
      sequences: new Set(),
      endpoints: new Set(),
      latestSequence: 0,
      capturedAt: '',
    };
    grouped.set(id, created);
    return created;
  };

  const buildCurrent = () => {
    if (!latestSnapshot) return null;
    const datasets = [...grouped.values()].map((state) => ({
      sequence: state.latestSequence,
      dataset: state.dataset,
      endpoint: [...state.endpoints][0] || '',
      quality: 'confirmed-data',
      capturedAt: state.capturedAt,
      records: [...state.records.values()],
    }));
    const normalized = normalizeDataAnalysisMarketBrowserSnapshot({
      ...latestSnapshot,
      datasets,
    });
    const sourceCounts = new Map([...grouped.entries()].map(([id, state]) => [id, state.sequences.size]));
    normalized.datasetViews = normalized.datasetViews.map((dataset) => ({
      ...dataset,
      datasetCount: sourceCounts.get(marketCaptureText(dataset.dataset)) || dataset.datasetCount,
      endpoints: [...(grouped.get(marketCaptureText(dataset.dataset))?.endpoints || [])].slice(0, 30),
    }));
    normalized.sections = Object.fromEntries(Object.entries(normalized.sections).map(([id, section]) => [id, {
      ...section,
      datasetCount: (section.datasets || []).reduce(
        (total, dataset) => total + (sourceCounts.get(marketCaptureText(dataset)) || 0),
        0,
      ),
    }]));
    current = normalized;
    return current;
  };

  return Object.freeze({
    add(snapshot = {}) {
      latestSnapshot = { ...(latestSnapshot || {}), ...snapshot };
      for (const dataset of Array.isArray(snapshot.datasets) ? snapshot.datasets : []) {
        if (marketCaptureText(dataset?.quality) !== 'confirmed-data') continue;
        const sourceDataset = marketCaptureText(dataset?.dataset);
        const sequence = Math.max(0, Number(dataset?.sequence) || 0);
        const capturedAt = marketCaptureText(dataset?.capturedAt);
        const endpoint = marketCaptureText(dataset?.endpoint);
        const sourceRecords = Array.isArray(dataset?.records) ? dataset.records : [];
        if (sourceDataset === 'subscription-status') {
          const state = stateFor(sourceDataset);
          state.sequences.add(sequence);
          state.latestSequence = Math.max(state.latestSequence, sequence);
          state.capturedAt = [state.capturedAt, capturedAt].filter(Boolean).sort().at(-1) || '';
          if (endpoint) state.endpoints.add(endpoint);
          sourceRecords.forEach((record, index) => {
            state.records.set(`${sequence}:${index}`, record);
          });
          continue;
        }
        for (const sourceRecord of sourceRecords) {
          const resolvedDataset = resolveMarketDatasetId(sourceDataset, endpoint, sourceRecord);
          const record = compactRecord(sourceRecord, resolvedDataset, sequence, capturedAt, endpoint);
          record.dataset = resolvedDataset;
          if (!isMeaningfulMarketRecord(record)) continue;
          const state = stateFor(resolvedDataset);
          state.sequences.add(sequence);
          state.latestSequence = Math.max(state.latestSequence, sequence);
          state.capturedAt = [state.capturedAt, capturedAt].filter(Boolean).sort().at(-1) || '';
          if (endpoint) state.endpoints.add(endpoint);
          const key = recordKey(record);
          const existing = state.records.get(key);
          state.records.set(key, existing ? mergeMarketRecords(existing, record) : record);
        }
      }
      return buildCurrent();
    },
    snapshot() {
      return current || buildCurrent();
    },
  });
}
