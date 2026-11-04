import {
  DEFAULT_RETRY_DELAY_MS,
  MAX_DOMAIN_SNAPSHOTS,
  MAX_IMAGES,
  MAX_ORDERS,
  MAX_PRODUCTS,
  MAX_REFRESH_LOGS,
  MAX_RETRY_DELAY_MS,
  MAX_RETRY_FAILURES,
  MAX_SNAPSHOT_RETRY_ATTEMPTS,
  MAX_SNAPSHOTS,
  OZON_LOCAL_DATA_LAYER_VERSION,
  SNAPSHOT_TYPE_ORDER,
  SNAPSHOT_TYPE_PRODUCT,
  cloneJsonSafe,
  createSignature,
  isPlainObject,
  normalizeArray,
  normalizeText,
  nowIso,
} from './ozonLocalDataLayerShared.js';

const LEGACY_SECRET_KEY_SEGMENT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SECRET_LIKE_UUID_TEXT_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function createEmptyOzonLocalDataStore() {
  return {
    version: OZON_LOCAL_DATA_LAYER_VERSION,
    updatedAt: '',
    snapshots: {},
    domainSnapshots: {},
    orders: {},
    orderProducts: {},
    products: {},
    images: {},
    failures: {},
    logs: [],
  };
}

function stripEphemeralEntityFieldMeta(records = {}) {
  if (!isPlainObject(records)) return {};
  let changed = false;
  const compacted = {};
  for (const [key, record] of Object.entries(records)) {
    if (isPlainObject(record) && Object.prototype.hasOwnProperty.call(record, 'fieldMeta')) {
      const { fieldMeta: _fieldMeta, ...withoutFieldMeta } = record;
      compacted[key] = withoutFieldMeta;
      changed = true;
    } else {
      compacted[key] = record;
    }
  }
  return changed ? compacted : records;
}

export function normalizeOzonLocalDataStore(store = {}) {
  const normalized = createEmptyOzonLocalDataStore();
  if (!isPlainObject(store)) return normalized;
  const snapshots = {
    ...trimRecordMapByRecentTime(isPlainObject(store.snapshots) ? store.snapshots : {}, MAX_SNAPSHOTS),
  };
  pruneSupersededProductPageSnapshotsForFullSnapshots({ snapshots });
  return {
    ...normalized,
    ...store,
    version: OZON_LOCAL_DATA_LAYER_VERSION,
    snapshots,
    domainSnapshots: trimRecordMapByRecentTime(
      isPlainObject(store.domainSnapshots) ? store.domainSnapshots : {},
      MAX_DOMAIN_SNAPSHOTS
    ),
    // 订单和订单商品的 fieldMeta 只记录一次请求中的字段来源/时间；读取路径
    // 不消费它，合并也仅将其当作可选的时间提示。持久化它会为每一行复制
    // 数十份相同结构的元数据，因此在 cache normalization 时删除。
    orders: stripEphemeralEntityFieldMeta(store.orders),
    orderProducts: stripEphemeralEntityFieldMeta(store.orderProducts),
    products: isPlainObject(store.products) ? store.products : {},
    images: isPlainObject(store.images) ? store.images : {},
    failures: normalizeFailureMap(store.failures),
    logs: normalizeRefreshLogs(store.logs),
  };
}

export function getAfterSalesSnapshotLogicalScope(snapshotKey = '') {
  return normalizeText(snapshotKey).replace(/:range:[^:]+(?=:|$)/g, ':range:current');
}

