import assert from 'node:assert/strict';
import test from 'node:test';
import { createContinuousSyncService } from './continuousSyncService.js';

function createServices(calls, domains) {
  return new Map(domains.map((domain) => [domain, {
    startSync(input) {
      calls.push({ domain, input });
      return { accepted: true, status: 'queued', jobId: `${domain}-${calls.length}` };
    },
  }]));
}

test('continuous sync bootstraps all safe hot-cache domains through existing domain services', () => {
  const calls = [];
  const services = createServices(calls, ['products', 'orders', 'returns', 'finance', 'logistics', 'marketing', 'customerService', 'profit', 'data-analysis']);
  const service = createContinuousSyncService({
    shopRepository: { listShops: () => [{ id: 'shop-1', status: 'active' }, { id: 'shop-disabled', status: 'disabled' }] },
    domainServices: { get: (domain) => services.get(domain) },
    now: () => new Date('2026-07-11T00:00:00.000Z'),
  });

  const result = service.runOnce({ force: true, startup: true });
  assert.equal(result.shopCount, 1);
  assert.equal(result.accepted, 12);
  assert.equal(calls.length, 12);
  assert.equal(calls.every((call) => call.input.requestedBy === 'continuous-sync'), true);
  assert.equal(calls.every((call) => call.input.source === 'continuous-sync'), true);
  assert.equal(calls.every((call) => call.input.profile === 'background'), true);
  assert.equal(calls.every((call) => call.input.schedulerProfile === 'background'), true);
  assert.equal(calls.every((call) => call.input.syncMode === 'bootstrap'), true);
  const productBootstrap = calls.find((call) => call.domain === 'products').input;
  assert.equal(productBootstrap.allStatuses, true);
  assert.equal(productBootstrap.hydrationMode, 'full');
  assert.equal(productBootstrap.maxPages, 'all');
  assert.equal(calls.find((call) => call.domain === 'finance').input.from, '2026-04-12T00:00:00.000Z');
  assert.equal(calls.find((call) => call.domain === 'customerService').input.maxPages, 10);
  assert.equal(calls.find((call) => call.domain === 'data-analysis').input.startDate, '2026-06-12');
  assert.equal(calls.find((call) => call.domain === 'data-analysis').input.endDate, '2026-07-11');
});

test('normal startup fully warms product inventory while other domains stay in steady lanes', () => {
  const calls = [];
  const services = createServices(calls, ['products', 'orders']);
  const service = createContinuousSyncService({
    shopRepository: {
      listShops: () => [
        { id: 'shop-a', status: 'active' },
        { id: 'shop-b', status: 'active' },
        { id: 'shop-c', status: 'active' },
      ],
    },
    domainServices: { get: (domain) => services.get(domain) },
    policies: [
      { id: 'products:fast', domain: 'products', cadenceMs: 300_000, payload: { hydrationMode: 'fast' }, startupPayload: { hydrationMode: 'full' } },
      { id: 'orders:recent', domain: 'orders', cadenceMs: 300_000, payload: { defaultDays: 7 }, startupPayload: { defaultDays: 90 } },
    ],
    now: () => new Date('2026-08-01T00:00:00.000Z'),
    setIntervalImpl: () => ({ unref() {} }),
  });

  const started = service.start();
  assert.equal(started.started, true);
  assert.equal(started.initial.accepted, 6);
  assert.equal(calls.length, 6, 'all shops enter their independent lanes in the startup turn');
  assert.deepEqual(
    calls.map((call) => call.input.shopId),
    ['shop-a', 'shop-a', 'shop-b', 'shop-b', 'shop-c', 'shop-c'],
  );
  assert.equal(calls.filter((call) => call.domain === 'products').every((call) => call.input.syncMode === 'bootstrap'), true);
  assert.equal(calls.filter((call) => call.domain === 'products').every((call) => call.input.hydrationMode === 'full'), true);
  assert.equal(calls.filter((call) => call.domain === 'orders').every((call) => call.input.syncMode === 'steady'), true);
  assert.equal(calls.filter((call) => call.domain === 'orders').every((call) => call.input.defaultDays === 7), true);
});

