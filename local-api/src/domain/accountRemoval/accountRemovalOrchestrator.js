import {
  ACCOUNT_REMOVAL_SAFETY_BARRIER_VERSION,
  createAccountRemovalConfirmDto,
  validateAccountRemovalOwner,
} from './accountRemovalContract.js';
import {
  getAccountRemovalClientBarrierIds,
  getAccountRemovalClientResourceIds,
} from './accountRemovalClientResources.js';
import { ACCOUNT_REMOVAL_ERROR_CODES, failAccountRemovalContract } from './accountRemovalErrors.js';
import { accountRemovalOperationErrorCode as operationErrorCode } from './accountRemovalErrorClassifier.js';
import { createAccountRemovalClientFailureDto } from './accountRemovalClientFailureContract.js';
import { DATA_BACKUP_SKIP_CONFIRMATION_CODE } from '../../backup/dataBackupService.js';

export const ACCOUNT_REMOVAL_CONFIRMATION_CODE = 'DELETE_ACCOUNT_PERMANENTLY';

const LEGACY_UNPROTECTED_BACKUP_OUTCOME = 'legacy-unprotected';

const OPERATION_PHASE_RANK = new Map([
  'confirmed',
  'quiescing',
  'local-delete-pending',
  'external-delete-pending',
  'verifying',
  'completed',
].map((phase, index) => [phase, index]));

function sameArray(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

const SQLITE_BUSY_RETRY_DELAYS_MS = Object.freeze([250, 500, 1_000, 1_500, 2_000, 3_000]);

function phaseRank(phase) {
  const rank = OPERATION_PHASE_RANK.get(phase);
  if (rank === undefined) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OPERATION_STATE_INVALID);
  return rank;
}

function hasBackupAuthorization(operation) {
  const authorization = operation?.payload?.backupAuthorization;
  return Boolean(
    authorization
    && typeof authorization === 'object'
    && !Array.isArray(authorization)
    && typeof authorization.outcome === 'string'
    && authorization.outcome,
  );
}

function backupAuthorizationAuditSummary(authorization) {
  return {
    outcome: authorization.outcome,
    ...(typeof authorization.previewFingerprint === 'string' && authorization.previewFingerprint
      ? { previewFingerprint: authorization.previewFingerprint }
      : {}),
    ...(typeof authorization.dataFingerprint === 'string' && authorization.dataFingerprint
      ? { dataFingerprint: authorization.dataFingerprint }
      : {}),
    ...(typeof authorization.backupId === 'string' && authorization.backupId
      ? { backupId: authorization.backupId }
      : {}),
    ...(typeof authorization.packageSha256 === 'string' && authorization.packageSha256
      ? { packageSha256: authorization.packageSha256 }
      : {}),
    ...(typeof authorization.verifiedAt === 'string' && authorization.verifiedAt
      ? { verifiedAt: authorization.verifiedAt }
      : {}),
  };
}

function backupAudit(operation) {
  if (hasBackupAuthorization(operation)) {
    return {
      backupOutcome: operation.payload.backupAuthorization.outcome,
      backupSummary: backupAuthorizationAuditSummary(operation.payload.backupAuthorization),
    };
  }
  if (!operation?.payload?.deletionExecution) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.BACKUP_REVIEW_REQUIRED);
  }
  return {
    backupOutcome: LEGACY_UNPROTECTED_BACKUP_OUTCOME,
    backupSummary: {
      outcome: LEGACY_UNPROTECTED_BACKUP_OUTCOME,
      protectedByBackupGate: false,
      reason: 'legacy-operation-local-deletion-already-started',
    },
  };
}

function shopStorageScopeToken(operation) {
  const identity = operation?.payload?.identityLifecycle;
  const owner = operation?.payload?.confirm?.owner;
  if (owner?.ownerType !== 'ozon_shop' || !identity?.shopIncarnation) return null;
  return Object.freeze({
    profileId: identity.profileId,
    shopId: owner.ownerId,
    shopIncarnation: identity.shopIncarnation,
    credentialRevision: identity.credentialRevision,
  });
}

function publicShopStorageDeletion(deletion, backup) {
  return {
    deleted: deletion?.deleted === true,
    alreadyAbsent: deletion?.alreadyAbsent === true,
    scopeDigest: deletion?.scopeDigest || deletion?.preview?.layout?.scopeDigest || backup?.scopeDigest || null,
    backupCreated: Boolean(backup?.backupSha256),
    backupSha256: backup?.backupSha256 || null,
    backupByteSize: Number(backup?.byteSize || 0),
    sourceFingerprint: backup?.sourceFingerprint || deletion?.preview?.fingerprint || null,
  };
}

