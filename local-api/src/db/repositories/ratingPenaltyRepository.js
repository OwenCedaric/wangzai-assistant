import { createStableHash } from '../../utils/stableHash.js';

import { appendShopQueryFilter } from '../shopQueryScope.js';

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeId(value) {
  const text = normalizeText(value);
  return text && text !== '0' && text !== '未返回' ? text : '';
}

function compactJson(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function firstFilled(...values) {
  for (const value of values) {
    if (normalizeText(value)) return value;
  }
  return '';
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function extractPenaltyRows(data = {}) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.postings)) return data.postings;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.result?.postings)) return data.result.postings;
  if (Array.isArray(data.result?.items)) return data.result.items;
  if (Array.isArray(data.result)) return data.result;
  if (data.result && typeof data.result === 'object') return [data.result];
  if (data.posting_number || data.operation_id) return [data];
  return [];
}

function normalizePenalty(row = {}, { shopId } = {}) {
  const postingNumber = normalizeId(firstFilled(row.posting_number, row.postingNumber, row.posting?.posting_number));
  const orderId = normalizeId(firstFilled(row.order_id, row.orderId, row.posting?.order_id));
  const operationId = normalizeId(firstFilled(row.operation_id, row.operationId, row.id));
  const operationDate = normalizeText(firstFilled(row.operation_date, row.operationDate, row.created_at, row.date));
  const penaltyType = normalizeText(firstFilled(row.operation_type, row.type, row.penalty_type, row.index_type));
  const penaltyName = normalizeText(firstFilled(row.operation_type_name, row.name, row.penalty_name, row.reason));
  const ratingIndex = normalizeText(firstFilled(row.rating_index, row.ratingIndex, row.index, row.index_name));
  const status = normalizeText(firstFilled(row.status, row.state));
  const amount = toNumberOrNull(firstFilled(row.error_fee_cny, row.error_fee, row.amount_cny, row.amount, row.penalty_amount));
  const currencyCode = normalizeText(firstFilled(row.currency_code, row.currencyCode, row.currency)) || (amount === null ? '' : 'CNY');
  const penaltyKey = operationId || createStableHash({ postingNumber, operationDate, penaltyType, penaltyName, amount, row }, { length: 40 });
  const remoteHash = createStableHash({ row, normalized: { penaltyKey, postingNumber, status, amount } }, { length: 40 });
  return {
    id: `rating_${createStableHash({ shopId, penaltyKey }, { length: 32 })}`,
    shopId,
    penaltyKey,
    postingNumber,
    orderId,
    operationId,
    ratingIndex,
    status,
    penaltyType,
    penaltyName,
    operationDate,
    amount,
    currencyCode,
    raw: row,
    remoteHash,
  };
}

function toPublicPenalty(row = {}) {
  const raw = parseJson(row.raw_json, {});
  return {
    ...raw,
    id: row.operation_id || row.penalty_key || row.id,
    localId: row.id,
    shopId: row.shop_id,
    penaltyKey: row.penalty_key,
    posting_number: row.posting_number || raw.posting_number || raw.posting?.posting_number || null,
    postingNumber: row.posting_number || raw.postingNumber || null,
    order_id: row.order_id || raw.order_id || raw.posting?.order_id || null,
    orderId: row.order_id || raw.orderId || null,
    operation_id: row.operation_id || raw.operation_id || null,
    operationId: row.operation_id || raw.operationId || null,
    rating_index: row.rating_index || raw.rating_index || null,
    status: row.penalty_status || raw.status || null,
    operation_type: row.penalty_type || raw.operation_type || raw.type || null,
    operation_type_name: row.penalty_name || raw.operation_type_name || raw.name || null,
    operation_date: row.operation_date || raw.operation_date || raw.created_at || null,
    amount: row.amount_cny ?? raw.amount ?? null,
    error_fee_cny: row.amount_cny ?? raw.error_fee_cny ?? null,
    currency_code: row.currency_code || raw.currency_code || 'CNY',
    raw,
    isStale: Boolean(row.is_stale),
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  };
}

function normalizePageSize(value, fallback = 1000) {
  return Math.min(Math.max(Number(value) || fallback, 1), 1000);
}

