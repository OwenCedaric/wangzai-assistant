import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/app/createApp.js';
import { openDatabase, runMigrations } from '../src/db/database.js';
import { createAccountRemovalOperationRepository } from '../src/db/repositories/accountRemovalOperationRepository.js';
import { ACCOUNT_REMOVAL_SAFETY_BARRIER_VERSION } from '../src/domain/accountRemoval/accountRemovalContract.js';
import {
  getAccountRemovalClientBarrierIds,
  isAccountRemovalServerVerifiedClientResource,
} from '../src/domain/accountRemoval/accountRemovalClientResources.js';

process.env.LOCAL_API_SECRET ||= 'account-removal-stress-isolated-secret-material';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const localApiRoot = resolve(scriptDirectory, '..');
const testResultsRoot = resolve(localApiRoot, 'test-results');
const workRoot = resolve(testResultsRoot, 'account-removal-stress-work');
const databasePath = resolve(workRoot, 'account-removal-stress.sqlite');
const reportPath = resolve(testResultsRoot, 'account-removal-stress-report.json');
const parsedCycles = Number.parseInt(
  process.argv.find((argument) => argument.startsWith('--cycles='))?.split('=')[1] || '50',
  10,
);
const cyclesPerOwner = Math.max(50, Number.isFinite(parsedCycles) ? parsedCycles : 50);
const restartEvery = 10;

const OWNER_TABLES = Object.freeze({
  ozon_shop: 'shops',
  cross_border_bus: 'cross_border_accounts',
  promotion_account: 'performance_accounts',
  purchase_account: 'purchase_accounts',
  model_api_account: 'model_api_accounts',
  integration_profile: 'integration_profiles',
});

const OWNER_TYPES = Object.freeze(Object.keys(OWNER_TABLES));

function fixtureCredential(...parts) {
  return ['account-removal', 'test-credential', ...parts].join('-');
}

function assertOwnedWorkPath(targetPath) {
  const normalizedRoot = `${workRoot}${sep}`.toLowerCase();
  const normalizedTarget = resolve(targetPath).toLowerCase();
  assert.ok(
    normalizedTarget === workRoot.toLowerCase() || normalizedTarget.startsWith(normalizedRoot),
    `refusing to clean path outside stress work root: ${targetPath}`,
  );
}

function cleanupWorkRoot() {
  assertOwnedWorkPath(workRoot);
  rmSync(workRoot, { recursive: true, force: true });
}

function databaseConfig() {
  return {
    database: {
      path: databasePath,
      enableWal: true,
      busyTimeoutMs: 5000,
    },
  };
}

function openStressDatabase() {
  const db = openDatabase(databaseConfig());
  runMigrations(db);
  return db;
}

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise(server.address().port);
    });
  });
}

async function startServer(db) {
  const server = createApp({
    db,
    config: { security: {}, sync: { continuousEnabled: false }, ozon: {} },
    ozonClient: {
      requestReadOnly() { throw new Error('ACCOUNT_REMOVAL_STRESS_EXTERNAL_REQUEST_FORBIDDEN'); },
      requestWrite() { throw new Error('ACCOUNT_REMOVAL_STRESS_EXTERNAL_WRITE_FORBIDDEN'); },
    },
    getDatabaseStatus: () => ({ ok: true }),
    listAppliedMigrations: () => [],
    startedAt: Date.now(),
  });
  const port = await listen(server);
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()));
    }),
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
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`non-JSON response ${response.status} ${path}: ${text.slice(0, 500)}`, { cause: error });
    }
  }
  return { response, payload, text };
}

