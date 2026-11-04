import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeRetirementBarrier } from './runtimeRetirementBarrier.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('retired runtime stays fenced after the caller drops its reference and repeated disposal is single-flight', async () => {
  const exit = deferred();
  let disposals = 0;
  let runtime = { dispose: () => { disposals++; return exit.promise; } };
  const barrier = createRuntimeRetirementBarrier();
  const retirement = barrier.retire(runtime);
  assert.equal(barrier.retire(runtime), retirement);
  runtime = null;
  assert.equal(barrier.size, 1);
  await assert.rejects(barrier.wait({ timeoutMs: 10 }), { code: 'DESKTOP_NATIVE_RETIREMENT_TIMEOUT' });
  assert.equal(barrier.size, 1, 'a UI timeout cannot release files to a new runtime');
  exit.resolve({ ok: true, exitVerified: true });
  await retirement;
  assert.equal((await barrier.wait()).ok, true);
  assert.equal(barrier.size, 0);
  assert.equal(disposals, 1);
});

test('a bounded dispose timeout waits for the actual pending shutdown receipt', async () => {
  const exit = deferred();
  let shutdowns = 0;
  const runtime = { dispose: () => ({ ok: true, timedOut: true }),
    shutdown: () => { shutdowns++; return exit.promise; } };
  const barrier = createRuntimeRetirementBarrier();
  barrier.retire(runtime);
  await assert.rejects(barrier.wait({ timeoutMs: 10 }), { code: 'DESKTOP_NATIVE_RETIREMENT_TIMEOUT' });
  assert.equal(shutdowns, 1);
  exit.resolve({ ok: true, exitVerified: true });
  await barrier.wait();
  assert.equal(barrier.size, 0);
});

test('failed or unverified retirement remains blocked and is never hidden by logging failure', async () => {
  const barrier = createRuntimeRetirementBarrier({ onFailure() { throw new Error('diagnostic error'); } });
  await assert.rejects(barrier.retire({ dispose: () => ({ ok: true, exitVerified: false }) }),
    { code: 'DESKTOP_NATIVE_RETIREMENT_UNVERIFIED' });
  await assert.rejects(barrier.wait(), { code: 'DESKTOP_NATIVE_RETIREMENT_UNVERIFIED' });
  assert.equal(barrier.size, 1);
});

test('a legacy ok without an actual exit receipt cannot authorize a new runtime', async () => {
  const barrier = createRuntimeRetirementBarrier();
  await assert.rejects(barrier.retire({ dispose: () => ({ ok: true }) }),
    { code: 'DESKTOP_NATIVE_RETIREMENT_UNVERIFIED' });
  await assert.rejects(barrier.wait(), { code: 'DESKTOP_NATIVE_RETIREMENT_UNVERIFIED' });
});

test('replacement also waits for another retirement registered while the first one is draining', async () => {
  const first = deferred(), second = deferred();
  const barrier = createRuntimeRetirementBarrier();
  barrier.retire({ dispose: () => first.promise });
  let ready = false;
  const waiting = barrier.wait().then(() => { ready = true; });
  barrier.retire({ dispose: () => second.promise });
  first.resolve({ ok: true, exitVerified: true });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(ready, false);
  second.resolve({ ok: true, exitVerified: true });
  await waiting;
  assert.equal(ready, true);
});
