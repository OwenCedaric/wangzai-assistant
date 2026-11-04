import assert from 'node:assert/strict';
import test from 'node:test';
import { createIdleCacheMaintenance } from './idleCacheMaintenance.js';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };

test('maintenance intervals reject invalid and overflowing timers instead of creating a retry spin', () => {
  for (const options of [{ idleQuietMs: -1 }, { retryDelayMs: 0 }, { retryDelayMs: Infinity },
    { maxRetryDelayMs: 500 }, { minimumIntervalMs: 2_147_483_648 }, { checkIntervalMs: '1000' }]) {
    assert.throws(() => createIdleCacheMaintenance(options), /CACHE_MAINTENANCE_INVALID_/);
  }
});

test('automatic cache maintenance defers for any active or unknown runtime without touching resources', async () => {
  let runs = 0;
  for (const isIdle of [() => false, () => { throw new Error('unknown activity'); }]) {
    const maintenance = createIdleCacheMaintenance({ run: async () => { runs++; }, isIdle });
    assert.equal((await maintenance.request({ force: true })).status, 'deferred');
  }
  assert.equal(runs, 0);
});

test('opening wins over an idle check even before the native session exists', async () => {
  const opening = deferred(); let runs = 0;
  const maintenance = createIdleCacheMaintenance({ run: async () => { runs++; }, isIdle: () => true });
  const access = maintenance.withAccess(() => opening.promise);
  assert.equal((await maintenance.request({ force: true })).reason, 'active-runtime');
  assert.equal(runs, 0);
  opening.resolve('opened'); assert.equal(await access, 'opened');
});

test('foreground open cancels cleanup but waits for its actual settlement before starting native work', async () => {
  const exited = deferred(), started = deferred(); let signal, opened = false, runs = 0;
  const maintenance = createIdleCacheMaintenance({ isIdle: () => true, run: options => {
    signal = options.signal; runs++; started.resolve(); return exited.promise;
  } });
  const cleanup = maintenance.request({ force: true }); await started.promise;
  assert.equal(maintenance.request({ force: true }), cleanup);
  const access = maintenance.withAccess(() => { opened = true; return 'opened'; });
  assert.equal(signal.aborted, true); await Promise.resolve(); assert.equal(opened, false);
  exited.resolve({ ok: false, cancelled: true, removed: null, exitVerified: true });
  assert.equal(await access, 'opened'); assert.equal(runs, 1);
});

test('background preparation waits for maintenance without cancelling it', async () => {
  const exiting = deferred(), started = deferred(); let signal;
  const maintenance = createIdleCacheMaintenance({ isIdle: () => true, run: options => {
    signal = options.signal; started.resolve(); return exiting.promise;
  } });
  const cleanup = maintenance.request(); await started.promise;
  const access = maintenance.withAccess(() => true, { interrupt: false });
  assert.equal(signal.aborted, false);
  exiting.resolve({ ok: true, removed: 0, exitVerified: true });
  await cleanup; assert.equal(await access, true);
});

test('idle checks are rate-limited, stop removes the timer, and worker failure is not reported as cleanup success', async () => {
  let current = 0, runs = 0, tick, cleared = false;
  const maintenance = createIdleCacheMaintenance({ isIdle: () => true, now: () => current, minimumIntervalMs: 100,
    idleQuietMs: 0, retryDelayMs: 100, maxRetryDelayMs: 400,
    run: async () => { runs++; return { ok: false, code: 'LOCKED', exitVerified: true }; },
    setIntervalImpl: callback => { tick = callback; return 1; }, clearIntervalImpl: () => { cleared = true; },
  });
  maintenance.start(); await maintenance.request(); assert.equal(maintenance.snapshot().status, 'deferred');
  current = 50; await maintenance.request(); assert.equal(runs, 1);
  current = 101; await maintenance.request(); assert.equal(runs, 2);
  await maintenance.stop(); tick(); await Promise.resolve(); assert.equal(runs, 2); assert.equal(cleared, true);
});

test('stop rejects access already queued behind maintenance instead of running it after stop', async () => {
  const exited = deferred(), started = deferred(); let opened = false;
  const maintenance = createIdleCacheMaintenance({ isIdle: () => true, run() { started.resolve(); return exited.promise; } });
  const cleanup = maintenance.request(); await started.promise;
  const access = maintenance.withAccess(() => { opened = true; return true; }, { interrupt: false });
  access.catch(() => undefined);
  const stopped = maintenance.stop();
  exited.resolve({ ok: false, cancelled: true, exitVerified: true });
  await cleanup; await stopped;
  await assert.rejects(access, { code: 'CACHE_MAINTENANCE_ACCESS_CANCELLED' });
  assert.equal(opened, false);
});

