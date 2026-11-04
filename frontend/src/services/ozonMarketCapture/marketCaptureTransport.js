import { readOzonBrowserCaptureSnapshot } from '../ozonBrowserCaptureClient.js';
import {
  OZON_MARKET_COMMAND_RESERVE_MS,
  OZON_MARKET_PAGINATION_POLICIES,
  OZON_MARKET_REFRESH_BUDGET_MS,
} from './marketCaptureRoutes.js';

const DEFAULT_SEARCH_TIMEOUT_MS = 8_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_CAPTURE_SETTLE_MS = 500;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 20_000;
const DEFAULT_PAGINATION_MAX_PAGES = 250;
const DEFAULT_PAGINATION_BATCH_PAGES = 5;
const DEFAULT_PAGINATION_DELAY_MS = 100;
const MAX_PAGINATION_BATCH_PAGES = 25;
const DEFAULT_PAGINATION_MAX_ATTEMPTS = 3;
const DEFAULT_PAGINATION_RETRY_DELAY_MS = 1_000;
const COMPLETE_PAGINATION_STOP_REASONS = new Set([
  'reported-total-reached',
  'short-page',
  'empty-page',
  'cursor-exhausted',
]);
const FAILED_PAGINATION_STOP_REASONS = new Set([
  'network-error',
  'non-json-response',
  'capture-error',
  'capture-empty',
  'http-error',
]);
const SAFE_PARTIAL_PAGINATION_STOP_REASONS = new Map([
  // Some Ozon list endpoints accept the request but ignore its pagination
  // position and return the first page again. That is not proof of a complete
  // dataset, so never replace the trusted cache with it; it is still a safe
  // partial capture that must not block other, independently completed
  // datasets from being persisted.
  ['duplicate-page', Object.freeze({
    coverageStatus: 'pagination-ignored',
    limitationCode: 'OZON_DATA_PAGINATION_DUPLICATE_PAGE',
  })],
]);

function text(value) {
  return String(value ?? '').trim();
}
export function responseResult(response) {
  return response?.result && typeof response.result === 'object' ? response.result : response || {};
}

export function lastSequence(status = {}) {
  return Number(status.lastSequence || status.runtime?.lastSequence || 0) || 0;
}

export async function resolveAfterNavigationSequence(command, tabId, previousSequence = 0) {
  const before = Math.max(0, Number(previousSequence) || 0);
  try {
    const status = responseResult(await command({ command: 'ozon-data-status', tabId }));
    const current = lastSequence(status);
    // The observer lives in the page document. A real main-frame navigation
    // creates a new runtime whose sequence starts at zero; carrying the old
    // page's sequence into the new page silently skips its first responses.
    return current < before ? 0 : before;
  } catch {
    // Reading from zero is safe after navigation because every captured row is
    // still deduplicated by the cross-route accumulator.
    return 0;
  }
}