export function pruneAfterSalesSnapshotVariants(store = {}, options = {}) {
  if (!isPlainObject(store?.snapshots)) {
    return { changed: false, removedSnapshots: 0, removedOrders: 0, removedFailures: 0, removedLogs: 0 };
  }
  const preferredSnapshotKey = normalizeText(options.preferredSnapshotKey);
  const candidateKeys = normalizeArray(options.compatibleSnapshotKeys)
    .map(normalizeText)
    .filter(Boolean);
  if (preferredSnapshotKey) candidateKeys.unshift(preferredSnapshotKey);
  const logicalScopes = new Set(
    candidateKeys
      .filter((key) => key.startsWith('ozon-after-sales:'))
      .map(getAfterSalesSnapshotLogicalScope)
      .filter(Boolean)
  );
  if (!preferredSnapshotKey || !logicalScopes.size || !store.snapshots[preferredSnapshotKey]) {
    return { changed: false, removedSnapshots: 0, removedOrders: 0, removedFailures: 0, removedLogs: 0 };
  }

  const removedSnapshotKeys = new Set();
  for (const snapshotKey of Object.keys(store.snapshots)) {
    if (snapshotKey === preferredSnapshotKey || !snapshotKey.startsWith('ozon-after-sales:')) continue;
    if (!logicalScopes.has(getAfterSalesSnapshotLogicalScope(snapshotKey))) continue;
    delete store.snapshots[snapshotKey];
    removedSnapshotKeys.add(snapshotKey);
  }

  const referencedOrderKeys = new Set(
    Object.entries(store.snapshots)
      .filter(([snapshotKey]) => snapshotKey.startsWith('ozon-after-sales:'))
      .flatMap(([, snapshot]) => normalizeArray(snapshot?.rowKeys))
      .map(normalizeText)
      .filter(Boolean)
  );
  let removedOrders = 0;
  for (const [orderKey, order] of Object.entries(store.orders || {})) {
    if (order?.domain !== '09_after_sales' || referencedOrderKeys.has(orderKey)) continue;
    delete store.orders[orderKey];
    removedOrders += 1;
  }

  let removedFailures = 0;
  for (const [failureKey, failure] of Object.entries(store.failures || {})) {
    if (!removedSnapshotKeys.has(normalizeText(failure?.snapshotKey))) continue;
    delete store.failures[failureKey];
    removedFailures += 1;
  }
  const previousLogCount = normalizeArray(store.logs).length;
  store.logs = normalizeArray(store.logs).filter((log) => !removedSnapshotKeys.has(normalizeText(log?.snapshotKey)));
  const removedLogs = previousLogCount - store.logs.length;
  return {
    changed: removedSnapshotKeys.size > 0 || removedOrders > 0 || removedFailures > 0 || removedLogs > 0,
    removedSnapshots: removedSnapshotKeys.size,
    removedOrders,
    removedFailures,
    removedLogs,
  };
}

export function normalizeSnapshotKeyForCompatibility(snapshotKey = '') {
  return normalizeText(snapshotKey)
    .split(':')
    .filter((part) => !LEGACY_SECRET_KEY_SEGMENT_PATTERN.test(part))
    .join(':');
}

export function findCompatibleSnapshotRecord(section = {}, snapshotKey = '', isUsable = () => true) {
  const keys = normalizeArray(snapshotKey).map(normalizeText).filter(Boolean);
  for (const key of keys) {
    const snapshot = section[key];
    if (snapshot && isUsable(snapshot)) return { key, snapshot, migrated: false };
  }

  const compatibleKeys = new Set(keys.map(normalizeSnapshotKeyForCompatibility).filter(Boolean));
  if (!compatibleKeys.size) return { key: '', snapshot: null, migrated: false };

  for (const [storedKey, snapshot] of Object.entries(section)) {
    if (!snapshot || !isUsable(snapshot)) continue;
    if (compatibleKeys.has(normalizeSnapshotKeyForCompatibility(storedKey))) {
      return { key: storedKey, snapshot, migrated: true };
    }
  }

  return { key: '', snapshot: null, migrated: false };
}

export function toErrorRecords(errors = []) {
  return normalizeArray(errors)
    .map((item) => {
      const endpoint = normalizeText(item?.endpoint || item?.error?.endpoint || '');
      const status = Number(item?.status || item?.error?.status) || 0;
      const retryAfterMs = Number(item?.retryAfterMs || item?.error?.retryAfterMs) || 0;
      return {
        label: sanitizeLogText(item?.label || 'Ozon'),
        message: normalizeText(item?.error?.message || item?.message || item?.error || '读取失败'),
        ...(endpoint ? { endpoint: sanitizeLogText(endpoint) } : {}),
        ...(status ? { status } : {}),
        ...(retryAfterMs ? { retryAfterMs } : {}),
      };
    })
    .map(sanitizeErrorRecord)
    .filter((item) => item.label || item.message);
}

export function getRetryDelayMs(errorRecord, previousFailure) {
  if (Number(errorRecord.retryAfterMs) > 0) return Number(errorRecord.retryAfterMs);
  const attemptCount = (Number(previousFailure?.attemptCount) || 0) + 1;
  return Math.min(MAX_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS * 2 ** Math.max(0, attemptCount - 1));
}

