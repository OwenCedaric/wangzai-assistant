import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createRuntimeLifecycleController } from './runtimeLifecycleController.js';

function createFakeWindow() {
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  window.hidden = 0;
  window.shown = 0;
  window.focused = 0;
  window.restored = 0;
  window.minimized = false;
  window.destroyed = false;
  window.hide = () => { window.hidden += 1; };
  window.show = () => { window.shown += 1; };
  window.focus = () => { window.focused += 1; };
  window.restore = () => { window.restored += 1; window.minimized = false; };
  window.isMinimized = () => window.minimized;
  window.isDestroyed = () => window.destroyed;
  return window;
}

test('closing to tray hides only the window and tray restore reuses the same runtime owner', async () => {
  const window = createFakeWindow();
  const tray = new EventEmitter();
  let quitting = false;
  let serviceStops = 0;
  let profileLockReleases = 0;
  let restoredCallbacks = 0;
  const lifecycle = createRuntimeLifecycleController({
    closeToTrayEnabled: true,
    isQuitting: () => quitting,
    getWindow: () => window,
    createWindow: async () => window,
    onSuspend: async () => { serviceStops += 1; },
    onWindowRestored: async () => { restoredCallbacks += 1; },
  });
  lifecycle.attachTray(tray);
  lifecycle.bindWindow(window);

  let prevented = 0;
  window.emit('close', { preventDefault() { prevented += 1; } });
  assert.equal(prevented, 1);
  assert.equal(window.hidden, 1);
  assert.equal(serviceStops, 0, 'tray hiding must not stop local-api');
  assert.equal(profileLockReleases, 0, 'tray hiding must not release the profile lock');
  assert.equal(lifecycle.shouldKeepAliveWithoutWindows(), true);

  window.minimized = true;
  tray.emit('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(window.restored, 1);
  assert.equal(window.shown, 1);
  assert.equal(window.focused, 1);
  assert.equal(restoredCallbacks, 1);

  quitting = true;
  window.emit('close', { preventDefault() { prevented += 1; } });
  assert.equal(prevented, 1, 'explicit quit is not intercepted by tray behavior');
  assert.equal(window.hidden, 1);
  profileLockReleases += 1;
  assert.equal(profileLockReleases, 1);
});

test('automation mode never intercepts close when no tray is installed', () => {
  const window = createFakeWindow();
  const lifecycle = createRuntimeLifecycleController({
    closeToTrayEnabled: false,
    getWindow: () => window,
  });
  lifecycle.bindWindow(window);
  let prevented = false;
  window.emit('close', { preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(window.hidden, 0);
  assert.equal(lifecycle.shouldKeepAliveWithoutWindows(), false);
});

test('a native Tray initialization failure never strands an invisible main process', () => {
  const lifecycle = createRuntimeLifecycleController({
    closeToTrayEnabled: true,
    getWindow: () => null,
  });
  assert.equal(lifecycle.canHideToTray(), false);
  assert.equal(lifecycle.shouldKeepAliveWithoutWindows(), false);
});

test('power resume waits for suspend checkpoint, coalesces duplicates, and then invokes one recovery restart', async () => {
  let releaseCheckpoint;
  const checkpointGate = new Promise((resolve) => { releaseCheckpoint = resolve; });
  const events = [];
  const lifecycle = createRuntimeLifecycleController({
    onSuspend: async () => {
      events.push('pause-and-checkpoint-start');
      await checkpointGate;
      events.push('pause-and-checkpoint-finished');
      return { stopped: true, persistentWorkPreserved: true };
    },
    onResume: async () => {
      events.push('recover-and-reconcile');
      return { restarted: true, shopIsolation: true };
    },
  });

  const suspend = lifecycle.handleSuspend();
  const resumedA = lifecycle.handleResume();
  const resumedB = lifecycle.handleResume();
  assert.equal(resumedA, resumedB, 'duplicate resume events share one recovery transition');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['pause-and-checkpoint-start']);

  releaseCheckpoint();
  assert.equal((await suspend).ok, true);
  const resumed = await resumedA;
  assert.equal(resumed.ok, true);
  assert.deepEqual(events, [
    'pause-and-checkpoint-start',
    'pause-and-checkpoint-finished',
    'recover-and-reconcile',
  ]);
  assert.deepEqual(lifecycle.getStatus(), {
    closeToTrayEnabled: true,
    trayAttached: false,
    suspended: false,
    resuming: false,
    disposed: false,
  });
});

test('renderer crash observation never invokes the service suspend path', () => {
  const window = createFakeWindow();
  let suspended = 0;
  const logs = [];
  const lifecycle = createRuntimeLifecycleController({
    getWindow: () => window,
    onSuspend: async () => { suspended += 1; },
    logger: (event, details) => logs.push({ event, details }),
  });
  lifecycle.bindWindow(window);
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 });
  assert.equal(suspended, 0);
  assert.deepEqual(logs, [{ event: 'renderer-gone', details: { reason: 'crashed', exitCode: 9 } }]);
});

