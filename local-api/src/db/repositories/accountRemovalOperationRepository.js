import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createIrreversibleSecretReference, decryptSecret, encryptSecret } from '../../security/secretCrypto.js';
import {
  getAccountRemovalClientResourceIds,
  isAccountRemovalServerVerifiedClientResource,
} from '../../domain/accountRemoval/accountRemovalClientResources.js';
import { createAccountRemovalClientFailureDto } from '../../domain/accountRemoval/accountRemovalClientFailureContract.js';

const ACTIVE_STATUS = 'pending';
const OPERATION_PHASES = Object.freeze([
  'confirmed',
  'quiescing',
  'local-delete-pending',
  'external-delete-pending',
  'verifying',
  'completed',
]);
const OPERATION_PHASE_RANK = new Map(OPERATION_PHASES.map((phase, index) => [phase, index]));

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function assertText(value, code) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(code);
  return text;
}

export function createAccountRemovalOwnerRef(owner = {}) {
  return createIrreversibleSecretReference(
    'account-removal-owner-v1',
    `${owner.ownerType}\0${owner.ownerId}`,
  );
}

export function createAccountRemovalIdempotencyKeyHash(idempotencyKey) {
  return sha256(`account-removal-idempotency-v1\0${idempotencyKey}`);
}

export function createAccountRemovalOperationRepository(db, {
  encryptPayload = (value) => encryptSecret(JSON.stringify(value)),
  decryptPayload = (value) => JSON.parse(decryptSecret(value)),
  now = nowIso,
  createOperationId = () => `account_removal_${randomUUID()}`,
  createClientCleanupNonce = () => randomBytes(24).toString('base64url'),
} = {}) {
  function rowById(operationId) {
    return db.prepare('SELECT * FROM account_removal_operations WHERE operation_id = ?').get(operationId) || null;
  }

  function rowByKeyHash(keyHash) {
    return db.prepare('SELECT * FROM account_removal_operations WHERE idempotency_key_hash = ?').get(keyHash) || null;
  }

  function decodePayload(row) {
    if (!row?.payload_encrypted) return null;
    try {
      return decryptPayload(row.payload_encrypted);
    } catch {
      throw new Error('ACCOUNT_REMOVAL_OPERATION_PAYLOAD_INVALID');
    }
  }

  function toOperation(row, { includePayload = true } = {}) {
    if (!row) return null;
    return {
      operationId: row.operation_id,
      requestDigest: row.request_digest,
      ownerType: row.owner_type,
      ownerRef: row.owner_ref,
      phase: row.phase,
      status: row.status,
      attemptCount: Number(row.attempt_count) || 0,
      previewFingerprint: row.preview_fingerprint,
      catalogFingerprint: row.catalog_fingerprint,
      snapshotFingerprint: row.snapshot_fingerprint,
      clientCleanupNonce: row.client_cleanup_nonce || null,
      clientResourceIds: parseJson(row.client_resource_ids_json, []),
      deletionSummary: parseJson(row.deletion_summary_json, {}),
      lastErrorCode: row.last_error_code || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at || null,
      ...(includePayload ? { payload: decodePayload(row) } : {}),
    };
  }

  function getOperation(operationId, options) {
    return toOperation(rowById(assertText(operationId, 'ACCOUNT_REMOVAL_OPERATION_ID_REQUIRED')), options);
  }

  function findByIdempotencyKey(idempotencyKey, options) {
    const key = assertText(idempotencyKey, 'ACCOUNT_REMOVAL_IDEMPOTENCY_KEY_REQUIRED');
    return toOperation(rowByKeyHash(createAccountRemovalIdempotencyKeyHash(key)), options);
  }

  function findActiveByOwner(owner = {}, options) {
    const ownerType = assertText(owner.ownerType, 'ACCOUNT_REMOVAL_OWNER_TYPE_INVALID');
    const ownerRef = createAccountRemovalOwnerRef({ ownerType, ownerId: assertText(owner.ownerId, 'ACCOUNT_REMOVAL_OWNER_ID_REQUIRED') });
    const row = db.prepare(`
      SELECT * FROM account_removal_operations
      WHERE owner_type = ? AND owner_ref = ? AND completed_at IS NULL
      ORDER BY created_at ASC, operation_id ASC
      LIMIT 1
    `).get(ownerType, ownerRef);
    return toOperation(row || null, options);
  }

  function findLatestByOwner(owner = {}, options) {
    const ownerType = assertText(owner.ownerType, 'ACCOUNT_REMOVAL_OWNER_TYPE_INVALID');
    const ownerRef = createAccountRemovalOwnerRef({ ownerType, ownerId: assertText(owner.ownerId, 'ACCOUNT_REMOVAL_OWNER_ID_REQUIRED') });
    const row = db.prepare(`
      SELECT * FROM account_removal_operations
      WHERE owner_type = ? AND owner_ref = ?
      ORDER BY created_at DESC, operation_id DESC
      LIMIT 1
    `).get(ownerType, ownerRef);
    return toOperation(row || null, options);
  }

  function hasActiveOwner(owner = {}) {
    return Boolean(findActiveByOwner(owner, { includePayload: false }));
  }

  function upgradeLegacyClientCleanupChallenge(operationId) {
    const row = rowById(assertText(operationId, 'ACCOUNT_REMOVAL_OPERATION_ID_REQUIRED'));
    const operation = toOperation(row);
    if (!operation) throw new Error('ACCOUNT_REMOVAL_OPERATION_NOT_FOUND');
    if (operation.completedAt) return operation;
    const currentIds = [...getAccountRemovalClientResourceIds(operation.ownerType)].sort();
    const storedIds = [...operation.clientResourceIds].sort();
    if (JSON.stringify(currentIds) === JSON.stringify(storedIds)) return operation;
    // Compatibility for the one known additive renderer-cache contract. Old
    // tasks advertised the old list, while the verifier required the new list,
    // so no challenge generated by that task could ever pass verification.
    // This only extends cleanup of the same confirmed owner; arbitrary future
    // catalog changes still fail closed rather than silently widening scope.
    const addedId = 'memory:renderer-collection-listing-category-template-cache';
    const legacyIds = currentIds.filter(id => id !== addedId);
    if (operation.ownerType !== 'ozon_shop' || !currentIds.includes(addedId)
      || JSON.stringify(storedIds) !== JSON.stringify(legacyIds)
      || operation.phase !== 'external-delete-pending'
      || operation.payload?.clientCleanupVerification?.verified === true
      || !operation.clientCleanupNonce) {
      throw new Error('ACCOUNT_REMOVAL_CLIENT_CLEANUP_UPGRADE_UNSUPPORTED');
    }
    const nextNonce = createClientCleanupNonce();
    if (!nextNonce || nextNonce === operation.clientCleanupNonce) throw new Error('ACCOUNT_REMOVAL_OPERATION_STATE_INVALID');
    const result = db.prepare(`
      UPDATE account_removal_operations
      SET client_resource_ids_json = ?, client_cleanup_nonce = ?,
          last_error_code = NULL, status = 'pending', updated_at = ?
      WHERE operation_id = ? AND completed_at IS NULL AND phase = 'external-delete-pending'
        AND client_resource_ids_json = ? AND client_cleanup_nonce = ?
    `).run(JSON.stringify(currentIds), nextNonce, now(), operationId, row.client_resource_ids_json, operation.clientCleanupNonce);
    const latest = getOperation(operationId);
    if (!latest) throw new Error('ACCOUNT_REMOVAL_OPERATION_NOT_FOUND');
    if (result.changes === 0 && !latest?.completedAt
      && JSON.stringify([...latest.clientResourceIds].sort()) !== JSON.stringify(currentIds)) {
      throw new Error('ACCOUNT_REMOVAL_OPERATION_STATE_INVALID');
    }
    return latest;
  }

  function beginOrReuse({
    preview,
    confirm,
    account,
    ownerIncarnation,
    identityLifecycle = null,
    barrierProof,
    backupAuthorization,
  }) {
    const keyHash = createAccountRemovalIdempotencyKeyHash(confirm.idempotencyKey);
    const existing = rowByKeyHash(keyHash);
    if (existing) {
      if (existing.request_digest !== confirm.requestDigest) {
        throw new Error('ACCOUNT_REMOVAL_IDEMPOTENCY_KEY_CONFLICT');
      }
      return { created: false, operation: toOperation(existing) };
    }

    const ownerRef = createAccountRemovalOwnerRef(confirm.owner);
    const active = db.prepare(`
      SELECT * FROM account_removal_operations
      WHERE owner_type = ? AND owner_ref = ? AND completed_at IS NULL
      LIMIT 1
    `).get(confirm.owner.ownerType, ownerRef);
    if (active) throw new Error('ACCOUNT_REMOVAL_OWNER_LOCKED');

    const timestamp = now();
    const operationId = createOperationId();
    const plannedIds = new Set(preview.plannedResources.map((entry) => entry.id));
    const clientResourceIds = getAccountRemovalClientResourceIds(confirm.owner.ownerType)
      .filter((resourceId) => plannedIds.has(resourceId))
      .sort();
    const payload = {
      preview,
      confirm,
      account,
      ownerIncarnation: assertText(ownerIncarnation, 'ACCOUNT_REMOVAL_OWNER_INCARNATION_REQUIRED'),
      ...(identityLifecycle ? { identityLifecycle } : {}),
      barrierProof,
      backupAuthorization: backupAuthorization && typeof backupAuthorization === 'object'
        ? { ...backupAuthorization }
        : null,
      preservationSnapshot: null,
    };
    try {
      db.prepare(`
      INSERT INTO account_removal_operations (
        operation_id, idempotency_key_hash, request_digest, owner_type, owner_ref,
        payload_encrypted, phase, status, attempt_count, preview_fingerprint,
        catalog_fingerprint, snapshot_fingerprint, client_cleanup_nonce,
        client_resource_ids_json, deletion_summary_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, 0, ?, ?, ?, ?, ?, '{}', ?, ?)
    `).run(
      operationId,
      keyHash,
      confirm.requestDigest,
      confirm.owner.ownerType,
      ownerRef,
      encryptPayload(payload),
      ACTIVE_STATUS,
      confirm.previewFingerprint,
      confirm.catalogFingerprint,
      confirm.snapshotFingerprint,
      clientResourceIds.length ? createClientCleanupNonce() : null,
      JSON.stringify(clientResourceIds),
      timestamp,
      timestamp,
      );
    } catch (error) {
      const sqliteConstraint = /^SQLITE_CONSTRAINT/u.test(String(error?.code || ''))
        || (error?.code === 'ERR_SQLITE_ERROR' && (Number(error.errcode) & 0xff) === 19);
      if (!sqliteConstraint) throw error;
      // Another connection may win between the optimistic lookup and INSERT.
      // Reconcile through the actual unique rows, not the driver error string.
      const concurrent = rowByKeyHash(keyHash);
      if (concurrent) {
        if (concurrent.request_digest !== confirm.requestDigest) throw new Error('ACCOUNT_REMOVAL_IDEMPOTENCY_KEY_CONFLICT');
        return { created: false, operation: toOperation(concurrent) };
      }
      if (findActiveByOwner(confirm.owner, { includePayload: false })) throw new Error('ACCOUNT_REMOVAL_OWNER_LOCKED');
      throw error;
    }
    return { created: true, operation: getOperation(operationId) };
  }

  function updatePayload(operationId, patch = {}) {
    const operation = getOperation(operationId);
    if (!operation) throw new Error('ACCOUNT_REMOVAL_OPERATION_NOT_FOUND');
    if (!operation.payload) throw new Error('ACCOUNT_REMOVAL_OPERATION_PAYLOAD_REQUIRED');
    const payload = { ...operation.payload, ...patch };
    db.prepare(`
      UPDATE account_removal_operations
      SET payload_encrypted = ?, updated_at = ?
      WHERE operation_id = ?
    `).run(encryptPayload(payload), now(), operationId);
    return getOperation(operationId);
  }

  function recordTrustedClientResourceReceipt(operationId, resourceId) {
    const operation = getOperation(operationId);
    const id = assertText(resourceId, 'ACCOUNT_REMOVAL_CLIENT_RESOURCE_ID_REQUIRED');
    if (
      !operation
      || operation.completedAt
      || !operation.payload
      || !operation.clientResourceIds.includes(id)
      || !isAccountRemovalServerVerifiedClientResource(operation.ownerType, id)
    ) {
      throw new Error('ACCOUNT_REMOVAL_CLIENT_RESOURCE_RECEIPT_INVALID');
    }
    const trustedClientResourceReceipts = {
      ...(operation.payload.trustedClientResourceReceipts || {}),
      [id]: { verified: true },
    };
    return updatePayload(operationId, { trustedClientResourceReceipts });
  }

  function markPhase(operationId, phase, { deletionSummary, incrementAttempt = false } = {}) {
    const normalizedOperationId = assertText(operationId, 'ACCOUNT_REMOVAL_OPERATION_ID_REQUIRED');
    const targetRank = OPERATION_PHASE_RANK.get(phase);
    if (targetRank === undefined || phase === 'completed') {
      throw new Error('ACCOUNT_REMOVAL_OPERATION_PHASE_INVALID');
    }
    const current = rowById(normalizedOperationId);
    if (!current) throw new Error('ACCOUNT_REMOVAL_OPERATION_NOT_FOUND');
    const currentRank = OPERATION_PHASE_RANK.get(current.phase);
    if (currentRank === undefined) throw new Error('ACCOUNT_REMOVAL_OPERATION_PHASE_INVALID');
    if (current.completed_at) return toOperation(current);
    if (targetRank < currentRank) throw new Error('ACCOUNT_REMOVAL_OPERATION_PHASE_REGRESSION');
    const timestamp = now();
    const summary = deletionSummary === undefined
      ? null
      : JSON.stringify(deletionSummary && typeof deletionSummary === 'object' ? deletionSummary : {});
    db.prepare(`
      UPDATE account_removal_operations
      SET phase = ?, status = ?, attempt_count = attempt_count + ?,
          deletion_summary_json = COALESCE(?, deletion_summary_json),
          last_error_code = NULL, updated_at = ?
      WHERE operation_id = ? AND completed_at IS NULL
    `).run(phase, ACTIVE_STATUS, incrementAttempt ? 1 : 0, summary, timestamp, normalizedOperationId);
    return getOperation(normalizedOperationId);
  }

  function recordFailure(operationId, code) {
    db.prepare(`
      UPDATE account_removal_operations
      SET status = 'retryable-failed', last_error_code = ?, updated_at = ?
      WHERE operation_id = ? AND completed_at IS NULL
    `).run(assertText(code, 'ACCOUNT_REMOVAL_FAILURE_CODE_REQUIRED'), now(), operationId);
    return getOperation(operationId);
  }

  function recordClientFailure(input) {
    const report = createAccountRemovalClientFailureDto(input);
    function assertPending(row) {
      if (!row) throw new Error('ACCOUNT_REMOVAL_OPERATION_NOT_FOUND');
      if (row.completed_at) return false;
      if (row.phase !== 'external-delete-pending') throw new Error('ACCOUNT_REMOVAL_CLIENT_CLEANUP_REQUIRED');
      if (row.client_cleanup_nonce !== report.nonce || row.preview_fingerprint !== report.previewFingerprint) {
        throw new Error('ACCOUNT_REMOVAL_CLIENT_FAILURE_CHALLENGE_MISMATCH');
      }
      const resources = parseJson(row.client_resource_ids_json, []);
      if (report.resourceId && (!Array.isArray(resources) || !resources.includes(report.resourceId))) {
        throw new Error('ACCOUNT_REMOVAL_CLIENT_FAILURE_RESOURCE_INVALID');
      }
      return true;
    }
    const before = rowById(report.operationId);
    if (!assertPending(before)) return { reported: false, operation: toOperation(before, { includePayload: false }) };
    const resourceId = report.resourceId || null;
    const written = db.prepare(`
      UPDATE account_removal_operations
      SET status = 'retryable-failed', last_error_code = ?, updated_at = ?,
          deletion_summary_json = json_set(deletion_summary_json, '$.clientFailure',
            json_object('code', ?, 'resourceId', ?))
      WHERE operation_id = ? AND completed_at IS NULL
        AND phase = 'external-delete-pending'
        AND client_cleanup_nonce = ? AND preview_fingerprint = ?
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM json_each(client_resource_ids_json) WHERE value = ?
        ))
    `).run(report.errorCode, now(), report.errorCode, resourceId, report.operationId,
      report.nonce, report.previewFingerprint, resourceId, resourceId);
    const current = rowById(report.operationId);
    if (!current) throw new Error('ACCOUNT_REMOVAL_OPERATION_NOT_FOUND');
    if (current.completed_at) return { reported: false, operation: toOperation(current, { includePayload: false }) };
    if (Number(written.changes) !== 1) {
      assertPending(current);
      throw new Error('ACCOUNT_REMOVAL_CLIENT_FAILURE_CONFLICT');
    }
    return { reported: true, operation: toOperation(current, { includePayload: false }) };
  }

  function markCompleted(operationId, deletionSummary = {}) {
    const timestamp = now();
    db.prepare(`
      UPDATE account_removal_operations
      SET phase = 'completed', status = 'completed', payload_encrypted = NULL,
          client_cleanup_nonce = NULL, deletion_summary_json = ?,
          last_error_code = NULL, updated_at = ?, completed_at = ?
      WHERE operation_id = ? AND completed_at IS NULL
    `).run(JSON.stringify(deletionSummary), timestamp, timestamp, operationId);
    return getOperation(operationId, { includePayload: false });
  }

  function listPending() {
    return db.prepare(`
      SELECT * FROM account_removal_operations
      WHERE completed_at IS NULL
      ORDER BY created_at ASC, operation_id ASC
    `).all().map((row) => toOperation(row, { includePayload: false }));
  }

  return {
    beginOrReuse,
    findActiveByOwner,
    findByIdempotencyKey,
    findLatestByOwner,
    getOperation,
    hasActiveOwner,
    upgradeLegacyClientCleanupChallenge,
    listPending,
    markCompleted,
    markPhase,
    recordTrustedClientResourceReceipt,
    recordFailure,
    recordClientFailure,
    updatePayload,
  };
}
