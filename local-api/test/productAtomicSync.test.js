import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/db/database.js';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import {
  createProductSyncRunRepository,
  normalizeProductSyncCoverageProof,
} from '../src/db/repositories/productSyncRunRepository.js';

function createFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  const shops = createShopRepository(db);
  shops.saveShop({
    id: 'shop_atomic',
    profileId: 'profile_atomic',
    name: 'Atomic shop',
    clientId: 'client-atomic',
    apiKey: 'key-atomic',
    status: 'active',
  });
  db.exec(`CREATE TABLE product_atomic_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.prepare(`INSERT INTO product_atomic_probe (id, value) VALUES ('active', 'old')`).run();
  return { db, repository: createProductSyncRunRepository(db) };
}

function createFetchingRun(repository, suffix = 'base') {
  const created = repository.createRun({
    runId: `run_${suffix}`,
    shopId: 'shop_atomic',
    mode: 'incremental',
    visibility: 'ARCHIVED',
    requestFingerprint: `fingerprint_${suffix}`,
    contractHash: 'product-list-contract-v1',
    mapperVersion: 'product-mapper-v1',
  });
  assert.equal(created.reused, false);
  return repository.startFetching(created.run.runId, {
    leaseOwner: `worker_${suffix}`,
    leaseExpiresAt: '2099-01-01T00:00:00.000Z',
  });
}

function stageTerminalList(repository, runId, rows = [{ product_id: 'p-1', offer_id: 'offer-1' }]) {
  repository.stageBatch({
    runId,
    stageKind: 'list',
    endpointKey: 'products.list',
    facet: 'identity',
    visibility: 'ARCHIVED',
    batchIndex: 1,
    requestCursor: null,
    nextCursor: null,
    rows,
    actualProductIds: rows.map((row) => row.product_id),
    actualOfferIds: rows.map((row) => row.offer_id),
    responseHash: 'list-response-hash',
    contractVersion: 'product-list-contract-v1',
    mapperVersion: 'product-list-mapper-v1',
  });
  repository.recordPageProof({
    runId,
    visibility: 'ARCHIVED',
    pageIndex: 1,
    requestCursor: null,
    nextCursor: null,
    rowCount: rows.length,
    pageLimit: 1000,
    isShortPage: true,
    isTerminal: true,
    responseHash: 'list-response-hash',
    contractVersion: 'product-list-contract-v1',
    mapperVersion: 'product-list-mapper-v1',
  });
}

function stagePriceFacet(repository, runId) {
  repository.stageBatch({
    runId,
    stageKind: 'facet',
    endpointKey: 'products.prices',
    facet: 'prices',
    batchIndex: 1,
    expectedProductIds: ['p-1'],
    actualProductIds: ['p-1'],
    rows: [{ product_id: 'p-1', offer_id: 'offer-1', price: '55.16' }],
    responseHash: 'price-response-hash',
    contractVersion: 'product-price-contract-v5',
    mapperVersion: 'product-price-mapper-v2',
  });
}

const COMPLETE_COVERAGE = {
  facets: {
    identity: { expected: 1, returned: 1 },
    prices: { expected: 1, returned: 1 },
  },
};

test('product atomic run stages network results and commits facts, cursor, snapshot and outbox once', () => {
  const { db, repository } = createFixture();
  const run = createFetchingRun(repository, 'success');
  stageTerminalList(repository, run.runId);
  stagePriceFacet(repository, run.runId);
  const proving = repository.markProving(run.runId, COMPLETE_COVERAGE);
  assert.equal(proving.status, 'proving');
  const activated = repository.activateRun(run.runId, {
    snapshotId: 'snapshot-success',
    apply({ batches, proof }) {
      assert.equal(batches.length, 2);
      assert.equal(proof.coverage.expected, 2);
      db.prepare(`UPDATE product_atomic_probe SET value = 'new' WHERE id = 'active'`).run();
      return { changed: 1 };
    },
  });
  assert.equal(activated.run.status, 'completed');
  assert.equal(activated.run.activatedSnapshotId, 'snapshot-success');
  assert.equal(db.prepare(`SELECT value FROM product_atomic_probe WHERE id = 'active'`).get().value, 'new');
  const outbox = repository.listPendingOutbox();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].eventType, 'ProductSnapshotActivated');
  assert.equal(outbox[0].payload.proofHash, activated.run.proofHash);
  const compacted = repository.listStagedBatches(run.runId);
  assert.equal(compacted.length, 2);
  assert.equal(compacted.every((batch) => batch.rows.length === 0), true);
  assert.equal(compacted.reduce((sum, batch) => sum + batch.rowCount, 0), 2);
  db.close();
});

test('interrupted fifty-product sync reuses one run and overwrites the same staged batch', () => {
  const { db, repository } = createFixture();
  const rows = Array.from({ length: 50 }, (_, index) => ({
    product_id: `product-${index + 1}`,
    offer_id: `old-offer-${index + 1}`,
  }));
  const run = createFetchingRun(repository, 'retry-fifty');
  repository.stageBatch({
    runId: run.runId,
    batchKey: 'identity-page-1',
    stageKind: 'list',
    endpointKey: 'products.list',
    facet: 'identity',
    visibility: 'ARCHIVED',
    batchIndex: 1,
    rows,
    actualProductIds: rows.map((row) => row.product_id),
    actualOfferIds: rows.map((row) => row.offer_id),
    responseHash: 'first-response',
    contractVersion: 'product-list-contract-v1',
    mapperVersion: 'product-list-mapper-v1',
  });
  repository.failRun(run.runId, {
    status: 'interrupted',
    errorCode: 'PRODUCT_SYNC_FETCH_OR_MAP_FAILED',
  });

  const reused = repository.createRun({
    runId: 'must-not-create-a-second-run',
    shopId: 'shop_atomic',
    mode: 'incremental',
    visibility: 'ARCHIVED',
    requestFingerprint: 'fingerprint_retry-fifty',
    contractHash: 'product-list-contract-v1',
    mapperVersion: 'product-mapper-v1',
  });
  assert.equal(reused.reused, true);
  assert.equal(reused.run.runId, run.runId);
  repository.startFetching(run.runId, {
    leaseOwner: 'worker-retry-fifty',
    leaseExpiresAt: '2099-01-01T00:00:00.000Z',
  });
  const retriedRows = rows.map((row, index) => ({
    ...row,
    offer_id: `changed-offer-${index + 1}`,
  }));
  repository.stageBatch({
    runId: run.runId,
    batchKey: 'identity-page-1',
    stageKind: 'list',
    endpointKey: 'products.list',
    facet: 'identity',
    visibility: 'ARCHIVED',
    batchIndex: 1,
    rows: retriedRows,
    actualProductIds: retriedRows.map((row) => row.product_id),
    actualOfferIds: retriedRows.map((row) => row.offer_id),
    responseHash: 'retry-response',
    contractVersion: 'product-list-contract-v1',
    mapperVersion: 'product-list-mapper-v1',
  });

  assert.equal(db.prepare('SELECT COUNT(*) count FROM product_sync_runs').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM product_sync_stage_batches').get().count, 1);
  const batch = repository.listStagedBatches(run.runId)[0];
  assert.equal(batch.rows.length, 50);
  assert.equal(batch.rows[0].offer_id, 'changed-offer-1');
  db.close();
});

for (const failurePoint of ['outbox', 'commit']) {
  test(`product atomic activation rolls every fact back when ${failurePoint} injection fails`, () => {
    const { db, repository } = createFixture();
    const run = createFetchingRun(repository, `rollback_${failurePoint}`);
    stageTerminalList(repository, run.runId);
    stagePriceFacet(repository, run.runId);
    repository.markProving(run.runId, COMPLETE_COVERAGE);
    assert.throws(
      () => repository.activateRun(run.runId, {
        snapshotId: `snapshot-${failurePoint}`,
        apply() {
          db.prepare(`UPDATE product_atomic_probe SET value = 'partial' WHERE id = 'active'`).run();
        },
        ...(failurePoint === 'outbox'
          ? { beforeOutbox() { throw new Error('INJECT_OUTBOX_FAILURE'); } }
          : { beforeCommit() { throw new Error('INJECT_COMMIT_FAILURE'); } }),
      }),
      new RegExp(`INJECT_${failurePoint.toUpperCase()}_FAILURE`, 'u'),
    );
    assert.equal(db.prepare(`SELECT value FROM product_atomic_probe WHERE id = 'active'`).get().value, 'old');
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM product_sync_outbox`).get().count, 0);
    assert.equal(repository.getRun(run.runId).status, 'invalid');
    assert.equal(repository.listStagedBatches(run.runId).length, 2, 'staging remains for diagnosis/retry');
    db.close();
  });
}