export function addMsToIso(timestamp, ms) {
  const time = Date.parse(timestamp);
  const base = Number.isFinite(time) ? time : Date.now();
  return new Date(base + ms).toISOString();
}

export function getRecordTimeMs(record = {}) {
  const time = Date.parse(
    normalizeText(
      record.updatedAt ||
        record.fetchedAt ||
        record.at ||
        record.nextRetryAt ||
        record.lastFailedAt ||
        record.firstFailedAt
    )
  );
  return Number.isFinite(time) ? time : 0;
}

export function trimRecordMapByRecentTime(recordMap = {}, limit = 0) {
  const entries = Object.entries(recordMap || {});
  const safeLimit = Math.max(0, Number(limit) || 0);
  if (!safeLimit || entries.length <= safeLimit) return isPlainObject(recordMap) ? recordMap : {};
  return Object.fromEntries(
    entries.sort(([, left], [, right]) => getRecordTimeMs(right) - getRecordTimeMs(left)).slice(0, safeLimit)
  );
}

export function sanitizeLogText(value) {
  return normalizeText(value)
    .replace(
      /(api[-_ ]?key|token|secret|password|authorization|client[-_ ]?secret|company[-_ ]?secret)\s*[:=]\s*[^,\s}]+/gi,
      '$1=[REDACTED]'
    )
    .replace(SECRET_LIKE_UUID_TEXT_PATTERN, '[REDACTED]');
}

export function sanitizeErrorRecord(error = {}) {
  const cloned = cloneJsonSafe(error) || {};
  const endpoint = sanitizeLogText(cloned.endpoint || '');
  const status = Number(cloned.status) || 0;
  const record = {
    ...cloned,
    label: sanitizeLogText(error?.label || ''),
    message: sanitizeLogText(error?.message || ''),
  };
  if (endpoint) record.endpoint = endpoint;
  else delete record.endpoint;
  if (status) record.status = status;
  else delete record.status;
  return record;
}

export function normalizeFailureMap(failures = {}) {
  const trimmed = trimRecordMapByRecentTime(isPlainObject(failures) ? failures : {}, MAX_RETRY_FAILURES);
  return Object.fromEntries(
    Object.entries(trimmed).map(([key, failure]) => [
      key,
      {
        ...cloneJsonSafe(failure),
        key: sanitizeLogText(failure?.key || key),
        snapshotKey: sanitizeLogText(failure?.snapshotKey || ''),
        type: sanitizeLogText(failure?.type || ''),
        label: sanitizeLogText(failure?.label || ''),
        endpoint: sanitizeLogText(failure?.endpoint || ''),
        message: sanitizeLogText(failure?.message || ''),
      },
    ])
  );
}

export function normalizeRefreshLogs(logs = []) {
  return normalizeArray(logs)
    .map((log) => {
      const cloned = cloneJsonSafe(log) || {};
      return {
        ...cloned,
        id: sanitizeLogText(cloned.id || ''),
        at: normalizeText(cloned.at || cloned.updatedAt || cloned.fetchedAt || ''),
        snapshotKey: sanitizeLogText(cloned.snapshotKey || ''),
        type: sanitizeLogText(cloned.type || ''),
        source: sanitizeLogText(cloned.source || ''),
        errors: normalizeArray(cloned.errors).map(sanitizeErrorRecord),
      };
    })
    .filter((log) => log.id || log.at || log.snapshotKey)
    .sort((left, right) => getRecordTimeMs(right) - getRecordTimeMs(left))
    .slice(0, MAX_REFRESH_LOGS);
}

export function createSnapshotChangeSummary(previousKeys = [], nextKeys = [], options = {}) {
  const previousSet = new Set(normalizeArray(previousKeys).map(normalizeText).filter(Boolean));
  const nextSet = new Set(normalizeArray(nextKeys).map(normalizeText).filter(Boolean));
  let added = 0;
  let retained = 0;
  nextSet.forEach((key) => {
    if (previousSet.has(key)) retained += 1;
    else added += 1;
  });
  return {
    previous: previousSet.size,
    next: nextSet.size,
    added,
    retained,
    updated: Math.max(0, Number(options.updated) || 0),
    unchanged: Math.max(0, Number(options.unchanged) || 0),
    removed: [...previousSet].filter((key) => !nextSet.has(key)).length,
    failed: Math.max(0, Number(options.failed) || 0),
    skippedEmpty: Math.max(0, Number(options.skippedEmpty) || 0),
  };
}

