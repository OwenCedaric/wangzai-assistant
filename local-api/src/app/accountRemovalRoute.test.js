import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { ACCOUNT_REMOVAL_SAFETY_BARRIER_VERSION } from '../domain/accountRemoval/accountRemovalContract.js';
import { ACCOUNT_REMOVAL_ERROR_CODES } from '../domain/accountRemoval/accountRemovalErrors.js';
import {
  getAccountRemovalClientBarrierIds,
  isAccountRemovalServerVerifiedClientResource,
} from '../domain/accountRemoval/accountRemovalClientResources.js';
import { createAccountRemovalOperationRepository } from '../db/repositories/accountRemovalOperationRepository.js';
import { createShopIdentityRepository } from '../db/repositories/shopIdentityRepository.js';
import { createMigratedTestDb } from '../../test/testDb.js';

process.env.LOCAL_API_SECRET ||= 'account-removal-route-test-secret-material';

const OWNER_TABLES = Object.freeze({
  ozon_shop: 'shops',
  cross_border_bus: 'cross_border_accounts',
  promotion_account: 'performance_accounts',
  purchase_account: 'purchase_accounts',
  model_api_account: 'model_api_accounts',
  integration_profile: 'integration_profiles',
});
const BACKUP_REVIEW_BY_PREVIEW = new Map();

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function startServer(db, overrides = {}) {
  const server = createApp({
    db,
    config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: Date.now(),
    ...overrides,
  });
  const port = await listen(server);
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function requestJson(baseUrl, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  const text = await response.text();
  return {
    response,
    payload: text ? JSON.parse(text) : null,
    text,
  };
}

async function saveOwner(baseUrl, owner, overrides = {}) {
  const fixtures = {
    ozon_shop: {
      path: '/api/shops',
      body: {
        id: owner.ownerId,
        name: `Shop ${owner.ownerId}`,
        clientId: `client-${owner.ownerId}`,
        apiKey: `shop-secret-${owner.ownerId}`,
        status: 'active',
      },
    },
    cross_border_bus: {
      path: '/api/logistics/cross-border/accounts',
      body: {
        id: owner.ownerId,
        name: `Bus ${owner.ownerId}`,
        userName: `user-${owner.ownerId}`,
        password: `bus-secret-${owner.ownerId}`,
        status: 'active',
      },
    },
    promotion_account: {
      path: '/api/performance/accounts',
      body: {
        id: owner.ownerId,
        name: `Performance ${owner.ownerId}`,
        clientId: `performance-client-${owner.ownerId}`,
        clientSecret: `performance-secret-${owner.ownerId}`,
        status: 'active',
      },
    },
    purchase_account: {
      path: '/api/purchase/accounts',
      body: {
        id: owner.ownerId,
        name: `Purchase ${owner.ownerId}`,
        loginAccount: `purchase-user-${owner.ownerId}`,
        loginPassword: `purchase-secret-${owner.ownerId}`,
        status: 'active',
      },
    },
    model_api_account: {
      path: '/api/model-api/accounts',
      body: {
        id: owner.ownerId,
        apiAlias: `Model ${owner.ownerId}`,
        provider: 'fixture-provider',
        apiKey: `model-secret-${owner.ownerId}`,
        status: 'active',
      },
    },
    integration_profile: {
      path: '/api/integrations/profiles',
      body: {
        id: owner.ownerId,
        integrationType: 'tool',
        platformName: `Integration ${owner.ownerId}`,
        apiType: 'tool-service',
        authMode: 'local',
        configStatus: 'saved',
      },
    },
  };
  const fixture = fixtures[owner.ownerType];
  assert.ok(fixture, `missing fixture for ${owner.ownerType}`);
  const result = await requestJson(baseUrl, fixture.path, {
    method: 'POST',
    body: { ...fixture.body, ...overrides },
  });
  assert.ok([200, 201].includes(result.response.status), result.text);
  assert.equal(result.payload.ok, true, result.text);
  return result.payload;
}

function createConfirmRequest(preview, idempotencyKey) {
  const barrierIds = getAccountRemovalClientBarrierIds(preview.owner.ownerType).sort();
  const request = {
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
    confirmationCode: 'DELETE_ACCOUNT_PERMANENTLY',
  };
  const backupReview = BACKUP_REVIEW_BY_PREVIEW.get(preview.previewFingerprint);
  if (backupReview?.required === true) {
    request.backupAuthorization = {
      outcome: 'explicitly-skipped',
      previewFingerprint: preview.previewFingerprint,
      dataFingerprint: backupReview.dataFingerprint,
      skipConfirmationCode: 'SKIP_BACKUP_AND_DELETE_PERMANENTLY',
    };
  }
  return request;
}

async function previewOwner(baseUrl, owner) {
  const result = await requestJson(baseUrl, '/api/account-removal/preview', {
    method: 'POST',
    body: { owner },
  });
  assert.equal(result.response.status, 200, result.text);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.preview.owner.ownerId, owner.ownerId);
  BACKUP_REVIEW_BY_PREVIEW.set(
    result.payload.preview.previewFingerprint,
    result.payload.backupReview,
  );
  return result.payload;
}