test('production admission keeps startup full sync but bounds created domain jobs', () => {
  const calls = [];
  const jobStates = new Map();
  const services = new Map(['products', 'orders', 'returns'].map((domain) => [domain, {
    startSync(input) {
      const jobId = `${domain}-${input.shopId}-${calls.length + 1}`;
      calls.push({ domain, input, jobId });
      jobStates.set(jobId, { jobId, status: 'queued' });
      return { accepted: true, status: 'queued', jobId };
    },
  }]));
  const service = createContinuousSyncService({
    shopRepository: {
      listShops: () => ['shop-a', 'shop-b', 'shop-c'].map((id) => ({ id, status: 'active' })),
    },
    domainServices: { get: (domain) => services.get(domain) },
    policies: [
      { id: 'products:all', domain: 'products', cadenceMs: 300_000, payload: {}, startupPayload: { allStatuses: true } },
      { id: 'orders:fbs', domain: 'orders', cadenceMs: 300_000, payload: {}, startupPayload: {} },
      { id: 'returns:standard', domain: 'returns', cadenceMs: 300_000, payload: {}, startupPayload: {} },
    ],
    getSyncJob: (jobId) => jobStates.get(jobId) || null,
    maxOutstandingTasks: 3,
    maxOutstandingTasksPerShop: 1,
    maxOutstandingTasksByDomain: { products: 1 },
    now: () => new Date('2026-08-18T00:00:00.000Z'),
  });

  const result = service.runOnce({ force: true, startup: true });
  assert.equal(result.accepted, 9, 'every startup domain remains admitted for eventual execution');
  assert.equal(calls.length, 3, 'only the bounded foreground of domain jobs is created immediately');
  assert.equal(calls.filter((call) => call.domain === 'products').length, 1);
  assert.equal(new Set(calls.map((call) => call.input.shopId)).size, 3, 'independent shops still make parallel progress');
  assert.deepEqual(service.getStatus().admission, {
    enabled: true,
    pending: 6,
    active: 3,
    limits: { global: 3, perShop: 1, byDomain: { products: 1 } },
    pendingByShop: { 'shop-a': 2, 'shop-b': 2, 'shop-c': 2 },
    activeByShop: { 'shop-a': 1, 'shop-b': 1, 'shop-c': 1 },
    activeByDomain: { products: 1, orders: 2 },
    completedHistory: 0,
  });
});

test('twenty shops drain every startup task without exceeding admission budgets', () => {
  const calls = [];
  const jobStates = new Map();
  const services = new Map(['products', 'orders'].map((domain) => [domain, {
    startSync(input) {
      const jobId = `${domain}-${input.shopId}-${calls.length + 1}`;
      calls.push({ domain, shopId: input.shopId, jobId });
      jobStates.set(jobId, { jobId, status: 'queued' });
      return { accepted: true, status: 'queued', jobId };
    },
  }]));
  const shops = Array.from({ length: 20 }, (_, index) => ({ id: `shop-${index + 1}`, status: 'active' }));
  const service = createContinuousSyncService({
    shopRepository: { listShops: () => shops },
    domainServices: { get: (domain) => services.get(domain) },
    policies: [
      { id: 'products:all', domain: 'products', cadenceMs: 300_000, payload: {}, startupPayload: {} },
      { id: 'orders:fbs', domain: 'orders', cadenceMs: 300_000, payload: {}, startupPayload: {} },
    ],
    getSyncJob: (jobId) => jobStates.get(jobId) || null,
    maxOutstandingTasks: 4,
    maxOutstandingTasksPerShop: 1,
    maxOutstandingTasksByDomain: { products: 1 },
    now: () => new Date('2026-08-18T01:00:00.000Z'),
  });

  const initial = service.runOnce({ force: true, startup: true });
  assert.equal(initial.accepted, 40);
  let cycles = 0;
  for (; cycles < 100; cycles += 1) {
    const status = service.getAdmissionStatus();
    assert.equal(status.active <= 4, true);
    assert.equal((status.activeByDomain.products || 0) <= 1, true);
    assert.equal(Object.values(status.activeByShop).every((count) => count <= 1), true);
    if (status.pending === 0 && status.active === 0) break;
    for (const job of jobStates.values()) {
      if (job.status === 'queued') {
        job.status = 'success';
        job.finishedAt = '2026-08-18T01:01:00.000Z';
      }
    }
    service.runOnce();
  }

  assert.equal(cycles < 100, true, 'the admitted startup backlog must fully drain');
  assert.equal(calls.length, 40);
  const countsByShop = calls.reduce((output, call) => {
    output[call.shopId] = (output[call.shopId] || 0) + 1;
    return output;
  }, {});
  assert.deepEqual(Object.values(countsByShop), Array(20).fill(2));
});