export function getOzonLocalSnapshotHealth(snapshot = {}, options = {}) {
  const timestamp = normalizeText(snapshot?.updatedAt || snapshot?.fetchedAt || snapshot?.at || '');
  const updatedAtMs = Date.parse(timestamp);
  const nowMs = Number.isFinite(Number(options.nowMs))
    ? Number(options.nowMs)
    : Date.parse(normalizeText(options.now || '')) || Date.now();
  const maxAgeMs = Math.max(0, Number(options.maxAgeMs ?? options.ttlMs) || 0);
  const version = Number(snapshot?.version) || 0;
  const hash = normalizeText(snapshot?.signature || snapshot?.rawHash || '');
  const ageMs = Number.isFinite(updatedAtMs) ? Math.max(0, nowMs - updatedAtMs) : null;
  const isCurrentVersion = version === OZON_LOCAL_DATA_LAYER_VERSION;
  const isExpired = maxAgeMs > 0 && ageMs !== null && ageMs > maxAgeMs;
  const reasons = [];

  if (options.forceRefresh === true) reasons.push('force-refresh');
  if (!isCurrentVersion) reasons.push('version-mismatch');
  if (!hash) reasons.push('missing-hash');
  if (!timestamp || !Number.isFinite(updatedAtMs)) reasons.push('missing-updated-at');
  if (isExpired) reasons.push('expired');

  return {
    version,
    expectedVersion: OZON_LOCAL_DATA_LAYER_VERSION,
    updatedAt: timestamp,
    ageMs,
    maxAgeMs,
    hash,
    hasHash: Boolean(hash),
    isCurrentVersion,
    isExpired,
    forceRefresh: options.forceRefresh === true,
    stale: reasons.length > 0,
    reasons,
  };
}

export function collectRecordSignatures(recordMap = {}, keys = []) {
  return new Map(
    normalizeArray(keys)
      .map(normalizeText)
      .filter(Boolean)
      .map((key) => [key, normalizeText(recordMap?.[key]?.signature)])
  );
}

export function countRecordSignatureChanges(previousSignatures = new Map(), recordMap = {}, keys = []) {
  let updated = 0;
  let unchanged = 0;
  normalizeArray(keys)
    .map(normalizeText)
    .filter(Boolean)
    .forEach((key) => {
      if (!previousSignatures.has(key)) return;
      const previousSignature = normalizeText(previousSignatures.get(key));
      const currentSignature = normalizeText(recordMap?.[key]?.signature);
      if (previousSignature && currentSignature && previousSignature === currentSignature) unchanged += 1;
      else updated += 1;
    });
  return { updated, unchanged };
}

export function countSignatureMapChanges(previousSignatures = new Map(), nextSignatures = new Map(), keys = []) {
  let updated = 0;
  let unchanged = 0;
  normalizeArray(keys)
    .map(normalizeText)
    .filter(Boolean)
    .forEach((key) => {
      if (!previousSignatures.has(key)) return;
      const previousSignature = normalizeText(previousSignatures.get(key));
      const currentSignature = normalizeText(nextSignatures.get(key));
      if (previousSignature && currentSignature && previousSignature === currentSignature) unchanged += 1;
      else updated += 1;
    });
  return { updated, unchanged };
}

export function appendRefreshLog(store, entry = {}) {
  const currentLogs = Array.isArray(store.logs) ? store.logs : [];
  const errors = normalizeArray(entry.errors).map((error) => ({
    label: sanitizeLogText(error?.label || ''),
    message: sanitizeLogText(error?.message || ''),
    endpoint: sanitizeLogText(error?.endpoint || ''),
    status: Number(error?.status) || 0,
  }));
  const nextLog = {
    id: createSignature({
      snapshotKey: entry.snapshotKey,
      type: entry.type,
      at: entry.at,
      rows: entry.rows,
      errors: errors.length,
    }),
    at: entry.at || nowIso(),
    snapshotKey: sanitizeLogText(entry.snapshotKey || ''),
    type: sanitizeLogText(entry.type || ''),
    source: sanitizeLogText(entry.source || 'local-data-layer'),
    rows: Math.max(0, Number(entry.rows) || 0),
    errors,
    failureCount: Math.max(0, Number(entry.failureCount) || 0),
    partial: errors.length > 0 && Number(entry.rows) > 0,
    changeSummary: entry.changeSummary || null,
  };
  store.logs = [nextLog, ...currentLogs].slice(0, MAX_REFRESH_LOGS);
}

