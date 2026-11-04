import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createModelApiAccountRepository } from '../../db/repositories/modelApiAccountRepository.js';
import { createPurchaseAccountRepository } from '../../db/repositories/purchaseAccountRepository.js';
import { createAccountRemovalOperationRepository } from '../../db/repositories/accountRemovalOperationRepository.js';
import { ACCOUNT_REMOVAL_SAFETY_BARRIER_VERSION } from './accountRemovalContract.js';
import {
  ACCOUNT_REMOVAL_CONFIRMATION_CODE,
  createAccountRemovalOrchestrator as createAccountRemovalOrchestratorRuntime,
} from './accountRemovalOrchestrator.js';
import { createAccountRemovalPlanner } from './accountRemovalPlanner.js';
import { createAccountRemovalSqliteExecutor } from './accountRemovalSqliteExecutor.js';
import { createAccountRemovalVerifier } from './accountRemovalVerifier.js';
import { createAccountRemovalProductImageCleanup } from './accountRemovalProductImageCleanup.js';
import {
  getAccountRemovalClientBarrierIds,
  isAccountRemovalServerVerifiedClientResource,
} from './accountRemovalClientResources.js';
import {
  createDataBackupService,
  DATA_BACKUP_SKIP_CONFIRMATION_CODE,
} from '../../backup/dataBackupService.js';

process.env.LOCAL_API_SECRET ||= 'account-removal-orchestrator-test-secret';

function createAccountRemovalOrchestrator(options = {}) {
  return createAccountRemovalOrchestratorRuntime({
    ...options,
    dataBackupService: options.dataBackupService || {
      reviewAccountRemoval: () => ({ required: false, domains: [], totalRecords: 0 }),
      authorizeAccountRemoval: () => ({ outcome: 'not-required', dataFingerprint: null }),
    },
  });
}

function createRuntimeCoordinator({ failQuiesce = () => false } = {}) {
  return {
    observeResource: (owner, resourceId) => (
      owner?.ownerType === 'purchase_account' && resourceId === 'runtime:purchase-task-queue'
        ? { resourceId, state: 'absent' }
        : { resourceId, state: 'unobserved' }
    ),
    async quiesce() {
      if (failQuiesce()) throw new Error('ACCOUNT_REMOVAL_QUIESCE_TIMEOUT');
      return { ok: true };
    },
    verify: () => ({ ok: true, failures: [], status: {} }),
    releaseOwner: () => ({ ok: true }),
  };
}

function createConfirmEnvelope(preview, idempotencyKey) {
  const barrierIds = getAccountRemovalClientBarrierIds(preview.owner.ownerType).sort();
  return {
    preview,
    confirm: {
      version: preview.version,
      contractVersion: preview.version,
      owner: { ...preview.owner },
      requestedOwnerType: preview.requestedOwnerType,
      requestedOwnerId: preview.requestedOwnerId,
      requestedResourceIdsSemantics: preview.requestedResourceIdsSemantics,
      requestedResourceIds: [...preview.requestedResourceIds],
      catalogVersion: preview.catalogVersion,
      catalogFingerprint: preview.catalogFingerprint,
      resourceObservations: preview.resourceObservations.map((entry) => ({ ...entry })),
      snapshotFingerprint: preview.snapshotFingerprint,
      previewFingerprint: preview.previewFingerprint,
      idempotencyKey,
    },
    barrierProof: {
      version: ACCOUNT_REMOVAL_SAFETY_BARRIER_VERSION,
      owner: { ...preview.owner },
      previewFingerprint: preview.previewFingerprint,
      fencedResourceIds: [...barrierIds],
      drainedResourceIds: [...barrierIds],
    },
    confirmationCode: ACCOUNT_REMOVAL_CONFIRMATION_CODE,
  };
}

function createOzonBackupGateFixture({ onQuiesce, executeLocalDeletion, shopStorageLifecycle } = {}) {
  const db = createMigratedTestDb();
  const owner = { ownerType: 'ozon_shop', ownerId: 'shop-backup-gate' };
  const now = '2026-07-17T02:00:00.000Z';
  db.prepare(`
    INSERT INTO shops (
      id, name, status, shop_incarnation, created_at, updated_at
    ) VALUES (?, 'Backup Gate Shop', 'active', 'inc-backup-gate', ?, ?)
  `).run(owner.ownerId, now, now);
  db.prepare(`
    INSERT INTO purchase_order_overrides (
      id, shop_id, order_key, purchase_platform, purchase_order_number,
      created_at, updated_at
    ) VALUES ('backup-gate-override', ?, 'posting-backup-gate', 'pdd', 'PDD-GATE', ?, ?)
  `).run(owner.ownerId, now, now);

  const calls = { quiesce: 0, prepare: 0, execute: 0 };
  const runtimeCoordinator = {
    observeResource(_targetOwner, resourceId) {
      return { resourceId, state: 'absent' };
    },
    async quiesce() {
      calls.quiesce += 1;
      onQuiesce?.({ calls, db, owner });
      return { ok: true };
    },
    async quiesceOwnerWrites() {
      calls.prepare += 1;
      return { ok: true };
    },
    verify: () => ({ ok: true, failures: [], status: {} }),
    releaseOwner: () => ({ ok: true }),
  };
  const planner = createAccountRemovalPlanner({ db, runtimeCoordinator });
  const operationRepository = createAccountRemovalOperationRepository(db);
  const actualExecutor = createAccountRemovalSqliteExecutor({ db });
  const sqliteExecutor = {
    execute(targetOwner, options) {
      calls.execute += 1;
      if (typeof executeLocalDeletion === 'function') {
        return executeLocalDeletion({ actualExecutor, owner: targetOwner, options });
      }
      throw new Error('UNEXPECTED_ACCOUNT_REMOVAL_EXECUTOR_CALL');
    },
    completePhysicalErasure(execution) {
      if (typeof executeLocalDeletion === 'function') {
        return actualExecutor.completePhysicalErasure(execution);
      }
      throw new Error('UNEXPECTED_ACCOUNT_REMOVAL_ERASURE_CALL');
    },
  };
  const dataBackupService = createDataBackupService({
    db,
    decryptShopSecret: (value) => String(value).replace(/^encrypted:/u, ''),
    keysetStore: {
      readState: () => null,
      initialize: () => { throw new Error('UNEXPECTED_BACKUP_KEYSET_INITIALIZATION'); },
    },
  });
  const orchestrator = createAccountRemovalOrchestrator({
    planner,
    operationRepository,
    sqliteExecutor,
    verifier: {
      verifyServer: () => ({ ok: true }),
      verifyClientProof: () => ({ ok: true, observations: [] }),
    },
    runtimeCoordinator,
    dataBackupService,
    shopStorageLifecycle,
  });
  return { calls, db, operationRepository, orchestrator, owner };
}

