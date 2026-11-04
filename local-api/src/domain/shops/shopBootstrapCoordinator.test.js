import assert from 'node:assert/strict';
import test from 'node:test';
import { createShopLifecycleRepository } from '../../db/repositories/shopLifecycleRepository.js';
import { createShopRepository } from '../../db/repositories/shopRepository.js';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createShopIdentityLifecycleService } from './shopIdentityLifecycleService.js';
import {
  createDefaultShopBootstrapTaskDriver,
  createShopBootstrapCoordinator,
} from './shopBootstrapCoordinator.js';

function createFixture() {
  const db = createMigratedTestDb();
  let incarnationSequence = 0;
  let runSequence = 0;
  const shops = createShopRepository(db, {
    profileId: 'profile-bootstrap-coordinator',
    createIncarnation: () => `inc-${++incarnationSequence}`,
  });
  const lifecycle = createShopLifecycleRepository(db, {
    profileId: shops.profileId,
    identityRepository: shops.identityRepository,
    createRunId: () => `run-${++runSequence}`,
  });
  const service = createShopIdentityLifecycleService({
    shopRepository: shops,
    lifecycleRepository: lifecycle,
    requiredDomains: ['products', 'orders'],
  });
  return { db, shops, lifecycle, service };
}

function createControlledDriver(prefix = 'task') {
  const jobs = new Map();
  const enqueueCalls = [];
  return {
    jobs,
    enqueueCalls,
    driver: {
      enqueue(run) {
        enqueueCalls.push(run.runId);
        const tasks = run.requiredDomains.map((domain) => {
          const taskId = `${prefix}-${run.runId}-${domain}`;
          jobs.set(taskId, { jobId: taskId, status: 'queued' });
          return { domain, kind: 'ozon', taskId };
        });
        return { tasks, rejections: [] };
      },
      getTask(task) {
        return jobs.get(task.taskId) || null;
      },
    },
  };
}

function bindingInput(apiKey = 'key-v1') {
  return {
    id: 'shop-bootstrap',
    name: 'Bootstrap shop',
    clientId: 'client-bootstrap',
    apiKey,
    status: 'active',
  };
}

test('default task driver retains every domain job reference and routes catalog polling separately', async () => {
  const schedulerJobs = new Map([
    ['products-job', { jobId: 'products-job', status: 'queued' }],
    ['orders-fbs-job', { jobId: 'orders-fbs-job', status: 'queued' }],
    ['orders-fbo-job', { jobId: 'orders-fbo-job', status: 'queued' }],
  ]);
  const catalogJob = { jobId: 'catalog-job', status: 'queued' };
  const driver = createDefaultShopBootstrapTaskDriver({
    continuousSyncService: {
      bootstrapShop() {
        return {
          results: [
            { domain: 'products', accepted: true, result: { jobId: 'products-job' } },
            {
              domain: 'orders',
              accepted: true,
              result: {
                jobIds: ['orders-fbs-job', 'orders-fbo-job'],
                jobs: [{ jobId: 'orders-fbs-job' }, { jobId: 'orders-fbo-job' }],
              },
            },
          ],
        };
      },
    },
    catalogCacheService: {
      startCatalogSync() { return { accepted: true, job: catalogJob }; },
      getCatalogSyncJob(jobId) { return jobId === catalogJob.jobId ? catalogJob : null; },
    },
    ozonScheduler: {
      getJob(jobId) { return schedulerJobs.get(jobId) || null; },
    },
  });
  const queued = await driver.enqueue({
    runId: 'run-driver',
    shopId: 'shop-driver',
    requiredDomains: ['products', 'orders', 'catalog_mappings'],
  });
  assert.deepEqual(queued.rejections, []);
  assert.deepEqual(
    queued.tasks.map((task) => `${task.domain}:${task.taskId}`).sort(),
    [
      'catalog_mappings:catalog-job',
      'orders:orders-fbo-job',
      'orders:orders-fbs-job',
      'products:products-job',
    ],
  );
  assert.equal((await driver.getTask(queued.tasks.find((task) => task.kind === 'catalog'))).status, 'queued');
  assert.equal((await driver.getTask(queued.tasks.find((task) => task.taskId === 'products-job'))).status, 'queued');
});