test('product atomic proof rejects an incomplete cursor chain and never exposes staged rows', () => {
  const { db, repository } = createFixture();
  const run = createFetchingRun(repository, 'cursor');
  repository.stageBatch({
    runId: run.runId,
    stageKind: 'list',
    endpointKey: 'products.list',
    facet: 'identity',
    visibility: 'ARCHIVED',
    batchIndex: 1,
    nextCursor: 'next-page',
    rows: [{ product_id: 'p-1' }],
    actualProductIds: ['p-1'],
    responseHash: 'page-one',
    contractVersion: 'product-list-contract-v1',
    mapperVersion: 'product-list-mapper-v1',
  });
  repository.recordPageProof({
    runId: run.runId,
    visibility: 'ARCHIVED',
    pageIndex: 1,
    nextCursor: 'next-page',
    rowCount: 1,
    pageLimit: 1,
    isShortPage: false,
    isTerminal: false,
    responseHash: 'page-one',
    contractVersion: 'product-list-contract-v1',
    mapperVersion: 'product-list-mapper-v1',
  });
  assert.throws(() => repository.markProving(run.runId, {
    facets: { identity: { expected: 1, returned: 1 } },
  }), /PRODUCT_SYNC_INCOMPLETE_PAGINATION/u);
  assert.equal(db.prepare(`SELECT value FROM product_atomic_probe WHERE id = 'active'`).get().value, 'old');
  assert.equal(repository.getRun(run.runId).status, 'fetching');
  db.close();
});

