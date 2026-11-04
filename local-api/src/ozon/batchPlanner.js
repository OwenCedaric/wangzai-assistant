import { createStableHash } from '../utils/stableHash.js';

const DEFAULT_MAX_BATCHES = 100;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_LIMIT = 100;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function cloneParams(params = {}) {
  if (!params || typeof params !== 'object') return {};
  return JSON.parse(JSON.stringify(params));
}

function createPlannerError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'BatchPlannerError';
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizePositiveInteger(value, fallback) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : fallback;
}

function clampLimit(value, planning = {}) {
  const maxLimit = normalizePositiveInteger(planning.maxLimit, DEFAULT_LIMIT);
  const defaultLimit = normalizePositiveInteger(planning.defaultLimit, maxLimit);
  const limit = normalizePositiveInteger(value, defaultLimit);
  if (limit > maxLimit) {
    throw createPlannerError('BATCH_LIMIT_EXCEEDS_MAX', `Requested limit ${limit} exceeds endpoint maxLimit ${maxLimit}.`, { limit, maxLimit });
  }
  return limit;
}

function chunkArray(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

function uniqueArray(items = []) {
  return [...new Set(items.filter((item) => item !== undefined && item !== null && item !== ''))];
}

function getPathValue(source, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((value, key) => (value == null ? undefined : value[key]), source);
}

function setPathValue(target, path, value) {
  const parts = String(path).split('.');
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
  return target;
}

function getRowsFromResponse(response = {}, planning = {}) {
  const data = response.data ?? response;
  const explicitPath = planning.itemsPath || planning.responseItemsPath;
  const explicit = getPathValue(data, explicitPath);
  if (Array.isArray(explicit)) return explicit;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data?.result?.items)) return data.result.items;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.values)) return data.values;
  if (Array.isArray(data?.rows)) return data.rows;
  return [];
}

function normalizePlanning(endpoint = {}) {
  const fromLegacyBatching = endpoint.batching || {};
  const fromLegacyPagination = endpoint.pagination || {};
  const planning = endpoint.planning || {};
  const mode = planning.mode || fromLegacyBatching.mode || fromLegacyPagination.mode || 'single';
  return {
    mode,
    arrayParam: planning.arrayParam || fromLegacyBatching.arrayParam || detectArrayParamName(endpoint),
    limitParam: planning.limitParam || fromLegacyPagination.limitField || 'limit',
    offsetParam: planning.offsetParam || fromLegacyPagination.offsetField || 'offset',
    cursorParam: planning.cursorParam || 'cursor',
    nextCursorPath: planning.nextCursorPath || fromLegacyPagination.nextCursorPath || 'result.cursor',
    lastIdParam: planning.lastIdParam || 'last_id',
    nextLastIdPath: planning.nextLastIdPath || 'result.last_id',
    dateFromParam: planning.dateFromParam || 'since',
    dateToParam: planning.dateToParam || 'to',
    maxLimit: planning.maxLimit ?? fromLegacyPagination.maxLimit ?? DEFAULT_LIMIT,
    defaultLimit: planning.defaultLimit ?? fromLegacyPagination.defaultLimit ?? DEFAULT_LIMIT,
    maxPages: planning.maxPages ?? fromLegacyPagination.maxPages ?? DEFAULT_MAX_PAGES,
    maxBatches: planning.maxBatches ?? fromLegacyBatching.maxBatches ?? DEFAULT_MAX_BATCHES,
    batchSize: planning.batchSize ?? fromLegacyBatching.size ?? DEFAULT_BATCH_SIZE,
    windowDays: planning.windowDays ?? fromLegacyBatching.windowDays ?? 7,
    stopOnEmpty: planning.stopOnEmpty !== false,
    stopOnDuplicateCursor: planning.stopOnDuplicateCursor !== false,
    stopOnDuplicateLastId: planning.stopOnDuplicateLastId !== false,
    stopOnDuplicatePayload: planning.stopOnDuplicatePayload !== false,
    currentPageFirst: planning.currentPageFirst === true || mode === 'current_page_first',
    itemsPath: planning.itemsPath || endpoint.responseShape?.itemsPath || null,
    report: planning.report || null,
  };
}

