import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './createApp.js';
import { createMigratedTestDb } from '../../test/testDb.js';

process.env.LOCAL_API_SECRET = 'unit-local-master-material';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function createControlledTaskDriver() {
  const jobs = new Map();
  const enqueueCalls = [];
  return {
    jobs,
    enqueueCalls,
    driver: {
      enqueue(run) {
        enqueueCalls.push({
          runId: run.runId,
          shopIncarnation: run.shopIncarnation,
          credentialRevision: run.credentialRevision,
        });
        const tasks = run.requiredDomains.map((domain) => {
          const taskId = `${run.runId}:${domain}`;
          jobs.set(taskId, { jobId: taskId, status: 'queued' });
          return { domain, kind: 'controlled', taskId };
        });
        return { tasks, rejections: [] };
      },
      getTask(task) {
        return jobs.get(task.taskId) || null;
      },
    },
  };
}

test('shop lifecycle HTTP routes expose durable bootstrap readiness and rebind to a new incarnation', async () => {
  const db = createMigratedTestDb();
  const controlled = createControlledTaskDriver();
  let server;
  try {
    server = createApp({
      db,
      config: {
        runtime: { profileId: 'profile-http-lifecycle' },
        security: {},
        sync: { continuousEnabled: true },
        ozon: {},
      },
      getDatabaseStatus: () => ({ ok: true }),
      listAppliedMigrations: () => [],
      startedAt: Date.now(),
      continuousSyncService: {
        start() { return { ok: true }; },
        getStatus() { return { ok: true }; },
      },
      shopBootstrapTaskDriver: controlled.driver,
      shopBootstrapPollIntervalMs: 60_000,
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    const createdResponse = await fetch(`${baseUrl}/api/shops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'shop-http-lifecycle',
        name: 'HTTP lifecycle shop',
        clientId: 'http-lifecycle-client',
        apiKey: 'http-lifecycle-key',
        status: 'active',
      }),
    });
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 201);
    assert.equal(created.bindingReady, false);
    assert.equal(created.bindingStatus, 'running');
    assert.equal(created.bootstrap.ready, false);
    assert.equal(created.bootstrap.required, true);
    assert.equal(created.shop.profileId, 'profile-http-lifecycle');
    assert.equal(JSON.stringify(created).includes('http-lifecycle-key'), false);
    const firstIncarnation = created.shop.shopIncarnation;
    const firstRunId = created.bootstrapRun.runId;

    const storedStates = db.prepare(`
      SELECT domain, status FROM shop_domain_sync_state
      WHERE profile_id = ? AND shop_id = ? AND bootstrap_run_id = ?
      ORDER BY domain ASC
    `).all('profile-http-lifecycle', created.shop.id, firstRunId);
    assert.equal(storedStates.length, 7);
    assert.ok(storedStates.every((state) => state.status === 'syncing'));

    const pendingResponse = await fetch(`${baseUrl}/api/shops/${created.shop.id}/lifecycle`);
    const pending = await pendingResponse.json();
    assert.equal(pendingResponse.status, 200);
    assert.equal(pending.bindingReady, false);
    assert.equal(pending.bindingStatus, 'running');

    for (const job of controlled.jobs.values()) {
      job.status = 'success';
      job.finishedAt = '2026-07-16T00:05:00.000Z';
      job.changedCount = 1;
    }
    const completedResponse = await fetch(`${baseUrl}/api/shops/${created.shop.id}/lifecycle`);
    const completed = await completedResponse.json();
    assert.equal(completed.bindingReady, true);
    assert.equal(completed.bindingStatus, 'completed');
    assert.match(completed.bootstrapRun.proofHash, /^[a-f0-9]{64}$/u);
    assert.ok(completed.domainStates.every((state) => state.status === 'completed'));

    const runResponse = await fetch(
      `${baseUrl}/api/shops/${created.shop.id}/bootstrap/${firstRunId}`,
    );
    const runStatus = await runResponse.json();
    assert.equal(runStatus.run.status, 'completed');
    assert.equal(runStatus.bindingReady, true);

    const manualResponse = await fetch(`${baseUrl}/api/shops/${created.shop.id}/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requiredDomains: ['products'] }),
    });
    const manual = await manualResponse.json();
    assert.equal(manualResponse.status, 202);
    assert.equal(manual.bindingReady, false);
    assert.equal(manual.bootstrapRun.requiredDomains.length, 7);
    assert.deepEqual(manual.bootstrapRun.requiredDomains, [
      'catalog_mappings',
      'finance',
      'logistics',
      'marketing',
      'orders',
      'products',
      'returns',
    ]);

    const reboundResponse = await fetch(`${baseUrl}/api/shops/${created.shop.id}/rebind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'HTTP lifecycle shop rebound' }),
    });
    const rebound = await reboundResponse.json();
    assert.equal(reboundResponse.status, 200);
    assert.equal(rebound.bindingReady, false);
    assert.equal(rebound.bindingStatus, 'running');
    assert.notEqual(rebound.shop.shopIncarnation, firstIncarnation);
    assert.equal(rebound.bootstrapRun.reason, 'rebind');
    assert.equal(controlled.enqueueCalls.length, 3);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