test('prepared preview quiesces owner writes before taking the deletion fingerprint', async () => {
  const fixture = createOzonBackupGateFixture();
  try {
    const result = await fixture.orchestrator.preparePreview({ owner: fixture.owner });
    assert.equal(result.ok, true);
    assert.equal(result.preview.owner.ownerId, fixture.owner.ownerId);
    assert.equal(fixture.calls.prepare, 1);
    assert.equal(fixture.calls.quiesce, 0);
    assert.equal(fixture.calls.execute, 0);
  } finally {
    fixture.db.close();
  }
});

test('Ozon account removal retries remote image cleanup, then deletes only the selected shop metadata', async () => {
  const db = createMigratedTestDb();
  const now = '2026-08-03T00:00:00.000Z';
  try {
    for (const shopId of ['shop-image-a', 'shop-image-b']) {
      db.prepare(`
        INSERT INTO shops (id, name, status, shop_incarnation, created_at, updated_at)
        VALUES (?, ?, 'active', ?, ?, ?)
      `).run(shopId, shopId, `inc-${shopId}`, now, now);
    }
    const insertAsset = db.prepare(`
      INSERT INTO product_image_assets (
        id, tenant_id, user_id, shop_id, sha256, mime_type, byte_length,
        storage_scope, variant, source_type, object_key, status,
        reference_count, upload_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'image/png', 68, 'permanent', 'original',
                'account-removal-integration', ?, 'published', 1, 1, ?, ?)
    `);
    for (let index = 0; index < 8; index += 1) {
      insertAsset.run(
        `shop-a-image-${index}`,
        `tenant-${index % 2}`,
        `user-${index % 3}`,
        'shop-image-a',
        String(index).padStart(64, 'a'),
        `wangzai/assets/images/tenant-${index % 2}/shop-image-a/${index}.png`,
        now,
        now,
      );
    }
    for (let index = 0; index < 4; index += 1) {
      insertAsset.run(
        `shop-b-image-${index}`,
        'tenant-other',
        'user-other',
        'shop-image-b',
        String(index).padStart(64, 'b'),
        `wangzai/assets/images/tenant-other/shop-image-b/${index}.png`,
        now,
        now,
      );
    }

    let failRemote = true;
    const deletedKeys = [];
    const serverResourceCleanup = createAccountRemovalProductImageCleanup({
      db,
      objectStorage: {
        async deleteImage(objectKey) {
          if (failRemote && objectKey.endsWith('/3.png')) throw new Error('injected OSS failure');
          deletedKeys.push(objectKey);
        },
      },
      concurrency: 2,
      maxAttempts: 1,
    });
    const runtimeCoordinator = {
      observeResource: (_owner, resourceId) => ({ resourceId, state: 'absent' }),
      async quiesce() { return { ok: true }; },
      verify: () => ({ ok: true, failures: [], status: {} }),
      releaseOwner: () => ({ ok: true }),
    };
    const planner = createAccountRemovalPlanner({ db, runtimeCoordinator });
    const operationRepository = createAccountRemovalOperationRepository(db);
    const orchestrator = createAccountRemovalOrchestrator({
      planner,
      operationRepository,
      sqliteExecutor: createAccountRemovalSqliteExecutor({ db }),
      verifier: createAccountRemovalVerifier({ db, runtimeCoordinator }),
      runtimeCoordinator,
      serverResourceCleanup,
    });
    const { preview } = orchestrator.preview({ owner: { ownerType: 'ozon_shop', ownerId: 'shop-image-a' } });
    const envelope = createConfirmEnvelope(preview, 'image-cleanup-retry-key');
    await assert.rejects(orchestrator.confirm(envelope), { code: 'ACCOUNT_REMOVAL_REMOTE_OBJECT_DELETE_FAILED' });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shops WHERE id = ?').get('shop-image-a').count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM product_image_assets WHERE shop_id = ?').get('shop-image-a').count, 8);

    failRemote = false;
    const recovered = await orchestrator.recover({ ownerType: 'ozon_shop', ownerId: 'shop-image-a' });
    assert.equal(recovered.phase, 'external-delete-pending');
    assert.deepEqual(recovered.deletionSummary.remoteObjectStorage, {
      completed: true,
      candidates: 8,
      deleted: 8,
      retries: 0,
    });
    assert.equal(recovered.deletionSummary.deletedRows['registry:product-image-assets'], 8);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM product_image_assets WHERE shop_id = ?').get('shop-image-a').count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM product_image_assets WHERE shop_id = ?').get('shop-image-b').count, 4);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shops WHERE id = ?').get('shop-image-b').count, 1);
    assert.equal(deletedKeys.some((key) => key.includes('/shop-image-b/')), false);
  } finally {
    db.close();
  }
});

function createClientCleanupProof(operation, preview) {
  return {
    operationId: operation.operationId,
    nonce: operation.clientCleanup.nonce,
    previewFingerprint: preview.previewFingerprint,
    resourceObservations: operation.clientCleanup.resourceIds
      .map((resourceId) => ({ resourceId, state: 'absent' })),
  };
}

