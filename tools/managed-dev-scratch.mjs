import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT_NAME = '.managed-dev-scratch';
const ROOT_MARKER = 'ownership.json';
const CONTRACT = 'wangzai-managed-dev-scratch-v1';
const RUN_ID = /^run-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const PURPOSES = new Set(['native-build', 'test-scratch', 'tool-scratch']);
const KEEP_NAME = /^(?:\.keep|\.retain|DO_NOT_DELETE|AGENTS\.md|profile\.json|ROLLBACK(?:\..*)?|(?:evidence|acceptance|backup)-manifest\.json)$/iu;
const fail = code => { throw Object.assign(new Error(`MANAGED_SCRATCH_${code}`), { code: `MANAGED_SCRATCH_${code}` }); };
const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const stat = value => { try { return fs.lstatSync(value, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

function plainDirectory(value) {
  let current = path.resolve(value);
  while (true) {
    const metadata = stat(current);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink() || normalized(fs.realpathSync(current)) !== normalized(current)) fail('LINKED_OR_INVALID_DIRECTORY');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function plainFile(value, maxBytes = null) {
  const metadata = stat(value);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n || (maxBytes !== null && metadata.size > BigInt(maxBytes))) fail('LINKED_OR_INVALID_FILE');
  return metadata;
}
function readMarker(file) {
  plainFile(file, 4096);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('MANIFEST_INVALID'); }
}
function workspacePath(value) {
  if (typeof value !== 'string' || !value.trim()) fail('WORKSPACE_INVALID');
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) fail('WORKSPACE_INVALID');
  plainDirectory(resolved);
  return resolved;
}

function openRoot(workspaceRoot, { create = false, writable = false } = {}) {
  const workspace = workspacePath(workspaceRoot);
  const root = path.join(workspace, ROOT_NAME);
  const markerPath = path.join(root, ROOT_MARKER);
  const databasePath = path.join(root, 'registry.sqlite');
  const scope = digest(normalized(workspace));
  if (!stat(root)) {
    if (!create) return null;
    // No adopt/mark-existing operation exists. Creation must exclusively own
    // a previously absent directory before it writes any ownership metadata.
    fs.mkdirSync(root);
    const marker = { contract: CONTRACT, rootId: randomUUID(), scope };
    fs.writeFileSync(markerPath, JSON.stringify(marker), { flag: 'wx' });
    const initial = new DatabaseSync(databasePath);
    try {
      initial.exec(`PRAGMA synchronous=FULL;
        CREATE TABLE metadata (identity TEXT NOT NULL);
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY, owner_token TEXT NOT NULL, purpose TEXT NOT NULL,
          created_at INTEGER NOT NULL, state TEXT NOT NULL, ttl_ms INTEGER NOT NULL,
          expires_at INTEGER, owner_pid INTEGER NOT NULL, lease_until INTEGER NOT NULL,
          directory_device TEXT NOT NULL, directory_inode TEXT NOT NULL
        );
        CREATE INDEX runs_expiry ON runs(state, expires_at);`);
      initial.prepare('INSERT INTO metadata(identity) VALUES (?)').run(JSON.stringify(marker));
    } finally { initial.close(); }
  }
  plainDirectory(root);
  if (!stat(markerPath) || !stat(databasePath)) fail('ROOT_UNRECOGNIZED');
  const marker = readMarker(markerPath);
  if (Object.keys(marker).sort().join(',') !== 'contract,rootId,scope' || marker.contract !== CONTRACT || marker.scope !== scope || !/^[a-f0-9-]{36}$/u.test(marker.rootId || '')) fail('ROOT_UNRECOGNIZED');
  for (const name of ['registry.sqlite', 'registry.sqlite-wal', 'registry.sqlite-shm', 'registry.sqlite-journal']) {
    const file = path.join(root, name);
    if (stat(file)) plainFile(file);
  }
  // Validate existing identity read-only before ever opening it for writes.
  const probe = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (probe.prepare('SELECT identity FROM metadata').all().length !== 1
      || probe.prepare('SELECT identity FROM metadata').get().identity !== JSON.stringify(marker)) fail('ROOT_UNRECOGNIZED');
  } catch { fail('ROOT_UNRECOGNIZED'); } finally { probe.close(); }
  const db = new DatabaseSync(databasePath, { readOnly: !writable });
  db.exec('PRAGMA busy_timeout=250;');
  return { root, marker, db };
}