function detectArrayParamName(endpoint = {}) {
  return endpoint.batching?.arrayParam || null;
}

function detectArrayParam(params = {}, planning = {}) {
  if (planning.arrayParam && Array.isArray(getPathValue(params, planning.arrayParam))) return planning.arrayParam;
  for (const key of ['ids', 'product_ids', 'productIds', 'offer_id', 'offer_ids', 'offerIds', 'posting_number', 'posting_numbers', 'postingNumbers']) {
    if (Array.isArray(getPathValue(params, key))) return key;
  }
  return planning.arrayParam || 'ids';
}

function buildBatch(request, endpoint, planning, params, index = 0, total = 1, extra = {}) {
  const payloadHash = createStableHash(params, { length: 32 });
  return {
    index,
    total,
    mode: extra.mode || planning.mode || 'single',
    domain: request.domain,
    shopId: request.shopId,
    endpointKey: request.endpointKey,
    action: request.action,
    priority: request.priority,
    params,
    payloadHash,
    batchKey: `${request.endpointKey}:${extra.mode || planning.mode || 'single'}:${index + 1}/${total}:${payloadHash}`,
    page: extra.page ?? null,
    cursor: extra.cursor ?? null,
    lastId: extra.lastId ?? null,
    dateWindow: extra.dateWindow ?? null,
    isCurrentPage: Boolean(extra.isCurrentPage),
    endpoint,
  };
}

function limitBatches(batches, planning) {
  const maxBatches = normalizePositiveInteger(planning.maxBatches, DEFAULT_MAX_BATCHES);
  return batches.slice(0, maxBatches).map((batch, index, list) => ({ ...batch, index, total: list.length }));
}

function planSingle(request, endpoint, planning) {
  const params = cloneParams(request.params || {});
  return [buildBatch(request, endpoint, planning, params, 0, 1, { mode: 'single' })];
}

function planIds(request, endpoint, planning) {
  const params = cloneParams(request.params || {});
  const arrayParam = detectArrayParam(params, planning);
  const sourceArray = getPathValue(params, arrayParam);
  if (!Array.isArray(sourceArray)) {
    throw createPlannerError('BATCH_IDS_ARRAY_REQUIRED', `Planning mode ids requires an array param: ${arrayParam}.`, { arrayParam });
  }
  const ids = uniqueArray(sourceArray);
  const batchSize = normalizePositiveInteger(planning.batchSize, DEFAULT_BATCH_SIZE);
  const chunks = chunkArray(ids, batchSize);
  const batches = chunks.map((chunk, index) => buildBatch(
    request,
    endpoint,
    planning,
    setPathValue(cloneParams(params), arrayParam, chunk),
    index,
    chunks.length,
    { mode: 'ids' },
  ));
  return limitBatches(batches, planning);
}

function planOffset(request, endpoint, planning, { currentPageOnly = false } = {}) {
  const params = cloneParams(request.params || {});
  const limit = clampLimit(getPathValue(params, planning.limitParam), planning);
  const maxPages = currentPageOnly ? 1 : normalizePositiveInteger(params.maxPages ?? planning.maxPages, DEFAULT_MAX_PAGES);
  const offsetCandidate = getPathValue(params, planning.offsetParam);
  const startOffset = Number.isFinite(Number(offsetCandidate)) ? Number(offsetCandidate) : 0;
  if (startOffset < 0) {
    throw createPlannerError('BATCH_OFFSET_INVALID', 'Offset cannot be negative.', { offset: startOffset });
  }
  const batches = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const offset = startOffset + (page - 1) * limit;
    batches.push(buildBatch(
      request,
      endpoint,
      planning,
      setPathValue(setPathValue(cloneParams(params), planning.limitParam, limit), planning.offsetParam, offset),
      batches.length,
      maxPages,
      { mode: 'offset', page },
    ));
  }
  return limitBatches(batches, planning);
}

