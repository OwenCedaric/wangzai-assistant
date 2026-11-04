import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestQueue } from '../src/ozon/requestQueue.js';

test('requestQueue supports queue full rejection, pause/resume and status counters', async () => {
  const queue = createRequestQueue({ shopConcurrency: 1, endpointConcurrency: 1, maxQueueSizePerShop: 1, queueTimeoutMs: 50 });
  queue.pauseShop('shop-a');
  const queued = queue.enqueue({ jobId: 'job-1', requestId: 'r1', priority: 'P1', shopId: 'shop-a', endpointKey: 'e1' }, async () => 'ok');
  await assert.rejects(
    () => queue.enqueue({ jobId: 'job-2', requestId: 'r2', priority: 'P1', shopId: 'shop-a', endpointKey: 'e1' }, async () => 'no'),
    (error) => error?.code === 'OZON_QUEUE_FULL' && error?.shopId === 'shop-a',
  );
  assert.equal(await queue.enqueue(
    { jobId: 'job-b', requestId: 'rb', priority: 'P1', shopId: 'shop-b', endpointKey: 'e1' },
    async () => 'shop-b-ok',
  ), 'shop-b-ok', 'shop-b must run even when shop-a has filled its own queue');
  assert.equal(queue.getStatus().queuedByPriority.P1, 1);
  queue.resumeShop('shop-a');
  assert.equal(await queued, 'ok');
});

test('requestQueue account-removal quiesce rejects post-fence work until explicit release', async () => {
  const queue = createRequestQueue({ shopConcurrency: 1, endpointConcurrency: 1 });

  const quiesced = await queue.quiesceShop('shop-delete');
  assert.equal(quiesced.fenced, true);
  assert.equal(quiesced.queued, 0);
  assert.equal(quiesced.running, 0);
  await assert.rejects(
    () => queue.enqueue(
      { jobId: 'job-after-fence', requestId: 'request-after-fence', shopId: 'shop-delete', endpointKey: 'products.list' },
      async () => 'must-not-run',
    ),
    (error) => error?.code === 'OZON_QUEUE_OWNER_QUIESCED',
  );

  assert.equal(await queue.enqueue(
    { jobId: 'job-other-owner', requestId: 'request-other-owner', shopId: 'shop-keep', endpointKey: 'products.list' },
    async () => 'other-owner-ok',
  ), 'other-owner-ok');

  assert.equal(queue.resumeShop('shop-delete').fenced, false);
  assert.equal(await queue.enqueue(
    { jobId: 'job-after-release', requestId: 'request-after-release', shopId: 'shop-delete', endpointKey: 'products.list' },
    async () => 'released-owner-ok',
  ), 'released-owner-ok');
});

test('requestQueue queueTimeout rejects stale queued items', async () => {
  const queue = createRequestQueue({ shopConcurrency: 1, endpointConcurrency: 1, maxQueueSize: 10, queueTimeoutMs: 10 });
  queue.pauseEndpoint('e-timeout');
  const stale = queue.enqueue({ jobId: 'job-timeout', requestId: 'timeout', priority: 'P1', shopId: 'shop-a', endpointKey: 'e-timeout' }, async () => 'no');
  await new Promise((resolve) => setTimeout(resolve, 15));
  queue.sweepTimeouts();
  await assert.rejects(stale, /queueTimeoutMs/u);
});

