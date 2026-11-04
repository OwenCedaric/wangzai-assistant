import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isAsyncFunction } from 'node:util/types';

const RESTORABLE_MODES = new Set(['wal', 'delete', 'truncate', 'persist']);
const CONTRACT = 'recovery-rollback-journal-window/v1';
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function diagnostic(error) {
  return {
    code: /^[A-Z][A-Z0-9_]+$/u.test(String(error?.code || ''))
      ? error.code : 'RECOVERY_JOURNAL_CALLBACK_FAILED',
    ...(Number.isInteger(error?.errcode) ? { sqliteCode: error.errcode } : {}),
  };
}

function synchronousResult(value) {
  if (value && typeof value.then === 'function') {
    Promise.resolve(value).catch(() => undefined);
    fail('RECOVERY_JOURNAL_ASYNC_CALLBACK_REJECTED');
  }
  return value;
}

function journalMode(db, alias = 'main') {
  return String(db.prepare(`PRAGMA ${quote(alias)}.journal_mode`).get()?.journal_mode || '').toLowerCase();
}

function assertOutsideTransaction(db) {
  if (typeof db?.isTransaction !== 'boolean') fail('RECOVERY_JOURNAL_TRANSACTION_STATE_UNAVAILABLE');
  if (db.isTransaction) fail('RECOVERY_JOURNAL_EXISTING_TRANSACTION');
}

function readParticipant(db, index) {
  if (typeof db?.prepare !== 'function' || typeof db?.exec !== 'function') fail('RECOVERY_JOURNAL_DATABASE_REQUIRED');
  assertOutsideTransaction(db);
  const databaseList = db.prepare('PRAGMA database_list').all();
  if (databaseList.some((row) => !['main', 'temp'].includes(row.name))) fail('RECOVERY_JOURNAL_PREEXISTING_ATTACHMENT');
  const file = String(databaseList.find((row) => row.name === 'main')?.file || '');
  if (!file || !isAbsolute(file)) fail('RECOVERY_JOURNAL_FILE_DATABASE_REQUIRED');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('RECOVERY_JOURNAL_LINKED_DATABASE_REJECTED');
  const canonicalPath = realpathSync(file);
  const originalMode = journalMode(db);
  if (!RESTORABLE_MODES.has(originalMode)) fail('RECOVERY_JOURNAL_UNSAFE_ORIGINAL_MODE');
  return {
    db,
    index,
    path: canonicalPath,
    identity: process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath,
    originalMode,
    originalBusyTimeout: Number(db.prepare('PRAGMA busy_timeout').get()?.timeout),
    alias: index === 0 ? 'main' : `recovery_journal_${index}`,
    modeAttempted: false,
    timeoutChanged: false,
    attached: false,
  };
}

/**
 * Experimental synchronous primitive, deliberately not wired into importers.
 *
 * All participants must be the application's existing writable, file-backed
 * main-database handles. The first/coordinator handle is `db`; no replacement
 * connection is opened, so repositories already bound to canonicalDb join the
 * same transaction. The callback receives an alias map for shop SQL.
 *
 * The caller must establish its application-wide admission/quiescence window
 * BEFORE calling this function and synchronously close owned federation read
 * CONNECTIONS in closeOwnedReaders (ending SELECT alone does not release WAL
 * mode-transition locks). This primitive cannot prove global quiescence or
 * prevent another process from opening a reader during mode restoration.
 *
 * `work` must use only the supplied coordinator/aliases and must not BEGIN,
 * COMMIT, ROLLBACK, attach databases, retain iterators, or return a Promise.
 * SQLite transaction ownership and participating modes are checked again
 * before commit. Callback code is trusted application code, not renderer input.
 *
 * A committed transaction whose mode restoration fails returns ok:false AND
 * committed:true. It MUST NOT be replayed; its journal-mode cleanup needs an
 * explicit recovery step. Restoring prior modes preserves intentional rollback
 * journal configuration; normally every prior mode is WAL.
 */