function planCursorInitial(request, endpoint, planning) {
  const params = cloneParams(request.params || {});
  const limit = clampLimit(getPathValue(params, planning.limitParam), planning);
  const cursor = getPathValue(params, planning.cursorParam) ?? null;
  return [buildBatch(request, endpoint, planning, setPathValue(cloneParams(params), planning.limitParam, limit), 0, 1, { mode: 'cursor', page: 1, cursor })];
}

function planLastIdInitial(request, endpoint, planning) {
  const params = cloneParams(request.params || {});
  const limit = clampLimit(getPathValue(params, planning.limitParam), planning);
  const lastId = getPathValue(params, planning.lastIdParam) ?? null;
  return [buildBatch(request, endpoint, planning, setPathValue(cloneParams(params), planning.limitParam, limit), 0, 1, { mode: 'last_id', page: 1, lastId })];
}

function parseDate(value, name) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) {
    throw createPlannerError('BATCH_DATE_INVALID', `Invalid date parameter: ${name}.`, { name, value });
  }
  return timestamp;
}

function planDateWindow(request, endpoint, planning) {
  const params = cloneParams(request.params || {});
  const fromMs = parseDate(getPathValue(params, planning.dateFromParam), planning.dateFromParam);
  const toMs = parseDate(getPathValue(params, planning.dateToParam), planning.dateToParam);
  if (fromMs > toMs) {
    throw createPlannerError('BATCH_DATE_RANGE_INVALID', 'dateFrom cannot be later than dateTo.', { fromMs, toMs });
  }
  const windowMs = normalizePositiveInteger(planning.windowDays, 7) * ONE_DAY_MS;
  const batches = [];
  for (let cursorMs = fromMs; cursorMs <= toMs; cursorMs += windowMs) {
    const endMs = Math.min(toMs, cursorMs + windowMs - 1);
    const dateWindow = {
      from: new Date(cursorMs).toISOString(),
      to: new Date(endMs).toISOString(),
    };
    batches.push(buildBatch(
      request,
      endpoint,
      planning,
      setPathValue(setPathValue(cloneParams(params), planning.dateFromParam, dateWindow.from), planning.dateToParam, dateWindow.to),
      batches.length,
      0,
      { mode: 'date_window', page: batches.length + 1, dateWindow },
    ));
  }
  return limitBatches(batches, planning);
}

function planReportJob(request, endpoint, planning) {
  const params = cloneParams(request.params || {});
  return [buildBatch(request, endpoint, planning, params, 0, 1, { mode: 'report_job', page: 1 })];
}

function planCurrentPageFirst(request, endpoint, planning) {
  const params = cloneParams(request.params || {});
  const current = buildBatch(request, endpoint, planning, params, 0, 1, {
    mode: 'current_page_first',
    page: normalizePositiveInteger(params.page, 1),
    isCurrentPage: true,
  });

  if ((planning.nextMode || planning.fallbackMode || 'offset') === 'offset') {
    const background = planOffset(request, endpoint, { ...planning, mode: 'offset' })
      .filter((batch) => batch.payloadHash !== current.payloadHash)
      .map((batch) => ({ ...batch, mode: 'current_page_first', isCurrentPage: false }));
    return limitBatches([current, ...background], planning);
  }

  return [current];
}

export function createPaginationState() {
  return {
    seenCursors: new Set(),
    seenLastIds: new Set(),
    seenPayloadHashes: new Set(),
    emptyPages: 0,
  };
}

