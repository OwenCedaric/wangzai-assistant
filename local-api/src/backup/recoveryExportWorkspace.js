import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, opendirSync, realpathSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { hostname } from 'node:os';
import { deriveScopedEncryptionKey } from '../security/secretCrypto.js';

export const RECOVERY_EXPORT_WORKSPACE_POLICY = Object.freeze({
  minimumAgeMs: 24 * 60 * 60 * 1_000,
  maximumScanEntries: 128,
  maximumRemovals: 4,
});
const PREFIX = 'recovery-export-v1-';
const NAME_PATTERN = /^recovery-export-v1-([A-Za-z0-9_-]{39})$/u;
const STATE_CODES = Object.freeze({ a: 1, c: 2, f: 3, g: 4 });
const SNAPSHOT_FILES = Object.freeze(['restore.sqlite', 'restore.sqlite-wal', 'restore.sqlite-shm', 'restore.sqlite-journal']);
const activeWorkspaces = new Set();
// Only names/identity are retained, never an open directory handle or a marker
// in the strict restore-staging layout. Restart/eviction starts a fresh sweep.
const scanBookmarks = new Map();
const MAX_SCAN_BOOKMARKS = 32;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function pathKey(value) {
  const path = resolve(value);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}
function clockMs(now) {
  const value = Number(now());
  if (!Number.isSafeInteger(value) || value <= 0) fail('RECOVERY_EXPORT_WORKSPACE_TIME_INVALID');
  return value;
}
function signingKey(value) {
  const key = value ?? deriveScopedEncryptionKey('recovery-export-workspace/authentication/v1');
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('RECOVERY_EXPORT_WORKSPACE_KEY_INVALID');
  return key;
}
function canonicalRoot(root, create = false) {
  const resolved = resolve(String(root || ''));
  if (!root || resolved === parse(resolved).root) fail('RECOVERY_EXPORT_WORKSPACE_ROOT_INVALID');
  const ancestors = [];
  for (let current = resolved; ; current = dirname(current)) {
    ancestors.unshift(current);
    if (current === dirname(current)) break;
  }
  const verifyAncestors = allowMissing => {
    for (const ancestor of ancestors) {
      let status;
      try { status = lstatSync(ancestor); }
      catch (error) { if (allowMissing && error?.code === 'ENOENT') break; throw error; }
      if (!status.isDirectory() || status.isSymbolicLink()
        || pathKey(realpathSync(ancestor)) !== pathKey(ancestor)) fail('RECOVERY_EXPORT_WORKSPACE_ROOT_INVALID');
    }
  };
  // Validate every existing ancestor before mkdir can create anything. A
  // junction above the last component must never redirect an authority root.
  verifyAncestors(create);
  if (create) mkdirSync(resolved, { recursive: true });
  verifyAncestors(false);
  return realpathSync(resolved);
}
function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}
function assertRootIdentity(root, identity) {
  canonicalRoot(root);
  if (identity && !sameIdentity(lstatSync(root), identity)) fail('RECOVERY_EXPORT_WORKSPACE_ROOT_CHANGED');
}
function rememberScan(root, identity, name) {
  const id = pathKey(root);
  scanBookmarks.delete(id);
  if (!name) return;
  scanBookmarks.set(id, { dev: identity.dev, ino: identity.ino, name });
  while (scanBookmarks.size > MAX_SCAN_BOOKMARKS) scanBookmarks.delete(scanBookmarks.keys().next().value);
}
function signature(root, material, key) {
  // PID leases are local-machine facts. Copied/shared workspaces from another
  // host deliberately fail authentication rather than being mistaken for dead.
  return createHmac('sha256', key)
    .update(`wangzai-recovery-export-workspace:v1\0${hostname().toLowerCase()}\0${pathKey(root)}\0`)
    .update(material).digest().subarray(0, 16);
}
function workspaceName(root, state, { createdAt, producerPid, nonce }, key) {
  // A 13-byte producer lease plus a 128-bit HMAC fits a 58-character name,
  // shorter than the former UUID+mkdtemp name. This matters for Windows SQLite.
  // Round creation UP to a second so precision never expires a lease early.
  const seconds = Math.ceil(createdAt / 1_000);
  if (!STATE_CODES[state] || !Number.isInteger(seconds) || seconds <= 0 || seconds > 0xffffffff
    || !Number.isSafeInteger(producerPid) || producerPid <= 0 || producerPid > 0xffffffff
    || !Buffer.isBuffer(nonce) || nonce.length !== 4) fail('RECOVERY_EXPORT_WORKSPACE_LEASE_INVALID');
  const material = Buffer.alloc(13);
  material[0] = STATE_CODES[state];
  material.writeUInt32BE(seconds, 1);
  material.writeUInt32BE(producerPid, 5);
  nonce.copy(material, 9);
  return `${PREFIX}${Buffer.concat([material, signature(root, material, key)]).toString('base64url')}`;
}
function readLease(root, name, key) {
  const match = NAME_PATTERN.exec(name);
  if (!match) return null;
  const encoded = Buffer.from(match[1], 'base64url');
  if (encoded.length !== 29 || encoded.toString('base64url') !== match[1]) return null;
  const material = encoded.subarray(0, 13);
  const state = Object.keys(STATE_CODES).find(value => STATE_CODES[value] === material[0]);
  const createdAt = material.readUInt32BE(1) * 1_000;
  const producerPid = material.readUInt32BE(5);
  if (!state || !createdAt || !producerPid || !timingSafeEqual(encoded.subarray(13), signature(root, material, key))) return null;
  return { state, createdAt, producerPid, nonce: material.subarray(9, 13) };
}

