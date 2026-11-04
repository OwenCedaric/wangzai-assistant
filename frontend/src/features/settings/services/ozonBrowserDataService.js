import { normalizePurchaseBrowserState } from './purchaseBrowserLoginClient.js';

function createError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getCommand(commandOverride) {
  const command = commandOverride || globalThis.window?.wangzaiDesktop?.purchaseBrowser?.command;
  if (typeof command !== 'function') {
    throw createError('PURCHASE_BROWSER_BRIDGE_UNAVAILABLE', '当前桌面端没有提供内置浏览器。');
  }
  return command;
}

function requireText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw createError(code);
  return text;
}

function abortError() {
  const error = new Error('Ozon data observer check was cancelled.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function wait(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, milliseconds);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function normalizeResponse(response) {
  return {
    result: response?.result && typeof response.result === 'object' ? response.result : {},
    state: normalizePurchaseBrowserState(response?.state || response),
  };
}

export async function readOzonBrowserDataStatus({ tabId, command: commandOverride } = {}) {
  const command = getCommand(commandOverride);
  return normalizeResponse(await command({
    command: 'ozon-data-status',
    tabId: requireText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND'),
  }));
}

export async function waitForOzonBrowserDataObserver({
  tabId,
  command,
  signal,
  intervalMs = 250,
  timeoutMs = 5000,
} = {}) {
  const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError();
    const status = await readOzonBrowserDataStatus({ tabId, command });
    if (
      status.result.installed === true
      && status.result.enabled === true
      && status.result.ready === true
    ) return status;
    await wait(Math.max(50, Number(intervalMs) || 250), signal);
  }
  throw createError('OZON_DATA_OBSERVER_NOT_READY', 'Ozon 数据观察器没有成功加载，请重启内置浏览器。');
}

export async function readOzonBrowserData({
  tabId,
  afterSequence = 0,
  limit = 20,
  drain = false,
  command: commandOverride,
} = {}) {
  const command = getCommand(commandOverride);
  return normalizeResponse(await command({
    command: 'ozon-data-read',
    tabId: requireText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND'),
    afterSequence: Math.max(0, Number(afterSequence) || 0),
    limit: Math.max(1, Math.min(50, Number(limit) || 20)),
    drain: drain === true,
  }));
}

export async function readOzonBrowserDataCatalog({ tabId, command: commandOverride } = {}) {
  const command = getCommand(commandOverride);
  return normalizeResponse(await command({
    command: 'ozon-data-catalog',
    tabId: requireText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND'),
  }));
}

export async function normalizeOzonBrowserData({
  tabId,
  afterSequence = 0,
  limit = 10,
  command: commandOverride,
} = {}) {
  const command = getCommand(commandOverride);
  return normalizeResponse(await command({
    command: 'ozon-data-normalize',
    tabId: requireText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND'),
    afterSequence: Math.max(0, Number(afterSequence) || 0),
    limit: Math.max(1, Math.min(20, Number(limit) || 10)),
  }));
}

export async function readOzonBrowserDataPayload({
  tabId,
  sourceSequence,
  offset = 0,
  limit = 256 * 1024,
  command: commandOverride,
} = {}) {
  const command = getCommand(commandOverride);
  const sequence = Number(sourceSequence);
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw createError('OZON_DATA_PAYLOAD_SOURCE_REQUIRED', '缺少原始数据响应序号。');
  }
  return normalizeResponse(await command({
    command: 'ozon-data-payload',
    tabId: requireText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND'),
    sourceSequence: sequence,
    offset: Math.max(0, Number(offset) || 0),
    limit: Math.max(1, Math.min(512 * 1024, Number(limit) || 256 * 1024)),
  }));
}

export async function searchOzonBrowserData({
  tabId,
  sourceSequence,
  query,
  command: commandOverride,
} = {}) {
  const command = getCommand(commandOverride);
  const sequence = Number(sourceSequence);
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw createError('OZON_DATA_SEARCH_SOURCE_REQUIRED', '缺少可复用的关键词请求序号。');
  }
  const text = String(query || '').trim();
  if (!text || text.length > 160) {
    throw createError('OZON_DATA_SEARCH_QUERY_INVALID', '请输入有效的搜索词。');
  }
  return normalizeResponse(await command({
    command: 'ozon-data-search',
    tabId: requireText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND'),
    sourceSequence: sequence,
    query: text,
  }));
}