function isLegacyOperationAwaitingBackupReview(operation) {
  return Boolean(
    operation
    && operation.status !== 'completed'
    && !hasBackupAuthorization(operation)
    && !operation.payload?.deletionExecution,
  );
}

function publicOperation(operation) {
  if (!operation) return null;
  const completed = operation.status === 'completed' && operation.phase === 'completed';
  const requiresClientCleanup = !completed
    && operation.phase === 'external-delete-pending'
    && operation.clientResourceIds.length > 0;
  const pendingOwner = !completed ? operation.payload?.confirm?.owner : null;
  const lifecycle = operation.payload?.identityLifecycle;
  const pendingOwnerGeneration = !completed ? operation.deletionSummary?.removedOwnerGeneration || (lifecycle ? {
    ownerId: pendingOwner?.ownerId, clientId: lifecycle.clientId, profileId: lifecycle.profileId,
    shopIncarnation: lifecycle.shopIncarnation, credentialRevision: lifecycle.credentialRevision,
  } : null) : null;
  return {
    ok: true,
    operationId: operation.operationId,
    ownerType: operation.ownerType,
    ownerRef: operation.ownerRef,
    phase: operation.phase,
    status: operation.status,
    attemptCount: operation.attemptCount,
    previewFingerprint: operation.previewFingerprint,
    completed,
    ...(!completed && pendingOwner ? { pendingOwner: { ownerType: pendingOwner.ownerType, ownerId: pendingOwner.ownerId }, pendingOwnerGeneration } : {}),
    requiresClientCleanup,
    clientCleanup: requiresClientCleanup
      ? { nonce: operation.clientCleanupNonce, resourceIds: operation.clientResourceIds }
      : null,
    deletionSummary: operation.deletionSummary,
    error: operation.lastErrorCode ? { code: operation.lastErrorCode } : null,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    completedAt: operation.completedAt,
  };
}

function validateBarrierProof(preview, proof) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.BARRIER_PROOF_REQUIRED);
  }
  const expectedIds = getAccountRemovalClientBarrierIds(preview.owner.ownerType).sort();
  const fenced = Array.isArray(proof.fencedResourceIds) ? [...proof.fencedResourceIds].sort() : null;
  const drained = Array.isArray(proof.drainedResourceIds) ? [...proof.drainedResourceIds].sort() : null;
  const keys = Object.keys(proof).sort();
  const allowedKeys = ['drainedResourceIds', 'fencedResourceIds', 'owner', 'previewFingerprint', 'version'].sort();
  if (
    !sameArray(keys, allowedKeys)
    || proof.version !== ACCOUNT_REMOVAL_SAFETY_BARRIER_VERSION
    || proof.previewFingerprint !== preview.previewFingerprint
    || proof.owner?.ownerType !== preview.owner.ownerType
    || proof.owner?.ownerId !== preview.owner.ownerId
    || !sameArray(fenced, expectedIds)
    || !sameArray(drained, expectedIds)
  ) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.BARRIER_PROOF_INVALID);
  }
  return {
    version: proof.version,
    owner: { ...proof.owner },
    previewFingerprint: proof.previewFingerprint,
    fencedResourceIds: fenced,
    drainedResourceIds: drained,
  };
}

