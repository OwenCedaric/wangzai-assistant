import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase, runMigrations } from "../src/db/database.js";
import { createShopRepository } from "../src/db/repositories/shopRepository.js";
import { createProductSyncRunRepository } from "../src/db/repositories/productSyncRunRepository.js";
import { createSyncJobService } from "../src/sync/syncJobService.js";
import { createSyncSnapshotService } from "../src/sync/syncSnapshotService.js";
import {
  resolveProductAtomicActivationDatabase,
  runProductAtomicActivationProcess,
} from "../src/domain/products/productAtomicActivationProcessRunner.js";

const ROWS_PER_PAGE = 1_000;
const PAGE_COUNT = 10;

test("10k product atomic activation stays in a child process and commits one snapshot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wangzai-product-activation-worker-"));
  const databasePath = join(directory, "worker.sqlite");
  const db = openDatabase({
    database: {
      path: databasePath,
      enableWal: true,
      busyTimeoutMs: 5_000,
    },
  });

  try {
    runMigrations(db);
    createShopRepository(db).saveShop({
      id: "shop_worker_10k",
      name: "Worker 10k shop",
      clientId: "worker-client",
      apiKey: "worker-key",
      status: "active",
    });
    const jobService = createSyncJobService(db);
    const snapshotService = createSyncSnapshotService(db);
    const atomicRunRepository = createProductSyncRunRepository(db);
    const job = jobService.createJob({
      id: "products_sync_worker_10k",
      domain: "products",
      shopId: "shop_worker_10k",
      status: "running",
    });
    const snapshot = snapshotService.createSnapshot({
      id: "snapshot_worker_10k",
      domain: "products",
      shopId: "shop_worker_10k",
      source: "worker-regression",
      status: "running",
      sourceJobId: job.jobId,
    });
    const run = atomicRunRepository.createRun({
      runId: `product_run_${job.jobId}`,
      shopId: "shop_worker_10k",
      mode: "incremental",
      visibility: "ALL",
      requestFingerprint: "worker-10k-fingerprint",
      contractHash: "worker-list-contract-v1",
      mapperVersion: "worker-list-mapper-v1",
    }).run;
    atomicRunRepository.startFetching(run.runId, {
      leaseOwner: "worker-regression",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    });

    let requestCursor = "";
    for (let page = 1; page <= PAGE_COUNT; page += 1) {
      const first = (page - 1) * ROWS_PER_PAGE;
      const rows = Array.from({ length: ROWS_PER_PAGE }, (_value, index) => {
        const id = first + index + 1;
        return {
          product_id: `worker-product-${id}`,
          offer_id: `worker-offer-${id}`,
          name: `Worker product ${id}`,
        };
      });
      const nextCursor = page === PAGE_COUNT ? "" : `worker-cursor-${page}`;
      const responseHash = `worker-page-hash-${page}`;
      atomicRunRepository.stageBatch({
        runId: run.runId,
        stageKind: "list",
        endpointKey: "products.list",
        facet: "identity",
        visibility: "ALL",
        batchIndex: page,
        requestCursor,
        nextCursor,
        rows,
        actualProductIds: rows.map((row) => row.product_id),
        actualOfferIds: rows.map((row) => row.offer_id),
        responseHash,
        contractVersion: "worker-list-contract-v1",
        mapperVersion: "worker-list-mapper-v1",
      });
      atomicRunRepository.recordPageProof({
        runId: run.runId,
        visibility: "ALL",
        pageIndex: page,
        requestCursor,
        nextCursor,
        rowCount: rows.length,
        pageLimit: ROWS_PER_PAGE,
        isShortPage: false,
        isTerminal: page === PAGE_COUNT,
        responseHash,
        contractVersion: "worker-list-contract-v1",
        mapperVersion: "worker-list-mapper-v1",
      });
      requestCursor = nextCursor;
    }
    atomicRunRepository.markProving(run.runId, {
      facets: {
        identity: { expected: ROWS_PER_PAGE * PAGE_COUNT, returned: ROWS_PER_PAGE * PAGE_COUNT },
      },
    });

    let workerStarted = false;
    let responsiveReads = 0;
    let maxReadMs = 0;
    const timer = setInterval(() => {
      if (!workerStarted) return;
      const startedAt = performance.now();
      const count = db.prepare("SELECT COUNT(*) AS count FROM shops").get().count;
      assert.equal(db.prepare("PRAGMA journal_mode;").get().journal_mode, "wal");
      assert.ok(Number.isInteger(db.prepare("PRAGMA user_version;").get().user_version));
      assert.ok(
        db.prepare("SELECT COUNT(*) AS count FROM sqlite_master").get().count > 0,
      );
      maxReadMs = Math.max(maxReadMs, performance.now() - startedAt);
      assert.equal(count, 1);
      responsiveReads += 1;
    }, 5);

    let result;
    try {
      result = await runProductAtomicActivationProcess(
        {
          database: resolveProductAtomicActivationDatabase(db),
          activation: {
            atomicRunId: run.runId,
            snapshotId: snapshot.id,
            shopId: "shop_worker_10k",
            shopName: "Worker 10k shop",
            jobId: job.jobId,
            visibility: "ALL",
            runVisibilities: ["ALL"],
            completedVisibilities: ["ALL"],
            allowVisibilityReconcile: false,
            notificationBeforeRows: [],
          },
        },
        {
          timeoutMs: 120_000,
          onStarted() {
            workerStarted = true;
          },
        },
      );
    } finally {
      clearInterval(timer);
    }

    assert.equal(result.finalJob.status, "success");
    assert.equal(result.activation.run.status, "completed");
    assert.equal(result.cacheRowCount, ROWS_PER_PAGE * PAGE_COUNT);
    assert.ok(responsiveReads >= 1, "main event loop must serve reads during activation");
    assert.ok(maxReadMs < 250, `read latency must stay bounded, observed ${maxReadMs.toFixed(1)}ms`);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM ozon_products WHERE shop_id = ?").get("shop_worker_10k").count,
      ROWS_PER_PAGE * PAGE_COUNT,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM product_sync_outbox WHERE run_id = ?").get(run.runId).count,
      1,
    );
    assert.equal(
      db.prepare("SELECT active FROM ozon_sync_snapshots WHERE id = ?").get(snapshot.id).active,
      1,
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
