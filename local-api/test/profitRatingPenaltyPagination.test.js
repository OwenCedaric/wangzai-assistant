import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb } from './testDb.js';
import { createProfitService } from '../src/domain/profit/profitService.js';
import { createSyncJobService } from '../src/sync/syncJobService.js';

const penalty = (id, money = {}) => ({ operation_id: id, posting_number: `posting-${id}`,
  operation_type: 'DefectFineCancellation', ...money });

async function runSync(scheduler, input = {}, verify) {
  const db = createMigratedTestDb();
  try {
    db.prepare('INSERT INTO shops (id,name) VALUES (?,?)').run('memory-sync', 'Isolated sync fixture');
    const service = createProfitService({ db, backgroundRunner: () => {}, ozonScheduler: scheduler });
    const params = { shopId: 'memory-sync', pageSize: 2, ...input };
    const started = service.startSync(params);
    const done = await service.runRatingPenaltySyncJob(started.job, params);
    await verify({ db, service, done, cache: service.readCache({ scope: 'rating-penalties', shopId: params.shopId }) });
  } finally { db.close(); }
}

test('default penalty sync reads all pages, not just the first full page', async () => {
  const rows = [1, 2, 3].map(id => penalty(`page-${id}`, { error_fee_cny: -1 }));
  const offsets = [];
  await runSync({ async executeReadOnly({ params }) {
    offsets.push(params.offset);
    return { ok: true, data: { result: { postings: rows.slice(params.offset, params.offset + params.limit), has_next: params.offset + params.limit < rows.length } } };
  } }, {}, ({ done, cache }) => {
    assert.deepEqual(offsets, [0, 2]);
    assert.equal(cache.total, 3);
    assert.equal(done.job.status, 'success');
    assert.equal(done.complete, true);
  });
});

test('an explicit page cap produces partial, never a complete-success receipt', async () => {
  await runSync({ async executeReadOnly() {
    return { ok: true, data: { result: { postings: [penalty('cap-1'), penalty('cap-2')], has_next: true } } };
  } }, { maxPages: 1 }, ({ done, cache }) => {
    assert.equal(done.job.status, 'partial');
    assert.equal(done.complete, false);
    assert.match(done.job.lastError, /PROFIT_RATING_PAGE_LIMIT/);
    assert.equal(cache.syncState[0].lastSuccessAt, null);
    assert.equal(cache.complete, false);
  });
});

test('completion is bound to the requested date and posting scope', async () => {
  await runSync({ async executeReadOnly() { return { ok: true, data: { postings: [] } }; } },
    { params: { filter: { date_from: '2026-09-01', date_to: '2026-09-06', posting_number: 'scope-posting' } } },
    ({ service, done }) => {
      assert.equal(done.complete, true);
      const query = { scope: 'rating-penalties', shopId: 'memory-sync', since: '2026-09-01', to: '2026-09-06', postingNumber: 'scope-posting' };
      assert.equal(service.readCache(query).complete, true);
      assert.equal(service.readCache({ ...query, since: '2026-08-01' }).complete, false);
      assert.equal(service.readCache({ ...query, postingNumber: 'other-posting' }).complete, false);
      assert.equal(service.readCache({ ...query, postingNumber: '' }).complete, false);
    });
});

test('unknown legacy success cannot prove complete penalty coverage', () => {
  const db = createMigratedTestDb();
  try {
    const service = createProfitService({ db });
    assert.equal(service.readCache({ scope: 'rating-penalties', shopId: 'legacy-no-receipt' }).complete, false);
  } finally { db.close(); }
});

test('explicit next-page evidence survives a short page and offsets use returned rows', async () => {
  const offsets = [];
  await runSync({ async executeReadOnly({ params }) {
    offsets.push(params.offset);
    return { ok: true, data: { result: { postings: [penalty(`short-${params.offset}`)], has_next: params.offset === 0 } } };
  } }, {}, ({ done, cache }) => {
    assert.deepEqual(offsets, [0, 1]);
    assert.equal(done.complete, true);
    assert.equal(cache.total, 2);
  });
});

