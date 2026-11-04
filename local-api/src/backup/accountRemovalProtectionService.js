import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../db/database.js';
import { createAccountRemovalOwnerRef } from '../db/repositories/accountRemovalOperationRepository.js';
import { createAccountRemovalSqliteExecutor } from '../domain/accountRemoval/accountRemovalSqliteExecutor.js';
import {
  observeCrossBorderPreferenceResource,
  observeOzonShopPreferenceResource,
} from '../domain/accountRemoval/accountRemovalEvidence.js';
import {
  getAccountRemovalSqliteResources,
  quoteAccountRemovalIdentifier,
} from '../domain/accountRemoval/accountRemovalSqliteCatalog.js';

// The desktop launcher and diagnostics tooling can add new process log files
// (for example `codex-*.out.log`) without changing the account-removal
// contract. Treat every safe, top-level `.log` file in the application-owned
// log directory as diagnostic data instead of freezing deletion to four
// historical file names. Non-log entries and links still fail closed below.
const PROCESS_LOG_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.log$/u;
const OWNER_TOKEN_CHARACTERS = 'A-Za-z0-9._:-';

function normalizeOwner(owner = {}) {
  const ownerType = String(owner?.ownerType || '').trim();
  const ownerId = String(owner?.ownerId || '').trim();
  if (!ownerType || !ownerId) throw new Error('ACCOUNT_REMOVAL_PROTECTION_OWNER_INVALID');
  getAccountRemovalSqliteResources(ownerType);
  return { ownerType, ownerId };
}

