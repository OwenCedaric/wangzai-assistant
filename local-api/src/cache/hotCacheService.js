const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

function nowMs() {
  return Date.now();
}

function safeJsonSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch (_error) {
    return Number.MAX_SAFE_INTEGER;
  }
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeTags(value) {
  return new Set(
    (Array.isArray(value) ? value : [value])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
}

function normalizeKeyPart(value, fallback) {
  const text = String(value ?? '').trim();
  return text || fallback;
}

/**
 * 进程内 L1：有明确容量/对象预算的 LRU，不承担持久化或业务真相。
 * 这里仅保存 DTO 查询结果；SQLite 仍是 L2 当前快照和唯一可恢复来源。
 */
export function createHotCacheService(options = {}) {
  const maxEntries = normalizePositiveInteger(options.maxEntries, 200);
  const ttlMs = normalizePositiveInteger(options.ttlMs, 5_000);
  const maxPayloadBytes = normalizePositiveInteger(options.maxPayloadBytes, 256 * 1024);
  const maxBytes = normalizePositiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
  const store = new Map();
  let totalBytes = 0;
  const metrics = {
    hits: 0,
    misses: 0,
    expired: 0,
    evictions: 0,
    invalidations: 0,
    rejectedPayloads: 0,
  };

  function remove(key, reason = '') {
    const entry = store.get(key);
    if (!entry) return false;
    store.delete(key);
    totalBytes = Math.max(0, totalBytes - entry.sizeBytes);
    if (reason === 'eviction') metrics.evictions += 1;
    if (reason === 'invalidation') metrics.invalidations += 1;
    if (reason === 'expired') metrics.expired += 1;
    return true;
  }

  function evictIfNeeded() {
    while (store.size > maxEntries || totalBytes > maxBytes) {
      const oldestKey = store.keys().next().value;
      if (!oldestKey) break;
      remove(oldestKey, 'eviction');
    }
  }

  function matches(entry, key, options = {}) {
    const tags = normalizeTags(options.tags);
    const predicate = typeof options.predicate === 'function' ? options.predicate : null;
    const tagMatches = tags.size > 0 && [...tags].some((tag) => entry.tags.has(tag));
    return tagMatches || Boolean(predicate?.({ key, tags: [...entry.tags], expiresAt: entry.expiresAt }));
  }

  return {
    buildKey(input = {}) {
      const profileId = normalizeKeyPart(input.profileId, 'current');
      const shopId = normalizeKeyPart(input.shopId, 'global');
      const operation = normalizeKeyPart(input.operation || input.domain, 'unknown');
      const query = normalizeKeyPart(input.queryKey || input.cacheKey, 'all');
      const contractVersion = normalizeKeyPart(input.contractVersion, 'v1');
      const schemaVersion = normalizeKeyPart(input.schemaVersion, 'v1');
      const mapperVersion = normalizeKeyPart(input.mapperVersion, 'v1');
      const snapshotVersion = normalizeKeyPart(input.snapshotVersion, 'current');
      const page = normalizeKeyPart(input.page, '1');
      const pageSize = normalizeKeyPart(input.pageSize, '20');
      return [
        profileId,
        shopId,
        operation,
        query,
        contractVersion,
        schemaVersion,
        mapperVersion,
        snapshotVersion,
        page,
        pageSize,
      ].join('::');
    },

    get(key) {
      const entry = store.get(key);
      if (!entry) {
        metrics.misses += 1;
        return null;
      }
      if (entry.expiresAt <= nowMs()) {
        remove(key, 'expired');
        metrics.misses += 1;
        return null;
      }
      metrics.hits += 1;
      store.delete(key);
      store.set(key, entry);
      return { ...entry.value, source: 'memory' };
    },

    set(key, value, setOptions = {}) {
      const sizeBytes = safeJsonSize(value);
      if (sizeBytes > maxPayloadBytes) {
        metrics.rejectedPayloads += 1;
        return { cached: false, reason: 'payload_too_large', sizeBytes };
      }
      if (sizeBytes > maxBytes) {
        metrics.rejectedPayloads += 1;
        return { cached: false, reason: 'cache_budget_exceeded', sizeBytes };
      }
      remove(key);
      store.set(key, {
        value,
        sizeBytes,
        tags: normalizeTags(setOptions.tags),
        expiresAt: nowMs() + normalizePositiveInteger(setOptions.ttlMs, ttlMs),
      });
      totalBytes += sizeBytes;
      evictIfNeeded();
      return { cached: store.has(key), sizeBytes };
    },

    invalidate(options = {}) {
      let removed = 0;
      for (const [key, entry] of [...store.entries()]) {
        if (matches(entry, key, options)) {
          if (remove(key, 'invalidation')) removed += 1;
        }
      }
      return { ok: true, removed };
    },

    count(options = {}) {
      let entries = 0;
      for (const [key, entry] of store.entries()) {
        if (matches(entry, key, options)) entries += 1;
      }
      return entries;
    },

    clear() {
      const removed = store.size;
      store.clear();
      totalBytes = 0;
      return { ok: true, removed };
    },

    getStatus() {
      const requests = metrics.hits + metrics.misses;
      return {
        ok: true,
        entries: store.size,
        totalBytes,
        maxEntries,
        maxBytes,
        ttlMs,
        maxPayloadBytes,
        metrics: {
          ...metrics,
          hitRate: requests ? Number((metrics.hits / requests).toFixed(4)) : null,
        },
      };
    },
  };
}