export function getFailureKey(snapshotKey, errorRecord) {
  return createSignature({
    snapshotKey,
    label: errorRecord.label,
    endpoint: errorRecord.endpoint,
    status: errorRecord.status,
    message: errorRecord.message,
  });
}

export function clearSnapshotFailures(store, snapshotKey) {
  for (const [key, failure] of Object.entries(store.failures || {})) {
    if (failure?.snapshotKey === snapshotKey) delete store.failures[key];
  }
}

export function trimRetryFailures(store) {
  store.failures = trimRecordMapByRecentTime(store.failures, MAX_RETRY_FAILURES);
}

export function upsertSnapshotFailures(store, snapshotKey, snapshotType, errors, timestamp) {
  if (!errors.length) {
    clearSnapshotFailures(store, snapshotKey);
    trimRetryFailures(store);
    return [];
  }

  const failures = errors.map((errorRecord) => {
    const key = getFailureKey(snapshotKey, errorRecord);
    const previous = store.failures[key];
    const maxAttempts = Math.max(1, Number(previous?.maxAttempts) || MAX_SNAPSHOT_RETRY_ATTEMPTS);
    const attemptCount = Math.min(maxAttempts, (Number(previous?.attemptCount) || 0) + 1);
    const retryStatus = attemptCount >= maxAttempts ? 'paused' : 'pending';
    const retryDelayMs = retryStatus === 'pending' ? getRetryDelayMs(errorRecord, previous) : 0;
    const failure = {
      key,
      snapshotKey,
      type: snapshotType,
      label: errorRecord.label,
      endpoint: errorRecord.endpoint,
      status: errorRecord.status,
      message: errorRecord.message,
      attemptCount,
      maxAttempts,
      retryStatus,
      firstFailedAt: previous?.firstFailedAt || timestamp,
      lastFailedAt: timestamp,
      nextRetryAt: retryStatus === 'pending' ? addMsToIso(timestamp, retryDelayMs) : '',
      retryDelayMs,
    };
    store.failures[key] = failure;
    return failure;
  });
  trimRetryFailures(store);
  return failures;
}

export function markRecordNotSeen(record = {}, timestamp, snapshotKey = '') {
  return {
    ...record,
    notSeenInLastRefresh: true,
    needsVerify: true,
    lastNotSeenAt: timestamp,
    lastNotSeenSnapshotKey: snapshotKey,
  };
}

export function markOrderSnapshotRowsNotSeen(store, previousKeys = [], nextKeys = [], timestamp, snapshotKey = '') {
  const nextKeySet = new Set(nextKeys);
  previousKeys.forEach((orderKey) => {
    if (!orderKey || nextKeySet.has(orderKey) || !store.orders[orderKey]) return;
    store.orders[orderKey] = markRecordNotSeen(store.orders[orderKey], timestamp, snapshotKey);
    normalizeArray(store.orders[orderKey].orderProductKeys).forEach((orderProductKey) => {
      if (!store.orderProducts[orderProductKey]) return;
      store.orderProducts[orderProductKey] = markRecordNotSeen(
        store.orderProducts[orderProductKey],
        timestamp,
        snapshotKey
      );
    });
  });
}

export function markProductSnapshotRowsNotSeen(store, previousKeys = [], nextKeys = [], timestamp, snapshotKey = '') {
  const nextKeySet = new Set(nextKeys);
  previousKeys.forEach((productKey) => {
    if (!productKey || nextKeySet.has(productKey) || !store.products[productKey]) return;
    store.products[productKey] = markRecordNotSeen(store.products[productKey], timestamp, snapshotKey);
  });
}

export function sortByLastSeenDesc(records = []) {
  return records.sort((left, right) => normalizeText(right.lastSeenAt).localeCompare(normalizeText(left.lastSeenAt)));
}

export function updateSnapshotSignature(snapshot = {}) {
  const { signature: _signature, ...payload } = snapshot;
  snapshot.signature = createSignature(payload);
}

