import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createTraceController } from '../ozon/traceController.js';
import { createTechnicalArchiveService, TECHNICAL_ARCHIVE_POLICY } from './technicalArchiveService.js';
import { createTechnicalArchiveStore } from './technicalArchiveStore.js';

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE product_sync_runs (
      id TEXT PRIMARY KEY,
      shop_id TEXT,
      status TEXT,
      finished_at TEXT
    );
    CREATE TABLE product_sync_stage_batches (
      run_id TEXT,
      batch_key TEXT,
      stage_kind TEXT,
      batch_index INTEGER,
      normalized_rows_json TEXT,
      PRIMARY KEY (run_id, batch_key)
    );
    CREATE TABLE product_sync_page_proofs (
      run_id TEXT,
      visibility TEXT,
      page_index INTEGER,
      response_hash TEXT,
      PRIMARY KEY (run_id, visibility, page_index)
    );
    CREATE TABLE ozon_scheduler_trace_events (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      shop_id TEXT,
      phase TEXT,
      status TEXT,
      created_at TEXT
    );
    CREATE TABLE business_facts (id TEXT PRIMARY KEY, payload TEXT);
  `);
  return db;
}

function createStore(directory) {
  return createTechnicalArchiveStore({
    archiveDirectory: directory,
    encryptionKey: Buffer.alloc(32, 31),
    dedupeKey: Buffer.alloc(32, 37),
    logger: { warn() {} },
  });
}

function insertProductRun(db, id, finishedAt) {
  db.prepare('INSERT INTO product_sync_runs VALUES (?, ?, ?, ?)').run(id, 'shop-private', 'completed', finishedAt);
  db.prepare('INSERT INTO product_sync_stage_batches VALUES (?, ?, ?, ?, ?)')
    .run(id, `batch-${id}`, 'list', 0, `[{"private":"${id}"}]`);
  db.prepare('INSERT INTO product_sync_page_proofs VALUES (?, ?, ?, ?)')
    .run(id, 'all', 1, `hash-${id}`);
}

test('archive cycle keeps one hot day, archives days 2-7, and leaves business facts untouched', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wangzai-technical-service-'));
  const db = createDb();
  try {
    insertProductRun(db, 'run-eligible', '2026-07-24T12:00:00.000Z');
    insertProductRun(db, 'run-hot', '2026-07-28T12:00:00.000Z');
    insertProductRun(db, 'run-over-45', '2026-06-01T12:00:00.000Z');
    db.prepare('INSERT INTO ozon_scheduler_trace_events VALUES (?, ?, ?, ?, ?, ?)')
      .run('trace-eligible', 'job-eligible', 'shop-private', 'request', 'success', '2026-07-24T13:00:00.000Z');
    db.prepare('INSERT INTO ozon_scheduler_trace_events VALUES (?, ?, ?, ?, ?, ?)')
      .run('trace-hot', 'job-hot', 'shop-private', 'request', 'success', '2026-07-28T13:00:00.000Z');
    db.prepare('INSERT INTO ozon_scheduler_trace_events VALUES (?, ?, ?, ?, ?, ?)')
      .run('trace-over-45', 'job-old', 'shop-private', 'request', 'success', '2026-06-01T13:00:00.000Z');
    db.prepare('INSERT INTO business_facts VALUES (?, ?)').run('fact-1', 'must-survive');

    const service = createTechnicalArchiveService({
      db,
      store: createStore(directory),
      now: () => new Date('2026-07-29T12:00:00.000Z'),
      policy: { productRunsPerCycle: 10, tracePackagesPerCycle: 10 },
    });
    const result = service.runCycle();
    assert.equal(result.ok, true);
    assert.equal(result.hotRetentionDays, 1);
    assert.equal(result.totalRetentionDays, 7);
    assert.equal(result.archiveByteLimit, 2 * 1024 * 1024 * 1024);
    assert.equal(TECHNICAL_ARCHIVE_POLICY.productRunsPerCycle, 100);
    assert.equal(result.archivedPackages, 2);
    assert.equal(result.archivedRecords, 4);
    assert.equal(result.deletedHotRows, 3);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM product_sync_runs WHERE id = 'run-eligible'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM product_sync_stage_batches WHERE run_id = 'run-eligible'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM product_sync_page_proofs WHERE run_id = 'run-eligible'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM product_sync_stage_batches WHERE run_id IN ('run-hot', 'run-over-45')").get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM ozon_scheduler_trace_events WHERE id = 'trace-eligible'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM ozon_scheduler_trace_events WHERE id IN ('trace-hot', 'trace-over-45')").get().count, 2);
    assert.equal(db.prepare('SELECT payload FROM business_facts').get().payload, 'must-survive');

    const archivedTraces = service.listTraceEventsByJob('job-eligible');
    assert.equal(archivedTraces.length, 1);
    assert.equal(archivedTraces[0].id, 'trace-eligible');
    const traceController = createTraceController(db, { archiveReader: service });
    assert.equal(traceController.listByJob('job-eligible')[0].id, 'trace-eligible');
    assert.equal(service.inspect().packages.length, 2);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('archive publish failure leaves every selected SQLite row intact', () => {
  const db = createDb();
  try {
    db.prepare('INSERT INTO ozon_scheduler_trace_events VALUES (?, ?, ?, ?, ?, ?)')
      .run('trace-eligible', 'job-eligible', 'shop-private', 'request', 'success', '2026-07-24T13:00:00.000Z');
    const service = createTechnicalArchiveService({
      db,
      store: {
        pruneExpired: () => ({ deleted: [], errors: [] }),
        publish: () => { throw new Error('SIMULATED_ARCHIVE_PUBLISH_FAILURE'); },
      },
      now: () => new Date('2026-07-29T12:00:00.000Z'),
    });
    assert.throws(() => service.runCycle(), /SIMULATED_ARCHIVE_PUBLISH_FAILURE/);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM ozon_scheduler_trace_events WHERE id = 'trace-eligible'").get().count, 1);
  } finally {
    db.close();
  }
});

test('a restart after package publication reuses the verified archive then finishes SQLite deletion', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wangzai-technical-retry-'));
  const db = createDb();
  try {
    db.prepare('INSERT INTO ozon_scheduler_trace_events VALUES (?, ?, ?, ?, ?, ?)')
      .run('trace-retry', 'job-retry', 'shop-private', 'request', 'success', '2026-07-24T13:00:00.000Z');
    const store = createStore(directory);
    const row = db.prepare("SELECT * FROM ozon_scheduler_trace_events WHERE id = 'trace-retry'").get();
    store.publish({
      archiveType: 'scheduler-trace',
      sourceFrom: row.created_at,
      sourceTo: row.created_at,
      expiresAt: '2026-07-31T13:00:00.000Z',
      records: [{ key: `trace:${row.id}`, value: row }],
    });
    const service = createTechnicalArchiveService({
      db,
      store,
      now: () => new Date('2026-07-29T12:00:00.000Z'),
    });
    const result = service.runCycle();
    assert.equal(result.tracePackages[0].archiveCreated, false);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM ozon_scheduler_trace_events WHERE id = 'trace-retry'").get().count, 0);
    assert.equal(store.list({ archiveType: 'scheduler-trace' }).length, 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const method of ['runCycle', 'runCycleBatched']) {
  test(`${method} reports newly published bytes and enforces the unchanged archive budget at cycle completion`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'wangzai-archive-budget-'));
    const db = createDb();
    t.after(() => {
      db.close();
      // This path is the exact temporary fixture created by this test.
      assert.ok(directory.startsWith(join(tmpdir(), 'wangzai-archive-budget-')));
      rmSync(directory, { recursive: true, force: true });
    });
    const store = createStore(directory);
    const insert = db.prepare('INSERT INTO ozon_scheduler_trace_events VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('trace-0', 'job-0', 'fixture-shop', 'request', 'success', '2026-07-24T13:00:00.000Z');
    db.prepare('INSERT INTO business_facts VALUES (?, ?)').run('order-proof', 'must-survive');
    const referenceNow = () => new Date('2026-07-29T12:00:00.000Z');
    const firstService = createTechnicalArchiveService({ db, store, now: referenceNow,
      policy: { traceRowsPerPackage: 1 } });
    const firstResult = await firstService[method]();
    const firstBytes = store.inspectDirectory().packages.reduce((total, item) => total + item.bytes, 0);
    assert.ok(firstBytes > 0);

    // Non-published in-flight files and unrelated recovery packages are never
    // candidates for the existing authenticated .wzta retention policy.
    const activePath = join(directory, '.fixture-active.tmp');
    const recoveryPath = join(directory, 'fixture-required-recovery.wzb');
    writeFileSync(activePath, 'unverified-active-archive');
    writeFileSync(recoveryPath, 'required-recovery-package');
    for (let index = 1; index <= 2; index += 1) {
      insert.run(`trace-${index}`, `job-${index}`, 'fixture-shop', 'request', 'success', `2026-07-2${4 + index}T13:00:00.000Z`);
    }
    const maximumBytes = firstBytes * 2;
    const service = createTechnicalArchiveService({ db, store, now: referenceNow,
      policy: { traceRowsPerPackage: 1, maxArchiveBytes: maximumBytes } });
    const result = await service[method]();
    const current = store.inspectDirectory();
    const actualBytes = current.packages.reduce((total, item) => total + item.bytes, 0);
    assert.equal(result.archivedPackages, 2);
    assert.equal(result.archiveBytes, actualBytes);
    assert.ok(actualBytes <= maximumBytes);
    assert.equal(result.archiveCapacitySatisfied, true);
    assert.ok(result.expiredArchives >= 1);
    assert.ok(service.listTraceEventsByJob('job-2').some(row => row.id === 'trace-2'));
    assert.equal(readFileSync(activePath, 'utf8'), 'unverified-active-archive');
    assert.equal(readFileSync(recoveryPath, 'utf8'), 'required-recovery-package');
    assert.equal(db.prepare('SELECT payload FROM business_facts').get().payload, 'must-survive');
    assert.equal(firstResult.archiveBytes, firstBytes);
  });
}