test('product atomic proof rejects offer-only identity and waits for Ozon product_id', () => {
  const { db, repository } = createFixture();
  const run = createFetchingRun(repository, 'product-id-required');
  stageTerminalList(repository, run.runId, [{ offer_id: 'editable-offer-only' }]);
  assert.throws(() => repository.markProving(run.runId, {
    facets: { identity: { expected: 1, returned: 1 } },
  }), /PRODUCT_SYNC_LIST_PRODUCT_ID_REQUIRED/u);
  assert.equal(repository.getRun(run.runId).status, 'fetching');
  db.close();
});

test('coverage equation distinguishes source gaps from failures and only source gaps may activate', () => {
  assert.throws(() => normalizeProductSyncCoverageProof({
    facets: { prices: { expected: 2, returned: 1 } },
  }), /PRODUCT_SYNC_COVERAGE_EQUATION_INVALID/u);

  const { db, repository } = createFixture();
  const run = createFetchingRun(repository, 'source_gap');
  stageTerminalList(repository, run.runId);
  repository.markProving(run.runId, {
    facets: {
      identity: { expected: 1, returned: 1 },
      prices: { expected: 1, notReturned: 1 },
    },
  });
  const activated = repository.activateRun(run.runId, {
    snapshotId: 'snapshot-gap',
    apply() {
      db.prepare(`UPDATE product_atomic_probe SET value = 'gap-safe' WHERE id = 'active'`).run();
    },
  });
  assert.equal(activated.run.status, 'completed_with_source_gaps');
  assert.equal(repository.listPendingOutbox()[0].eventType, 'ProductSnapshotActivatedWithSourceGaps');

  const failed = createFetchingRun(repository, 'failed_facet');
  stageTerminalList(repository, failed.runId);
  assert.throws(() => repository.markProving(failed.runId, {
    facets: {
      identity: { expected: 1, returned: 1 },
      prices: { expected: 1, failed: 1 },
    },
  }), /PRODUCT_SYNC_COVERAGE_FAILED/u);
  repository.failRun(failed.runId, { status: 'failed', errorCode: 'FETCH_FAILED' });
  assert.equal(repository.getRun(failed.runId).status, 'failed');
  db.close();
});

test('shop incarnation and credential revision fence stale product callbacks', () => {
  const { db, repository } = createFixture();
  const run = createFetchingRun(repository, 'stale_fence');
  db.prepare(`
    UPDATE shops
       SET shop_incarnation = 'replacement-incarnation', credential_revision = credential_revision + 1
     WHERE id = 'shop_atomic'
  `).run();
  assert.throws(() => stageTerminalList(repository, run.runId), /PRODUCT_SYNC_SHOP_INCARNATION_STALE/u);
  assert.equal(repository.getRun(run.runId).status, 'fetching');
  assert.equal(db.prepare(`SELECT value FROM product_atomic_probe WHERE id = 'active'`).get().value, 'old');
  db.close();
});

