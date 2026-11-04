const DEFAULT_OVERLAP_MINUTES = 30;
const FINAL_JOB_STATUSES = new Set(['success', 'partial', 'cache_hit', 'failed', 'canceled', 'blocked', 'rate_limited', 'circuit_open']);
const SUCCESS_JOB_STATUSES = new Set(['success', 'partial', 'cache_hit']);

function nowIso(now) {
  return now().toISOString();
}

function requiredText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw new Error(code);
  return text;
}

function normalizeOverlapMinutes(value) {
  const minutes = Number(value ?? DEFAULT_OVERLAP_MINUTES);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error('RECOVERY_RECONCILE_OVERLAP_INVALID');
  }
  return minutes;
}

function normalizeJobIds(value) {
  const source = Array.isArray(value) ? value : [];
  return [...new Set(source.map((item) => String(item || '').trim()).filter(Boolean))];
}

function parseJobIds(value) {
  try {
    return normalizeJobIds(JSON.parse(String(value || '[]')));
  } catch {
    return [];
  }
}

function publicRow(row) {
  if (!row) return null;
  return {
    restoreId: row.restore_id,
    generationId: row.generation_id,
    shopId: row.shop_id,
    status: row.status,
    overlapMinutes: row.overlap_minutes,
    queuedPolicyCount: row.queued_policy_count,
    completedPolicyCount: row.completed_policy_count || 0,
    failedPolicyCount: row.failed_policy_count || 0,
    jobIds: parseJobIds(row.job_ids_json),
    queuedAt: row.queued_at || null,
    completedAt: row.completed_at || null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Persists the one-shot post-restore read-only Ozon reconcile request inside the staged database. */
export function createRecoveryReconcileState({ db, now = () => new Date() } = {}) {
  if (!db) throw new Error('createRecoveryReconcileState requires db.');

  function get(restoreId, shopId) {
    const restore = requiredText(restoreId, 'RECOVERY_RECONCILE_RESTORE_ID_REQUIRED');
    const shop = requiredText(shopId, 'RECOVERY_RECONCILE_SHOP_ID_REQUIRED');
    return publicRow(db.prepare(`
      SELECT restore_id, generation_id, shop_id, status, overlap_minutes,
             queued_policy_count, completed_policy_count, failed_policy_count, job_ids_json,
             queued_at, completed_at, last_error, created_at, updated_at
      FROM recovery_reconcile_state
      WHERE restore_id = ? AND shop_id = ?
    `).get(restore, shop));
  }

  function prepare({ restoreId, generationId, shopId, overlapMinutes = DEFAULT_OVERLAP_MINUTES } = {}) {
    const restore = requiredText(restoreId, 'RECOVERY_RECONCILE_RESTORE_ID_REQUIRED');
    const generation = requiredText(generationId, 'RECOVERY_RECONCILE_GENERATION_ID_REQUIRED');
    const shop = requiredText(shopId, 'RECOVERY_RECONCILE_SHOP_ID_REQUIRED');
    const overlap = normalizeOverlapMinutes(overlapMinutes);
    const timestamp = nowIso(now);
    db.prepare(`
      INSERT INTO recovery_reconcile_state (
        restore_id, generation_id, shop_id, status, overlap_minutes,
        queued_policy_count, completed_policy_count, failed_policy_count, job_ids_json,
        queued_at, completed_at, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, 0, 0, 0, '[]', NULL, NULL, NULL, ?, ?)
      ON CONFLICT(restore_id, shop_id) DO UPDATE SET
        generation_id = excluded.generation_id,
        status = 'pending',
        overlap_minutes = excluded.overlap_minutes,
        queued_policy_count = 0,
        completed_policy_count = 0,
        failed_policy_count = 0,
        job_ids_json = '[]',
        queued_at = NULL,
        completed_at = NULL,
        last_error = NULL,
        updated_at = excluded.updated_at
    `).run(restore, generation, shop, overlap, timestamp, timestamp);
    return get(restore, shop);
  }

  function listPending() {
    return db.prepare(`
      SELECT restore_id, generation_id, shop_id, status, overlap_minutes,
             queued_policy_count, completed_policy_count, failed_policy_count, job_ids_json,
             queued_at, completed_at, last_error, created_at, updated_at
      FROM recovery_reconcile_state
      WHERE status = 'pending'
      ORDER BY created_at ASC, restore_id ASC
    `).all().map(publicRow);
  }

  function listStatus() {
    return db.prepare(`
      SELECT restore_id, generation_id, shop_id, status, overlap_minutes,
             queued_policy_count, completed_policy_count, failed_policy_count, job_ids_json,
             queued_at, completed_at, last_error, created_at, updated_at
      FROM recovery_reconcile_state
      ORDER BY created_at DESC, restore_id DESC
      LIMIT 50
    `).all().map(publicRow);
  }

  function markQueued({ restoreId, shopId, queuedPolicyCount, jobIds = [], lastError = null } = {}) {
    const restore = requiredText(restoreId, 'RECOVERY_RECONCILE_RESTORE_ID_REQUIRED');
    const shop = requiredText(shopId, 'RECOVERY_RECONCILE_SHOP_ID_REQUIRED');
    const count = Math.max(0, Number.parseInt(queuedPolicyCount, 10) || 0);
    const normalizedJobIds = normalizeJobIds(jobIds);
    const timestamp = nowIso(now);
    const result = db.prepare(`
      UPDATE recovery_reconcile_state
      SET status = CASE WHEN ? > 0 THEN 'queued' ELSE 'pending' END,
          queued_policy_count = ?,
          completed_policy_count = 0,
          failed_policy_count = 0,
          job_ids_json = ?,
          queued_at = CASE WHEN ? > 0 THEN ? ELSE NULL END,
          completed_at = NULL,
          last_error = ?,
          updated_at = ?
      WHERE restore_id = ? AND shop_id = ?
    `).run(count, count, JSON.stringify(normalizedJobIds), count, timestamp, lastError || null, timestamp, restore, shop);
    if (result.changes !== 1) throw new Error('RECOVERY_RECONCILE_STATE_NOT_FOUND');
    return get(restore, shop);
  }

  function markFinal({ restoreId, shopId, completedPolicyCount, failedPolicyCount, lastError = null } = {}) {
    const restore = requiredText(restoreId, 'RECOVERY_RECONCILE_RESTORE_ID_REQUIRED');
    const shop = requiredText(shopId, 'RECOVERY_RECONCILE_SHOP_ID_REQUIRED');
    const completed = Math.max(0, Number.parseInt(completedPolicyCount, 10) || 0);
    const failed = Math.max(0, Number.parseInt(failedPolicyCount, 10) || 0);
    const status = failed > 0 ? (completed > 0 ? 'partial' : 'failed') : 'completed';
    const timestamp = nowIso(now);
    const result = db.prepare(`
      UPDATE recovery_reconcile_state
      SET status = ?, completed_policy_count = ?, failed_policy_count = ?,
          completed_at = ?, last_error = ?, updated_at = ?
      WHERE restore_id = ? AND shop_id = ?
    `).run(status, completed, failed, timestamp, lastError || null, timestamp, restore, shop);
    if (result.changes !== 1) throw new Error('RECOVERY_RECONCILE_STATE_NOT_FOUND');
    return get(restore, shop);
  }

  function reconcileQueuedJobs({ getJob } = {}) {
    if (typeof getJob !== 'function') return [];
    const rows = db.prepare(`
      SELECT restore_id, generation_id, shop_id, status, overlap_minutes,
             queued_policy_count, completed_policy_count, failed_policy_count, job_ids_json,
             queued_at, completed_at, last_error, created_at, updated_at
      FROM recovery_reconcile_state WHERE status = 'queued'
      ORDER BY queued_at ASC, restore_id ASC
    `).all().map(publicRow);
    const finalized = [];
    for (const row of rows) {
      if (!row.jobIds.length) continue;
      const jobs = row.jobIds.map((jobId) => ({ jobId, job: getJob(jobId) || null }));
      // A pruned/missing scheduler job is a failed observation, not permission to keep
      // claiming an indefinitely running recovery reconcile.
      if (jobs.some(({ job }) => job && !FINAL_JOB_STATUSES.has(String(job.status || '').trim()))) continue;
      const completed = jobs.filter(({ job }) => SUCCESS_JOB_STATUSES.has(String(job?.status || '').trim())).length;
      const failedJobs = jobs.filter(({ job }) => !SUCCESS_JOB_STATUSES.has(String(job?.status || '').trim()));
      const reason = failedJobs
        .map(({ jobId, job }) => job?.lastError || job?.error?.message || `${jobId}: job_missing_or_failed`)
        .filter(Boolean)
        .join('; ') || null;
      finalized.push(markFinal({
        restoreId: row.restoreId,
        shopId: row.shopId,
        completedPolicyCount: completed,
        failedPolicyCount: failedJobs.length,
        lastError: reason,
      }));
    }
    return finalized;
  }

  function getStatus() {
    const rows = listStatus();
    return {
      pending: rows.filter((row) => row.status === 'pending').length,
      queued: rows.filter((row) => row.status === 'queued').length,
      completed: rows.filter((row) => row.status === 'completed').length,
      partial: rows.filter((row) => row.status === 'partial').length,
      failed: rows.filter((row) => row.status === 'failed').length,
      rows,
    };
  }

  return { prepare, get, listPending, listStatus, markQueued, markFinal, reconcileQueuedJobs, getStatus };
}