export async function probeKnownOzonBrowserData({
  tabId,
  sourceSequence = 0,
  path,
  method = 'POST',
  body = null,
  origin = 'https://seller.ozon.ru',
  maxAttempts = 3,
  retryDelayMs = 1000,
  signal,
  command: commandOverride,
} = {}) {
  const command = getCommand(commandOverride);
  const endpoint = String(path || '').trim();
  if (!endpoint.startsWith('/api/site/') || endpoint.includes('?') || endpoint.includes('#')) {
    throw createError('OZON_DATA_PROBE_PATH_INVALID', 'Ozon 只读端点无效。');
  }
  const browserTabId = requireText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND');
  const attempts = Math.max(1, Math.min(5, Number(maxAttempts) || 3));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw abortError();
    try {
      const response = normalizeResponse(await command({
        command: 'ozon-data-probe',
        tabId: browserTabId,
        sourceSequence: Math.max(0, Number(sourceSequence) || 0),
        path: endpoint,
        method: String(method || 'POST').trim().toUpperCase(),
        body: body && typeof body === 'object' && !Array.isArray(body) ? body : null,
        origin: String(origin || 'https://seller.ozon.ru').trim(),
      }));
      const status = Number(response.result.status) || 0;
      const retryableStatus = status === 408 || status === 425 || status === 429 || status >= 500;
      if (!retryableStatus || attempt >= attempts) {
        return {
          ...response,
          result: { ...response.result, attempts: attempt, retriesUsed: attempt - 1 },
        };
      }
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) throw error;
    }
    await wait(Math.max(1, Number(retryDelayMs) || 1000) * attempt, signal);
  }
  throw lastError || createError('OZON_DATA_OBSERVER_PROBE_FAILED');
}

export async function paginateOzonBrowserData({
  tabId,
  sourceSequence,
  maxPages = 5,
  delayMs = 350,
  command: commandOverride,
} = {}) {
  const command = getCommand(commandOverride);
  const sequence = Number(sourceSequence);
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw createError('OZON_DATA_PAGINATION_SOURCE_REQUIRED', '缺少可回放的数据响应序号。');
  }
  return normalizeResponse(await command({
    command: 'ozon-data-paginate',
    tabId: requireText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND'),
    sourceSequence: sequence,
    maxPages: Math.max(1, Math.min(250, Number(maxPages) || 5)),
    delayMs: Math.max(250, Math.min(3000, Number(delayMs) || 350)),
  }));
}

const SAFE_PAGINATION_TERMINALS = new Set([
  'cursor-exhausted',
  'duplicate-page',
  'empty-page',
  'no-data',
  'short-page',
]);

