import assert from 'node:assert/strict';
import test from 'node:test';
import { createPurchaseBrowserCommandQueue } from './purchaseBrowserCommandQueue.js';

test('purchase browser command queue serializes work and exposes lifecycle state', async () => {
  const states = [];
  const queue = createPurchaseBrowserCommandQueue({
    onStateChanged: (snapshot) => states.push(snapshot.state),
  });
  const order = [];
  const first = queue.enqueue('first', async () => {
    order.push('first-start');
    await new Promise((resolve) => setTimeout(resolve, 8));
    order.push('first-end');
    return 1;
  });
  const second = queue.enqueue('second', async () => {
    order.push('second');
    return 2;
  });
  assert.equal(await first, 1);
  assert.equal(await second, 2);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  assert.equal(queue.getSnapshot().state, 'idle');
  assert.ok(states.includes('busy'));
  queue.dispose();
});

test('owner-scoped maintenance cancellation leaves unrelated active/pending work untouched', async () => {
  const queue = createPurchaseBrowserCommandQueue();
  let release;
  const active = queue.enqueue('read-a', () => new Promise(resolve => { release = resolve; }), { scope: { ownerRef: 'owner-a' } });
  const pendingA = queue.enqueue('write-a', async () => 'unexpected', { scope: { ownerRef: 'owner-a' } });
  const pendingB = queue.enqueue('read-b', async () => 'kept-b', { scope: { ownerRef: 'owner-b' } });
  const activeCancelled = assert.rejects(active, { code: 'PURCHASE_BROWSER_COMMAND_CANCELLED' });
  const pendingCancelled = assert.rejects(pendingA, { code: 'PURCHASE_BROWSER_COMMAND_CANCELLED' });
  assert.deepEqual(queue.cancelMatching(({ scope }) => scope?.ownerRef === 'owner-a'), { canceled: 2 });
  await activeCancelled;
  await pendingCancelled;
  assert.equal(await pendingB, 'kept-b');
  release('late-a');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.getSnapshot().state, 'idle');
  queue.dispose();
});

test('latest-key bounds work supersedes stale pending work', async () => {
  const queue = createPurchaseBrowserCommandQueue();
  let release;
  const active = queue.enqueue('active', () => new Promise((resolve) => { release = resolve; }));
  const stale = queue.enqueue('bounds-old', async () => 'old', { latestKey: 'bounds' });
  const latest = queue.enqueue('bounds-new', async () => 'new', { latestKey: 'bounds' });
  await assert.rejects(stale, (error) => error.code === 'PURCHASE_BROWSER_COMMAND_SUPERSEDED');
  release('done');
  await active;
  assert.equal(await latest, 'new');
  queue.dispose();
});

test('same-key work shares one active or pending command instead of growing the queue', async () => {
  const queue = createPurchaseBrowserCommandQueue();
  let release;
  let runs = 0;
  const task = () => {
    runs += 1;
    return new Promise((resolve) => { release = resolve; });
  };
  const requests = Array.from(
    { length: 100 },
    () => queue.enqueue('prewarm', task, { coalesceKey: 'prewarm\u0000purchase-a\u0000interactive' }),
  );

  assert.equal(runs, 1);
  assert.equal(queue.getSnapshot().pending.length, 0);
  release('ready');
  assert.deepEqual(await Promise.all(requests), Array.from({ length: 100 }, () => 'ready'));
  queue.dispose();
});

test('an atomic open drops stale pending bounds without becoming supersedable itself', async () => {
  const queue = createPurchaseBrowserCommandQueue();
  let release;
  const active = queue.enqueue('active', () => new Promise((resolve) => { release = resolve; }));
  const staleBounds = queue.enqueue('bounds', async () => 'stale', { latestKey: 'bounds' });
  const open = queue.enqueue('open', async () => 'opened', {
    priority: 'high',
    supersedePendingKeys: ['bounds'],
  });
  const freshBounds = queue.enqueue('bounds', async () => 'fresh', { latestKey: 'bounds' });

  await assert.rejects(staleBounds, (error) => error.code === 'PURCHASE_BROWSER_COMMAND_SUPERSEDED');
  release('active-done');
  await active;
  assert.equal(await open, 'opened');
  assert.equal(await freshBounds, 'fresh');
  queue.dispose();
});

test('timeout aborts the task and does not create an unhandled rejection', async () => {
  const queue = createPurchaseBrowserCommandQueue();
  let aborted = false;
  await assert.rejects(
    queue.enqueue('hang', ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }), { timeoutMs: 10 }),
    (error) => error.code === 'PURCHASE_BROWSER_COMMAND_TIMEOUT',
  );
  assert.equal(aborted, true);
  queue.dispose();
});