function sleep(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function normalizeCommandState(response) {
  return response?.state?.tabs ? response.state : response;
}

function normalizedUrlPath(value) {
  try {
    return new URL(text(value)).pathname.replace(/\/+$/u, '') || '/';
  } catch {
    return '';
  }
}

function findCommandTab(state, tabId) {
  return (Array.isArray(state?.tabs) ? state.tabs : [])
    .find((tab) => text(tab?.tabId) === text(tabId)) || null;
}

export async function waitForNavigationCommit(command, tabId, targetUrl, navigationResponse, options = {}) {
  const initialState = normalizeCommandState(navigationResponse);
  // Unit fixtures and older bridges may only acknowledge the command.  The
  // production CEF bridge always returns a tab snapshot, which lets us reject
  // the stale pre-navigation document instead of reading the preceding route.
  if (!Array.isArray(initialState?.tabs)) return null;
  const expectedPath = normalizedUrlPath(targetUrl);
  const timeoutMs = Math.max(250, Math.min(
    30_000,
    Number(options.navigationTimeoutMs) || DEFAULT_NAVIGATION_TIMEOUT_MS,
  ));
  const pollIntervalMs = Math.max(50, Math.min(
    1_000,
    Number(options.navigationPollIntervalMs) || DEFAULT_POLL_INTERVAL_MS,
  ));
  const deadline = Date.now() + timeoutMs;
  let state = initialState;
  let tab = findCommandTab(state, tabId);
  const requestedNavigationSequence = Number(tab?.navigationSequence) || 0;
  const hasNativeNavigationFence = requestedNavigationSequence > 0;
  while (true) {
    const nativeNavigationCommitted = !hasNativeNavigationFence
      || Number(tab?.navigationCompletedSequence) >= requestedNavigationSequence;
    if (
      normalizedUrlPath(tab?.url) === expectedPath
      && tab?.loading !== true
      && nativeNavigationCommitted
    ) return tab;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
    state = normalizeCommandState(await command({ command: 'state' }));
    tab = findCommandTab(state, tabId);
  }
  const error = new Error(`Ozon 后台页面未切换到 ${expectedPath || targetUrl}。`);
  error.code = 'OZON_MARKET_ROUTE_NAVIGATION_TIMEOUT';
  error.expectedPath = expectedPath;
  error.actualPath = normalizedUrlPath(tab?.url);
  error.expectedNavigationSequence = requestedNavigationSequence;
  error.completedNavigationSequence = Number(tab?.navigationCompletedSequence) || 0;
  throw error;
}

export async function navigateToExactMarketRoute(command, tabId, targetUrl, options = {}) {
  const attempts = Math.max(1, Math.min(2, Number(options.navigationAttempts) || 2));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const navigation = await command({ command: 'navigate', tabId, url: targetUrl, waitUntil: 'commit' });
    try {
      return await waitForNavigationCommit(command, tabId, targetUrl, navigation, options);
    } catch (error) {
      lastError = error;
      if (error?.code !== 'OZON_MARKET_ROUTE_NAVIGATION_TIMEOUT' || attempt >= attempts) throw error;
      await sleep(Math.min(1_000, Math.max(100, Number(options.navigationRetryDelayMs) || 250)));
    }
  }
  throw lastError;
}

async function readNormalizedBatch(command, tabId, afterSequence = 0, limit = 20) {
  const response = await command({
    command: 'ozon-data-normalize',
    tabId,
    afterSequence: Math.max(0, Number(afterSequence) || 0),
    limit: Math.max(1, Math.min(20, Number(limit) || 20)),
  });
  const result = responseResult(response);
  return Array.isArray(result.datasets) ? result.datasets : [];
}

export async function readNormalizedDatasetWindow(command, tabId, afterSequence = 0, maxBatches = 20) {
  const datasets = [];
  let cursor = Math.max(0, Number(afterSequence) || 0);
  const boundedBatches = Math.max(1, Math.min(20, Number(maxBatches) || 20));
  for (let batchIndex = 0; batchIndex < boundedBatches; batchIndex += 1) {
    const batch = await readNormalizedBatch(command, tabId, cursor, 20);
    if (!batch.length) break;
    datasets.push(...batch);
    const nextCursor = Math.max(...batch.map((dataset) => Number(dataset?.sequence) || 0));
    if (nextCursor <= cursor || batch.length < 20) break;
    cursor = nextCursor;
  }
  return datasets;
}

export function latestDataset(datasets, datasetId) {
  return datasets
    .filter((item) => text(item?.dataset) === datasetId)
    .sort((left, right) => (Number(right?.sequence) || 0) - (Number(left?.sequence) || 0))[0] || null;
}