function transaction(db, work, writable = true) {
  db.exec(writable ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Holds ownership through work AND all registered child exits. A crash never
 * converts an incomplete lease into permission to remove its payload. */
export async function withManagedDevScratch(options, work, { now = Date.now } = {}) {
  if (!PURPOSES.has(options?.purpose)) fail('PURPOSE_INVALID');
  const ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 30 * 24 * 60 * 60 * 1000) fail('TTL_INVALID');
  if (typeof work !== 'function') fail('WORK_CALLBACK_REQUIRED');
  // Opportunistic expiry is bounded and limited to the same managed root.
  // A failed cleanup cannot turn a new build/test into a failure.
  try { collectExpiredManagedDevScratch({ workspaceRoot: options.workspaceRoot, apply: true, timeBudgetMs: 250 }, { now }); } catch { /* keep uncertain state */ }
  const context = openRoot(options.workspaceRoot, { create: true, writable: true });
  const { root, marker, db } = context;
  const runId = `run-${randomUUID()}`, ownerToken = randomUUID();
  const runRoot = path.join(root, runId), directory = path.join(runRoot, 'work');
  const ownership = { contract: CONTRACT, rootId: marker.rootId, runId, ownerToken, purpose: options.purpose };
  try {
    transaction(db, () => {
      fs.mkdirSync(runRoot);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(runRoot, ROOT_MARKER), JSON.stringify(ownership), { flag: 'wx' });
      const metadata = stat(runRoot);
      db.prepare(`INSERT INTO runs VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, ?, ?, ?)`).run(
        runId, ownerToken, options.purpose, now(), ttlMs, process.pid, now() + 120_000,
        String(metadata.dev), String(metadata.ino),
      );
    });
  } catch (error) { db.close(); throw error; }
  const children = new Set();
  let retained = false, unsafe = false, failed = false, result, workError;
  const heartbeat = setInterval(() => {
    try { db.prepare('UPDATE runs SET lease_until=? WHERE run_id=? AND owner_token=?').run(now() + 120_000, runId, ownerToken); }
    catch { unsafe = true; }
  }, 30_000);
  heartbeat.unref();
  const scope = Object.freeze({
    directory,
    runId,
    retain() { retained = true; },
    trackChild(child) {
      if (!child || typeof child.once !== 'function') fail('CHILD_PROCESS_REQUIRED');
      if (child.exitCode !== null && child.exitCode !== undefined || child.signalCode) {
        if (child.exitCode !== 0 || child.signalCode) retained = true;
        return Promise.resolve();
      }
      const completion = new Promise(resolve => {
        child.once('exit', (code, signal) => {
          if (code !== 0 || signal) retained = true;
          resolve({ code, signal });
        });
        // A failed spawn has no operating-system process whose exit can occur.
        child.once('error', () => { retained = true; if (!child.pid) resolve(); });
      });
      children.add(completion);
      void completion.then(() => children.delete(completion));
      return completion;
    },
  });
  try { result = await work(scope); }
  catch (error) { failed = true; workError = error; }
  finally {
    // No timeout is a release receipt. Parent death leaves state=active and
    // requires review, rather than deleting a possibly detached child's work.
    while (children.size) await Promise.all([...children]);
    clearInterval(heartbeat);
    try {
      transaction(db, () => {
        const keep = retained || failed || unsafe;
        const receipt = db.prepare(`UPDATE runs SET state=?, expires_at=?, lease_until=0
          WHERE run_id=? AND owner_token=? AND state='active'`).run(
          keep ? 'retained' : 'ready', keep ? null : now() + ttlMs, runId, ownerToken,
        );
        if (receipt.changes !== 1) fail('LEASE_FINALIZATION_UNVERIFIED');
      });
    } catch { unsafe = true; } finally { db.close(); }
  }
  if (failed) throw workError;
  if (unsafe) fail('LEASE_FINALIZATION_UNVERIFIED');
  if (!retained) {
    try { collectExpiredManagedDevScratch({ workspaceRoot: options.workspaceRoot, apply: true, timeBudgetMs: 250 }, { now }); } catch { /* completed output remains retained until a later check */ }
  }
  return result;
}

function metadataIdentity(metadata) {
  return [metadata.dev, metadata.ino, metadata.mode, metadata.nlink, metadata.size,
    metadata.mtimeNs, metadata.ctimeNs].map(String);
}