export function createRatingPenaltyRepository(db) {
  function upsertPenalties({ shopId, rows = [] } = {}) {
    const normalizedShopId = normalizeId(shopId);
    if (!normalizedShopId) throw new Error('shopId is required for rating penalty merge.');
    const timestamp = nowIso();
    const selectExisting = db.prepare('SELECT remote_hash FROM ozon_rating_penalties WHERE shop_id = ? AND penalty_key = ?');
    const insertOrUpdate = db.prepare(`
      INSERT INTO ozon_rating_penalties (
        id, shop_id, penalty_key, posting_number, order_id, operation_id, rating_index,
        penalty_status, penalty_type, penalty_name, operation_date, amount_cny, currency_code,
        raw_json, remote_hash, is_stale, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(shop_id, penalty_key) DO UPDATE SET
        posting_number = COALESCE(excluded.posting_number, ozon_rating_penalties.posting_number),
        order_id = COALESCE(excluded.order_id, ozon_rating_penalties.order_id),
        operation_id = COALESCE(excluded.operation_id, ozon_rating_penalties.operation_id),
        rating_index = COALESCE(excluded.rating_index, ozon_rating_penalties.rating_index),
        penalty_status = COALESCE(excluded.penalty_status, ozon_rating_penalties.penalty_status),
        penalty_type = COALESCE(excluded.penalty_type, ozon_rating_penalties.penalty_type),
        penalty_name = COALESCE(excluded.penalty_name, ozon_rating_penalties.penalty_name),
        operation_date = COALESCE(excluded.operation_date, ozon_rating_penalties.operation_date),
        amount_cny = COALESCE(excluded.amount_cny, ozon_rating_penalties.amount_cny),
        currency_code = COALESCE(excluded.currency_code, ozon_rating_penalties.currency_code),
        raw_json = COALESCE(excluded.raw_json, ozon_rating_penalties.raw_json),
        remote_hash = excluded.remote_hash,
        is_stale = 0,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `);
    const touchUnchanged = db.prepare(`
      UPDATE ozon_rating_penalties SET last_seen_at = ?, is_stale = 0, updated_at = ?
      WHERE shop_id = ? AND penalty_key = ?
    `);
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let missing = 0;
    for (const sourceRow of rows) {
      const row = normalizePenalty(sourceRow, { shopId: normalizedShopId });
      if (!row.penaltyKey) {
        missing += 1;
        continue;
      }
      const existing = selectExisting.get(normalizedShopId, row.penaltyKey);
      if (existing?.remote_hash === row.remoteHash) {
        touchUnchanged.run(timestamp, timestamp, normalizedShopId, row.penaltyKey);
        unchanged += 1;
        continue;
      }
      insertOrUpdate.run(
        row.id,
        normalizedShopId,
        row.penaltyKey,
        row.postingNumber || null,
        row.orderId || null,
        row.operationId || null,
        row.ratingIndex || null,
        row.status || null,
        row.penaltyType || null,
        row.penaltyName || null,
        row.operationDate || null,
        row.amount,
        row.currencyCode || null,
        compactJson(row.raw),
        row.remoteHash,
        timestamp,
        timestamp,
        timestamp,
      );
      if (existing) updated += 1;
      else inserted += 1;
    }
    return { ok: true, inserted, updated, unchanged, missing, changed: inserted + updated, rows: rows.length, updatedAt: timestamp };
  }

  function listPenalties(query = {}) {
    const pageSize = normalizePageSize(query.pageSize ?? query.limit, 1000);
    const page = Math.max(Number(query.page) || 1, 1);
    const offset = Math.max(Number(query.offset) || (page - 1) * pageSize, 0);
    const postingNumber = normalizeId(query.postingNumber ?? query.posting_number);
    const since = normalizeText(query.since ?? query.from ?? query.dateFrom);
    const to = normalizeText(query.to ?? query.dateTo);
    const where = ['is_stale = 0'];
    const params = [];
    appendShopQueryFilter(query, where, params);
    if (postingNumber) {
      where.push('posting_number = ?');
      params.push(postingNumber);
    }
    if (since) {
      where.push('(operation_date IS NULL OR operation_date >= ?)');
      params.push(since);
    }
    if (to) {
      where.push('(operation_date IS NULL OR operation_date <= ?)');
      params.push(to);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM ozon_rating_penalties ${clause}`).get(...params);
    const rows = db.prepare(`
      SELECT * FROM ozon_rating_penalties
      ${clause}
      ORDER BY COALESCE(operation_date, updated_at) DESC, posting_number ASC, penalty_key ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    return {
      ok: true,
      domain: 'profit',
      entity: 'rating_penalties',
      source: 'sqlite',
      rows: rows.map(toPublicPenalty),
      page,
      pageSize,
      offset,
      total: Number(totalRow?.total) || 0,
      durationMs: 0,
    };
  }

  return { upsertPenalties, listPenalties, extractPenaltyRows };
}
