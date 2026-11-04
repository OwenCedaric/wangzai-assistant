import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createPurchaseAccountRepository } from '../../db/repositories/purchaseAccountRepository.js';
import { createAccountRemovalOperationRepository } from '../../db/repositories/accountRemovalOperationRepository.js';
import { createAccountRemovalPlanner } from './accountRemovalPlanner.js';
import { createAccountRemovalSqliteExecutor } from './accountRemovalSqliteExecutor.js';
import { createAccountRemovalVerifier } from './accountRemovalVerifier.js';
import { createAccountRemovalOrchestrator, ACCOUNT_REMOVAL_CONFIRMATION_CODE } from './accountRemovalOrchestrator.js';
import { ACCOUNT_REMOVAL_SAFETY_BARRIER_VERSION } from './accountRemovalContract.js';
import { getAccountRemovalClientBarrierIds, isAccountRemovalServerVerifiedClientResource } from './accountRemovalClientResources.js';
import { accountRemovalOperationErrorCode } from './accountRemovalErrorClassifier.js';

process.env.LOCAL_API_SECRET = 'synthetic-removal-retry-concurrency-test-key';

function envelope(preview, idempotencyKey = 'synthetic-removal-retry-request-001') {
  const ids = getAccountRemovalClientBarrierIds(preview.owner.ownerType).sort();
  return {
    preview,
    confirm: { version: preview.version, contractVersion: preview.version, owner: preview.owner,
      requestedOwnerType: preview.requestedOwnerType, requestedOwnerId: preview.requestedOwnerId,
      requestedResourceIdsSemantics: preview.requestedResourceIdsSemantics, requestedResourceIds: preview.requestedResourceIds,
      catalogVersion: preview.catalogVersion, catalogFingerprint: preview.catalogFingerprint,
      resourceObservations: preview.resourceObservations, snapshotFingerprint: preview.snapshotFingerprint,
      previewFingerprint: preview.previewFingerprint, idempotencyKey },
    barrierProof: { version: ACCOUNT_REMOVAL_SAFETY_BARRIER_VERSION, owner: preview.owner,
      previewFingerprint: preview.previewFingerprint, fencedResourceIds: ids, drainedResourceIds: ids },
    confirmationCode: ACCOUNT_REMOVAL_CONFIRMATION_CODE,
  };
}

function fixture(t, overrides = {}) {
  const db = createMigratedTestDb(overrides.databasePath || ':memory:');
  t.after(() => { overrides.beforeClose?.(); db.close(); overrides.afterClose?.(); });
  const owner = { ownerType: 'purchase_account', ownerId: 'synthetic-retry-account' };
  createPurchaseAccountRepository(db).saveAccount({ id: owner.ownerId, name: 'Synthetic retry account', loginPassword: 'synthetic-password' });
  const counts = { executions: 0, quiesces: 0, transientReleases: 0, completions: 0, persistentReleases: 0 };
  const runtimeCoordinator = {
    observeResource: (_owner, resourceId) => ({ resourceId, state: 'absent' }),
    async quiesce() { counts.quiesces += 1; await overrides.quiesce?.(); },
    async quiesceOwnerWrites() { await overrides.prepareQuiesce?.(); },
    verify: () => ({ ok: true, failures: [], status: {} }),
    releaseOwner: () => { counts.persistentReleases += 1; return { ok: true }; },
    complete() { counts.completions += 1; },
    releaseTransientResources() { counts.transientReleases += 1; },
  };
  const planner = createAccountRemovalPlanner({ db, runtimeCoordinator });
  const repository = createAccountRemovalOperationRepository(db);
  const actualExecutor = createAccountRemovalSqliteExecutor({ db });
  const actualVerifier = createAccountRemovalVerifier({ db, runtimeCoordinator });
  function makeOrchestrator(options = {}) {
    return createAccountRemovalOrchestrator({ planner, operationRepository: repository, runtimeCoordinator,
      sqliteExecutor: { ...actualExecutor, execute(...args) {
        counts.executions += 1;
        if (!options.good) overrides.beforeExecute?.();
        return actualExecutor.execute(...args);
      } },
      verifier: { ...actualVerifier, verifyServer(...args) {
        const result = actualVerifier.verifyServer(...args);
        overrides.afterServerVerify?.(result);
        return result;
      } },
      dataBackupService: { reviewAccountRemoval: () => ({ required: false }), authorizeAccountRemoval: () => ({ outcome: 'not-required' }) },
      serverResourceCleanup: overrides.serverResourceCleanup,
      wait: overrides.wait || (async () => {}),
    });
  }
  return { db, owner, repository, counts, orchestrator: makeOrchestrator(), makeOrchestrator };
}

