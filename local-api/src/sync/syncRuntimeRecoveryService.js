const INTERRUPTED_CODE = 'SYNC_PROCESS_RESTART_INTERRUPTED';

function nowIso() {
  return new Date().toISOString();
}

function hasTable(db, tableName) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName),
  );
}

function changes(result) {
  return Number(result?.changes || 0);
}

/**
 * Reconciles work that can only have been owned by the previous local-api
 * process. Network request payloads and JS promises are intentionally not
 * reconstructed: durable staging/cursors stay in SQLite, while active leases
 * become explainable terminal records so startup scheduling can enqueue a new
 * run without being trapped behind a permanent singleflight row.
 */
export function recoverPersistedSyncRuntime(db, { recoveredAt = nowIso() } = {}) {
  if (!db) throw new Error('recoverPersistedSyncRuntime requires db.');
  const summary = {
    recoveredAt,
    code: INTERRUPTED_CODE,
    legacyJobs: 0,
    legacyStates: 0,
    requestJobs: 0,
    requestAttempts: 0,
    requestLocks: 0,
    requestStates: 0,
    committedSnapshotsRecovered: 0,
    snapshots: 0,
    productRuns: 0,
    productOutbox: 0,
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    if (hasTable(db, 'sync_jobs')) {
      summary.legacyJobs = changes(db.prepare(`
        UPDATE sync_jobs
           SET status = 'failed', finished_at = ?, updated_at = ?,
               error_message = ?
         WHERE status IN ('queued', 'running')
      `).run(recoveredAt, recoveredAt, INTERRUPTED_CODE));
    }

    if (hasTable(db, 'sync_state')) {
      summary.legacyStates = changes(db.prepare(`
        UPDATE sync_state
           SET status = 'failed', last_attempt_at = ?, updated_at = ?
         WHERE status = 'syncing'
      `).run(recoveredAt, recoveredAt));
    }

    if (hasTable(db, 'ozon_request_attempts')) {
      summary.requestAttempts = changes(db.prepare(`
        UPDATE ozon_request_attempts
           SET status = 'failed', error_message = ?, finished_at = ?
         WHERE status IN ('queued', 'running')
      `).run(INTERRUPTED_CODE, recoveredAt));
    }

    if (hasTable(db, 'ozon_request_jobs')) {
      summary.requestJobs = changes(db.prepare(`
        UPDATE ozon_request_jobs
           SET status = 'failed', last_error = ?, next_retry_at = NULL,
               message = 'Previous local-api process stopped before this job completed.',
               finished_at = ?, updated_at = ?
         WHERE status IN ('queued', 'running', 'rate_limited', 'circuit_open')
      `).run(INTERRUPTED_CODE, recoveredAt, recoveredAt));
    }

    if (hasTable(db, 'ozon_sync_locks')) {
      summary.requestLocks = changes(db.prepare(`
        UPDATE ozon_sync_locks
           SET status = 'expired', expires_at = ?, heartbeat_at = ?, released_at = ?
         WHERE status = 'active'
      `).run(recoveredAt, recoveredAt, recoveredAt));
    }

    if (hasTable(db, 'ozon_sync_state')) {
      summary.requestStates = changes(db.prepare(`
        UPDATE ozon_sync_state
           SET status = 'failed', last_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE status IN ('queued', 'running', 'rate_limited', 'circuit_open')
      `).run(recoveredAt, INTERRUPTED_CODE, recoveredAt));
    }

    if (hasTable(db, 'ozon_sync_snapshots')) {
      if (hasTable(db, 'product_sync_runs')) {
        // The product activation transaction can commit just before the
        // generic snapshot status callback runs. That is a completed commit,
        // not an interrupted fetch. Reconstruct the small status projection
        // from the durable product run instead of downgrading good data.
        db.prepare(`
          UPDATE ozon_sync_snapshots AS previous
             SET active = 0
           WHERE active = 1
             AND EXISTS (
               SELECT 1
                 FROM ozon_sync_snapshots AS committed
                 JOIN product_sync_runs AS run
                   ON run.activated_snapshot_id = committed.id
                  AND run.status IN ('completed', 'completed_with_source_gaps')
                WHERE committed.status = 'running'
                  AND committed.domain = previous.domain
                  AND COALESCE(committed.shop_id, '') = COALESCE(previous.shop_id, '')
                  AND committed.id <> previous.id
             )
        `).run();
        summary.committedSnapshotsRecovered = changes(db.prepare(`
          UPDATE ozon_sync_snapshots
             SET status = 'success', active = 1,
                 activated_at = COALESCE(activated_at, ?),
                 finished_at = COALESCE(finished_at, ?)
           WHERE status = 'running'
             AND EXISTS (
               SELECT 1 FROM product_sync_runs
                WHERE activated_snapshot_id = ozon_sync_snapshots.id
                  AND status IN ('completed', 'completed_with_source_gaps')
             )
        `).run(recoveredAt, recoveredAt));
      }
      summary.snapshots = changes(db.prepare(`
        UPDATE ozon_sync_snapshots
           SET status = 'failed', active = 0, finished_at = ?
         WHERE status = 'running'
      `).run(recoveredAt));
    }

    if (hasTable(db, 'product_sync_runs')) {
      summary.productRuns = changes(db.prepare(`
        UPDATE product_sync_runs
           SET status = 'interrupted', error_code = ?,
               error_message = 'Previous local-api process stopped before product snapshot activation.',
               lease_owner = NULL, lease_expires_at = NULL,
               updated_at = ?, finished_at = ?
         WHERE status IN ('queued', 'fetching', 'proving', 'activating')
      `).run(INTERRUPTED_CODE, recoveredAt, recoveredAt));
    }

    if (hasTable(db, 'product_sync_outbox')) {
      summary.productOutbox = changes(db.prepare(`
        UPDATE product_sync_outbox
           SET status = 'failed', attempts = attempts + 1, available_at = ?,
               last_error = ?
         WHERE status = 'processing'
      `).run(recoveredAt, INTERRUPTED_CODE));
    }

    db.exec('COMMIT');
    return Object.freeze(summary);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export const SYNC_PROCESS_RESTART_INTERRUPTED = INTERRUPTED_CODE;