test('default task driver tracks a throttled continuous-sync admission until its real job finishes', async () => {
  const admissionJobs = new Map([
    ['admission-products', { jobId: 'admission-products', status: 'queued' }],
  ]);
  const driver = createDefaultShopBootstrapTaskDriver({
    continuousSyncService: {
      bootstrapShop() {
        return {
          results: [{
            domain: 'products',
            accepted: true,
            result: {
              accepted: true,
              admissionPending: true,
              admissionId: 'admission-products',
            },
          }],
        };
      },
      getAdmissionTask(admissionId) {
        return admissionJobs.get(admissionId) || null;
      },
    },
  });

  const queued = await driver.enqueue({
    runId: 'run-admitted',
    shopId: 'shop-admitted',
    requiredDomains: ['products'],
  });
  assert.deepEqual(queued.rejections, []);
  assert.deepEqual(queued.tasks, [{
    domain: 'products',
    taskId: 'admission-products',
    kind: 'continuous-admission',
  }]);
  assert.equal((await driver.getTask(queued.tasks[0])).status, 'queued');
  admissionJobs.set('admission-products', { jobId: 'admission-products', status: 'success' });
  assert.equal((await driver.getTask(queued.tasks[0])).status, 'success');
});

test('queue acceptance remains not-ready until every required domain has a persisted success proof', async () => {
  const fixture = createFixture();
  const controlled = createControlledDriver();
  let bindingFenceReleased = false;
  const coordinator = createShopBootstrapCoordinator({
    lifecycleService: fixture.service,
    lifecycleRepository: fixture.lifecycle,
    taskDriver: {
      ...controlled.driver,
      enqueue(run) {
        assert.equal(bindingFenceReleased, true);
        return controlled.driver.enqueue(run);
      },
    },
  });
  try {
    const binding = await coordinator.saveBinding(bindingInput(), {
      onBindingSaved() { bindingFenceReleased = true; },
    });
    assert.equal(binding.bindingReady, false);
    assert.equal(binding.bindingStatus, 'running');
    assert.deepEqual(controlled.enqueueCalls, [binding.bootstrapRun.runId]);
    assert.deepEqual(
      fixture.lifecycle.listCurrentDomainStates(binding.shop.id).map((state) => state.status),
      ['syncing', 'syncing'],
    );

    for (const job of controlled.jobs.values()) {
      job.status = 'success';
      job.changedCount = 3;
      job.finishedAt = '2026-07-16T00:01:00.000Z';
    }
    const completed = await coordinator.reconcileRun(binding.bootstrapRun.runId);
    assert.equal(completed.bindingReady, true);
    assert.equal(completed.run.status, 'completed');
    assert.match(completed.run.proofHash, /^[a-f0-9]{64}$/u);
    assert.ok(completed.domainStates.every((state) => state.status === 'completed'));
    assert.ok(completed.domainStates.every((state) => /^[a-f0-9]{64}$/u.test(state.proofHash)));
  } finally {
    fixture.db.close();
  }
});

test('credential revision rotation invalidates the old run and prevents its tasks from activating readiness', async () => {
  const fixture = createFixture();
  const controlled = createControlledDriver();
  const coordinator = createShopBootstrapCoordinator({
    lifecycleService: fixture.service,
    lifecycleRepository: fixture.lifecycle,
    taskDriver: controlled.driver,
  });
  try {
    const first = await coordinator.saveBinding(bindingInput('key-v1'));
    const rotated = await coordinator.saveBinding(bindingInput('key-v2'));
    assert.equal(rotated.scopeToken.credentialRevision, first.scopeToken.credentialRevision + 1);
    assert.equal(fixture.lifecycle.getBootstrapRun(first.bootstrapRun.runId).status, 'invalid');

    for (const [taskId, job] of controlled.jobs.entries()) {
      if (taskId.includes(first.bootstrapRun.runId)) job.status = 'success';
    }
    const oldResult = await coordinator.reconcileRun(first.bootstrapRun.runId);
    assert.equal(oldResult.run.status, 'invalid');
    assert.equal(oldResult.bindingReady, false);
    assert.equal(fixture.service.getBindingReadiness(first.shop.id).bootstrapRun.runId, rotated.bootstrapRun.runId);
  } finally {
    fixture.db.close();
  }
});

test('a proven partial source result is explicit and can only finish as completed_with_source_gaps', async () => {
  const fixture = createFixture();
  const controlled = createControlledDriver();
  const coordinator = createShopBootstrapCoordinator({
    lifecycleService: fixture.service,
    lifecycleRepository: fixture.lifecycle,
    taskDriver: controlled.driver,
  });
  try {
    const binding = await coordinator.saveBinding(bindingInput());
    for (const [taskId, job] of controlled.jobs.entries()) {
      job.status = taskId.endsWith(':orders') || taskId.endsWith('-orders') ? 'partial' : 'success';
    }
    const completed = await coordinator.reconcileRun(binding.bootstrapRun.runId);
    assert.equal(completed.bindingReady, true);
    assert.equal(completed.run.status, 'completed_with_source_gaps');
    assert.deepEqual(completed.run.sourceGaps, [
      { domain: 'orders', code: 'SHOP_BOOTSTRAP_SOURCE_GAP' },
    ]);
  } finally {
    fixture.db.close();
  }
});

