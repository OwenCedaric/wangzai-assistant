import { createStableHash } from '../../utils/stableHash.js';

const DATA_ANALYSIS_DOMAIN = 'data-analysis';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value, fallback = '') {
  const text = value == null ? '' : String(value).trim();
  return text || fallback;
}

function normalizeOptionalText(value) {
  const text = normalizeText(value);
  return text || null;
}

function normalizeLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(number), MAX_LIMIT));
}

function normalizeOffset(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

function hasOwn(input, key) {
  return Object.prototype.hasOwnProperty.call(input || {}, key);
}

function stringifyJson(value) {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify({ text: value });
    }
  }
  return JSON.stringify(value && typeof value === 'object' ? value : {});
}

function stringifyNullableJson(value) {
  return value == null ? 'null' : stringifyJson(value);
}

function parseJson(text, fallback = {}) {
  try {
    return JSON.parse(text || '');
  } catch {
    return fallback;
  }
}

function createCacheKey({ shopId = '', analysisType = 'general', sourceType = 'manual', sourceKey = '' } = {}) {
  return [
    DATA_ANALYSIS_DOMAIN,
    normalizeText(shopId, 'all'),
    normalizeText(analysisType, 'general'),
    normalizeText(sourceType, 'manual'),
    normalizeText(sourceKey, 'default'),
  ].join(':');
}

function createSyncCacheKey({ shopId = '', analysisType = 'all' } = {}) {
  return [DATA_ANALYSIS_DOMAIN, normalizeText(shopId, 'all'), normalizeText(analysisType, 'all'), 'sync'].join(':');
}