function recordTrustedReceipts(operationRepository, operation) {
  for (const resourceId of operation.clientCleanup?.resourceIds || []) {
    if (isAccountRemovalServerVerifiedClientResource(operation.ownerType, resourceId)) {
      operationRepository.recordTrustedClientResourceReceipt(operation.operationId, resourceId);
    }
  }
}

async function finishPendingClientCleanup(orchestrator, operationRepository, operation, preview) {
  if (!operation.requiresClientCleanup) return operation;
  recordTrustedReceipts(operationRepository, operation);
  return orchestrator.verifyClientCleanup(createClientCleanupProof(operation, preview));
}

function createPurchaseFixture(failureStage) {
  const db = createMigratedTestDb();
  const owner = { ownerType: 'purchase_account', ownerId: `purchase_retry_${failureStage}` };
  createPurchaseAccountRepository(db).saveAccount({
    id: owner.ownerId,
    name: `Retry ${failureStage}`,
    loginPassword: `secret-${failureStage}`,
  });
  let failureEnabled = true;
  const runtimeCoordinator = createRuntimeCoordinator({
    failQuiesce: () => failureStage === 'quiesce' && failureEnabled,
  });
  const planner = createAccountRemovalPlanner({ db, runtimeCoordinator });
  const operationRepository = createAccountRemovalOperationRepository(db);
  const actualExecutor = createAccountRemovalSqliteExecutor({ db });
  const sqliteExecutor = {
    ...actualExecutor,
      execute(targetOwner, options) {
        if (failureStage === 'execute' && failureEnabled) {
          throw new Error('ACCOUNT_REMOVAL_INJECTED_SQLITE_FAILURE');
        }
        return actualExecutor.execute(targetOwner, options);
    },
  };
  const actualVerifier = createAccountRemovalVerifier({ db, runtimeCoordinator });
  const verifier = {
    ...actualVerifier,
    verifyServer(targetOwner, preview) {
      if (failureStage === 'verify' && failureEnabled) {
        return { ok: false, failures: ['injected-server-readback'], observations: [] };
      }
      return actualVerifier.verifyServer(targetOwner, preview);
    },
  };
  const createOrchestrator = ({ good = false, dataBackupService } = {}) => createAccountRemovalOrchestrator({
    planner,
    operationRepository,
    sqliteExecutor: good ? actualExecutor : sqliteExecutor,
    verifier: good ? actualVerifier : verifier,
    runtimeCoordinator,
    ...(dataBackupService ? { dataBackupService } : {}),
  });
  return {
    db,
    owner,
    operationRepository,
    createOrchestrator,
    disableFailure() { failureEnabled = false; },
  };
}

test('transient SQLite writer locks are retried automatically before deleting the account', async () => {
  const db = createMigratedTestDb();
  try {
    const owner = { ownerType: 'purchase_account', ownerId: 'purchase_busy_retry' };
    createPurchaseAccountRepository(db).saveAccount({
      id: owner.ownerId,
      name: 'Busy retry',
      loginPassword: 'busy-retry-secret',
    });
    const runtimeCoordinator = createRuntimeCoordinator();
    const planner = createAccountRemovalPlanner({ db, runtimeCoordinator });
    const operationRepository = createAccountRemovalOperationRepository(db);
    const actualExecutor = createAccountRemovalSqliteExecutor({ db });
    const verifier = createAccountRemovalVerifier({ db, runtimeCoordinator });
    const retryDelays = [];
    let attempts = 0;
    const orchestrator = createAccountRemovalOrchestrator({
      planner,
      operationRepository,
      sqliteExecutor: {
        ...actualExecutor,
        execute(targetOwner, options) {
          attempts += 1;
          if (attempts < 3) {
            const error = new Error('database is locked');
            error.code = 'SQLITE_BUSY';
            throw error;
          }
          return actualExecutor.execute(targetOwner, options);
        },
      },
      verifier,
      runtimeCoordinator,
      wait: async (delayMs) => { retryDelays.push(delayMs); },
    });
    const { preview } = orchestrator.preview({ owner });
    const pending = await orchestrator.confirm(createConfirmEnvelope(
      preview,
      'account-removal-busy-retry-01',
    ));
    assert.equal(pending.phase, 'external-delete-pending');
    assert.equal(attempts, 3);
    assert.deepEqual(retryDelays, [250, 500]);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM purchase_accounts WHERE id = ?').get(owner.ownerId).count,
      0,
    );
    assert.equal(
      operationRepository.getOperation(pending.operationId).payload.deletionExecution.verificationMode,
      'locked-preservation-snapshot-and-target-readback',
    );
  } finally {
    db.close();
  }
});

test('backup authorization failures are rejected before account-removal quiesce or SQLite execution', async (t) => {
  for (const scenario of [
    {
      name: 'missing',
      expectedCode: 'ACCOUNT_REMOVAL_BACKUP_REVIEW_REQUIRED',
      authorization: () => undefined,
    },
    {
      name: 'stale',
      expectedCode: 'ACCOUNT_REMOVAL_BACKUP_STALE',
      authorization: ({ preview }) => ({
        outcome: 'recent-verified',
        backupId: 'data_backup_stale_authorization',
        previewFingerprint: preview.previewFingerprint,
        dataFingerprint: '0'.repeat(64),
      }),
    },
    {
      name: 'wrong-export',
      expectedCode: 'ACCOUNT_REMOVAL_BACKUP_NOT_VERIFIED',
      authorization: ({ preview, backupReview }) => ({
        outcome: 'exported',
        backupId: 'data_backup_does_not_exist',
        previewFingerprint: preview.previewFingerprint,
        dataFingerprint: backupReview.dataFingerprint,
      }),
    },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = createOzonBackupGateFixture();
      try {
        const previewResult = fixture.orchestrator.preview({ owner: fixture.owner });
        assert.equal(previewResult.backupReview.required, true);
        const request = createConfirmEnvelope(
          previewResult.preview,
          `account-removal-backup-gate-${scenario.name}-01`,
        );
        request.backupAuthorization = scenario.authorization(previewResult);
        await assert.rejects(
          fixture.orchestrator.confirm(request),
          new RegExp(scenario.expectedCode, 'u'),
        );
        assert.deepEqual(fixture.calls, { quiesce: 0, prepare: 0, execute: 0 });
        assert.deepEqual(fixture.operationRepository.listPending(), []);
      } finally {
        fixture.db.close();
      }
    });
  }
});

