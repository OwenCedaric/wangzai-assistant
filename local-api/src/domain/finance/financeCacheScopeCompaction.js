import { normalizeLegacyFinanceScopeKey } from './financeCacheScope.js';

const DEFAULT_MAX_DELETE_ROWS = 2_000;
const DELETE_BATCH_SIZE = 500;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function duplicatePrimaryKeys(rows, { keyField, updatedField, maxDeleteRows }) {
  const groups = new Map();
  for (const row of rows) {
    const primaryKey = String(row[keyField] || '').trim();
    if (!primaryKey) continue;
    const normalized = normalizeLegacyFinanceScopeKey(primaryKey);
    const group = groups.get(normalized) || [];
    group.push({
      primaryKey,
      normalized,
      isCanonical: normalized === primaryKey,
      updatedAt: timestamp(row[updatedField]),
    });
    groups.set(normalized, group);
  }

  const candidates = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((left, right) => Number(right.isCanonical) - Number(left.isCanonical)
      || right.updatedAt - left.updatedAt
      || left.primaryKey.localeCompare(right.primaryKey));
    candidates.push(...group.slice(1).map((item) => item.primaryKey));
  }
  return candidates.slice(0, maxDeleteRows);
}

function deleteByPrimaryKeys(db, table, field, shopId, keys = []) {
  let deleted = 0;
  for (let offset = 0; offset < keys.length; offset += DELETE_BATCH_SIZE) {
    const batch = keys.slice(offset, offset + DELETE_BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(', ');
    deleted += Number(db.prepare(`
      DELETE FROM ${table}
      WHERE domain = 'finance' AND shop_id = ? AND ${field} IN (${placeholders})
    `).run(shopId, ...batch).changes) || 0;
  }
  return deleted;
}

/**
 * Removes only duplicate finance runtime/cache variants caused by historical timestamped
 * cache identities. Canonical finance facts remain in ozon_finance_transactions; this
 * service never touches facts, user data, credentials, jobs, traces, or another shop.
 */
export function compactFinanceCacheScopes(db, { shopId, maxDeleteRows = DEFAULT_MAX_DELETE_ROWS } = {}) {
  if (!db) throw new Error('compactFinanceCacheScopes requires db.');
  const normalizedShopId = String(shopId || '').trim();
  if (!normalizedShopId) return { ok: true, skipped: 'shop-required', deleted: 0 };
  const limit = positiveInteger(maxDeleteRows, DEFAULT_MAX_DELETE_ROWS);
  const plans = [
    {
      table: 'ozon_response_cache',
      field: 'cache_key',
      rows: db.prepare(`SELECT cache_key, updated_at FROM ozon_response_cache WHERE domain = 'finance' AND shop_id = ?`).all(normalizedShopId),
    },
    {
      table: 'ozon_cache_keys',
      field: 'cache_key',
      rows: db.prepare(`SELECT cache_key, updated_at FROM ozon_cache_keys WHERE domain = 'finance' AND shop_id = ?`).all(normalizedShopId),
    },
    {
      table: 'ozon_sync_state',
      field: 'scope_key',
      rows: db.prepare(`SELECT scope_key, updated_at FROM ozon_sync_state WHERE domain = 'finance' AND shop_id = ?`).all(normalizedShopId),
    },
  ];
  let remainingBudget = limit;
  const keysByTable = new Map();
  for (const plan of plans) {
    const keys = duplicatePrimaryKeys(plan.rows, {
      keyField: plan.field,
      updatedField: 'updated_at',
      maxDeleteRows: remainingBudget,
    });
    keysByTable.set(plan.table, keys);
    remainingBudget -= keys.length;
  }
  const planned = [...keysByTable.values()].reduce((total, keys) => total + keys.length, 0);
  if (!planned) return { ok: true, planned: 0, deleted: 0, remaining: 0, byTable: {} };

  db.exec('BEGIN IMMEDIATE');
  try {
    const byTable = {};
    for (const plan of plans) {
        byTable[plan.table] = deleteByPrimaryKeys(
          db,
          plan.table,
          plan.field,
          normalizedShopId,
          keysByTable.get(plan.table),
        );
    }
    db.exec('COMMIT');
    const deleted = Object.values(byTable).reduce((total, value) => total + value, 0);
    return { ok: true, planned, deleted, remaining: Math.max(0, planned - deleted), byTable };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
