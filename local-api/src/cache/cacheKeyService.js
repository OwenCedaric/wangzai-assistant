import { randomUUID } from 'node:crypto';
import { createStableHash, stableStringify } from '../utils/stableHash.js';

function normalizePart(value, fallback = 'none') {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

export function hashCacheParams(params = {}) {
  return createStableHash(params, { length: 32 });
}

export function buildOzonCacheKey(input = {}) {
  const domain = normalizePart(input.domain, 'unknown');
  const shopId = normalizePart(input.shopId ?? input.shop_id, '');
  if (!shopId) {
    const error = new Error('Ozon cache keys require an exact shopId.');
    error.code = 'OZON_CACHE_SHOP_SCOPE_REQUIRED';
    throw error;
  }
  const endpointKey = normalizePart(input.endpointKey ?? input.endpoint_key, 'none');
  const action = normalizePart(input.action, 'read');
  const paramsHash = normalizePart(input.paramsHash ?? input.params_hash ?? hashCacheParams(input.params || {}), 'none');
  return ['ozon', domain, `shop:${shopId}`, endpointKey, action, `params:${paramsHash}`].join(':');
}

function toPublicCacheKey(row) {
  return {
    cacheKey: row.cache_key,
    domain: row.domain,
    shopId: row.shop_id || null,
    endpointKey: row.endpoint_key || null,
    scopeKey: row.scope_key || null,
    paramsHash: row.params_hash || null,
    policy: row.policy,
    allowStale: Boolean(row.allow_stale),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createCacheKeyService(db) {
  return {
    buildCacheKey(input = {}) {
      return buildOzonCacheKey(input);
    },

    registerCacheKey(input = {}) {
      const cacheKey = input.cacheKey || buildOzonCacheKey(input);
      const paramsHash = input.paramsHash || hashCacheParams(input.params || {});
      const timestamp = new Date().toISOString();
      db.prepare(`
        INSERT INTO ozon_cache_keys (
          cache_key, domain, shop_id, endpoint_key, scope_key, params_hash,
          policy, allow_stale, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          domain = excluded.domain,
          shop_id = excluded.shop_id,
          endpoint_key = excluded.endpoint_key,
          scope_key = excluded.scope_key,
          params_hash = excluded.params_hash,
          policy = excluded.policy,
          allow_stale = excluded.allow_stale,
          updated_at = excluded.updated_at
      `).run(
        cacheKey,
        input.domain || 'unknown',
        input.shopId || null,
        input.endpointKey || null,
        input.scopeKey || null,
        paramsHash,
        input.policy || 'entity_snapshot',
        input.allowStale === false ? 0 : 1,
        timestamp,
        timestamp,
      );
      return this.getCacheKey(cacheKey);
    },

    getCacheKey(cacheKey) {
      const row = db.prepare('SELECT * FROM ozon_cache_keys WHERE cache_key = ?').get(cacheKey);
      return row ? toPublicCacheKey(row) : null;
    },

    listCacheKeys(filters = {}) {
      const rows = db.prepare(`
        SELECT * FROM ozon_cache_keys
        WHERE (? IS NULL OR domain = ?)
          AND (? IS NULL OR shop_id = ?)
        ORDER BY updated_at DESC, cache_key ASC
        LIMIT ?
      `).all(
        filters.domain || null,
        filters.domain || null,
        filters.shopId || null,
        filters.shopId || null,
        Math.min(Number(filters.limit) || 100, 500),
      );
      return rows.map(toPublicCacheKey);
    },

    createEphemeralKey(prefix = 'cache') {
      return `${prefix}_${randomUUID()}`;
    },

    stableStringify,
  };
}