test('backup authorization is rechecked after quiesce and before the first local deletion', async () => {
  let injected = false;
  const fixture = createOzonBackupGateFixture({
    onQuiesce({ db, owner }) {
      if (injected) return;
      injected = true;
      const timestamp = '2026-07-17T02:00:01.000Z';
      db.prepare(`
        INSERT INTO purchase_order_overrides (
          id, shop_id, order_key, purchase_platform, purchase_order_number,
          created_at, updated_at
        ) VALUES ('backup-gate-concurrent-override', ?, 'posting-concurrent',
          'pdd', 'PDD-CONCURRENT', ?, ?)
      `).run(owner.ownerId, timestamp, timestamp);
    },
  });
  try {
    const previewResult = fixture.orchestrator.preview({ owner: fixture.owner });
    const request = createConfirmEnvelope(
      previewResult.preview,
      'account-removal-backup-gate-toctou-01',
    );
    request.backupAuthorization = {
      outcome: 'explicitly-skipped',
      previewFingerprint: previewResult.preview.previewFingerprint,
      dataFingerprint: previewResult.backupReview.dataFingerprint,
      skipConfirmationCode: DATA_BACKUP_SKIP_CONFIRMATION_CODE,
    };

    await assert.rejects(
      fixture.orchestrator.confirm(request),
      /ACCOUNT_REMOVAL_BACKUP_STALE/u,
    );
    assert.deepEqual(fixture.calls, { quiesce: 1, prepare: 0, execute: 0 });
    const pending = fixture.operationRepository.findActiveByOwner(fixture.owner);
    assert.equal(pending.lastErrorCode, 'ACCOUNT_REMOVAL_BACKUP_STALE');
    assert.equal(pending.payload.deletionExecution, undefined);
    assert.equal(
      fixture.db.prepare(`
        SELECT COUNT(*) AS count FROM purchase_order_overrides
        WHERE id = 'backup-gate-concurrent-override'
      `).get().count,
      1,
    );
    assert.equal(
      fixture.db.prepare('SELECT COUNT(*) AS count FROM shops WHERE id = ?')
        .get(fixture.owner.ownerId).count,
      1,
    );
  } finally {
    fixture.db.close();
  }
});

test('Ozon account removal durably backs up and deletes only its independent shop cache', async () => {
  const shopStorageCalls = [];
  const fixture = createOzonBackupGateFixture({
    executeLocalDeletion({ actualExecutor, owner, options }) {
      return actualExecutor.execute(owner, options);
    },
    shopStorageLifecycle: {
      async deleteWithBackup(input) {
        shopStorageCalls.push(input.scopeToken);
        const backup = {
          scopeDigest: 'a'.repeat(64),
          backupPath: 'private-shop-cache-backup.sqlite',
          backupSha256: 'b'.repeat(64),
          byteSize: 4096,
          sourceFingerprint: 'c'.repeat(64),
        };
        await input.onBackup(backup);
        return {
          deleted: true,
          alreadyAbsent: false,
          preview: { layout: { scopeDigest: backup.scopeDigest } },
          backup,
        };
      },
    },
  });
  try {
    const previewResult = fixture.orchestrator.preview({ owner: fixture.owner });
    const request = createConfirmEnvelope(
      previewResult.preview,
      'account-removal-independent-shop-cache-01',
    );
    request.backupAuthorization = {
      outcome: 'explicitly-skipped',
      previewFingerprint: previewResult.preview.previewFingerprint,
      dataFingerprint: previewResult.backupReview.dataFingerprint,
      skipConfirmationCode: DATA_BACKUP_SKIP_CONFIRMATION_CODE,
    };
    const result = await fixture.orchestrator.confirm(request);
    assert.equal(result.phase, 'external-delete-pending');
    assert.equal(shopStorageCalls.length, 1);
    assert.deepEqual(shopStorageCalls[0], {
      profileId: 'default',
      shopId: fixture.owner.ownerId,
      shopIncarnation: 'inc-backup-gate',
      credentialRevision: 1,
    });
    assert.equal(result.deletionSummary.shopStorage.deleted, true);
    assert.equal(result.deletionSummary.shopStorage.backupCreated, true);
    assert.equal(JSON.stringify(result).includes('private-shop-cache-backup.sqlite'), false);
    const durable = fixture.operationRepository.getOperation(result.operationId);
    assert.equal(durable.payload.shopStorageBackup.backupPath, 'private-shop-cache-backup.sqlite');
    assert.equal(durable.payload.shopStorageDeletion.deleted, true);
  } finally {
    fixture.db.close();
  }
});