/** false means proven absent; denied/unknown/reused-live PIDs always preserve the directory. */
function ownerIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'ESRCH' ? false : null; }
}
function inspectContents(root, directory, { rootIdentity, workspaceIdentity } = {}) {
  assertRootIdentity(root, rootIdentity);
  const dirStat = lstatSync(directory);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()
    || (workspaceIdentity && !sameIdentity(dirStat, workspaceIdentity))
    || pathKey(dirname(realpathSync(directory))) !== pathKey(root)
    || pathKey(realpathSync(directory)) !== pathKey(directory)) fail('RECOVERY_EXPORT_WORKSPACE_PATH_CHANGED');
  const files = [];
  const handle = opendirSync(directory);
  try {
    let entry;
    while ((entry = handle.readSync())) {
      if (files.length >= SNAPSHOT_FILES.length || !SNAPSHOT_FILES.includes(entry.name)
        || !entry.isFile() || entry.isSymbolicLink()) fail('RECOVERY_EXPORT_WORKSPACE_CONTENT_UNRECOGNIZED');
      const filePath = join(directory, entry.name);
      const status = lstatSync(filePath);
      if (!status.isFile() || status.isSymbolicLink() || Number(status.nlink) !== 1
        || pathKey(dirname(realpathSync(filePath))) !== pathKey(directory)) fail('RECOVERY_EXPORT_WORKSPACE_LINK_UNSAFE');
      files.push({ name: entry.name, status });
    }
  } finally { handle.closeSync(); }
  return { dirStat, files };
}
function removeExactWorkspace(root, directory, options = {}) {
  const inspected = inspectContents(root, directory, options);
  let removedBytes = 0;
  // If a temporary sidecar is locked, keep the snapshot main file rather than
  // leaving a main-less SQLite family that protection discovery cannot verify.
  const files = [...inspected.files].sort((left, right) =>
    Number(left.name === 'restore.sqlite') - Number(right.name === 'restore.sqlite'));
  for (const file of files) {
    // Recheck directory identity and each exact file before unlinking. Never
    // recurse through a new child or follow a reparse point/hard link.
    assertRootIdentity(root, options.rootIdentity);
    const directoryNow = lstatSync(directory);
    if (directoryNow.isSymbolicLink() || directoryNow.dev !== inspected.dirStat.dev || directoryNow.ino !== inspected.dirStat.ino
      || pathKey(realpathSync(directory)) !== pathKey(directory)) fail('RECOVERY_EXPORT_WORKSPACE_PATH_CHANGED');
    const target = join(directory, file.name);
    const current = lstatSync(target);
    if (!current.isFile() || current.isSymbolicLink() || Number(current.nlink) !== 1
      || current.dev !== file.status.dev || current.ino !== file.status.ino
      || current.size !== file.status.size || current.mtimeMs !== file.status.mtimeMs) fail('RECOVERY_EXPORT_WORKSPACE_FILE_CHANGED');
    unlinkSync(target);
    removedBytes += current.size;
  }
  assertRootIdentity(root, options.rootIdentity);
  const finalDirectory = lstatSync(directory);
  if (finalDirectory.isSymbolicLink() || !sameIdentity(finalDirectory, inspected.dirStat)) fail('RECOVERY_EXPORT_WORKSPACE_PATH_CHANGED');
  if (!options.keepDirectory) rmdirSync(directory);
  return removedBytes;
}