function clientProof(f, pending) {
  const operation = f.repository.getOperation(pending.operationId);
  for (const resourceId of operation.clientResourceIds) {
    if (isAccountRemovalServerVerifiedClientResource(operation.ownerType, resourceId)) {
      f.repository.recordTrustedClientResourceReceipt(operation.operationId, resourceId);
    }
  }
  return { operationId: operation.operationId, nonce: operation.clientCleanupNonce,
    previewFingerprint: operation.previewFingerprint,
    resourceObservations: operation.clientResourceIds.map((resourceId) => ({ resourceId, state: 'absent' })) };
}

function nativeBusyFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-native-busy-removal-test-'));
  const primary = new DatabaseSync(join(root, 'contention.sqlite'));
  primary.exec('PRAGMA busy_timeout=0; CREATE TABLE synthetic_probe(value INTEGER); INSERT INTO synthetic_probe VALUES(1)');
  const holder = new DatabaseSync(join(root, 'contention.sqlite'));
  holder.exec('BEGIN IMMEDIATE');
  t.after(() => {
    try { holder.exec('ROLLBACK'); } catch { /* already released by the test */ }
    holder.close(); primary.close(); rmSync(root, { recursive: true, force: true });
  });
  return { primary, holder };
}

function nativeLockedError() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE synthetic_probe(value INTEGER); INSERT INTO synthetic_probe VALUES(1),(2)');
  const iterator = db.prepare('SELECT * FROM synthetic_probe').iterate();
  iterator.next();
  try { db.exec('DROP TABLE synthetic_probe'); } catch (error) { return error; }
  finally { iterator.return?.(); db.close(); }
  throw new Error('TEST_EXPECTED_NATIVE_SQLITE_LOCKED');
}

test('native ERR_SQLITE_ERROR / errcode 5 writer contention is retried and transient barriers release without clearing pending owner lock', async (t) => {
  const lock = nativeBusyFixture(t);
  const waits = [];
  let observed;
  const f = fixture(t, { beforeExecute() {
    try { lock.primary.prepare('UPDATE synthetic_probe SET value=value+1').run(); }
    catch (error) { observed = error; throw error; }
  }, wait: async (ms) => { waits.push(ms); lock.holder.exec('COMMIT'); } });
  const { preview } = f.orchestrator.preview({ owner: f.owner });
  const pending = await f.orchestrator.confirm(envelope(preview));
  assert.equal(observed.code, 'ERR_SQLITE_ERROR');
  assert.equal(observed.errcode, 5);
  assert.deepEqual(waits, [250]);
  assert.equal(f.counts.executions, 2);
  assert.equal(pending.requiresClientCleanup, true);
  assert.ok(f.counts.transientReleases >= 1);
  assert.equal(f.counts.completions, 0);
  assert.equal(f.counts.persistentReleases, 0);
  assert.throws(() => f.orchestrator.assertOwnerWritable(f.owner), /ACCOUNT_REMOVAL_OWNER_LOCKED/);
});

test('native table-locked errcode 6 inside a normalized SQLite failure is classified as busy', async (t) => {
  const raw = nativeLockedError();
  assert.equal(raw.code, 'ERR_SQLITE_ERROR');
  assert.equal(raw.errcode, 6);
  let failed = false;
  const waits = [];
  const f = fixture(t, { beforeExecute() {
    if (failed) return;
    failed = true;
    const wrapped = new Error('ACCOUNT_REMOVAL_SQLITE_EXECUTION_FAILED', { cause: raw });
    wrapped.code = 'ACCOUNT_REMOVAL_SQLITE_EXECUTION_FAILED';
    throw wrapped;
  }, wait: async (ms) => waits.push(ms) });
  const { preview } = f.orchestrator.preview({ owner: f.owner });
  const pending = await f.orchestrator.confirm(envelope(preview));
  assert.deepEqual(waits, [250]);
  assert.equal(pending.requiresClientCleanup, true);
});

test('exhausted native locks remain resumable in the same durable operation after reconstruction', async (t) => {
  const raw = nativeLockedError();
  const waits = [];
  const f = fixture(t, { beforeExecute() { throw raw; }, wait: async (ms) => waits.push(ms) });
  const { preview } = f.orchestrator.preview({ owner: f.owner });
  await assert.rejects(f.orchestrator.confirm(envelope(preview)), { code: 'ACCOUNT_REMOVAL_DATABASE_BUSY' });
  assert.deepEqual(waits, [250, 500, 1000, 1500, 2000, 3000]);
  const failed = f.repository.findActiveByOwner(f.owner);
  assert.equal(failed.status, 'retryable-failed');
  assert.equal(failed.lastErrorCode, 'ACCOUNT_REMOVAL_DATABASE_BUSY');
  assert.equal(f.counts.persistentReleases, 0);
  const resumed = await f.makeOrchestrator({ good: true }).recover(f.owner);
  assert.equal(resumed.operationId, failed.operationId);
  assert.equal(resumed.requiresClientCleanup, true);
  assert.equal(f.repository.listPending().length, 1);
});

