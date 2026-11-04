import { randomUUID } from 'node:crypto';
import { createStableHash } from '../utils/stableHash.js';
import { safeLogPayload } from './safeLog.js';

function toPublicAudit(row) {
  return {
    id: row.id,
    domain: row.domain,
    shopId: row.shop_id || null,
    endpointKey: row.endpoint_key || null,
    action: row.action,
    status: row.status,
    idempotencyKey: row.idempotency_key || null,
    requestedBy: row.requested_by || null,
    diffHash: row.diff_hash || null,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at || null,
  };
}

export function createAuditLogService(db) {
  return {
    record(entry = {}) {
      const id = entry.id || `audit_${randomUUID()}`;
      const safePayload = safeLogPayload(entry.payload || {});
      const diffHash = entry.diffHash || createStableHash(safePayload, { length: 32 });
      db.prepare(`
        INSERT INTO ozon_write_audit_log (
          id, domain, shop_id, endpoint_key, action, status, idempotency_key,
          requested_by, diff_hash, audit_payload_json, created_at, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        entry.domain || 'unknown',
        entry.shopId || null,
        entry.endpointKey || null,
        entry.action || 'unknown',
        entry.status || 'preview',
        entry.idempotencyKey || null,
        entry.requestedBy || null,
        diffHash,
        JSON.stringify(safePayload),
        new Date().toISOString(),
        entry.confirmedAt || null,
      );
      return this.get(id);
    },

    get(id) {
      const row = db.prepare('SELECT * FROM ozon_write_audit_log WHERE id = ?').get(id);
      return row ? toPublicAudit(row) : null;
    },

    list(filters = {}) {
      const rows = db.prepare(`
        SELECT * FROM ozon_write_audit_log
        WHERE (? IS NULL OR domain = ?)
        ORDER BY created_at DESC
        LIMIT ?
      `).all(filters.domain || null, filters.domain || null, Math.min(Number(filters.limit) || 100, 500));
      return rows.map(toPublicAudit);
    },
  };
}