function inspectPayload(directory, { deadline, maxScanEntries }) {
  if (!stat(directory)) return { bytes: 0, fingerprint: 'missing' };
  plainDirectory(directory);
  const stack = [directory];
  const identities = [['.', ...metadataIdentity(stat(directory))]];
  let entries = 0, bytes = 0;
  while (stack.length) {
    const current = stack.pop();
    for (const name of fs.readdirSync(current).sort()) {
      if (++entries > maxScanEntries || performance.now() > deadline) fail('SCAN_BUDGET_EXCEEDED');
      if (KEEP_NAME.test(name)) fail('PROTECTED_PAYLOAD_MARKER');
      const file = path.join(current, name), metadata = stat(file);
      if (!metadata || metadata.isSymbolicLink()) fail('LINKED_OR_CHANGED_PAYLOAD');
      identities.push([path.relative(directory, file), ...metadataIdentity(metadata)]);
      if (metadata.isDirectory()) stack.push(file);
      else if (metadata.isFile() && metadata.nlink === 1n) bytes += Number(metadata.size);
      else fail('LINKED_OR_SPECIAL_PAYLOAD');
    }
  }
  return { bytes, fingerprint: digest(JSON.stringify(identities)) };
}

function inspectRegisteredRun(context, row, limits) {
  const { root, marker } = context;
  if (!RUN_ID.test(row.run_id)) fail('RUN_ID_INVALID');
  const runRoot = path.join(root, row.run_id);
  if (path.dirname(runRoot) !== root) fail('PATH_ESCAPE');
  plainDirectory(runRoot);
  if (JSON.stringify(readMarker(path.join(root, ROOT_MARKER))) !== JSON.stringify(marker)) fail('ROOT_IDENTITY_CHANGED');
  const metadata = stat(runRoot);
  if (String(metadata.dev) !== row.directory_device || String(metadata.ino) !== row.directory_inode) fail('RUN_IDENTITY_CHANGED');
  if (fs.readdirSync(runRoot).some(name => name !== ROOT_MARKER && name !== 'work')) fail('UNKNOWN_RUN_CONTENT');
  const ownershipPath = path.join(runRoot, ROOT_MARKER);
  const ownership = readMarker(ownershipPath);
  const expected = { contract: CONTRACT, rootId: marker.rootId, runId: row.run_id, ownerToken: row.owner_token, purpose: row.purpose };
  if (JSON.stringify(ownership) !== JSON.stringify(expected)) fail('MANIFEST_MISMATCH');
  const directory = path.join(runRoot, 'work');
  const payload = inspectPayload(directory, limits);
  const fingerprint = digest(JSON.stringify([metadataIdentity(metadata), metadataIdentity(stat(ownershipPath)), payload.fingerprint]));
  return { row, runRoot, directory, bytes: payload.bytes, fingerprint };
}

/** Preview by default. Never enumerates legacy workspace directories or adopts
 * unknown children. Only this registry's completed, expired, verified runs. */