test('continuous sync respects each hot-cache cadence and exposes target status', () => {
  const calls = [];
  let clock = new Date('2026-07-11T00:00:00.000Z');
  const policies = [
    { id: 'fast', domain: 'products', cadenceMs: 5 * 60 * 1000, payload: { hydrationMode: 'fast' }, startupPayload: { hydrationMode: 'core' } },
    { id: 'slow', domain: 'orders', cadenceMs: 15 * 60 * 1000, payload: { endpointKey: 'orders.fbsList' }, startupPayload: { endpointKey: 'orders.fbsList' } },
  ];
  const services = createServices(calls, ['products', 'orders']);
  const service = createContinuousSyncService({
    shopRepository: { listShops: () => [{ id: 'shop-1', status: 'active' }] },
    domainServices: { get: (domain) => services.get(domain) },
    policies,
    now: () => clock,
  });

  assert.equal(service.runOnce({ force: true, startup: true }).accepted, 2);
  clock = new Date('2026-07-11T00:05:00.000Z');
  const second = service.runOnce();
  assert.equal(second.accepted, 1);
  assert.equal(second.skippedNotDue, 1);
  assert.equal(calls[2].domain, 'products');
  assert.equal(calls[2].input.syncMode, 'steady');

  const status = service.getStatus();
  assert.equal(status.policy.length, 2);
  assert.equal(status.targets.length, 2);
  assert.equal(status.targets.find((item) => item.policyId === 'fast').lastResult.accepted, true);
});

test('continuous sync status resolves the terminal scheduler result without triggering another remote request', () => {
  const calls = [];
  const service = createContinuousSyncService({
    shopRepository: { listShops: () => [{ id: 'shop-1', status: 'active' }] },
    domainServices: { get: (domain) => createServices(calls, [domain]).get(domain) },
    policies: [{ id: 'products:fast', domain: 'products', cadenceMs: 5 * 60 * 1000, payload: {}, startupPayload: {} }],
    getSyncJob: (jobId) => ({
      jobId,
      status: 'failed',
      finishedAt: '2026-07-12T00:05:00.000Z',
      lastError: 'Ozon temporarily unavailable',
      retry: { nextRetryAt: '2026-07-12T00:10:00.000Z' },
    }),
    now: () => new Date('2026-07-12T00:00:00.000Z'),
  });

  service.runOnce({ force: true });
  const [target] = service.getStatus().targets;
  assert.equal(calls.length, 1);
  assert.equal(target.lastResult.jobStatus, 'failed');
  assert.equal(target.lastResult.jobFinishedAt, '2026-07-12T00:05:00.000Z');
  assert.equal(target.lastResult.jobLastError, 'Ozon temporarily unavailable');
  assert.equal(target.lastResult.jobRetryAt, '2026-07-12T00:10:00.000Z');
});

test('continuous sync keeps task status bounded and honors per-domain cadence across an eight-hour scheduler simulation', () => {
  const calls = [];
  let clock = new Date('2026-07-12T00:00:00.000Z');
  const policies = [
    { id: 'products:fast', domain: 'products', cadenceMs: 5 * 60 * 1000, payload: {}, startupPayload: {} },
    { id: 'orders:steady', domain: 'orders', cadenceMs: 15 * 60 * 1000, payload: {}, startupPayload: {} },
  ];
  const shops = ['shop-1', 'shop-2', 'shop-3'].map((id) => ({ id, status: 'active' }));
  const services = createServices(calls, ['products', 'orders']);
  const service = createContinuousSyncService({
    shopRepository: { listShops: () => shops },
    domainServices: { get: (domain) => services.get(domain) },
    policies,
    now: () => clock,
  });

  for (let step = 0; step <= 96; step += 1) {
    service.runOnce({ force: step === 0, startup: step === 0 });
    clock = new Date(clock.getTime() + 5 * 60 * 1000);
  }

  assert.equal(calls.filter((call) => call.domain === 'products').length, 291);
  assert.equal(calls.filter((call) => call.domain === 'orders').length, 99);
  assert.equal(service.getStatus().targets.length, 6);
  assert.equal(service.getStatus().lastRun.due, 6);
  assert.equal(service.getStatus().lastRun.skippedNotDue, 0);
});