export function reconcileSnapshotEntityReferences(store) {
  const existingOrderKeys = new Set(Object.keys(store.orders));
  const existingProductKeys = new Set(Object.keys(store.products));

  Object.values(store.snapshots).forEach((snapshot) => {
    let changed = false;
    if (Array.isArray(snapshot.rowKeys)) {
      const rowKeys = snapshot.rowKeys.filter((key) => existingOrderKeys.has(key));
      changed = changed || rowKeys.length !== snapshot.rowKeys.length;
      snapshot.rowKeys = rowKeys;
    }
    if (Array.isArray(snapshot.productKeys)) {
      const productKeys = snapshot.productKeys.filter((key) => existingProductKeys.has(key));
      changed = changed || productKeys.length !== snapshot.productKeys.length;
      snapshot.productKeys = productKeys;
    }
    if (changed) updateSnapshotSignature(snapshot);
  });
}

export function pruneStore(store) {
  store.snapshots = trimRecordMapByRecentTime(store.snapshots, MAX_SNAPSHOTS);
  store.domainSnapshots = trimRecordMapByRecentTime(store.domainSnapshots, MAX_DOMAIN_SNAPSHOTS);
  trimRetryFailures(store);

  const keepOrders = new Set(
    sortByLastSeenDesc(Object.values(store.orders))
      .slice(0, MAX_ORDERS)
      .map((item) => item.key)
  );
  for (const key of Object.keys(store.orders)) {
    if (!keepOrders.has(key)) delete store.orders[key];
  }
  for (const key of Object.keys(store.orderProducts)) {
    if (!keepOrders.has(store.orderProducts[key]?.orderKey)) delete store.orderProducts[key];
  }

  const referencedProducts = new Set(
    [
      ...Object.values(store.orderProducts).map((item) => item.productKey),
      ...Object.values(store.snapshots).flatMap((item) => normalizeArray(item?.productKeys)),
      ...Object.values(store.products)
        .filter((item) => item?.notSeenInLastRefresh)
        .map((item) => item.key),
    ].filter(Boolean)
  );
  const keepProducts = new Set(
    sortByLastSeenDesc(Object.values(store.products))
      .filter((item) => referencedProducts.has(item.key))
      .slice(0, MAX_PRODUCTS)
      .map((item) => item.key)
  );
  for (const key of Object.keys(store.products)) {
    if (!keepProducts.has(key)) delete store.products[key];
  }

  const referencedImages = new Set(
    Object.values(store.products).flatMap((item) => [
      ...normalizeArray(item.imageUrls),
      ...normalizeArray(item.skuImageUrls),
      ...normalizeArray(item.mainImageUrls),
    ])
  );
  const keepImages = new Set(
    sortByLastSeenDesc(Object.values(store.images))
      .filter((item) => referencedImages.has(item.url))
      .slice(0, MAX_IMAGES)
      .map((item) => item.url)
  );
  for (const key of Object.keys(store.images)) {
    if (!keepImages.has(key)) delete store.images[key];
  }

  reconcileSnapshotEntityReferences(store);
}

export function normalizeCleanupValues(value) {
  return normalizeArray(value).map(normalizeText).filter(Boolean);
}

export function normalizeCleanupDateKey(value) {
  const text = normalizeText(value);
  if (!text) return '';
  if (text === 'open') return 'open';
  return text.slice(0, 10);
}

export function getCleanupTimeMs(value) {
  const time = Date.parse(normalizeText(value));
  return Number.isFinite(time) ? time : 0;
}

export function getSnapshotCleanupDomain(key = '', snapshot = {}, section = 'snapshots') {
  const explicitDomain = normalizeText(snapshot.domain || snapshot.payload?.domain);
  if (explicitDomain) return explicitDomain;
  const normalizedKey = normalizeText(key).toLowerCase();
  if (section === 'domainSnapshots') return normalizedKey.split(':')[0] || 'domain';
  if (normalizedKey.includes('product')) return 'products';
  if (normalizedKey.includes('after-sales') || normalizedKey.includes('aftersales')) return 'afterSales';
  if (normalizedKey.includes('purchase')) return 'purchase';
  if (normalizedKey.includes('profit')) return 'profit';
  if (normalizedKey.includes('finance')) return 'finance';
  if (normalizedKey.includes('warehouse')) return 'warehouse';
  if (normalizedKey.includes('marketing')) return 'marketing';
  if (normalizedKey.includes('sales-orders')) return 'salesOrders';
  if (snapshot.type === SNAPSHOT_TYPE_PRODUCT) return 'products';
  if (snapshot.type === SNAPSHOT_TYPE_ORDER) return 'salesOrders';
  return normalizeText(snapshot.type || 'unknown');
}