export function collectExpiredManagedDevScratch({
  workspaceRoot, apply = false, maxRuns = 8, maxScanEntries = 5000, timeBudgetMs = 1000,
  maxCompletedBytes = 2 * 1024 * 1024 * 1024,
} = {}, { now = Date.now } = {}) {
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 100
    || !Number.isSafeInteger(maxScanEntries) || maxScanEntries < 1 || maxScanEntries > 100_000
    || !Number.isSafeInteger(timeBudgetMs) || timeBudgetMs < 1 || timeBudgetMs > 30_000
    || !Number.isSafeInteger(maxCompletedBytes) || maxCompletedBytes < 0) fail('SCAN_LIMIT_INVALID');
  const context = openRoot(workspaceRoot, { writable: apply });
  const report = { ok: true, mode: apply ? 'apply' : 'preview', rootExists: Boolean(context),
    eligibleRuns: 0, removedRuns: 0, removedLogicalBytes: 0, activeRuns: 0, retainedRuns: 0,
    maxCompletedBytes, completedDisposableBytesBefore: 0, completedDisposableBytesAfter: 0,
    completedMeasurementComplete: true, completedMeasurementStatus: 'complete',
    completedBudgetStatus: 'within-budget', measurementScope: 'registered-ready-disposable-runs-only',
    capacityTriggered: false, blocked: [] };
  if (!context) return report;
  const { db } = context;
  const deadline = performance.now() + timeBudgetMs;
  try {
    return transaction(db, () => {
      // An additive technical cursor is compatible with existing registry
      // identities/leases. Preview never creates or changes this table.
      if (apply) db.exec(`CREATE TABLE IF NOT EXISTS cleanup_scan_cursor (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), created_at INTEGER NOT NULL, run_id TEXT NOT NULL
      )`);
      const hasCursor = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cleanup_scan_cursor'").get());
      const cursor = hasCursor ? db.prepare('SELECT created_at, run_id FROM cleanup_scan_cursor WHERE singleton=1').get() : null;
      report.activeRuns = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE state='active'").get().n;
      report.retainedRuns = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE state='retained'").get().n;
      const readyCount = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE state='ready'").get().n;
      let rows = cursor ? db.prepare(`SELECT * FROM runs WHERE state='ready'
        AND (created_at>? OR (created_at=? AND run_id>?)) ORDER BY created_at, run_id LIMIT ?`)
        .all(cursor.created_at, cursor.created_at, cursor.run_id, maxRuns) : [];
      if (!rows.length) {
        report.scanWrapped = Boolean(cursor);
        rows = db.prepare("SELECT * FROM runs WHERE state='ready' ORDER BY created_at, run_id LIMIT ?").all(maxRuns);
      }
      const candidates = [];
      let lastAttempted = null, measurementInvalidated = false;
      const block = (row, error, phase) => {
        report.ok = false;
        report.blocked.push({ runId: row.run_id, phase, code: error.code || 'MANAGED_SCRATCH_CLEANUP_FAILED' });
        if (apply && String(error.code || '').startsWith('MANAGED_SCRATCH_')
          && error.code !== 'MANAGED_SCRATCH_SCAN_BUDGET_EXCEEDED') {
          db.prepare("UPDATE runs SET state='retained', expires_at=NULL WHERE run_id=? AND owner_token=? AND state='ready'").run(row.run_id, row.owner_token);
        }
      };
      for (const row of rows) {
        if (performance.now() > deadline) { report.budgetExhausted = true; break; }
        lastAttempted = row;
        try {
          candidates.push(inspectRegisteredRun(context, row, { deadline, maxScanEntries }));
        } catch (error) { block(row, error, 'inspection'); }
      }
      report.completedMeasurementComplete = candidates.length === readyCount;
      report.completedDisposableBytesBefore = candidates.reduce((sum, entry) => sum + entry.bytes, 0);
      report.completedDisposableBytesAfter = report.completedDisposableBytesBefore;
      report.capacityTriggered = report.completedDisposableBytesBefore > maxCompletedBytes;
      let projectedBytes = report.completedDisposableBytesBefore;
      let capacityAdmission = report.capacityTriggered;
      for (const { row, runRoot, directory, bytes, fingerprint } of candidates) {
        if (row.expires_at > now() && (!capacityAdmission || projectedBytes <= maxCompletedBytes)) continue;
        report.eligibleRuns++;
        if (!apply) { projectedBytes -= bytes; continue; }
        if (performance.now() > deadline) { report.budgetExhausted = true; break; }
        try {
          // A prior scan is not deletion authority. Recheck every identity,
          // marker and payload metadata immediately at final admission.
          const admitted = inspectRegisteredRun(context, row, { deadline, maxScanEntries });
          if (admitted.fingerprint !== fingerprint) fail('PAYLOAD_CHANGED_AFTER_SCAN');
          if (stat(directory)) {
            fs.rmSync(directory, { recursive: true, force: false });
          }
          if (stat(directory)) fail('DELETE_UNVERIFIED');
          // Preserve the ownership proof until payload deletion is verified,
          // so a locked file cannot strand an unmarked, partially deleted run.
          fs.unlinkSync(path.join(runRoot, ROOT_MARKER));
          fs.rmdirSync(runRoot);
          if (stat(runRoot)) fail('DELETE_UNVERIFIED');
          db.prepare('DELETE FROM runs WHERE run_id=? AND owner_token=?').run(row.run_id, row.owner_token);
          report.removedRuns++;
          report.removedLogicalBytes += bytes;
          projectedBytes -= bytes;
          report.completedDisposableBytesAfter -= bytes;
        } catch (error) {
          measurementInvalidated = true;
          capacityAdmission = false;
          block(row, error, 'deletion-admission');
        }
      }
      if (apply && lastAttempted) db.prepare(`INSERT INTO cleanup_scan_cursor VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET created_at=excluded.created_at, run_id=excluded.run_id`)
        .run(lastAttempted.created_at, lastAttempted.run_id);
      report.scanAdvanced = Boolean(apply && lastAttempted);
      report.scannedReadyRuns = candidates.length;
      report.readyRunsAtScanStart = readyCount;
      report.retainedRuns = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE state='retained'").get().n;
      if (measurementInvalidated) report.completedMeasurementComplete = false;
      report.completedMeasurementStatus = report.completedMeasurementComplete ? 'complete'
        : measurementInvalidated || !candidates.length ? 'unknown' : 'partial';
      report.completedBudgetStatus = !report.completedMeasurementComplete ? 'unknown'
        : report.completedDisposableBytesAfter <= maxCompletedBytes ? 'within-budget' : 'exceeded';
      report.projectedCompletedDisposableBytesAfter = projectedBytes;
      return report;
    }, apply);
  } finally { db.close(); }
}