test('a twenty-four-hour ten-shop scheduler simulation stays bounded and gives every shop equal progress', () => {
  const calls = [];
  let clock = new Date('2026-07-16T00:00:00.000Z');
  const shops = Array.from({ length: 10 }, (_item, index) => ({
    id: `shop-${String(index + 1).padStart(2, '0')}`,
    status: 'active',
  }));
  const policies = [
    { id: 'products:fast', domain: 'products', cadenceMs: 5 * 60 * 1000, payload: {}, startupPayload: {} },
    { id: 'orders:steady', domain: 'orders', cadenceMs: 15 * 60 * 1000, payload: {}, startupPayload: {} },
  ];
  const services = createServices(calls, ['products', 'orders']);
  const service = createContinuousSyncService({
    shopRepository: { listShops: () => shops },
    domainServices: { get: (domain) => services.get(domain) },
    policies,
    now: () => clock,
  });

  // 00:00 through the next 00:00, inclusive: 289 five-minute passes.
  for (let step = 0; step <= 288; step += 1) {
    service.runOnce({ force: step === 0, startup: step === 0 });
    clock = new Date(clock.getTime() + 5 * 60 * 1000);
  }

  const progressByShop = new Map(shops.map((shop) => [shop.id, 0]));
  for (const call of calls) {
    progressByShop.set(call.input.shopId, progressByShop.get(call.input.shopId) + 1);
  }
  assert.deepEqual([...progressByShop.values()], Array(10).fill(386));
  assert.equal(calls.filter((call) => call.domain === 'products').length, 2_890);
  assert.equal(calls.filter((call) => call.domain === 'orders').length, 970);
  assert.equal(service.getStatus().targets.length, 20, 'status is one bounded row per shop/policy');
  assert.equal(service.getStatus().lastRun.accepted, 20);
  assert.equal(service.getStatus().lastRun.rejected, 0);
});

test('saving ready credentials can bootstrap only the new active shop without waiting for the next cadence', () => {
  const calls = [];
  const shops = [
    { id: 'shop-existing', status: 'active', hasClientId: true, hasApiKey: true },
    { id: 'shop-new', status: 'inactive', hasClientId: false, hasApiKey: false },
  ];
  const services = createServices(calls, ['products']);
  const policies = [{ id: 'products:fast', domain: 'products', cadenceMs: 5 * 60 * 1000, payload: {}, startupPayload: {} }];
  const service = createContinuousSyncService({
    shopRepository: { listShops: () => shops },
    domainServices: { get: (domain) => services.get(domain) },
    policies,
    now: () => new Date('2026-07-12T00:00:00.000Z'),
  });

  assert.equal(service.runOnce({ force: true, startup: true }).accepted, 1);
  shops[1] = { id: 'shop-new', status: 'active', hasClientId: true, hasApiKey: true };
  const bootstrapped = service.bootstrapShop('shop-new');

  assert.equal(bootstrapped.ok, true);
  assert.equal(bootstrapped.trigger, 'shop-credentials-saved');
  assert.equal(bootstrapped.shopCount, 1);
  assert.equal(bootstrapped.accepted, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].input.shopId, 'shop-new');
  assert.equal(calls[1].input.syncMode, 'bootstrap');
  assert.equal(service.bootstrapShop('shop-missing').reason, 'shop_not_active_or_credentials_missing');
});

test('continuous sync does not overlap an already running scheduler pass', () => {
  const service = createContinuousSyncService({
    shopRepository: { listShops: () => [] },
    domainServices: { get: () => null },
  });
  const first = service.runOnce();
  assert.equal(first.ok, true);
  assert.equal(first.shopCount, 0);
});