export function getSnapshotCleanupRange(key = '') {
  const match = normalizeText(key).match(/(?:^|:)range:([^:]+)/i);
  if (!match) return { start: '', end: '' };
  const [start = '', end = ''] = match[1].split('_');
  return {
    start: normalizeCleanupDateKey(start),
    end: normalizeCleanupDateKey(end),
  };
}

export function snapshotMatchesCleanupRange(key = '', options = {}) {
  const startSelector = normalizeCleanupDateKey(options.rangeStart ?? options.startTime ?? options.startDate ?? '');
  const endSelector = normalizeCleanupDateKey(options.rangeEnd ?? options.endTime ?? options.endDate ?? '');
  if (!startSelector && !endSelector) return true;
  const range = getSnapshotCleanupRange(key);
  if (!range.start && !range.end) return false;
  const matchesStart = !startSelector || range.start === startSelector;
  const matchesEnd = !endSelector || range.end === endSelector;
  return matchesStart && matchesEnd;
}

export function getSnapshotCleanupKeySegments(key = '') {
  return normalizeText(key)
    .split(':')
    .flatMap((part) => part.split(/[|,]/))
    .map(normalizeText)
    .filter(Boolean);
}

export function snapshotMatchesCleanupShop(key = '', snapshot = {}, shopKeys = []) {
  if (!shopKeys.length) return true;
  const keySegments = new Set(getSnapshotCleanupKeySegments(key).map((part) => part.toLowerCase()));
  const snapshotShopValues = normalizeArray(snapshot.shops)
    .flatMap((shop) => [shop?.id, shop?.clientId, shop?.label, shop?.name])
    .map(normalizeText)
    .filter(Boolean);
  return shopKeys.some((shopKey) => {
    const normalizedShopKey = normalizeText(shopKey);
    if (!normalizedShopKey) return false;
    if (keySegments.has(normalizedShopKey.toLowerCase())) return true;
    return snapshotShopValues.includes(normalizedShopKey);
  });
}

export function snapshotMatchesCleanupTime(snapshot = {}, options = {}) {
  const updatedBefore = getCleanupTimeMs(options.updatedBefore || options.before);
  const fetchedBefore = getCleanupTimeMs(options.fetchedBefore);
  if (!updatedBefore && !fetchedBefore) return true;
  const updatedAt = getCleanupTimeMs(snapshot.updatedAt);
  const fetchedAt = getCleanupTimeMs(snapshot.fetchedAt);
  const matchesUpdated = !updatedBefore || (updatedAt > 0 && updatedAt < updatedBefore);
  const matchesFetched = !fetchedBefore || (fetchedAt > 0 && fetchedAt < fetchedBefore);
  return matchesUpdated && matchesFetched;
}

export function hasCleanupSelector(options = {}) {
  return Boolean(
    normalizeCleanupValues(options.snapshotKeys).length ||
    normalizeText(options.snapshotKeyPrefix) ||
    normalizeCleanupValues(options.domains).length ||
    normalizeCleanupValues(options.shopKeys).length ||
    normalizeText(options.rangeStart ?? options.startTime ?? options.startDate ?? '') ||
    normalizeText(options.rangeEnd ?? options.endTime ?? options.endDate ?? '') ||
    normalizeText(options.updatedBefore || options.before || options.fetchedBefore)
  );
}

export function shouldRemoveSnapshotForCleanup(key = '', snapshot = {}, section = 'snapshots', options = {}) {
  const snapshotKeys = new Set(normalizeCleanupValues(options.snapshotKeys));
  if (snapshotKeys.size && !snapshotKeys.has(key)) return false;
  const snapshotKeyPrefix = normalizeText(options.snapshotKeyPrefix);
  if (snapshotKeyPrefix && !key.startsWith(snapshotKeyPrefix)) return false;

  const domains = normalizeCleanupValues(options.domains);
  if (domains.length) {
    const snapshotDomain = getSnapshotCleanupDomain(key, snapshot, section);
    if (!domains.includes(snapshotDomain)) return false;
  }

  if (!snapshotMatchesCleanupShop(key, snapshot, normalizeCleanupValues(options.shopKeys))) return false;
  if (!snapshotMatchesCleanupRange(key, options)) return false;
  if (!snapshotMatchesCleanupTime(snapshot, options)) return false;
  return true;
}