test('direct recovery replaces a stale backup authorization and deletes the account without another backup prompt', async () => {
  let failExecution = true;
  const fixture = createOzonBackupGateFixture({
    executeLocalDeletion({ actualExecutor, owner, options }) {
      if (failExecution) {
        const error = new Error('ACCOUNT_REMOVAL_EXECUTION_FAILED');
        error.code = 'ACCOUNT_REMOVAL_EXECUTION_FAILED';
        throw error;
      }
      return actualExecutor.execute(owner, options);
    },
  });
  try {
    const previewResult = fixture.orchestrator.preview({ owner: fixture.owner });
    const request = createConfirmEnvelope(
      previewResult.preview,
      'account-removal-direct-recovery-stale-backup-01',
    );
    request.backupAuthorization = {
      outcome: 'explicitly-skipped',
      previewFingerprint: previewResult.preview.previewFingerprint,
      dataFingerprint: previewResult.backupReview.dataFingerprint,
      skipConfirmationCode: DATA_BACKUP_SKIP_CONFIRMATION_CODE,
    };
    await assert.rejects(
      fixture.orchestrator.confirm(request),
      /ACCOUNT_REMOVAL_EXECUTION_FAILED/u,
    );

    const timestamp = '2026-07-17T02:00:02.000Z';
    fixture.db.prepare(`
      INSERT INTO purchase_order_overrides (
        id, shop_id, order_key, purchase_platform, purchase_order_number,
        created_at, updated_at
      ) VALUES ('backup-gate-direct-new', ?, 'posting-direct-new',
        'pdd', 'PDD-DIRECT-NEW', ?, ?)
    `).run(fixture.owner.ownerId, timestamp, timestamp);
    failExecution = false;

    await assert.rejects(
      fixture.orchestrator.recover(fixture.owner),
      /ACCOUNT_REMOVAL_BACKUP_STALE/u,
    );
    const pending = await fixture.orchestrator.recoverDirect(fixture.owner);
    assert.equal(pending.phase, 'external-delete-pending');
    assert.equal(pending.requiresClientCleanup, true);
    const durable = fixture.operationRepository.getOperation(pending.operationId);
    assert.equal(durable.payload.backupAuthorization.outcome, 'explicitly-skipped');
    assert.equal(durable.payload.directDelete.backupPromptRequired, false);
    assert.notEqual(
      durable.payload.backupAuthorization.dataFingerprint,
      previewResult.backupReview.dataFingerprint,
    );
    assert.equal(
      fixture.db.prepare('SELECT COUNT(*) AS count FROM shops WHERE id = ?')
        .get(fixture.owner.ownerId).count,
      0,
    );
    assert.equal(
      fixture.db.prepare('SELECT COUNT(*) AS count FROM purchase_order_overrides WHERE shop_id = ?')
        .get(fixture.owner.ownerId).count,
      0,
    );

    const completed = await finishPendingClientCleanup(
      fixture.orchestrator,
      fixture.operationRepository,
      pending,
      previewResult.preview,
    );
    assert.equal(completed.completed, true);
    assert.equal(completed.deletionSummary.backupOutcome, 'explicitly-skipped');
  } finally {
    fixture.db.close();
  }
});

test('legacy pending operations without local deletion must pass the current backup gate before resuming', async () => {
  const fixture = createPurchaseFixture('quiesce');
  try {
    const first = fixture.createOrchestrator();
    const { preview } = first.preview({ owner: fixture.owner });
    await assert.rejects(
      first.confirm(createConfirmEnvelope(preview, 'account-removal-legacy-pre-delete-01')),
      /ACCOUNT_REMOVAL_QUIESCE_TIMEOUT/u,
    );
    const original = fixture.operationRepository.findActiveByOwner(fixture.owner);
    fixture.operationRepository.updatePayload(original.operationId, { backupAuthorization: null });
    fixture.disableFailure();

    const reconstructed = fixture.createOrchestrator({ good: true });
    await assert.rejects(
      reconstructed.recover(fixture.owner),
      /ACCOUNT_REMOVAL_BACKUP_REVIEW_REQUIRED/u,
    );
    const blocked = fixture.operationRepository.getOperation(original.operationId);
    assert.equal(blocked.attemptCount, original.attemptCount);
    assert.equal(blocked.lastErrorCode, 'ACCOUNT_REMOVAL_BACKUP_REVIEW_REQUIRED');
    assert.equal(blocked.payload.deletionExecution, undefined);
    assert.equal(
      fixture.db.prepare('SELECT COUNT(*) AS count FROM purchase_accounts WHERE id = ?')
        .get(fixture.owner.ownerId).count,
      1,
    );

    const refreshed = reconstructed.preview({ owner: fixture.owner });
    const pending = await reconstructed.confirm(createConfirmEnvelope(
      refreshed.preview,
      'account-removal-legacy-pre-delete-reauthorized-01',
    ));
    assert.equal(pending.operationId, original.operationId);
    const rebound = fixture.operationRepository.getOperation(original.operationId);
    assert.equal(rebound.payload.backupAuthorization.outcome, 'not-required');
    assert.equal(
      rebound.payload.legacyBackupReauthorization.previewFingerprint,
      refreshed.preview.previewFingerprint,
    );
    const completed = await finishPendingClientCleanup(
      reconstructed,
      fixture.operationRepository,
      pending,
      refreshed.preview,
    );
    assert.equal(completed.completed, true);
    assert.equal(completed.deletionSummary.backupOutcome, 'not-required');
  } finally {
    fixture.db.close();
  }
});

test('legacy operations that already deleted local data remain recoverable and are audited as unprotected', async () => {
  const fixture = createPurchaseFixture('verify');
  try {
    const first = fixture.createOrchestrator();
    const { preview } = first.preview({ owner: fixture.owner });
    const pending = await first.confirm(createConfirmEnvelope(
      preview,
      'account-removal-legacy-post-delete-01',
    ));
    assert.equal(pending.phase, 'external-delete-pending');
    fixture.operationRepository.updatePayload(pending.operationId, { backupAuthorization: null });
    fixture.disableFailure();

    let reauthorizationCalls = 0;
    const reconstructed = fixture.createOrchestrator({
      good: true,
      dataBackupService: {
        reviewAccountRemoval: () => ({ required: true }),
        authorizeAccountRemoval() {
          reauthorizationCalls += 1;
          throw new Error('UNEXPECTED_POST_DELETE_BACKUP_REAUTHORIZATION');
        },
      },
    });
    const recovered = await reconstructed.recover(fixture.owner);
    assert.equal(recovered.operationId, pending.operationId);
    assert.equal(recovered.requiresClientCleanup, true);
    assert.equal(recovered.deletionSummary.backupOutcome, 'legacy-unprotected');
    assert.deepEqual(recovered.deletionSummary.backupSummary, {
      outcome: 'legacy-unprotected',
      protectedByBackupGate: false,
      reason: 'legacy-operation-local-deletion-already-started',
    });

    const completed = await finishPendingClientCleanup(
      reconstructed,
      fixture.operationRepository,
      recovered,
      preview,
    );
    assert.equal(completed.completed, true);
    assert.equal(completed.deletionSummary.backupOutcome, 'legacy-unprotected');
    assert.equal(completed.deletionSummary.backupSummary.protectedByBackupGate, false);
    assert.equal(reauthorizationCalls, 0);
  } finally {
    fixture.db.close();
  }
});