test('ten timed-out native-like tasks keep the next command fenced until the late task settles', async () => {
  for (let round = 0; round < 10; round += 1) {
    const queue = createPurchaseBrowserCommandQueue();
    const order = [];
    let release;
    const slow = queue.enqueue('slow-native', async () => {
      order.push('slow-start');
      await new Promise((resolve) => { release = resolve; });
      order.push('slow-finished');
    }, { timeoutMs: 5 });
    await assert.rejects(slow, { code: 'PURCHASE_BROWSER_COMMAND_TIMEOUT' });
    const next = queue.enqueue('next', async () => { order.push('next'); });
    await new Promise((resolve) => setTimeout(resolve, 2));
    assert.deepEqual(order, ['slow-start']);
    release();
    await next;
    assert.deepEqual(order, ['slow-start', 'slow-finished', 'next']);
    queue.dispose();
  }
});

test('high-priority lifecycle work preempts active work before another normal task starts', async () => {
  const queue = createPurchaseBrowserCommandQueue();
  const order = [];
  let release;
  const active = queue.enqueue('open', ({ signal }) => new Promise((resolve, reject) => {
    order.push('open-start');
    release = resolve;
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), {
      code: 'PURCHASE_BROWSER_COMMAND_CANCELLED',
    })), { once: true });
  }));
  const normal = queue.enqueue('navigate', async () => {
    order.push('navigate');
    return 'navigate';
  });
  const close = queue.enqueue('close', async () => {
    order.push('close');
    return 'closed';
  }, { priority: 'high', preemptActive: true });

  await assert.rejects(active, (error) => error.code === 'PURCHASE_BROWSER_COMMAND_CANCELLED');
  assert.equal(await close, 'closed');
  assert.equal(await normal, 'navigate');
  assert.deepEqual(order, ['open-start', 'close', 'navigate']);
  release?.('late');
  queue.dispose();
});

test('selective high-priority work preempts only the matching background command', async () => {
  const queue = createPurchaseBrowserCommandQueue();
  const order = [];
  let releaseInteractive;
  const interactive = queue.enqueue('capture-confirm', ({ signal }) => new Promise((resolve, reject) => {
    order.push('interactive-start');
    releaseInteractive = resolve;
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), {
      code: 'PURCHASE_BROWSER_COMMAND_CANCELLED',
    })), { once: true });
  }));
  const firstOpen = queue.enqueue('open', async () => {
    order.push('first-open');
    return 'first-open';
  }, {
    priority: 'high',
    preemptActive: ({ name }) => name.startsWith('ozon-data-'),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ['interactive-start']);
  releaseInteractive('confirmed');
  assert.equal(await interactive, 'confirmed');
  assert.equal(await firstOpen, 'first-open');

  const pagination = queue.enqueue('ozon-data-paginate', ({ signal }) => new Promise((resolve, reject) => {
    order.push('pagination-start');
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), {
      code: 'PURCHASE_BROWSER_COMMAND_CANCELLED',
    })), { once: true });
  }));
  const urgentOpen = queue.enqueue('open', async () => {
    order.push('urgent-open');
    return 'urgent-open';
  }, {
    priority: 'high',
    preemptActive: ({ name }) => name.startsWith('ozon-data-'),
  });

  await assert.rejects(pagination, (error) => error.code === 'PURCHASE_BROWSER_COMMAND_CANCELLED');
  assert.equal(await urgentOpen, 'urgent-open');
  assert.deepEqual(order, [
    'interactive-start',
    'first-open',
    'pagination-start',
    'urgent-open',
  ]);
  queue.dispose();
});

test('failed commands expose an error state until a new command is accepted', async () => {
  const queue = createPurchaseBrowserCommandQueue();
  await assert.rejects(
    queue.enqueue('broken', async () => {
      throw Object.assign(new Error('broken'), { code: 'PURCHASE_BROWSER_CEF_HOST_UNHEALTHY' });
    }),
    (error) => error.code === 'PURCHASE_BROWSER_CEF_HOST_UNHEALTHY',
  );
  assert.equal(queue.getSnapshot().state, 'error');
  await queue.enqueue('recover', async () => 'ok');
  assert.equal(queue.getSnapshot().state, 'idle');
  queue.dispose();
});

test('cancelPending, cancelActive and drain release every queue slot', async () => {
  const queue = createPurchaseBrowserCommandQueue();
  let release;
  const active = queue.enqueue('active', ({ signal }) => new Promise((resolve, reject) => {
    release = resolve;
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), {
      code: 'PURCHASE_BROWSER_COMMAND_CANCELLED',
    })), { once: true });
  }));
  const pending = queue.enqueue('pending', async () => 'never-started');
  assert.equal(queue.cancelPending(), undefined);
  await assert.rejects(pending, { code: 'PURCHASE_BROWSER_COMMAND_CANCELLED' });
  assert.equal(queue.cancelActive(), true);
  await assert.rejects(active, { code: 'PURCHASE_BROWSER_COMMAND_CANCELLED' });
  await queue.drain();
  assert.equal(queue.getSnapshot().state, 'idle');
  release?.('late');
  queue.dispose();
});
