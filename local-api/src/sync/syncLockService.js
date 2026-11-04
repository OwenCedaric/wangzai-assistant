function nowIso() {
  return new Date().toISOString();
}

function addMs(ms) {
  return new Date(Date.now() + Math.max(1, Number(ms) || 60_000)).toISOString();
}

function normalizeText(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function buildLockKey(input = {}) {
  if (input.lockKey) return input.lockKey;
  const domain = normalizeText(input.domain, 'unknown');
  const shopId = normalizeText(input.shopId);
  if (!shopId) {
    const error = new Error('Ozon sync locks require an exact shopId.');
    error.code = 'OZON_SYNC_LOCK_SHOP_SCOPE_REQUIRED';
    throw error;
  }
  const cacheKey = normalizeText(input.cacheKey, 'default');
  return `${domain}::${shopId}::${cacheKey}`;
}

function toPublicLock(row) {
  if (!row) return null;
  return {
    lockKey: row.lock_key,
    ownerJobId: row.owner_job_id || null,
    domain: row.domain,
    shopId: row.shop_id || null,
    cacheKey: row.cache_key || null,
    status: row.status,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at || null,
    releasedAt: row.released_at || null,
    reusedJobId: row.reused_job_id || row.owner_job_id || null,
  };
}

export function createSyncLockService(db) {
  if (!db) throw new Error('createSyncLockService requires db.');

  function getRaw(lockKey) {
    return db.prepare('SELECT * FROM ozon_sync_locks WHERE lock_key = ?').get(lockKey) || null;
  }

  function isActive(row) {
    return row?.status === 'active' && Date.parse(row.expires_at) > Date.now();
  }

  return {
    buildLockKey,

    acquire(input = {}) {
      const lockKey = buildLockKey(input);
      const ownerJobId = normalizeText(input.ownerJobId || input.owner || input.jobId, 'unknown');
      const ttlMs = Number(input.ttlMs) || 120_000;
      const existing = getRaw(lockKey);
      if (isActive(existing)) {
        return {
          acquired: false,
          lock: toPublicLock(existing),
          existingJobId: existing.owner_job_id || null,
          reason: 'active_lock_exists',
        };
      }

      const timestamp = nowIso();
      const expiresAt = addMs(ttlMs);
      db.prepare(`
        INSERT INTO ozon_sync_locks (
          lock_key, owner_job_id, domain, shop_id, cache_key, status,
          acquired_at, expires_at, heartbeat_at, released_at, reused_job_id
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, NULL)
        ON CONFLICT(lock_key) DO UPDATE SET
          owner_job_id = excluded.owner_job_id,
          domain = excluded.domain,
          shop_id = excluded.shop_id,
          cache_key = excluded.cache_key,
          status = 'active',
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at,
          heartbeat_at = excluded.heartbeat_at,
          released_at = NULL,
          reused_job_id = NULL
      `).run(
        lockKey,
        ownerJobId,
        normalizeText(input.domain, 'unknown'),
        input.shopId || null,
        input.cacheKey || null,
        timestamp,
        expiresAt,
        timestamp,
      );
      return { acquired: true, lock: toPublicLock(getRaw(lockKey)), existingJobId: null };
    },

    heartbeat(lockKeyOrInput, ttlMs = 120_000) {
      const lockKey = typeof lockKeyOrInput === 'string' ? lockKeyOrInput : buildLockKey(lockKeyOrInput);
      const timestamp = nowIso();
      const result = db.prepare(`
        UPDATE ozon_sync_locks
        SET heartbeat_at = ?, expires_at = ?
        WHERE lock_key = ? AND status = 'active'
      `).run(timestamp, addMs(ttlMs), lockKey);
      return { ok: result.changes > 0, lock: toPublicLock(getRaw(lockKey)) };
    },

    release(lockKeyOrInput, ownerJobId = null) {
      const lockKey = typeof lockKeyOrInput === 'string' ? lockKeyOrInput : buildLockKey(lockKeyOrInput);
      const existing = getRaw(lockKey);
      if (!existing) return { released: false, lockKey, reason: 'not_found' };
      if (ownerJobId && existing.owner_job_id && existing.owner_job_id !== ownerJobId) {
        return { released: false, lockKey, reason: 'owner_mismatch', ownerJobId: existing.owner_job_id };
      }
      const timestamp = nowIso();
      db.prepare(`
        UPDATE ozon_sync_locks
        SET status = 'released', released_at = ?, heartbeat_at = ?
        WHERE lock_key = ?
      `).run(timestamp, timestamp, lockKey);
      return { released: true, lock: toPublicLock(getRaw(lockKey)) };
    },

    markExpiredLocks() {
      const timestamp = nowIso();
      const result = db.prepare(`
        UPDATE ozon_sync_locks
        SET status = 'expired'
        WHERE status = 'active' AND expires_at <= ?
      `).run(timestamp);
      return { expired: result.changes };
    },

    get(lockKeyOrInput) {
      const lockKey = typeof lockKeyOrInput === 'string' ? lockKeyOrInput : buildLockKey(lockKeyOrInput);
      return toPublicLock(getRaw(lockKey));
    },

    listLocks(filters = {}) {
      const rows = db.prepare(`
        SELECT * FROM ozon_sync_locks
        WHERE (? IS NULL OR domain = ?)
          AND (? IS NULL OR shop_id = ?)
          AND (? IS NULL OR status = ?)
        ORDER BY acquired_at DESC
        LIMIT ?
      `).all(
        filters.domain || null,
        filters.domain || null,
        filters.shopId || null,
        filters.shopId || null,
        filters.status || null,
        filters.status || null,
        Math.min(Number(filters.limit) || 100, 500),
      );
      return rows.map(toPublicLock);
    },
  };
}