test('quiesce, transaction, and server-readback failures remain retryable and resume after reconstruction', async (t) => {
  for (const failureStage of ['quiesce', 'execute', 'verify']) {
    await t.test(failureStage, async () => {
      const fixture = createPurchaseFixture(failureStage);
      try {
        const failing = fixture.createOrchestrator();
        const { preview } = failing.preview({ owner: fixture.owner });
        if (failureStage === 'verify') {
          const pending = await failing.confirm(createConfirmEnvelope(preview, `account-removal-retry-${failureStage}-01`));
          recordTrustedReceipts(fixture.operationRepository, pending);
          await assert.rejects(
            failing.verifyClientCleanup(createClientCleanupProof(pending, preview)),
            /ACCOUNT_REMOVAL_/u,
          );
        } else {
          await assert.rejects(
            failing.confirm(createConfirmEnvelope(preview, `account-removal-retry-${failureStage}-01`)),
            /ACCOUNT_REMOVAL_/u,
          );
        }
        const failedOperation = fixture.operationRepository.findActiveByOwner(fixture.owner);
        assert.equal(failedOperation.status, 'retryable-failed');
        assert.equal(failedOperation.completedAt, null);
        if (failureStage === 'verify') {
          assert.equal(
            fixture.db.prepare('SELECT COUNT(*) AS count FROM purchase_accounts WHERE id = ?').get(fixture.owner.ownerId).count,
            0,
          );
          assert.ok(failedOperation.payload.deletionExecution);
        } else {
          assert.equal(
            fixture.db.prepare('SELECT COUNT(*) AS count FROM purchase_accounts WHERE id = ?').get(fixture.owner.ownerId).count,
            1,
          );
        }

        fixture.disableFailure();
        const reconstructed = fixture.createOrchestrator({ good: true });
        const resumed = await reconstructed.recover(fixture.owner);
        const completed = await finishPendingClientCleanup(reconstructed, fixture.operationRepository, resumed, preview);
        assert.equal(completed.completed, true);
        assert.equal(completed.phase, 'completed');
        assert.ok(completed.attemptCount >= 2);
        assert.equal(
          fixture.db.prepare('SELECT COUNT(*) AS count FROM purchase_accounts WHERE id = ?').get(fixture.owner.ownerId).count,
          0,
        );
      } finally {
        fixture.db.close();
      }
    });
  }
});

test('retry recovery never moves a durable operation phase backward', async () => {
  const fixture = createPurchaseFixture('verify');
  try {
    const baseRepository = fixture.operationRepository;
    const phases = [];
    const operationRepository = {
      ...baseRepository,
      markPhase(operationId, phase, options) {
        phases.push(phase);
        return baseRepository.markPhase(operationId, phase, options);
      },
      markCompleted(operationId, summary) {
        phases.push('completed');
        return baseRepository.markCompleted(operationId, summary);
      },
    };
    const planner = createAccountRemovalPlanner({
      db: fixture.db,
      runtimeCoordinator: createRuntimeCoordinator(),
    });
    const actualExecutor = createAccountRemovalSqliteExecutor({ db: fixture.db });
    let verifyFails = true;
    const actualVerifier = createAccountRemovalVerifier({
      db: fixture.db,
      runtimeCoordinator: createRuntimeCoordinator(),
    });
    const orchestrator = createAccountRemovalOrchestrator({
      planner,
      operationRepository,
      sqliteExecutor: actualExecutor,
      verifier: {
        ...actualVerifier,
        verifyServer(owner, preview) {
          return verifyFails
            ? { ok: false, failures: ['injected-server-readback'], observations: [] }
            : actualVerifier.verifyServer(owner, preview);
        },
      },
      runtimeCoordinator: createRuntimeCoordinator(),
    });
    const { preview } = orchestrator.preview({ owner: fixture.owner });
    const pending = await orchestrator.confirm(createConfirmEnvelope(preview, 'account-removal-monotonic-retry-01'));
    recordTrustedReceipts(baseRepository, pending);
    await assert.rejects(
      orchestrator.verifyClientCleanup(createClientCleanupProof(pending, preview)),
      /ACCOUNT_REMOVAL_SERVER_VERIFY_FAILED/u,
    );
    verifyFails = false;
    const completed = await orchestrator.recover(fixture.owner);
    assert.equal(completed.completed, true);
    const ranks = new Map([
      'confirmed', 'quiescing', 'local-delete-pending', 'external-delete-pending', 'verifying', 'completed',
    ].map((phase, index) => [phase, index]));
    assert.ok(phases.every((phase, index) => index === 0 || ranks.get(phase) >= ranks.get(phases[index - 1])));
    assert.deepEqual(phases, [
      'quiescing',
      'local-delete-pending',
      'external-delete-pending',
      'verifying',
      'verifying',
      'verifying',
      'completed',
    ]);
  } finally {
    fixture.db.close();
  }
});

test('client cleanup proof is rejected until the durable operation reaches external-delete-pending', async () => {
  const fixture = createPurchaseFixture('execute');
  try {
    const orchestrator = fixture.createOrchestrator();
    const { preview } = orchestrator.preview({ owner: fixture.owner });
    await assert.rejects(
      orchestrator.confirm(createConfirmEnvelope(preview, 'account-removal-early-client-proof-01')),
      /ACCOUNT_REMOVAL_INJECTED_SQLITE_FAILURE/u,
    );
    const interrupted = fixture.operationRepository.findActiveByOwner(fixture.owner);
    for (const resourceId of interrupted.clientResourceIds) {
      if (isAccountRemovalServerVerifiedClientResource(interrupted.ownerType, resourceId)) {
        fixture.operationRepository.recordTrustedClientResourceReceipt(interrupted.operationId, resourceId);
      }
    }
    await assert.rejects(
      orchestrator.verifyClientCleanup({
        operationId: interrupted.operationId,
        nonce: interrupted.clientCleanupNonce,
        previewFingerprint: interrupted.previewFingerprint,
        resourceObservations: interrupted.clientResourceIds.map((resourceId) => ({ resourceId, state: 'absent' })),
      }),
      /ACCOUNT_REMOVAL_CLIENT_CLEANUP_REQUIRED/u,
    );
    const unchanged = fixture.operationRepository.getOperation(interrupted.operationId);
    assert.equal(unchanged.phase, 'local-delete-pending');
    assert.equal(unchanged.payload.clientCleanupVerification, undefined);
    assert.equal(
      fixture.db.prepare('SELECT COUNT(*) AS count FROM purchase_accounts WHERE id = ?').get(fixture.owner.ownerId).count,
      1,
    );
  } finally {
    fixture.db.close();
  }
});

