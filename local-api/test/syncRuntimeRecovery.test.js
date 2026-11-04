import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createProductSyncRunRepository } from '../src/db/repositories/productSyncRunRepository.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createOzonScheduler } from '../src/ozon/ozonScheduler.js';
import { createSyncJobService } from '../src/sync/syncJobService.js';
import { createSyncLockService } from '../src/sync/syncLockService.js';
import { createSyncStateService } from '../src/sync/syncStateService.js';
import { SYNC_PROCESS_RESTART_INTERRUPTED } from '../src/sync/syncRuntimeRecoveryService.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

process.env.LOCAL_API_SECRET = 'unit-local-master-material';

test('a fresh local-api process reconciles durable jobs, leases, attempts, snapshots, and product staging before retry', async () => {
  const tempRoot = resolve('.tmp');
  mkdirSync(tempRoot, { recursive: true });
  const tempDirectory = mkdtempSync(resolve(tempRoot, 'sync-runtime-recovery-'));
  const databasePath = resolve(tempDirectory, 'runtime.sqlite');
  let db = createMigratedTestDb(databasePath);

  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop-runtime-restart');
    const oldJobId = 'ozon-job-before-crash';
    const cacheKey = 'catalog:test:restart-recovery';
    const jobs = createSyncJobService(db);
    jobs.createJob({
      id: oldJobId,
      shopId,
      domain: 'catalog',
      endpointKey: 'catalog.categoryTree',
      action: 'sync',
      status: 'running',
      requestFingerprint: 'request-before-crash',
      cacheKey,
      lockKey: `catalog::${shopId}::${cacheKey}`,
    });
    jobs.updateJob(oldJobId, {
      status: 'running',
      startedAt: '2026-07-16T00:00:00.000Z',
    });
    createSyncLockService(db).acquire({
      domain: 'catalog',
      shopId,
      cacheKey,
      ownerJobId: oldJobId,
      ttlMs: 24 * 60 * 60 * 1000,
    });
    createSyncStateService(db).upsertState({
      domain: 'catalog',
      shopId,
      scopeKey: cacheKey,
      status: 'running',
    });
    db.prepare(`
      INSERT INTO ozon_request_attempts (
        id, job_id, request_id, shop_id, endpoint_key, status, attempt, created_at
      ) VALUES (?, ?, ?, ?, ?, 'running', 1, ?)
    `).run(
      'attempt-before-crash',
      oldJobId,
      'request-before-crash',
      shopId,
      'catalog.categoryTree',
      '2026-07-16T00:00:00.000Z',
    );
    db.prepare(`
      INSERT INTO ozon_sync_snapshots (
        id, domain, shop_id, source, status, active, source_job_id, created_at
      ) VALUES (?, 'catalog', ?, 'continuous-sync', 'running', 0, ?, ?)
    `).run('snapshot-before-crash', shopId, oldJobId, '2026-07-16T00:00:00.000Z');
    db.prepare(`
      INSERT INTO ozon_sync_snapshots (
        id, domain, shop_id, source, status, active, row_count, created_at,
        activated_at, finished_at
      ) VALUES (?, 'products', ?, 'continuous-sync', 'running', 0, 1, ?, NULL, NULL)
    `).run(
      'snapshot-committed-before-crash',
      shopId,
      '2026-07-15T23:59:00.000Z',
    );
    db.prepare(`
      INSERT INTO sync_jobs (
        id, shop_id, module, status, started_at, created_at, updated_at
      ) VALUES (?, ?, 'products', 'running', ?, ?, ?)
    `).run(
      'legacy-job-before-crash',
      shopId,
      '2026-07-16T00:00:00.000Z',
      '2026-07-16T00:00:00.000Z',
      '2026-07-16T00:00:00.000Z',
    );
    db.prepare(`
      INSERT INTO sync_state (
        shop_id, module, status, last_attempt_at, created_at, updated_at
      ) VALUES (?, 'products', 'syncing', ?, ?, ?)
    `).run(
      shopId,
      '2026-07-16T00:00:00.000Z',
      '2026-07-16T00:00:00.000Z',
      '2026-07-16T00:00:00.000Z',
    );

    const productRuns = createProductSyncRunRepository(db);
    const productFingerprint = 'product-request-before-crash';
    const created = productRuns.createRun({
      runId: 'product-run-before-crash',
      shopId,
      mode: 'incremental',
      visibility: 'ALL',
      requestFingerprint: productFingerprint,
      contractHash: 'contract-v1',
      mapperVersion: 'mapper-v1',
    }).run;
    productRuns.startFetching(created.runId, {
      leaseOwner: 'previous-process-owner',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    productRuns.stageBatch({
      runId: created.runId,
      stageKind: 'list',
      endpointKey: 'products.list',
      facet: 'identity',
      visibility: 'ALL',
      batchIndex: 1,
      rows: [{ product_id: 101, offer_id: 'restart-101' }],
      actualProductIds: ['101'],
      actualOfferIds: ['restart-101'],
      responseHash: 'response-before-crash',
      contractVersion: 'contract-v1',
      mapperVersion: 'mapper-v1',
      status: 'returned',
    });
    const shopFence = shopRepository.getShopCredentialsForInternalUse(shopId);
    db.prepare(`
      INSERT INTO product_sync_runs (
        id, shop_id, shop_incarnation, credential_revision, mode, visibility,
        request_fingerprint, status, contract_hash, mapper_version,
        activated_snapshot_id, created_at, started_at, updated_at, finished_at
      ) VALUES (?, ?, ?, ?, 'incremental', 'ALL', ?, 'completed', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'product-run-committed-before-crash',
      shopId,
      shopFence.shopIncarnation,
      shopFence.credentialRevision,
      'product-committed-fingerprint',
      'contract-v1',
      'mapper-v1',
      'snapshot-committed-before-crash',
      '2026-07-15T23:59:00.000Z',
      '2026-07-15T23:59:00.000Z',
      '2026-07-15T23:59:01.000Z',
      '2026-07-15T23:59:01.000Z',
    );
    db.prepare(`
      INSERT INTO product_sync_outbox (
        event_id, shop_id, run_id, snapshot_id, event_type, payload_json,
        payload_hash, status, attempts, available_at, created_at
      ) VALUES (?, ?, ?, ?, 'ProductSnapshotActivated', '{}', ?, 'pending', 0, ?, ?)
    `).run(
      'product-outbox-committed-before-crash',
      shopId,
      'product-run-committed-before-crash',
      'snapshot-committed-before-crash',
      'committed-payload-hash',
      '2026-07-15T23:59:01.000Z',
      '2026-07-15T23:59:01.000Z',
    );
    db.close();

    // Opening the persisted file models a new local-api process/Database owner.
    db = new DatabaseSync(databasePath);
    db.exec('PRAGMA foreign_keys = ON;');
    const restartedShopRepository = createShopRepository(db);
    const scheduler = createOzonScheduler({
      db,
      shopRepository: restartedShopRepository,
      logger: () => {},
      queueOptions: { shopConcurrency: 1, endpointConcurrency: 1 },
      ozonClient: {
        async requestReadOnly() {
          return { ok: true, status: 200, data: { result: [{ id: 'after-restart' }] } };
        },
      },
    });

    const recovery = scheduler.getSchedulerStatus().startupRecovery;
    assert.equal(recovery.requestJobs, 1);
    assert.equal(recovery.requestAttempts, 1);
    assert.equal(recovery.requestLocks, 1);
    assert.equal(recovery.requestStates, 1);
    assert.equal(recovery.snapshots, 1);
    assert.equal(recovery.committedSnapshotsRecovered, 1);
    assert.equal(recovery.productRuns, 1);
    assert.equal(recovery.legacyJobs, 1);
    assert.equal(recovery.legacyStates, 1);

    const oldJob = db.prepare(`
      SELECT status, last_error, finished_at FROM ozon_request_jobs WHERE id = ?
    `).get(oldJobId);
    assert.equal(oldJob.status, 'failed');
    assert.equal(oldJob.last_error, SYNC_PROCESS_RESTART_INTERRUPTED);
    assert.ok(oldJob.finished_at);
    assert.deepEqual(
      { ...db.prepare(`SELECT status, error_message, finished_at FROM ozon_request_attempts WHERE id = ?`)
        .get('attempt-before-crash') },
      {
        status: 'failed',
        error_message: SYNC_PROCESS_RESTART_INTERRUPTED,
        finished_at: recovery.recoveredAt,
      },
    );
    assert.equal(
      db.prepare(`SELECT status FROM ozon_sync_locks WHERE owner_job_id = ?`).get(oldJobId).status,
      'expired',
    );
    assert.equal(
      db.prepare(`SELECT status FROM ozon_sync_snapshots WHERE id = ?`).get('snapshot-before-crash').status,
      'failed',
    );
    assert.deepEqual(
      { ...db.prepare(`SELECT status, active FROM ozon_sync_snapshots WHERE id = ?`)
        .get('snapshot-committed-before-crash') },
      { status: 'success', active: 1 },
      'a snapshot committed before the crash remains active',
    );
    assert.equal(
      db.prepare(`SELECT status FROM sync_jobs WHERE id = ?`).get('legacy-job-before-crash').status,
      'failed',
    );
    assert.equal(
      db.prepare(`SELECT status FROM sync_state WHERE shop_id = ? AND module = 'products'`).get(shopId).status,
      'failed',
    );

    const recoveredProductRun = createProductSyncRunRepository(db).getRun(created.runId);
    assert.equal(recoveredProductRun.status, 'interrupted');
    assert.equal(recoveredProductRun.errorCode, SYNC_PROCESS_RESTART_INTERRUPTED);
    assert.equal(recoveredProductRun.leaseOwner, null);
    assert.equal(recoveredProductRun.leaseExpiresAt, null);
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM product_sync_stage_batches WHERE run_id = ?`)
        .get(created.runId).count,
      1,
      'staging remains available as recovery evidence',
    );
    assert.deepEqual(
      { ...db.prepare(`
        SELECT status, activated_snapshot_id, error_code
          FROM product_sync_runs WHERE id = ?
      `).get('product-run-committed-before-crash') },
      {
        status: 'completed',
        activated_snapshot_id: 'snapshot-committed-before-crash',
        error_code: null,
      },
      'a product run committed before the crash is not downgraded',
    );
    assert.equal(
      db.prepare(`SELECT status FROM product_sync_outbox WHERE event_id = ?`)
        .get('product-outbox-committed-before-crash').status,
      'pending',
      'a committed pending outbox event remains publishable',
    );

    const retried = await scheduler.executeReadOnly({
      shopId,
      domain: 'catalog',
      endpointKey: 'catalog.categoryTree',
      action: 'sync',
      params: { language: 'DEFAULT' },
      cacheKey,
      forceRefresh: true,
    });
    assert.equal(retried.status, 'success');
    assert.notEqual(retried.jobId, oldJobId);

    const replacementRun = createProductSyncRunRepository(db).createRun({
      shopId,
      mode: 'incremental',
      visibility: 'ALL',
      requestFingerprint: productFingerprint,
      contractHash: 'contract-v1',
      mapperVersion: 'mapper-v1',
    });
    assert.equal(replacementRun.reused, true);
    assert.equal(replacementRun.run.runId, created.runId);
    assert.equal(replacementRun.run.status, 'interrupted');
  } finally {
    try {
      db?.close();
    } catch {
      // The seed connection may already have been closed before reopening.
    }
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