test('continuous sync retries a pending recovery marker on every pass as a recovery-reconcile queue', () => {
  const calls = [];
  const updates = [];
  const services = createServices(calls, ['orders']);
  const service = createContinuousSyncService({
    shopRepository: { listShops: () => [{ id: 'shop-recovered', status: 'active' }] },
    domainServices: { get: (domain) => services.get(domain) },
    policies: [{ id: 'orders:recovery', domain: 'orders', cadenceMs: 60_000, payload: {}, startupPayload: {} }],
    recoveryReconcileState: {
      listPending: () => [{
        restoreId: 'restore-1',
        generationId: 'generation-1',
        shopId: 'shop-recovered',
        overlapMinutes: 30,
      }],
      markQueued: (input) => updates.push(input),
      getStatus: () => ({ pending: 0, queued: 1, rows: [] }),
    },
    now: () => new Date('2026-07-11T12:00:00.000Z'),
  });

  const result = service.runOnce({ force: true });
  assert.equal(result.recoveryQueued, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.syncMode, 'recovery-reconcile');
  assert.equal(calls[0].input.source, 'recovery-reconcile');
  assert.equal(calls[0].input.requestedBy, 'recovery-reconcile');
  assert.equal(calls[0].input.recoveryOverlapMinutes, 30);
  assert.deepEqual(updates, [{
    restoreId: 'restore-1',
    shopId: 'shop-recovered',
    queuedPolicyCount: 1,
    jobIds: ['orders-1'],
    lastError: null,
  }]);
  assert.equal(service.getStatus().recovery.queued, 1);
});

test('an eight-hour sleep jump immediately queues every overdue shop into its independent lane', () => {
  const calls = [];
  let clock = new Date('2026-07-16T00:00:00.000Z');
  const shops = Array.from({ length: 10 }, (_, index) => ({
    id: `shop-${String(index + 1).padStart(2, '0')}`,
    status: 'active',
  }));
  const services = createServices(calls, ['products']);
  const service = createContinuousSyncService({
    shopRepository: { listShops: () => shops },
    domainServices: { get: (domain) => services.get(domain) },
    policies: [{
      id: 'products:resume',
      domain: 'products',
      cadenceMs: 5 * 60 * 1000,
      payload: {},
      startupPayload: {},
    }],
    now: () => clock,
  });

  assert.equal(service.runOnce({ force: true, startup: true }).accepted, 10);
  assert.equal(calls.length, 10);
  clock = new Date('2026-07-16T08:00:00.000Z');
  const resumed = service.runOnce();

  assert.equal(resumed.trigger, 'resume-after-suspend');
  assert.equal(resumed.shopCount, 10);
  assert.equal(resumed.accepted, 10);
  assert.equal(calls.length, 20);
  assert.equal(new Set(calls.slice(10).map((item) => item.input.shopId)).size, 10);
  assert.equal(service.getStatus().lastRun.accepted, 10);
});

test('pausing one continuous-sync owner never blocks another shop lane', () => {
  const calls = [];
  const services = createServices(calls, ['orders']);
  const service = createContinuousSyncService({
    shopRepository: {
      listShops: () => [{ id: 'shop-a', status: 'active' }, { id: 'shop-b', status: 'active' }],
    },
    domainServices: { get: (domain) => services.get(domain) },
    policies: [{ id: 'orders:resume', domain: 'orders', cadenceMs: 60_000, payload: {}, startupPayload: {} }],
    now: () => new Date('2026-07-16T08:00:00.000Z'),
  });

  const paused = service.pauseOwner('shop-a');
  assert.equal(paused.paused, true);
  const resumed = service.resumeAfterSuspend();
  assert.equal(resumed.shopCount, 1);
  assert.equal(resumed.accepted, 1);
  assert.deepEqual(calls.map((call) => call.input.shopId), ['shop-b']);
  assert.equal(service.getStatus().pausedShopIds.includes('shop-a'), true);

  const stopped = service.stop();
  assert.equal(stopped.stopped, false);
  assert.equal(service.getStatus().pausedShopIds.includes('shop-a'), true);
});