test('expired persistent leases become interrupted without deleting staging', () => {
  const { db, repository } = createFixture();
  const created = repository.createRun({
    runId: 'run_expired',
    shopId: 'shop_atomic',
    mode: 'incremental',
    visibility: 'ALL',
    requestFingerprint: 'fingerprint_expired',
    contractHash: 'contract',
    mapperVersion: 'mapper',
  }).run;
  repository.startFetching(created.runId, {
    leaseOwner: 'worker-expired',
    leaseExpiresAt: '2000-01-01T00:00:00.000Z',
  });
  const recovery = repository.recoverExpiredRuns('2026-07-16T00:00:00.000Z');
  assert.equal(recovery.interrupted, 1);
  assert.equal(repository.getRun(created.runId).status, 'interrupted');
  db.close();
});

test('retention compacts old terminal failures but never removes interrupted retry payloads', () => {
  const { db, repository } = createFixture();
  const failed = createFetchingRun(repository, 'old-failed');
  stageTerminalList(repository, failed.runId);
  repository.failRun(failed.runId, { status: 'failed', errorCode: 'NON_RECOVERABLE' });
  db.prepare(`UPDATE product_sync_runs SET finished_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`)
    .run(failed.runId);

  const interrupted = createFetchingRun(repository, 'old-interrupted');
  stageTerminalList(repository, interrupted.runId);
  repository.failRun(interrupted.runId, { status: 'interrupted', errorCode: 'RETRY_LATER' });
  db.prepare(`UPDATE product_sync_runs SET finished_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`)
    .run(interrupted.runId);

  const cleanup = repository.compactExpiredTerminalStagePayloads({
    at: '2026-08-27T00:00:00.000Z',
    shopId: 'shop_atomic',
  });
  assert.equal(cleanup.compactedBatches, 1);
  assert.equal(repository.listStagedBatches(failed.runId)[0].rows.length, 0);
  assert.equal(repository.listStagedBatches(interrupted.runId)[0].rows.length, 1);
  db.close();
});

test('retention keeps only the newest resumable interrupted payload for one shop fingerprint', () => {
  const { db, repository } = createFixture();
  const oldRun = createFetchingRun(repository, 'superseded-old');
  stageTerminalList(repository, oldRun.runId);
  repository.failRun(oldRun.runId, { status: 'interrupted', errorCode: 'RETRY_OLD' });
  db.prepare(`UPDATE product_sync_runs SET created_at = '2026-08-20T00:00:00.000Z' WHERE id = ?`)
    .run(oldRun.runId);

  const newestRun = createFetchingRun(repository, 'superseded-new');
  db.prepare(`UPDATE product_sync_runs SET request_fingerprint = ?, created_at = '2026-08-21T00:00:00.000Z' WHERE id = ?`)
    .run('fingerprint_superseded-old', newestRun.runId);
  stageTerminalList(repository, newestRun.runId);
  repository.failRun(newestRun.runId, { status: 'interrupted', errorCode: 'RETRY_NEW' });

  const cleanup = repository.compactExpiredTerminalStagePayloads({
    at: '2026-08-27T00:00:00.000Z',
    shopId: 'shop_atomic',
  });
  assert.equal(cleanup.compactedBatches, 1);
  assert.equal(repository.listStagedBatches(oldRun.runId)[0].rows.length, 0);
  assert.equal(repository.listStagedBatches(newestRun.runId)[0].rows.length, 1);
  db.close();
});

test('full, bootstrap, and reconcile modes cannot masquerade as a single visibility run', () => {
  const { db, repository } = createFixture();
  for (const mode of ['full', 'bootstrap', 'reconcile']) {
    assert.throws(() => repository.createRun({
      runId: `run_fake_${mode}`,
      shopId: 'shop_atomic',
      mode,
      visibility: 'ARCHIVED',
      requestFingerprint: `fingerprint_fake_${mode}`,
      contractHash: 'contract',
      mapperVersion: 'mapper',
    }), /PRODUCT_SYNC_FULL_RUN_SCOPE_REQUIRED/u);
  }
  db.close();
});
