import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStableHash } from '../utils/stableHash.js';

export const SHOP_AGGREGATE_INDEX_LAYOUT_VERSION = 1;
const SHOP_AGGREGATE_INDEX_APPLICATION_ID = 0x575a4101;

function requiredText(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > 500 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    const error = new Error(`${field} is required`);
    error.code = `SHOP_AGGREGATE_INDEX_${field.replaceAll(/[^A-Za-z0-9]/gu, '_').toUpperCase()}_INVALID`;
    throw error;
  }
  return normalized;
}

function requiredHash(value, field) {
  const normalized = requiredText(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    const error = new Error(`${field} must be a SHA-256 hash`);
    error.code = `SHOP_AGGREGATE_INDEX_${field.replaceAll(/[^A-Za-z0-9]/gu, '_').toUpperCase()}_INVALID`;
    throw error;
  }
  return normalized;
}

function positiveInteger(value, field) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    const error = new Error(`${field} must be a positive integer`);
    error.code = `SHOP_AGGREGATE_INDEX_${field.replaceAll(/[^A-Za-z0-9]/gu, '_').toUpperCase()}_INVALID`;
    throw error;
  }
  return normalized;
}

function isoTimestamp(value, field) {
  const normalized = new Date(value);
  if (!Number.isFinite(normalized.getTime())) {
    const error = new Error(`${field} must be a valid timestamp`);
    error.code = `SHOP_AGGREGATE_INDEX_${field.replaceAll(/[^A-Za-z0-9]/gu, '_').toUpperCase()}_INVALID`;
    throw error;
  }
  return normalized.toISOString();
}

function publicRow(row) {
  return Object.freeze({
    scopeDigest: row.scope_digest,
    shopId: row.shop_id,
    shopIncarnation: row.shop_incarnation,
    domain: row.domain,
    queryHash: row.query_hash,
    contractKey: row.contract_key,
    payloadHash: row.payload_hash,
    revision: Number(row.revision),
    committedAt: row.committed_at,
    indexedAt: row.indexed_at,
  });
}

