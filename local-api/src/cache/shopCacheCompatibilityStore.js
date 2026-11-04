import { createHash } from 'node:crypto';
import { createStableHash } from '../utils/stableHash.js';

const initializedContractDatabases = new WeakSet();

function requiredText(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > 500) {
    const error = new Error(`${field} is required`);
    error.code = `SHOP_CACHE_${field.toUpperCase()}_INVALID`;
    throw error;
  }
  return normalized;
}

function serializePayload(payload) {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    const error = new Error('shop cache payload is not JSON serializable');
    error.code = 'SHOP_CACHE_PAYLOAD_INVALID';
    throw error;
  }
  return serialized;
}

function payloadHash(serialized) {
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

function ensureContractTable(db) {
  if (initializedContractDatabases.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_cache_contracts (
      contract_key TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      query_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      revision INTEGER NOT NULL,
      committed_at TEXT NOT NULL,
      verified_at TEXT,
      verification_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_shop_cache_contracts_domain
      ON shop_cache_contracts(domain, committed_at DESC, contract_key);
  `);
  const columns = new Set(
    db.prepare('PRAGMA table_info(shop_cache_contracts);').all().map((column) => column.name),
  );
  if (!columns.has('verified_at')) {
    db.exec('ALTER TABLE shop_cache_contracts ADD COLUMN verified_at TEXT;');
  }
  if (!columns.has('verification_count')) {
    db.exec('ALTER TABLE shop_cache_contracts ADD COLUMN verification_count INTEGER NOT NULL DEFAULT 0;');
  }
  initializedContractDatabases.add(db);
}

export function createShopCacheContractKey(domain, query = {}) {
  const normalizedDomain = requiredText(domain, 'domain');
  const queryHash = createStableHash(query, { length: 64 });
  return Object.freeze({
    domain: normalizedDomain,
    queryHash,
    contractKey: `${normalizedDomain}:${queryHash}`,
  });
}

export function createShopCacheCompatibilityStore({
  shopDatabaseManager,
  onCommitted = null,
  onInvalidated = null,
  verifyIndexed = null,
  now = () => new Date(),
} = {}) {
  if (!shopDatabaseManager?.ensure) throw new Error('SHOP_CACHE_DATABASE_MANAGER_REQUIRED');
  const status = {
    commits: 0,
    reads: 0,
    reconciliations: 0,
    mismatches: 0,
    indexNotifications: 0,
    indexNotificationFailures: 0,
    verifiedReadHits: 0,
    verifiedReadMisses: 0,
    verifiedReadStale: 0,
    indexReadVerifications: 0,
    indexReadVerificationFailures: 0,
    invalidations: 0,
    invalidatedContracts: 0,
    invalidationNotificationFailures: 0,
    failures: 0,
    lastErrorCode: '',
  };

  function recordFailure(error) {
    status.failures += 1;
    status.lastErrorCode = String(error?.code || 'SHOP_CACHE_COMPATIBILITY_FAILED');
  }

  function commit({ scopeToken, domain, query = {}, payload }) {
    const contract = createShopCacheContractKey(domain, query);
    const serialized = serializePayload(payload);
    const hash = payloadHash(serialized);
    const handle = shopDatabaseManager.ensure(scopeToken);
    const db = handle.db;
    ensureContractTable(db);
    db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = db.prepare(`
        SELECT revision FROM shop_cache_contracts WHERE contract_key = ?
      `).get(contract.contractKey);
      const revision = Number(existing?.revision || 0) + 1;
      const committedAt = new Date(now()).toISOString();
      db.prepare(`
        INSERT INTO shop_cache_contracts (
          contract_key, domain, query_hash, payload_json, payload_hash, revision, committed_at,
          verified_at, verification_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)
        ON CONFLICT(contract_key) DO UPDATE SET
          domain = excluded.domain,
          query_hash = excluded.query_hash,
          payload_json = excluded.payload_json,
          payload_hash = excluded.payload_hash,
          revision = excluded.revision,
          committed_at = excluded.committed_at,
          verified_at = NULL,
          verification_count = 0
      `).run(
        contract.contractKey,
        contract.domain,
        contract.queryHash,
        serialized,
        hash,
        revision,
        committedAt,
      );
      const readback = db.prepare(`
        SELECT contract_key, domain, query_hash, payload_json, payload_hash, revision, committed_at
        FROM shop_cache_contracts
        WHERE contract_key = ?
      `).get(contract.contractKey);
      if (
        readback?.contract_key !== contract.contractKey
        || readback?.domain !== contract.domain
        || readback?.query_hash !== contract.queryHash
        || readback?.payload_json !== serialized
        || readback?.payload_hash !== hash
        || Number(readback?.revision) !== revision
      ) {
        const error = new Error('shop cache readback mismatch');
        error.code = 'SHOP_CACHE_READBACK_MISMATCH';
        throw error;
      }
      db.exec('COMMIT;');
      status.commits += 1;
      status.lastErrorCode = '';
      const committed = Object.freeze({
        ...contract,
        payloadHash: hash,
        revision,
        committedAt: readback.committed_at,
      });
      if (typeof onCommitted === 'function') {
        try {
          onCommitted(Object.freeze({
            scopeToken,
            layout: handle.layout,
            ...committed,
          }));
          status.indexNotifications += 1;
        } catch {
          // The lightweight index is rebuildable from per-shop databases. Its
          // failure must never change a committed shop cache or the old DTO.
          status.indexNotificationFailures += 1;
        }
      }
      return committed;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* no active transaction */ }
      recordFailure(error);
      throw error;
    }
  }

  function read({ scopeToken, domain, query = {} }) {
    const contract = createShopCacheContractKey(domain, query);
    const handle = shopDatabaseManager.ensure(scopeToken);
    const db = handle.db;
    ensureContractTable(db);
    const row = db.prepare(`
      SELECT contract_key, domain, query_hash, payload_json, payload_hash, revision, committed_at,
             verified_at, verification_count
      FROM shop_cache_contracts
      WHERE contract_key = ?
    `).get(contract.contractKey);
    if (!row) return null;
    if (
      row.contract_key !== contract.contractKey
      || row.domain !== contract.domain
      || row.query_hash !== contract.queryHash
    ) {
      const error = new Error('shop cache contract metadata mismatch');
      error.code = 'SHOP_CACHE_CONTRACT_MISMATCH';
      recordFailure(error);
      throw error;
    }
    if (payloadHash(row.payload_json) !== row.payload_hash) {
      const error = new Error('shop cache payload hash mismatch');
      error.code = 'SHOP_CACHE_HASH_MISMATCH';
      recordFailure(error);
      throw error;
    }
    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch (cause) {
      const error = new Error('shop cache payload JSON is invalid', { cause });
      error.code = 'SHOP_CACHE_PAYLOAD_CORRUPT';
      recordFailure(error);
      throw error;
    }
    status.reads += 1;
    status.lastErrorCode = '';
    return Object.freeze({
      ...contract,
      payload,
      payloadHash: row.payload_hash,
      revision: Number(row.revision),
      committedAt: row.committed_at,
      verifiedAt: row.verified_at || null,
      verificationCount: Number(row.verification_count || 0),
    });
  }

  function reconcile({ scopeToken, domain, query = {}, payload }) {
    const expectedSerialized = serializePayload(payload);
    const expectedHash = payloadHash(expectedSerialized);
    let current;
    try {
      current = read({ scopeToken, domain, query });
    } catch (error) {
      status.reconciliations += 1;
      status.mismatches += 1;
      throw error;
    }
    status.reconciliations += 1;
    const matched = Boolean(
      current
      && current.payloadHash === expectedHash
      && serializePayload(current.payload) === expectedSerialized
    );
    if (!matched) {
      status.mismatches += 1;
    } else {
      const verifiedAt = new Date(now()).toISOString();
      const contract = createShopCacheContractKey(domain, query);
      const result = shopDatabaseManager.ensure(scopeToken).db.prepare(`
        UPDATE shop_cache_contracts
        SET verified_at = ?, verification_count = verification_count + 1
        WHERE contract_key = ? AND payload_hash = ?
      `).run(verifiedAt, contract.contractKey, expectedHash);
      if (Number(result.changes || 0) !== 1) {
        status.mismatches += 1;
        return Object.freeze({
          ok: false,
          matched: false,
          expectedHash,
          actualHash: current?.payloadHash || null,
          revision: current?.revision || null,
          verifiedAt: null,
        });
      }
      current = Object.freeze({
        ...current,
        verifiedAt,
        verificationCount: Number(current.verificationCount || 0) + 1,
      });
    }
    return Object.freeze({
      ok: matched,
      matched,
      expectedHash,
      actualHash: current?.payloadHash || null,
      revision: current?.revision || null,
      verifiedAt: current?.verifiedAt || null,
    });
  }

  function readVerified({ scopeToken, domain, query = {}, maxAgeMs = 10_000 } = {}) {
    const current = read({ scopeToken, domain, query });
    if (!current) {
      status.verifiedReadMisses += 1;
      return null;
    }
    const verifiedAtMs = Date.parse(String(current.verifiedAt || ''));
    const committedAtMs = Date.parse(String(current.committedAt || ''));
    const maximumAge = Math.max(0, Number(maxAgeMs) || 0);
    const rawAgeMs = new Date(now()).getTime() - verifiedAtMs;
    const ageMs = Number.isFinite(rawAgeMs) && rawAgeMs >= 0 ? rawAgeMs : Infinity;
    if (
      !Number.isFinite(ageMs)
      || !Number.isFinite(committedAtMs)
      || verifiedAtMs < committedAtMs
      || ageMs > maximumAge
      || current.verificationCount < 1
    ) {
      status.verifiedReadMisses += 1;
      status.verifiedReadStale += 1;
      return null;
    }
    if (typeof verifyIndexed === 'function') {
      status.indexReadVerifications += 1;
      const layout = shopDatabaseManager.resolve?.(scopeToken)
        || shopDatabaseManager.ensure(scopeToken).layout;
      let indexed = false;
      try {
        indexed = verifyIndexed(Object.freeze({
          scopeToken,
          layout,
          domain: current.domain,
          queryHash: current.queryHash,
          contractKey: current.contractKey,
          payloadHash: current.payloadHash,
          revision: current.revision,
          committedAt: current.committedAt,
        })) === true;
      } catch {
        indexed = false;
      }
      if (!indexed) {
        status.indexReadVerificationFailures += 1;
        status.verifiedReadMisses += 1;
        return null;
      }
    }
    status.verifiedReadHits += 1;
    return Object.freeze({ ...current, ageMs });
  }

  function invalidate({ scopeToken, domain } = {}) {
    const normalizedDomain = requiredText(domain, 'domain');
    if (shopDatabaseManager.has?.(scopeToken) === false) {
      status.invalidations += 1;
      return Object.freeze({ ok: true, removed: 0, domain: normalizedDomain });
    }
    try {
      const handle = shopDatabaseManager.openExisting?.(scopeToken)
        || shopDatabaseManager.ensure(scopeToken);
      ensureContractTable(handle.db);
      const result = handle.db.prepare(`
        DELETE FROM shop_cache_contracts
        WHERE domain = ?
      `).run(normalizedDomain);
      const removed = Number(result.changes || 0);
      status.invalidations += 1;
      status.invalidatedContracts += removed;
      if (typeof onInvalidated === 'function') {
        try {
          onInvalidated(Object.freeze({
            scopeToken,
            layout: handle.layout,
            domain: normalizedDomain,
            removed,
          }));
        } catch {
          status.invalidationNotificationFailures += 1;
        }
      }
      status.lastErrorCode = '';
      return Object.freeze({ ok: true, removed, domain: normalizedDomain });
    } catch (error) {
      recordFailure(error);
      throw error;
    }
  }

  return Object.freeze({
    commit,
    read,
    reconcile,
    readVerified,
    invalidate,
    getStatus: () => Object.freeze({
      ...status,
      mode: 'shadow-verified',
      readMode: 'verified-shop-l2-with-canonical-fallback',
      cutoverReady: status.commits > 0
        && status.reconciliations === status.commits
        && status.mismatches === 0
        && status.indexNotifications === status.commits
        && status.indexNotificationFailures === 0,
    }),
  });
}