function fakeClock() {
  let current = 0, sequence = 0;
  const timeouts = new Map(), intervals = new Map();
  return {
    now: () => current,
    setTimeoutImpl(callback, delay) { const id = ++sequence; timeouts.set(id, { callback, at: current + delay }); return id; },
    clearTimeoutImpl(id) { timeouts.delete(id); },
    setIntervalImpl(callback) { const id = ++sequence; intervals.set(id, callback); return id; },
    clearIntervalImpl(id) { intervals.delete(id); },
    get timers() { return timeouts; }, get intervals() { return intervals; },
    async advanceTo(value) {
      let next;
      while ((next = [...timeouts.entries()].filter(([, task]) => task.at <= value).sort((a, b) => a[1].at - b[1].at)[0])) {
        timeouts.delete(next[0]); current = next[1].at; await next[1].callback();
      }
      current = value;
    },
  };
}

test('idle transition waits sixty quiet seconds, then successful worker exit keeps the six-hour limit', async () => {
  const clock = fakeClock(); let runs = 0;
  const maintenance = createIdleCacheMaintenance({ ...clock, isIdle: () => true,
    run: async () => { runs++; return { ok: true, removed: 0, triggered: false, exitVerified: true }; },
  });
  maintenance.start(); assert.equal(maintenance.snapshot().scheduledAt, 60000);
  await clock.advanceTo(59999);
  assert.equal((await maintenance.request()).due, false, 'the fallback poll cannot skip the quiet period');
  assert.equal(runs, 0);
  await clock.advanceTo(60000); assert.equal(runs, 1);
  assert.equal(maintenance.snapshot().lastSuccessAt, 60000);
  const nextAt = 60000 + 6 * 60 * 60 * 1000;
  await clock.advanceTo(nextAt - 1); await maintenance.request(); assert.equal(runs, 1);
  await clock.advanceTo(nextAt); assert.equal(runs, 2);
  await maintenance.stop(); assert.equal(clock.timers.size, 0); assert.equal(clock.intervals.size, 0);
});

test('cancellation and thrown worker failures retry with bounded backoff instead of consuming a success interval', async () => {
  const clock = fakeClock(); let runs = 0;
  const maintenance = createIdleCacheMaintenance({ ...clock, isIdle: () => true,
    run: async () => {
      runs++;
      if (runs === 1) return { ok: false, cancelled: true, exitVerified: true };
      if (runs < 7) throw Object.assign(new Error('fixture-locked'), { code: 'LOCKED' });
      return { ok: true, exitVerified: true };
    },
  });
  maintenance.start();
  let at = 60000;
  for (const delay of [60000, 120000, 240000, 480000, 900000, 900000]) {
    await clock.advanceTo(at);
    assert.equal(maintenance.snapshot().lastSuccessAt, null);
    assert.equal(maintenance.snapshot().retryAt, at + delay);
    assert.equal(maintenance.snapshot().scheduledAt, at + delay);
    at += delay;
  }
  await clock.advanceTo(at); assert.equal(runs, 7);
  assert.equal(maintenance.snapshot().status, 'completed');
  assert.equal(maintenance.snapshot().retryAt, null);
  assert.equal(maintenance.snapshot().consecutiveFailures, 0);
  await maintenance.stop();
});

test('an opening reservation cancels the quiet timer and stale callbacks cannot retire a quickly reopened runtime', async () => {
  const clock = fakeClock(); const gate = deferred(); let active = false, prepared = 0;
  const maintenance = createIdleCacheMaintenance({ ...clock, isIdle: () => !active,
    prepare: async () => { prepared++; }, run: async () => ({ ok: true, exitVerified: true }),
  });
  maintenance.start(); const staleTick = [...clock.timers.values()][0].callback;
  await clock.advanceTo(30000);
  const opening = maintenance.withAccess(async () => { await gate.promise; active = true; });
  assert.equal(clock.timers.size, 0);
  await staleTick(); await clock.advanceTo(120000); assert.equal(prepared, 0);
  gate.resolve(); await opening;
  assert.equal(clock.timers.size, 0, 'an active owner must not arm maintenance');
  active = false; maintenance.notifyIdle();
  assert.equal(maintenance.snapshot().scheduledAt, 180000);
  await clock.advanceTo(179999); assert.equal(prepared, 0);
  await clock.advanceTo(180000); assert.equal(prepared, 1);
  await maintenance.stop();
});

test('cancel and stop release pending checks and unverified results do not become successful cleanup', async () => {
  const clock = fakeClock(); let runs = 0;
  const maintenance = createIdleCacheMaintenance({ ...clock, isIdle: () => true,
    run: async () => { runs++; return { ok: true, exitVerified: false }; },
  });
  maintenance.start(); await maintenance.cancel(); assert.equal(clock.timers.size, 0);
  await clock.advanceTo(120000); assert.equal(runs, 0);
  maintenance.notifyIdle(); await clock.advanceTo(180000);
  assert.equal(maintenance.snapshot().status, 'deferred'); assert.equal(maintenance.snapshot().lastSuccessAt, null);
  const staleTick = [...clock.timers.values()][0].callback;
  await maintenance.stop(); await staleTick(); await clock.advanceTo(3600000);
  assert.equal(runs, 1); assert.equal(clock.timers.size, 0); assert.equal(clock.intervals.size, 0);
});