/** Only versioned, authenticated producer-owned snapshots are eligible, never legacy backups. */
export function reclaimExpiredRecoveryExportWorkspaces({
  root, authenticationKey, now = Date.now, isOwnerAlive = ownerIsAlive,
  minimumAgeMs = RECOVERY_EXPORT_WORKSPACE_POLICY.minimumAgeMs,
  maximumScanEntries = RECOVERY_EXPORT_WORKSPACE_POLICY.maximumScanEntries,
  maximumRemovals = RECOVERY_EXPORT_WORKSPACE_POLICY.maximumRemovals,
} = {}) {
  const key = signingKey(authenticationKey);
  const at = clockMs(now);
  const requestedAge = Number(minimumAgeMs);
  const ageLimit = Number.isFinite(requestedAge) && requestedAge >= 0
    ? requestedAge : RECOVERY_EXPORT_WORKSPACE_POLICY.minimumAgeMs;
  const scanLimit = Math.max(1, Math.min(512, Number(maximumScanEntries) || 1));
  const removeLimit = Math.max(1, Math.min(16, Number(maximumRemovals) || 1));
  const result = { ok: true, scanned: 0, discoveredEntries: 0, replayedEntries: 0, removedWorkspaces: 0, removedBytes: 0,
    preservedActive: 0, preservedUnknown: 0, preservedYoung: 0, deferred: 0, scanComplete: false };
  let canonical;
  try { canonical = canonicalRoot(root); }
  catch (error) {
    if (root) scanBookmarks.delete(pathKey(root));
    if (error?.code === 'ENOENT') return { ...result, scanComplete: true };
    return { ...result, ok: false, code: error?.code || 'RECOVERY_EXPORT_WORKSPACE_ROOT_INVALID' };
  }
  const rootIdentity = lstatSync(canonical);
  const prior = scanBookmarks.get(pathKey(canonical));
  let lastPreserved = sameIdentity(rootIdentity, prior) ? prior.name : null;
  let directory = opendirSync(canonical);
  try {
    if (lastPreserved) {
      let found = false;
      let entry;
      // Reopening avoids holding a Windows directory handle across exports.
      // Seeking is metadata-only and separately counted: the 128-entry budget
      // bounds NEW entry validation, not all directory-name discovery work.
      while ((entry = directory.readSync())) {
        result.discoveredEntries += 1;
        result.replayedEntries += 1;
        if (entry.name === lastPreserved) { found = true; break; }
      }
      if (!found) {
        directory.closeSync();
        directory = null;
        assertRootIdentity(canonical, rootIdentity);
        directory = opendirSync(canonical);
        lastPreserved = null;
      }
    }
    while (result.scanned < scanLimit && result.removedWorkspaces < removeLimit) {
      const entry = directory.readSync();
      if (!entry) { result.scanComplete = true; break; }
      result.scanned += 1;
      result.discoveredEntries += 1;
      const previousPreserved = lastPreserved;
      lastPreserved = entry.name;
      const lease = readLease(canonical, entry.name, key);
      if (!lease || !entry.isDirectory() || entry.isSymbolicLink()) { result.preservedUnknown += 1; continue; }
      const candidate = join(canonical, entry.name);
      let live = null;
      try { live = isOwnerAlive(lease.producerPid); } catch { /* uncertainty never authorizes deletion */ }
      if (activeWorkspaces.has(pathKey(candidate)) || live !== false) { result.preservedActive += 1; continue; }
      if (lease.createdAt > at || at - lease.createdAt < ageLimit) { result.preservedYoung += 1; continue; }
      let claimed = false;
      try {
        const { dirStat } = inspectContents(canonical, candidate, { rootIdentity });
        // Atomic claiming prevents two collectors from acting on the same old
        // name. A collector crash leaves another authenticated dead-PID lease.
        const claimedPath = join(canonical, workspaceName(canonical, 'g', {
          createdAt: at, producerPid: process.pid, nonce: randomBytes(4),
        }, key));
        assertRootIdentity(canonical, rootIdentity);
        renameSync(candidate, claimedPath);
        claimed = true;
        lastPreserved = previousPreserved;
        result.removedBytes += removeExactWorkspace(canonical, claimedPath, { rootIdentity, workspaceIdentity: dirStat });
        result.removedWorkspaces += 1;
      } catch (error) {
        if (claimed) lastPreserved = previousPreserved;
        result.deferred += 1;
        result.ok = false;
        result.code = error?.code || 'RECOVERY_EXPORT_WORKSPACE_CLEANUP_DEFERRED';
      }
    }
  } finally {
    directory?.closeSync();
    rememberScan(canonical, rootIdentity, result.scanComplete ? null : lastPreserved);
  }
  return result;
}

