import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const NAMESPACE_PATTERN = /^[a-z][a-z0-9._-]{0,95}$/u;
const SCOPE_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const KEY_PATTERN = /^[^\u0000-\u001F\u007F]{1,500}$/u;
const ASSET_ID_PATTERN = /^[A-Za-z0-9._-]{1,160}$/u;
const ASSET_EXTENSION_PATTERN = /^[a-z0-9]{1,12}$/u;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/u;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;

function requiredText(value, pattern, code) {
  const text = String(value || '').trim();
  if (!pattern.test(text)) throw Object.assign(new Error(code), { code });
  return text;
}

function normalizeJson(value) {
  const serialized = JSON.stringify(value ?? null);
  if (Buffer.byteLength(serialized, 'utf8') > 8 * 1024 * 1024) {
    throw Object.assign(new Error('CACHE_PAYLOAD_TOO_LARGE'), { code: 'CACHE_PAYLOAD_TOO_LARGE' });
  }
  return serialized;
}

function parseJson(value) {
  return JSON.parse(String(value));
}

function normalizeEncryptionKey(value) {
  const key = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : Buffer.from(String(value || ''), 'base64url');
  if (key.length !== 32) {
    throw Object.assign(new Error('CACHE_ENCRYPTION_KEY_REQUIRED'), { code: 'CACHE_ENCRYPTION_KEY_REQUIRED' });
  }
  return key;
}

function createEncryptionCodec(value) {
  const key = normalizeEncryptionKey(value);
  function encryptBytes(input) {
    const plaintext = Buffer.from(input);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from('WZCA1', 'ascii'), iv, tag, ciphertext]);
  }
  function decryptBytes(input) {
    const envelope = Buffer.from(input);
    if (envelope.length < 34 || envelope.subarray(0, 5).toString('ascii') !== 'WZCA1') {
      throw Object.assign(new Error('CACHE_ENCRYPTED_PAYLOAD_INVALID'), { code: 'CACHE_ENCRYPTED_PAYLOAD_INVALID' });
    }
    const iv = envelope.subarray(5, 17);
    const tag = envelope.subarray(17, 33);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(envelope.subarray(33)), decipher.final()]);
    } catch {
      throw Object.assign(new Error('CACHE_ENCRYPTED_PAYLOAD_INVALID'), { code: 'CACHE_ENCRYPTED_PAYLOAD_INVALID' });
    }
  }
  return Object.freeze({
    encryptBytes,
    decryptBytes,
    sealJson(input) {
      return encryptBytes(Buffer.from(normalizeJson(input), 'utf8')).toString('base64url');
    },
    openJson(input) {
      return parseJson(decryptBytes(Buffer.from(String(input || ''), 'base64url')).toString('utf8'));
    },
  });
}

function nowIso() {
  return new Date().toISOString();
}

function createAssetManifestTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_manifest (
      scope_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope_id, asset_id),
      UNIQUE (relative_path)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_manifest_scope_updated
      ON asset_manifest(scope_id, updated_at DESC);
  `);
}

function migrateAssetManifestScopeKey(db) {
  const columns = db.prepare('PRAGMA table_info(asset_manifest)').all();
  const primaryKeyColumns = columns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name);
  if (primaryKeyColumns.join(',') === 'scope_id,asset_id') return;
  db.exec(`
    BEGIN IMMEDIATE;
    DROP INDEX IF EXISTS idx_asset_manifest_scope_updated;
    ALTER TABLE asset_manifest RENAME TO asset_manifest_legacy_v1;
    CREATE TABLE asset_manifest (
      scope_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope_id, asset_id),
      UNIQUE (relative_path)
    );
    INSERT INTO asset_manifest (
      scope_id, asset_id, relative_path, media_type, size_bytes, sha256,
      metadata_json, created_at, updated_at
    )
    SELECT scope_id, asset_id, relative_path, media_type, size_bytes, sha256,
           metadata_json, created_at, updated_at
    FROM asset_manifest_legacy_v1;
    DROP TABLE asset_manifest_legacy_v1;
    CREATE INDEX idx_asset_manifest_scope_updated
      ON asset_manifest(scope_id, updated_at DESC);
    COMMIT;
  `);
}

function parseAssetContent(value) {
  const encoded = String(value || '');
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    throw Object.assign(new Error('ASSET_CONTENT_BASE64_INVALID'), { code: 'ASSET_CONTENT_BASE64_INVALID' });
  }
  const content = Buffer.from(encoded, 'base64');
  if (!content.length || content.length > MAX_ASSET_BYTES) {
    throw Object.assign(new Error('ASSET_CONTENT_SIZE_INVALID'), { code: 'ASSET_CONTENT_SIZE_INVALID' });
  }
  return content;
}

function assetDto(row, codec) {
  if (!row) return null;
  return {
    assetId: row.asset_id,
    relativePath: row.relative_path,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    metadata: codec.openJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createLocalCacheStore({ databasePath, assetRoot, encryptionKey }) {
  const resolvedDatabase = path.resolve(databasePath);
  const resolvedAssets = path.resolve(assetRoot);
  const codec = createEncryptionCodec(encryptionKey);
  fs.mkdirSync(path.dirname(resolvedDatabase), { recursive: true });
  fs.mkdirSync(resolvedAssets, { recursive: true });
  const db = new DatabaseSync(resolvedDatabase);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS cache_records (
      scope_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      record_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope_id, namespace, record_key)
    );
    CREATE INDEX IF NOT EXISTS idx_cache_records_namespace_updated
      ON cache_records(scope_id, namespace, updated_at DESC);
    CREATE TABLE IF NOT EXISTS outbox_tasks (
      task_id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      task_kind TEXT NOT NULL,
      request_json TEXT NOT NULL,
      state TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_scope_state
      ON outbox_tasks(scope_id, state, created_at);
  `);
  createAssetManifestTable(db);
  migrateAssetManifestScopeKey(db);

  const statements = {
    getRecord: db.prepare(`
      SELECT payload_json, revision, expires_at, created_at, updated_at
      FROM cache_records WHERE scope_id=? AND namespace=? AND record_key=?
    `),
    listRecords: db.prepare(`
      SELECT record_key, payload_json, revision, expires_at, created_at, updated_at
      FROM cache_records WHERE scope_id=? AND namespace=?
      ORDER BY updated_at DESC LIMIT ? OFFSET ?
    `),
    listScopesByNamespace: db.prepare(`
      SELECT DISTINCT scope_id
      FROM cache_records
      WHERE namespace=?
      ORDER BY scope_id
    `),
    upsertRecord: db.prepare(`
      INSERT INTO cache_records (
        scope_id, namespace, record_key, payload_json, revision, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(scope_id, namespace, record_key) DO UPDATE SET
        payload_json=excluded.payload_json,
        revision=cache_records.revision + 1,
        expires_at=excluded.expires_at,
        updated_at=excluded.updated_at
      RETURNING revision, created_at, updated_at
    `),
    deleteRecord: db.prepare(`
      DELETE FROM cache_records WHERE scope_id=? AND namespace=? AND record_key=?
    `),
    enqueueTask: db.prepare(`
      INSERT INTO outbox_tasks (
        task_id, scope_id, task_kind, request_json, state, attempt_count,
        idempotency_key, result_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)
      ON CONFLICT(task_id) DO NOTHING
    `),
    listTasks: db.prepare(`
      SELECT task_id, task_kind, request_json, state, attempt_count,
             idempotency_key, result_json, created_at, updated_at
      FROM outbox_tasks WHERE scope_id=? AND state=?
      ORDER BY created_at LIMIT ?
    `),
    completeTask: db.prepare(`
      UPDATE outbox_tasks SET state='completed', result_json=?, updated_at=?
      WHERE scope_id=? AND task_id=?
    `),
    getAsset: db.prepare(`
      SELECT asset_id, relative_path, media_type, size_bytes, sha256,
             metadata_json, created_at, updated_at
      FROM asset_manifest WHERE scope_id=? AND asset_id=?
    `),
    listAssets: db.prepare(`
      SELECT asset_id, relative_path, media_type, size_bytes, sha256,
             metadata_json, created_at, updated_at
      FROM asset_manifest WHERE scope_id=?
      ORDER BY updated_at DESC LIMIT ? OFFSET ?
    `),
    upsertAsset: db.prepare(`
      INSERT INTO asset_manifest (
        scope_id, asset_id, relative_path, media_type, size_bytes, sha256,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_id, asset_id) DO UPDATE SET
        relative_path=excluded.relative_path,
        media_type=excluded.media_type,
        size_bytes=excluded.size_bytes,
        sha256=excluded.sha256,
        metadata_json=excluded.metadata_json,
        updated_at=excluded.updated_at
      RETURNING asset_id, relative_path, media_type, size_bytes, sha256,
                metadata_json, created_at, updated_at
    `),
    deleteAsset: db.prepare(`
      DELETE FROM asset_manifest WHERE scope_id=? AND asset_id=?
    `),
  };

  function normalizeIdentity(input = {}) {
    return {
      scopeId: requiredText(input.scopeId, SCOPE_PATTERN, 'CACHE_SCOPE_INVALID'),
      namespace: requiredText(input.namespace, NAMESPACE_PATTERN, 'CACHE_NAMESPACE_INVALID'),
      key: requiredText(input.key, KEY_PATTERN, 'CACHE_KEY_INVALID'),
    };
  }

  function prepareRecord(input = {}, timestamp = nowIso()) {
    const identity = normalizeIdentity(input);
    return {
      identity,
      sealedPayload: codec.sealJson(input.payload),
      expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
      timestamp,
    };
  }

  function persistPreparedRecord(prepared) {
    const row = statements.upsertRecord.get(
      prepared.identity.scopeId,
      prepared.identity.namespace,
      prepared.identity.key,
      prepared.sealedPayload,
      prepared.expiresAt,
      prepared.timestamp,
      prepared.timestamp,
    );
    return {
      key: prepared.identity.key,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  return Object.freeze({
    databasePath: resolvedDatabase,
    assetRoot: resolvedAssets,
    getRecord(input) {
      const identity = normalizeIdentity(input);
      const row = statements.getRecord.get(identity.scopeId, identity.namespace, identity.key);
      if (!row) return null;
      return {
        key: identity.key,
        payload: codec.openJson(row.payload_json),
        revision: row.revision,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },
    listRecords(input = {}) {
      const scopeId = requiredText(input.scopeId, SCOPE_PATTERN, 'CACHE_SCOPE_INVALID');
      const namespace = requiredText(input.namespace, NAMESPACE_PATTERN, 'CACHE_NAMESPACE_INVALID');
      const limit = Math.max(1, Math.min(1000, Number(input.limit) || 100));
      const offset = Math.max(0, Number(input.offset) || 0);
      return statements.listRecords.all(scopeId, namespace, limit, offset).map((row) => ({
        key: row.record_key,
        payload: codec.openJson(row.payload_json),
        revision: row.revision,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },
    listScopesByNamespace(namespaceValue) {
      const namespace = requiredText(namespaceValue, NAMESPACE_PATTERN, 'CACHE_NAMESPACE_INVALID');
      return statements.listScopesByNamespace.all(namespace).map((row) => String(row.scope_id));
    },
    putRecord(input) {
      return persistPreparedRecord(prepareRecord(input));
    },
    putRecordsAtomic(inputs) {
      if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 2000) {
        throw Object.assign(new Error('CACHE_ATOMIC_RECORDS_INVALID'), { code: 'CACHE_ATOMIC_RECORDS_INVALID' });
      }
      const timestamp = nowIso();
      // Validate and encrypt the complete batch before opening the transaction,
      // so malformed input cannot leave a partial legacy migration behind.
      const prepared = inputs.map((input) => prepareRecord(input, timestamp));
      db.exec('BEGIN IMMEDIATE;');
      try {
        const saved = prepared.map(persistPreparedRecord);
        db.exec('COMMIT;');
        return saved;
      } catch (error) {
        db.exec('ROLLBACK;');
        throw error;
      }
    },
    deleteRecord(input) {
      const identity = normalizeIdentity(input);
      const result = statements.deleteRecord.run(identity.scopeId, identity.namespace, identity.key);
      return { deleted: Number(result.changes) === 1 };
    },
    enqueueTask(input = {}) {
      const scopeId = requiredText(input.scopeId, SCOPE_PATTERN, 'CACHE_SCOPE_INVALID');
      const taskKind = requiredText(input.taskKind, NAMESPACE_PATTERN, 'OUTBOX_TASK_KIND_INVALID');
      const taskId = requiredText(input.taskId || crypto.randomUUID(), SCOPE_PATTERN, 'OUTBOX_TASK_ID_INVALID');
      const idempotencyKey = requiredText(input.idempotencyKey || crypto.randomUUID(), SCOPE_PATTERN, 'OUTBOX_IDEMPOTENCY_INVALID');
      const now = nowIso();
      statements.enqueueTask.run(taskId, scopeId, taskKind, codec.sealJson(input.request), idempotencyKey, now, now);
      return { taskId, idempotencyKey, state: 'pending' };
    },
    listTasks(input = {}) {
      const scopeId = requiredText(input.scopeId, SCOPE_PATTERN, 'CACHE_SCOPE_INVALID');
      const state = requiredText(input.state || 'pending', NAMESPACE_PATTERN, 'OUTBOX_STATE_INVALID');
      const limit = Math.max(1, Math.min(500, Number(input.limit) || 50));
      return statements.listTasks.all(scopeId, state, limit).map((row) => ({
        taskId: row.task_id,
        taskKind: row.task_kind,
        request: codec.openJson(row.request_json),
        state: row.state,
        attemptCount: row.attempt_count,
        idempotencyKey: row.idempotency_key,
        result: row.result_json ? codec.openJson(row.result_json) : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },
    completeTask(input = {}) {
      const scopeId = requiredText(input.scopeId, SCOPE_PATTERN, 'CACHE_SCOPE_INVALID');
      const taskId = requiredText(input.taskId, SCOPE_PATTERN, 'OUTBOX_TASK_ID_INVALID');
      const result = statements.completeTask.run(codec.sealJson(input.result), nowIso(), scopeId, taskId);
      return { completed: Number(result.changes) === 1 };
    },
    putAsset(input = {}) {
      const scopeId = requiredText(input.scopeId, SCOPE_PATTERN, 'CACHE_SCOPE_INVALID');
      const assetId = requiredText(input.assetId || crypto.randomUUID(), ASSET_ID_PATTERN, 'ASSET_ID_INVALID');
      const extension = requiredText(String(input.extension || 'bin').toLowerCase(), ASSET_EXTENSION_PATTERN, 'ASSET_EXTENSION_INVALID');
      const mediaType = requiredText(String(input.mediaType || '').toLowerCase(), MEDIA_TYPE_PATTERN, 'ASSET_MEDIA_TYPE_INVALID');
      const content = parseAssetContent(input.contentBase64);
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      const scopeDirectory = crypto.createHash('sha256').update(scopeId).digest('hex').slice(0, 32);
      const relativePath = path.join(scopeDirectory, `${assetId}-${sha256.slice(0, 16)}.${extension}`);
      const absolutePath = path.resolve(resolvedAssets, relativePath);
      if (!absolutePath.startsWith(`${resolvedAssets}${path.sep}`)) {
        throw Object.assign(new Error('ASSET_PATH_OUTSIDE_ROOT'), { code: 'ASSET_PATH_OUTSIDE_ROOT' });
      }
      const previous = statements.getAsset.get(scopeId, assetId);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      const temporaryPath = `${absolutePath}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporaryPath, codec.encryptBytes(content), { flag: 'wx' });
      try {
        if (fs.existsSync(absolutePath)) fs.rmSync(temporaryPath, { force: true });
        else fs.renameSync(temporaryPath, absolutePath);
        const now = nowIso();
        const row = statements.upsertAsset.get(
          scopeId,
          assetId,
          relativePath,
          mediaType,
          content.length,
          sha256,
          codec.sealJson(input.metadata || {}),
          now,
          now,
        );
        if (previous?.relative_path && previous.relative_path !== relativePath) {
          fs.rmSync(path.resolve(resolvedAssets, previous.relative_path), { force: true });
        }
        return assetDto(row, codec);
      } catch (error) {
        fs.rmSync(temporaryPath, { force: true });
        if (!previous || previous.relative_path !== relativePath) fs.rmSync(absolutePath, { force: true });
        throw error;
      }
    },
    getAsset(input = {}) {
      const scopeId = requiredText(input.scopeId, SCOPE_PATTERN, 'CACHE_SCOPE_INVALID');
      const assetId = requiredText(input.assetId, ASSET_ID_PATTERN, 'ASSET_ID_INVALID');
      return assetDto(statements.getAsset.get(scopeId, assetId), codec);
    },
    readAsset(input = {}) {
      const scopeId = requiredText(input.scopeId, SCOPE_PATTERN, 'CACHE_SCOPE_INVALID');
      const assetId = requiredText(input.assetId, ASSET_ID_PATTERN, 'ASSET_ID_INVALID');
      const row = statements.getAsset.get(scopeId, assetId);
      if (!row) return null;
      const absolutePath = path.resolve(resolvedAssets, row.relative_path);
      if (!absolutePath.startsWith(`${resolvedAssets}${path.sep}`) || !fs.existsSync(absolutePath)) return null;
      const content = codec.decryptBytes(fs.readFileSync(absolutePath));
      const actualSha256 = crypto.createHash('sha256').update(content).digest('hex');
      if (content.length !== row.size_bytes || actualSha256 !== row.sha256) {
        throw Object.assign(new Error('ASSET_INTEGRITY_INVALID'), { code: 'ASSET_INTEGRITY_INVALID' });
      }
      return { ...assetDto(row, codec), content };
    },
    listAssets(input = {}) {
      const scopeId = requiredText(input.scopeId, SCOPE_PATTERN, 'CACHE_SCOPE_INVALID');
      const limit = Math.max(1, Math.min(1000, Number(input.limit) || 100));
      const offset = Math.max(0, Number(input.offset) || 0);
      return statements.listAssets.all(scopeId, limit, offset).map((row) => assetDto(row, codec));
    },
    deleteAsset(input = {}) {
      const scopeId = requiredText(input.scopeId, SCOPE_PATTERN, 'CACHE_SCOPE_INVALID');
      const assetId = requiredText(input.assetId, ASSET_ID_PATTERN, 'ASSET_ID_INVALID');
      const row = statements.getAsset.get(scopeId, assetId);
      if (!row) return { deleted: false };
      const absolutePath = path.resolve(resolvedAssets, row.relative_path);
      if (!absolutePath.startsWith(`${resolvedAssets}${path.sep}`)) {
        throw Object.assign(new Error('ASSET_PATH_OUTSIDE_ROOT'), { code: 'ASSET_PATH_OUTSIDE_ROOT' });
      }
      fs.rmSync(absolutePath, { force: true });
      const result = statements.deleteAsset.run(scopeId, assetId);
      return { deleted: Number(result.changes) === 1 };
    },
    status() {
      const recordCount = Number(db.prepare('SELECT COUNT(*) AS count FROM cache_records').get().count);
      const pendingCount = Number(db.prepare("SELECT COUNT(*) AS count FROM outbox_tasks WHERE state='pending'").get().count);
      const assetCount = Number(db.prepare('SELECT COUNT(*) AS count FROM asset_manifest').get().count);
      return { recordCount, pendingCount, assetCount, databasePath: resolvedDatabase, assetRoot: resolvedAssets };
    },
    close() {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
    },
  });
}