function recordTrustedReceipts(db, operation) {
  const repository = createAccountRemovalOperationRepository(db);
  for (const resourceId of operation.clientCleanup?.resourceIds || []) {
    if (isAccountRemovalServerVerifiedClientResource(operation.ownerType, resourceId)) {
      repository.recordTrustedClientResourceReceipt(operation.operationId, resourceId);
    }
  }
}

async function confirmOwner(baseUrl, preview, idempotencyKey, db) {
  const request = createConfirmRequest(preview, idempotencyKey);
  const confirmed = await requestJson(baseUrl, '/api/account-removal/confirm', {
    method: 'POST',
    body: request,
  });
  assert.ok([200, 202].includes(confirmed.response.status), confirmed.text);
  let operation = confirmed.payload;
  if (operation.requiresClientCleanup) {
    recordTrustedReceipts(db, operation);
    const verified = await requestJson(baseUrl, '/api/account-removal/client-verify', {
      method: 'POST',
      body: {
        operationId: operation.operationId,
        nonce: operation.clientCleanup.nonce,
        previewFingerprint: preview.previewFingerprint,
        resourceObservations: operation.clientCleanup.resourceIds.map((resourceId) => ({
          resourceId,
          state: 'absent',
        })),
      },
    });
    assert.equal(verified.response.status, 200, verified.text);
    operation = verified.payload;
  }
  assert.equal(operation.completed, true);
  assert.equal(operation.phase, 'completed');
  assert.equal(operation.deletionSummary.serverVerified, true);
  assert.equal(operation.deletionSummary.clientVerified, true);
  assert.equal(JSON.stringify(operation.deletionSummary).includes('SKIP_BACKUP_AND_DELETE_PERMANENTLY'), false);
  return { operation, request };
}