test('concurrent identical confirmation and recovery share one deletion execution', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let cleanups = 0;
  const f = fixture(t, { serverResourceCleanup: { async cleanupOwner() { cleanups += 1; await gate; return { completed: true }; } } });
  const { preview } = f.orchestrator.preview({ owner: f.owner });
  const request = envelope(preview);
  const first = f.orchestrator.confirm(request);
  const second = f.orchestrator.confirm(request);
  await new Promise((resolve) => setImmediate(resolve));
  const recovery = f.orchestrator.recover(f.owner);
  await new Promise((resolve) => setImmediate(resolve));
  const observedCleanups = cleanups;
  release();
  const results = await Promise.allSettled([first, second, recovery]);
  assert.equal(observedCleanups, 1);
  assert.equal(f.counts.executions, 1);
  assert.ok(results.every((result) => result.status === 'fulfilled'));
  assert.equal(new Set(results.map((result) => result.value.operationId)).size, 1);
});

test('duplicate client-proof confirmations are idempotent while verification is still draining runtime', async (t) => {
  let release;
  let gated = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { quiesce: async () => { if (gated) await gate; } });
  const { preview } = f.orchestrator.preview({ owner: f.owner });
  const pending = await f.orchestrator.confirm(envelope(preview));
  const operation = f.repository.getOperation(pending.operationId);
  for (const resourceId of operation.clientResourceIds) {
    if (isAccountRemovalServerVerifiedClientResource(operation.ownerType, resourceId)) {
      f.repository.recordTrustedClientResourceReceipt(operation.operationId, resourceId);
    }
  }
  const proof = { operationId: operation.operationId, nonce: operation.clientCleanupNonce,
    previewFingerprint: operation.previewFingerprint,
    resourceObservations: operation.clientResourceIds.map((resourceId) => ({ resourceId, state: 'absent' })) };
  gated = true;
  const first = f.orchestrator.verifyClientCleanup(proof);
  const second = f.orchestrator.verifyClientCleanup(proof);
  const invalid = f.orchestrator.verifyClientCleanup({ ...proof, nonce: 'wrong-challenge' });
  await assert.rejects(invalid, /ACCOUNT_REMOVAL_CLIENT_CLEANUP_PROOF_INVALID/);
  release();
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every((result) => result.status === 'fulfilled'));
  assert.ok(results.every((result) => result.value.completed === true));
  assert.equal(f.counts.executions, 1);
  assert.equal(f.counts.completions, 1);
  assert.equal(f.repository.hasActiveOwner(f.owner), false);
  assert.ok(f.counts.transientReleases >= 2);
});

test('a lock on the operation journal itself retries even when the failure record cannot be written', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-removal-operation-lock-test-'));
  let holder;
  const waits = [];
  const f = fixture(t, {
    databasePath: join(root, 'operations.sqlite'),
    beforeClose() { try { holder?.exec('ROLLBACK'); } catch { /* already released */ } holder?.close(); },
    afterClose() { rmSync(root, { recursive: true, force: true }); },
    wait: async (ms) => { waits.push(ms); holder.exec('COMMIT'); },
  });
  holder = new DatabaseSync(join(root, 'operations.sqlite'));
  const begin = f.repository.beginOrReuse.bind(f.repository);
  f.repository.beginOrReuse = (input) => {
    const result = begin(input);
    holder.exec('BEGIN IMMEDIATE');
    return result;
  };
  const { preview } = f.orchestrator.preview({ owner: f.owner });
  const pending = await f.orchestrator.confirm(envelope(preview));
  assert.deepEqual(waits, [250]);
  assert.equal(f.counts.executions, 1);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.error, null);
  assert.equal(pending.requiresClientCleanup, true);
  assert.equal(f.counts.persistentReleases, 0);
});

test('explicit preservation/authorization errors and non-lock SQLite errors are not silently downgraded to retryable busy', () => {
  const busy = nativeLockedError();
  for (const code of ['ACCOUNT_REMOVAL_PRESERVATION_MISMATCH', 'ACCOUNT_REMOVAL_CLIENT_CLEANUP_PROOF_INVALID']) {
    const error = new Error('database is locked', { cause: busy });
    error.code = code;
    assert.equal(accountRemovalOperationErrorCode(error), code);
  }
  const constraint = new Error('constraint failed');
  Object.assign(constraint, { code: 'ERR_SQLITE_ERROR', errcode: 787 });
  assert.equal(accountRemovalOperationErrorCode(constraint), 'ERR_SQLITE_ERROR');
  const extendedBusy = new Error('extended native status');
  Object.assign(extendedBusy, { code: 'ERR_SQLITE_ERROR', errcode: 517 });
  assert.equal(accountRemovalOperationErrorCode(extendedBusy), 'ACCOUNT_REMOVAL_DATABASE_BUSY');
});