function ownerFixture(owner, cycle, { sentinel = false } = {}) {
  const marker = sentinel ? 'sentinel' : `cycle-${cycle.toString().padStart(3, '0')}`;
  const common = { id: owner.ownerId };
  switch (owner.ownerType) {
    case 'ozon_shop':
      return {
        path: '/api/shops',
        body: {
          ...common,
          name: `Stress Shop ${marker}`,
          clientId: `stress-client-${owner.ownerId}-${marker}`,
          apiKey: fixtureCredential('stress', 'shop', owner.ownerId, marker),
          status: 'active',
        },
      };
    case 'cross_border_bus':
      return {
        path: '/api/logistics/cross-border/accounts',
        body: {
          ...common,
          name: `Stress Bus ${marker}`,
          userName: `stress-user-${owner.ownerId}-${marker}`,
          password: fixtureCredential('stress', 'bus', owner.ownerId, marker),
          status: 'active',
        },
      };
    case 'promotion_account':
      return {
        path: '/api/performance/accounts',
        body: {
          ...common,
          name: `Stress Performance ${marker}`,
          clientId: `stress-performance-client-${owner.ownerId}-${marker}`,
          clientSecret: fixtureCredential('stress', 'performance', owner.ownerId, marker),
          status: 'active',
        },
      };
    case 'purchase_account':
      return {
        path: '/api/purchase/accounts',
        body: {
          ...common,
          name: `Stress Purchase ${marker}`,
          loginAccount: `stress-purchase-user-${owner.ownerId}-${marker}`,
          loginPassword: `stress-purchase-secret-${owner.ownerId}-${marker}`,
          status: 'active',
        },
      };
    case 'model_api_account':
      return {
        path: '/api/model-api/accounts',
        body: {
          ...common,
          apiAlias: `Stress Model ${marker}`,
          provider: 'stress-provider',
          apiKey: fixtureCredential('stress', 'model', owner.ownerId, marker),
          status: 'active',
        },
      };
    case 'integration_profile':
      return {
        path: '/api/integrations/profiles',
        body: {
          ...common,
          integrationType: 'tool',
          platformName: `Stress Integration ${marker}`,
          apiType: 'tool-service',
          authMode: 'local',
          configStatus: 'saved',
          note: `stress-integration-note-${owner.ownerId}-${marker}`,
        },
      };
    default:
      throw new Error(`unsupported owner type: ${owner.ownerType}`);
  }
}

async function saveOwner(baseUrl, owner, cycle, options = {}) {
  const fixture = ownerFixture(owner, cycle, options);
  const result = await requestJson(baseUrl, fixture.path, {
    method: 'POST',
    body: {
      ...fixture.body,
      ...(options.rebind ? { accountRemovalRebind: true } : {}),
    },
  });
  assert.ok([200, 201].includes(result.response.status), result.text);
  assert.equal(result.payload?.ok, true, result.text);
  return fixture;
}

