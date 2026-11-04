const DEFAULT_RESPONSE_CACHE_POLICY = Object.freeze({
  maxRowsPerEndpoint: 500,
  maxTotalRows: 5000,
  maxTotalPayloadBytes: 50 * 1024 * 1024,
  endpointMaxRows: Object.freeze({
    'products.attributes': 100,
    'products.infoList': 200,
    'products.pictures': 200,
    'products.prices': 300,
    'products.stocks': 300,
    'finance.transactionList': 128,
  }),
});

const LAST_TRUSTED_LOGISTICS_ENDPOINTS = Object.freeze(['warehouse.list', 'deliveryMethod.list']);

function placeholders(values = []) {
  return values.map(() => '?').join(',');
}

function nowIso(options = {}) {
  return options.now || new Date().toISOString();
}

function toPositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function normalizePolicy(input = {}) {
  const source = input.responseCache || input;
  return {
    maxRowsPerEndpoint: toPositiveInteger(source.maxRowsPerEndpoint, DEFAULT_RESPONSE_CACHE_POLICY.maxRowsPerEndpoint),
    maxTotalRows: toPositiveInteger(source.maxTotalRows, DEFAULT_RESPONSE_CACHE_POLICY.maxTotalRows),
    maxTotalPayloadBytes: toPositiveInteger(source.maxTotalPayloadBytes, DEFAULT_RESPONSE_CACHE_POLICY.maxTotalPayloadBytes),
    endpointMaxRows: {
      ...DEFAULT_RESPONSE_CACHE_POLICY.endpointMaxRows,
      ...(source.endpointMaxRows || {}),
    },
    now: source.now,
  };
}

function deleteByIds(db, ids = []) {
  const normalized = ids.filter(Boolean);
  if (!normalized.length) return 0;
  const statement = db.prepare(`DELETE FROM ozon_response_cache WHERE id IN (${normalized.map(() => '?').join(',')})`);
  const result = statement.run(...normalized);
  return Number(result.changes) || 0;
}

function getPayloadBytes(db) {
  const row = db.prepare('SELECT COALESCE(SUM(LENGTH(payload_json)), 0) AS bytes FROM ozon_response_cache').get();
  return Number(row?.bytes) || 0;
}

export function createCacheCleanupService(db, options = {}) {
  if (!db) throw new Error('createCacheCleanupService requires db.');
  const policy = normalizePolicy(options);

  function pruneExpired() {
    const result = db.prepare(`
      DELETE FROM ozon_response_cache
      WHERE expires_at IS NOT NULL
        AND expires_at <> ''
        AND expires_at < ?
        AND endpoint_key NOT IN (${placeholders(LAST_TRUSTED_LOGISTICS_ENDPOINTS)})
    `).run(nowIso(policy), ...LAST_TRUSTED_LOGISTICS_ENDPOINTS);
    return Number(result.changes) || 0;
  }

  function pruneEndpointOverflow() {
    const endpoints = db.prepare(`
      SELECT endpoint_key AS endpointKey, COUNT(*) AS count
      FROM ozon_response_cache
      GROUP BY endpoint_key
    `).all();
    let deleted = 0;
    for (const endpoint of endpoints) {
      const endpointKey = endpoint.endpointKey || 'unknown';
      if (LAST_TRUSTED_LOGISTICS_ENDPOINTS.includes(endpointKey)) continue;
      const maxRows = toPositiveInteger(policy.endpointMaxRows[endpointKey], policy.maxRowsPerEndpoint);
      if (Number(endpoint.count) <= maxRows) continue;
      const overflowIds = db.prepare(`
        SELECT id
        FROM ozon_response_cache
        WHERE endpoint_key = ?
        ORDER BY updated_at DESC, cache_key ASC
        LIMIT -1 OFFSET ?
      `).all(endpointKey, maxRows).map((row) => row.id);
      deleted += deleteByIds(db, overflowIds);
    }
    return deleted;
  }

  function pruneTotalRows() {
    const row = db.prepare('SELECT COUNT(*) AS count FROM ozon_response_cache').get();
    const count = Number(row?.count) || 0;
    if (count <= policy.maxTotalRows) return 0;
    const protectedCount = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM ozon_response_cache
      WHERE endpoint_key IN (${placeholders(LAST_TRUSTED_LOGISTICS_ENDPOINTS)})
    `).get(...LAST_TRUSTED_LOGISTICS_ENDPOINTS)?.count) || 0;
    const unprotectedLimit = Math.max(0, policy.maxTotalRows - protectedCount);
    const overflowIds = db.prepare(`
      SELECT id
      FROM ozon_response_cache
      WHERE endpoint_key NOT IN (${placeholders(LAST_TRUSTED_LOGISTICS_ENDPOINTS)})
      ORDER BY updated_at DESC, cache_key ASC
      LIMIT -1 OFFSET ?
    `).all(...LAST_TRUSTED_LOGISTICS_ENDPOINTS, unprotectedLimit).map((item) => item.id);
    return deleteByIds(db, overflowIds);
  }

  function pruneTotalPayloadBytes() {
    let bytes = getPayloadBytes(db);
    if (bytes <= policy.maxTotalPayloadBytes) return 0;
    const oldestRows = db.prepare(`
      SELECT id, COALESCE(LENGTH(payload_json), 0) AS bytes
      FROM ozon_response_cache
      WHERE endpoint_key NOT IN (${placeholders(LAST_TRUSTED_LOGISTICS_ENDPOINTS)})
      ORDER BY updated_at ASC, cache_key ASC
    `).all(...LAST_TRUSTED_LOGISTICS_ENDPOINTS);
    const ids = [];
    for (const row of oldestRows) {
      if (bytes <= policy.maxTotalPayloadBytes) break;
      ids.push(row.id);
      bytes -= Number(row.bytes) || 0;
    }
    return deleteByIds(db, ids);
  }

  return {
    getPolicy() {
      return {
        maxRowsPerEndpoint: policy.maxRowsPerEndpoint,
        maxTotalRows: policy.maxTotalRows,
        maxTotalPayloadBytes: policy.maxTotalPayloadBytes,
        endpointMaxRows: { ...policy.endpointMaxRows },
      };
    },

    cleanupResponseCache() {
      const beforeRows = Number(db.prepare('SELECT COUNT(*) AS count FROM ozon_response_cache').get()?.count) || 0;
      const beforeBytes = getPayloadBytes(db);
      const deletedExpired = pruneExpired();
      const deletedByEndpointLimit = pruneEndpointOverflow();
      const deletedByTotalRows = pruneTotalRows();
      const deletedByTotalBytes = pruneTotalPayloadBytes();
      const afterRows = Number(db.prepare('SELECT COUNT(*) AS count FROM ozon_response_cache').get()?.count) || 0;
      const afterBytes = getPayloadBytes(db);
      return {
        ok: true,
        target: 'ozon_response_cache',
        deletedExpired,
        deletedByEndpointLimit,
        deletedByTotalRows,
        deletedByTotalBytes,
        beforeRows,
        afterRows,
        beforeBytes,
        afterBytes,
        note: '仅清理 ozon_response_cache，不删除 ozon_products 主商品数据。',
      };
    },
  };
}