test('release-preview cannot lift a durable pending write fence, but completed explicit rebind is allowed', async (t) => {
  const f = fixture(t);
  assert.equal(f.orchestrator.releaseOwnerFence(f.owner).ok, true);
  assert.equal(f.counts.persistentReleases, 1);
  const { preview } = f.orchestrator.preview({ owner: f.owner });
  const pending = await f.orchestrator.confirm(envelope(preview));
  assert.throws(() => f.orchestrator.releaseOwnerFence(f.owner), /ACCOUNT_REMOVAL_OWNER_LOCKED/);
  assert.equal(f.counts.persistentReleases, 1);
  const completed = await f.orchestrator.verifyClientCleanup(clientProof(f, pending));
  assert.equal(completed.completed, true);
  assert.equal(f.orchestrator.assertOwnerAccountSave(f.owner, { allowRebind: true }).rebind, true);
  assert.equal(f.orchestrator.releaseOwnerFence(f.owner).ok, true);
  assert.equal(f.counts.persistentReleases, 2);
});

test('late failure after verified durable completion returns the existing completion without downgrading it', async (t) => {
  let f;
  f = fixture(t, { afterServerVerify(result) {
    assert.equal(result.ok, true);
    const operation = f.repository.findActiveByOwner(f.owner);
    f.repository.markCompleted(operation.operationId, { serverVerified: true, clientVerified: true });
    throw new Error('SYNTHETIC_LATE_POST_COMPLETION_FAILURE');
  } });
  const { preview } = f.orchestrator.preview({ owner: f.owner });
  const pending = await f.orchestrator.confirm(envelope(preview));
  const completed = await f.orchestrator.verifyClientCleanup(clientProof(f, pending));
  assert.equal(completed.completed, true);
  assert.equal(completed.error, null);
  assert.equal(f.repository.getOperation(completed.operationId).status, 'completed');
  assert.equal(f.counts.executions, 1);
  assert.equal(f.counts.completions, 1);
});

test('recovering a failed external-cleanup wait clears the stale failure while preserving its owner lock', async (t) => {
  const f = fixture(t);
  const { preview } = f.orchestrator.preview({ owner: f.owner });
  const pending = await f.orchestrator.confirm(envelope(preview));
  f.repository.recordFailure(pending.operationId, 'SYNTHETIC_PRIOR_RUNTIME_FAILURE');
  const resumed = await f.makeOrchestrator({ good: true }).recover(f.owner);
  assert.equal(resumed.status, 'pending');
  assert.equal(resumed.error, null);
  assert.equal(resumed.requiresClientCleanup, true);
  assert.equal(f.counts.executions, 1);
  assert.throws(() => f.orchestrator.releaseOwnerFence(f.owner), /ACCOUNT_REMOVAL_OWNER_LOCKED/);
});

test('a failed prepared preview cannot release an earlier unfinished removal fence', async (t) => {
  const f = fixture(t, { beforeExecute() { throw new Error('SYNTHETIC_EXECUTION_FAILURE'); },
    prepareQuiesce() { throw new Error('SYNTHETIC_PREVIEW_QUIESCE_FAILURE'); } });
  const { preview } = f.orchestrator.preview({ owner: f.owner });
  await assert.rejects(f.orchestrator.confirm(envelope(preview)));
  await assert.rejects(f.orchestrator.preparePreview({ owner: f.owner }), /SYNTHETIC_PREVIEW_QUIESCE_FAILURE/);
  assert.equal(f.counts.persistentReleases, 0);
  assert.equal(f.repository.hasActiveOwner(f.owner), true);
});

test('a native lock on initial operation INSERT is retried while release-preview remains fenced', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-removal-admission-lock-test-'));
  let holder;
  let f;
  const waits = [];
  f = fixture(t, { databasePath: join(root, 'operations.sqlite'),
    beforeClose() { try { holder?.exec('ROLLBACK'); } catch { /* released */ } holder?.close(); },
    afterClose() { rmSync(root, { recursive: true, force: true }); },
    wait: async (ms) => {
      waits.push(ms);
      assert.throws(() => f.orchestrator.releaseOwnerFence(f.owner), /ACCOUNT_REMOVAL_OWNER_LOCKED/);
      holder.exec('COMMIT');
    },
  });
  const { preview } = f.orchestrator.preview({ owner: f.owner });
  holder = new DatabaseSync(join(root, 'operations.sqlite'));
  holder.exec('BEGIN IMMEDIATE');
  const result = await f.orchestrator.confirm(envelope(preview));
  assert.deepEqual(waits, [250]);
  assert.equal(result.requiresClientCleanup, true);
  assert.equal(f.counts.executions, 1);
  assert.equal(f.counts.persistentReleases, 0);
});
