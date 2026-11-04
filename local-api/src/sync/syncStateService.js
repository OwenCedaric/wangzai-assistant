import { randomUUID } from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

function toPublicState(row) {
  return {
    id: row.id,
    domain: row.domain,
    shopId: row.shop_id || null,
    scopeKey: row.scope_key,
    status: row.status,
    lastSuccessAt: row.last_success_at || null,
    lastAttemptAt: row.last_attempt_at || null,
    lastError: row.last_error || null,
    remoteCursor: row.remote_cursor || null,
    changedCount: row.changed_count,
    unchangedCount: row.unchanged_count,
    staleCount: row.stale_count,
    updatedAt: row.updated_at,
  };
}

export function createSyncStateService(db) {
  return {
    upsertState(input = {}) {
      const timestamp = nowIso();
      const id = input.id || `sync_state_${randomUUID()}`;
      db.prepare(`
        INSERT INTO ozon_sync_state (
          id, domain, shop_id, scope_key, status, last_success_at,
          last_attempt_at, last_error, remote_cursor, changed_count,
          unchanged_count, stale_count, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(domain, shop_id, scope_key) DO UPDATE SET
          status = excluded.status,
          last_success_at = excluded.last_success_at,
          last_attempt_at = excluded.last_attempt_at,
          last_error = excluded.last_error,
          remote_cursor = excluded.remote_cursor,
          changed_count = excluded.changed_count,
          unchanged_count = excluded.unchanged_count,
          stale_count = excluded.stale_count,
          updated_at = excluded.updated_at
      `).run(
        id,
        input.domain,
        input.shopId || null,
        input.scopeKey || 'default',
        input.status || 'idle',
        input.lastSuccessAt || null,
        input.lastAttemptAt || timestamp,
        input.lastError || null,
        input.remoteCursor || null,
        Number(input.changedCount) || 0,
        Number(input.unchangedCount) || 0,
        Number(input.staleCount) || 0,
        timestamp,
      );
      return this.getState(input.domain, input.scopeKey || 'default', input.shopId || null);
    },

    getState(domain, scopeKey = 'default', shopId = null) {
      const row = db.prepare(`
        SELECT * FROM ozon_sync_state
        WHERE domain = ? AND COALESCE(shop_id, '') = COALESCE(?, '') AND scope_key = ?
      `).get(domain, shopId, scopeKey);
      return row ? toPublicState(row) : null;
    },

    listStates(domain, filters = {}) {
      const rows = db.prepare(`
        SELECT * FROM ozon_sync_state
        WHERE domain = ?
          AND (? IS NULL OR shop_id = ?)
        ORDER BY updated_at DESC, scope_key ASC
        LIMIT ?
      `).all(
        domain,
        filters.shopId || null,
        filters.shopId || null,
        Math.min(Number(filters.limit) || 100, 500),
      );
      return rows.map(toPublicState);
    },
  };
}