export function withRollbackJournalTransaction({
  db,
  databases = [],
  closeOwnedReaders,
  busyTimeoutMs = 0,
} = {}, work) {
  const participants = [];
  const cleanupErrors = [];
  let phase = 'admission';
  let primaryError = null;
  let businessOutcome = 'not-started';
  let callbackInvoked = false;
  let readerCloseCompleted = false;
  let transactionStarted = false;
  let originalSynchronous = null;
  let synchronousChanged = false;
  let value;

  try {
    if (!Array.isArray(databases)) fail('RECOVERY_JOURNAL_DATABASE_LIST_REQUIRED');
    if (typeof closeOwnedReaders !== 'function' || typeof work !== 'function') fail('RECOVERY_JOURNAL_CALLBACK_REQUIRED');
    if (isAsyncFunction(closeOwnedReaders) || isAsyncFunction(work)) fail('RECOVERY_JOURNAL_ASYNC_CALLBACK_REJECTED');
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 1000) fail('RECOVERY_JOURNAL_BUSY_TIMEOUT_INVALID');
    const selected = [...new Set([db, ...databases.map((entry) => entry?.db || entry)])];
    if (selected.length > 10) fail('RECOVERY_JOURNAL_DATABASE_LIMIT');
    const identities = new Set();
    for (const [index, source] of selected.entries()) {
      const participant = readParticipant(source, index);
      if (identities.has(participant.identity)) fail('RECOVERY_JOURNAL_DUPLICATE_CONNECTION');
      identities.add(participant.identity);
      participants.push(participant);
    }
    originalSynchronous = Number(db.prepare('PRAGMA main.synchronous').get()?.synchronous);
    if (!Number.isInteger(originalSynchronous) || originalSynchronous < 0 || originalSynchronous > 3) fail('RECOVERY_JOURNAL_SYNCHRONOUS_UNAVAILABLE');

    phase = 'close-owned-readers';
    synchronousResult(closeOwnedReaders());
    readerCloseCompleted = true;
    // A miswired reader closer must not start a transaction on a participant.
    for (const participant of participants) assertOutsideTransaction(participant.db);

    phase = 'checkpoint-and-convert';
    for (const participant of participants) {
      participant.db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      participant.timeoutChanged = true;
      if (participant.originalMode === 'wal') {
        const checkpoint = participant.db.prepare('PRAGMA main.wal_checkpoint(TRUNCATE)').get();
        if (Number(checkpoint?.busy) !== 0 || Number(checkpoint?.log) !== Number(checkpoint?.checkpointed)) {
          fail('RECOVERY_JOURNAL_CHECKPOINT_BUSY');
        }
      }
      participant.modeAttempted = true;
      const changed = String(participant.db.prepare('PRAGMA main.journal_mode = DELETE').get()?.journal_mode || '').toLowerCase();
      if (changed !== 'delete') fail('RECOVERY_JOURNAL_DELETE_MODE_UNAVAILABLE');
    }

    phase = 'attach-and-lock';
    for (const participant of participants.slice(1)) {
      db.prepare(`ATTACH DATABASE ? AS ${quote(participant.alias)}`).run(participant.path);
      participant.attached = true;
      db.exec(`PRAGMA ${quote(participant.alias)}.synchronous = FULL`);
    }
    db.exec('PRAGMA main.synchronous = FULL');
    synchronousChanged = true;
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    businessOutcome = 'in-progress';

    function assertLockedModes() {
      if (!db.isTransaction) fail('RECOVERY_JOURNAL_TRANSACTION_OWNERSHIP_LOST');
      const attached = db.prepare('PRAGMA database_list').all().filter((row) => row.name !== 'temp');
      if (attached.length !== participants.length) fail('RECOVERY_JOURNAL_PARTICIPANT_SET_CHANGED');
      for (const participant of participants) {
        if (!attached.some((row) => row.name === participant.alias && realpathSync(row.file) === participant.path)) fail('RECOVERY_JOURNAL_PARTICIPANT_SET_CHANGED');
        if (journalMode(db, participant.alias) !== 'delete') fail('RECOVERY_JOURNAL_LOCKED_MODE_UNSAFE');
        if (Number(db.prepare(`PRAGMA ${quote(participant.alias)}.synchronous`).get()?.synchronous) < 2) fail('RECOVERY_JOURNAL_SYNCHRONOUS_UNSAFE');
      }
    }
    // BEGIN IMMEDIATE reserves every attached writer before these checks;
    // another connection cannot change journal modes between check and write.
    assertLockedModes();
    phase = 'business-transaction';
    callbackInvoked = true;
    value = synchronousResult(work(Object.freeze({
      db,
      aliases: new Map(participants.map((participant) => [participant.db, participant.alias])),
      atomicity: 'single-connection-attached-rollback-journal',
    })));
    assertLockedModes();
    phase = 'commit';
    db.exec('COMMIT');
    businessOutcome = 'committed';
  } catch (error) {
    primaryError = diagnostic(error);
    if (transactionStarted) {
      if (db?.isTransaction) {
        try {
          db.exec('ROLLBACK');
          businessOutcome = 'rolled-back';
        } catch (rollbackError) {
          businessOutcome = 'unknown';
          cleanupErrors.push({ stage: 'rollback', ...diagnostic(rollbackError) });
        }
      } else {
        // A callback-controlled COMMIT or a failed commit with an ambiguous
        // native outcome cannot be advertised as rolled back / safe to retry.
        businessOutcome = 'unknown';
      }
    }
  } finally {
    if (synchronousChanged) {
      try { db.exec(`PRAGMA main.synchronous = ${originalSynchronous}`); }
      catch (error) { cleanupErrors.push({ stage: 'restore-synchronous', ...diagnostic(error) }); }
    }
    for (const participant of [...participants].reverse()) {
      if (!participant.attached) continue;
      try { db.exec(`DETACH DATABASE ${quote(participant.alias)}`); participant.attached = false; }
      catch (error) { cleanupErrors.push({ stage: 'detach', index: participant.index, ...diagnostic(error) }); }
    }
    for (const participant of [...participants].reverse()) {
      if (participant.modeAttempted) {
        try {
          if (journalMode(participant.db) !== participant.originalMode) {
            participant.db.prepare(`PRAGMA main.journal_mode = ${participant.originalMode.toUpperCase()}`).get();
          }
          if (journalMode(participant.db) !== participant.originalMode) fail('RECOVERY_JOURNAL_MODE_RESTORE_MISMATCH');
        } catch (error) {
          cleanupErrors.push({ stage: 'restore-journal-mode', index: participant.index, ...diagnostic(error) });
        }
      }
      if (participant.timeoutChanged) {
        try { participant.db.exec(`PRAGMA busy_timeout = ${participant.originalBusyTimeout}`); }
        catch (error) { cleanupErrors.push({ stage: 'restore-busy-timeout', index: participant.index, ...diagnostic(error) }); }
      }
    }
  }

  const journalModes = participants.map((participant) => {
    let currentMode = null;
    try { currentMode = journalMode(participant.db); } catch { /* diagnostics below fail closed */ }
    return { index: participant.index, previousMode: participant.originalMode, currentMode, restored: currentMode === participant.originalMode };
  });
  const restorationOk = cleanupErrors.length === 0 && journalModes.every((entry) => entry.restored);
  const committed = businessOutcome === 'committed';
  const ok = committed && restorationOk;
  return Object.freeze({
    contract: CONTRACT,
    ok,
    code: !restorationOk ? 'RECOVERY_JOURNAL_CLEANUP_REQUIRED' : primaryError?.code || (ok ? null : 'RECOVERY_JOURNAL_OPERATION_FAILED'),
    phase: ok ? 'complete' : phase,
    committed,
    businessOutcome,
    callbackInvoked,
    readerCloseCompleted,
    globalQuiescenceProven: false,
    databaseCount: participants.length,
    primaryError,
    restoration: { ok: restorationOk, journalModes, errors: cleanupErrors },
    businessReplaySafe: restorationOk && ['not-started', 'rolled-back'].includes(businessOutcome),
    ...(committed ? { value } : {}),
  });
}