export function createRecoveryExportWorkspace({
  root, authenticationKey, now = Date.now, createId = randomUUID, ...reclaimOptions
} = {}) {
  const id = String(createId()).replace(/[^A-Za-z0-9_-]/gu, '');
  if (!id) fail('RECOVERY_SNAPSHOT_ID_INVALID');
  const key = signingKey(authenticationKey);
  const canonical = canonicalRoot(root, true);
  const rootIdentity = lstatSync(canonical);
  const createdAt = clockMs(now);
  const reclaimed = reclaimExpiredRecoveryExportWorkspaces({ ...reclaimOptions, root: canonical, authenticationKey: key, now });
  const lease = { createdAt, producerPid: process.pid,
    nonce: createHash('sha256').update(id).update(randomBytes(16)).digest().subarray(0, 4) };
  let directory = join(canonical, workspaceName(canonical, 'a', lease, key));
  assertRootIdentity(canonical, rootIdentity);
  mkdirSync(directory, { mode: 0o700 });
  const workspaceIdentity = lstatSync(directory);
  activeWorkspaces.add(pathKey(directory));
  let finishResult = null;
  return Object.freeze({
    get directory() { return directory; },
    get snapshotPath() { return join(directory, 'restore.sqlite'); },
    reclaimed,
    reset() {
      if (finishResult || !activeWorkspaces.has(pathKey(directory))) fail('RECOVERY_EXPORT_WORKSPACE_RELEASED');
      const removedBytes = removeExactWorkspace(canonical, directory, {
        rootIdentity, workspaceIdentity, keepDirectory: true,
      });
      return { ok: true, removedBytes };
    },
    finish(outcome) {
      if (!['completed', 'failed'].includes(outcome)) fail('RECOVERY_EXPORT_WORKSPACE_OUTCOME_INVALID');
      if (finishResult) return { ...finishResult, alreadyFinished: true };
      // Callers may invoke finish only after every workspace DB handle closed.
      // Renaming marks that fact without introducing unaudited metadata files
      // into the existing account-removal protection directory layout.
      const previous = directory;
      try {
        inspectContents(canonical, directory, { rootIdentity, workspaceIdentity });
        const terminal = join(canonical, workspaceName(canonical, outcome === 'completed' ? 'c' : 'f', lease, key));
        assertRootIdentity(canonical, rootIdentity);
        renameSync(directory, terminal);
        directory = terminal;
        activeWorkspaces.delete(pathKey(previous));
        const removedBytes = removeExactWorkspace(canonical, directory, { rootIdentity, workspaceIdentity });
        finishResult = { ok: true, removedBytes };
        return finishResult;
      } catch (error) {
        activeWorkspaces.delete(pathKey(previous));
        finishResult = { ok: false, deferred: true, code: error?.code || 'RECOVERY_EXPORT_WORKSPACE_CLEANUP_DEFERRED' };
        return finishResult;
      }
    },
  });
}