function isDescendant(root, candidate) {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot !== '' && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`);
}

function escapeRegularExpression(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function ownerTokenPattern(value) {
  const token = escapeRegularExpression(value);
  return new RegExp(`(^|[^${OWNER_TOKEN_CHARACTERS}])${token}(?=$|[^${OWNER_TOKEN_CHARACTERS}])`, 'gu');
}

function replaceOwnerToken(text, token, replacement) {
  if (!token) return { text, replacements: 0 };
  let replacements = 0;
  return {
    text: text.replace(ownerTokenPattern(token), (match, prefix) => {
      replacements += 1;
      return `${prefix}${replacement}`;
    }),
    replacements,
  };
}

function fullWidthHex(value) {
  return String(value).replace(/[0-9a-f]/gu, (character) => (
    String.fromCodePoint(character.codePointAt(0) + 0xfee0)
  ));
}

function overwriteTextFile(filePath, originalByteLength, text) {
  const descriptor = openSync(filePath, 'r+');
  try {
    const zeroBlock = Buffer.alloc(Math.min(64 * 1024, Math.max(1, originalByteLength)));
    let offset = 0;
    while (offset < originalByteLength) {
      const length = Math.min(zeroBlock.length, originalByteLength - offset);
      writeSync(descriptor, zeroBlock, 0, length, offset);
      offset += length;
    }
    fsyncSync(descriptor);
    ftruncateSync(descriptor, 0);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  writeFileSync(filePath, text, { encoding: 'utf8', flag: 'w' });
  const verificationDescriptor = openSync(filePath, 'r+');
  try {
    fsyncSync(verificationDescriptor);
  } finally {
    closeSync(verificationDescriptor);
  }
}

export function scrubAccountRemovalDiagnosticLogs({ logDirectory, owner: ownerInput } = {}) {
  const owner = normalizeOwner(ownerInput);
  const sourceDirectory = String(logDirectory || '').trim();
  if (!sourceDirectory || !existsSync(sourceDirectory)) {
    return { verified: true, fileCount: 0, replacementCount: 0 };
  }
  const directory = resolve(sourceDirectory);
  if (directory === parse(directory).root) throw new Error('ACCOUNT_REMOVAL_LOG_PATH_INVALID');
  const directoryStatus = lstatSync(directory);
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
    throw new Error('ACCOUNT_REMOVAL_LOG_PATH_INVALID');
  }
  const realDirectory = realpathSync(directory);
  const entries = readdirSync(realDirectory, { withFileTypes: true });
  if (entries.some((entry) => (
    !entry.isFile()
    || entry.isSymbolicLink()
    || !PROCESS_LOG_FILE_NAME_PATTERN.test(entry.name)
  ))) {
    throw new Error('ACCOUNT_REMOVAL_LOG_LAYOUT_UNRECOGNIZED');
  }
  const ownerRef = createAccountRemovalOwnerRef(owner).slice(0, 24);
  // A valid owner ID may itself be `ACCOUNT_REMOVED`, a single hex digit, or
  // any other ASCII token.  Keep the marker outside the complete owner-ID
  // alphabet so the mandatory readback can never mistake the marker for the
  // deleted identifier.
  const replacement = `【账号已销毁：${fullWidthHex(ownerRef)}】`;
  const tokens = [...new Set([owner.ownerId, encodeURIComponent(owner.ownerId)])];
  let replacementCount = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = join(realDirectory, entry.name);
    const status = lstatSync(filePath);
    if (!status.isFile() || status.isSymbolicLink() || realpathSync(filePath) !== filePath) {
      throw new Error('ACCOUNT_REMOVAL_LOG_PATH_INVALID');
    }
    const originalBytes = readFileSync(filePath);
    const originalText = originalBytes.toString('utf8');
    if (!Buffer.from(originalText, 'utf8').equals(originalBytes)) {
      throw new Error('ACCOUNT_REMOVAL_LOG_ENCODING_INVALID');
    }
    let nextText = originalText;
    let fileReplacements = 0;
    for (const token of tokens) {
      const result = replaceOwnerToken(nextText, token, replacement);
      nextText = result.text;
      fileReplacements += result.replacements;
    }
    if (fileReplacements > 0) overwriteTextFile(filePath, originalBytes.length, nextText);
    const readback = readFileSync(filePath, 'utf8');
    if (tokens.some((token) => ownerTokenPattern(token).test(readback))) {
      throw new Error('ACCOUNT_REMOVAL_LOG_READBACK_FAILED');
    }
    replacementCount += fileReplacements;
  }
  return { verified: true, fileCount: entries.length, replacementCount };
}

function assertDirectoryPath(root, candidate) {
  if (!isDescendant(root, candidate)) throw new Error('ACCOUNT_REMOVAL_PROTECTION_PATH_INVALID');
  const status = lstatSync(candidate);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error('ACCOUNT_REMOVAL_PROTECTION_PATH_INVALID');
  }
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(candidate);
  if (!isDescendant(realRoot, realCandidate)) throw new Error('ACCOUNT_REMOVAL_PROTECTION_PATH_INVALID');
  return realCandidate;
}

function discoverRootFamilies({ baseDirectory, rootName, databaseName, kind }) {
  const root = join(baseDirectory, rootName);
  if (!existsSync(root)) return [];
  const rootStatus = lstatSync(root);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error('ACCOUNT_REMOVAL_PROTECTION_PATH_INVALID');
  }
  const families = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('ACCOUNT_REMOVAL_PROTECTION_LAYOUT_UNRECOGNIZED');
    }
    const directory = assertDirectoryPath(root, join(root, entry.name));
    const allowedNames = new Set([databaseName, `${databaseName}-wal`, `${databaseName}-shm`]);
    const children = readdirSync(directory, { withFileTypes: true });
    if (children.some((child) => !child.isFile() || child.isSymbolicLink() || !allowedNames.has(child.name))) {
      throw new Error('ACCOUNT_REMOVAL_PROTECTION_LAYOUT_UNRECOGNIZED');
    }
    const databasePath = join(directory, databaseName);
    const sidecarsExist = existsSync(`${databasePath}-wal`) || existsSync(`${databasePath}-shm`);
    if (!existsSync(databasePath)) {
      if (sidecarsExist) throw new Error('ACCOUNT_REMOVAL_PROTECTION_LAYOUT_UNRECOGNIZED');
      continue;
    }
    const databaseStatus = lstatSync(databasePath);
    if (!databaseStatus.isFile() || databaseStatus.isSymbolicLink()) {
      throw new Error('ACCOUNT_REMOVAL_PROTECTION_PATH_INVALID');
    }
    const realDatabasePath = realpathSync(databasePath);
    if (!isDescendant(realpathSync(root), realDatabasePath)) {
      throw new Error('ACCOUNT_REMOVAL_PROTECTION_PATH_INVALID');
    }
    families.push({ kind, databasePath: realDatabasePath });
  }
  return families;
}

export function discoverAccountRemovalProtectionFamilies(activeDatabasePath) {
  const sourcePath = String(activeDatabasePath || '').trim();
  if (!sourcePath) throw new Error('ACCOUNT_REMOVAL_PROTECTION_DATABASE_PATH_REQUIRED');
  const activePath = resolve(sourcePath);
  if (activePath === parse(activePath).root || !basename(activePath)) {
    throw new Error('ACCOUNT_REMOVAL_PROTECTION_DATABASE_PATH_REQUIRED');
  }
  const baseDirectory = dirname(activePath);
  const activeDatabaseName = basename(activePath);
  return [
    ...discoverRootFamilies({
      baseDirectory,
      rootName: 'restore-staging',
      databaseName: 'restore.sqlite',
      kind: 'staging',
    }),
    ...discoverRootFamilies({
      baseDirectory,
      rootName: 'restore-rollback',
      databaseName: activeDatabaseName,
      kind: 'rollback',
    }),
    ...discoverRootFamilies({
      baseDirectory,
      rootName: 'restore-failed',
      databaseName: activeDatabaseName,
      kind: 'failed',
    }),
  ].sort((left, right) => left.databasePath.localeCompare(right.databasePath));
}

function assertDatabaseIntegrity(db) {
  const integrityRows = db.prepare('PRAGMA integrity_check;').all().map((row) => Object.values(row)[0]);
  if (integrityRows.length !== 1 || integrityRows[0] !== 'ok') {
    throw new Error('ACCOUNT_REMOVAL_PROTECTION_INTEGRITY_FAILED');
  }
  if (db.prepare('PRAGMA foreign_key_check;').all().length > 0) {
    throw new Error('ACCOUNT_REMOVAL_PROTECTION_FOREIGN_KEY_FAILED');
  }
}

function verifyOwnerAbsent(db, owner) {
  for (const descriptor of getAccountRemovalSqliteResources(owner.ownerType)) {
    const table = quoteAccountRemovalIdentifier(descriptor.table);
    const ownerField = quoteAccountRemovalIdentifier(descriptor.ownerField);
    const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${ownerField} = ?`).get(owner.ownerId)?.count || 0);
    if (count !== 0) throw new Error('ACCOUNT_REMOVAL_PROTECTION_READBACK_FAILED');
  }
  if (owner.ownerType === 'ozon_shop' && observeOzonShopPreferenceResource(db, owner.ownerId).state !== 'absent') {
    throw new Error('ACCOUNT_REMOVAL_PROTECTION_READBACK_FAILED');
  }
  if (owner.ownerType === 'cross_border_bus' && observeCrossBorderPreferenceResource(db, owner.ownerId).state !== 'absent') {
    throw new Error('ACCOUNT_REMOVAL_PROTECTION_READBACK_FAILED');
  }
}

