import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { backup as backupSqlite, DatabaseSync } from 'node:sqlite';
import { createStableHash } from '../utils/stableHash.js';

function lifecycleError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'ShopDatabaseLifecycleError';
  error.code = code;
  Object.assign(error, details);
  return error;
}

function isDescendant(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

function requireDescendant(root, candidate, code) {
  const resolvedRoot = resolve(String(root || ''));
  const resolvedCandidate = resolve(String(candidate || ''));
  if (!isDescendant(resolvedRoot, resolvedCandidate)) {
    throw lifecycleError(code, 'shop database lifecycle path escaped its configured root');
  }
  return resolvedCandidate;
}

function sha256File(filePath) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function checkpoint(db) {
  const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get();
  if (Number(result?.busy || 0) !== 0) {
    throw lifecycleError('SHOP_DATABASE_CHECKPOINT_BUSY', 'shop database checkpoint is busy');
  }
}

function verifyIntegrity(db) {
  const row = db.prepare('PRAGMA integrity_check;').get();
  const value = String(row?.integrity_check ?? Object.values(row || {})[0] ?? '').trim();
  if (value.toLowerCase() !== 'ok') {
    throw lifecycleError('SHOP_DATABASE_INTEGRITY_FAILED', 'shop database integrity check failed');
  }
}

function readScopeMetadata(db) {
  return db.prepare(`
    SELECT layout_version, profile_id, shop_id, shop_incarnation, scope_digest, created_at
    FROM shop_database_metadata
    WHERE singleton = 1
  `).get() || null;
}

function assertScopeMetadata(metadata, layout) {
  if (
    !metadata
    || Number(metadata.layout_version) !== layout.version
    || metadata.profile_id !== layout.profileId
    || metadata.shop_id !== layout.shopId
    || metadata.shop_incarnation !== layout.shopIncarnation
    || metadata.scope_digest !== layout.scopeDigest
  ) {
    throw lifecycleError('SHOP_DATABASE_BACKUP_SCOPE_MISMATCH', 'shop database backup belongs to another scope');
  }
}

function readContractStats(db) {
  const exists = db.prepare(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type = 'table' AND name = 'shop_cache_contracts'
  `).get();
  if (!exists) return { contractCount: 0, maxRevision: 0 };
  const row = db.prepare(`
    SELECT COUNT(*) AS contract_count, COALESCE(MAX(revision), 0) AS max_revision
    FROM shop_cache_contracts
  `).get();
  return {
    contractCount: Number(row?.contract_count || 0),
    maxRevision: Number(row?.max_revision || 0),
  };
}

function databaseFamily(databasePath) {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
}

export function createShopDatabaseLifecycle({
  shopDatabaseManager,
  backupRoot,
  shopAggregateIndex = null,
  now = () => new Date(),
} = {}) {
  if (
    !shopDatabaseManager?.resolve
    || !shopDatabaseManager?.openExisting
    || !shopDatabaseManager?.close
  ) {
    throw lifecycleError('SHOP_DATABASE_LIFECYCLE_MANAGER_REQUIRED', 'shop database manager is required');
  }
  const resolvedBackupRoot = resolve(String(backupRoot || '').trim());
  if (!String(backupRoot || '').trim()) {
    throw lifecycleError('SHOP_DATABASE_BACKUP_ROOT_REQUIRED', 'shop database backup root is required');
  }
  mkdirSync(resolvedBackupRoot, { recursive: true });

  async function preview(scopeToken) {
    const layout = shopDatabaseManager.resolve(scopeToken);
    if (!shopDatabaseManager.has(scopeToken)) {
      return Object.freeze({
        ok: true,
        exists: false,
        layout,
        contractCount: 0,
        maxRevision: 0,
        byteSize: 0,
        databaseSha256: null,
        fingerprint: createStableHash({ scopeDigest: layout.scopeDigest, exists: false }, { length: 64 }),
      });
    }
    const handle = shopDatabaseManager.openExisting(scopeToken);
    checkpoint(handle.db);
    verifyIntegrity(handle.db);
    assertScopeMetadata(readScopeMetadata(handle.db), layout);
    const stats = readContractStats(handle.db);
    const databaseSha256 = await sha256File(layout.databasePath);
    const byteSize = statSync(layout.databasePath).size;
    return Object.freeze({
      ok: true,
      exists: true,
      layout,
      ...stats,
      byteSize,
      databaseSha256,
      fingerprint: createStableHash({
        scopeDigest: layout.scopeDigest,
        contractCount: stats.contractCount,
        maxRevision: stats.maxRevision,
        byteSize,
        databaseSha256,
      }, { length: 64 }),
    });
  }

  async function validateBackup({ backupPath, expectedSha256, layout }) {
    const resolvedBackupPath = requireDescendant(
      resolvedBackupRoot,
      backupPath,
      'SHOP_DATABASE_BACKUP_PATH_ESCAPE',
    );
    if (!existsSync(resolvedBackupPath)) {
      throw lifecycleError('SHOP_DATABASE_BACKUP_NOT_FOUND', 'shop database backup was not found');
    }
    const actualSha256 = await sha256File(resolvedBackupPath);
    if (expectedSha256 && actualSha256 !== String(expectedSha256).trim().toLowerCase()) {
      throw lifecycleError('SHOP_DATABASE_BACKUP_HASH_MISMATCH', 'shop database backup hash mismatch');
    }
    const db = new DatabaseSync(resolvedBackupPath, { readOnly: true });
    try {
      verifyIntegrity(db);
      assertScopeMetadata(readScopeMetadata(db), layout);
      return Object.freeze({
        backupPath: resolvedBackupPath,
        backupSha256: actualSha256,
        byteSize: statSync(resolvedBackupPath).size,
        ...readContractStats(db),
      });
    } finally {
      db.close();
    }
  }

  async function backupScope({ scopeToken, expectedFingerprint = '' } = {}) {
    const before = await preview(scopeToken);
    if (!before.exists) {
      throw lifecycleError('SHOP_DATABASE_NOT_FOUND', 'shop database does not exist');
    }
    if (expectedFingerprint && before.fingerprint !== expectedFingerprint) {
      throw lifecycleError('SHOP_DATABASE_PREVIEW_STALE', 'shop database changed after preview');
    }
    const directory = requireDescendant(
      resolvedBackupRoot,
      resolve(resolvedBackupRoot, before.layout.scopeDigest),
      'SHOP_DATABASE_BACKUP_PATH_ESCAPE',
    );
    mkdirSync(directory, { recursive: true });
    const timestamp = new Date(now()).toISOString().replaceAll(/[^0-9]/gu, '').slice(0, 17);
    const backupPath = requireDescendant(
      resolvedBackupRoot,
      resolve(directory, `${timestamp}-${randomUUID()}.sqlite`),
      'SHOP_DATABASE_BACKUP_PATH_ESCAPE',
    );
    const handle = shopDatabaseManager.openExisting(scopeToken);
    try {
      await backupSqlite(handle.db, backupPath);
      const verified = await validateBackup({ backupPath, layout: before.layout });
      const after = await preview(scopeToken);
      if (after.fingerprint !== before.fingerprint) {
        rmSync(backupPath, { force: true });
        throw lifecycleError('SHOP_DATABASE_PREVIEW_STALE', 'shop database changed while backup was created');
      }
      return Object.freeze({
        ok: true,
        scopeDigest: before.layout.scopeDigest,
        sourceFingerprint: before.fingerprint,
        createdAt: new Date(now()).toISOString(),
        ...verified,
      });
    } catch (error) {
      if (existsSync(backupPath)) rmSync(backupPath, { force: true });
      throw error;
    }
  }

  function removeExactFamily(layout) {
    const expectedName = 'shop-cache.sqlite';
    if (basename(layout.databasePath) !== expectedName) {
      throw lifecycleError('SHOP_DATABASE_DELETE_TARGET_INVALID', 'shop database filename does not match its scope');
    }
    if (
      basename(layout.scopeDirectory) !== `scope-${layout.scopeDigest.slice(0, 16)}`
      || dirname(layout.scopeDirectory) !== layout.shopDirectory
      || dirname(layout.shopDirectory) !== layout.root
    ) {
      throw lifecycleError('SHOP_DATABASE_DELETE_TARGET_INVALID', 'shop database directory does not match its scope');
    }
    requireDescendant(layout.root, layout.databasePath, 'SHOP_DATABASE_DELETE_PATH_ESCAPE');
    for (const filePath of databaseFamily(layout.databasePath)) {
      const exactPath = requireDescendant(layout.root, filePath, 'SHOP_DATABASE_DELETE_PATH_ESCAPE');
      if (existsSync(exactPath)) rmSync(exactPath, { force: true });
    }
    const exactScopeDirectory = requireDescendant(
      layout.root,
      layout.scopeDirectory,
      'SHOP_DATABASE_DELETE_PATH_ESCAPE',
    );
    if (existsSync(exactScopeDirectory)) rmSync(exactScopeDirectory, { recursive: true, force: true });
    const exactShopDirectory = requireDescendant(
      layout.root,
      layout.shopDirectory,
      'SHOP_DATABASE_DELETE_PATH_ESCAPE',
    );
    if (existsSync(exactShopDirectory)) {
      const remaining = readdirSync(exactShopDirectory).filter((name) => name !== 'shop-info.json');
      if (!remaining.length) rmSync(exactShopDirectory, { recursive: true, force: true });
    }
  }

  async function restoreFromBackup({ scopeToken, backupPath, backupSha256 } = {}) {
    const layout = shopDatabaseManager.resolve(scopeToken);
    if (shopDatabaseManager.has(scopeToken)) {
      throw lifecycleError('SHOP_DATABASE_RESTORE_TARGET_EXISTS', 'shop database restore target already exists');
    }
    const verified = await validateBackup({ backupPath, expectedSha256: backupSha256, layout });
    const temporaryPath = requireDescendant(
      layout.root,
      `${layout.databasePath}.restore-${randomUUID()}.tmp`,
      'SHOP_DATABASE_RESTORE_PATH_ESCAPE',
    );
    mkdirSync(dirname(layout.databasePath), { recursive: true });
    try {
      copyFileSync(verified.backupPath, temporaryPath, constants.COPYFILE_EXCL);
      renameSync(temporaryPath, layout.databasePath);
      const handle = shopDatabaseManager.openExisting(scopeToken);
      verifyIntegrity(handle.db);
      assertScopeMetadata(readScopeMetadata(handle.db), layout);
      reindexScope(scopeToken);
      const restored = await preview(scopeToken);
      return Object.freeze({ ok: true, restored: true, backup: verified, preview: restored });
    } catch (error) {
      shopDatabaseManager.close(scopeToken);
      if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
      if (existsSync(layout.databasePath)) removeExactFamily(layout);
      throw error;
    }
  }

  function reindexScope(scopeToken) {
    const layout = shopDatabaseManager.resolve(scopeToken);
    shopAggregateIndex?.removeScope?.(layout);
    if (!shopDatabaseManager.has(scopeToken)) return Object.freeze({ ok: true, indexed: 0 });
    const handle = shopDatabaseManager.openExisting(scopeToken);
    const table = handle.db.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'shop_cache_contracts'
    `).get();
    if (!table || typeof shopAggregateIndex?.record !== 'function') {
      return Object.freeze({ ok: true, indexed: 0 });
    }
    const rows = handle.db.prepare(`
      SELECT contract_key, domain, query_hash, payload_hash, revision, committed_at
      FROM shop_cache_contracts
      ORDER BY contract_key ASC
    `).all();
    for (const row of rows) {
      shopAggregateIndex.record({
        scopeToken,
        layout,
        contractKey: row.contract_key,
        domain: row.domain,
        queryHash: row.query_hash,
        payloadHash: row.payload_hash,
        revision: row.revision,
        committedAt: row.committed_at,
      });
    }
    return Object.freeze({ ok: true, indexed: rows.length });
  }

  function observeResource({ owner, scopeToken, resourceId } = {}) {
    if (owner?.ownerType !== 'ozon_shop') return null;
    if (!scopeToken || String(scopeToken.shopId || '').trim() !== String(owner.ownerId || '').trim()) {
      throw lifecycleError('SHOP_DATABASE_OBSERVATION_SCOPE_INVALID', 'shop database observation scope is invalid');
    }
    const layout = shopDatabaseManager.resolve(scopeToken);
    if (resourceId === 'filesystem:shop-database-scope') {
      if (!shopDatabaseManager.has(scopeToken)) return Object.freeze({ state: 'absent' });
      const handle = shopDatabaseManager.openExisting(scopeToken);
      const metadata = readScopeMetadata(handle.db);
      assertScopeMetadata(metadata, layout);
      const stats = readContractStats(handle.db);
      return Object.freeze({
        state: 'observed',
        count: 1,
        revision: String(stats.maxRevision),
        hash: createStableHash({
          scopeDigest: layout.scopeDigest,
          metadata,
          contractCount: stats.contractCount,
          maxRevision: stats.maxRevision,
        }, { length: 64 }),
      });
    }
    if (resourceId === 'filesystem:shop-aggregate-index-scope') {
      const observation = typeof shopAggregateIndex?.observeScope === 'function'
        ? shopAggregateIndex.observeScope(layout)
        : { state: 'absent', count: 0 };
      if (observation.state === 'absent') return Object.freeze({ state: 'absent' });
      return Object.freeze({
        state: 'observed',
        count: observation.count,
        revision: observation.revision,
        hash: observation.hash,
      });
    }
    return null;
  }

  function readScopeContracts(scopeToken) {
    if (!shopDatabaseManager.has(scopeToken)) return [];
    const handle = shopDatabaseManager.openExisting(scopeToken);
    const table = handle.db.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'shop_cache_contracts'
    `).get();
    if (!table) return [];
    return handle.db.prepare(`
      SELECT contract_key, domain, query_hash, payload_hash, revision, committed_at
      FROM shop_cache_contracts
      ORDER BY contract_key ASC
    `).all().map((row) => Object.freeze({
      contractKey: row.contract_key,
      domain: row.domain,
      queryHash: row.query_hash,
      payloadHash: row.payload_hash,
      revision: Number(row.revision),
      committedAt: row.committed_at,
    }));
  }

  function compareScopeIndex(layout, expectedRows, actualRows) {
    const expectedByKey = new Map(expectedRows.map((row) => [row.contractKey, row]));
    const actualByKey = new Map(actualRows.map((row) => [row.contractKey, row]));
    const missing = [];
    const mismatched = [];
    const extra = [];
    for (const [contractKey, expected] of expectedByKey) {
      const actual = actualByKey.get(contractKey);
      if (!actual) {
        missing.push(contractKey);
        continue;
      }
      if (
        actual.scopeDigest !== layout.scopeDigest
        || actual.shopId !== layout.shopId
        || actual.shopIncarnation !== layout.shopIncarnation
        || actual.domain !== expected.domain
        || actual.queryHash !== expected.queryHash
        || actual.payloadHash !== expected.payloadHash
        || Number(actual.revision) !== expected.revision
        || actual.committedAt !== expected.committedAt
      ) mismatched.push(contractKey);
    }
    for (const contractKey of actualByKey.keys()) {
      if (!expectedByKey.has(contractKey)) extra.push(contractKey);
    }
    return Object.freeze({
      ok: missing.length === 0 && mismatched.length === 0 && extra.length === 0,
      expected: expectedRows.length,
      actual: actualRows.length,
      missing: Object.freeze(missing),
      mismatched: Object.freeze(mismatched),
      extra: Object.freeze(extra),
      fingerprint: createStableHash({
        scopeDigest: layout.scopeDigest,
        expectedRows,
        actualRows: actualRows.map((row) => ({
          contractKey: row.contractKey,
          domain: row.domain,
          queryHash: row.queryHash,
          payloadHash: row.payloadHash,
          revision: row.revision,
          committedAt: row.committedAt,
        })),
      }, { length: 64 }),
    });
  }

  function reconcileScope(scopeToken, { repair = false } = {}) {
    const layout = shopDatabaseManager.resolve(scopeToken);
    const inspect = () => compareScopeIndex(
      layout,
      readScopeContracts(scopeToken),
      typeof shopAggregateIndex?.listScope === 'function' ? shopAggregateIndex.listScope(layout) : [],
    );
    const before = inspect();
    if (!repair || before.ok) return Object.freeze({ ok: before.ok, repaired: false, before, after: before });
    reindexScope(scopeToken);
    const after = inspect();
    return Object.freeze({ ok: after.ok, repaired: true, before, after });
  }

  async function deleteWithBackup({ scopeToken, expectedFingerprint = '', onBackup = null } = {}) {
    const before = await preview(scopeToken);
    if (!before.exists) {
      shopAggregateIndex?.removeScope?.(before.layout);
      return Object.freeze({ ok: true, deleted: false, alreadyAbsent: true, preview: before, backup: null });
    }
    if (expectedFingerprint && before.fingerprint !== expectedFingerprint) {
      throw lifecycleError('SHOP_DATABASE_PREVIEW_STALE', 'shop database changed after preview');
    }
    const backup = await backupScope({ scopeToken, expectedFingerprint: before.fingerprint });
    const current = await preview(scopeToken);
    if (current.fingerprint !== before.fingerprint) {
      throw lifecycleError('SHOP_DATABASE_PREVIEW_STALE', 'shop database changed before deletion');
    }
    if (typeof onBackup === 'function') await onBackup(backup, before);
    shopDatabaseManager.close(scopeToken);
    try {
      removeExactFamily(before.layout);
      shopAggregateIndex?.removeScope?.(before.layout);
      const remaining = databaseFamily(before.layout.databasePath).filter(existsSync);
      if (remaining.length || existsSync(before.layout.scopeDirectory)) {
        throw lifecycleError('SHOP_DATABASE_DELETE_VERIFY_FAILED', 'shop database files remain after deletion');
      }
      return Object.freeze({ ok: true, deleted: true, alreadyAbsent: false, preview: before, backup });
    } catch (error) {
      if (!existsSync(before.layout.databasePath)) {
        try {
          mkdirSync(dirname(before.layout.databasePath), { recursive: true });
          copyFileSync(backup.backupPath, before.layout.databasePath, constants.COPYFILE_EXCL);
          shopDatabaseManager.openExisting(scopeToken);
          reindexScope(scopeToken);
        } catch {
          // Keep the verified backup for an explicit retry/restore operation.
        }
      }
      throw error;
    }
  }

  async function rebuildEmpty({ scopeToken, expectedFingerprint = '' } = {}) {
    const deletion = await deleteWithBackup({ scopeToken, expectedFingerprint });
    const handle = shopDatabaseManager.ensure(scopeToken);
    shopAggregateIndex?.removeScope?.(handle.layout);
    return Object.freeze({ ok: true, rebuilt: true, backup: deletion.backup, layout: handle.layout });
  }

  return Object.freeze({
    backupRoot: resolvedBackupRoot,
    preview,
    backupScope,
    deleteWithBackup,
    restoreFromBackup,
    rebuildEmpty,
    reindexScope,
    observeResource,
    reconcileScope,
  });
}
