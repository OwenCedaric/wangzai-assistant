(() => {
  'use strict';

  const GLOBAL_KEY = '__WANGZAI_OZON_ANALYTICS_OBSERVER__';
  const VERSION = '2.6.16';
  const MAX_ENTRIES = 400;
  const MAX_INLINE_ENTRY_CHARS = 1024 * 1024;
  const MAX_TOTAL_CHARS = 128 * 1024 * 1024;
  const MAX_PAYLOAD_CHUNK_CHARS = 512 * 1024;
  const MAX_LIMIT_EXPANSION_RECORDS = 20_000;
  // Ozon rejects oversized offset pages on several analytics endpoints. Keep
  // the optimisation conservative: the observed request remains the source
  // of truth and an automatic expansion never raises its page size above 50.
  const MAX_OFFSET_PAGE_SIZE = 50;
  const PAGINATION_FETCH_TIMEOUT_MS = 20_000;
  const OZON_ANALYTICS_HOSTS = new Set(['seller.ozon.ru', 'api.seller.ozon.ru', 'www.ozon.ru', 'ozon.ru']);
  const SAFE_REPLAY_HEADERS = new Set([
    'accept',
    'content-type',
    'x-o3-app-name',
    'x-o3-company-id',
    'x-o3-language',
    'x-o3-page-type',
  ]);
  const SENSITIVE_KEY = /(?:auth|cookie|credential|email|password|phone|secret|signature|token|address)/iu;
  const WRITE_PATH = /(?:activate|archive|bind|cancel|checkout|confirm|create|delete|edit|import|pay|publish|remove|save|send|submit|sync|unbind|update|upload)/iu;
  const REPLAY_READ_PATH = /(?:analytics|comparison|conversion|graph|market|missing_items|report|search|seller-analytics|statistic|top-entity|traffic|trend|what_to_sell)/iu;
  const EXACT_READ_PATHS = Object.freeze([
    /^\/api\/site\/seller-analytics\/what_to_sell\/data\/v3(?:[/?#]|$)/iu,
    /^\/api\/site\/seller-analytics\/what_to_sell\/get_categories(?:[/?#]|$)/iu,
    /^\/api\/site\/seller-analytics\/what_to_sell\/get_platform_data(?:[/?#]|$)/iu,
    /^\/api\/site\/seller-analytics\/charts(?:[/?#]|$)/iu,
    /^\/api\/site\/exar-api\/v2\/seller\/comparison\/widget(?:[/?#]|$)/iu,
    /^\/api\/site\/exar-api\/v2\/seller\/top-entity-ids(?:[/?#]|$)/iu,
    /^\/api\/site\/exar-api\/v2\/get_seller_tree(?:[/?#]|$)/iu,
    /^\/api\/site\/exar-api\/v2\/gb\/price_segmentation(?:[/?#]|$)/iu,
    /^\/api\/site\/exar-api\/v2\/gb\/seller\/metrics(?:[/?#]|$)/iu,
    /^\/api\/site\/exa-products-api\/missing_items(?:[/?#]|$)/iu,
    /^\/api\/site\/exa-products-api\/(?:current_date|price_segmentation|search_items|seller_tree|user_quota)(?:[/?#]|$)/iu,
    /^\/api\/site\/searchstat\/Stats\/queries\/groups(?:[/?#]|$)/u,
    /^\/api\/site\/searchteam\/Stats\/queries\/search\/v2(?:[/?#]|$)/u,
  ]);
  const LEGACY_PLUGIN_PATHS = Object.freeze([
    /\/premium\/status(?:[/?#]|$)/iu,
    /get-seller-premium-status(?:[/?#]|$)/iu,
    /\/analytics\/graphs(?:[/?#]|$)/iu,
    /\/graph\/data(?:[/?#]|$)/iu,
    /\/statistics\/data(?:[/?#]|$)/iu,
  ]);

  // Existing queues and hooks belong to the live document. A different
  // installed version requires a restart, not redefining a non-configurable
  // global or silently discarding the old document's captured responses.
  if (window[GLOBAL_KEY]) return;

  const entries = [];
  const fullPayloads = new Map();
  const recipes = new Map();
  const endpointCatalog = new Map();
  const runtimeErrors = [];
  let sequence = 0;
  let totalSerializedBytes = 0;
  let evictedEntries = 0;
  let paginationGeneration = 0;
  const paginationDelayWaiters = new Set();
  let forwardedFrameCaptures = 0;
  let receivedFrameCaptures = 0;
  let frameScopeFailures = 0;

  function topFrameObserver() {
    try {
      const top = window.top;
      if (!top || top === window || top.location.origin !== window.location.origin) return null;
      const observer = top[GLOBAL_KEY];
      return observer?.version === VERSION && typeof observer.receiveFrameRecord === 'function' ? observer : null;
    } catch { return null; }
  }

  function isSameOriginDescendant(candidate) {
    try {
      const queue = Array.from(window.frames || []);
      for (let visited = 0; queue.length && visited < 128; visited++) {
        const frame = queue.shift();
        try {
          if (frame.location.origin !== window.location.origin) continue;
          if (frame === candidate) return true;
          queue.push(...Array.from(frame.frames || []));
        } catch { /* a cross-origin/closed frame is not an accepted sender */ }
      }
    } catch { /* unavailable frame tree */ }
    return false;
  }

  function receiveFrameRecord(sourceWindow, input = {}) {
    if (!isSameOriginDescendant(sourceWindow)) return null;
    const original = input.recipe || {};
    const method = String(original.method || 'GET').toUpperCase();
    const descriptor = describeEndpoint(original.absoluteUrl, method);
    if (!descriptor) return null;
    const headers = sanitizedHeaders(original.headers);
    const parentCompany = currentCompanyId();
    if (headers['x-o3-company-id'] && parentCompany !== headers['x-o3-company-id']) {
      frameScopeFailures++;
      recordRuntimeError('frame-owner', new Error(parentCompany ? 'OZON_DATA_FRAME_COMPANY_MISMATCH' : 'OZON_DATA_FRAME_COMPANY_UNVERIFIED'));
      return null;
    }
    const kind = ['json', 'form', 'text', 'none'].includes(original.body?.kind) ? original.body.kind : 'none';
    const value = sanitize(original.body?.value ?? null);
    const body = { kind, value, text: kind === 'json' ? JSON.stringify(value) : kind === 'form' ? new URLSearchParams(value).toString() : '' };
    const recipe = { ...descriptor, classification: endpointClass(descriptor.endpoint, sourceWindow.location.pathname || ''),
      method, headers, body, query: sanitizedQuery(descriptor.absoluteUrl) };
    // Network responses are JSON. Materialize them in this realm so the
    // parent queue cannot retain an entire detached child's JS context.
    const payload = JSON.parse(JSON.stringify(input.payload));
    const captured = record({ ...input, recipe, payload });
    if (captured) {
      receivedFrameCaptures++;
      captured.sourceFrameUrl = sourceWindow.location.origin + (sourceWindow.location.pathname || '/');
    }
    return captured;
  }

  function paginationCancelled(generation) {
    return Number(generation) !== paginationGeneration;
  }

  function paginationCancellationError() {
    const error = new Error('OZON_DATA_PAGINATION_CANCELLED');
    error.ozonStage = 'cancelled';
    return error;
  }

  function assertPaginationActive(generation) {
    if (paginationCancelled(generation)) throw paginationCancellationError();
  }

  function waitForPaginationDelay(delayMs, generation) {
    if (paginationCancelled(generation)) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      let timer = 0;
      const finish = (completed) => {
        if (settled) return;
        settled = true;
        if (timer && completed === false && typeof window.clearTimeout === 'function') {
          window.clearTimeout(timer);
        }
        paginationDelayWaiters.delete(cancel);
        resolve(completed && !paginationCancelled(generation));
      };
      const cancel = () => finish(false);
      paginationDelayWaiters.add(cancel);
      timer = window.setTimeout(() => finish(true), Math.max(0, Number(delayMs) || 0));
    });
  }

  function cancelPagination() {
    paginationGeneration += 1;
    for (const cancel of [...paginationDelayWaiters]) cancel();
    return {
      ready: true,
      version: VERSION,
      cancelled: true,
      generation: paginationGeneration,
    };
  }

  function errorCode(value) {
    return String(value?.message || value || 'unknown').replace(/[^A-Z0-9_-]/giu, '_').slice(0, 120);
  }

  function recordRuntimeError(stage, error) {
    runtimeErrors.push({ stage, code: errorCode(error), occurredAt: new Date().toISOString() });
    while (runtimeErrors.length > 10) runtimeErrors.shift();
  }

  function endpointClass(endpoint, pagePath = window.location?.pathname || '') {
    if (/(?:premium|subscription)/iu.test(endpoint)) return 'subscription-status';
    if (/missing_items/iu.test(endpoint)) return 'missing-items';
    if (/charts\/v3\/(?:table\/by_sku|recommendation)(?:[/?#]|$)/iu.test(endpoint)) return 'products';
    if (/what_to_sell\/get_categories/iu.test(endpoint)) return 'categories';
    if (/(?:get_seller_tree|seller_tree)/iu.test(endpoint)) return 'categories';
    if (/price_segmentation/iu.test(endpoint)) return 'price-segments';
    if (/seller\/metrics/iu.test(endpoint)) return 'comparison';
    // “分析 → Ozon 上的商品” uses the same what_to_sell API family as
    // the opportunity pages. Keep it as a separate dataset so the fields
    // from that table are not flattened into the old market-products view.
    if (/(?:what_to_sell|exa-products-api)/iu.test(endpoint)
      && /\/what-to-sell\/ozon-bestsellers(?:[/?#]|$)/iu.test(pagePath)) return 'product-performance';
    if (/charts/iu.test(endpoint)) return 'trends';
    if (/what_to_sell/iu.test(endpoint)) return 'market-products';
    if (/(?:search|keyword|query)/iu.test(endpoint)) return 'keywords';
    if (/category/iu.test(endpoint)) return 'categories';
    if (/brand/iu.test(endpoint)) return 'brands';
    if (/(?:traffic|conversion)/iu.test(endpoint)) return 'traffic-conversion';
    if (/(?:comparison|top-entity)/iu.test(endpoint)) return 'comparison';
    if (/(?:trend|graph|statistic)/iu.test(endpoint)) return 'trends';
    if (/(?:inventory|stock)/iu.test(endpoint)) return 'inventory';
    if (/product/iu.test(endpoint)) return 'products';
    if (/report/iu.test(endpoint)) return 'reports';
    return 'discovered-api';
  }

  function describeEndpoint(input, method = 'GET') {
    try {
      const url = new URL(String(input || ''), window.location.href);
      if (url.protocol !== 'https:' || !OZON_ANALYTICS_HOSTS.has(url.hostname)) return null;
      const legacySurface = LEGACY_PLUGIN_PATHS.some((pattern) => pattern.test(url.pathname));
      if (!url.pathname.startsWith('/api/site/') && !legacySurface) return null;
      if (/(?:\/auth|\/login|\/security|\/session|\/user\/)/iu.test(url.pathname)) return null;
      const known = EXACT_READ_PATHS.some((pattern) => pattern.test(url.pathname));
      const replaySafe = ['GET', 'POST'].includes(String(method || '').toUpperCase())
        && !WRITE_PATH.test(url.pathname)
        && (known || REPLAY_READ_PATH.test(url.pathname));
      return {
        absoluteUrl: url.toString(),
        origin: url.origin,
        endpoint: url.pathname,
        classification: endpointClass(url.pathname, window.location?.pathname || ''),
        known,
        legacySurface,
        replaySafe,
      };
    } catch {
      return null;
    }
  }

  function sanitize(value, key = '', depth = 0) {
    if (SENSITIVE_KEY.test(String(key || ''))) return '[redacted]';
    if (value === null || value === undefined) return value ?? null;
    if (depth > 6) return '[depth-limited]';
    if (typeof value === 'string') return value.slice(0, 1000);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitize(item, key, depth + 1));
    if (typeof value === 'object') {
      const result = {};
      for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
        result[childKey] = sanitize(childValue, childKey, depth + 1);
      }
      return result;
    }
    return String(value).slice(0, 500);
  }

  function sanitizedQuery(urlText) {
    try {
      const result = {};
      const url = new URL(urlText, window.location.href);
      for (const [key, value] of [...url.searchParams.entries()].slice(0, 80)) {
        result[key] = sanitize(value, key);
      }
      return result;
    } catch {
      return {};
    }
  }

  function sanitizedHeaders(input) {
    const result = {};
    try {
      const headers = new Headers(input || {});
      for (const [key, value] of headers.entries()) {
        if (SAFE_REPLAY_HEADERS.has(key.toLowerCase())) result[key.toLowerCase()] = value.slice(0, 500);
      }
    } catch {
      return result;
    }
    return result;
  }

  async function requestBody(input, init, method) {
    if (['GET', 'HEAD'].includes(method)) return { kind: 'none', value: null, text: '' };
    try {
      let source = init?.body;
      if (source === undefined && input instanceof Request) source = await input.clone().text();
      if (source === undefined || source === null || source === '') return { kind: 'none', value: null, text: '' };
      if (source instanceof URLSearchParams) {
        const value = sanitize(Object.fromEntries(source.entries()));
        return { kind: 'form', value, text: new URLSearchParams(value).toString() };
      }
      if (typeof source === 'string') {
        try {
          const value = sanitize(JSON.parse(source));
          return { kind: 'json', value, text: JSON.stringify(value) };
        } catch {
          return { kind: 'text', value: '[non-json-body]', text: '' };
        }
      }
      if (typeof source === 'object') {
        const value = sanitize(source);
        return { kind: 'json', value, text: JSON.stringify(value) };
      }
    } catch (error) {
      recordRuntimeError('request-body', error);
    }
    return { kind: 'none', value: null, text: '' };
  }

  async function fetchRecipe(input, init = {}) {
    const request = input instanceof Request ? input : null;
    const url = request?.url || String(input || '');
    const method = String(init.method || request?.method || 'GET').toUpperCase();
    const descriptor = describeEndpoint(url, method);
    if (!descriptor) return null;
    const headers = {
      ...sanitizedHeaders(request?.headers),
      ...sanitizedHeaders(init.headers),
    };
    const body = await requestBody(input, init, method);
    return {
      ...descriptor,
      method,
      headers,
      body,
      query: sanitizedQuery(url),
    };
  }

  const PRIMARY_RECORD_ARRAY_KEYS = new Set([
    'items',
    'rows',
    'records',
    'results',
    'products',
    'queries',
    'groups',
    'categories',
    'brands',
    'segments',
    'series',
  ]);
  const NESTED_DETAIL_ARRAY_KEYS = new Set([
    'attributes',
    'characteristics',
    'images',
    'photos',
    'pictures',
    'variants',
    'sellers',
    'badges',
    'tags',
  ]);
  const BUSINESS_RECORD_KEY = /(?:sku|product|item|offer|title|name|keyword|query|category|brand|seller|metric|gmv|revenue|sale|order|price|stock|view|date)/iu;

  function recordArrayScore(records, path) {
    const pathParts = String(path || '').split('.');
    const finalPart = String(pathParts.at(-1) || '').replace(/\[\d+\]$/u, '').toLowerCase();
    const primaryBonus = PRIMARY_RECORD_ARRAY_KEYS.has(finalPart) ? 100_000 : 0;
    const detailPenalty = NESTED_DETAIL_ARRAY_KEYS.has(finalPart) ? 100_000 : 0;
    const samples = records.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).slice(0, 5);
    const schemaScore = samples.reduce((total, item) => {
      const keys = Object.keys(item);
      const businessKeys = keys.filter((key) => BUSINESS_RECORD_KEY.test(key)).length;
      const detailOnly = keys.length > 0 && keys.every((key) => /^(?:id|key|name|title|type|unit|value)$/iu.test(key));
      return total + businessKeys * 2_000 - (detailOnly ? 750 : 0);
    }, 0);
    return primaryBonus - detailPenalty + schemaScore + Math.min(records.length, 20_000) - pathParts.length * 10;
  }

  function largestRecordArray(value, path = '$', depth = 0, best = { path: '', records: [], score: Number.NEGATIVE_INFINITY }) {
    if (depth > 7 || value === null || value === undefined) return best;
    if (Array.isArray(value)) {
      if (value.length > 0 && value.some((item) => item && typeof item === 'object')) {
        const score = recordArrayScore(value, path);
        if (score > best.score || score === best.score && value.length > best.records.length) {
          best = { path, records: value, score };
        }
      }
      for (let index = 0; index < Math.min(value.length, 5); index += 1) {
        best = largestRecordArray(value[index], `${path}[${index}]`, depth + 1, best);
      }
      return best;
    }
    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value).slice(0, 100)) {
        best = largestRecordArray(child, `${path}.${key}`, depth + 1, best);
      }
    }
    return best;
  }

  function responseQuality(status, payload) {
    const preview = (() => {
      try { return JSON.stringify(payload).slice(0, 20000); } catch { return ''; }
    })();
    if ([401, 403].includes(Number(status)) || /(?:access denied|permission denied|subscribe to|subscription required|subscription_required|upgrade plan)/iu.test(preview)) {
      return 'access-denied';
    }
    if (Number(status) < 200 || Number(status) >= 300) return 'http-error';
    const records = largestRecordArray(payload);
    if (records.records.length > 0) return 'confirmed-data';
    if (payload && typeof payload === 'object' && Object.keys(payload).length > 0) return 'confirmed-object';
    return 'empty';
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function payloadShape(value, depth = 0) {
    if (depth > 4) return '*';
    if (Array.isArray(value)) return `[${value.length}:${value.length ? payloadShape(value[0], depth + 1) : ''}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().slice(0, 60).map((key) => `${key}:${payloadShape(value[key], depth + 1)}`).join(',')}}`;
    }
    return typeof value;
  }

  function safePayload(value) {
    try {
      const serialized = JSON.stringify(value);
      if (serialized.length <= MAX_INLINE_ENTRY_CHARS) {
        return { value, serialized, bytes: serialized.length, truncated: false };
      }
      const records = largestRecordArray(value);
      return {
        value: {
          truncated: true,
          serializedBytes: serialized.length,
          recordPath: records.path,
          recordCount: records.records.length,
          recordPreview: sanitize(records.records.slice(0, 25)),
        },
        serialized,
        bytes: serialized.length,
        truncated: true,
      };
    } catch {
      return { value: { unreadable: true }, serialized: '', bytes: 0, truncated: true };
    }
  }

  function updateCatalog(entry) {
    const key = `${entry.method} ${entry.endpoint}`;
    const current = endpointCatalog.get(key) || {
      method: entry.method,
      endpoint: entry.endpoint,
      classification: entry.classification,
      known: entry.known,
      replaySafe: entry.replaySafe,
      captures: 0,
      confirmedData: 0,
      denied: 0,
      maxRecords: 0,
      lastStatus: 0,
      lastCapturedAt: '',
      shapeHashes: [],
    };
    current.captures += 1;
    current.confirmedData += entry.quality === 'confirmed-data' ? 1 : 0;
    current.denied += entry.quality === 'access-denied' ? 1 : 0;
    current.maxRecords = Math.max(current.maxRecords, entry.recordCount);
    current.lastStatus = entry.status;
    current.lastCapturedAt = entry.capturedAt;
    if (!current.shapeHashes.includes(entry.shapeHash)) current.shapeHashes.push(entry.shapeHash);
    current.shapeHashes = current.shapeHashes.slice(-8);
    endpointCatalog.set(key, current);
  }

  function removeOldest() {
    const removed = entries.shift();
    if (!removed) return;
    totalSerializedBytes = Math.max(0, totalSerializedBytes - Number(removed.serializedBytes || 0));
    fullPayloads.delete(removed.sequence);
    recipes.delete(removed.sequence);
    evictedEntries += 1;
  }

  function record({ recipe, status, transport, payload, replayedFrom = 0, pageIndex = 0 }) {
    if (!recipe) return null;
    const top = topFrameObserver();
    if (top) {
      const forwarded = top.receiveFrameRecord(window, { recipe, status, transport, payload, replayedFrom, pageIndex });
      if (forwarded) { forwardedFrameCaptures++; return forwarded; }
    }
    const stored = safePayload(payload);
    const records = largestRecordArray(payload);
    sequence += 1;
    const entry = {
      sequence,
      endpoint: recipe.endpoint,
      origin: recipe.origin,
      method: recipe.method,
      status: Number(status) || 0,
      transport,
      classification: recipe.classification,
      known: recipe.known,
      legacySurface: recipe.legacySurface,
      provenance: 'ozon-server-response',
      replaySafe: recipe.replaySafe,
      capturedAt: new Date().toISOString(),
      quality: responseQuality(status, payload),
      recordPath: records.path,
      recordCount: records.records.length,
      shapeHash: hashText(payloadShape(payload)),
      payloadHash: hashText((() => { try { return JSON.stringify(payload); } catch { return ''; } })()),
      serializedBytes: stored.bytes,
      truncated: stored.truncated,
      payloadAvailable: stored.serialized.length > 0,
      payloadComplete: !stored.truncated,
      request: {
        query: recipe.query,
        body: recipe.body.value,
        pagination: detectPagination(recipe),
      },
      replayedFrom: Number(replayedFrom) || 0,
      pageIndex: Number(pageIndex) || 0,
      payload: stored.value,
    };
    entries.push(entry);
    if (stored.serialized) fullPayloads.set(sequence, stored.serialized);
    totalSerializedBytes += stored.bytes;
    if (recipe.replaySafe) recipes.set(sequence, recipe);
    updateCatalog(entry);
    while (entries.length > MAX_ENTRIES || totalSerializedBytes > MAX_TOTAL_CHARS) removeOldest();
    return entry;
  }

  function publicEntry(entry) {
    return { ...entry, serializedBytes: undefined };
  }

  function read(afterSequence = 0, limit = 20, drain = false) {
    const safeAfter = Math.max(0, Number(afterSequence) || 0);
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    const selected = entries.filter((entry) => entry.sequence > safeAfter).slice(0, safeLimit);
    if (drain && selected.length > 0) {
      const cutoff = selected[selected.length - 1].sequence;
      while (entries[0]?.sequence <= cutoff && entries[0]?.payloadComplete === true) removeOldest();
    }
    return {
      ready: true,
      version: VERSION,
      queueLength: entries.length,
      lastSequence: sequence,
      evictedEntries,
      drainDeferred: drain && selected.some((entry) => entry.payloadComplete !== true),
      entries: selected.map(publicEntry),
    };
  }

  function payload(sourceSequence, offset = 0, limit = 256 * 1024) {
    const safeSequence = Math.max(0, Number(sourceSequence) || 0);
    const serialized = fullPayloads.get(safeSequence);
    if (typeof serialized !== 'string') throw new Error('OZON_DATA_PAYLOAD_NOT_FOUND');
    const safeOffset = Math.max(0, Math.min(serialized.length, Number(offset) || 0));
    const safeLimit = Math.max(1, Math.min(MAX_PAYLOAD_CHUNK_CHARS, Number(limit) || 256 * 1024));
    const chunk = serialized.slice(safeOffset, safeOffset + safeLimit);
    const nextOffset = safeOffset + chunk.length;
    return {
      ready: true,
      version: VERSION,
      sourceSequence: safeSequence,
      offset: safeOffset,
      nextOffset,
      totalChars: serialized.length,
      complete: nextOffset >= serialized.length,
      payloadHash: hashText(serialized),
      encoding: 'json',
      chunk,
    };
  }

  function catalog() {
    const endpoints = [...endpointCatalog.values()].sort((left, right) => right.captures - left.captures);
    return {
      ready: true,
      version: VERSION,
      endpointCount: endpoints.length,
      discoveredEndpointCount: endpoints.filter((item) => !item.known).length,
      endpoints,
    };
  }

  function pick(source, keys) {
    for (const key of keys) {
      const value = source?.[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  }

  function canonicalRecord(row, dataset = '') {
    const nested = {
      ...(row?.product && typeof row.product === 'object' ? row.product : {}),
      ...(row?.item && typeof row.item === 'object' ? row.item : {}),
      ...(row?.productInfo && typeof row.productInfo === 'object' ? row.productInfo : {}),
      ...(row?.itemInfo && typeof row.itemInfo === 'object' ? row.itemInfo : {}),
      ...(row?.skuInfo && typeof row.skuInfo === 'object' ? row.skuInfo : {}),
    };
    const source = { ...nested, ...(row && typeof row === 'object' ? row : {}) };
    const metrics = source.metrics && typeof source.metrics === 'object' ? source.metrics : {};
    const metricRevenue = pick(metrics, ['revenue', 'revenueV2']);
    const isMissingItems = dataset === 'missing-items';
    return {
      id: pick(source, ['sku', 'skuId', 'sku_id', 'productId', 'product_id', 'itemId', 'item_id', 'offerId', 'offer_id', 'id', 'date']),
      title: pick(source, ['title', 'name', 'productName', 'product_name', 'itemName', 'keyword', 'query']),
      category: pick(source, ['category', 'categoryName', 'category_name', 'category3Name', 'category2Name', 'category1Name', 'categoryId', 'category_id']),
      category1: pick(source, ['category1', 'category1Name', 'category_1', 'category_1_name']),
      category2: pick(source, ['category2', 'category2Name', 'category_2', 'category_2_name']),
      category3: pick(source, ['category3', 'category3Name', 'category_3', 'category_3_name']),
      brand: pick(source, ['brand', 'brandName', 'brand_name']),
      seller: pick(source, ['seller', 'sellerName', 'seller_name']),
      article: pick(source, ['article', 'vendorCode', 'vendor_code']),
      imageUrl: pick(source, ['imageUrl', 'image', 'photo', 'photoUrl', 'picture']),
      link: pick(source, ['link', 'url', 'productUrl']),
      date: pick(source, ['date', 'day', 'period']),
      price: pick(source, ['price', 'currentPrice', 'current_price', 'averagePrice', 'average_price', 'avgPrice']),
      cardPrice: pick(source, ['cardPrice', 'card_price', 'ozonCardPrice', 'ozon_card_price', 'priceWithCard', 'price_with_card']),
      discount: pick(source, ['discount', 'discountPercent', 'discount_percent', 'salePercent', 'sale_percent']),
      rating: pick(source, ['rating', 'ratingValue', 'rating_value', 'score', 'stars']),
      reviews: pick(source, ['reviews', 'reviewCount', 'review_count', 'commentsCount', 'comments_count']),
      averagePrice: pick(source, ['averagePrice', 'average_price', 'avgPrice']),
      sales: pick(source, ['sales', 'salesCount', 'sales_count', 'orderedUnits', 'ordered_units', 'soldCount'])
        ?? (isMissingItems ? pick(source, ['totalItems']) : null)
        ?? pick(metrics, ['sales', 'salesCount', 'orderedUnits', 'ordered_units', 'soldCount']),
      orders: pick(source, ['orders', 'ord', 'orderCount'])
        ?? pick(metrics, ['orders', 'ord', 'orderCount', 'orderedUnits']),
      productCount: pick(source, isMissingItems ? ['productCount', 'itemsCount'] : ['productCount', 'totalItems', 'itemsCount']),
      revenue: pick(source, ['revenue', 'salesAmount', 'sales_amount', 'gmv', 'gmvSum', 'amount', 'orderedAmount', 'soldSum']) ?? metricRevenue,
      stock: pick(source, ['stock', 'stocks', 'availableStock', 'available_stock', 'quantity', 'lastStockFboMoscow']),
      views: pick(source, ['views', 'viewCount', 'view_count', 'itemsViews', 'traffic']),
      searches: pick(source, ['searches', 'searchCount', 'count']),
      conversion: pick(source, ['conversion', 'conversionRate', 'conversion_rate', 'searchUsersToOrdUsers']),
      growth: pick(source, ['growth', 'gmvGrowth', 'salesDynamics']),
      averageDailyRevenue: isMissingItems
        ? pick(source, ['averageDailyRevenue', 'adsDays'])
        : pick(source, ['averageDailyRevenue', 'avgGmvOnAccDays']),
      averageDailyUnits: isMissingItems
        ? pick(source, ['averageDailyUnits', 'adqDays'])
        : pick(source, ['averageDailyUnits', 'avgOrdersOnAccDays']),
      adSpendShare: pick(source, ['adSpendShare', 'ad_spend_share', 'drr']),
      promoDays: pick(source, ['promoDays', 'promo_days', 'daysInPromo']),
      promoRevenueShare: pick(source, ['promoRevenueShare', 'promo_revenue_share']),
      paidPromotionDays: pick(source, ['paidPromotionDays', 'paid_promotion_days', 'daysWithTrafarets']),
      productCardViews: pick(source, ['productCardViews', 'product_card_views', 'qtyViewPdp']),
      productCardToCartRate: pick(source, ['productCardToCartRate', 'product_card_to_cart_rate', 'convToCartPdp']),
      searchCatalogViews: pick(source, ['searchCatalogViews', 'search_catalog_views', 'sessionCountSearch']),
      searchCatalogToCartRate: pick(source, ['searchCatalogToCartRate', 'search_catalog_to_cart_rate', 'convToCartSearch']),
      impressionToOrderRate: pick(source, ['impressionToOrderRate', 'impression_to_order_rate', 'convViewToOrder']),
      fulfillmentModel: pick(source, ['fulfillmentModel', 'fulfillment_model', 'salesSchema']),
      redemptionRate: pick(source, ['redemptionRate', 'redemption_rate', 'nullableRedemptionRate']),
      listedAt: pick(source, ['listedAt', 'listed_at', 'nullableCreateDate', 'createDate', 'createdAt']),
      packageDimensions: pick(source, ['packageDimensions', 'package_dimensions', 'custom_volume']),
      packageWeight: pick(source, ['packageWeight', 'package_weight', 'custom_weight', 'weight']),
      followSellerCount: pick(source, ['followSellerCount', 'follow_seller_count', 'followCount'])
        ?? (() => {
          const followInfo = pick(source, ['followSellers', 'follow_info', 'sellers']);
          return Array.isArray(followInfo) ? followInfo.length : pick(followInfo, ['count']);
        })(),
      followMinPrice: pick(source, ['followMinPrice', 'follow_min_price']),
      followMaxPrice: pick(source, ['followMaxPrice', 'follow_max_price']),
      rfbsRate: pick(source, ['rfbsRate', 'rfbs_rate']),
      fbpRate: pick(source, ['fbpRate', 'fbp_rate']),
      categoryCommission: pick(source, ['categoryCommission', 'category_commission']),
      uniqueSellers: pick(source, ['uniqueSellers', 'uniqSellers']),
      noInteractionCount: pick(source, ['noInteractionCount', 'usersWithoutInterectionCount']),
      noInteractionShare: pick(source, ['noInteractionShare', 'usersWithoutInterectionShare']),
      zeroResultCount: pick(source, ['zeroResultCount', 'zrCount']),
      zeroResultShare: pick(source, ['zeroResultShare', 'zrShare']),
      recommendation: pick(source, ['recommendation', 'action', 'suggestion']),
      feature: pick(source, ['feature', 'features', 'productFeature', 'productFeatures', 'product_feature', 'characteristic', 'characteristics', 'badge', 'badges', 'tag', 'tags', 'label', 'labels'])
        ?? pick(metrics, ['feature', 'features', 'productFeature', 'characteristic', 'badge', 'badges', 'tag', 'tags', 'label', 'labels']),
      searchPosition: pick(source, ['searchPosition', 'search_position', 'searchResultPosition', 'search_result_position', 'positionInSearch', 'position_in_search', 'position'])
        ?? pick(metrics, ['searchPosition', 'searchResultPosition', 'positionInSearch', 'position']),
      orderAmount: pick(source, ['orderAmount', 'order_amount', 'ordersAmount', 'orders_amount', 'orderedAmount', 'ordered_amount', 'orderedSum', 'ordered_sum', 'salesAmount', 'sales_amount', 'revenue', 'gmv', 'amount', 'soldSum'])
        ?? pick(metrics, ['orderAmount', 'ordersAmount', 'orderedAmount', 'orderedSum', 'salesAmount', 'revenue', 'revenueV2', 'gmv', 'amount']),
      dynamics: pick(source, ['dynamics', 'dynamic', 'salesDynamics', 'sales_dynamics', 'revenueGrowth', 'revenue_growth', 'growth'])
        ?? pick(metrics, ['dynamics', 'dynamic', 'salesDynamics', 'revenueGrowth', 'growth']),
      orderedProducts: pick(source, ['orderedProducts', 'ordered_products', 'orderedProductCount', 'ordered_product_count', 'orderedUnits', 'ordered_units', 'itemsOrdered', 'items_ordered', 'soldCount', 'salesCount', 'sales'])
        ?? pick(metrics, ['orderedProducts', 'orderedProductCount', 'orderedUnits', 'itemsOrdered', 'soldCount', 'salesCount', 'sales']),
      averagePurchasePrice: pick(source, ['averagePurchasePrice', 'average_purchase_price', 'averagePurchaseCost', 'average_purchase_cost', 'avgPurchasePrice', 'avg_purchase_price', 'averagePrice', 'average_price', 'avgPrice'])
        ?? pick(metrics, ['averagePurchasePrice', 'averagePurchaseCost', 'avgPurchasePrice', 'averagePrice', 'avgPrice']),
      periodDays: pick(source, ['periodDays', 'period_days', 'days', 'periodLength', 'period_length'])
        ?? pick(metrics, ['periodDays', 'days', 'periodLength']),
      priceFrom: pick(source, ['priceFrom', 'price_from', 'from']),
      priceTo: pick(source, ['priceTo', 'price_to', 'to']),
      sourceFields: Object.keys(source).slice(0, 80),
      raw: clone(row),
    };
  }

  function normalize(afterSequence = 0, limit = 10) {
    const selected = entries
      .filter((entry) => entry.sequence > Math.max(0, Number(afterSequence) || 0))
      .slice(0, Math.max(1, Math.min(20, Number(limit) || 10)));
    return {
      ready: true,
      version: VERSION,
      datasets: selected.map((entry) => {
        const serialized = fullPayloads.get(entry.sequence) || '';
        const fullPayload = (() => {
          try { return serialized ? JSON.parse(serialized) : entry.payload; } catch { return entry.payload; }
        })();
        const records = largestRecordArray(fullPayload);
        return {
          sequence: entry.sequence,
          dataset: entry.classification,
          source: 'ozon-server-response',
          ...(entry.sourceFrameUrl ? { sourceFrameUrl: entry.sourceFrameUrl } : {}),
          endpoint: entry.endpoint,
          origin: entry.origin,
          method: entry.method,
          capturedAt: entry.capturedAt,
          quality: entry.quality,
          query: entry.request.query,
          // The workflow may replay only allow-listed read endpoints. Keep the
          // sanitized request body so it can preserve Ozon's current filter
          // context (for example price_segment) while changing just the search
          // keyword. Dropping these fields makes a valid read return an empty
          // list even though the page itself has data.
          requestBody: clone(entry.request.body),
          recordCount: entry.recordCount,
          recordPath: records.path,
          rawPayloadAvailable: Boolean(serialized),
          records: records.records.map((row) => canonicalRecord(row, entry.classification)),
          fallbackRecommended: entry.quality !== 'confirmed-data',
        };
      }),
    };
  }

  function scanPagination(value, path = [], depth = 0) {
    if (!value || typeof value !== 'object' || depth > 5) return null;
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase();
      if (/^(?:page|page_num|page_no|page_number|pagenumber|pageindex|page_index|currentpage|current_page)$/u.test(normalized) && Number.isFinite(Number(child))) {
        return { location: 'body', kind: 'page', path: [...path, key], value: Number(child) };
      }
      if (/^(?:offset|skip|start|start_index|startindex|from_index|fromindex|\$skip)$/u.test(normalized) && Number.isFinite(Number(child))) {
        return { location: 'body', kind: 'offset', path: [...path, key], value: Number(child) };
      }
      if (/^(?:cursor|last_id|lastid|page_token|pagetoken|next_cursor|nextcursor|continuation_token|continuationtoken)$/u.test(normalized)) {
        return { location: 'body', kind: 'cursor', path: [...path, key], value: child };
      }
      const nested = scanPagination(child, [...path, key], depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  function scanLimitPagination(value, path = [], depth = 0) {
    if (!value || typeof value !== 'object' || depth > 5) return null;
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:limit|page_limit|pagelimit|page_size|pagesize|per_page|perpage|batch_size|batchsize|size|take|\$top)$/iu.test(key) && Number.isFinite(Number(child))) {
        return { location: 'body', kind: 'limit', path: [...path, key], value: Number(child) };
      }
      const nested = scanLimitPagination(child, [...path, key], depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  function detectPagination(recipe) {
    try {
      const url = new URL(recipe.absoluteUrl);
      let limitFallback = null;
      for (const [key, value] of url.searchParams.entries()) {
        const normalized = key.toLowerCase();
        if (/^(?:page|page_num|page_no|page_number|pagenumber|pageindex|page_index|currentpage|current_page)$/u.test(normalized) && Number.isFinite(Number(value))) {
          return { location: 'query', kind: 'page', key, value: Number(value) };
        }
        if (/^(?:offset|skip|start|start_index|startindex|from_index|fromindex|\$skip)$/u.test(normalized) && Number.isFinite(Number(value))) {
          return { location: 'query', kind: 'offset', key, value: Number(value) };
        }
        if (/^(?:cursor|last_id|lastid|page_token|pagetoken|next_cursor|nextcursor|continuation_token|continuationtoken)$/u.test(normalized)) {
          return { location: 'query', kind: 'cursor', key, value };
        }
        if (/^(?:limit|page_limit|pagelimit|page_size|pagesize|per_page|perpage|batch_size|batchsize|size|take|\$top)$/u.test(normalized) && Number.isFinite(Number(value))) {
          limitFallback = { location: 'query', kind: 'limit', key, value: Number(value) };
        }
      }
      if (limitFallback) return limitFallback;
    } catch {
      return null;
    }
    return scanPagination(recipe.body.value) || scanLimitPagination(recipe.body.value);
  }

  function detectLimitPagination(recipe) {
    try {
      const url = new URL(recipe.absoluteUrl);
      for (const [key, value] of url.searchParams.entries()) {
        if (/^(?:limit|page_limit|pagelimit|page_size|pagesize|per_page|perpage|batch_size|batchsize|size|take|\$top)$/iu.test(key) && Number.isFinite(Number(value))) {
          return { location: 'query', kind: 'limit', key, value: Number(value) };
        }
      }
    } catch {
      return null;
    }
    return scanLimitPagination(recipe.body.value);
  }

  function findPageSize(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 5) return 0;
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:limit|page_limit|pagelimit|page_size|pagesize|per_page|perpage|batch_size|batchsize|size|take|\$top)$/iu.test(key) && Number.isFinite(Number(child))) {
        return Math.max(1, Math.min(1000, Number(child)));
      }
    }
    for (const child of Object.values(value)) {
      const nested = findPageSize(child, depth + 1);
      if (nested) return nested;
    }
    return 0;
  }

  function pageSize(recipe) {
    return findPageSize({ query: recipe.query, body: recipe.body.value }) || 50;
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function setPath(target, path, value) {
    let current = target;
    for (let index = 0; index < path.length - 1; index += 1) current = current[path[index]];
    current[path[path.length - 1]] = value;
  }

  function nextCursor(payload) {
    if (!payload || typeof payload !== 'object') return '';
    for (const [key, value] of Object.entries(payload)) {
      if (/^(?:next_cursor|nextcursor|next_page_token|nextpagetoken|continuation_token|continuationtoken)$/iu.test(key) && value) return String(value);
      const nested = nextCursor(value);
      if (nested) return nested;
    }
    return '';
  }

  function reportedTotalCount(payload, depth = 0) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || depth > 5) return 0;
    for (const [key, value] of Object.entries(payload)) {
      if (/^(?:total|total_count|totalcount|items_count|itemscount|total_items|totalitems|records_total|recordstotal)$/iu.test(key)) {
        const count = Number(value);
        if (Number.isFinite(count) && count >= 0) return Math.floor(count);
      }
    }
    for (const value of Object.values(payload)) {
      const nested = reportedTotalCount(value, depth + 1);
      if (nested > 0) return nested;
    }
    return 0;
  }

  function writePaginationValue(recipe, pagination, value) {
    const next = recipe;
    const url = new URL(next.absoluteUrl);
    if (pagination.location === 'query') {
      url.searchParams.set(pagination.key, String(value));
      next.absoluteUrl = url.toString();
      next.query = sanitizedQuery(next.absoluteUrl);
    } else {
      setPath(next.body.value, pagination.path, value);
      next.body.text = next.body.kind === 'json'
        ? JSON.stringify(next.body.value)
        : next.body.kind === 'form'
          ? new URLSearchParams(next.body.value).toString()
          : '';
    }
    return next;
  }

  function replayRecipe(recipe, pagination, value) {
    const next = { ...recipe, headers: { ...recipe.headers }, body: { ...recipe.body, value: clone(recipe.body.value) } };
    return writePaginationValue(next, pagination, value);
  }

  function findSearchField(value, path = [], depth = 0) {
    if (!value || typeof value !== 'object' || depth > 5) return null;
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:text|query|keyword|search_text|searchText)$/iu.test(key) && typeof child === 'string') {
        return [...path, key];
      }
      const nested = findSearchField(child, [...path, key], depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  function searchRecipe(recipe, queryText) {
    const next = {
      ...recipe,
      headers: { ...recipe.headers },
      body: { ...recipe.body, value: clone(recipe.body.value) },
    };
    const url = new URL(next.absoluteUrl);
    const queryKey = [...url.searchParams.keys()].find((key) => /^(?:text|query|keyword|search_text|searchText)$/iu.test(key));
    if (queryKey) {
      url.searchParams.set(queryKey, queryText);
      for (const key of [...url.searchParams.keys()]) {
        if (/^(?:offset|skip|start_index|startindex|page|page_num|page_no|page_number|pageNumber|pageIndex|page_index|currentPage|current_page)$/iu.test(key)) {
          url.searchParams.set(key, /page|current/iu.test(key) ? '1' : '0');
        }
      }
      next.absoluteUrl = url.toString();
      next.query = sanitizedQuery(next.absoluteUrl);
      return next;
    }
    const bodyPath = findSearchField(next.body.value);
    if (!bodyPath) throw new Error('OZON_DATA_SEARCH_FIELD_UNAVAILABLE');
    setPath(next.body.value, bodyPath, queryText);
    const pagination = detectPagination(next);
    if (pagination?.location === 'body') {
      setPath(next.body.value, pagination.path, pagination.kind === 'page' ? 1 : 0);
    }
    next.body.text = next.body.kind === 'json'
      ? JSON.stringify(next.body.value)
      : next.body.kind === 'form'
        ? new URLSearchParams(next.body.value).toString()
        : '';
    return next;
  }

  async function search(sourceSequence, queryText) {
    const recipe = recipes.get(Math.max(0, Number(sourceSequence) || 0));
    if (!recipe?.replaySafe || recipe.classification !== 'keywords') {
      throw new Error('OZON_DATA_SEARCH_NOT_SAFE');
    }
    const query = String(queryText || '').trim();
    if (!query || query.length > 160) throw new Error('OZON_DATA_SEARCH_QUERY_INVALID');
    const next = searchRecipe(recipe, query);
    const options = {
      method: next.method,
      headers: next.headers,
      credentials: 'include',
    };
    if (!['GET', 'HEAD'].includes(next.method) && next.body.text) options.body = next.body.text;
    const response = await originalFetch(next.absoluteUrl, options);
    const payloadValue = await response.clone().json();
    const captured = record({
      recipe: next,
      status: response.status,
      transport: 'search',
      payload: payloadValue,
      replayedFrom: Number(sourceSequence),
    });
    return {
      ready: true,
      version: VERSION,
      sourceSequence: Number(sourceSequence),
      query,
      capturedSequence: captured?.sequence || 0,
      status: captured?.status || response.status,
      quality: captured?.quality || 'empty',
      recordCount: captured?.recordCount || 0,
    };
  }

  function currentCompanyId() {
    const initialState = window.__INITIAL_STATE__ && typeof window.__INITIAL_STATE__ === 'object'
      ? window.__INITIAL_STATE__
      : {};
    const candidates = [
      window.__companyId,
      initialState.companyId,
      initialState.company?.id,
      initialState.company?.companyId,
      initialState.user?.companyId,
    ];
    for (const candidate of candidates) {
      const normalized = String(candidate ?? '').trim();
      if (/^[a-z0-9_-]{1,128}$/iu.test(normalized)) return normalized;
    }
    return '';
  }

  function inheritedHeaders(sourceSequence) {
    const requested = recipes.get(Math.max(0, Number(sourceSequence) || 0));
    const result = requested ? { ...requested.headers } : {};
    if (!requested) {
      for (const recipe of recipes.values()) Object.assign(result, recipe.headers || {});
    }
    // A cold what-to-sell page can be probed before its first analytics
    // request creates a replay recipe. Ozon exposes the active company in the
    // page runtime, so attach only that non-secret routing header.
    const companyId = currentCompanyId();
    if (companyId) result['x-o3-company-id'] = companyId;
    return result;
  }

  function buildProbeRecipe(
    pathname,
    method = 'POST',
    bodyValue = null,
    origin = window.location.origin,
    sourceSequence = 0,
  ) {
    const path = String(pathname || '').trim();
    const requestMethod = String(method || 'POST').trim().toUpperCase();
    const requestOrigin = String(origin || window.location.origin).trim();
    if (!['GET', 'POST'].includes(requestMethod)) throw new Error('OZON_DATA_PROBE_METHOD_INVALID');
    if (!/^\/api\/site\//u.test(path) || /[?#]/u.test(path)) throw new Error('OZON_DATA_PROBE_PATH_INVALID');
    const descriptor = describeEndpoint(`${requestOrigin}${path}`, requestMethod);
    if (!descriptor?.known || !descriptor.replaySafe) throw new Error('OZON_DATA_PROBE_NOT_SAFE');
    const headers = inheritedHeaders(sourceSequence);
    const value = bodyValue && typeof bodyValue === 'object' ? sanitize(bodyValue) : null;
    const body = requestMethod === 'POST'
      ? { kind: 'json', value, text: JSON.stringify(value || {}) }
      : { kind: 'none', value: null, text: '' };
    if (requestMethod === 'POST' && !headers['content-type']) headers['content-type'] = 'application/json';
    const recipe = {
      ...descriptor,
      method: requestMethod,
      headers,
      body,
      query: {},
    };
    return recipe;
  }

  function probeResult(recipe, sourceSequence, status, payloadValue, transport) {
    const captured = record({
      recipe,
      status,
      transport,
      payload: payloadValue,
      replayedFrom: Number(sourceSequence) || 0,
    });
    return {
      ready: true,
      version: VERSION,
      sourceSequence: Number(sourceSequence) || 0,
      capturedSequence: captured?.sequence || 0,
      endpoint: recipe.endpoint,
      status: captured?.status || status,
      quality: captured?.quality || 'empty',
      recordCount: captured?.recordCount || 0,
    };
  }

  function prepareProbe(pathname, method = 'POST', bodyValue = null, origin = window.location.origin, sourceSequence = 0) {
    return {
      ready: true,
      version: VERSION,
      sourceSequence: Number(sourceSequence) || 0,
      recipe: buildProbeRecipe(pathname, method, bodyValue, origin, sourceSequence),
    };
  }

  function commitProbe(
    pathname,
    method = 'POST',
    bodyValue = null,
    origin = window.location.origin,
    sourceSequence = 0,
    status = 0,
    payloadValue = null,
  ) {
    const recipe = buildProbeRecipe(pathname, method, bodyValue, origin, sourceSequence);
    return probeResult(recipe, sourceSequence, Number(status) || 0, payloadValue, 'native-probe');
  }

  async function probe(pathname, method = 'POST', bodyValue = null, origin = window.location.origin, sourceSequence = 0, paginationToken = null) {
    if (paginationToken !== null) assertPaginationActive(paginationToken);
    const recipe = buildProbeRecipe(pathname, method, bodyValue, origin, sourceSequence);
    const requestMethod = recipe.method;
    const options = { method: requestMethod, headers: recipe.headers, credentials: 'include' };
    if (requestMethod === 'POST') options.body = recipe.body.text;
    const response = await (paginationToken !== null ? fetchPaginatedPage : originalFetch)(recipe.absoluteUrl, options);
    if (paginationToken !== null) assertPaginationActive(paginationToken);
    let payloadValue;
    try {
      payloadValue = await response.clone().json();
      if (paginationToken !== null) assertPaginationActive(paginationToken);
    } catch (error) {
      error.ozonStage = 'response';
      error.ozonStatus = Number(response.status) || 0;
      error.ozonContentType = String(response.headers?.get?.('content-type') || '').slice(0, 120);
      throw error;
    }
    return probeResult(recipe, sourceSequence, response.status, payloadValue, 'known-probe');
  }

  function isRetryablePaginationStatus(status) {
    const value = Number(status) || 0;
    return value === 408 || value === 425 || value === 429 || value >= 500;
  }

  function paginationRetryDelay(delay, attempt) {
    return Math.min(5000, Math.max(250, Number(delay) * (2 ** attempt)));
  }

  async function fetchPaginatedPage(url, options) {
    const controller = typeof window.AbortController === 'function'
      ? new window.AbortController()
      : null;
    let timeoutId = 0;
    if (controller) {
      options.signal = controller.signal;
      timeoutId = window.setTimeout(() => controller.abort(), PAGINATION_FETCH_TIMEOUT_MS);
    }
    try {
      return await originalFetch(url, options);
    } catch (error) {
      if (controller?.signal?.aborted === true) {
        const timeoutError = new Error('OZON_DATA_PAGINATION_FETCH_TIMEOUT');
        timeoutError.ozonStage = 'timeout';
        timeoutError.ozonStatus = 0;
        throw timeoutError;
      }
      throw error;
    } finally {
      if (timeoutId) window.clearTimeout(timeoutId);
    }
  }

  async function capturePaginatedPage(next, pagination, sourceSequence, pageIndex, paginationToken) {
    assertPaginationActive(paginationToken);
    if (next.known && pagination.location === 'body') {
      const probed = await probe(
        next.endpoint,
        next.method,
        next.body.value,
        next.origin,
        Number(sourceSequence),
        paginationToken,
      );
      assertPaginationActive(paginationToken);
      const captured = entries.find((entry) => entry.sequence === probed.capturedSequence) || null;
      if (captured) {
        captured.transport = 'pagination';
        captured.replayedFrom = Number(sourceSequence);
        captured.pageIndex = pageIndex;
      }
      return captured;
    }
    const options = {
      method: next.method,
      headers: next.headers,
      credentials: 'include',
    };
    if (!['GET', 'HEAD'].includes(next.method) && next.body.text) options.body = next.body.text;
    const response = await fetchPaginatedPage(next.absoluteUrl, options);
    assertPaginationActive(paginationToken);
    let payload;
    try {
      payload = await response.clone().json();
      assertPaginationActive(paginationToken);
    } catch (error) {
      error.ozonStage = 'response';
      error.ozonStatus = Number(response.status) || 0;
      error.ozonContentType = String(response.headers?.get?.('content-type') || '').slice(0, 120);
      throw error;
    }
    return record({
      recipe: next,
      status: response.status,
      transport: 'pagination',
      payload,
      replayedFrom: Number(sourceSequence),
      pageIndex,
    });
  }

  async function paginate(sourceSequence, maxPages = 5, delayMs = 100) {
    const paginationToken = paginationGeneration;
    const recipe = recipes.get(Math.max(0, Number(sourceSequence) || 0));
    if (!recipe?.replaySafe) throw new Error('OZON_DATA_PAGINATION_NOT_SAFE');
    const pagination = detectPagination(recipe);
    if (!pagination) throw new Error('OZON_DATA_PAGINATION_UNAVAILABLE');
    const limitPagination = pagination.kind === 'offset' ? detectLimitPagination(recipe) : null;
    const pages = Math.max(1, Math.min(250, Number(maxPages) || 5));
    const delay = Math.max(100, Math.min(3000, Number(delayMs) || 100));
    const sourceEntry = entries.find((entry) => entry.sequence === Number(sourceSequence));
    const sourcePayload = (() => {
      const serialized = fullPayloads.get(Number(sourceSequence)) || '';
      try { return serialized ? JSON.parse(serialized) : sourceEntry?.payload; }
      catch { return sourceEntry?.payload; }
    })();
    const seen = new Set(sourceEntry?.payloadHash ? [sourceEntry.payloadHash] : []);
    const capturedSequences = [];
    const pageValues = [];
    const expectedPageSize = pageSize(recipe);
    let recordsFetched = 0;
    let attemptedPages = 0;
    let failedPage = 0;
    let failedStatus = 0;
    let failureCode = '';
    let failureContentType = '';
    let retriesUsed = 0;
    const pageAttempts = [];
    let stopReason = 'max-pages-reached';
    const sourceReportedTotal = reportedTotalCount(sourcePayload);
    const limitBase = Math.max(1, Number(pagination.value || expectedPageSize));
    const limitCeiling = sourceReportedTotal > 0
      ? Math.max(limitBase, Math.min(MAX_LIMIT_EXPANSION_RECORDS, sourceReportedTotal))
      : Math.max(limitBase, MAX_LIMIT_EXPANSION_RECORDS);
    let nextOffset = Number(pagination.value || 0) + expectedPageSize;
    let offsetPageSize = limitPagination
      ? Math.max(expectedPageSize, Math.min(
        MAX_OFFSET_PAGE_SIZE,
        sourceReportedTotal > 0
          ? Math.max(expectedPageSize, sourceReportedTotal - nextOffset)
          : MAX_OFFSET_PAGE_SIZE,
      ))
      : expectedPageSize;
    // Without an authoritative total a short response could mean either
    // "server capped the requested limit" or "dataset ended". Keep the old
    // page size in that case so completion remains provable.
    let offsetExpansionEnabled = Boolean(
      limitPagination
      && sourceReportedTotal > 0
      && offsetPageSize > expectedPageSize,
    );
    let cursor = pagination.kind === 'cursor' ? nextCursor(sourcePayload) : '';
    for (let index = 1; index <= pages; index += 1) {
      if (paginationCancelled(paginationToken)) {
        stopReason = 'cancelled';
        break;
      }
      let value;
      if (pagination.kind === 'page') value = Number(pagination.value || 0) + index;
      else if (pagination.kind === 'offset') value = nextOffset;
      // A limit-only endpoint returns the complete prefix [0, limit).  Linear
      // growth (50, 100, 150...) repeatedly downloads almost the same rows and
      // makes a large keyword dataset take many minutes.  Doubling reaches the
      // server's real cap in O(log n) requests while the short-page check below
      // still proves that the complete available prefix was received.
      else if (pagination.kind === 'limit') {
        value = Math.min(limitCeiling, limitBase * (2 ** index));
      }
      else {
        if (!cursor) {
          stopReason = 'cursor-exhausted';
          break;
        }
        value = cursor;
      }
      attemptedPages += 1;
      pageValues.push(value);
      let next = replayRecipe(recipe, pagination, value);
      let requestedPageSize = pagination.kind === 'offset' && offsetExpansionEnabled
        ? offsetPageSize
        : expectedPageSize;
      let expandedOffsetRequest = pagination.kind === 'offset'
        && Boolean(limitPagination)
        && requestedPageSize !== expectedPageSize;
      if (expandedOffsetRequest) {
        writePaginationValue(next, limitPagination, requestedPageSize);
      }
      let captured = null;
      let lastError = null;
      let attempts = 0;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (paginationCancelled(paginationToken)) {
          lastError = paginationCancellationError();
          break;
        }
        attempts = attempt;
        try {
          captured = await capturePaginatedPage(next, pagination, sourceSequence, index, paginationToken);
          lastError = null;
        } catch (error) {
          captured = null;
          lastError = error;
        }
        if (lastError?.ozonStage === 'cancelled') break;
        const attemptStatus = Number(captured?.status || lastError?.ozonStatus) || 0;
        const retryable = lastError
          ? attemptStatus === 0 || lastError?.ozonStage === 'response' || isRetryablePaginationStatus(attemptStatus)
          : isRetryablePaginationStatus(attemptStatus);
        if (!retryable || attempt >= 3) break;
        if (!await waitForPaginationDelay(paginationRetryDelay(delay, attempt), paginationToken)) {
          lastError = paginationCancellationError();
          break;
        }
      }
      if (lastError?.ozonStage === 'cancelled' || paginationCancelled(paginationToken)) {
        stopReason = 'cancelled';
        break;
      }
      // A larger limit is only an optimisation. Some real Ozon deployments
      // reject it with 4xx/non-JSON even though the original request works.
      // Retry the exact same offset once with the observed page size so no row
      // can be skipped and the route is not incorrectly marked as failed.
      const expandedOffsetFailed = expandedOffsetRequest && (
        Boolean(lastError)
        || !captured
        || Number(captured.status) >= 400
        || captured.quality !== 'confirmed-data'
      );
      if (expandedOffsetFailed) {
        const expansionAttempts = attempts;
        offsetExpansionEnabled = false;
        offsetPageSize = expectedPageSize;
        requestedPageSize = expectedPageSize;
        expandedOffsetRequest = false;
        next = replayRecipe(recipe, pagination, value);
        captured = null;
        lastError = null;
        let fallbackAttempts = 0;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          if (paginationCancelled(paginationToken)) {
            lastError = paginationCancellationError();
            break;
          }
          fallbackAttempts = attempt;
          try {
            captured = await capturePaginatedPage(next, pagination, sourceSequence, index, paginationToken);
            lastError = null;
          } catch (error) {
            captured = null;
            lastError = error;
          }
          if (lastError?.ozonStage === 'cancelled') break;
          const attemptStatus = Number(captured?.status || lastError?.ozonStatus) || 0;
          const retryable = lastError
            ? attemptStatus === 0 || lastError?.ozonStage === 'response' || isRetryablePaginationStatus(attemptStatus)
            : isRetryablePaginationStatus(attemptStatus);
          if (!retryable || attempt >= 3) break;
          if (!await waitForPaginationDelay(paginationRetryDelay(delay, attempt), paginationToken)) {
            lastError = paginationCancellationError();
            break;
          }
        }
        attempts = expansionAttempts + fallbackAttempts;
      }
      if (lastError?.ozonStage === 'cancelled' || paginationCancelled(paginationToken)) {
        stopReason = 'cancelled';
        break;
      }
      retriesUsed += Math.max(0, attempts - 1);
      pageAttempts.push({
        pageIndex: index,
        value,
        attempts,
        status: Number(captured?.status || lastError?.ozonStatus) || 0,
      });
      if (lastError) {
        failedPage = index;
        failedStatus = Number(lastError?.ozonStatus) || 0;
        failureCode = errorCode(lastError);
        failureContentType = String(lastError?.ozonContentType || '').slice(0, 120);
        stopReason = lastError?.ozonStage === 'response' ? 'non-json-response' : 'network-error';
        recordRuntimeError(
          lastError?.ozonStage === 'response' ? 'pagination-response' : 'pagination-fetch',
          lastError,
        );
        break;
      }
      if (!captured) {
        failedPage = index;
        failedStatus = 0;
        stopReason = 'capture-empty';
        break;
      }
      if (seen.has(captured.payloadHash)) {
        stopReason = 'duplicate-page';
        break;
      }
      if (
        captured.quality === 'confirmed-object'
        && captured.recordCount === 0
        && captured.status >= 200
        && captured.status < 300
        && capturedSequences.length > 0
      ) {
        stopReason = 'empty-page';
        break;
      }
      if (captured.quality !== 'confirmed-data') {
        failedPage = index;
        failedStatus = captured.status;
        failureCode = captured.quality;
        stopReason = captured.status >= 400 ? 'http-error' : 'no-data';
        break;
      }
      seen.add(captured.payloadHash);
      capturedSequences.push(captured.sequence);
      recordsFetched = pagination.kind === 'limit'
        ? Math.max(recordsFetched, captured.recordCount)
        : recordsFetched + captured.recordCount;
      if (pagination.kind === 'cursor') cursor = nextCursor(captured.payload);
      const expectedRecordCount = pagination.kind === 'limit'
        ? Number(value) || expectedPageSize
        : pagination.kind === 'offset'
          ? requestedPageSize
          : expectedPageSize;
      const reportedOffsetHasMore = pagination.kind === 'offset'
        && sourceReportedTotal > Number(value) + captured.recordCount;
      if (pagination.kind === 'offset') {
        nextOffset = Number(value) + captured.recordCount;
        // Some Ozon routes accept a larger limit, while older deployments cap
        // it at the original 50 rows.  Probe once and fall back without gaps:
        // the next offset always advances by the number of rows actually read.
        if (offsetExpansionEnabled && captured.recordCount < requestedPageSize && reportedOffsetHasMore) {
          offsetExpansionEnabled = false;
          offsetPageSize = Math.max(1, captured.recordCount || expectedPageSize);
        }
      }
      if (
        pagination.kind === 'offset'
        && sourceReportedTotal > 0
        && Number(value) + captured.recordCount >= sourceReportedTotal
      ) {
        stopReason = 'reported-total-reached';
        break;
      }
      if (captured.recordCount < expectedRecordCount && !reportedOffsetHasMore) {
        stopReason = captured.recordCount === 0 ? 'empty-page' : 'short-page';
        break;
      }
      if (pagination.kind === 'limit' && Number(value) >= limitCeiling) {
        stopReason = sourceReportedTotal > 0 ? 'reported-total-reached' : 'limit-safety-cap';
        break;
      }
      if (index < pages && !await waitForPaginationDelay(delay, paginationToken)) {
        stopReason = 'cancelled';
        break;
      }
    }
    return {
      ready: true,
      version: VERSION,
      sourceSequence: Number(sourceSequence),
      paginationKind: pagination.kind,
      expectedPageSize,
      attemptedPages,
      pagesFetched: capturedSequences.length,
      recordsFetched,
      sourceRecordCount: Number(sourceEntry?.recordCount) || 0,
      reportedTotalCount: sourceReportedTotal,
      totalRecordCount: pagination.kind === 'limit'
        ? Math.max(Number(sourceEntry?.recordCount) || 0, recordsFetched)
        : (Number(sourceEntry?.recordCount) || 0) + recordsFetched,
      capturedSequences,
      pageValues,
      stopReason,
      complete: ['reported-total-reached', 'short-page', 'empty-page', 'cursor-exhausted'].includes(stopReason),
      cancelled: stopReason === 'cancelled',
      generation: paginationToken,
      failedPage,
      failedStatus,
      failureCode,
      failureContentType,
      retriesUsed,
      pageAttempts,
      resumeSourceSequence: capturedSequences.at(-1) || Number(sourceSequence),
      integrity: {
        uniquePayloads: seen.size === capturedSequences.length + (sourceEntry?.payloadHash ? 1 : 0),
        uniqueCapturedSequences: new Set(capturedSequences).size === capturedSequences.length,
        pageValueCountMatchesAttempts: pageValues.length === attemptedPages,
      },
      stoppedSafely: !['network-error', 'non-json-response', 'capture-error', 'capture-empty', 'http-error', 'cancelled'].includes(stopReason),
    };
  }

  const runtime = {
    version: VERSION,
    status() {
      const catalogState = catalog();
      return {
        ready: true,
        version: VERSION,
        queueLength: entries.length,
        lastSequence: sequence,
        endpointCount: catalogState.endpointCount,
        discoveredEndpointCount: catalogState.discoveredEndpointCount,
        totalSerializedBytes,
        retainedPayloadCount: fullPayloads.size,
        evictedEntries,
        frameCapture: { scope: 'same-origin-descendants', forwarded: forwardedFrameCaptures, received: receivedFrameCaptures, scopeFailures: frameScopeFailures },
        companyContextReady: Boolean(currentCompanyId()),
        retention: {
          maxEntries: MAX_ENTRIES,
          maxTotalChars: MAX_TOTAL_CHARS,
          maxInlineEntryChars: MAX_INLINE_ENTRY_CHARS,
          payloadChunkChars: MAX_PAYLOAD_CHUNK_CHARS,
        },
        fetchHooked: window.fetch !== originalFetch,
        xhrHooked: XMLHttpRequest.prototype.open !== xhrOpen,
        errors: [...runtimeErrors],
      };
    },
    read,
    payload,
    catalog,
    normalize,
    search,
    probe,
    prepareProbe,
    commitProbe,
    paginate,
    cancelPagination,
    receiveFrameRecord,
  };
  Object.defineProperty(window, GLOBAL_KEY, {
    value: runtime,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function wangzaiObservedFetch(input, init) {
      const recipePromise = fetchRecipe(input, init).catch((error) => {
        recordRuntimeError('fetch-request', error);
        return null;
      });
      const response = await originalFetch.apply(this, arguments);
      const recipe = await recipePromise;
      if (recipe) {
        void response.clone().json().then((payload) => {
          record({ recipe, status: response.status, transport: 'fetch', payload });
        }).catch((error) => recordRuntimeError('fetch-response', error));
      }
      return response;
    };
  }

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  const xhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const xhrMetadata = new WeakMap();

  XMLHttpRequest.prototype.open = function wangzaiObservedOpen(method, url) {
    xhrMetadata.set(this, {
      method: String(method || 'GET').toUpperCase(),
      url: String(url || ''),
      headers: {},
    });
    return xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function wangzaiObservedSetRequestHeader(name, value) {
    const metadata = xhrMetadata.get(this);
    const key = String(name || '').toLowerCase();
    if (metadata && SAFE_REPLAY_HEADERS.has(key)) metadata.headers[key] = String(value || '').slice(0, 500);
    return xhrSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function wangzaiObservedSend(body) {
    const metadata = xhrMetadata.get(this);
    const descriptor = metadata ? describeEndpoint(metadata.url, metadata.method) : null;
    if (metadata && descriptor) {
      const parsedBody = (() => {
        if (typeof body !== 'string' || !body) return { kind: 'none', value: null, text: '' };
        try {
          const value = sanitize(JSON.parse(body));
          return { kind: 'json', value, text: JSON.stringify(value) };
        } catch {
          return { kind: 'text', value: '[non-json-body]', text: '' };
        }
      })();
      const recipe = {
        ...descriptor,
        method: metadata.method,
        headers: metadata.headers,
        body: parsedBody,
        query: sanitizedQuery(metadata.url),
      };
      this.addEventListener('load', () => {
        try {
          const payload = this.responseType === 'json'
            ? this.response
            : JSON.parse(String(this.responseText || 'null'));
          record({ recipe, status: this.status, transport: 'xhr', payload });
        } catch (error) {
          recordRuntimeError('xhr-response', error);
        }
      }, { once: true });
    }
    return xhrSend.apply(this, arguments);
  };
})();