export function mergeRouteBatches(...batches) {
  const merge = (field) => {
    const items = [];
    const seen = new Set();
    for (const batch of batches) {
      for (const dataset of Array.isArray(batch?.[field]) ? batch[field] : []) {
        const key = `${Number(dataset?.sequence) || 0}:${text(dataset?.dataset)}:${text(dataset?.endpoint)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(dataset);
      }
    }
    return items;
  };
  return { datasets: merge('datasets'), matching: merge('matching') };
}

const PAGINATION_POSITION_KEYS = new Set([
  'after',
  'cursor',
  'next_cursor',
  'nextcursor',
  'offset',
  'page',
  'page_index',
  'page_number',
  'pageindex',
  'pagenumber',
  'skip',
]);
const PAGINATION_LIMIT_KEYS = new Set([
  'count',
  'limit',
  'page_size',
  'pagesize',
  'size',
  'take',
]);

function paginationShapeScore(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return 0;
  let score = 0;
  for (const [rawKey, nested] of Object.entries(value)) {
    const key = text(rawKey).toLowerCase();
    if (PAGINATION_POSITION_KEYS.has(key)) score = Math.max(score, 2);
    else if (PAGINATION_LIMIT_KEYS.has(key)) score = Math.max(score, 1);
    if (nested && typeof nested === 'object') {
      score = Math.max(score, paginationShapeScore(nested, depth + 1));
    }
  }
  return score;
}

function paginationRecipeScore(dataset = {}) {
  const kind = text(dataset?.pagination?.kind).toLowerCase();
  if (['cursor', 'offset', 'page'].includes(kind)) return 3;
  if (kind === 'limit') return 2;
  return Math.max(
    paginationShapeScore(dataset?.query),
    paginationShapeScore(dataset?.requestBody),
  );
}

export function paginationCandidates(datasets = [], expected = []) {
  const accepted = new Set(expected.map(text).filter(Boolean));
  const bySource = new Map();
  for (const dataset of datasets) {
    const id = text(dataset?.dataset);
    const sequence = Math.max(0, Number(dataset?.sequence) || 0);
    if (!sequence || text(dataset?.quality) !== 'confirmed-data') continue;
    if (accepted.size && !accepted.has(id)) continue;
    const key = `${id}:${text(dataset?.endpoint) || sequence}`;
    const current = bySource.get(key);
    const candidateScore = paginationRecipeScore(dataset);
    const currentScore = paginationRecipeScore(current);
    if (
      !current
      || candidateScore > currentScore
      || (candidateScore === currentScore && sequence > Number(current.sequence || 0))
    ) bySource.set(key, dataset);
  }
  return [...bySource.values()].sort((left, right) => Number(right.sequence || 0) - Number(left.sequence || 0));
}

function expectedPaginationMiss(error) {
  const code = text(error?.code || error?.message).toUpperCase();
  return code.includes('PAGINATION_UNAVAILABLE')
    || code.includes('PAGINATION_NOT_SAFE')
    || code.includes('PAYLOAD_NOT_FOUND');
}

function markSafePartialPagination(aggregate, {
  limitationCode = '',
  stopReason = '',
  coverageStatus = 'bounded-partial',
} = {}) {
  aggregate.complete = false;
  aggregate.stoppedSafely = true;
  aggregate.safePartial = true;
  aggregate.safeToPersist = true;
  aggregate.preserveExisting = true;
  aggregate.stopReason = text(stopReason || aggregate.stopReason || 'pagination-unavailable');
  aggregate.coverageStatus = text(coverageStatus || 'bounded-partial');
  aggregate.limitationCode = text(limitationCode || aggregate.stopReason || 'OZON_DATA_PAGINATION_UNAVAILABLE');
  aggregate.errorCode = '';
  return aggregate;
}

function paginationCommandBudgetMiss(error) {
  const code = text(error?.code || error?.message).toUpperCase();
  return code.includes('PURCHASE_BROWSER_COMMAND_TIMEOUT')
    || code.includes('OZON_DATA_PAGINATION_TIMEOUT');
}

function paginationSessionInvalid(error) {
  const code = text(error?.code || error?.message).toUpperCase();
  return code.includes('PURCHASE_BROWSER_SESSION_STALE')
    || code.includes('PURCHASE_BROWSER_SESSION_CRASHED')
    || code.includes('PURCHASE_BROWSER_CEF_RUNTIME_CLOSED')
    || code.includes('PURCHASE_BROWSER_CEF_PROTOCOL_CLOSED')
    || code.includes('PURCHASE_BROWSER_CEF_HOST_UNHEALTHY');
}

function createPaginationAggregate(dataset = {}) {
  return {
    dataset: text(dataset.dataset),
    sourceSequence: Number(dataset.sequence) || 0,
    pagesFetched: 0,
    recordsFetched: 0,
    totalRecordCount: Number(dataset.recordCount) || 0,
    stopReason: '',
    complete: false,
    stoppedSafely: true,
    safePartial: false,
    safeToPersist: false,
    preserveExisting: true,
    coverageStatus: 'incomplete',
    limitationCode: '',
    errorCode: '',
    failedPage: 0,
    failedStatus: 0,
    capturedSequences: [],
    commandAttempts: 0,
    retryCount: 0,
    lastRetryCode: '',
  };
}

function markTimeBudgetPartial(aggregate) {
  return markSafePartialPagination(aggregate, {
    stopReason: 'time-budget-exhausted',
    coverageStatus: 'time-budget-exhausted',
    limitationCode: 'OZON_DATA_PAGINATION_TIME_BUDGET_EXHAUSTED',
  });
}

function markPageBudgetPartial(aggregate) {
  return markSafePartialPagination(aggregate, {
    stopReason: 'max-page-limit',
    coverageStatus: 'page-budget-exhausted',
    limitationCode: 'OZON_DATA_PAGINATION_PAGE_BUDGET_EXHAUSTED',
  });
}

function paginationResponseComplete(response = {}) {
  const stopReason = text(response.stopReason);
  if (response.stoppedSafely === false || FAILED_PAGINATION_STOP_REASONS.has(stopReason)) return false;
  return COMPLETE_PAGINATION_STOP_REASONS.has(stopReason);
}

function paginationFailureCode(response = {}) {
  return text(response.failureCode || response.errorCode || response.stopReason || 'OZON_DATA_PAGINATION_INCOMPLETE');
}

function unresolvedPaginationResults(results = []) {
  const items = Array.isArray(results) ? results : [];
  const completedDatasets = new Set(items
    .filter((item) => item?.complete === true)
    .map((item) => text(item?.dataset))
    .filter(Boolean));
  return items.filter((item) => (
    item?.complete === false
    && !completedDatasets.has(text(item?.dataset))
  ));
}

function transientObserverReadError(error) {
  const code = text(error?.code || error?.message).toUpperCase();
  return code.includes('OZON_DATA_OBSERVER_NOT_READY')
    || code.includes('OZON_DATA_OBSERVER_NORMALIZE_FAILED')
    || code.includes('PURCHASE_BROWSER_CEF_FAILED')
    || code.includes('PURCHASE_BROWSER_COMMAND_CANCELLED');
}

export async function paginateCapturedDatasets(command, tabId, datasets, expected, options = {}) {
  if (options.pagination === false) return [];
  const delayMs = Math.max(100, Math.min(3_000, Number(options.paginationDelayMs) || DEFAULT_PAGINATION_DELAY_MS));
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const configuredDeadline = Number(options.paginationDeadlineAt) || 0;
  const deadlineAt = configuredDeadline > 0
    ? configuredDeadline
    : now() + Math.max(1_000, Number(options.paginationBudgetMs) || OZON_MARKET_REFRESH_BUDGET_MS);
  const commandReserveMs = options.paginationCommandReserveMs == null
    ? OZON_MARKET_COMMAND_RESERVE_MS
    : Math.max(0, Number(options.paginationCommandReserveMs) || 0);
  const maxAttempts = Math.max(1, Math.min(
    5,
    Number(options.paginationMaxAttempts) || DEFAULT_PAGINATION_MAX_ATTEMPTS,
  ));
  const retryDelayMs = options.paginationRetryDelayMs === 0
    ? 0
    : Math.max(100, Math.min(
      10_000,
      Number(options.paginationRetryDelayMs) || DEFAULT_PAGINATION_RETRY_DELAY_MS,
    ));
  const results = [];
  for (const dataset of paginationCandidates(datasets, expected)) {
    const datasetId = text(dataset.dataset);
    const policy = OZON_MARKET_PAGINATION_POLICIES[datasetId] || {};
    const maxPages = Math.max(1, Math.min(
      250,
      Number(options.paginationMaxPages) || Number(policy.maxPages) || DEFAULT_PAGINATION_MAX_PAGES,
    ));
    const batchPages = Math.max(1, Math.min(
      MAX_PAGINATION_BATCH_PAGES,
      Number(options.paginationBatchPages) || Number(policy.batchPages) || DEFAULT_PAGINATION_BATCH_PAGES,
    ));
    let sourceSequence = Number(dataset.sequence);
    let remainingPages = maxPages;
    const aggregate = createPaginationAggregate(dataset);
    try {
      while (remainingPages > 0) {
        if ((deadlineAt - now()) <= commandReserveMs) {
          markTimeBudgetPartial(aggregate);
          break;
        }
        const requestedPages = Math.min(batchPages, remainingPages);
        let response;
        let attempt = 0;
        while (attempt < maxAttempts) {
          attempt += 1;
          aggregate.commandAttempts += 1;
          try {
            response = responseResult(await command({
              command: 'ozon-data-paginate',
              tabId,
              sourceSequence,
              maxPages: requestedPages,
              delayMs,
            }));
            break;
          } catch (error) {
            const retryable = paginationCommandBudgetMiss(error) || transientObserverReadError(error);
            const retryDeadlineAvailable = (deadlineAt - now()) > commandReserveMs;
            if (
              !retryable
              || options.signal?.aborted === true
              || attempt >= maxAttempts
              || !retryDeadlineAvailable
            ) throw error;
            aggregate.retryCount += 1;
            aggregate.lastRetryCode = text(error?.code || error?.message || 'OZON_DATA_PAGINATION_RETRY');
            await options.onPaginationRetry?.({
              dataset: datasetId,
              sourceSequence,
              requestedPages,
              attempt,
              nextAttempt: attempt + 1,
              code: aggregate.lastRetryCode,
            }, dataset);
            const backoffMs = retryDelayMs * (attempt === 1 ? 1 : 3);
            if (backoffMs > 0) await sleep(backoffMs);
          }
        }
        const pagesFetched = Number(response.pagesFetched) || 0;
        const attemptedPages = Math.max(pagesFetched, Number(response.attemptedPages) || 0);
        const batchRecordCount = Number(response.recordsFetched) || 0;
        aggregate.capturedSequences.push(...(Array.isArray(response.capturedSequences)
          ? response.capturedSequences.map(Number).filter((sequence) => sequence > 0)
          : []));
        aggregate.capturedSequences = [...new Set(aggregate.capturedSequences)];
        aggregate.pagesFetched += pagesFetched;
        if (text(response.paginationKind) === 'limit') {
          aggregate.recordsFetched = Math.max(aggregate.recordsFetched, batchRecordCount);
          aggregate.totalRecordCount = Math.max(
            aggregate.totalRecordCount,
            Number(response.totalRecordCount) || 0,
            batchRecordCount,
          );
        } else {
          aggregate.recordsFetched += batchRecordCount;
          aggregate.totalRecordCount = Math.max(
            aggregate.totalRecordCount,
            Number(response.totalRecordCount) || 0,
            (Number(dataset.recordCount) || 0) + aggregate.recordsFetched,
          );
        }
        aggregate.stopReason = text(response.stopReason);
        aggregate.stoppedSafely = response.stoppedSafely !== false
          && !FAILED_PAGINATION_STOP_REASONS.has(aggregate.stopReason);
        aggregate.complete = paginationResponseComplete(response);
        aggregate.failedPage = Math.max(aggregate.failedPage, Number(response.failedPage) || 0);
        aggregate.failedStatus = Math.max(aggregate.failedStatus, Number(response.failedStatus) || 0);
        const safePartialReason = SAFE_PARTIAL_PAGINATION_STOP_REASONS.get(aggregate.stopReason);
        if (!aggregate.complete && safePartialReason) {
          markSafePartialPagination(aggregate, {
            ...safePartialReason,
            stopReason: aggregate.stopReason,
          });
        } else {
          aggregate.errorCode = aggregate.complete || aggregate.stopReason === 'max-pages-reached'
            ? ''
            : paginationFailureCode(response);
          aggregate.safePartial = !aggregate.complete
            && aggregate.stoppedSafely
            && aggregate.stopReason === 'max-pages-reached';
          aggregate.safeToPersist = aggregate.complete || aggregate.safePartial;
          aggregate.preserveExisting = !aggregate.complete;
          aggregate.coverageStatus = aggregate.complete
            ? 'complete'
            : aggregate.safePartial ? 'bounded-partial' : 'failed';
          aggregate.limitationCode = aggregate.safePartial
            ? 'OZON_DATA_PAGINATION_LIMIT_REACHED'
            : '';
        }
        if (pagesFetched > 0) await options.onPaginationBatch?.({ ...aggregate }, dataset);
        remainingPages -= Math.max(1, attemptedPages);
        if (
          !aggregate.complete
          && aggregate.stoppedSafely
          && aggregate.stopReason === 'max-pages-reached'
          && remainingPages <= 0
        ) {
          markPageBudgetPartial(aggregate);
          break;
        }
        const resumeSequence = Number(response.resumeSourceSequence) || 0;
        if (!pagesFetched || aggregate.stopReason !== 'max-pages-reached' || !resumeSequence || resumeSequence === sourceSequence) break;
        sourceSequence = resumeSequence;
      }
      // Reaching the configured safety ceiling is a valid bounded read, but it
      // is not proof that the remote dataset ended.  Keep it visible as a
      // partial result so callers cannot overwrite a larger trusted cache.
      if (!aggregate.complete && !aggregate.errorCode && !aggregate.safePartial) {
        aggregate.errorCode = aggregate.stopReason === 'max-pages-reached'
          ? 'OZON_DATA_PAGINATION_LIMIT_REACHED'
          : 'OZON_DATA_PAGINATION_INCOMPLETE';
      }
      if (aggregate.safePartial) {
        aggregate.limitationCode = aggregate.errorCode || aggregate.limitationCode;
        aggregate.errorCode = '';
      }
      results.push(aggregate);
    } catch (error) {
      if (paginationSessionInvalid(error)) throw error;
      const expectedMiss = expectedPaginationMiss(error);
      const pageTimeout = paginationCommandBudgetMiss(error);
      const observerTimeout = transientObserverReadError(error);
      const failureCode = text(error?.code || error?.message || 'OZON_DATA_PAGINATION_FAILED');
      aggregate.stopReason = aggregate.stopReason
        || (pageTimeout ? 'page-timeout' : observerTimeout ? 'observer-timeout' : expectedMiss ? 'pagination-unavailable' : 'command-error');
      if (pageTimeout && (deadlineAt - now()) <= commandReserveMs) {
        markTimeBudgetPartial(aggregate);
      } else if (pageTimeout) {
        markSafePartialPagination(aggregate, {
          limitationCode: failureCode,
          stopReason: 'page-timeout',
          coverageStatus: 'page-timeout',
        });
      } else if (observerTimeout) {
        markSafePartialPagination(aggregate, {
          limitationCode: failureCode,
          stopReason: 'observer-timeout',
          coverageStatus: 'observer-timeout',
        });
      } else if (expectedMiss) {
        markSafePartialPagination(aggregate, {
          limitationCode: failureCode,
          stopReason: 'pagination-unavailable',
          coverageStatus: 'pagination-unavailable',
        });
      } else {
        aggregate.complete = false;
        aggregate.stoppedSafely = false;
        aggregate.safePartial = false;
        aggregate.safeToPersist = false;
        aggregate.preserveExisting = true;
        aggregate.coverageStatus = 'failed';
        aggregate.errorCode = failureCode;
        await options.onPaginationError?.(error, dataset);
      }
      results.push(aggregate);
    }
  }
  return results;
}

export function paginationSummary(results = []) {
  const incomplete = unresolvedPaginationResults(results);
  const safePartial = incomplete.filter((item) => item?.safePartial === true && item?.safeToPersist === true);
  const failed = incomplete.filter((item) => item?.safePartial !== true || item?.safeToPersist !== true);
  return {
    sourceCount: results.length,
    pagesFetched: results.reduce((total, item) => total + (Number(item.pagesFetched) || 0), 0),
    recordsFetched: results.reduce((total, item) => total + (Number(item.recordsFetched) || 0), 0),
    complete: incomplete.length === 0,
    safeToPersist: failed.length === 0,
    safePartialDatasets: [...new Set(safePartial
      .map((item) => text(item?.dataset))
      .filter(Boolean))],
    incompleteDatasets: [...new Set(incomplete
      .map((item) => text(item?.dataset))
      .filter(Boolean))],
    warnings: safePartial.map((item) => ({
      dataset: text(item?.dataset),
      coverageStatus: text(item?.coverageStatus),
      limitationCode: text(item?.limitationCode),
      stopReason: text(item?.stopReason),
      preserveExisting: item?.preserveExisting !== false,
    })),
    sources: results,
  };
}

export async function waitForDatasets(command, tabId, {
  afterSequence = 0,
  expected = [],
  timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  settleMs = DEFAULT_CAPTURE_SETTLE_MS,
  requireConfirmed = true,
} = {}) {
  const startedAt = Date.now();
  const boundedTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
  const boundedSettleMs = Math.max(0, Math.min(
    boundedTimeoutMs,
    Number(settleMs) || 0,
  ));
  let latest;
  let matching;
  let lastMatchingSignature = '';
  let lastMatchingChangeAt = 0;
  const hardDeadline = startedAt + boundedTimeoutMs + (boundedSettleMs * 2);
  while (true) {
    try {
      latest = await readNormalizedDatasetWindow(command, tabId, afterSequence, 20);
    } catch (error) {
      const remainingMs = hardDeadline - Date.now();
      if (!transientObserverReadError(error) || remainingMs <= 0) throw error;
      await sleep(Math.min(Math.max(50, Number(pollIntervalMs) || 0), remainingMs));
      continue;
    }
    matching = latest.filter((item) => {
      if (!expected.length || !expected.includes(text(item?.dataset))) return false;
      return requireConfirmed ? text(item?.quality) === 'confirmed-data' : true;
    });
    if (matching.length) {
      const signature = matching
        .map((item) => Number(item?.sequence) || 0)
        .sort((left, right) => left - right)
        .join(',');
      if (signature !== lastMatchingSignature) {
        lastMatchingSignature = signature;
        lastMatchingChangeAt = Date.now();
      }
      if (boundedSettleMs === 0 || Date.now() - lastMatchingChangeAt >= boundedSettleMs) {
        return { datasets: latest, matching };
      }
    }
    const ordinaryDeadline = startedAt + boundedTimeoutMs;
    const settleDeadline = matching.length && boundedSettleMs > 0
      ? Math.min(hardDeadline, lastMatchingChangeAt + boundedSettleMs)
      : ordinaryDeadline;
    const remainingMs = settleDeadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(Math.max(0, Number(pollIntervalMs) || 0), remainingMs));
  }
  return {
    datasets: latest,
    matching: matching.length
      ? matching
      : latest.filter((item) => expected.includes(text(item?.dataset))),
  };
}

function hasProductPerformanceSignals(dataset = {}) {
  const signalFields = ['searchPosition', 'orderAmount', 'dynamics', 'orderedProducts', 'averagePurchasePrice'];
  return Array.isArray(dataset?.records)
    && dataset.records.some((record) => signalFields.some((field) => (
      record?.[field] !== null
      && record?.[field] !== undefined
      && record?.[field] !== ''
      && (typeof record[field] !== 'number' || record[field] !== 0)
    )));
}

export function needsProductPerformanceProbe(route = {}, batch = {}) {
  if (route.id !== 'ozon-bestsellers' || !Array.isArray(route.probes) || !route.probes.length) return false;
  return !batch.matching.some(hasProductPerformanceSignals);
}

export async function probeRouteDatasets(command, tabId, route, baseline, options = {}) {
  for (const probe of Array.isArray(route.probes) ? route.probes : []) {
    try {
      const response = responseResult(await command({
        command: 'ozon-data-probe',
        tabId,
        path: probe.path,
        method: probe.method || 'POST',
        origin: probe.origin,
        body: probe.body || {},
      }));
      const capturedSequence = Number(response.capturedSequence) || 0;
      if (response.quality !== 'confirmed-data' || !capturedSequence) continue;
      const batch = await waitForDatasets(command, tabId, {
        afterSequence: baseline,
        expected: route.datasets,
        timeoutMs: options.probeTimeoutMs ?? route.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
        pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        settleMs: route.settleMs ?? options.captureSettleMs ?? DEFAULT_CAPTURE_SETTLE_MS,
      });
      // A route can emit another request to the same endpoint while the probe
      // result is settling.  Only the probe's exact sequence is guaranteed to
      // carry the explicit, audited offset/limit body.  Handing a later natural
      // request to the paginator can select an unrelated body without paging
      // fields and incorrectly surface PAGINATION_UNAVAILABLE.
      const exactProbeMatching = batch.matching.filter(
        (dataset) => Number(dataset?.sequence) === capturedSequence,
      );
      if (
        route.id === 'ozon-bestsellers'
          ? exactProbeMatching.some(hasProductPerformanceSignals)
          : exactProbeMatching.length > 0
      ) return {
        ...batch,
        matching: exactProbeMatching,
        paginationMatching: exactProbeMatching,
        probe,
        probeResponse: response,
      };
    } catch (error) {
      await options.onRouteError?.(error, { ...route, phase: 'probe', probe: probe.path });
    }
  }
  return { datasets: [], matching: [] };
}

export async function readSearchSnapshot(
  command,
  tabId,
  afterSequence = 0,
  accumulator = null,
  normalizeSnapshot = (snapshot) => snapshot,
) {
  const snapshot = await readOzonBrowserCaptureSnapshot({
    command,
    tabId,
    afterSequence,
    autoOpen: false,
  });
  return accumulator?.add ? accumulator.add(snapshot) : normalizeSnapshot(snapshot);
}