test('client readback persists its proof and recover completes without another challenge or local deletion', async () => {
  const db = createMigratedTestDb();
  try {
    const owner = { ownerType: 'model_api_account', ownerId: 'model_client_retry' };
    createModelApiAccountRepository(db).saveAccount({
      id: owner.ownerId,
      apiAlias: 'Client retry',
      apiKey: 'client-retry-secret',
    });
    const runtimeCoordinator = createRuntimeCoordinator();
    const planner = createAccountRemovalPlanner({ db, runtimeCoordinator });
    const operationRepository = createAccountRemovalOperationRepository(db);
    const actualSqliteExecutor = createAccountRemovalSqliteExecutor({ db });
    let deletionCount = 0;
    const sqliteExecutor = {
      ...actualSqliteExecutor,
      execute(targetOwner, options) {
        deletionCount += 1;
        return actualSqliteExecutor.execute(targetOwner, options);
      },
    };
    const actualVerifier = createAccountRemovalVerifier({ db, runtimeCoordinator });
    let failServerReadback = true;
    const failingVerifier = {
      ...actualVerifier,
      verifyServer(targetOwner, preview) {
        return failServerReadback
          ? { ok: false, failures: ['injected-client-stage-server-readback'], observations: [] }
          : actualVerifier.verifyServer(targetOwner, preview);
      },
    };
    const createWithVerifier = (verifier) => createAccountRemovalOrchestrator({
      planner,
      operationRepository,
      sqliteExecutor,
      verifier,
      runtimeCoordinator,
    });
    const first = createWithVerifier(failingVerifier);
    const { preview } = first.preview({ owner });
    const pending = await first.confirm(createConfirmEnvelope(preview, 'account-removal-client-retry-01'));
    assert.equal(pending.phase, 'external-delete-pending');
    assert.equal(pending.requiresClientCleanup, true);
    const proof = {
      operationId: pending.operationId,
      nonce: pending.clientCleanup.nonce,
      previewFingerprint: preview.previewFingerprint,
      resourceObservations: pending.clientCleanup.resourceIds.map((resourceId) => ({ resourceId, state: 'absent' })),
    };
    recordTrustedReceipts(operationRepository, pending);
    await assert.rejects(first.verifyClientCleanup(proof), /ACCOUNT_REMOVAL_SERVER_VERIFY_FAILED/u);
    const failed = operationRepository.getOperation(pending.operationId);
    assert.equal(failed.status, 'retryable-failed');
    assert.equal(failed.phase, 'verifying');
    assert.ok(failed.payload.deletionExecution);

    failServerReadback = false;
    const reconstructed = createWithVerifier(actualVerifier);
    const completed = await reconstructed.recover(owner);
    assert.equal(completed.completed, true);
    assert.equal(completed.requiresClientCleanup, false);
    assert.equal(deletionCount, 1);
    assert.equal(completed.deletionSummary.clientVerified, true);
    assert.equal(completed.deletionSummary.serverVerified, true);
  } finally {
    db.close();
  }
});

