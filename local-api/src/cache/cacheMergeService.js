import { randomUUID } from 'node:crypto';
import { createStableHash } from '../utils/stableHash.js';
import { createCacheCleanupService } from './cacheCleanupService.js';

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function isEmptyOverwrite(value) {
  return value === null || value === undefined || value === '';
}

export function mergePreservingLocalRules(existingValue, nextValue) {
  if (Array.isArray(existingValue) || Array.isArray(nextValue)) {
    return nextValue === undefined ? existingValue : nextValue;
  }

  if (!existingValue || typeof existingValue !== 'object' || !nextValue || typeof nextValue !== 'object') {
    return isEmptyOverwrite(nextValue) ? existingValue : nextValue;
  }

  const merged = { ...existingValue };
  for (const [key, value] of Object.entries(nextValue)) {
    if (isEmptyOverwrite(value) && !isEmptyOverwrite(existingValue[key])) {
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged[key] = mergePreservingLocalRules(existingValue[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function toCacheRow(row) {
  return {
    id: row.id,
    domain: row.domain,
    shopId: row.shop_id || null,
    endpointKey: row.endpoint_key,
    cacheKey: row.cache_key,
    payloadHash: row.payload_hash || null,
    responseHash: row.response_hash || null,
    remoteHash: row.remote_hash || null,
    status: row.status,
    isStale: Boolean(row.is_stale),
    staleReason: row.stale_reason || null,
    expiresAt: row.expires_at || null,
    lastSeenAt: row.last_seen_at || null,
    updatedAt: row.updated_at,
    payload: parseJson(row.payload_json),
  };
}

export function createCacheMergeService(db, options = {}) {
  const cleanupService = createCacheCleanupService(db, options.cleanupPolicy || options);
  const cleanupEveryWrites = Math.max(Number(options.cleanupEveryWrites ?? options.cleanup?.everyWrites ?? 50) || 50, 1);
  let responseCacheWriteCount = 0;

  function maybeCleanupResponseCache() {
    responseCacheWriteCount += 1;
    if (responseCacheWriteCount < cleanupEveryWrites) {
      return { ok: true, skipped: true, writesSinceCleanup: responseCacheWriteCount, cleanupEveryWrites };
    }
    responseCacheWriteCount = 0;
    return cleanupService.cleanupResponseCache();
  }

  function logMerge(entry = {}) {
    db.prepare(`
      INSERT INTO ozon_cache_merge_log (
        id, domain, shop_id, cache_key, merge_status, old_remote_hash,
        new_remote_hash, reason, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      entry.domain || 'unknown',
      entry.shopId || null,
      entry.cacheKey,
      entry.mergeStatus,
      entry.oldRemoteHash || null,
      entry.newRemoteHash || null,
      entry.reason || null,
      nowIso(),
    );
  }

  return {
    mergeResponse(entry = {}) {
      const domain = entry.domain || 'unknown';
      const cacheKey = entry.cacheKey;
      if (!cacheKey) {
        throw new Error('cacheMergeService.mergeResponse requires cacheKey.');
      }

      const nextPayload = entry.payload ?? null;
      const nextRemoteHash = entry.remoteHash || createStableHash(nextPayload, { length: 32 });
      const responseHash = createStableHash(nextPayload, { length: 32 });
      const payloadHash = entry.payloadHash || createStableHash(entry.params || {}, { length: 32 });
      const timestamp = nowIso();
      const existing = db.prepare(`
        SELECT * FROM ozon_response_cache
        WHERE domain = ? AND COALESCE(shop_id, '') = COALESCE(?, '') AND cache_key = ?
      `).get(domain, entry.shopId || null, cacheKey);

      if (existing?.remote_hash && existing.remote_hash === nextRemoteHash) {
        db.prepare(`
          UPDATE ozon_response_cache
          SET last_seen_at = ?, updated_at = ?, is_stale = 0, stale_reason = NULL
          WHERE id = ?
        `).run(timestamp, timestamp, existing.id);
        logMerge({ ...entry, mergeStatus: 'unchanged', oldRemoteHash: existing.remote_hash, newRemoteHash: nextRemoteHash, reason: 'remote_hash unchanged' });
        return { status: 'unchanged', row: toCacheRow({ ...existing, last_seen_at: timestamp, updated_at: timestamp, is_stale: 0, stale_reason: null }) };
      }

      if (existing?.status === 'confirmed' && entry.status === 'partial') {
        logMerge({ ...entry, mergeStatus: 'skipped', oldRemoteHash: existing.remote_hash, newRemoteHash: nextRemoteHash, reason: 'partial cannot overwrite confirmed' });
        return { status: 'skipped', reason: 'partial_cannot_overwrite_confirmed', row: toCacheRow(existing) };
      }

      const mergedPayload = existing ? mergePreservingLocalRules(parseJson(existing.payload_json), nextPayload) : nextPayload;
      const payloadJson = JSON.stringify(mergedPayload ?? null);
      const rowId = existing?.id || randomUUID();
      const mergeStatus = existing ? 'updated' : 'inserted';

      db.prepare(`
        INSERT INTO ozon_response_cache (
          id, domain, shop_id, endpoint_key, cache_key, payload_hash,
          response_hash, remote_hash, status, is_stale, stale_reason,
          expires_at, last_seen_at, updated_at, payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)
        ON CONFLICT(domain, shop_id, cache_key) DO UPDATE SET
          endpoint_key = excluded.endpoint_key,
          payload_hash = excluded.payload_hash,
          response_hash = excluded.response_hash,
          remote_hash = excluded.remote_hash,
          status = excluded.status,
          is_stale = 0,
          stale_reason = NULL,
          expires_at = excluded.expires_at,
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json
      `).run(
        rowId,
        domain,
        entry.shopId || null,
        entry.endpointKey || 'unknown',
        cacheKey,
        payloadHash,
        responseHash,
        nextRemoteHash,
        entry.status || 'confirmed',
        entry.expiresAt || null,
        timestamp,
        timestamp,
        payloadJson,
      );

      const row = db.prepare('SELECT * FROM ozon_response_cache WHERE id = ?').get(rowId);
      logMerge({ ...entry, mergeStatus, oldRemoteHash: existing?.remote_hash || null, newRemoteHash: nextRemoteHash, reason: mergeStatus });
      const cleanup = maybeCleanupResponseCache();
      return { status: mergeStatus, row: toCacheRow(row), cleanup };
    },

    logMerge,
    mergePreservingLocalRules,
    cleanupResponseCache: () => cleanupService.cleanupResponseCache(),
  };
}