export function createAccountRemovalOrchestrator({
  planner,
  operationRepository,
  sqliteExecutor,
  verifier,
  runtimeCoordinator,
  dataBackupService,
  serverResourceCleanup = null,
  shopStorageLifecycle = null,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  if (
    !planner
    || !operationRepository
    || !sqliteExecutor
    || !verifier
    || !runtimeCoordinator
    || typeof dataBackupService?.reviewAccountRemoval !== 'function'
    || typeof dataBackupService?.authorizeAccountRemoval !== 'function'
  ) {
    throw new Error('ACCOUNT_REMOVAL_ORCHESTRATOR_DEPENDENCY_REQUIRED');
  }

  const operationTasks = new Map();
  const confirmingOwners = new Map();
  const ownerKey = (owner) => JSON.stringify([owner.ownerType, owner.ownerId]);

  async function retryDatabaseBusy(work) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        const code = operationErrorCode(error);
        if (
          code !== ACCOUNT_REMOVAL_ERROR_CODES.DATABASE_BUSY
          || attempt >= SQLITE_BUSY_RETRY_DELAYS_MS.length
        ) {
          if (code === ACCOUNT_REMOVAL_ERROR_CODES.DATABASE_BUSY && error?.code !== code) failAccountRemovalContract(code);
          throw error;
        }
        await wait(SQLITE_BUSY_RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  function startOperationTask(operationId, kind, work) {
    const promise = retryDatabaseBusy(work).finally(() => {
      if (operationTasks.get(operationId)?.promise === promise) operationTasks.delete(operationId);
    });
    operationTasks.set(operationId, { kind, promise });
    return promise;
  }

  function recordFailureSafely(operationId, code) {
    try {
      operationRepository.recordFailure(operationId, code);
    } catch (persistenceError) {
      // A writer lock can also block failure recording. Keep the original
      // failure and the durable unfinished operation; never release its fence.
      console.error('[account-removal] failure status persistence deferred', {
        operationId, code, persistenceCode: operationErrorCode(persistenceError),
      });
    }
  }

  function readCompletedOperation(operationId) {
    try {
      const operation = operationRepository.getOperation(operationId, { includePayload: false });
      return operation?.status === 'completed' && operation.phase === 'completed' ? operation : null;
    } catch { return null; }
  }

  async function releaseTransientResources(owner) {
    if (!owner) return;
    try {
      await runtimeCoordinator.releaseTransientResources?.(owner);
    } catch (error) {
      // Read-barrier release cannot turn committed deletion into a false
      // failure or erase the persistent write fence of an unfinished one.
      console.error('[account-removal] transient resource release deferred', { code: operationErrorCode(error) });
    }
  }

  function completeRuntime(owner) {
    try {
      runtimeCoordinator.complete?.(owner);
    } catch {
      // The durable operation is already complete. A transient in-memory
      // release failure is cleared on process restart and must not create a
      // false retry of the irreversible SQLite deletion.
    }
  }

  function createDirectDeleteBackupAuthorization(owner, previewFingerprint) {
    const review = dataBackupService.reviewAccountRemoval({ owner, previewFingerprint });
    if (review.required !== true) return null;
    return {
      outcome: 'explicitly-skipped',
      previewFingerprint,
      dataFingerprint: review.dataFingerprint,
      skipConfirmationCode: DATA_BACKUP_SKIP_CONFIRMATION_CODE,
    };
  }

  async function runOperationAttempt(operationId, { directDelete = false } = {}) {
    let operation = operationRepository.getOperation(operationId);
    if (!operation) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OPERATION_NOT_FOUND);
    if (operation.status === 'completed') return publicOperation(operation);
    const { preview, confirm } = operation.payload || {};
    if (!preview || !confirm) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OPERATION_STATE_INVALID);
    try {
      if (operation.phase === 'external-delete-pending'
        && typeof operationRepository.upgradeLegacyClientCleanupChallenge === 'function') {
        operation = operationRepository.upgradeLegacyClientCleanupChallenge(operationId);
        if (operation.status === 'completed') return publicOperation(operation);
      }
      let operationBackupAudit = backupAudit(operation);
      const clientResourceIds = getAccountRemovalClientResourceIds(confirm.owner.ownerType);
      if (
        operation.phase === 'external-delete-pending'
        && clientResourceIds.length > 0
        && operation.payload?.clientCleanupVerification?.verified !== true
      ) {
        operation = operationRepository.markPhase(operationId, 'external-delete-pending', {
          deletionSummary: { ...operation.deletionSummary, ...operationBackupAudit },
        });
        await runtimeCoordinator.quiesce(confirm.owner);
        return publicOperation(operationRepository.getOperation(operationId));
      }
      const attemptPhase = phaseRank(operation.phase) < phaseRank('quiescing')
        ? 'quiescing'
        : operation.phase;
      operationRepository.markPhase(operationId, attemptPhase, { incrementAttempt: true });
      await runtimeCoordinator.quiesce(confirm.owner);
      operation = operationRepository.getOperation(operationId);

      let deletionExecution = operation.payload?.deletionExecution || null;
      if (!deletionExecution) {
        const requestedBackupAuthorization = directDelete
          ? createDirectDeleteBackupAuthorization(confirm.owner, preview.previewFingerprint)
          : operation.payload?.backupAuthorization;
        const refreshedBackupAuthorization = dataBackupService.authorizeAccountRemoval({
          owner: confirm.owner,
          previewFingerprint: preview.previewFingerprint,
          authorization: requestedBackupAuthorization,
        });
        operation = operationRepository.updatePayload(operationId, {
          backupAuthorization: refreshedBackupAuthorization,
          ...(directDelete ? {
            directDelete: {
              requested: true,
              backupPromptRequired: false,
            },
          } : {}),
        });
        if (phaseRank(operation.phase) > phaseRank('local-delete-pending')) {
          failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OPERATION_STATE_INVALID);
        }
        operationRepository.markPhase(operationId, 'local-delete-pending');
        let remoteObjectStorage = operation.payload?.remoteObjectStorage || null;
        if (typeof serverResourceCleanup?.cleanupOwner === 'function' && remoteObjectStorage?.completed !== true) {
          remoteObjectStorage = await serverResourceCleanup.cleanupOwner(confirm.owner);
          operation = operationRepository.updatePayload(operationId, { remoteObjectStorage });
        }
        deletionExecution = await sqliteExecutor.execute(confirm.owner, {
          operationId,
          ownerIncarnation: operation.payload?.ownerIncarnation,
          identityLifecycle: operation.payload?.identityLifecycle || null,
          persistDeletionExecution(preparedExecution) {
            operationRepository.updatePayload(operationId, { deletionExecution: preparedExecution });
          },
        });
        if (remoteObjectStorage) deletionExecution = { ...deletionExecution, remoteObjectStorage };
        operation = operationRepository.updatePayload(operationId, { deletionExecution });
      } else if (deletionExecution.physicalStorage?.secureDelete !== true) {
        deletionExecution = sqliteExecutor.completePhysicalErasure(deletionExecution);
        operation = operationRepository.updatePayload(operationId, { deletionExecution });
      }
      const scopeToken = shopStorageScopeToken(operation);
      if (scopeToken && typeof shopStorageLifecycle?.deleteWithBackup === 'function') {
        let shopStorageDeletion = operation.payload?.shopStorageDeletion || null;
        let shopStorageBackup = operation.payload?.shopStorageBackup || null;
        if (!shopStorageDeletion) {
          const result = await shopStorageLifecycle.deleteWithBackup({
            scopeToken,
            async onBackup(backup) {
              shopStorageBackup = backup;
              operation = operationRepository.updatePayload(operationId, { shopStorageBackup: backup });
            },
          });
          shopStorageBackup = result.backup || shopStorageBackup;
          shopStorageDeletion = {
            deleted: result.deleted === true,
            alreadyAbsent: result.alreadyAbsent === true,
            scopeDigest: result.preview?.layout?.scopeDigest || shopStorageBackup?.scopeDigest || null,
          };
          operation = operationRepository.updatePayload(operationId, {
            shopStorageBackup,
            shopStorageDeletion,
          });
        }
        deletionExecution = {
          ...deletionExecution,
          shopStorage: publicShopStorageDeletion(shopStorageDeletion, shopStorageBackup),
        };
        operation = operationRepository.updatePayload(operationId, { deletionExecution });
      }
      if (!deletionExecution.remoteObjectStorage && operation.payload?.remoteObjectStorage) {
        deletionExecution = {
          ...deletionExecution,
          remoteObjectStorage: operation.payload.remoteObjectStorage,
        };
        operation = operationRepository.updatePayload(operationId, { deletionExecution });
      }
      operationBackupAudit = backupAudit(operation);

      if (clientResourceIds.length > 0) {
        const clientCleanupVerification = operation.payload?.clientCleanupVerification;
        if (clientCleanupVerification?.verified !== true) {
          if (phaseRank(operation.phase) > phaseRank('external-delete-pending')) {
            failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OPERATION_STATE_INVALID);
          }
          operation = operationRepository.markPhase(operationId, 'external-delete-pending', {
            deletionSummary: { ...deletionExecution, ...operationBackupAudit },
          });
          return publicOperation(operation);
        }
      }
      operationRepository.markPhase(operationId, 'verifying', {
        deletionSummary: { ...deletionExecution, ...operationBackupAudit },
      });
      const serverVerification = verifier.verifyServer(confirm.owner, preview, { scopeToken });
      if (!serverVerification.ok) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.SERVER_VERIFY_FAILED);
      operation = operationRepository.markCompleted(operationId, {
        ...deletionExecution,
        serverVerified: true,
        clientVerified: true,
        ...operationBackupAudit,
        ...(operation.payload?.clientCleanupVerification?.resourceCount !== undefined
          ? { clientResourceCount: operation.payload.clientCleanupVerification.resourceCount }
          : {}),
      });
      completeRuntime(confirm.owner);
      return publicOperation(operation);
    } catch (error) {
      const completed = readCompletedOperation(operationId);
      if (completed) {
        completeRuntime(confirm.owner);
        return publicOperation(completed);
      }
      const code = operationErrorCode(error);
      recordFailureSafely(operationId, code);
      if ([
        ACCOUNT_REMOVAL_ERROR_CODES.DATABASE_BUSY,
        ACCOUNT_REMOVAL_ERROR_CODES.SQLITE_EXECUTION_FAILED,
        'ACCOUNT_REMOVAL_EXECUTION_FAILED',
      ].includes(code)) {
        let phase = null;
        try { phase = operationRepository.getOperation(operationId, { includePayload: false })?.phase || null; } catch { /* same writer lock */ }
        console.error('[account-removal] operation failed', {
          operationId,
          phase,
          code,
          step: typeof error?.step === 'string' ? error.step : null,
          sqliteCode: typeof error?.sqliteCode === 'string' ? error.sqliteCode : null,
        });
      }
      if (typeof error?.code === 'string' && error.code === code) throw error;
      failAccountRemovalContract(code);
    } finally {
      await releaseTransientResources(confirm.owner);
    }
  }

  function runOperation(operationId, options = {}) {
    const active = operationTasks.get(operationId);
    if (active) return active.promise;
    return startOperationTask(operationId, 'run', () => runOperationAttempt(operationId, options));
  }

  function preview(input) {
    const result = planner.createPreview(input);
    const backupReview = dataBackupService.reviewAccountRemoval({
      owner: result.preview.owner,
      previewFingerprint: result.preview.previewFingerprint,
    });
    return { ok: true, ...result, backupReview };
  }

  async function preparePreview(input = {}) {
    const { owner } = planner.requireAccount(input.owner);
    if (typeof runtimeCoordinator.quiesceOwnerWrites !== 'function') {
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.QUIESCE_TIMEOUT);
    }
    try {
      await runtimeCoordinator.quiesceOwnerWrites(owner);
      return preview({ owner });
    } catch (error) {
      try { releaseOwnerFence(owner); } catch { /* keep preparation failure; never clear a durable removal fence */ }
      throw error;
    }
  }

  async function confirm({
    preview: echoedPreview,
    confirm: confirmInput,
    barrierProof,
    confirmationCode,
    backupAuthorization,
  } = {}) {
    if (confirmationCode !== ACCOUNT_REMOVAL_CONFIRMATION_CODE) {
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.CONFIRMATION_REQUIRED);
    }
    // This pure validation path permits a completed idempotent request to be
    // replayed after the owner row has already been erased.
    const echoedConfirm = createAccountRemovalConfirmDto(confirmInput, echoedPreview, {
      currentResourceObservations: echoedPreview?.resourceObservations,
    });
    const existing = operationRepository.findByIdempotencyKey(echoedConfirm.idempotencyKey);
    if (existing) {
      if (existing.requestDigest !== echoedConfirm.requestDigest) {
        failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT);
      }
      if (existing.status === 'completed') return publicOperation(existing);
      if (!isLegacyOperationAwaitingBackupReview(existing)) return runOperation(existing.operationId);
    }

    const { owner, account, ownerIncarnation, identityLifecycle } = planner.requireAccount(echoedConfirm.owner);
    const currentResourceObservations = planner.observeCurrent(owner, echoedPreview.plannedResources, {
      scopeToken: identityLifecycle
        ? {
            profileId: identityLifecycle.profileId,
            shopId: owner.ownerId,
            shopIncarnation: identityLifecycle.shopIncarnation,
          }
        : null,
    });
    const canonicalConfirm = createAccountRemovalConfirmDto(confirmInput, echoedPreview, {
      currentResourceObservations,
    });
    const canonicalBarrierProof = validateBarrierProof(echoedPreview, barrierProof);
    const canonicalBackupAuthorization = dataBackupService.authorizeAccountRemoval({
      owner,
      previewFingerprint: echoedPreview.previewFingerprint,
      authorization: backupAuthorization,
    });
    const active = operationRepository.findActiveByOwner(owner);
    if (active) {
      if (!isLegacyOperationAwaitingBackupReview(active)) {
        failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_LOCKED);
      }
      if (
        active.previewFingerprint !== echoedPreview.previewFingerprint
        || active.payload?.preview?.previewFingerprint !== echoedPreview.previewFingerprint
      ) {
        failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_FINGERPRINT_MISMATCH);
      }
      operationRepository.updatePayload(active.operationId, {
        barrierProof: canonicalBarrierProof,
        backupAuthorization: canonicalBackupAuthorization,
        legacyBackupReauthorization: {
          previewFingerprint: echoedPreview.previewFingerprint,
          requestDigest: canonicalConfirm.requestDigest,
        },
      });
      return runOperation(active.operationId);
    }
    const admissionKey = ownerKey(owner);
    confirmingOwners.set(admissionKey, (confirmingOwners.get(admissionKey) || 0) + 1);
    let created;
    try {
      created = await retryDatabaseBusy(() => operationRepository.beginOrReuse({
        preview: echoedPreview,
        confirm: canonicalConfirm,
        account,
        ownerIncarnation,
        identityLifecycle,
        barrierProof: canonicalBarrierProof,
        backupAuthorization: canonicalBackupAuthorization,
      }));
    } finally {
      const remaining = (confirmingOwners.get(admissionKey) || 1) - 1;
      if (remaining) confirmingOwners.set(admissionKey, remaining);
      else confirmingOwners.delete(admissionKey);
    }
    return runOperation(created.operation.operationId);
  }

  async function verifyClientCleanupAttempt(proof = {}) {
    const operation = operationRepository.getOperation(proof.operationId);
    if (!operation) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OPERATION_NOT_FOUND);
    if (operation.status === 'completed') return publicOperation(operation);
    if (operation.payload?.clientCleanupVerification?.verified === true) {
      // A previous attempt already authenticated/persisted the client proof.
      // Resume server verification rather than demanding a second challenge.
      const owner = operation.payload.confirm?.owner;
      if (!owner || !verifier.verifyClientProof(owner, operation, proof).ok) {
        failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.CLIENT_CLEANUP_PROOF_INVALID);
      }
      return runOperationAttempt(operation.operationId);
    }
    if (operation.phase !== 'external-delete-pending') {
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.CLIENT_CLEANUP_REQUIRED);
    }
    const { preview, confirm } = operation.payload || {};
    const clientVerification = verifier.verifyClientProof(confirm.owner, operation, proof);
    if (!clientVerification.ok) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.CLIENT_CLEANUP_PROOF_INVALID);
    try {
      operationRepository.updatePayload(operation.operationId, {
        clientCleanupVerification: {
          verified: true,
          resourceCount: clientVerification.observations.length,
        },
      });
      operationRepository.markPhase(operation.operationId, 'verifying');
      await runtimeCoordinator.quiesce(confirm.owner);
      const serverVerification = verifier.verifyServer(confirm.owner, preview, {
        scopeToken: shopStorageScopeToken(operation),
      });
      if (!serverVerification.ok) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.SERVER_VERIFY_FAILED);
      const operationBackupAudit = backupAudit(operationRepository.getOperation(operation.operationId));
      const completed = operationRepository.markCompleted(operation.operationId, {
        ...operation.deletionSummary,
        serverVerified: true,
        clientVerified: true,
        ...operationBackupAudit,
        clientResourceCount: clientVerification.observations.length,
      });
      completeRuntime(confirm.owner);
      return publicOperation(completed);
    } catch (error) {
      const completed = readCompletedOperation(operation.operationId);
      if (completed) {
        completeRuntime(confirm.owner);
        return publicOperation(completed);
      }
      recordFailureSafely(operation.operationId, operationErrorCode(error));
      throw error;
    } finally {
      await releaseTransientResources(confirm.owner);
    }
  }

  async function verifyClientCleanup(proof = {}) {
    const active = operationTasks.get(proof.operationId);
    if (active?.kind === 'verify') {
      const operation = operationRepository.getOperation(proof.operationId);
      if (operation?.status !== 'completed') {
        const owner = operation?.payload?.confirm?.owner;
        if (!owner || !verifier.verifyClientProof(owner, operation, proof).ok) {
          failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.CLIENT_CLEANUP_PROOF_INVALID);
        }
      }
      return active.promise;
    }
    if (active) {
      return active.promise.catch(() => undefined).then(() => verifyClientCleanup(proof));
    }
    return startOperationTask(proof.operationId, 'verify', () => verifyClientCleanupAttempt(proof));
  }

  async function reportClientFailure(input = {}) {
    const report = createAccountRemovalClientFailureDto(input);
    const result = await retryDatabaseBusy(() => operationRepository.recordClientFailure(report));
    return { ...publicOperation(result.operation), reported: result.reported };
  }

  function publicReadStatus(operation) {
    if (!operation) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OPERATION_NOT_FOUND);
    const metadata = publicOperation(operation);
    if (metadata.completed) return metadata;
    try {
      const hydrated = operationRepository.getOperation(operation.operationId);
      const result = publicOperation(hydrated);
      if (result?.completed || result?.pendingOwner) return result;
    } catch (error) {
      // A single legacy/corrupt encrypted payload must remain visible without
      // exposing its contents. Database/read failures still fail the request;
      // they must not masquerade as an empty list or permanently lost payload.
      if (error?.code !== 'ACCOUNT_REMOVAL_OPERATION_PAYLOAD_INVALID'
        && error?.message !== 'ACCOUNT_REMOVAL_OPERATION_PAYLOAD_INVALID') throw error;
    }
    return { ...metadata, recoveryUnavailable: true,
      error: { code: 'ACCOUNT_REMOVAL_RECOVERY_DATA_UNAVAILABLE' } };
  }

  function getStatus(operationId) {
    return publicReadStatus(operationRepository.getOperation(operationId, { includePayload: false }));
  }

  function listPending(rawOwner) {
    if (rawOwner !== undefined) {
      const owner = validateAccountRemovalOwner(rawOwner);
      const operation = operationRepository.findActiveByOwner(owner, { includePayload: false });
      return operation ? [publicReadStatus(operation)] : [];
    }
    return operationRepository.listPending().map(publicReadStatus);
  }

  async function recover(rawOwner) {
    const owner = validateAccountRemovalOwner(rawOwner);
    const operation = operationRepository.findActiveByOwner(owner);
    if (!operation) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OPERATION_NOT_FOUND);
    return runOperation(operation.operationId);
  }

  async function recoverDirect(rawOwner) {
    const owner = validateAccountRemovalOwner(rawOwner);
    const operation = operationRepository.findActiveByOwner(owner);
    if (!operation) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OPERATION_NOT_FOUND);
    return runOperation(operation.operationId, { directDelete: true });
  }

  function releaseOwnerFence(rawOwner) {
    const owner = validateAccountRemovalOwner(rawOwner);
    if (confirmingOwners.has(ownerKey(owner)) || operationRepository.findActiveByOwner(owner, { includePayload: false })) {
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_LOCKED);
    }
    return runtimeCoordinator.releaseOwner(owner);
  }

  function assertOwnerWritable(rawOwner, {
    requireExisting = false,
    allowCompletedTombstone = false,
  } = {}) {
    const owner = validateAccountRemovalOwner(rawOwner);
    if (operationRepository.hasActiveOwner(owner)) {
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_LOCKED);
    }
    const existingAccount = planner.findAccount(owner);
    const latestOperation = existingAccount
      ? null
      : operationRepository.findLatestByOwner(owner, { includePayload: false });
    if (
      !existingAccount
      && latestOperation?.status === 'completed'
      && allowCompletedTombstone !== true
    ) {
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_REBIND_REQUIRED);
    }
    if (requireExisting && !existingAccount) {
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_NOT_FOUND);
    }
    return owner;
  }

  function assertOwnerAccountSave(rawOwner, { allowRebind = false } = {}) {
    const owner = assertOwnerWritable(rawOwner, { allowCompletedTombstone: allowRebind });
    const existingAccount = planner.findAccount(owner);
    const latestOperation = operationRepository.findLatestByOwner(owner, { includePayload: false });
    const rebind = !existingAccount && latestOperation?.status === 'completed';
    if (rebind && allowRebind !== true) {
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_REBIND_REQUIRED);
    }
    return { owner, rebind };
  }

  return {
    assertOwnerWritable,
    assertOwnerAccountSave,
    confirm,
    getStatus,
    listPending,
    preparePreview,
    preview,
    recover,
    recoverDirect,
    releaseOwnerFence,
    reportClientFailure,
    runOperation,
    verifyClientCleanup,
  };
}