function ownerRowCount(db, owner) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM "${OWNER_TABLES[owner.ownerType]}" WHERE id = ?`).get(owner.ownerId).count);
}

test('client-failure accepts only a bound pending challenge and never completes or unlocks the operation', async () => {
  const db = createMigratedTestDb();
  let app;
  try {
    app = await startServer(db);
    const owner = { ownerType: 'model_api_account', ownerId: 'client_failure_route_owner' };
    await saveOwner(app.baseUrl, owner);
    const { preview } = await previewOwner(app.baseUrl, owner);
    const pending = (await requestJson(app.baseUrl, '/api/account-removal/confirm', { method: 'POST',
      body: createConfirmRequest(preview, 'client-failure-route-request-001') })).payload;
    const report = { operationId: pending.operationId, nonce: pending.clientCleanup.nonce,
      previewFingerprint: pending.previewFingerprint, errorCode: 'RECOVERY_REMOTE_UNAVAILABLE',
      resourceId: 'backup:remote-recovery-owner-model-api-account' };
    const recorded = await requestJson(app.baseUrl, '/api/account-removal/client-failure', { method: 'POST', body: report });
    assert.equal(recorded.response.status, 202, recorded.text);
    assert.equal(recorded.payload.reported, true);
    assert.equal(recorded.payload.completed, false);
    assert.equal(recorded.payload.phase, 'external-delete-pending');
    assert.equal(recorded.payload.status, 'retryable-failed');
    assert.equal(recorded.payload.error.code, report.errorCode);
    const repository = createAccountRemovalOperationRepository(db);
    assert.equal(repository.hasActiveOwner(owner), true);
    const released = await requestJson(app.baseUrl, '/api/account-removal/release-preview', { method: 'POST', body: { owner } });
    assert.equal(released.response.status, 409);
    for (const bad of [
      { ...report, nonce: 'wrong-challenge-1234' }, { ...report, previewFingerprint: 'e'.repeat(64) },
      { ...report, resourceId: 'browser:purchase-cookies' }, { ...report, message: 'must-not-store' },
      { ...report, owner }, { ...report, errorCode: 'ARBITRARY_UPPERCASE_SECRET' }, {},
    ]) {
      const rejected = await requestJson(app.baseUrl, '/api/account-removal/client-failure', { method: 'POST', body: bad });
      assert.ok([400, 409].includes(rejected.response.status), rejected.text);
    }
    const otherOwner = { ownerType: 'model_api_account', ownerId: 'client_failure_route_other' };
    await saveOwner(app.baseUrl, otherOwner);
    const { preview: otherPreview } = await previewOwner(app.baseUrl, otherOwner);
    const other = (await requestJson(app.baseUrl, '/api/account-removal/confirm', { method: 'POST',
      body: createConfirmRequest(otherPreview, 'client-failure-route-request-002') })).payload;
    const wrongOwner = await requestJson(app.baseUrl, '/api/account-removal/client-failure', { method: 'POST',
      body: { ...report, operationId: other.operationId } });
    assert.equal(wrongOwner.response.status, 409);
    assert.equal(repository.getOperation(other.operationId).lastErrorCode, null);
    recordTrustedReceipts(db, pending);
    const verified = await requestJson(app.baseUrl, '/api/account-removal/client-verify', { method: 'POST', body: {
      operationId: pending.operationId, nonce: pending.clientCleanup.nonce, previewFingerprint: pending.previewFingerprint,
      resourceObservations: pending.clientCleanup.resourceIds.map((resourceId) => ({ resourceId, state: 'absent' })),
    } });
    assert.equal(verified.payload.completed, true, verified.text);
    const late = await requestJson(app.baseUrl, '/api/account-removal/client-failure', { method: 'POST', body: report });
    assert.equal(late.response.status, 200);
    assert.equal(late.payload.completed, true);
    assert.equal(late.payload.reported, false);
    assert.equal(late.payload.error, null);
    assert.equal(Object.hasOwn(late.payload, 'pendingOwner'), false);
  } finally {
    if (app) await app.close();
    db.close();
  }
});

test('canonical preview-confirm-readback flow completes for all six account owner types', async () => {
  const db = createMigratedTestDb();
  let app;
  try {
    app = await startServer(db);
    const owners = [
      { ownerType: 'ozon_shop', ownerId: 'shop_route_complete' },
      { ownerType: 'cross_border_bus', ownerId: 'bus_route_complete' },
      { ownerType: 'promotion_account', ownerId: 'performance_route_complete' },
      { ownerType: 'purchase_account', ownerId: 'purchase_route_complete' },
      { ownerType: 'model_api_account', ownerId: 'model_route_complete' },
      { ownerType: 'integration_profile', ownerId: 'integration_route_complete' },
    ];

    for (const [index, owner] of owners.entries()) {
      await saveOwner(app.baseUrl, owner);
      const { preview, account, ownerGeneration } = await previewOwner(app.baseUrl, owner);
      assert.equal(account.ownerType, owner.ownerType);
      if (owner.ownerType === 'ozon_shop') {
        assert.equal(ownerGeneration.ownerId, owner.ownerId);
        assert.equal(ownerGeneration.clientId, `client-${owner.ownerId}`);
        assert.match(ownerGeneration.shopIncarnation, /^inc_/u);
        assert.equal(ownerGeneration.credentialRevision, 1);
      } else {
        assert.equal(ownerGeneration, null);
      }
      assert.ok(preview.plannedResources.length > 0);
      assert.ok(preview.preserveResources.length > 0);
      assert.ok(preview.fenceResources.some(
        (resource) => resource.resourceId === 'runtime:desktop-recovery-auto-backup-scheduler',
      ));
      assert.ok(preview.drainResources.some(
        (resource) => resource.resourceId === 'runtime:desktop-recovery-auto-backup-scheduler',
      ));
      const { operation } = await confirmOwner(
        app.baseUrl,
        preview,
        `account-removal-all-types-${index.toString().padStart(2, '0')}`,
        db,
      );
      assert.equal(operation.ownerType, owner.ownerType);
      if (owner.ownerType === 'ozon_shop') {
        assert.deepEqual(operation.deletionSummary.removedOwnerGeneration, ownerGeneration);
      }
      assert.equal(ownerRowCount(db, owner), 0);
    }
  } finally {
    if (app) await app.close();
    db.close();
  }
});

test('trusted recovery purge commands resolve owner only from the pending operation and persist server receipts', async () => {
  const db = createMigratedTestDb();
  let app;
  try {
    const purgeCalls = [];
    const remoteCalls = [];
    app = await startServer(db, {
      accountRemovalProtectionService: {
        purgeOwner(input) {
          purgeCalls.push(structuredClone(input));
          return {
            ok: true,
            verified: true,
            familyCount: 2,
            diagnosticLogs: { verified: true, fileCount: 1, replacementCount: 1 },
          };
        },
      },
      recoveryFetchImpl: async (url, options = {}) => {
        remoteCalls.push({ url: String(url), authorization: options.headers?.Authorization || options.headers?.authorization || '' });
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const owner = { ownerType: 'purchase_account', ownerId: 'purchase_protection_command' };
    await saveOwner(app.baseUrl, owner);
    const { preview } = await previewOwner(app.baseUrl, owner);
    const pending = await requestJson(app.baseUrl, '/api/account-removal/confirm', {
      method: 'POST',
      body: createConfirmRequest(preview, 'account-removal-protection-command-01'),
    });
    assert.equal(pending.response.status, 202, pending.text);
    assert.equal(pending.payload.requiresClientCleanup, true);

    const purged = await requestJson(app.baseUrl, '/api/app/recovery/command', {
      method: 'POST',
      body: {
        command: 'purge-account-owner-protection',
        operationId: pending.payload.operationId,
        owner: { ownerType: 'ozon_shop', ownerId: 'renderer-forgery' },
        remote: { accessToken: 'renderer-must-not-control-this-command' },
      },
    });
    assert.equal(purged.response.status, 200, purged.text);
    assert.deepEqual(purged.payload, {
      ok: true,
      verified: true,
      familyCount: 2,
      diagnosticLogs: { verified: true, fileCount: 1, replacementCount: 1 },
    });
    assert.deepEqual(purgeCalls, [{ owner }]);
    const remotePurged = await requestJson(app.baseUrl, '/api/app/recovery/command', {
      method: 'POST',
      body: {
        command: 'purge-account-owner',
        operationId: pending.payload.operationId,
        owner: { ownerType: 'ozon_shop', ownerId: 'renderer-forgery' },
        remote: { baseUrl: 'https://recovery.fixture.invalid', accessToken: 'trusted-desktop-token' },
      },
    });
    assert.equal(remotePurged.response.status, 200, remotePurged.text);
    assert.equal(remotePurged.payload.verified, true);
    assert.deepEqual(remoteCalls, [{
      url: 'https://recovery.fixture.invalid/api/recovery/generations',
      authorization: 'Bearer trusted-desktop-token',
    }]);
    const recorded = createAccountRemovalOperationRepository(db).getOperation(pending.payload.operationId);
    assert.deepEqual(recorded.payload.trustedClientResourceReceipts, {
      'backup:remote-recovery-owner-purchase-account': { verified: true },
      'filesystem:diagnostic-logs-owner-purchase-account': { verified: true },
      'filesystem:recovery-protection-owner-purchase-account': { verified: true },
    });
  } finally {
    if (app) await app.close();
    db.close();
  }
});

test('all six legacy DELETE routes fail closed and leave their account rows unchanged', async () => {
  const db = createMigratedTestDb();
  let app;
  try {
    app = await startServer(db);
    const fixtures = [
      [{ ownerType: 'ozon_shop', ownerId: 'shop_legacy_blocked' }, '/api/shops/shop_legacy_blocked'],
      [{ ownerType: 'cross_border_bus', ownerId: 'bus_legacy_blocked' }, '/api/logistics/cross-border/accounts/bus_legacy_blocked'],
      [{ ownerType: 'promotion_account', ownerId: 'performance_legacy_blocked' }, '/api/performance/accounts/performance_legacy_blocked'],
      [{ ownerType: 'purchase_account', ownerId: 'purchase_legacy_blocked' }, '/api/purchase/accounts/purchase_legacy_blocked'],
      [{ ownerType: 'model_api_account', ownerId: 'model_legacy_blocked' }, '/api/model-api/accounts/model_legacy_blocked'],
      [{ ownerType: 'integration_profile', ownerId: 'integration_legacy_blocked' }, '/api/integrations/profiles/integration_legacy_blocked'],
    ];
    for (const [owner, path] of fixtures) {
      await saveOwner(app.baseUrl, owner);
      const rejected = await requestJson(app.baseUrl, path, { method: 'DELETE' });
      assert.equal(rejected.response.status, 409, rejected.text);
      assert.equal(rejected.payload.completed, false);
      assert.equal(rejected.payload.error.code, 'ACCOUNT_REMOVAL_LEGACY_ROUTE_PREVIEW_REQUIRED');
      assert.equal(rejected.payload.canonicalRoute, '/api/account-removal/preview');
      assert.equal(ownerRowCount(db, owner), 1);
    }
  } finally {
    if (app) await app.close();
    db.close();
  }
});

test('malformed encoded operation and legacy owner ids fail closed without terminating the server', async () => {
  const db = createMigratedTestDb();
  const app = await startServer(db);
  try {
    const malformedStatus = await requestJson(app.baseUrl, '/api/account-removal/operations/%E0%A4%A');
    assert.equal(malformedStatus.response.status, 400, malformedStatus.text);
    assert.equal(malformedStatus.payload.completed, false);
    assert.equal(malformedStatus.payload.error.code, ACCOUNT_REMOVAL_ERROR_CODES.OWNER_ID_INVALID);

    const malformedResume = await requestJson(app.baseUrl, '/api/account-removal/operations/%E0%A4%A/resume', {
      method: 'POST',
    });
    assert.equal(malformedResume.response.status, 400, malformedResume.text);
    assert.equal(malformedResume.payload.error.code, ACCOUNT_REMOVAL_ERROR_CODES.OWNER_ID_INVALID);

    const malformedLegacyDelete = await requestJson(app.baseUrl, '/api/shops/%E0%A4%A', { method: 'DELETE' });
    assert.equal(malformedLegacyDelete.response.status, 400, malformedLegacyDelete.text);
    assert.equal(malformedLegacyDelete.payload.error.code, ACCOUNT_REMOVAL_ERROR_CODES.OWNER_ID_INVALID);

    const missingDirectRecovery = await requestJson(app.baseUrl, '/api/account-removal/recover-direct', {
      method: 'POST',
      body: { owner: { ownerType: 'ozon_shop', ownerId: 'missing-direct-recovery' } },
    });
    assert.equal(missingDirectRecovery.response.status, 404, missingDirectRecovery.text);
    assert.equal(
      missingDirectRecovery.payload.error.code,
      ACCOUNT_REMOVAL_ERROR_CODES.OPERATION_NOT_FOUND,
    );

    const stillAlive = await requestJson(app.baseUrl, '/api/account-removal/pending');
    assert.equal(stillAlive.response.status, 200, stillAlive.text);
    assert.equal(stillAlive.payload.ok, true);
  } finally {
    await app.close();
    db.close();
  }
});

test('stale previews are rejected while successful confirmation is idempotent and owner-bound', async () => {
  const db = createMigratedTestDb();
  let app;
  try {
    app = await startServer(db);
    const firstOwner = { ownerType: 'purchase_account', ownerId: 'purchase_idempotent_a' };
    const secondOwner = { ownerType: 'purchase_account', ownerId: 'purchase_idempotent_b' };
    await saveOwner(app.baseUrl, firstOwner);
    const stale = await previewOwner(app.baseUrl, firstOwner);
    await saveOwner(app.baseUrl, firstOwner, { name: 'Changed after preview' });
    const staleRequest = createConfirmRequest(stale.preview, 'account-removal-stale-preview-01');
    const rejected = await requestJson(app.baseUrl, '/api/account-removal/confirm', {
      method: 'POST',
      body: staleRequest,
    });
    assert.equal(rejected.response.status, 409, rejected.text);
    assert.equal(rejected.payload.completed, false);
    assert.equal(rejected.payload.error.code, 'ACCOUNT_REMOVAL_SNAPSHOT_FINGERPRINT_MISMATCH');
    assert.equal(ownerRowCount(db, firstOwner), 1);

    const fresh = await previewOwner(app.baseUrl, firstOwner);
    const idempotencyKey = 'account-removal-idempotent-replay-01';
    const completed = await confirmOwner(app.baseUrl, fresh.preview, idempotencyKey, db);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const replay = await requestJson(app.baseUrl, '/api/account-removal/confirm', {
        method: 'POST',
        body: completed.request,
      });
      assert.equal(replay.response.status, 200, replay.text);
      assert.equal(replay.payload.completed, true);
      assert.equal(replay.payload.operationId, completed.operation.operationId);
    }

    await saveOwner(app.baseUrl, secondOwner);
    const other = await previewOwner(app.baseUrl, secondOwner);
    const conflicting = await requestJson(app.baseUrl, '/api/account-removal/confirm', {
      method: 'POST',
      body: createConfirmRequest(other.preview, idempotencyKey),
    });
    assert.equal(conflicting.response.status, 409, conflicting.text);
    assert.equal(conflicting.payload.error.code, 'ACCOUNT_REMOVAL_IDEMPOTENCY_KEY_CONFLICT');
    assert.equal(ownerRowCount(db, secondOwner), 1);
  } finally {
    if (app) await app.close();
    db.close();
  }
});

test('client proof is exact, active owners are write-locked, and same-id recreation requires explicit rebind', async () => {
  const db = createMigratedTestDb();
  let app;
  try {
    app = await startServer(db);
    const owner = { ownerType: 'ozon_shop', ownerId: 'shop_client_proof' };
    const originalBinding = await saveOwner(app.baseUrl, owner);
    const oldScopeToken = {
      profileId: originalBinding.shop.profileId,
      shopId: originalBinding.shop.id,
      shopIncarnation: originalBinding.shop.shopIncarnation,
      credentialRevision: originalBinding.shop.credentialRevision,
    };
    const { preview } = await previewOwner(app.baseUrl, owner);
    const request = createConfirmRequest(preview, 'account-removal-client-proof-01');
    const pending = await requestJson(app.baseUrl, '/api/account-removal/confirm', {
      method: 'POST',
      body: request,
    });
    assert.equal(pending.response.status, 202, pending.text);
    assert.equal(pending.payload.requiresClientCleanup, true);
    assert.equal(pending.payload.phase, 'external-delete-pending');

    const lockedWrite = await requestJson(app.baseUrl, '/api/shops', {
      method: 'POST',
      body: {
        id: owner.ownerId,
        name: 'Must remain locked',
        clientId: 'locked-client',
        apiKey: 'locked-secret',
      },
    });
    assert.equal(lockedWrite.response.status, 400, lockedWrite.text);
    assert.equal(lockedWrite.payload.error.code, 'ACCOUNT_REMOVAL_OWNER_LOCKED');

    const challenge = pending.payload.clientCleanup;
    const invalidNonce = await requestJson(app.baseUrl, '/api/account-removal/client-verify', {
      method: 'POST',
      body: {
        operationId: pending.payload.operationId,
        nonce: 'wrong-client-cleanup-nonce',
        previewFingerprint: preview.previewFingerprint,
        resourceObservations: challenge.resourceIds.map((resourceId) => ({ resourceId, state: 'absent' })),
      },
    });
    assert.equal(invalidNonce.response.status, 400, invalidNonce.text);
    assert.equal(invalidNonce.payload.error.code, 'ACCOUNT_REMOVAL_CLIENT_CLEANUP_PROOF_INVALID');

    const incomplete = await requestJson(app.baseUrl, '/api/account-removal/client-verify', {
      method: 'POST',
      body: {
        operationId: pending.payload.operationId,
        nonce: challenge.nonce,
        previewFingerprint: preview.previewFingerprint,
        resourceObservations: challenge.resourceIds.slice(1).map((resourceId) => ({ resourceId, state: 'absent' })),
      },
    });
    assert.equal(incomplete.response.status, 400, incomplete.text);
    assert.equal(incomplete.payload.error.code, 'ACCOUNT_REMOVAL_CLIENT_CLEANUP_PROOF_INVALID');

    const forgedExternalReadback = await requestJson(app.baseUrl, '/api/account-removal/client-verify', {
      method: 'POST',
      body: {
        operationId: pending.payload.operationId,
        nonce: challenge.nonce,
        previewFingerprint: preview.previewFingerprint,
        resourceObservations: challenge.resourceIds.map((resourceId) => ({ resourceId, state: 'absent' })),
      },
    });
    assert.equal(forgedExternalReadback.response.status, 400, forgedExternalReadback.text);
    assert.equal(forgedExternalReadback.payload.error.code, 'ACCOUNT_REMOVAL_CLIENT_CLEANUP_PROOF_INVALID');

    recordTrustedReceipts(db, pending.payload);
    const verified = await requestJson(app.baseUrl, '/api/account-removal/client-verify', {
      method: 'POST',
      body: {
        operationId: pending.payload.operationId,
        nonce: challenge.nonce,
        previewFingerprint: preview.previewFingerprint,
        resourceObservations: challenge.resourceIds.map((resourceId) => ({ resourceId, state: 'absent' })),
      },
    });
    assert.equal(verified.response.status, 200, verified.text);
    assert.equal(verified.payload.completed, true);

    const implicitRebind = await requestJson(app.baseUrl, '/api/shops', {
      method: 'POST',
      body: {
        id: owner.ownerId,
        name: 'Implicit rebind',
        clientId: 'new-client',
        apiKey: 'new-secret',
      },
    });
    assert.equal(implicitRebind.response.status, 400, implicitRebind.text);
    assert.equal(implicitRebind.payload.error.code, 'ACCOUNT_REMOVAL_OWNER_REBIND_REQUIRED');

    const explicitRebind = await requestJson(app.baseUrl, '/api/shops', {
      method: 'POST',
      body: {
        id: owner.ownerId,
        name: 'Explicit clean rebind',
        clientId: 'new-client',
        apiKey: 'new-secret',
        accountRemovalRebind: true,
      },
    });
    assert.ok([200, 201].includes(explicitRebind.response.status), explicitRebind.text);
    assert.equal(explicitRebind.payload.shop.name, 'Explicit clean rebind');
    assert.equal(explicitRebind.payload.shop.status, 'active');
    assert.notEqual(explicitRebind.payload.shop.shopIncarnation, oldScopeToken.shopIncarnation);
    assert.equal(explicitRebind.payload.bindingReady, false);
    assert.equal(explicitRebind.payload.bindingStatus, 'queued');
    assert.equal(explicitRebind.payload.bootstrapRun.reason, 'rebind');
    assert.deepEqual(explicitRebind.payload.bootstrapRun.requiredDomains, [
      'catalog_mappings',
      'finance',
      'logistics',
      'marketing',
      'orders',
      'products',
      'returns',
    ]);
    assert.throws(
      () => createShopIdentityRepository(db).assertCurrentScopeToken(oldScopeToken),
      (error) => error?.code === 'SHOP_INCARNATION_STALE',
    );
    assert.equal(ownerRowCount(db, owner), 1);

    const cleanScopedWrite = await requestJson(app.baseUrl, '/api/purchase/orders/overrides', {
      method: 'POST',
      body: {
        shopId: owner.ownerId,
        postingNumber: 'new-owner-posting',
        purchasePlatform: 'fixture',
        purchaseOrderNumber: 'new-owner-order',
        sourceCostCny: 1,
      },
    });
    assert.equal(cleanScopedWrite.response.status, 200, cleanScopedWrite.text);
    assert.equal(cleanScopedWrite.payload.ok, true);
  } finally {
    if (app) await app.close();
    db.close();
  }
});

test('pending operation exposes only the recovery owner DTO, keeps secrets private across restart, and recovers once', async () => {
  const db = createMigratedTestDb();
  let firstApp;
  let secondApp;
  try {
    const owner = { ownerType: 'model_api_account', ownerId: 'model_private_owner_01' };
    const rawSecret = 'private-model-secret-must-not-leak';
    const idempotencyKey = 'private-idempotency-key-must-not-leak';
    firstApp = await startServer(db);
    await saveOwner(firstApp.baseUrl, owner, { apiKey: rawSecret });
    const { preview } = await previewOwner(firstApp.baseUrl, owner);
    const pending = await requestJson(firstApp.baseUrl, '/api/account-removal/confirm', {
      method: 'POST',
      body: createConfirmRequest(preview, idempotencyKey),
    });
    assert.equal(pending.response.status, 202, pending.text);

    const operationRow = db.prepare('SELECT * FROM account_removal_operations WHERE operation_id = ?').get(
      pending.payload.operationId,
    );
    const persistedText = JSON.stringify(operationRow);
    assert.equal(persistedText.includes(owner.ownerId), false);
    assert.equal(persistedText.includes(rawSecret), false);
    assert.equal(persistedText.includes(idempotencyKey), false);

    const pendingList = await requestJson(firstApp.baseUrl, '/api/account-removal/pending');
    const status = await requestJson(
      firstApp.baseUrl,
      `/api/account-removal/operations/${encodeURIComponent(pending.payload.operationId)}`,
    );
    for (const dto of [...pendingList.payload.operations, status.payload, pending.payload]) {
      assert.deepEqual(dto.pendingOwner, owner);
      assert.equal(dto.pendingOwnerGeneration, null);
      const { pendingOwner, ...nonOwnerDto } = dto;
      assert.equal(JSON.stringify(nonOwnerDto).includes(pendingOwner.ownerId), false);
      assert.equal('payload' in dto, false);
      assert.equal('account' in dto, false);
    }
    for (const publicText of [pendingList.text, status.text, pending.text]) {
      assert.equal(publicText.includes(rawSecret), false);
      assert.equal(publicText.includes(idempotencyKey), false);
    }

    await firstApp.close();
    firstApp = null;
    secondApp = await startServer(db);
    const recovered = await requestJson(secondApp.baseUrl, '/api/account-removal/recover', {
      method: 'POST',
      body: { owner },
    });
    assert.equal(recovered.response.status, 202, recovered.text);
    assert.equal(recovered.payload.operationId, pending.payload.operationId);
    assert.deepEqual(recovered.payload.pendingOwner, owner);
    assert.equal(recovered.text.includes(rawSecret), false);
    assert.equal(recovered.text.includes(idempotencyKey), false);

    const challenge = recovered.payload.clientCleanup;
    recordTrustedReceipts(db, recovered.payload);
    const completed = await requestJson(secondApp.baseUrl, '/api/account-removal/client-verify', {
      method: 'POST',
      body: {
        operationId: recovered.payload.operationId,
        nonce: challenge.nonce,
        previewFingerprint: recovered.payload.previewFingerprint,
        resourceObservations: challenge.resourceIds.map((resourceId) => ({ resourceId, state: 'absent' })),
      },
    });
    assert.equal(completed.response.status, 200, completed.text);
    assert.equal(completed.payload.completed, true);
    assert.equal(ownerRowCount(db, owner), 0);

    const completedRow = db.prepare('SELECT payload_encrypted, client_cleanup_nonce FROM account_removal_operations WHERE operation_id = ?').get(
      pending.payload.operationId,
    );
    assert.equal(completedRow.payload_encrypted, null);
    assert.equal(completedRow.client_cleanup_nonce, null);
  } finally {
    if (firstApp) await firstApp.close();
    if (secondApp) await secondApp.close();
    db.close();
  }
});

test('cross-border preference cleanup removes only the deleted account slice', async () => {
  const db = createMigratedTestDb();
  let app;
  try {
    app = await startServer(db);
    const owner = { ownerType: 'cross_border_bus', ownerId: 'bus_preference_target' };
    await saveOwner(app.baseUrl, owner);
    const preferences = {
      crossBorderAccountId: owner.ownerId,
      accountId: owner.ownerId,
      accountAlias: 'Target alias',
      accountSaved: true,
      connectionStatus: 'connected',
      selectedWarehouseId: 'warehouse-preserved',
      warehouseOptions: [{ id: 'warehouse-preserved', label: 'Preserved warehouse' }],
      layoutDensity: 'compact',
    };
    const saved = await requestJson(app.baseUrl, '/api/profile-settings/cross-border-preferences', {
      method: 'PUT',
      body: { value: preferences },
    });
    assert.equal(saved.response.status, 200, saved.text);

    const { preview } = await previewOwner(app.baseUrl, owner);
    await confirmOwner(app.baseUrl, preview, 'account-removal-cross-preference-01', db);
    const readback = await requestJson(app.baseUrl, '/api/profile-settings/cross-border-preferences');
    assert.equal(readback.response.status, 200, readback.text);
    const readbackValue = readback.payload.setting.value;
    assert.equal('crossBorderAccountId' in readbackValue, false);
    assert.equal('accountId' in readbackValue, false);
    assert.equal('accountAlias' in readbackValue, false);
    assert.equal('accountSaved' in readbackValue, false);
    assert.equal('connectionStatus' in readbackValue, false);
    assert.equal(readbackValue.selectedWarehouseId, 'warehouse-preserved');
    assert.deepEqual(readbackValue.warehouseOptions, preferences.warehouseOptions);
    assert.equal(readbackValue.layoutDensity, 'compact');
  } finally {
    if (app) await app.close();
    db.close();
  }
});