test('requestQueue serializes reads and writes only inside one shop and supports pause endpoint', async () => {
  const queue = createRequestQueue({ shopConcurrency: 1, writeConcurrency: 1 });
  const order = [];
  let releaseRead;
  const read = queue.enqueue({ jobId: 'read', requestId: 'read', priority: 'P0', shopId: 's1', endpointKey: 'read.e' }, async () => new Promise((resolve) => { order.push('read-start'); releaseRead = () => { order.push('read-end'); resolve('read'); }; }));
  const write = queue.enqueue({ jobId: 'write', requestId: 'write', priority: 'WRITE', shopId: 's1', endpointKey: 'write.e' }, async () => { order.push('write'); return 'write'; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['read-start']);
  releaseRead();
  assert.equal(await read, 'read');
  assert.equal(await write, 'write');
  assert.deepEqual(order, ['read-start', 'read-end', 'write']);

  queue.pauseEndpoint('paused.e');
  const paused = queue.enqueue({ jobId: 'paused', requestId: 'paused', priority: 'P1', shopId: 's2', endpointKey: 'paused.e' }, async () => 'paused');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.getStatus().queued, 1);
  queue.resumeEndpoint('paused.e');
  assert.equal(await paused, 'paused');
});

test('requestQueue lets another shop read while the first shop has an active write', async () => {
  const queue = createRequestQueue({ shopConcurrency: 1, endpointConcurrency: 1, writeConcurrency: 1 });
  const events = [];
  let releaseWrite;
  const writeA = queue.enqueue(
    { jobId: 'write-a', requestId: 'write-a', priority: 'WRITE', shopId: 'shop-a', endpointKey: 'products.write' },
    async () => new Promise((resolve) => {
      events.push('write-a-start');
      releaseWrite = () => {
        events.push('write-a-end');
        resolve('write-a');
      };
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  const readB = queue.enqueue(
    { jobId: 'read-b', requestId: 'read-b', priority: 'P1', shopId: 'shop-b', endpointKey: 'products.list' },
    async () => {
      events.push('read-b');
      return 'read-b';
    },
  );
  assert.equal(await readB, 'read-b');
  assert.deepEqual(events, ['write-a-start', 'read-b']);
  releaseWrite();
  assert.equal(await writeA, 'write-a');
});

test('requestQueue applies endpoint concurrency per shop instead of across shops', async () => {
  const queue = createRequestQueue({ shopConcurrency: 1, endpointConcurrency: 1 });
  const started = [];
  const releases = new Map();
  const run = (shopId) => queue.enqueue(
    { jobId: `${shopId}-job`, requestId: `${shopId}-request`, priority: 'P1', shopId, endpointKey: 'products.list' },
    async () => new Promise((resolve) => {
      started.push(shopId);
      releases.set(shopId, () => resolve(shopId));
    }),
  );

  const shopA = run('shop-a');
  const shopB = run('shop-b');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...started].sort(), ['shop-a', 'shop-b']);
  releases.get('shop-a')();
  releases.get('shop-b')();
  assert.deepEqual((await Promise.all([shopA, shopB])).sort(), ['shop-a', 'shop-b']);
});

test('requestQueue fails closed when shopId is missing', async () => {
  const queue = createRequestQueue();
  await assert.rejects(
    () => queue.enqueue({ jobId: 'missing-shop', endpointKey: 'products.list' }, async () => 'no'),
    (error) => error?.code === 'OZON_QUEUE_SHOP_SCOPE_REQUIRED',
  );
});

test('requestQueue gives ten independent shops equal progress without starvation', async () => {
  const queue = createRequestQueue({
    shopConcurrency: 1,
    endpointConcurrency: 1,
    maxQueueSize: 100,
    queueTimeoutMs: 10_000,
  });
  const shops = Array.from({ length: 10 }, (_, index) => `fair-shop-${index + 1}`);
  const executionOrder = [];
  const tasks = [];
  for (const shopId of shops) {
    for (let index = 0; index < 5; index += 1) {
      tasks.push(queue.enqueue({
        jobId: `${shopId}-job-${index}`,
        requestId: `${shopId}-request-${index}`,
        priority: 'P1',
        profile: 'background',
        shopId,
        endpointKey: 'products.list',
      }, async () => {
        executionOrder.push(shopId);
        await Promise.resolve();
        return `${shopId}:${index}`;
      }));
    }
  }

  await Promise.all(tasks);
  assert.equal(executionOrder.length, 50);
  for (let offset = 0; offset < executionOrder.length; offset += shops.length) {
    assert.deepEqual(
      [...new Set(executionOrder.slice(offset, offset + shops.length))].sort(),
      [...shops].sort(),
      `round ${offset / shops.length + 1} starved at least one shop`,
    );
  }
  assert.deepEqual(queue.getStatus().activeByShop, {});
  assert.equal(queue.getStatus().queued, 0);
});

test('requestQueue enforces one global budget and separate foreground/background budgets across twenty shops', async () => {
  const queue = createRequestQueue({
    globalConcurrency: 8,
    shopConcurrency: 8,
    endpointConcurrency: 8,
    profiles: {
      foreground: { globalConcurrency: 6, shopConcurrency: 8, endpointConcurrency: 8 },
      background: { globalConcurrency: 2, shopConcurrency: 1, endpointConcurrency: 1 },
    },
  });
  let active = 0;
  let maxActive = 0;
  const activeByProfile = { foreground: 0, background: 0 };
  const maxByProfile = { foreground: 0, background: 0 };
  const run = (profile, index) => queue.enqueue({
    jobId: `${profile}-${index}`,
    requestId: `${profile}-request-${index}`,
    priority: profile === 'foreground' ? 'P1' : 'P3',
    profile,
    shopId: `${profile}-shop-${index + 1}`,
    endpointKey: 'orders.list',
  }, async () => {
    active += 1;
    activeByProfile[profile] += 1;
    maxActive = Math.max(maxActive, active);
    maxByProfile[profile] = Math.max(maxByProfile[profile], activeByProfile[profile]);
    await new Promise((resolve) => setTimeout(resolve, 2));
    activeByProfile[profile] -= 1;
    active -= 1;
    return `${profile}:${index}`;
  });

  const tasks = [
    ...Array.from({ length: 20 }, (_, index) => run('foreground', index)),
    ...Array.from({ length: 20 }, (_, index) => run('background', index)),
  ];
  await Promise.all(tasks);

  assert.equal(maxActive, 8);
  assert.equal(maxByProfile.foreground, 6);
  assert.equal(maxByProfile.background, 2);
  assert.equal(queue.getStatus().limits.globalConcurrency, 8);
});

test('requestQueue allows only one write globally even when writes belong to different shops', async () => {
  const queue = createRequestQueue({ globalConcurrency: 8, writeConcurrency: 1 });
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const runWrite = (shopId) => queue.enqueue({
    jobId: `write-${shopId}`,
    requestId: `write-request-${shopId}`,
    priority: 'WRITE',
    profile: 'write',
    shopId,
    endpointKey: 'products.write',
  }, async () => {
    activeWrites += 1;
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    await new Promise((resolve) => setTimeout(resolve, 2));
    activeWrites -= 1;
    return shopId;
  });

  await Promise.all([runWrite('shop-a'), runWrite('shop-b'), runWrite('shop-c')]);
  assert.equal(maxActiveWrites, 1);
});

test('requestQueue coalesces identical permit-wait telemetry instead of flooding SQLite traces', async () => {
  const events = [];
  const queue = createRequestQueue({
    permitController: {
      reserve() {
        return { allowed: false, status: 'waiting', waitMs: 1 };
      },
    },
    permitWaitTraceIntervalMs: 1_000,
    onEvent: (event) => events.push(event),
  });
  const task = queue.enqueue({
    jobId: 'permit-wait-job',
    requestId: 'permit-wait-request',
    shopId: 'permit-wait-shop',
    endpointKey: 'orders.list',
  }, async () => 'never-runs');

  await new Promise((resolve) => setTimeout(resolve, 20));
  queue.cancelJob('permit-wait-job');
  await assert.rejects(task, (error) => error?.code === 'OZON_QUEUE_JOB_CANCELED');
  assert.equal(events.filter((event) => event.phase === 'permit_wait').length, 1);
});

