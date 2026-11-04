import { createHotCacheService } from './hotCacheService.js';

function parsePayload(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function toPublicCacheRow(row, { includePayload = true } = {}) {
  return {
    id: row.id,
    domain: row.domain,
    shopId: row.shop_id || null,
    endpointKey: row.endpoint_key,
    cacheKey: row.cache_key,
    remoteHash: row.remote_hash || null,
    status: row.status,
    isStale: Boolean(row.is_stale),
    staleReason: row.stale_reason || null,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at || null,
    payload: includePayload ? parsePayload(row.payload_json) : undefined,
  };
}

function normalizePage(value) {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function normalizePageSize(value) {
  const pageSize = Number(value);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return 20;
  return Math.min(Math.floor(pageSize), 100);
}

function createSyncStateSnapshot(db, domain, filters = {}) {
  const rows = db.prepare(`
    SELECT domain, shop_id, scope_key, status, last_success_at, last_attempt_at,
           last_error, changed_count, unchanged_count, stale_count, updated_at
    FROM ozon_sync_state
    WHERE domain = ? AND (? IS NULL OR shop_id = ?)
    ORDER BY updated_at DESC
    LIMIT 20
  `).all(domain, filters.shopId || null, filters.shopId || null);
  return rows.map((row) => ({
    domain: row.domain,
    shopId: row.shop_id || null,
    scopeKey: row.scope_key,
    status: row.status,
    lastSuccessAt: row.last_success_at || null,
    lastAttemptAt: row.last_attempt_at || null,
    lastError: row.last_error || null,
    changedCount: row.changed_count,
    unchangedCount: row.unchanged_count,
    staleCount: row.stale_count,
    updatedAt: row.updated_at,
  }));
}

export function createCacheReadService(db, options = {}) {
  const hotCache = options.hotCache || createHotCacheService(options.hotCacheOptions || {});

  function readSqliteDomainCache(domain, filters = {}) {
    const started = Date.now();
    const page = normalizePage(filters.page);
    const pageSize = normalizePageSize(filters.pageSize || filters.limit);
    const offset = (page - 1) * pageSize;
    const total = db.prepare(`
      SELECT COUNT(*) AS count FROM ozon_response_cache
      WHERE domain = ?
        AND (? IS NULL OR shop_id = ?)
        AND (? IS NULL OR cache_key = ?)
    `).get(domain, filters.shopId || null, filters.shopId || null, filters.cacheKey || null, filters.cacheKey || null).count;

    const rows = db.prepare(`
      SELECT * FROM ozon_response_cache
      WHERE domain = ?
        AND (? IS NULL OR shop_id = ?)
        AND (? IS NULL OR cache_key = ?)
      ORDER BY updated_at DESC, cache_key ASC
      LIMIT ? OFFSET ?
    `).all(
      domain,
      filters.shopId || null,
      filters.shopId || null,
      filters.cacheKey || null,
      filters.cacheKey || null,
      pageSize,
      offset,
    ).map((row) => toPublicCacheRow(row));

    const stale = rows.some((row) => row.isStale || row.status === 'stale');
    return {
      ok: true,
      domain,
      source: 'sqlite',
      stale,
      rows,
      page,
      pageSize,
      total,
      syncState: createSyncStateSnapshot(db, domain, filters),
      durationMs: Date.now() - started,
    };
  }

  return {
    readDomainCache(domain, filters = {}) {
      const started = Date.now();
      const page = normalizePage(filters.page);
      const pageSize = normalizePageSize(filters.pageSize || filters.limit);
      const shopId = String(filters.shopId || '').trim();
      const cacheKey = shopId
        ? hotCache.buildKey({
            domain,
            shopId,
            cacheKey: filters.cacheKey,
            page,
            pageSize,
            contractVersion: filters.contractVersion,
            schemaVersion: filters.schemaVersion,
            mapperVersion: filters.mapperVersion,
            snapshotVersion: filters.snapshotVersion,
          })
        : '';
      if (cacheKey) {
        const memory = hotCache.get(cacheKey);
        if (memory) {
          return { ...memory, durationMs: Date.now() - started };
        }
      }
      const result = readSqliteDomainCache(domain, { ...filters, page, pageSize });
      if (cacheKey) {
        hotCache.set(cacheKey, { ...result, source: 'memory' }, {
          tags: [`domain:${domain}`, `shop:${shopId}`],
        });
      } else {
        result.aggregate = true;
        result.aggregateMode = 'sqlite-shop-rows';
      }
      return result;
    },

    getCacheRow(domain, cacheKey, shopId = null) {
      const row = db.prepare(`
        SELECT * FROM ozon_response_cache
        WHERE domain = ? AND COALESCE(shop_id, '') = COALESCE(?, '') AND cache_key = ?
      `).get(domain, shopId, cacheKey);
      return row ? toPublicCacheRow(row) : null;
    },

    isCacheFresh(domain, cacheKey, shopId = null) {
      const row = db.prepare(`
        SELECT * FROM ozon_response_cache
        WHERE domain = ? AND COALESCE(shop_id, '') = COALESCE(?, '') AND cache_key = ?
      `).get(domain, shopId, cacheKey);
      if (!row || row.is_stale) return { fresh: false, row: row ? toPublicCacheRow(row) : null };
      if (!row.expires_at) return { fresh: true, row: toPublicCacheRow(row) };
      return { fresh: Date.parse(row.expires_at) > Date.now(), row: toPublicCacheRow(row) };
    },

    hotCache,
  };
}