test('user activation reloads a crashed renderer once without replaying business operations', async () => {
  const window = createFakeWindow();
  const calls = { reloads: 0, creates: 0, suspends: 0, resumes: 0, restored: 0 };
  window.webContents.reload = () => { calls.reloads += 1; };
  const lifecycle = createRuntimeLifecycleController({
    getWindow: () => window,
    createWindow: async () => { calls.creates += 1; return window; },
    onSuspend: async () => { calls.suspends += 1; },
    onResume: async () => { calls.resumes += 1; },
    onWindowRestored: () => { calls.restored += 1; },
  });
  lifecycle.bindWindow(window);
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(calls.reloads, 0, 'a crash alone must not restart/replay anything');
  const first = lifecycle.restoreWindow();
  const duplicate = lifecycle.restoreWindow();
  assert.equal(first, duplicate, 'click and double-click share one renderer recovery');
  assert.equal(calls.reloads, 1);
  assert.equal(window.shown, 0, 'wait for the new renderer to finish loading');
  window.webContents.emit('did-finish-load');
  assert.equal(await first, window);
  assert.deepEqual(calls, { reloads: 1, creates: 0, suspends: 0, resumes: 0, restored: 1 });
  await lifecycle.restoreWindow();
  assert.equal(calls.reloads, 1, 'a healthy renderer is never reloaded by tray activation');
  assert.equal(window.shown, 2);
  lifecycle.dispose();
});

test('crash recovery is bounded and reports a restart requirement instead of a reload loop', async () => {
  const window = createFakeWindow();
  let now = 10_000;
  let reloads = 0;
  const failures = [];
  window.webContents.reload = () => {
    reloads += 1;
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  };
  const lifecycle = createRuntimeLifecycleController({
    getWindow: () => window,
    now: () => now,
    onRendererRecoveryFailed: error => failures.push(error.code),
  });
  lifecycle.bindWindow(window);
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(lifecycle.restoreWindow(), { code: 'DESKTOP_RENDERER_RECOVERY_CRASHED' });
  }
  await assert.rejects(lifecycle.restoreWindow(), { code: 'DESKTOP_RENDERER_RECOVERY_LIMIT' });
  assert.equal(reloads, 2);
  assert.deepEqual(failures, [
    'DESKTOP_RENDERER_RECOVERY_CRASHED',
    'DESKTOP_RENDERER_RECOVERY_CRASHED',
    'DESKTOP_RENDERER_RECOVERY_LIMIT',
  ]);
  assert.equal(window.shown, 0);
  now += 60_001;
  window.webContents.reload = () => { reloads += 1; window.webContents.emit('did-finish-load'); };
  assert.equal(await lifecycle.restoreWindow(), window);
  assert.equal(reloads, 3, 'a later explicit user attempt is available after the cooldown');
  lifecycle.dispose();
});

test('renderer recovery timeout and main-frame failure remove transient listeners', async () => {
  for (const reason of ['timeout', 'load-failure']) {
    const window = createFakeWindow();
    const failures = [];
    window.webContents.reload = () => {
      window.webContents.emit('did-fail-load', {}, -105, '', '', false);
      if (reason === 'load-failure') window.webContents.emit('did-fail-load', {}, -105, '', '', true);
    };
    const lifecycle = createRuntimeLifecycleController({
      getWindow: () => window,
      rendererRecoveryTimeoutMs: 10,
      onRendererRecoveryFailed: error => failures.push(error.code),
    });
    lifecycle.bindWindow(window);
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    const code = reason === 'timeout' ? 'DESKTOP_RENDERER_RECOVERY_TIMEOUT' : 'DESKTOP_RENDERER_RECOVERY_LOAD_FAILED';
    await assert.rejects(lifecycle.restoreWindow(), { code });
    assert.deepEqual(failures, [code]);
    assert.equal(window.webContents.listenerCount('did-fail-load'), 0);
    assert.equal(window.webContents.listenerCount('did-finish-load'), 1);
    assert.equal(window.webContents.listenerCount('render-process-gone'), 1);
    assert.equal(window.listenerCount('closed'), 0);
    lifecycle.dispose();
  }
});

test('disposing during renderer recovery cancels it without showing UI or touching services', async () => {
  const window = createFakeWindow();
  let failures = 0;
  window.webContents.reload = () => undefined;
  const lifecycle = createRuntimeLifecycleController({
    getWindow: () => window,
    onRendererRecoveryFailed: () => { failures += 1; },
  });
  lifecycle.bindWindow(window);
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  const recovering = lifecycle.restoreWindow();
  lifecycle.dispose();
  await assert.rejects(recovering, { code: 'DESKTOP_RENDERER_RECOVERY_CANCELLED' });
  assert.equal(window.shown, 0);
  assert.equal(failures, 0);
  assert.equal(window.webContents.listenerCount('did-fail-load'), 0);
  assert.equal(await lifecycle.restoreWindow(), null);
});