function configure(db, busyTimeoutMs) {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`PRAGMA busy_timeout = ${Number.isFinite(busyTimeoutMs) ? Math.max(0, Math.trunc(busyTimeoutMs)) : 5000};`);
  db.exec(`PRAGMA application_id = ${SHOP_AGGREGATE_INDEX_APPLICATION_ID};`);
  db.prepare('PRAGMA journal_mode = WAL;').get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_aggregate_index_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      layout_version INTEGER NOT NULL,
      profile_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shop_cache_index (
      scope_digest TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      shop_incarnation TEXT NOT NULL,
      domain TEXT NOT NULL,
      query_hash TEXT NOT NULL,
      contract_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      revision INTEGER NOT NULL,
      committed_at TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      PRIMARY KEY (scope_digest, contract_key)
    );
    CREATE INDEX IF NOT EXISTS idx_shop_cache_index_aggregate
      ON shop_cache_index(domain, query_hash, shop_id, committed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_shop_cache_index_shop
      ON shop_cache_index(shop_id, shop_incarnation, scope_digest);
  `);
}

function ensureMetadata(db, profileId, now) {
  const existing = db.prepare(`
    SELECT layout_version, profile_id, created_at
    FROM shop_aggregate_index_metadata
    WHERE singleton = 1
  `).get();
  if (!existing) {
    db.prepare(`
      INSERT INTO shop_aggregate_index_metadata (
        singleton, layout_version, profile_id, created_at
      ) VALUES (1, ?, ?, ?)
    `).run(SHOP_AGGREGATE_INDEX_LAYOUT_VERSION, profileId, new Date(now()).toISOString());
  }
  const readback = db.prepare(`
    SELECT layout_version, profile_id, created_at
    FROM shop_aggregate_index_metadata
    WHERE singleton = 1
  `).get();
  if (
    Number(readback?.layout_version) !== SHOP_AGGREGATE_INDEX_LAYOUT_VERSION
    || readback?.profile_id !== profileId
  ) {
    const error = new Error('shop aggregate index profile metadata mismatch');
    error.code = 'SHOP_AGGREGATE_INDEX_SCOPE_MISMATCH';
    throw error;
  }
  return Object.freeze({
    layoutVersion: Number(readback.layout_version),
    profileId: readback.profile_id,
    createdAt: readback.created_at,
  });
}

export function createShopAggregateIndex({
  databasePath,
  profileId,
  busyTimeoutMs = 5000,
  now = () => new Date(),
} = {}) {
  const resolvedPath = resolve(requiredText(databasePath, 'database_path'));
  const normalizedProfileId = requiredText(profileId, 'profile_id');
  mkdirSync(dirname(resolvedPath), { recursive: true });
  const db = new DatabaseSync(resolvedPath);
  let closed = false;
  const status = { records: 0, rejectedStale: 0, removals: 0, failures: 0, lastErrorCode: '' };
  try {
    configure(db, busyTimeoutMs);
    ensureMetadata(db, normalizedProfileId, now);
  } catch (error) {
    db.close();
    throw error;
  }

  function assertOpen() {
    if (!closed) return;
    const error = new Error('shop aggregate index is closed');
    error.code = 'SHOP_AGGREGATE_INDEX_CLOSED';
    throw error;
  }

  function record(input = {}) {
    assertOpen();
    try {
      const scopeToken = input.scopeToken || {};
      const layout = input.layout || {};
      const tokenProfileId = String(scopeToken.profileId || normalizedProfileId).trim();
      const layoutProfileId = String(layout.profileId || normalizedProfileId).trim();
      if (tokenProfileId !== normalizedProfileId || layoutProfileId !== normalizedProfileId) {
        const error = new Error('aggregate index record belongs to another profile');
        error.code = 'SHOP_AGGREGATE_INDEX_PROFILE_MISMATCH';
        throw error;
      }
      const scopeDigest = requiredHash(layout.scopeDigest, 'scope_digest');
      const shopId = requiredText(layout.shopId || scopeToken.shopId, 'shop_id');
      const shopIncarnation = requiredText(
        layout.shopIncarnation || scopeToken.shopIncarnation,
        'shop_incarnation',
      );
      if (
        (scopeToken.shopId && String(scopeToken.shopId).trim() !== shopId)
        || (scopeToken.shopIncarnation && String(scopeToken.shopIncarnation).trim() !== shopIncarnation)
      ) {
        const error = new Error('aggregate index record scope does not match its shop database');
        error.code = 'SHOP_AGGREGATE_INDEX_SCOPE_MISMATCH';
        throw error;
      }
      const domain = requiredText(input.domain, 'domain');
      const queryHash = requiredHash(input.queryHash, 'query_hash');
      const contractKey = requiredText(input.contractKey, 'contract_key');
      if (contractKey !== `${domain}:${queryHash}`) {
        const error = new Error('aggregate index contract key mismatch');
        error.code = 'SHOP_AGGREGATE_INDEX_CONTRACT_MISMATCH';
        throw error;
      }
      const payloadHash = requiredHash(input.payloadHash, 'payload_hash');
      const revision = positiveInteger(input.revision, 'revision');
      const committedAt = isoTimestamp(input.committedAt, 'committed_at');
      const indexedAt = new Date(now()).toISOString();
      const result = db.prepare(`
        INSERT INTO shop_cache_index (
          scope_digest, shop_id, shop_incarnation, domain, query_hash,
          contract_key, payload_hash, revision, committed_at, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_digest, contract_key) DO UPDATE SET
          shop_id = excluded.shop_id,
          shop_incarnation = excluded.shop_incarnation,
          domain = excluded.domain,
          query_hash = excluded.query_hash,
          payload_hash = excluded.payload_hash,
          revision = excluded.revision,
          committed_at = excluded.committed_at,
          indexed_at = excluded.indexed_at
        WHERE excluded.revision >= shop_cache_index.revision
      `).run(
        scopeDigest,
        shopId,
        shopIncarnation,
        domain,
        queryHash,
        contractKey,
        payloadHash,
        revision,
        committedAt,
        indexedAt,
      );
      const row = db.prepare(`
        SELECT * FROM shop_cache_index
        WHERE scope_digest = ? AND contract_key = ?
      `).get(scopeDigest, contractKey);
      const accepted = Number(result.changes || 0) === 1;
      if (accepted) status.records += 1;
      else status.rejectedStale += 1;
      status.lastErrorCode = '';
      return Object.freeze({ ok: true, accepted, row: publicRow(row) });
    } catch (error) {
      status.failures += 1;
      status.lastErrorCode = String(error?.code || 'SHOP_AGGREGATE_INDEX_RECORD_FAILED');
      throw error;
    }
  }

  function list(filters = {}) {
    assertOpen();
    const shopId = String(filters.shopId || '').trim() || null;
    const domain = String(filters.domain || '').trim() || null;
    const queryHash = String(filters.queryHash || '').trim() || null;
    const limit = Math.min(Math.max(1, Number(filters.limit) || 500), 5000);
    return db.prepare(`
      SELECT * FROM shop_cache_index
      WHERE (? IS NULL OR shop_id = ?)
        AND (? IS NULL OR domain = ?)
        AND (? IS NULL OR query_hash = ?)
      ORDER BY committed_at DESC, shop_id ASC, scope_digest ASC
      LIMIT ?
    `).all(shopId, shopId, domain, domain, queryHash, queryHash, limit).map(publicRow);
  }

  function removeScope(scope = {}) {
    assertOpen();
    const layout = scope.scopeDigest
      ? scope
      : scope.layout || {};
    const scopeDigest = requiredHash(layout.scopeDigest, 'scope_digest');
    const result = db.prepare('DELETE FROM shop_cache_index WHERE scope_digest = ?').run(scopeDigest);
    status.removals += Number(result.changes || 0);
    return Object.freeze({ ok: true, removed: Number(result.changes || 0), scopeDigest });
  }

  function removeShop(shopId) {
    assertOpen();
    const ownerId = requiredText(shopId, 'shop_id');
    const result = db.prepare('DELETE FROM shop_cache_index WHERE shop_id = ?').run(ownerId);
    status.removals += Number(result.changes || 0);
    return Object.freeze({ ok: true, removed: Number(result.changes || 0), shopId: ownerId });
  }

  function removeDomain(scope = {}, domainValue) {
    assertOpen();
    const scopeDigest = requiredHash(scope.scopeDigest || scope.layout?.scopeDigest, 'scope_digest');
    const domain = requiredText(domainValue, 'domain');
    const result = db.prepare(`
      DELETE FROM shop_cache_index
      WHERE scope_digest = ? AND domain = ?
    `).run(scopeDigest, domain);
    status.removals += Number(result.changes || 0);
    return Object.freeze({
      ok: true,
      removed: Number(result.changes || 0),
      scopeDigest,
      domain,
    });
  }

  function listScope(scope = {}) {
    assertOpen();
    const scopeDigest = requiredHash(scope.scopeDigest || scope.layout?.scopeDigest, 'scope_digest');
    return db.prepare(`
      SELECT scope_digest, shop_id, shop_incarnation, domain, query_hash,
             contract_key, payload_hash, revision, committed_at, indexed_at
      FROM shop_cache_index
      WHERE scope_digest = ?
      ORDER BY contract_key ASC
    `).all(scopeDigest).map(publicRow);
  }

  function getScopeContract(scope = {}, contractKeyValue) {
    assertOpen();
    const scopeDigest = requiredHash(scope.scopeDigest || scope.layout?.scopeDigest, 'scope_digest');
    const contractKey = requiredText(contractKeyValue, 'contract_key');
    const row = db.prepare(`
      SELECT scope_digest, shop_id, shop_incarnation, domain, query_hash,
             contract_key, payload_hash, revision, committed_at, indexed_at
      FROM shop_cache_index
      WHERE scope_digest = ? AND contract_key = ?
    `).get(scopeDigest, contractKey);
    return row ? publicRow(row) : null;
  }

  function observeScope(scope = {}) {
    assertOpen();
    const scopeDigest = requiredHash(scope.scopeDigest || scope.layout?.scopeDigest, 'scope_digest');
    const rows = listScope({ scopeDigest });
    if (!rows.length) return Object.freeze({ state: 'absent', count: 0, scopeDigest });
    return Object.freeze({
      state: 'observed',
      count: rows.length,
      revision: String(Math.max(...rows.map((row) => Number(row.revision || 0)))),
      hash: createStableHash(rows.map((row) => ({
        scopeDigest: row.scopeDigest,
        shopId: row.shopId,
        shopIncarnation: row.shopIncarnation,
        domain: row.domain,
        queryHash: row.queryHash,
        contractKey: row.contractKey,
        payloadHash: row.payloadHash,
        revision: row.revision,
        committedAt: row.committedAt,
      })), { length: 64 }),
      scopeDigest,
    });
  }

  function snapshot() {
    assertOpen();
    const counts = db.prepare(`
      SELECT COUNT(*) AS entries, COUNT(DISTINCT shop_id) AS shops,
             COUNT(DISTINCT domain) AS domains
      FROM shop_cache_index
    `).get();
    return Object.freeze({
      databasePath: resolvedPath,
      profileId: normalizedProfileId,
      entries: Number(counts?.entries || 0),
      shops: Number(counts?.shops || 0),
      domains: Number(counts?.domains || 0),
      ...status,
    });
  }

  function close() {
    if (closed) return false;
    try { db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get(); } catch { /* next open recovers WAL */ }
    db.close();
    closed = true;
    return true;
  }

  return Object.freeze({
    databasePath: resolvedPath,
    profileId: normalizedProfileId,
    record,
    list,
    removeScope,
    removeShop,
    removeDomain,
    listScope,
    getScopeContract,
    observeScope,
    snapshot,
    close,
  });
}