test('missing queue references fail closed instead of treating accepted work as a completed bootstrap', async () => {
  const fixture = createFixture();
  const coordinator = createShopBootstrapCoordinator({
    lifecycleService: fixture.service,
    lifecycleRepository: fixture.lifecycle,
    taskDriver: {
      enqueue(run) {
        return {
          tasks: [{ domain: 'products', taskId: `${run.runId}:products`, kind: 'controlled' }],
          rejections: [{ domain: 'orders', code: 'ORDERS_QUEUE_REJECTED' }],
        };
      },
      getTask() {
        return { status: 'success' };
      },
    },
  });
  try {
    const binding = await coordinator.saveBinding(bindingInput());
    assert.equal(binding.bindingReady, false);
    assert.equal(binding.bindingStatus, 'failed');
    assert.equal(binding.bootstrapRun.lastErrorCode, 'SHOP_BOOTSTRAP_DOMAIN_ENQUEUE_INCOMPLETE');
    assert.equal(
      fixture.lifecycle.listCurrentDomainStates(binding.shop.id)
        .find((state) => state.domain === 'orders').lastErrorCode,
      'ORDERS_QUEUE_REJECTED',
    );
  } finally {
    fixture.db.close();
  }
});

test('restart recovery interrupts lost task handles, requeues the durable run and completes from new proofs', async () => {
  const fixture = createFixture();
  const beforeRestart = createControlledDriver('before');
  const firstCoordinator = createShopBootstrapCoordinator({
    lifecycleService: fixture.service,
    lifecycleRepository: fixture.lifecycle,
    taskDriver: beforeRestart.driver,
  });
  try {
    const binding = await firstCoordinator.saveBinding(bindingInput());
    assert.equal(binding.bindingStatus, 'running');

    const afterRestart = createControlledDriver('after');
    const recoveredCoordinator = createShopBootstrapCoordinator({
      lifecycleService: fixture.service,
      lifecycleRepository: fixture.lifecycle,
      taskDriver: afterRestart.driver,
    });
    const recovery = await recoveredCoordinator.recoverNow();
    assert.equal(recovery.count, 1);
    assert.deepEqual(afterRestart.enqueueCalls, [binding.bootstrapRun.runId]);
    assert.equal(fixture.lifecycle.getBootstrapRun(binding.bootstrapRun.runId).status, 'running');
    assert.ok(
      fixture.lifecycle.listCurrentDomainStates(binding.shop.id)
        .every((state) => state.status === 'syncing'),
    );

    for (const job of afterRestart.jobs.values()) job.status = 'success';
    const completed = await recoveredCoordinator.reconcileRun(binding.bootstrapRun.runId);
    assert.equal(completed.bindingReady, true);
    assert.equal(completed.run.status, 'completed');
  } finally {
    fixture.db.close();
  }
});

test('restart recovery completes a verifying run from persisted domain proofs without re-enqueueing', async () => {
  const fixture = createFixture();
  const controlled = createControlledDriver();
  try {
    const binding = fixture.service.saveBinding(bindingInput());
    fixture.service.activateBootstrap(binding.bootstrapRun.runId, binding.scopeToken);
    fixture.service.recordBootstrapDomain({
      runId: binding.bootstrapRun.runId,
      scopeToken: binding.scopeToken,
      domain: 'products',
      status: 'completed',
      proofHash: 'a'.repeat(64),
    });
    fixture.service.recordBootstrapDomain({
      runId: binding.bootstrapRun.runId,
      scopeToken: binding.scopeToken,
      domain: 'orders',
      status: 'completed',
      proofHash: 'b'.repeat(64),
    });
    fixture.service.beginBootstrapVerification(binding.bootstrapRun.runId, binding.scopeToken);

    const coordinator = createShopBootstrapCoordinator({
      lifecycleService: fixture.service,
      lifecycleRepository: fixture.lifecycle,
      taskDriver: controlled.driver,
    });
    await coordinator.recoverNow();
    assert.equal(controlled.enqueueCalls.length, 0);
    assert.equal(fixture.service.getBindingReadiness(binding.shop.id).bindingReady, true);
    assert.equal(fixture.lifecycle.getBootstrapRun(binding.bootstrapRun.runId).status, 'completed');
  } finally {
    fixture.db.close();
  }
});