function isOwnerAlreadyAbsent(db, owner) {
  for (const descriptor of getAccountRemovalSqliteResources(owner.ownerType)) {
    const table = quoteAccountRemovalIdentifier(descriptor.table);
    const ownerField = quoteAccountRemovalIdentifier(descriptor.ownerField);
    const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${ownerField} = ?`).get(owner.ownerId)?.count || 0);
    if (count !== 0) return false;
  }
  if (owner.ownerType === 'ozon_shop' && observeOzonShopPreferenceResource(db, owner.ownerId).state !== 'absent') {
    return false;
  }
  if (owner.ownerType === 'cross_border_bus' && observeCrossBorderPreferenceResource(db, owner.ownerId).state !== 'absent') {
    return false;
  }
  return true;
}

function scrubProtectionDatabase({ databasePath, owner, now }) {
  const db = new DatabaseSync(databasePath);
  let execution;
  let sanitizedOperationCount = 0;
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA secure_delete = ON;');
    runMigrations(db);
    const ownerRef = createAccountRemovalOwnerRef(owner);
    const sanitized = db.prepare(`
      UPDATE account_removal_operations
      SET payload_encrypted = NULL, client_cleanup_nonce = NULL, updated_at = ?
      WHERE owner_ref = ? AND (payload_encrypted IS NOT NULL OR client_cleanup_nonce IS NOT NULL)
    `).run(now(), ownerRef);
    sanitizedOperationCount = Number(sanitized.changes || 0);
    const executor = createAccountRemovalSqliteExecutor({ db, now });
    execution = isOwnerAlreadyAbsent(db, owner)
      ? executor.completePhysicalErasure({
        deletedRows: {},
        totalDeletedRows: 0,
        preservationVerified: true,
      })
      : executor.execute(owner);
    verifyOwnerAbsent(db, owner);
    assertDatabaseIntegrity(db);
  } finally {
    db.close();
  }
  for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
    if (!existsSync(sidecar)) continue;
    truncateSync(sidecar, 0);
    if (statSync(sidecar).size !== 0) throw new Error('ACCOUNT_REMOVAL_PROTECTION_PHYSICAL_ERASURE_FAILED');
  }
  return { execution, sanitizedOperationCount };
}

export function createAccountRemovalProtectionService({
  activeDatabasePath,
  logDirectory,
  now = () => new Date().toISOString(),
  discoverFamilies = discoverAccountRemovalProtectionFamilies,
} = {}) {
  const sourcePath = String(activeDatabasePath || '').trim();
  if (!sourcePath) throw new Error('ACCOUNT_REMOVAL_PROTECTION_DATABASE_PATH_REQUIRED');
  const activePath = resolve(sourcePath);
  if (activePath === parse(activePath).root || !basename(activePath)) {
    throw new Error('ACCOUNT_REMOVAL_PROTECTION_DATABASE_PATH_REQUIRED');
  }
  const resolvedLogDirectory = String(logDirectory || '').trim()
    || (basename(dirname(activePath)) === 'local-api-data'
      ? join(dirname(dirname(activePath)), 'logs')
      : '');

  function purgeOwner({ owner: ownerInput } = {}) {
    const owner = normalizeOwner(ownerInput);
    const families = discoverFamilies(activePath);
    const byKind = { staging: 0, rollback: 0, failed: 0 };
    let totalDeletedRows = 0;
    let sanitizedOperationCount = 0;
    for (const family of families) {
      if (!Object.prototype.hasOwnProperty.call(byKind, family.kind)) {
        throw new Error('ACCOUNT_REMOVAL_PROTECTION_LAYOUT_UNRECOGNIZED');
      }
      const result = scrubProtectionDatabase({ databasePath: family.databasePath, owner, now });
      byKind[family.kind] += 1;
      totalDeletedRows += Number(result.execution.totalDeletedRows || 0);
      sanitizedOperationCount += result.sanitizedOperationCount;
    }
    const diagnosticLogs = scrubAccountRemovalDiagnosticLogs({
      logDirectory: resolvedLogDirectory,
      owner,
    });
    return {
      ok: true,
      verified: true,
      familyCount: families.length,
      familyKinds: byKind,
      totalDeletedRows,
      sanitizedOperationCount,
      diagnosticLogs,
    };
  }

  return { purgeOwner };
}