function createConfirmRequest(preview, backupReview, idempotencyKey) {
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
  assert.equal(result.payload?.ok, true, result.text);
  assert.equal(result.payload.preview.owner.ownerId, owner.ownerId);
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

async function confirmOwner(baseUrl, db, previewPayload, idempotencyKey) {
  const { preview, backupReview } = previewPayload;
  const request = createConfirmRequest(preview, backupReview, idempotencyKey);
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
  return { operation, request };
}

function ownerRowCount(db, owner) {
  return Number(
    db.prepare(`SELECT COUNT(*) AS count FROM "${OWNER_TABLES[owner.ownerType]}" WHERE id = ?`)
      .get(owner.ownerId).count,
  );
}

function operationPrivateFieldsCleared(db, operationId) {
  return db.prepare(`
    SELECT payload_encrypted, client_cleanup_nonce
    FROM account_removal_operations
    WHERE operation_id = ?
  `).get(operationId);
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

async function restartRuntime(runtime) {
  if (runtime.app) await runtime.app.close();
  runtime.app = null;
  if (runtime.db) runtime.db.close();
  runtime.db = openStressDatabase();
  runtime.app = await startServer(runtime.db);
}

function assertNoRawResidue(paths, needles) {
  const inspected = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    inspected.push(path);
    const bytes = readFileSync(path);
    for (const needle of needles) {
      assert.equal(
        bytes.includes(Buffer.from(needle, 'utf8')),
        false,
        `raw residue found in ${path}: ${needle}`,
      );
    }
  }
  return inspected;
}

async function main() {
  mkdirSync(testResultsRoot, { recursive: true });
  cleanupWorkRoot();
  mkdirSync(workRoot, { recursive: true });
  const runtime = { db: null, app: null };
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  const report = {
    schemaVersion: 1,
    startedAt,
    cyclesPerOwner,
    ownerTypeCount: OWNER_TYPES.length,
    totalDeletionCycles: cyclesPerOwner * OWNER_TYPES.length,
    totalIdempotentReplays: 0,
    totalRuntimeRestarts: 0,
    isolatedFileDatabase: true,
    realLoopbackHttp: true,
    externalCleanupEvidence: {
      syntheticTrustedReceipts: true,
      nativeBrowserVerified: false,
      realRemoteBackupVerified: false,
      scope: 'Server deletion, idempotency, restart, residue and owner isolation only; not full desktop/cloud acceptance.',
    },
    modules: [],
    passed: false,
  };
  const deletedRawSecrets = [];
  const deletedOwnerIdsThatMustBeErased = [];
  let expectedOzonIdentityTombstones = 0;

  try {
    runtime.db = openStressDatabase();
    runtime.app = await startServer(runtime.db);

    for (const ownerType of OWNER_TYPES) {
      const target = { ownerType, ownerId: `stress-target-${ownerType}` };
      const sentinel = { ownerType, ownerId: `stress-sentinel-${ownerType}` };
      await saveOwner(runtime.app.baseUrl, sentinel, 0, { sentinel: true });
      const durationsMs = [];
      const moduleResult = {
        ownerType,
        cycles: 0,
        idempotentReplays: 0,
        runtimeRestarts: 0,
        targetResidueMismatches: 0,
        sentinelIsolationMismatches: 0,
        operationPrivacyMismatches: 0,
      };

      for (let cycle = 0; cycle < cyclesPerOwner; cycle += 1) {
        if (cycle > 0 && cycle % restartEvery === 0) {
          await restartRuntime(runtime);
          moduleResult.runtimeRestarts += 1;
          report.totalRuntimeRestarts += 1;
          assert.equal(ownerRowCount(runtime.db, sentinel), 1, `${ownerType} sentinel lost after restart`);
          assert.equal(ownerRowCount(runtime.db, target), 0, `${ownerType} target returned after restart`);
        }

        const cycleStart = performance.now();
        const fixture = await saveOwner(runtime.app.baseUrl, target, cycle, { rebind: cycle > 0 });
        assert.equal(ownerRowCount(runtime.db, target), 1, `${ownerType} target was not saved`);
        assert.equal(ownerRowCount(runtime.db, sentinel), 1, `${ownerType} sentinel changed during save`);

        const previewPayload = await previewOwner(runtime.app.baseUrl, target);
        assert.equal(previewPayload.account.ownerType, ownerType);
        assert.ok(previewPayload.preview.plannedResources.length > 0);
        const idempotencyKey = `stress-remove-${ownerType}-${cycle.toString().padStart(3, '0')}`;
        const completed = await confirmOwner(
          runtime.app.baseUrl,
          runtime.db,
          previewPayload,
          idempotencyKey,
        );

        if (ownerRowCount(runtime.db, target) !== 0) moduleResult.targetResidueMismatches += 1;
        if (ownerRowCount(runtime.db, sentinel) !== 1) moduleResult.sentinelIsolationMismatches += 1;
        assert.equal(ownerRowCount(runtime.db, target), 0, `${ownerType} target row remains after cycle ${cycle}`);
        assert.equal(ownerRowCount(runtime.db, sentinel), 1, `${ownerType} sentinel was deleted at cycle ${cycle}`);

        const privateFields = operationPrivateFieldsCleared(runtime.db, completed.operation.operationId);
        if (privateFields?.payload_encrypted !== null || privateFields?.client_cleanup_nonce !== null) {
          moduleResult.operationPrivacyMismatches += 1;
        }
        assert.equal(privateFields?.payload_encrypted, null);
        assert.equal(privateFields?.client_cleanup_nonce, null);

        const replay = await requestJson(runtime.app.baseUrl, '/api/account-removal/confirm', {
          method: 'POST',
          body: completed.request,
        });
        assert.equal(replay.response.status, 200, replay.text);
        assert.equal(replay.payload.completed, true);
        assert.equal(replay.payload.operationId, completed.operation.operationId);
        assert.equal(ownerRowCount(runtime.db, target), 0);
        assert.equal(ownerRowCount(runtime.db, sentinel), 1);

        moduleResult.cycles += 1;
        moduleResult.idempotentReplays += 1;
        report.totalIdempotentReplays += 1;
        durationsMs.push(performance.now() - cycleStart);
        if (ownerType === 'ozon_shop') {
          expectedOzonIdentityTombstones += 1;
        } else {
          deletedOwnerIdsThatMustBeErased.push(target.ownerId);
        }
        for (const key of ['apiKey', 'password', 'clientSecret', 'loginPassword']) {
          const value = fixture.body[key];
          if (typeof value === 'string' && value) deletedRawSecrets.push(value);
        }
      }

      moduleResult.averageMs = Number((durationsMs.reduce((sum, value) => sum + value, 0) / durationsMs.length).toFixed(2));
      moduleResult.p95Ms = Number(percentile(durationsMs, 0.95).toFixed(2));
      moduleResult.maxMs = Number(Math.max(...durationsMs).toFixed(2));
      moduleResult.passed = (
        moduleResult.cycles === cyclesPerOwner
        && moduleResult.idempotentReplays === cyclesPerOwner
        && moduleResult.targetResidueMismatches === 0
        && moduleResult.sentinelIsolationMismatches === 0
        && moduleResult.operationPrivacyMismatches === 0
      );
      report.modules.push(moduleResult);
    }

    runtime.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    runtime.db.exec('PRAGMA incremental_vacuum;');
    const operationCount = Number(
      runtime.db.prepare('SELECT COUNT(*) AS count FROM account_removal_operations').get().count,
    );
    assert.equal(operationCount, cyclesPerOwner * OWNER_TYPES.length);
    report.persistedCompletedOperationCount = operationCount;
    const ozonIdentityTombstoneCount = Number(runtime.db.prepare(`
      SELECT COUNT(*) AS count
      FROM shop_identity_tombstones
      WHERE former_shop_id = 'stress-target-ozon_shop'
    `).get().count);
    assert.equal(ozonIdentityTombstoneCount, expectedOzonIdentityTombstones);
    report.expectedIdentityAuditRetention = {
      ownerType: 'ozon_shop',
      resource: 'shop_identity_tombstones.former_shop_id',
      reason: 'same-id rebind protection and old-generation rejection',
      rows: ozonIdentityTombstoneCount,
      containsSecret: false,
    };

    await runtime.app.close();
    runtime.app = null;
    runtime.db.close();
    runtime.db = null;

    assert.equal(new Set(deletedRawSecrets).size, cyclesPerOwner * 5);
    const inspectedSqliteFiles = assertNoRawResidue(
      [databasePath, `${databasePath}-wal`, `${databasePath}-shm`],
      [...new Set([...deletedRawSecrets, ...deletedOwnerIdsThatMustBeErased])],
    );
    report.rawSqliteResidueScan = {
      checkedSecrets: new Set(deletedRawSecrets).size,
      checkedNonOzonOwnerIds: new Set(deletedOwnerIdsThatMustBeErased).size,
      database: inspectedSqliteFiles.includes(databasePath),
      wal: inspectedSqliteFiles.includes(`${databasePath}-wal`),
      shm: inspectedSqliteFiles.includes(`${databasePath}-shm`),
      sidecarsAbsentAfterCheckpoint: !existsSync(`${databasePath}-wal`) && !existsSync(`${databasePath}-shm`),
      matches: 0,
    };
    report.passed = report.modules.every((moduleResult) => moduleResult.passed === true);
    assert.equal(report.passed, true);
  } finally {
    if (runtime.app) await runtime.app.close().catch(() => undefined);
    if (runtime.db) runtime.db.close();
    report.finishedAt = new Date().toISOString();
    report.durationMs = Number((performance.now() - startedMs).toFixed(2));
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    cleanupWorkRoot();
    report.temporaryDatabaseCleaned = !existsSync(workRoot);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