test('SQLite commit and deletion counts recover atomically when persistence is interrupted before physical readback is stored', async () => {
  const db = createMigratedTestDb();
  try {
    const owner = { ownerType: 'purchase_account', ownerId: 'purchase_sqlite_commit_crash' };
    createPurchaseAccountRepository(db).saveAccount({
      id: owner.ownerId,
      name: 'SQLite commit crash',
      loginPassword: 'sqlite-commit-crash-secret',
    });
    const runtimeCoordinator = createRuntimeCoordinator();
    const planner = createAccountRemovalPlanner({ db, runtimeCoordinator });
    const baseRepository = createAccountRemovalOperationRepository(db);
    let deletionPayloadWrites = 0;
    const interruptedRepository = {
      ...baseRepository,
      updatePayload(operationId, patch) {
        if (patch?.deletionExecution) {
          deletionPayloadWrites += 1;
          if (deletionPayloadWrites === 2) {
            throw new Error('ACCOUNT_REMOVAL_INJECTED_CRASH_AFTER_SQLITE_COMMIT');
          }
        }
        return baseRepository.updatePayload(operationId, patch);
      },
    };
    const actualSqliteExecutor = createAccountRemovalSqliteExecutor({ db });
    let deletionCount = 0;
    const sqliteExecutor = {
      ...actualSqliteExecutor,
      execute(targetOwner, options) {
        deletionCount += 1;
        return actualSqliteExecutor.execute(targetOwner, options);
      },
    };
    const verifier = createAccountRemovalVerifier({ db, runtimeCoordinator });
    const first = createAccountRemovalOrchestrator({
      planner,
      operationRepository: interruptedRepository,
      sqliteExecutor,
      verifier,
      runtimeCoordinator,
    });
    const { preview } = first.preview({ owner });
    await assert.rejects(
      first.confirm(createConfirmEnvelope(preview, 'account-removal-sqlite-commit-crash-01')),
      /ACCOUNT_REMOVAL_INJECTED_CRASH_AFTER_SQLITE_COMMIT/u,
    );

    const interrupted = baseRepository.findActiveByOwner(owner);
    assert.equal(interrupted.status, 'retryable-failed');
    assert.equal(interrupted.phase, 'local-delete-pending');
    assert.equal(interrupted.payload.deletionExecution.deletedRows['registry:purchase-accounts'], 1);
    assert.equal(interrupted.payload.deletionExecution.totalDeletedRows, 1);
    assert.equal(interrupted.payload.deletionExecution.physicalStorage, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM purchase_accounts WHERE id = ?').get(owner.ownerId).count, 0);
    assert.equal(deletionCount, 1);

    const reconstructed = createAccountRemovalOrchestrator({
      planner,
      operationRepository: baseRepository,
      sqliteExecutor,
      verifier,
      runtimeCoordinator,
    });
    const resumed = await reconstructed.recover(owner);
    const completed = await finishPendingClientCleanup(reconstructed, baseRepository, resumed, preview);
    assert.equal(completed.completed, true);
    assert.equal(completed.deletionSummary.deletedRows['registry:purchase-accounts'], 1);
    assert.equal(completed.deletionSummary.totalDeletedRows, 1);
    assert.equal(completed.deletionSummary.physicalStorage.secureDelete, true);
    assert.equal(completed.deletionSummary.physicalStorage.checkpoint.busy, 0);
    assert.equal(deletionCount, 1);
  } finally {
    db.close();
  }
});

test('recover resumes when a crash happens after client proof persistence but before the verifying phase', async () => {
  const db = createMigratedTestDb();
  try {
    const owner = { ownerType: 'model_api_account', ownerId: 'model_client_proof_crash' };
    createModelApiAccountRepository(db).saveAccount({
      id: owner.ownerId,
      apiAlias: 'Client proof crash',
      apiKey: 'client-proof-crash-secret',
    });
    const runtimeCoordinator = createRuntimeCoordinator();
    const planner = createAccountRemovalPlanner({ db, runtimeCoordinator });
    const baseRepository = createAccountRemovalOperationRepository(db);
    let crashBeforeVerifying = true;
    const crashingRepository = {
      ...baseRepository,
      markPhase(operationId, phase, options) {
        if (phase === 'verifying' && crashBeforeVerifying) {
          crashBeforeVerifying = false;
          throw new Error('ACCOUNT_REMOVAL_INJECTED_CRASH_AFTER_CLIENT_PROOF');
        }
        return baseRepository.markPhase(operationId, phase, options);
      },
    };
    const actualSqliteExecutor = createAccountRemovalSqliteExecutor({ db });
    let deletionCount = 0;
    const sqliteExecutor = {
      ...actualSqliteExecutor,
      execute(targetOwner, options) {
        deletionCount += 1;
        return actualSqliteExecutor.execute(targetOwner, options);
      },
    };
    const verifier = createAccountRemovalVerifier({ db, runtimeCoordinator });
    const first = createAccountRemovalOrchestrator({
      planner,
      operationRepository: crashingRepository,
      sqliteExecutor,
      verifier,
      runtimeCoordinator,
    });
    const { preview } = first.preview({ owner });
    const pending = await first.confirm(createConfirmEnvelope(preview, 'account-removal-client-proof-crash-01'));
    recordTrustedReceipts(baseRepository, pending);
    await assert.rejects(
      first.verifyClientCleanup(createClientCleanupProof(pending, preview)),
      /ACCOUNT_REMOVAL_INJECTED_CRASH_AFTER_CLIENT_PROOF/u,
    );

    const interrupted = baseRepository.getOperation(pending.operationId);
    assert.equal(interrupted.status, 'retryable-failed');
    assert.equal(interrupted.phase, 'external-delete-pending');
    assert.equal(interrupted.payload.clientCleanupVerification.verified, true);
    assert.equal(deletionCount, 1);

    const reconstructed = createAccountRemovalOrchestrator({
      planner,
      operationRepository: baseRepository,
      sqliteExecutor,
      verifier,
      runtimeCoordinator,
    });
    const completed = await reconstructed.recover(owner);
    assert.equal(completed.completed, true);
    assert.equal(completed.phase, 'completed');
    assert.equal(completed.requiresClientCleanup, false);
    assert.equal(completed.deletionSummary.clientVerified, true);
    assert.equal(completed.deletionSummary.serverVerified, true);
    assert.equal(deletionCount, 1);
  } finally {
    db.close();
  }
});

test('successful operations follow the required phase order and never move backward', async () => {
  const db = createMigratedTestDb();
  try {
    const owner = { ownerType: 'purchase_account', ownerId: 'purchase_phase_order' };
    createPurchaseAccountRepository(db).saveAccount({ id: owner.ownerId, name: 'Phase order' });
    const runtimeCoordinator = createRuntimeCoordinator();
    const planner = createAccountRemovalPlanner({ db, runtimeCoordinator });
    const baseRepository = createAccountRemovalOperationRepository(db);
    const phases = [];
    const operationRepository = {
      ...baseRepository,
      markPhase(operationId, phase, options) {
        phases.push(phase);
        return baseRepository.markPhase(operationId, phase, options);
      },
      markCompleted(operationId, summary) {
        phases.push('completed');
        return baseRepository.markCompleted(operationId, summary);
      },
    };
    const sqliteExecutor = createAccountRemovalSqliteExecutor({ db });
    const verifier = createAccountRemovalVerifier({ db, runtimeCoordinator });
    const orchestrator = createAccountRemovalOrchestrator({
      planner,
      operationRepository,
      sqliteExecutor,
      verifier,
      runtimeCoordinator,
    });
    const { preview } = orchestrator.preview({ owner });
    const pending = await orchestrator.confirm(createConfirmEnvelope(preview, 'account-removal-phase-order-01'));
    recordTrustedReceipts(baseRepository, pending);
    const completed = await orchestrator.verifyClientCleanup(createClientCleanupProof(pending, preview));
    assert.equal(completed.completed, true);
    assert.deepEqual(phases, ['quiescing', 'local-delete-pending', 'external-delete-pending', 'verifying', 'completed']);
  } finally {
    db.close();
  }
});
