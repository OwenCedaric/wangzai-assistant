import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SHOP_DATABASE_LAYOUT_VERSION = 2;
const SHOP_DATABASE_APPLICATION_ID = 0x575a5302;
const SHOP_DATABASE_FILENAME = 'shop-cache.sqlite';
const SHOP_IDENTITY_FILENAME = 'shop-info.json';
const SHOP_SCOPE_IDENTITY_FILENAME = 'scope-info.json';
const LEGACY_LAYOUT_VERSION = 1;

function requiredIdentity(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > 500 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    const error = new Error(`${field} is required`);
    error.code = `SHOP_DATABASE_${field.replaceAll(/[^A-Za-z0-9]/gu, '_').toUpperCase()}_INVALID`;
    throw error;
  }
  return normalized;
}

function encodeIdentity(value) {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

function createDigest(namespace, ...values) {
  const hash = createHash('sha256').update(`${namespace}\0`, 'utf8');
  for (const value of values) hash.update(encodeIdentity(value), 'utf8');
  return hash.digest('hex');
}

function safeDirectoryPart(value) {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replaceAll(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
    .replaceAll(/\s+/gu, '-')
    .replaceAll(/^[.\s-]+|[.\s-]+$/gu, '')
    .slice(0, 64);
  return normalized || 'unknown-shop';
}

function optionalDisplayText(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) return '';
  return normalized.slice(0, 200);
}

function isDescendant(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

export function resolveShopDatabaseLayout({
  root,
  profileId,
  shopId,
  shopIncarnation,
}) {
  const resolvedRoot = resolve(requiredIdentity(root, 'root'));
  const normalizedProfileId = requiredIdentity(profileId, 'profile_id');
  const normalizedShopId = requiredIdentity(shopId, 'shop_id');
  const normalizedIncarnation = requiredIdentity(shopIncarnation, 'shop_incarnation');
  // Keep the v1 digest stable: aggregate-index rows and verified backup
  // receipts already use it as the immutable scope identity.
  const scopeDigest = createDigest(
    'wangzai-shop-database:v1',
    normalizedProfileId,
    normalizedShopId,
    normalizedIncarnation,
  );
  const shopDigest = createDigest('wangzai-shop-directory:v2', normalizedProfileId, normalizedShopId);
  const shopDirectoryName = `shop-${safeDirectoryPart(normalizedShopId)}--${shopDigest.slice(0, 12)}`;
  const shopDirectory = resolve(resolvedRoot, shopDirectoryName);
  const scopeDirectory = resolve(shopDirectory, `scope-${scopeDigest.slice(0, 16)}`);
  const databasePath = resolve(scopeDirectory, SHOP_DATABASE_FILENAME);
  const shopIdentityPath = resolve(shopDirectory, SHOP_IDENTITY_FILENAME);
  const scopeIdentityPath = resolve(scopeDirectory, SHOP_SCOPE_IDENTITY_FILENAME);
  const legacyDatabasePath = resolve(resolvedRoot, `${scopeDigest}.sqlite`);
  const migrationBackupDirectory = resolve(scopeDirectory, 'migration-backup-v1');
  if ([shopDirectory, scopeDirectory, databasePath, shopIdentityPath, scopeIdentityPath,
    legacyDatabasePath, migrationBackupDirectory].some((candidate) => !isDescendant(resolvedRoot, candidate))) {
    const error = new Error('shop database path escaped its root');
    error.code = 'SHOP_DATABASE_PATH_ESCAPE';
    throw error;
  }
  return Object.freeze({
    version: SHOP_DATABASE_LAYOUT_VERSION,
    root: resolvedRoot,
    profileId: normalizedProfileId,
    shopId: normalizedShopId,
    shopIncarnation: normalizedIncarnation,
    scopeDigest,
    shopDigest,
    shopDirectoryName,
    shopDirectory,
    scopeDirectory,
    databasePath,
    shopIdentityPath,
    scopeIdentityPath,
    legacyDatabasePath,
    migrationBackupDirectory,
  });
}

function configureConnection(db, { busyTimeoutMs, enableWal, newDatabase }) {
  if (newDatabase) db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`PRAGMA busy_timeout = ${Number.isFinite(busyTimeoutMs) ? Math.max(0, Math.trunc(busyTimeoutMs)) : 5000};`);
  db.exec(`PRAGMA application_id = ${SHOP_DATABASE_APPLICATION_ID};`);
  if (enableWal !== false) db.prepare('PRAGMA journal_mode = WAL;').get();
}

function ensureScopeMetadata(db, layout, now) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_database_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      layout_version INTEGER NOT NULL,
      profile_id TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      shop_incarnation TEXT NOT NULL,
      scope_digest TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `);
  const existing = db.prepare(`
    SELECT layout_version, profile_id, shop_id, shop_incarnation, scope_digest, created_at
    FROM shop_database_metadata
    WHERE singleton = 1
  `).get();
  if (!existing) {
    db.prepare(`
      INSERT INTO shop_database_metadata (
        singleton, layout_version, profile_id, shop_id, shop_incarnation, scope_digest, created_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?)
    `).run(
      layout.version,
      layout.profileId,
      layout.shopId,
      layout.shopIncarnation,
      layout.scopeDigest,
      new Date(now()).toISOString(),
    );
  }
  const readback = db.prepare(`
    SELECT layout_version, profile_id, shop_id, shop_incarnation, scope_digest, created_at
    FROM shop_database_metadata
    WHERE singleton = 1
  `).get();
  if (
    ![LEGACY_LAYOUT_VERSION, layout.version].includes(Number(readback?.layout_version))
    || readback?.profile_id !== layout.profileId
    || readback?.shop_id !== layout.shopId
    || readback?.shop_incarnation !== layout.shopIncarnation
    || readback?.scope_digest !== layout.scopeDigest
  ) {
    const error = new Error('shop database scope metadata mismatch');
    error.code = 'SHOP_DATABASE_SCOPE_MISMATCH';
    throw error;
  }
  if (Number(readback.layout_version) !== layout.version) {
    db.prepare(`
      UPDATE shop_database_metadata
      SET layout_version = ?
      WHERE singleton = 1 AND layout_version = ?
    `).run(layout.version, LEGACY_LAYOUT_VERSION);
    readback.layout_version = layout.version;
  }
  return Object.freeze({
    layoutVersion: Number(readback.layout_version),
    profileId: readback.profile_id,
    shopId: readback.shop_id,
    shopIncarnation: readback.shop_incarnation,
    scopeDigest: readback.scope_digest,
    createdAt: readback.created_at,
  });
}

function ensureDisplayIdentity(db, identity, now) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_display_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      display_name TEXT,
      alias TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  const hasProvidedName = Boolean(identity) && (
    Object.prototype.hasOwnProperty.call(identity, 'displayName')
    || Object.prototype.hasOwnProperty.call(identity, 'name')
  );
  const hasProvidedAlias = Boolean(identity) && Object.prototype.hasOwnProperty.call(identity, 'alias');
  const providedName = optionalDisplayText(identity?.displayName ?? identity?.name);
  const providedAlias = optionalDisplayText(identity?.alias);
  const existing = db.prepare(`
    SELECT display_name, alias, updated_at
    FROM shop_display_identity
    WHERE singleton = 1
  `).get();
  if (!existing) {
    db.prepare(`
      INSERT INTO shop_display_identity (singleton, display_name, alias, updated_at)
      VALUES (1, ?, ?, ?)
    `).run(providedName || null, providedAlias || null, new Date(now()).toISOString());
  } else if (
    (hasProvidedName && providedName !== (existing.display_name || ''))
    || (hasProvidedAlias && providedAlias !== (existing.alias || ''))
  ) {
    db.prepare(`
      UPDATE shop_display_identity
      SET display_name = CASE WHEN ? = 1 THEN ? ELSE display_name END,
          alias = CASE WHEN ? = 1 THEN ? ELSE alias END,
          updated_at = ?
      WHERE singleton = 1
    `).run(
      hasProvidedName ? 1 : 0,
      providedName || null,
      hasProvidedAlias ? 1 : 0,
      providedAlias || null,
      new Date(now()).toISOString(),
    );
  }
  const readback = db.prepare(`
    SELECT display_name, alias, updated_at
    FROM shop_display_identity
    WHERE singleton = 1
  `).get();
  return Object.freeze({
    displayName: readback?.display_name || '',
    alias: readback?.alias || '',
    updatedAt: readback?.updated_at || '',
  });
}

function writeJsonFile(filePath, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const existing = lstatSync(filePath);
    if (existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1
      && existing.size === Buffer.byteLength(serialized) && readFileSync(filePath, 'utf8') === serialized) return;
  } catch { /* Missing/unreadable metadata follows the existing replacement path. */ }
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.writing-${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' });
  try {
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      // Windows cannot always atomically replace an existing file. The
      // identity document is reconstructable from SQLite and never contains
      // business payloads or credentials, so a direct rewrite is safe here.
      writeFileSync(filePath, serialized, 'utf8');
    } finally {
      try { if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
    }
    if (!existsSync(filePath)) throw error;
  }
}

function writeIdentityDocuments(layout, metadata, displayIdentity) {
  const displayLabel = displayIdentity.alias || displayIdentity.displayName || layout.shopId;
  const shared = {
    format: 'wangzai-ozon-shop-cache',
    layoutVersion: layout.version,
    platform: 'Ozon',
    displayLabel,
    shopId: layout.shopId,
    shopName: displayIdentity.displayName,
    shopAlias: displayIdentity.alias,
    profileId: layout.profileId,
    shopDirectory: layout.shopDirectoryName,
    updatedAt: displayIdentity.updatedAt,
  };
  writeJsonFile(layout.shopIdentityPath, {
    ...shared,
    currentScope: `scope-${layout.scopeDigest.slice(0, 16)}`,
    note: '一个店铺一个目录；密钥和业务正文不会写入此说明文件。',
  });
  writeJsonFile(layout.scopeIdentityPath, {
    ...shared,
    shopIncarnation: layout.shopIncarnation,
    scopeDigest: layout.scopeDigest,
    databaseFile: SHOP_DATABASE_FILENAME,
    createdAt: metadata.createdAt,
  });
}

function readLegacyMetadata(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare(`
      SELECT layout_version, profile_id, shop_id, shop_incarnation, scope_digest, created_at
      FROM shop_database_metadata
      WHERE singleton = 1
    `).get() || null;
  } finally {
    db.close();
  }
}

function verifyDatabaseIntegrity(db) {
  const row = db.prepare('PRAGMA integrity_check;').get();
  const result = String(row?.integrity_check ?? Object.values(row || {})[0] ?? '').trim().toLowerCase();
  if (result !== 'ok') {
    const error = new Error('shop database integrity check failed');
    error.code = 'SHOP_DATABASE_INTEGRITY_FAILED';
    throw error;
  }
}

function assertDatabaseMetadata(metadata, layout, allowedVersions) {
  if (
    !allowedVersions.includes(Number(metadata?.layout_version))
    || metadata?.profile_id !== layout.profileId
    || metadata?.shop_id !== layout.shopId
    || metadata?.shop_incarnation !== layout.shopIncarnation
    || metadata?.scope_digest !== layout.scopeDigest
  ) {
    const error = new Error('shop database scope metadata mismatch');
    error.code = 'SHOP_DATABASE_SCOPE_MISMATCH';
    throw error;
  }
}

function archiveLegacyDatabaseFamily(layout) {
  if (!existsSync(layout.legacyDatabasePath)) return null;
  mkdirSync(layout.migrationBackupDirectory, { recursive: true });
  let legacyBackupPath = resolve(layout.migrationBackupDirectory, 'legacy-shop-cache.sqlite');
  if (existsSync(legacyBackupPath)) {
    legacyBackupPath = resolve(
      layout.migrationBackupDirectory,
      `legacy-shop-cache-${randomUUID()}.sqlite`,
    );
  }
  renameSync(layout.legacyDatabasePath, legacyBackupPath);
  for (const suffix of ['-wal', '-shm']) {
    const source = `${layout.legacyDatabasePath}${suffix}`;
    const target = `${legacyBackupPath}${suffix}`;
    if (existsSync(source)) renameSync(source, target);
  }
  return legacyBackupPath;
}

function migrateLegacyDatabase(layout, { busyTimeoutMs, enableWal, now }) {
  if (!existsSync(layout.legacyDatabasePath)) return false;
  if (existsSync(layout.databasePath)) {
    const current = new DatabaseSync(layout.databasePath, { readOnly: true });
    try {
      verifyDatabaseIntegrity(current);
      const metadata = current.prepare(`
        SELECT layout_version, profile_id, shop_id, shop_incarnation, scope_digest, created_at
        FROM shop_database_metadata
        WHERE singleton = 1
      `).get();
      assertDatabaseMetadata(metadata, layout, [layout.version]);
    } finally {
      current.close();
    }
    archiveLegacyDatabaseFamily(layout);
    return false;
  }
  if (basename(layout.legacyDatabasePath) !== `${layout.scopeDigest}.sqlite`) {
    const error = new Error('legacy shop database filename does not match its scope');
    error.code = 'SHOP_DATABASE_LEGACY_PATH_INVALID';
    throw error;
  }
  const legacyDb = new DatabaseSync(layout.legacyDatabasePath);
  let metadata;
  try {
    configureConnection(legacyDb, { busyTimeoutMs, enableWal, newDatabase: false });
    metadata = legacyDb.prepare(`
      SELECT layout_version, profile_id, shop_id, shop_incarnation, scope_digest, created_at
      FROM shop_database_metadata
      WHERE singleton = 1
    `).get();
    assertDatabaseMetadata(metadata, layout, [LEGACY_LAYOUT_VERSION]);
    verifyDatabaseIntegrity(legacyDb);
    const checkpoint = legacyDb.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get();
    if (Number(checkpoint?.busy || 0) !== 0) {
      const error = new Error('legacy shop database is busy');
      error.code = 'SHOP_DATABASE_MIGRATION_BUSY';
      throw error;
    }
  } finally {
    legacyDb.close();
  }

  mkdirSync(layout.scopeDirectory, { recursive: true });
  const temporaryPath = resolve(layout.scopeDirectory, `${SHOP_DATABASE_FILENAME}.migrating-${randomUUID()}.tmp`);
  copyFileSync(layout.legacyDatabasePath, temporaryPath, 1);
  try {
    const copied = new DatabaseSync(temporaryPath);
    try {
      verifyDatabaseIntegrity(copied);
      ensureScopeMetadata(copied, layout, now);
      ensureDisplayIdentity(copied, null, now);
    } finally {
      copied.close();
    }
    renameSync(temporaryPath, layout.databasePath);
  } catch (error) {
    try { if (existsSync(temporaryPath)) renameSync(temporaryPath, `${temporaryPath}.failed`); } catch { /* preserve evidence */ }
    throw error;
  }

  // Preserve the exact v1 source inside the same shop scope as a one-time,
  // recoverable migration fallback. It is never opened by the v2 runtime.
  archiveLegacyDatabaseFamily(layout);
  return true;
}

export function openShopDatabase({
  root,
  profileId,
  shopId,
  shopIncarnation,
  create = false,
  enableWal = true,
  busyTimeoutMs = 5000,
  now = () => new Date(),
}) {
  const layout = resolveShopDatabaseLayout({ root, profileId, shopId, shopIncarnation });
  const migrated = migrateLegacyDatabase(layout, { busyTimeoutMs, enableWal, now });
  const existed = existsSync(layout.databasePath) && statSync(layout.databasePath).size > 0;
  if (!create && !existed) {
    const error = new Error('shop database does not exist');
    error.code = 'SHOP_DATABASE_NOT_FOUND';
    throw error;
  }
  if (create) mkdirSync(dirname(layout.databasePath), { recursive: true });
  const db = new DatabaseSync(layout.databasePath);
  try {
    configureConnection(db, { busyTimeoutMs, enableWal, newDatabase: !existed });
    const metadata = ensureScopeMetadata(db, layout, now);
    const displayIdentity = ensureDisplayIdentity(db, null, now);
    writeIdentityDocuments(layout, metadata, displayIdentity);
    return Object.freeze({ db, layout, metadata, displayIdentity, created: !existed, migrated });
  } catch (error) {
    db.close();
    throw error;
  }
}

function closeHandle(handle) {
  try {
    handle.db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get();
  } catch {
    // SQLite can recover a WAL on the next open; close must still continue.
  }
  handle.db.close();
}

export function createShopDatabaseManager({
  root,
  profileId,
  enableWal = true,
  busyTimeoutMs = 5000,
  now = () => new Date(),
  onMigrationError = () => undefined,
}) {
  const handles = new Map();
  const normalizedProfileId = requiredIdentity(profileId, 'profile_id');
  const migrationStatus = { discovered: 0, migrated: 0, failures: 0, lastErrorCode: '' };

  function layoutFor(scope) {
    return resolveShopDatabaseLayout({
      root,
      profileId: normalizedProfileId,
      shopId: scope?.shopId,
      shopIncarnation: scope?.shopIncarnation,
    });
  }

  function attachDisplayIdentity(handle, identity) {
    if (!identity && existsSync(handle.layout.shopIdentityPath) && existsSync(handle.layout.scopeIdentityPath)) {
      return handle.displayIdentity;
    }
    const displayIdentity = ensureDisplayIdentity(handle.db, identity, now);
    writeIdentityDocuments(handle.layout, handle.metadata, displayIdentity);
    return displayIdentity;
  }

  function ensure(scope, identity = null) {
    const layout = layoutFor(scope);
    const existing = handles.get(layout.scopeDigest);
    if (existing) {
      attachDisplayIdentity(existing, identity);
      return existing;
    }
    const handle = openShopDatabase({
      ...layout,
      create: true,
      enableWal,
      busyTimeoutMs,
      now,
    });
    attachDisplayIdentity(handle, identity);
    handles.set(layout.scopeDigest, handle);
    return handle;
  }

  function openExisting(scope, identity = null) {
    const layout = layoutFor(scope);
    const existing = handles.get(layout.scopeDigest);
    if (existing) {
      attachDisplayIdentity(existing, identity);
      return existing;
    }
    const handle = openShopDatabase({
      ...layout,
      create: false,
      enableWal,
      busyTimeoutMs,
      now,
    });
    attachDisplayIdentity(handle, identity);
    handles.set(layout.scopeDigest, handle);
    return handle;
  }

  function has(scope) {
    const layout = layoutFor(scope);
    return existsSync(layout.databasePath) && statSync(layout.databasePath).size > 0;
  }

  function get(scope) {
    return handles.get(layoutFor(scope).scopeDigest) || null;
  }

  function close(scope) {
    const layout = layoutFor(scope);
    const handle = handles.get(layout.scopeDigest);
    if (!handle) return false;
    handles.delete(layout.scopeDigest);
    closeHandle(handle);
    return true;
  }

  function closeAll() {
    for (const handle of handles.values()) closeHandle(handle);
    const closed = handles.size;
    handles.clear();
    return closed;
  }

  function migrateDiscoveredLegacyDatabases() {
    if (!existsSync(resolve(root))) return Object.freeze({ ...migrationStatus });
    const candidates = readdirSync(resolve(root), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.sqlite$/u.test(entry.name));
    migrationStatus.discovered = candidates.length;
    for (const entry of candidates) {
      const legacyPath = resolve(root, entry.name);
      try {
        const metadata = readLegacyMetadata(legacyPath);
        if (
          !metadata
          || metadata.profile_id !== normalizedProfileId
          || metadata.scope_digest !== entry.name.slice(0, 64)
        ) continue;
        const layout = layoutFor({
          shopId: metadata.shop_id,
          shopIncarnation: metadata.shop_incarnation,
        });
        if (migrateLegacyDatabase(layout, { busyTimeoutMs, enableWal, now })) {
          migrationStatus.migrated += 1;
        }
      } catch (error) {
        migrationStatus.failures += 1;
        migrationStatus.lastErrorCode = String(error?.code || 'SHOP_DATABASE_MIGRATION_FAILED');
        onMigrationError(error, { legacyPath });
      }
    }
    return Object.freeze({ ...migrationStatus });
  }

  function snapshot() {
    const physical = { shops: 0, scopes: 0, databases: 0 };
    if (existsSync(resolve(root))) {
      const shopDirectories = readdirSync(resolve(root), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('shop-'));
      physical.shops = shopDirectories.length;
      for (const shopEntry of shopDirectories) {
        const shopDirectory = resolve(root, shopEntry.name);
        for (const scopeEntry of readdirSync(shopDirectory, { withFileTypes: true })) {
          if (!scopeEntry.isDirectory() || !scopeEntry.name.startsWith('scope-')) continue;
          physical.scopes += 1;
          if (existsSync(resolve(shopDirectory, scopeEntry.name, SHOP_DATABASE_FILENAME))) {
            physical.databases += 1;
          }
        }
      }
    }
    return Object.freeze({
      layoutVersion: SHOP_DATABASE_LAYOUT_VERSION,
      storageModel: 'one-shop-one-directory',
      root: resolve(root),
      openCount: handles.size,
      physical: Object.freeze(physical),
      migration: Object.freeze({ ...migrationStatus }),
    });
  }

  migrateDiscoveredLegacyDatabases();

  return Object.freeze({
    ensure,
    openExisting,
    has,
    get,
    close,
    closeAll,
    migrateLegacyDatabases: migrateDiscoveredLegacyDatabases,
    resolve: layoutFor,
    snapshot,
  });
}