function appendUnique(target, seen, values = []) {
  let duplicates = 0;
  for (const value of Array.isArray(values) ? values : []) {
    const key = typeof value === 'string' ? `s:${value}` : `j:${JSON.stringify(value)}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    target.push(value);
  }
  return duplicates;
}

export async function paginateAllOzonBrowserData({
  tabId,
  sourceSequence,
  maxPages = 250,
  chunkPages = 25,
  delayMs = 700,
  maxRecoveryAttempts = 3,
  recoveryDelayMs = 1500,
  signal,
  onProgress,
  command: commandOverride,
} = {}) {
  const sequence = Number(sourceSequence);
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw createError('OZON_DATA_PAGINATION_SOURCE_REQUIRED', '缺少可回放的数据响应序号。');
  }
  const requestedPages = Math.max(1, Math.min(250, Number(maxPages) || 250));
  const pagesPerChunk = Math.max(1, Math.min(50, Number(chunkPages) || 25));
  const boundedDelay = Math.max(250, Math.min(3000, Number(delayMs) || 700));
  const recoveryLimit = Math.max(0, Math.min(5, Number(maxRecoveryAttempts) || 0));
  const capturedSequences = [];
  const pageValues = [];
  const sequenceKeys = new Set();
  const pageKeys = new Set();
  const chunks = [];
  let duplicateSequences = 0;
  let duplicatePageValues = 0;
  let currentSourceSequence = sequence;
  let recordsFetched = 0;
  let sourceRecordCount = 0;
  let retriesUsed = 0;
  let recoveryAttemptsUsed = 0;
  let consecutiveRecoveryAttempts = 0;
  let stopReason = 'max-pages-reached';
  let datasetComplete = false;
  let latestState = {};
  let lastResult = {};
  let lastError = null;

  while (capturedSequences.length < requestedPages) {
    if (signal?.aborted) throw abortError();
    const remainingPages = requestedPages - capturedSequences.length;
    const requestedChunkPages = Math.min(pagesPerChunk, remainingPages);
    let response;
    try {
      response = await paginateOzonBrowserData({
        tabId,
        sourceSequence: currentSourceSequence,
        maxPages: requestedChunkPages,
        delayMs: boundedDelay,
        command: commandOverride,
      });
      lastError = null;
    } catch (error) {
      lastError = error;
      if (consecutiveRecoveryAttempts >= recoveryLimit) break;
      consecutiveRecoveryAttempts += 1;
      recoveryAttemptsUsed += 1;
      await wait(Math.max(1, Number(recoveryDelayMs) || 1500) * consecutiveRecoveryAttempts, signal);
      continue;
    }

    latestState = response.state;
    const result = response.result || {};
    lastResult = result;
    if (chunks.length === 0) sourceRecordCount = Math.max(0, Number(result.sourceRecordCount) || 0);
    duplicateSequences += appendUnique(
      capturedSequences,
      sequenceKeys,
      (result.capturedSequences || []).map((value) => Number(value)).filter((value) => value > 0),
    );
    duplicatePageValues += appendUnique(pageValues, pageKeys, result.pageValues || []);
    recordsFetched += Math.max(0, Number(result.recordsFetched) || 0);
    retriesUsed += Math.max(0, Number(result.retriesUsed) || 0);
    stopReason = String(result.stopReason || 'unknown');
    const resumeSequence = Number(result.resumeSourceSequence || capturedSequences.at(-1));
    if (resumeSequence > 0) currentSourceSequence = resumeSequence;
    chunks.push({
      sourceSequence: Number(result.sourceSequence) || currentSourceSequence,
      requestedPages: requestedChunkPages,
      pagesFetched: Math.max(0, Number(result.pagesFetched) || 0),
      recordsFetched: Math.max(0, Number(result.recordsFetched) || 0),
      retriesUsed: Math.max(0, Number(result.retriesUsed) || 0),
      stopReason,
      failedPage: Math.max(0, Number(result.failedPage) || 0),
      failedStatus: Math.max(0, Number(result.failedStatus) || 0),
      resumeSourceSequence: currentSourceSequence,
    });

    const progress = {
      requestedPages,
      pagesFetched: capturedSequences.length,
      recordsFetched,
      sourceRecordCount,
      totalRecordCount: sourceRecordCount + recordsFetched,
      retriesUsed,
      recoveryAttemptsUsed,
      stopReason,
      resumeSourceSequence: currentSourceSequence,
    };
    if (typeof onProgress === 'function') await onProgress(progress);

    if (result.stoppedSafely === false) {
      consecutiveRecoveryAttempts = Number(result.pagesFetched) > 0
        ? 0
        : consecutiveRecoveryAttempts + 1;
      if (consecutiveRecoveryAttempts > recoveryLimit) break;
      recoveryAttemptsUsed += 1;
      await wait(Math.max(1, Number(recoveryDelayMs) || 1500), signal);
      continue;
    }
    consecutiveRecoveryAttempts = 0;
    if (SAFE_PAGINATION_TERMINALS.has(stopReason)) {
      datasetComplete = true;
      break;
    }
    if (Number(result.pagesFetched) <= 0) {
      stopReason = 'no-progress';
      break;
    }
  }

  const limitReached = !datasetComplete && capturedSequences.length >= requestedPages;
  const status = datasetComplete ? 'complete' : limitReached ? 'limit-reached' : 'partial';
  const chunkPageCount = chunks.reduce((total, chunk) => total + chunk.pagesFetched, 0);
  const chunkRecordCount = chunks.reduce((total, chunk) => total + chunk.recordsFetched, 0);
  return {
    result: {
      ready: true,
      version: String(lastResult.version || ''),
      status,
      datasetComplete,
      limitReached,
      initialSourceSequence: sequence,
      resumeSourceSequence: currentSourceSequence,
      requestedPages,
      pagesFetched: capturedSequences.length,
      recordsFetched,
      sourceRecordCount,
      totalRecordCount: sourceRecordCount + recordsFetched,
      capturedSequences,
      pageValues,
      retriesUsed,
      recoveryAttemptsUsed,
      stopReason,
      resumable: !datasetComplete && currentSourceSequence > 0,
      chunks,
      integrity: {
        uniqueCapturedSequences: duplicateSequences === 0,
        uniquePageValues: duplicatePageValues === 0,
        duplicateSequences,
        duplicatePageValues,
        capturedPageCountConsistent:
          chunkPageCount === capturedSequences.length + duplicateSequences,
        recordCountConsistent: chunkRecordCount === recordsFetched,
      },
      errorCode: String(lastError?.code || lastError?.message || ''),
    },
    state: latestState,
  };
}