function toPublicSnapshot(row = {}) {
  const summary = parseJson(row.summary_json, {});
  const metrics = parseJson(row.metrics_json, {});
  const payload = parseJson(row.payload_json, {});
  return {
    id: row.id,
    shopId: row.shop_id || '',
    analysisType: row.analysis_type,
    sourceType: row.source_type,
    sourceKey: row.source_key,
    title: row.title,
    status: row.status,
    timeRange: {
      start: row.time_range_start || null,
      end: row.time_range_end || null,
    },
    rowCount: Number(row.row_count) || 0,
    cacheKey: row.cache_key,
    remoteHash: row.remote_hash || '',
    summary,
    metrics,
    payload,
    sourceStatus: row.source_status,
    sourceSyncedAt: row.source_synced_at || null,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublicSyncState(row, query = {}) {
  if (!row) {
    return {
      cacheKey: createSyncCacheKey(query),
      shopId: normalizeText(query.shopId || query.shop_id),
      analysisType: normalizeText(query.analysisType || query.analysis_type, 'all'),
      status: 'idle',
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      changedCount: 0,
      unchangedCount: 0,
      deletedCount: 0,
      updatedAt: null,
    };
  }
  const lastError = parseJson(row.last_error_json, null);
  return {
    cacheKey: row.cache_key,
    shopId: row.shop_id || '',
    analysisType: row.analysis_type || 'all',
    status: row.status || 'idle',
    lastSuccessAt: row.last_success_at || null,
    lastAttemptAt: row.last_attempt_at || null,
    lastError,
    changedCount: Number(row.changed_count) || 0,
    unchangedCount: Number(row.unchanged_count) || 0,
    deletedCount: Number(row.deleted_count) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildSnapshotFilters(query = {}) {
  const clauses = [];
  const params = [];
  const shopId = normalizeText(query.shopId || query.shop_id);
  const analysisType = normalizeText(query.analysisType || query.analysis_type);
  const sourceType = normalizeText(query.sourceType || query.source_type);
  const sourceKey = normalizeText(query.sourceKey || query.source_key);
  const search = normalizeText(query.search || query.keyword);

  if (query.legacyGlobalOnly === true || query.legacy_global_only === true || query.legacy_global_only === '1') {
    clauses.push("shop_id = ''");
  }

  if (shopId && shopId !== 'all' && !(query.legacyGlobalOnly === true || query.legacy_global_only === true || query.legacy_global_only === '1')) {
    clauses.push('shop_id = ?');
    params.push(shopId);
  }
  if (analysisType && analysisType !== 'all') {
    clauses.push('analysis_type = ?');
    params.push(analysisType);
  }
  if (sourceType && sourceType !== 'all') {
    clauses.push('source_type = ?');
    params.push(sourceType);
  }
  if (sourceKey) {
    clauses.push('source_key = ?');
    params.push(sourceKey);
  }
  if (search) {
    clauses.push('(title LIKE ? OR source_key LIKE ? OR summary_json LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  // The ordinary business dashboard must never drag the very large browser
  // market snapshot into its response. Market reads always opt in with their
  // exact analysis/source type; an `all` business read is intentionally kept
  // compact so an unscoped legacy capture cannot block every shop page.
  const explicitMarketRead = analysisType === 'ozon-browser-market' || sourceType === 'ozon-browser-capture';
  if (!explicitMarketRead && (!analysisType || analysisType === 'all') && (!sourceType || sourceType === 'all')) {
    clauses.push("analysis_type NOT IN ('ozon-browser-market', 'dashboard')");
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function normalizeSnapshotInput(input = {}) {
  const shopId = normalizeText(input.shopId ?? input.shop_id);
  const analysisType = normalizeText(input.analysisType ?? input.analysis_type, 'general');
  const sourceType = normalizeText(input.sourceType ?? input.source_type, 'manual');
  const sourceKey = normalizeText(input.sourceKey ?? input.source_key, 'default');
  const title = normalizeText(input.title, `${analysisType} 分析缓存`);
  const rowCountValue = Number(input.rowCount ?? input.row_count);
  const rowCount = Number.isFinite(rowCountValue) && rowCountValue > 0 ? Math.floor(rowCountValue) : 0;
  const summaryJson = stringifyJson(input.summary ?? input.summaryJson ?? input.summary_json);
  const metricsJson = stringifyJson(input.metrics ?? input.metricsJson ?? input.metrics_json);
  const payloadJson = stringifyJson(input.payload ?? input.payloadJson ?? input.payload_json);
  const cacheKey = normalizeText(input.cacheKey ?? input.cache_key, createCacheKey({ shopId, analysisType, sourceType, sourceKey }));
  const remoteHash =
    normalizeText(input.remoteHash ?? input.remote_hash) ||
    createStableHash({ shopId, analysisType, sourceType, sourceKey, summaryJson, metricsJson, payloadJson }, { length: 32 });
  const seenAt = normalizeText(input.lastSeenAt ?? input.last_seen_at, nowIso());
  const updatedAt = normalizeText(input.updatedAt ?? input.updated_at, seenAt);

  return {
    id: normalizeText(input.id, createStableHash(cacheKey, { length: 24 })),
    shopId,
    analysisType,
    sourceType,
    sourceKey,
    title,
    status: normalizeText(input.status, 'cached'),
    timeRangeStart: normalizeOptionalText(input.timeRangeStart ?? input.time_range_start ?? input.timeRange?.start),
    timeRangeEnd: normalizeOptionalText(input.timeRangeEnd ?? input.time_range_end ?? input.timeRange?.end),
    rowCount,
    cacheKey,
    remoteHash,
    summaryJson,
    metricsJson,
    payloadJson,
    sourceStatus: normalizeText(input.sourceStatus ?? input.source_status, 'local_cache'),
    sourceSyncedAt: normalizeOptionalText(input.sourceSyncedAt ?? input.source_synced_at),
    lastSeenAt: seenAt,
    createdAt: normalizeText(input.createdAt ?? input.created_at, updatedAt),
    updatedAt,
  };
}

export function createDataAnalysisRepository(db) {
  if (!db) {
    throw new Error('createDataAnalysisRepository requires a DatabaseSync instance.');
  }

  return {
    getDashboardSnapshot(query = {}) {
      const shopId = normalizeText(query.shopId || query.shop_id);
      const startDate = normalizeOptionalText(query.startDate || query.start_date || query.dateFrom);
      const endDate = normalizeOptionalText(query.endDate || query.end_date || query.dateTo);
      const row = db
        .prepare(
          `
            SELECT *
            FROM data_analysis_snapshots
            WHERE shop_id = ?
              AND analysis_type = 'dashboard'
              AND source_type = 'derived-sqlite'
              AND COALESCE(time_range_start, '') = COALESCE(?, '')
              AND COALESCE(time_range_end, '') = COALESCE(?, '')
            ORDER BY updated_at DESC, id ASC
            LIMIT 1
          `,
        )
        .get(shopId, startDate, endDate);
      return row ? toPublicSnapshot(row) : null;
    },

    listSnapshots(query = {}) {
      const limit = normalizeLimit(query.limit);
      const offset = normalizeOffset(query.offset);
      const { whereSql, params } = buildSnapshotFilters(query);
      const rows = db
        .prepare(
          `
            SELECT *
            FROM data_analysis_snapshots
            ${whereSql}
            ORDER BY updated_at DESC, id ASC
            LIMIT ? OFFSET ?
          `,
        )
        .all(...params, limit, offset);
      const totalRow = db
        .prepare(
          `
            SELECT COUNT(*) AS total
            FROM data_analysis_snapshots
            ${whereSql}
          `,
        )
        .get(...params);

      return {
        rows: rows.map(toPublicSnapshot),
        total: Number(totalRow?.total) || 0,
        limit,
        offset,
      };
    },

    getStats(query = {}) {
      const { whereSql, params } = buildSnapshotFilters({
        shopId: query.shopId || query.shop_id,
      });
      const byAnalysisType = db
        .prepare(
          `
            SELECT analysis_type AS type, COUNT(*) AS count, SUM(row_count) AS row_count, MAX(updated_at) AS updated_at
            FROM data_analysis_snapshots
            ${whereSql}
            GROUP BY analysis_type
            ORDER BY updated_at DESC, type ASC
          `,
        )
        .all(...params)
        .map((row) => ({
          type: row.type,
          count: Number(row.count) || 0,
          rowCount: Number(row.row_count) || 0,
          updatedAt: row.updated_at || null,
        }));
      const bySourceType = db
        .prepare(
          `
            SELECT source_type AS type, COUNT(*) AS count, SUM(row_count) AS row_count, MAX(updated_at) AS updated_at
            FROM data_analysis_snapshots
            ${whereSql}
            GROUP BY source_type
            ORDER BY updated_at DESC, type ASC
          `,
        )
        .all(...params)
        .map((row) => ({
          type: row.type,
          count: Number(row.count) || 0,
          rowCount: Number(row.row_count) || 0,
          updatedAt: row.updated_at || null,
        }));
      const totalRow = db
        .prepare(
          `
            SELECT COUNT(*) AS total, SUM(row_count) AS row_count, MAX(updated_at) AS latest_updated_at
            FROM data_analysis_snapshots
            ${whereSql}
          `,
        )
        .get(...params);

      return {
        total: Number(totalRow?.total) || 0,
        rowCount: Number(totalRow?.row_count) || 0,
        latestUpdatedAt: totalRow?.latest_updated_at || null,
        byAnalysisType,
        bySourceType,
      };
    },

    getSyncState(query = {}) {
      const shopId = normalizeText(query.shopId || query.shop_id);
      const analysisType = normalizeText(query.analysisType || query.analysis_type, 'all');
      const cacheKey = normalizeText(query.cacheKey || query.cache_key, createSyncCacheKey({ shopId, analysisType }));
      const row = db
        .prepare(
          `
            SELECT *
            FROM data_analysis_sync_state
            WHERE cache_key = ?
            LIMIT 1
          `,
        )
        .get(cacheKey);
      return toPublicSyncState(row, { shopId, analysisType });
    },

    upsertSnapshot(input = {}) {
      const snapshot = normalizeSnapshotInput(input);
      db.prepare(
        `
          INSERT INTO data_analysis_snapshots (
            id,
            shop_id,
            analysis_type,
            source_type,
            source_key,
            title,
            status,
            time_range_start,
            time_range_end,
            row_count,
            cache_key,
            remote_hash,
            summary_json,
            metrics_json,
            payload_json,
            source_status,
            source_synced_at,
            last_seen_at,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(shop_id, analysis_type, source_type, source_key)
          DO UPDATE SET
            title = excluded.title,
            status = excluded.status,
            time_range_start = excluded.time_range_start,
            time_range_end = excluded.time_range_end,
            row_count = excluded.row_count,
            cache_key = excluded.cache_key,
            remote_hash = excluded.remote_hash,
            summary_json = excluded.summary_json,
            metrics_json = excluded.metrics_json,
            payload_json = excluded.payload_json,
            source_status = excluded.source_status,
            source_synced_at = excluded.source_synced_at,
            last_seen_at = excluded.last_seen_at,
            updated_at = excluded.updated_at
        `,
      ).run(
        snapshot.id,
        snapshot.shopId,
        snapshot.analysisType,
        snapshot.sourceType,
        snapshot.sourceKey,
        snapshot.title,
        snapshot.status,
        snapshot.timeRangeStart,
        snapshot.timeRangeEnd,
        snapshot.rowCount,
        snapshot.cacheKey,
        snapshot.remoteHash,
        snapshot.summaryJson,
        snapshot.metricsJson,
        snapshot.payloadJson,
        snapshot.sourceStatus,
        snapshot.sourceSyncedAt,
        snapshot.lastSeenAt,
        snapshot.createdAt,
        snapshot.updatedAt,
      );

      const row = db
        .prepare('SELECT * FROM data_analysis_snapshots WHERE shop_id = ? AND analysis_type = ? AND source_type = ? AND source_key = ?')
        .get(snapshot.shopId, snapshot.analysisType, snapshot.sourceType, snapshot.sourceKey);
      return toPublicSnapshot(row);
    },

    deleteSnapshots(query = {}) {
      const shopId = normalizeText(query.shopId ?? query.shop_id);
      const analysisType = normalizeText(query.analysisType ?? query.analysis_type);
      const sourceType = normalizeText(query.sourceType ?? query.source_type);
      const sourceKey = normalizeText(query.sourceKey ?? query.source_key);
      if (!analysisType || !sourceType || !sourceKey) {
        throw new Error('DATA_ANALYSIS_CACHE_DELETE_SCOPE_REQUIRED');
      }
      const result = shopId
        ? db.prepare(`
          DELETE FROM data_analysis_snapshots
          WHERE shop_id = ? AND analysis_type = ? AND source_type = ? AND source_key = ?
        `).run(shopId, analysisType, sourceType, sourceKey)
        : db.prepare(`
          DELETE FROM data_analysis_snapshots
          WHERE analysis_type = ? AND source_type = ? AND source_key = ?
        `).run(analysisType, sourceType, sourceKey);
      return {
        deletedCount: Number(result?.changes) || 0,
        shopId,
        analysisType,
        sourceType,
        sourceKey,
      };
    },

    deleteLegacyGlobalSnapshot(query = {}) {
      const analysisType = normalizeText(query.analysisType ?? query.analysis_type);
      const sourceType = normalizeText(query.sourceType ?? query.source_type);
      const sourceKey = normalizeText(query.sourceKey ?? query.source_key);
      if (!analysisType || !sourceType || !sourceKey) {
        throw new Error('DATA_ANALYSIS_CACHE_DELETE_SCOPE_REQUIRED');
      }
      const result = db.prepare(`
        DELETE FROM data_analysis_snapshots
        WHERE shop_id = '' AND analysis_type = ? AND source_type = ? AND source_key = ?
      `).run(analysisType, sourceType, sourceKey);
      return {
        deletedCount: Number(result?.changes) || 0,
        shopId: '',
        analysisType,
        sourceType,
        sourceKey,
      };
    },

    recordSyncState(input = {}) {
      const shopId = normalizeText(input.shopId ?? input.shop_id);
      const analysisType = normalizeText(input.analysisType ?? input.analysis_type, 'all');
      const cacheKey = normalizeText(input.cacheKey ?? input.cache_key, createSyncCacheKey({ shopId, analysisType }));
      const updatedAt = normalizeText(input.updatedAt ?? input.updated_at, nowIso());
      const existing = db.prepare('SELECT * FROM data_analysis_sync_state WHERE cache_key = ?').get(cacheKey);
      const hasLastSuccess = hasOwn(input, 'lastSuccessAt') || hasOwn(input, 'last_success_at');
      const hasLastAttempt = hasOwn(input, 'lastAttemptAt') || hasOwn(input, 'last_attempt_at');
      const hasLastError = hasOwn(input, 'lastError') || hasOwn(input, 'last_error');
      const incomingAttemptAt = hasLastAttempt
        ? normalizeOptionalText(input.lastAttemptAt ?? input.last_attempt_at)
        : null;
      const incomingAttemptTime = Date.parse(incomingAttemptAt || '');
      const existingAttemptTime = Date.parse(existing?.last_attempt_at || '');
      // Background and manual market captures can overlap briefly while an
      // aborted request is unwinding.  A final state from the older attempt
      // must never overwrite the newer attempt's syncing/success state.
      if (
        existing
        && Number.isFinite(incomingAttemptTime)
        && Number.isFinite(existingAttemptTime)
        && incomingAttemptTime < existingAttemptTime
      ) {
        return toPublicSyncState(existing, { shopId, analysisType });
      }
      const lastSuccessAt = hasLastSuccess
        ? normalizeOptionalText(input.lastSuccessAt ?? input.last_success_at)
        : existing?.last_success_at || null;
      const lastAttemptAt = hasLastAttempt
        ? incomingAttemptAt
        : existing?.last_attempt_at || null;
      const lastErrorJson = hasLastError
        ? stringifyNullableJson(input.lastError ?? input.last_error)
        : existing?.last_error_json || stringifyNullableJson(null);
      db.prepare(
        `
          INSERT INTO data_analysis_sync_state (
            cache_key,
            shop_id,
            analysis_type,
            status,
            last_success_at,
            last_attempt_at,
            last_error_json,
            changed_count,
            unchanged_count,
            deleted_count,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(cache_key)
          DO UPDATE SET
            status = excluded.status,
            last_success_at = excluded.last_success_at,
            last_attempt_at = excluded.last_attempt_at,
            last_error_json = excluded.last_error_json,
            changed_count = excluded.changed_count,
            unchanged_count = excluded.unchanged_count,
            deleted_count = excluded.deleted_count,
            updated_at = excluded.updated_at
        `,
      ).run(
        cacheKey,
        shopId,
        analysisType,
        normalizeText(input.status, 'idle'),
        lastSuccessAt,
        lastAttemptAt,
        lastErrorJson,
        hasOwn(input, 'changedCount') || hasOwn(input, 'changed_count')
          ? Number(input.changedCount ?? input.changed_count) || 0
          : Number(existing?.changed_count) || 0,
        hasOwn(input, 'unchangedCount') || hasOwn(input, 'unchanged_count')
          ? Number(input.unchangedCount ?? input.unchanged_count) || 0
          : Number(existing?.unchanged_count) || 0,
        hasOwn(input, 'deletedCount') || hasOwn(input, 'deleted_count')
          ? Number(input.deletedCount ?? input.deleted_count) || 0
          : Number(existing?.deleted_count) || 0,
        existing?.created_at || updatedAt,
        updatedAt,
      );
      return this.getSyncState({ shopId, analysisType });
    },
  };
}