for (const [label, response] of [
  ['partial scheduler result', { ok: true, status: 'partial', data: { result: { postings: [] } } }],
  ['stale scheduler result', { ok: true, stale: true, data: { result: { postings: [] } } }],
  ['unknown successful payload', { ok: true, data: { unexpected: [] } }],
  ['partial nested payload', { ok: true, data: { partial: true, postings: [] } }],
  ['invalid next-page flag', { ok: true, data: { postings: [], has_next: 'unknown' } }],
]) {
  test(`incomplete penalty source cannot become success: ${label}`, async () => {
    await runSync({ async executeReadOnly() { return response; } }, {}, ({ done }) => {
      assert.notEqual(done.job.status, 'success');
      assert.equal(done.complete, false);
    });
  });
}

test('repeated pages stop instead of being counted as full coverage', async () => {
  let calls = 0;
  await runSync({ async executeReadOnly() {
    calls += 1;
    return { ok: true, data: { postings: [penalty('repeat-1'), penalty('repeat-2')], has_next: true } };
  } }, {}, ({ done }) => {
    assert.equal(calls, 2);
    assert.equal(done.job.status, 'partial');
    assert.match(done.job.lastError, /PROFIT_RATING_PAGE_REPEATED/);
  });
});

test('cancellation during an in-flight read cannot write returned penalties', async () => {
  const db = createMigratedTestDb();
  try {
    db.prepare('INSERT INTO shops (id,name) VALUES (?,?)').run('memory-cancel', 'Isolated cancel fixture');
    let job;
    const service = createProfitService({ db, backgroundRunner: () => {}, ozonScheduler: { async executeReadOnly() {
      createSyncJobService(db).updateJob(job.jobId, { status: 'canceled' });
      return { ok: true, data: { postings: [penalty('late-cancel')] } };
    } } });
    const input = { shopId: 'memory-cancel' };
    job = service.startSync(input).job;
    const result = await service.runRatingPenaltySyncJob(job, input);
    assert.equal(result.job.status, 'canceled');
    assert.equal(result.complete, false);
    assert.equal(service.readCache({ scope: 'rating-penalties', shopId: input.shopId }).total, 0);
  } finally { db.close(); }
});

test('date-range completion receipts do not invalidate another completed range', async () => {
  const db = createMigratedTestDb();
  try {
    db.prepare('INSERT INTO shops (id,name) VALUES (?,?)').run('memory-scopes', 'Isolated scope fixture');
    const service = createProfitService({ db, backgroundRunner: () => {}, ozonScheduler: {
      async executeReadOnly() { return { ok: true, data: { postings: [] } }; },
    } });
    const scopes = [{ from: '2026-08-01', to: '2026-08-31' }, { from: '2026-09-01', to: '2026-09-06' }];
    for (const params of scopes) {
      const input = { shopId: 'memory-scopes', params };
      const job = service.startSync(input).job;
      assert.equal((await service.runRatingPenaltySyncJob(job, input)).complete, true);
    }
    for (const range of scopes) assert.equal(service.readCache({ scope: 'rating-penalties', shopId: 'memory-scopes', ...range }).complete, true);
  } finally { db.close(); }
});

test('a removed in-flight job cannot write a late page or recreate a completion receipt', async () => {
  const db = createMigratedTestDb();
  try {
    db.prepare('INSERT INTO shops (id,name) VALUES (?,?)').run('memory-removed', 'Isolated removed-job fixture');
    let job;
    const service = createProfitService({ db, backgroundRunner: () => {}, ozonScheduler: { async executeReadOnly() {
      db.prepare('DELETE FROM ozon_request_jobs WHERE id = ?').run(job.jobId);
      return { ok: true, data: { postings: [penalty('removed-late')] } };
    } } });
    const input = { shopId: 'memory-removed' };
    job = service.startSync(input).job;
    const result = await service.runRatingPenaltySyncJob(job, input);
    assert.equal(result.complete, false);
    assert.equal(service.readCache({ scope: 'rating-penalties', shopId: input.shopId }).total, 0);
  } finally { db.close(); }
});
