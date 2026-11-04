const SENSITIVE_KEY_PATTERN =
  /(api[-_ ]?key|secret|token|password|authorization|client[-_ ]?id|client[-_ ]?secret|company[-_ ]?secret)/i;
const SENSITIVE_VALUE_PATTERNS = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\bozon-shop:client:\d+\b/gi,
  /(api[-_ ]?key|token|secret|password|authorization|client[-_ ]?secret|company[-_ ]?secret)\s*[:=]\s*[^,\s}]+/gi,
];
const SEARCH_TOKEN_SPLIT_PATTERN = /[\s,;，；、|_./\\:：#№-]+/;
const SEARCH_COMPACT_SEPARATOR_PATTERN = /[\s,;，；、|_./\\:：#№-]+/g;
const EXACT_SEARCH_TOKEN_SPLIT_PATTERN = SEARCH_TOKEN_SPLIT_PATTERN;
const MAX_LOCAL_MIRROR_RETRY_TASKS = 500;
const DEFAULT_LOCAL_MIRROR_RETRY_DELAY_MS = 30_000;
const MAX_LOCAL_MIRROR_RETRY_DELAY_MS = 15 * 60_000;

function toArray(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeKeyPart(value) {
  return normalizeText(value).replace(/[^a-zA-Z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function addMsToIso(timestamp, ms) {
  const time = Date.parse(timestamp);
  const base = Number.isFinite(time) ? time : Date.now();
  return new Date(base + Math.max(0, Number(ms) || 0)).toISOString();
}

function normalizeSearchText(value) {
  return normalizeText(value).toLowerCase();
}

function compactSearchText(value) {
  return normalizeSearchText(value).replace(SEARCH_COMPACT_SEPARATOR_PATTERN, '');
}

function compactExactSearchText(value) {
  return normalizeSearchText(value).replace(SEARCH_COMPACT_SEPARATOR_PATTERN, '');
}

function getSignificantExactSearchTokens(value) {
  const normalized = normalizeSearchText(value);
  const compact = compactExactSearchText(value);
  return [
    normalized,
    compact,
    ...normalized.split(EXACT_SEARCH_TOKEN_SPLIT_PATTERN),
    ...compact.split(EXACT_SEARCH_TOKEN_SPLIT_PATTERN),
  ]
    .map(normalizeSearchText)
    .filter((token, index, tokens) => token && compactExactSearchText(token).length >= 6 && tokens.indexOf(token) === index);
}

function addToSetMap(map, key, value) {
  const normalizedKey = normalizeText(key);
  if (!normalizedKey) return;
  if (!map.has(normalizedKey)) map.set(normalizedKey, new Set());
  map.get(normalizedKey).add(value);
}

function tokenizeSearchValue(value) {
  const normalized = normalizeSearchText(value);
  const compact = compactSearchText(value);
  const tokens = new Set();
  if (normalized) tokens.add(normalized);
  if (compact) tokens.add(compact);
  normalized
    .split(SEARCH_TOKEN_SPLIT_PATTERN)
    .map(normalizeSearchText)
    .filter(Boolean)
    .forEach((token) => tokens.add(token));
  compact
    .split(SEARCH_TOKEN_SPLIT_PATTERN)
    .map(compactSearchText)
    .filter(Boolean)
    .forEach((token) => tokens.add(token));
  if (compact.length >= 3) {
    for (let size = 3; size <= Math.min(compact.length, 16); size += 1) {
      tokens.add(compact.slice(0, size));
    }
  }
  return [...tokens];
}

function intersectKeySets(left, right) {
  if (!left) return right ? new Set(right) : null;
  if (!right) return new Set(left);
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  const output = new Set();
  smaller.forEach((key) => {
    if (larger.has(key)) output.add(key);
  });
  return output;
}

function normalizePage(value) {
  const page = Math.floor(Number(value) || 1);
  return Math.max(1, page);
}

function normalizePageSize(value) {
  const pageSize = Math.floor(Number(value) || 20);
  return Math.max(1, pageSize);
}

function defaultGetRowShop(row = {}) {
  return [row.shopClientId, row.clientId, row.shopId, row.storeName, row.shopName, row.shop];
}

export function rowMatchesShopScope(row = {}, shopScope = 'all', options = {}) {
  const scopeValues = toArray(shopScope).map(normalizeText).filter(Boolean);
  if (!scopeValues.length || scopeValues.includes('all')) return true;

  const rowValues = toArray((options.getRowShop ?? defaultGetRowShop)(row)).map(normalizeText).filter(Boolean);
  if (!rowValues.length) return false;
  const rowSet = new Set(rowValues);
  return scopeValues.some((value) => rowSet.has(value));
}

export function filterRowsByShopScope(rows = [], shopScope = 'all', options = {}) {
  return toArray(rows).filter((row) => rowMatchesShopScope(row, shopScope, options));
}

export function buildRowsIndex(rows = [], options = {}) {
  const getRowKey =
    typeof options.getRowKey === 'function'
      ? options.getRowKey
      : (row, index) => normalizeText(row?.recordKey ?? row?.id ?? index);
  const getRowShop =
    typeof options.getRowShop === 'function'
      ? options.getRowShop
      : defaultGetRowShop;
  const getRowStatuses =
    typeof options.getRowStatuses === 'function'
      ? options.getRowStatuses
      : (row) => [row?.status];
  const getSearchValues =
    typeof options.getSearchValues === 'function'
      ? options.getSearchValues
      : (row) => [row?.id, row?.posting, row?.salesOrder, row?.sku, row?.product, row?.buyer];

  const orderedKeys = [];
  const rowsByKey = new Map();
  const rowOrder = new Map();
  const keysByShop = new Map();
  const keysByStatus = new Map();
  const keysByToken = new Map();
  const keysByExactToken = new Map();
  const searchTextByKey = new Map();

  toArray(rows).forEach((row, index) => {
    const key = normalizeText(getRowKey(row, index));
    if (!key || rowsByKey.has(key)) return;
    orderedKeys.push(key);
    rowsByKey.set(key, row);
    rowOrder.set(key, index);

    toArray(getRowShop(row)).map(normalizeText).filter(Boolean).forEach((shopValue) => {
      addToSetMap(keysByShop, shopValue, key);
    });
    toArray(getRowStatuses(row)).map(normalizeText).filter(Boolean).forEach((statusValue) => {
      addToSetMap(keysByStatus, statusValue, key);
    });

    const searchValues = toArray(getSearchValues(row)).map(normalizeSearchText).filter(Boolean);
    searchTextByKey.set(key, searchValues.join(' '));
    // The inverted maps contain sets: repeated values/tokens for the same row
    // cannot add information. Keep the original joined search text unchanged.
    const uniqueSearchValues = [...new Set(searchValues)];
    new Set(uniqueSearchValues.flatMap(getSignificantExactSearchTokens)).forEach((token) => addToSetMap(keysByExactToken, token, key));
    new Set(uniqueSearchValues.flatMap(tokenizeSearchValue)).forEach((token) => addToSetMap(keysByToken, token, key));
  });

  return {
    orderedKeys,
    rowsByKey,
    rowOrder,
    keysByShop,
    keysByStatus,
    keysByToken,
    keysByExactToken,
    searchTextByKey,
  };
}

function resolveIndexedShopKeys(index, shopScope = 'all') {
  const scopeValues = toArray(shopScope).map(normalizeText).filter(Boolean);
  if (!scopeValues.length || scopeValues.includes('all')) return null;
  return scopeValues.reduce((merged, value) => {
    const keys = index.keysByShop.get(value);
    if (!keys) return merged ?? new Set();
    const next = merged ?? new Set();
    keys.forEach((key) => next.add(key));
    return next;
  }, null);
}

function resolveIndexedStatusKeys(index, statusValue = 'all', options = {}) {
  const allValue = normalizeText(options.allValue ?? 'all');
  const selectedStatus = normalizeText(statusValue || allValue);
  if (!selectedStatus || selectedStatus === allValue) return null;
  return index.keysByStatus.get(selectedStatus) ?? new Set();
}

function resolveIndexedSearchKeys(index, keyword = '') {
  const query = normalizeSearchText(keyword);
  if (!query) return null;
  const compactQuery = compactSearchText(query);
  const exactSets = getSignificantExactSearchTokens(query)
    .map((token) => index.keysByExactToken?.get(token))
    .filter(Boolean);
  if (exactSets.length) {
    return exactSets.reduce((merged, set) => {
      const next = merged ?? new Set();
      set.forEach((key) => next.add(key));
      return next;
    }, null);
  }
  const queryTokens = tokenizeSearchValue(query);
  const directSets = queryTokens.map((token) => index.keysByToken.get(token)).filter(Boolean);
  if (directSets.length) {
    return directSets.reduce((merged, set) => {
      const next = merged ?? new Set();
      set.forEach((key) => next.add(key));
      return next;
    }, null);
  }
  const fallback = new Set();
  index.searchTextByKey.forEach((searchText, key) => {
    if (searchText.includes(query) || (compactQuery && compactSearchText(searchText).includes(compactQuery))) {
      fallback.add(key);
    }
  });
  return fallback;
}

export function queryRowsIndex(index, options = {}) {
  if (!index || !Array.isArray(index.orderedKeys) || !(index.rowsByKey instanceof Map)) return [];
  let candidateKeys = null;
  candidateKeys = intersectKeySets(candidateKeys, resolveIndexedShopKeys(index, options.shopScope ?? 'all'));
  candidateKeys = intersectKeySets(
    candidateKeys,
    resolveIndexedStatusKeys(index, options.statusValue ?? options.allStatusValue ?? 'all', {
      allValue: options.allStatusValue ?? 'all',
    })
  );
  candidateKeys = intersectKeySets(candidateKeys, resolveIndexedSearchKeys(index, options.keyword ?? ''));
  const keys = candidateKeys ? [...candidateKeys] : index.orderedKeys;
  return keys
    .sort((left, right) => (index.rowOrder.get(left) ?? 0) - (index.rowOrder.get(right) ?? 0))
    .map((key) => index.rowsByKey.get(key))
    .filter(Boolean);
}

export function filterRowsByStatus(rows = [], statusValue = 'all', options = {}) {
  const allValue = normalizeText(options.allValue ?? 'all');
  const selectedStatus = normalizeText(statusValue || allValue);
  if (!selectedStatus || selectedStatus === allValue) return toArray(rows);
  const matchesStatus =
    typeof options.matchesStatus === 'function'
      ? options.matchesStatus
      : (row, value) => normalizeText(row?.status) === value;
  return toArray(rows).filter((row) => matchesStatus(row, selectedStatus));
}

export function buildStatusCounts(rows = [], statusRules = [], options = {}) {
  const sourceRows = toArray(rows);
  const allValue = normalizeText(options.allValue ?? 'all');
  const matchesStatus =
    typeof options.matchesStatus === 'function'
      ? options.matchesStatus
      : (row, value) => normalizeText(row?.status) === value;

  return toArray(statusRules).reduce((counts, rule) => {
    const key = normalizeText(rule?.value ?? rule?.label);
    if (!key) return counts;
    counts[key] = key === allValue ? sourceRows.length : sourceRows.filter((row) => matchesStatus(row, key)).length;
    return counts;
  }, {});
}

export function resolveLocalMirrorDataState(options = {}) {
  const rowCount = Math.max(0, Number(options.rows ?? options.rowCount) || 0);
  const filteredRowCount = Math.max(0, Number(options.filteredRows ?? options.filteredRowCount) || 0);
  const failures = Math.max(0, Number(options.failures ?? options.failureCount) || 0);
  const status = normalizeText(options.status).toLowerCase();
  const source = normalizeText(options.source || 'local-cache');
  const hasLoaded =
    options.hasLoaded === true ||
    Boolean(options.refreshedAt) ||
    Boolean(options.fetchedAt) ||
    ['success', 'read', 'hit', 'local', 'remote', 'partial', 'empty', 'failed', 'error'].includes(status);
  const isLoading = options.loading === true || status === 'loading';
  const isFailed = Boolean(options.error) || failures > 0 || ['failed', 'error'].includes(status);
  const isPartial = Boolean(options.partial) || (rowCount > 0 && isFailed);

  const state = (() => {
    if (isLoading && rowCount === 0) return 'loading';
    if (isPartial) return 'partial';
    if (isFailed) return 'failed';
    if (!hasLoaded && rowCount === 0) return 'not_loaded';
    if (rowCount === 0) return 'empty';
    return 'ready';
  })();

  return {
    state,
    source,
    sourceStatus: `${source}:${state}`,
    rows: rowCount,
    filteredRows: filteredRowCount,
    failures,
    hasRows: rowCount > 0,
    hasFilteredRows: filteredRowCount > 0,
    isLoading: state === 'loading',
    isEmpty: state === 'empty',
    isFailed: state === 'failed',
    isPartial: state === 'partial',
    isNotLoaded: state === 'not_loaded',
  };
}

export function paginateRows(rows = [], page = 1, pageSize = 20) {
  const sourceRows = toArray(rows);
  const safePageSize = normalizePageSize(pageSize);
  const totalRows = sourceRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / safePageSize));
  const currentPage = Math.min(normalizePage(page), totalPages);
  const startIndex = (currentPage - 1) * safePageSize;
  const pageRows = sourceRows.slice(startIndex, startIndex + safePageSize);

  return {
    rows: pageRows,
    totalRows,
    totalPages,
    currentPage,
    rangeStart: totalRows ? startIndex + 1 : 0,
    rangeEnd: Math.min(totalRows, startIndex + safePageSize),
  };
}

function getDatasetRowIdentity(row, index, getRowKey) {
  const key = normalizeText(getRowKey?.(row, index) ?? row?.entityId ?? row?.recordKey ?? row?.id);
  return key || `__row_index_${index}`;
}

function rowsContainRow(sourceRows = [], targetRow = null, getRowKey) {
  if (!targetRow) return true;
  const rowArray = toArray(sourceRows);
  if (rowArray.includes(targetRow)) return true;
  const targetKey = getDatasetRowIdentity(targetRow, -1, getRowKey);
  if (!targetKey) return false;
  return rowArray.some((row, index) => getDatasetRowIdentity(row, index, getRowKey) === targetKey);
}

export function validatePageDatasetConsistency(dataset = {}, options = {}) {
  const countRows = toArray(dataset.countRows);
  const filteredRows = toArray(dataset.filteredRows);
  const pageRows = toArray(dataset.pageRows ?? dataset.page?.rows);
  const page = dataset.page || {};
  const statusCounts = dataset.statusCounts && typeof dataset.statusCounts === 'object' ? dataset.statusCounts : {};
  const getRowKey = typeof options.getRowKey === 'function' ? options.getRowKey : undefined;
  const allValue = normalizeText(options.allStatusValue ?? 'all');
  const issues = [];

  if (Object.prototype.hasOwnProperty.call(statusCounts, allValue) && Number(statusCounts[allValue]) !== countRows.length) {
    issues.push({
      code: 'status-count-mismatch',
      expected: countRows.length,
      actual: Number(statusCounts[allValue]) || 0,
    });
  }

  if (Number.isFinite(Number(page.totalRows)) && Number(page.totalRows) !== filteredRows.length) {
    issues.push({
      code: 'page-total-mismatch',
      expected: filteredRows.length,
      actual: Number(page.totalRows),
    });
  }

  const filteredKeys = new Set(filteredRows.map((row, index) => getDatasetRowIdentity(row, index, getRowKey)));
  pageRows.forEach((row, index) => {
    if (!filteredKeys.has(getDatasetRowIdentity(row, index, getRowKey)) && !filteredRows.includes(row)) {
      issues.push({ code: 'page-row-outside-filtered-source', rowIndex: index });
    }
  });

  const detailRow = dataset.selectedDetail ?? dataset.detailRow ?? options.selectedDetail ?? options.detailRow;
  const detailSourceRows = dataset.detailSourceRows ?? options.detailSourceRows ?? filteredRows;
  if (detailRow && !rowsContainRow(detailSourceRows, detailRow, getRowKey)) {
    issues.push({ code: 'detail-row-outside-source' });
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

export function buildPageDataset(rows = [], options = {}) {
  const shopRows = filterRowsByShopScope(rows, options.shopScope ?? 'all', {
    getRowShop: options.getRowShop,
  });
  const beforeStatusFilter =
    typeof options.beforeStatusFilter === 'function' ? options.beforeStatusFilter : () => true;
  const countRows = shopRows.filter(beforeStatusFilter);
  const statusCounts = buildStatusCounts(countRows, options.statusRules ?? [], {
    allValue: options.allStatusValue ?? 'all',
    matchesStatus: options.matchesStatus,
  });
  const filteredRows = filterRowsByStatus(countRows, options.statusValue ?? options.allStatusValue ?? 'all', {
    allValue: options.allStatusValue ?? 'all',
    matchesStatus: options.matchesStatus,
  });
  const page = paginateRows(filteredRows, options.page, options.pageSize);
  const dataState = resolveLocalMirrorDataState({
    source: options.source,
    status: options.status,
    rows: shopRows.length,
    filteredRows: filteredRows.length,
    failures: options.failures,
    failureCount: options.failureCount,
    partial: options.partial,
    loading: options.loading,
    error: options.error,
    hasLoaded: options.hasLoaded,
    refreshedAt: options.refreshedAt,
    fetchedAt: options.fetchedAt,
  });

  return {
    countRows,
    filteredRows,
    statusCounts,
    pageRows: page.rows,
    page,
    dataState,
    consistency: validatePageDatasetConsistency(
      {
        countRows,
        filteredRows,
        statusCounts,
        pageRows: page.rows,
        page,
        selectedDetail: options.selectedDetail,
        detailSourceRows: options.detailSourceRows,
      },
      {
        allStatusValue: options.allStatusValue ?? 'all',
        getRowKey: options.getRowKey,
      }
    ),
  };
}

export function buildRefreshChangeSummary(previousRows = [], nextRows = [], options = {}) {
  const getRowKey =
    typeof options.getRowKey === 'function'
      ? options.getRowKey
      : (row) => normalizeText(row?.entityId ?? row?.recordKey ?? row?.id);
  const previousMap = new Map(
    toArray(previousRows)
      .map((row) => [normalizeText(getRowKey(row)), row])
      .filter(([key]) => key)
  );
  const nextMap = new Map(
    toArray(nextRows)
      .map((row) => [normalizeText(getRowKey(row)), row])
      .filter(([key]) => key)
  );

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  nextMap.forEach((row, key) => {
    const previous = previousMap.get(key);
    if (!previous) {
      added += 1;
      return;
    }
    if (JSON.stringify(previous) === JSON.stringify(row)) unchanged += 1;
    else updated += 1;
  });

  return {
    previous: previousMap.size,
    next: nextMap.size,
    added,
    updated,
    unchanged,
    removed: [...previousMap.keys()].filter((key) => !nextMap.has(key)).length,
    skippedEmpty: Math.max(0, Number(options.skippedEmpty) || 0),
    failed: Math.max(0, Number(options.failed) || 0),
  };
}

export function sanitizeLocalMirrorLog(value) {
  if (Array.isArray(value)) return value.map(sanitizeLocalMirrorLog);
  if (typeof value === 'string') {
    return SENSITIVE_VALUE_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[REDACTED]'), value);
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeLocalMirrorLog(entryValue),
    ])
  );
}

export function createLocalMirrorReadLog(entry = {}) {
  const rowCount = Math.max(0, Number(entry.rows) || 0);
  const failures = Math.max(0, Number(entry.failures) || 0);
  const dataState = resolveLocalMirrorDataState({
    ...entry,
    rows: rowCount,
    failures,
  });
  return sanitizeLocalMirrorLog({
    domain: normalizeText(entry.domain || 'unknown'),
    shopScope: entry.shopScope ?? 'all',
    source: normalizeText(entry.source || 'local-cache'),
    status: normalizeText(entry.status || 'read'),
    sourceStatus: dataState.sourceStatus,
    dataState,
    rows: rowCount,
    failures,
    partial: Boolean(entry.partial),
    refreshedAt: entry.refreshedAt || new Date().toISOString(),
    changeSummary: entry.changeSummary || null,
    details: entry.details || null,
  });
}

export function createLocalMirrorRetryTask(entry = {}, previousTask = null, options = {}) {
  const now = options.now || new Date().toISOString();
  const maxAttempts = Math.max(1, Number(options.maxAttempts ?? entry.maxAttempts) || 8);
  const previousAttemptCount = Math.max(0, Number(previousTask?.attemptCount) || 0);
  const attemptCount = Math.min(maxAttempts, previousAttemptCount + 1);
  const retryAfterMs = Math.max(0, Number(entry.retryAfterMs) || 0);
  const retryDelayMs =
    retryAfterMs ||
    Math.min(
      MAX_LOCAL_MIRROR_RETRY_DELAY_MS,
      DEFAULT_LOCAL_MIRROR_RETRY_DELAY_MS * 2 ** Math.max(0, attemptCount - 1)
    );
  const domain = normalizeText(entry.domain || 'unknown');
  const source = normalizeText(entry.source || 'local-cache');
  const entityType = normalizeText(entry.entityType || 'snapshot');
  const entityKey = normalizeText(entry.entityKey || entry.snapshotKey || entry.fileKey || 'unknown');
  const rawKey = normalizeText(entry.key) || [domain, source, entityType, entityKey].map(normalizeKeyPart).join(':');
  const reason = normalizeText(entry.reason || entry.message || entry.error?.message || entry.error || '读取失败');
  const status = attemptCount >= maxAttempts ? 'paused' : 'pending';

  return sanitizeLocalMirrorLog({
    key: rawKey,
    domain,
    source,
    entityType,
    entityKey,
    fileKey: entry.fileKey || '',
    snapshotKey: entry.snapshotKey || '',
    reason,
    status,
    attemptCount,
    maxAttempts,
    firstFailedAt: previousTask?.firstFailedAt || now,
    lastFailedAt: now,
    nextRetryAt: status === 'pending' ? addMsToIso(now, retryDelayMs) : '',
    retryDelayMs: status === 'pending' ? retryDelayMs : 0,
  });
}

export function mergeLocalMirrorRetryQueue(queue = {}, entry = {}, options = {}) {
  const currentRows = Array.isArray(queue?.rows) ? queue.rows : Array.isArray(queue) ? queue : [];
  const draftTask = createLocalMirrorRetryTask(entry, null, options);
  const previousTask = currentRows.find((row) => normalizeText(row?.key) === normalizeText(draftTask.key));
  const nextTask = createLocalMirrorRetryTask(entry, previousTask, options);
  const rows = [
    nextTask,
    ...currentRows.filter((row) => normalizeText(row?.key) !== normalizeText(nextTask.key)),
  ]
    .sort((left, right) => {
      const leftTime = Date.parse(left.lastFailedAt || left.nextRetryAt || '');
      const rightTime = Date.parse(right.lastFailedAt || right.nextRetryAt || '');
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    })
    .slice(0, MAX_LOCAL_MIRROR_RETRY_TASKS);

  return {
    version: 1,
    updatedAt: options.now || new Date().toISOString(),
    rows,
  };
}