export function cleanupOzonLocalDataStoreSnapshots(store = {}, options = {}) {
  const normalizedStore = normalizeOzonLocalDataStore(store);
  if (!hasCleanupSelector(options)) {
    return {
      store: normalizedStore,
      stats: { changed: false, removedSnapshots: 0, removedDomainSnapshots: 0, removedFailures: 0, removedLogs: 0 },
    };
  }

  const removedSnapshotKeys = new Set();
  let removedSnapshots = 0;
  let removedDomainSnapshots = 0;

  for (const [key, snapshot] of Object.entries(normalizedStore.snapshots)) {
    if (!shouldRemoveSnapshotForCleanup(key, snapshot, 'snapshots', options)) continue;
    delete normalizedStore.snapshots[key];
    removedSnapshotKeys.add(key);
    removedSnapshots += 1;
  }

  for (const [key, snapshot] of Object.entries(normalizedStore.domainSnapshots)) {
    if (!shouldRemoveSnapshotForCleanup(key, snapshot, 'domainSnapshots', options)) continue;
    delete normalizedStore.domainSnapshots[key];
    removedSnapshotKeys.add(key);
    removedDomainSnapshots += 1;
  }

  let removedFailures = 0;
  for (const [key, failure] of Object.entries(normalizedStore.failures)) {
    if (!removedSnapshotKeys.has(failure?.snapshotKey)) continue;
    delete normalizedStore.failures[key];
    removedFailures += 1;
  }

  const previousLogCount = normalizeArray(normalizedStore.logs).length;
  normalizedStore.logs = normalizeArray(normalizedStore.logs).filter(
    (log) => !removedSnapshotKeys.has(log?.snapshotKey)
  );
  const removedLogs = previousLogCount - normalizedStore.logs.length;
  const changed = removedSnapshots > 0 || removedDomainSnapshots > 0 || removedFailures > 0 || removedLogs > 0;
  if (changed) normalizedStore.updatedAt = options.now || nowIso();
  pruneStore(normalizedStore);

  return {
    store: normalizedStore,
    stats: {
      changed,
      removedSnapshots,
      removedDomainSnapshots,
      removedFailures,
      removedLogs,
    },
  };
}

export function getFullProductSnapshotBaseKey(snapshotKey = '') {
  const key = normalizeText(snapshotKey);
  const fullSuffix = ':full';
  return key.toLowerCase().endsWith(fullSuffix) ? key.slice(0, -fullSuffix.length) : '';
}

export function pruneSupersededProductPageSnapshots(store = {}, fullSnapshotKey = '') {
  const baseKey = getFullProductSnapshotBaseKey(fullSnapshotKey);
  if (!baseKey || !isPlainObject(store?.snapshots)) return 0;

  const basePrefix = `${baseKey}:`.toLowerCase();
  const fullKey = normalizeText(fullSnapshotKey).toLowerCase();
  let removed = 0;
  Object.entries(store.snapshots).forEach(([snapshotKey, snapshot]) => {
    const normalizedSnapshotKey = normalizeText(snapshotKey).toLowerCase();
    if (normalizedSnapshotKey === fullKey) return;
    if (snapshot?.type !== SNAPSHOT_TYPE_PRODUCT) return;
    if (!normalizedSnapshotKey.startsWith(basePrefix)) return;
    delete store.snapshots[snapshotKey];
    removed += 1;
  });
  return removed;
}

export function pruneSupersededProductPageSnapshotsForFullSnapshots(store = {}) {
  if (!isPlainObject(store?.snapshots)) return 0;
  return Object.entries(store.snapshots).reduce((removed, [snapshotKey, snapshot]) => {
    if (snapshot?.type !== SNAPSHOT_TYPE_PRODUCT) return removed;
    if (!Array.isArray(snapshot?.productKeys)) return removed;
    if (!getFullProductSnapshotBaseKey(snapshotKey)) return removed;
    return removed + pruneSupersededProductPageSnapshots(store, snapshotKey);
  }, 0);
}