export function planNextPageBatch(request = {}, endpoint = {}, previousBatch = {}, response = {}, state = createPaginationState()) {
  const planning = normalizePlanning(endpoint);
  const rows = getRowsFromResponse(response, planning);
  if (planning.stopOnEmpty && rows.length === 0) {
    state.emptyPages += 1;
    return { done: true, reason: 'empty_page', state };
  }

  const maxPages = normalizePositiveInteger(planning.maxPages, DEFAULT_MAX_PAGES);
  const nextPage = (previousBatch.page || 1) + 1;
  if (nextPage > maxPages) {
    return { done: true, reason: 'max_pages_reached', state };
  }

  const params = cloneParams(previousBatch.params || request.params || {});
  let extra = { page: nextPage, mode: previousBatch.mode || planning.mode };

  if ((previousBatch.mode || planning.mode) === 'cursor') {
    const cursor = getPathValue(response.data ?? response, planning.nextCursorPath);
    if (!cursor) return { done: true, reason: 'missing_cursor', state };
    if (planning.stopOnDuplicateCursor && state.seenCursors.has(cursor)) {
      return { done: true, reason: 'duplicate_cursor', state };
    }
    state.seenCursors.add(cursor);
    setPathValue(params, planning.cursorParam, cursor);
    extra = { ...extra, cursor };
  } else if ((previousBatch.mode || planning.mode) === 'last_id') {
    const lastId = getPathValue(response.data ?? response, planning.nextLastIdPath);
    if (!lastId) return { done: true, reason: 'missing_last_id', state };
    if (planning.stopOnDuplicateLastId && state.seenLastIds.has(lastId)) {
      return { done: true, reason: 'duplicate_last_id', state };
    }
    state.seenLastIds.add(lastId);
    setPathValue(params, planning.lastIdParam, lastId);
    extra = { ...extra, lastId };
  } else if ((previousBatch.mode || planning.mode) === 'offset') {
    const limit = clampLimit(getPathValue(params, planning.limitParam), planning);
    params[planning.offsetParam] = (Number(params[planning.offsetParam]) || 0) + limit;
    extra = { ...extra, page: nextPage };
  } else {
    return { done: true, reason: 'mode_has_no_next_page', state };
  }

  const batch = buildBatch(request, endpoint, planning, params, nextPage - 1, maxPages, extra);
  if (planning.stopOnDuplicatePayload && state.seenPayloadHashes.has(batch.payloadHash)) {
    return { done: true, reason: 'duplicate_payload_hash', state };
  }
  state.seenPayloadHashes.add(batch.payloadHash);
  return { done: false, batch, state };
}

export function planRequestBatches(request = {}, endpoint = {}) {
  const planning = normalizePlanning(endpoint);
  switch (planning.mode) {
    case 'single':
      return planSingle(request, endpoint, planning);
    case 'ids':
      return planIds(request, endpoint, planning);
    case 'offset':
      return planOffset(request, endpoint, planning);
    case 'cursor':
      return planCursorInitial(request, endpoint, planning);
    case 'last_id':
      return planLastIdInitial(request, endpoint, planning);
    case 'date_window':
      return planDateWindow(request, endpoint, planning);
    case 'report_job':
      return planReportJob(request, endpoint, planning);
    case 'current_page_first':
      return planCurrentPageFirst(request, endpoint, planning);
    default:
      throw createPlannerError('BATCH_PLANNING_MODE_UNSUPPORTED', `Unsupported planning mode: ${planning.mode}.`, { mode: planning.mode });
  }
}

export function createBatchPlanner(defaults = {}) {
  return {
    plan(request = {}, endpoint = {}) {
      return planRequestBatches(
        {
          ...request,
          maxBatches: request.maxBatches ?? defaults.maxBatches,
          batchSize: request.batchSize ?? defaults.batchSize,
        },
        endpoint,
      );
    },
    nextPage(request = {}, endpoint = {}, previousBatch = {}, response = {}, state) {
      return planNextPageBatch(request, endpoint, previousBatch, response, state);
    },
    createPaginationState,
  };
}
