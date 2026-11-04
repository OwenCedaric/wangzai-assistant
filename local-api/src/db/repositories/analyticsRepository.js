import { createStableHash } from '../../utils/stableHash.js';

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value, fallback = '') {
  const text = value == null ? '' : String(value).trim();
  return text || fallback;
}

function normalizeDate(value) {
  const text = normalizeText(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(text) ? text : '';
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toInteger(value) {
  const number = toFiniteNumber(value);
  return number === null ? null : Math.round(number);
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function toPublicRow(row = {}) {
  return {
    id: row.id,
    shopId: row.shop_id,
    date: row.report_date,
    revenueRub: toFiniteNumber(row.revenue_rub),
    orderedUnits: toInteger(row.ordered_units),
    productViews: toInteger(row.product_views),
    cartAdds: toInteger(row.cart_adds),
    visitorSessions: toInteger(row.visitor_sessions),
    metricSignature: row.metric_signature,
    sourceCurrency: 'RUB',
    rawMetrics: parseJson(row.raw_metrics_json),
    remoteHash: row.remote_hash,
    isStale: Boolean(row.is_stale),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStoredRow(input = {}) {
  const shopId = normalizeText(input.shopId ?? input.shop_id);
  const date = normalizeDate(input.date ?? input.reportDate ?? input.report_date);
  if (!shopId) throw new Error('analytics row requires shopId');
  if (!date) throw new Error('analytics row requires YYYY-MM-DD date');
  const rawMetrics = input.rawMetrics ?? input.raw_metrics ?? {};
  const metricSignature = normalizeText(input.metricSignature ?? input.metric_signature, 'revenue,ordered_units,hits_view,hits_tocart,session_view');
  const remoteHash = normalizeText(
    input.remoteHash ?? input.remote_hash,
    createStableHash({
      shopId,
      date,
      revenueRub: toFiniteNumber(input.revenueRub ?? input.revenue_rub),
      orderedUnits: toInteger(input.orderedUnits ?? input.ordered_units),
      productViews: toInteger(input.productViews ?? input.product_views),
      cartAdds: toInteger(input.cartAdds ?? input.cart_adds),
      visitorSessions: toInteger(input.visitorSessions ?? input.visitor_sessions),
      metricSignature,
      rawMetrics,
    }, { length: 32 }),
  );
  const timestamp = normalizeText(input.updatedAt ?? input.updated_at, nowIso());
  return {
    id: normalizeText(input.id, createStableHash(`${shopId}:${date}`, { length: 24 })),
    shopId,
    date,
    revenueRub: toFiniteNumber(input.revenueRub ?? input.revenue_rub),
    orderedUnits: toInteger(input.orderedUnits ?? input.ordered_units),
    productViews: toInteger(input.productViews ?? input.product_views),
    cartAdds: toInteger(input.cartAdds ?? input.cart_adds),
    visitorSessions: toInteger(input.visitorSessions ?? input.visitor_sessions),
    metricSignature,
    rawMetricsJson: JSON.stringify(rawMetrics),
    remoteHash,
    isStale: input.isStale ? 1 : 0,
    lastSeenAt: normalizeText(input.lastSeenAt ?? input.last_seen_at, timestamp),
    createdAt: normalizeText(input.createdAt ?? input.created_at, timestamp),
    updatedAt: timestamp,
  };
}

export function createAnalyticsRepository(db) {
  if (!db) throw new Error('createAnalyticsRepository requires a database');

  const upsert = db.prepare(`
    INSERT INTO ozon_analytics_daily (
      id, shop_id, report_date, revenue_rub, ordered_units, product_views,
      cart_adds, visitor_sessions, metric_signature, raw_metrics_json,
      remote_hash, is_stale, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, report_date) DO UPDATE SET
      revenue_rub = excluded.revenue_rub,
      ordered_units = excluded.ordered_units,
      product_views = excluded.product_views,
      cart_adds = excluded.cart_adds,
      visitor_sessions = excluded.visitor_sessions,
      metric_signature = excluded.metric_signature,
      raw_metrics_json = excluded.raw_metrics_json,
      remote_hash = excluded.remote_hash,
      is_stale = excluded.is_stale,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at
  `);

  function upsertDailyRows({ shopId, rows = [] } = {}) {
    const normalizedRows = (Array.isArray(rows) ? rows : []).map((row) => toStoredRow({ ...row, shopId }));
    let changed = 0;
    let unchanged = 0;
    db.exec('BEGIN;');
    try {
      normalizedRows.forEach((row) => {
        const previous = db
          .prepare('SELECT remote_hash FROM ozon_analytics_daily WHERE shop_id = ? AND report_date = ?')
          .get(row.shopId, row.date);
        upsert.run(
          row.id,
          row.shopId,
          row.date,
          row.revenueRub,
          row.orderedUnits,
          row.productViews,
          row.cartAdds,
          row.visitorSessions,
          row.metricSignature,
          row.rawMetricsJson,
          row.remoteHash,
          row.isStale,
          row.lastSeenAt,
          row.createdAt,
          row.updatedAt,
        );
        if (previous?.remote_hash === row.remoteHash) unchanged += 1;
        else changed += 1;
      });
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
    return { changed, unchanged, total: normalizedRows.length };
  }

  function listDailyRows(query = {}) {
    const shopId = normalizeText(query.shopId ?? query.shop_id);
    const startDate = normalizeDate(query.startDate ?? query.start_date ?? query.dateFrom);
    const endDate = normalizeDate(query.endDate ?? query.end_date ?? query.dateTo);
    const clauses = [];
    const params = [];
    if (query.includeStale !== true && query.include_stale !== true) {
      clauses.push('COALESCE(is_stale, 0) = 0');
    }
    if (shopId) {
      clauses.push('shop_id = ?');
      params.push(shopId);
    }
    if (startDate) {
      clauses.push('report_date >= ?');
      params.push(startDate);
    }
    if (endDate) {
      clauses.push('report_date <= ?');
      params.push(endDate);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
      .prepare(`SELECT * FROM ozon_analytics_daily ${whereSql} ORDER BY report_date ASC`)
      .all(...params)
      .map(toPublicRow);
    const stats = db
      .prepare(`SELECT COUNT(*) AS row_count, MAX(updated_at) AS updated_at FROM ozon_analytics_daily ${whereSql}`)
      .get(...params);
    return {
      ok: true,
      domain: 'reports',
      source: 'official-analytics-cache',
      rows,
      total: rows.length,
      stats: {
        rowCount: Number(stats?.row_count) || 0,
        latestUpdatedAt: stats?.updated_at || null,
      },
    };
  }

  return { upsertDailyRows, listDailyRows };
}
