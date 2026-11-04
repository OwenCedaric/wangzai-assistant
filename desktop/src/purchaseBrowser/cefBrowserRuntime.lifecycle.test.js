import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCefBrowserRuntime } from './cefBrowserRuntime.js';

const ownerA = 'a'.repeat(40), ownerB = 'b'.repeat(40);

test('cross-border abort forwards only the exact owner and generated operation id', async t => {
  let original, respondOriginal, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { onCommand(request, respond) {
    if (request.command === 'cross-border-charges') { original = request; respondOriginal = respond; entered(); return false; }
    if (request.command === 'cross-border-cancel') {
      assert.equal(request.payload.ownerRef, ownerA);
      assert.equal(request.payload.operationId, original.id);
      respond({ ok: true, cancelled: true }); respondOriginal({ ok: false, code: 'CROSS_BORDER_OPERATION_CANCELLED' }); return false;
    }
  } });
  const browser = await f.open(ownerA); const other = await f.open(ownerB);
  const controller = new AbortController();
  const pending = browser.request('cross-border-charges', { operationId: 'renderer-must-not-select-id' }, 5000, controller.signal);
  await started; assert.equal(original.payload.operationId, original.id);
  controller.abort(); await pending;
  assert.equal(f.commands.filter(c => c.command === 'cross-border-cancel').length, 1);
  assert.equal((await other.request('state')).ok, true);
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function outcome(promise, milliseconds = 250) {
  let timer;
  try {
    return await Promise.race([
      promise.then(value => ({ value }), error => ({ error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-cef-pipe-fixture-'));
  const commands = [], peers = [], events = [], logs = [];
  let spawned;
  const spawnReady = new Promise(resolve => { spawned = resolve; });
  let spawnCount = 0;
  const runtime = createCefBrowserRuntime({ executable: process.execPath, rootCachePath: path.join(root, 'cache'),
    startupTimeoutMs: options.startupTimeoutMs || 100,
    cacheMaintenance: options.cacheMaintenance,
    appendLog: (_name, line) => logs.push(line), onHostAction: options.onHostAction,
    spawnProcess(_executable, args) {
      spawnCount += 1;
      const child = new EventEmitter();
      child.stderr = new EventEmitter(); child.stderr.setEncoding = () => undefined;
      child.exitCode = null;
      const peer = { child, socket: null, buffer: '' }; peers.push(peer);
      peer.finishExit = () => { child.exitCode = 0; peer.socket?.destroy(); child.emit('exit', 0); };
      child.kill = () => { if (!options.holdNativeExit) peer.finishExit(); };
      spawned();
      if (options.exitBeforePipe !== undefined && spawnCount === 1) {
        queueMicrotask(() => { child.exitCode = options.exitBeforePipe; child.emit('exit', options.exitBeforePipe); });
      } else if (!(options.neverConnect && spawnCount === 1)) {
        const name = args.find(arg => arg.startsWith('--wangzai-ipc-pipe=')).split('=')[1];
        const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join('/tmp', name);
        const socket = net.createConnection(endpoint); peer.socket = socket;
        socket.setEncoding('utf8'); socket.on('error', () => undefined);
        peer.send = value => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
        socket.on('connect', () => {
          if (options.startupFault) peer.send({ type: 'fault', error: { code: options.startupFault } });
          else if (!options.neverReady) peer.send({ type: 'ready', engine: 'synthetic-cef' });
        });
        socket.on('data', chunk => {
          peer.buffer += chunk;
          let end;
          while ((end = peer.buffer.indexOf('\n')) >= 0) {
            const line = peer.buffer.slice(0, end); peer.buffer = peer.buffer.slice(end + 1);
            if (!line) continue;
            const request = JSON.parse(line); commands.push(request); child.emit('protocol', request);
            if (!request.command) continue;
            const respond = data => peer.send({ type: 'response', id: request.id, ok: true, data });
            if (options.onCommand?.(request, respond, peer) === false) continue;
            respond({ ok: true, ...(request.command === 'force-close' ? { closed: true } : {}),
              url: request.payload?.url || 'about:blank', loading: false, health: 'healthy' });
          }
        });
      }
      return child;
    },
  });
  runtime.onEvent((event, details) => events.push({ event, details }));
  const open = (ownerRef = ownerA, overrides = {}) => runtime.open({ profile: { ownerRef }, profileRoot: path.join(root, 'profiles'),
    downloadsDirectory: path.join(root, 'downloads', ownerRef), url: 'about:blank', ...overrides });
  t.after(async () => { if (options.holdNativeExit) peers.forEach(peer => peer.finishExit()); await runtime.dispose(); peers.forEach(peer => peer.socket?.destroy()); fs.rmSync(root, { recursive: true, force: true }); });
  return { runtime, open, commands, peers, events, logs, spawnReady, get spawnCount() { return spawnCount; } };
}

test('a native host exiting before its pipe connects promptly rejects opening instead of hanging forever', async t => {
  const f = fixture(t, { exitBeforePipe: 23 });
  const result = await outcome(f.open());
  assert.equal(result.timedOut, undefined);
  assert.match(result.error?.code || '', /PURCHASE_BROWSER_CEF_HOST_EXIT_23/u);
  const reopened = await f.open();
  assert.equal(reopened.state.crashed, false);
  assert.equal(f.spawnCount, 2);
});

test('the startup deadline includes pipe connection time, not just the ready handshake', async t => {
  const f = fixture(t, { neverConnect: true });
  const result = await outcome(f.open());
  assert.equal(result.timedOut, undefined);
  assert.equal(result.error?.code, 'PURCHASE_BROWSER_CEF_READY_TIMEOUT');
  assert.equal((await f.open()).state.crashed, false);
});

test('shutdown before connection settles the pending open and does not leave a late launch', async t => {
  const f = fixture(t, { neverConnect: true });
  const opening = f.open(); await f.spawnReady;
  await f.runtime.shutdown({ timeoutMs: 500 });
  const result = await outcome(opening);
  assert.equal(result.timedOut, undefined);
  assert.equal(result.error?.code, 'PURCHASE_BROWSER_CEF_RUNTIME_CLOSED');
  assert.equal(f.commands.some(command => command.command === 'launch'), false);
});

test('one renderer crash fences only its owner and explicit reopen uses a fresh native session', async t => {
  const f = fixture(t);
  const first = await f.open(), second = await f.open(ownerB);
  f.peers[0].send({ type: 'event', event: 'renderer-crashed', ownerRef: ownerA,
    code: 'PURCHASE_BROWSER_RENDERER_GONE', state: { crashed: true, loading: false } });
  await delay(25);
  const result = await outcome(Promise.resolve().then(() => first.request('state')));
  assert.equal(result.error?.code, 'PURCHASE_BROWSER_SESSION_STALE');
  assert.equal((await second.request('state')).health, 'healthy');
  assert.equal(f.events.filter(entry => entry.event === 'crashed' && entry.details.ownerRef === ownerA).length, 1);
  const reopened = await f.open();
  assert.notEqual(reopened.sessionId, first.sessionId);
  assert.equal(f.spawnCount, 1);
  assert.equal(f.commands.filter(command => command.command === 'close' && command.payload.ownerRef === ownerA).length, 1);
  assert.equal(f.commands.filter(command => command.command === 'launch' && command.payload.profile.ownerRef === ownerA).length, 2);
  assert.equal(f.runtime.get(ownerB), second);
});

test('a native startup fault is reported immediately without hiding behind the readiness timeout', async t => {
  const f = fixture(t, { startupFault: 'PURCHASE_BROWSER_CEF_INITIALIZE_FAILED' });
  const result = await outcome(f.open());
  assert.equal(result.error?.code, 'PURCHASE_BROWSER_CEF_INITIALIZE_FAILED');
});

test('a synchronous main-process action error returns one native response without crashing the pipe reader', async t => {
  const f = fixture(t, { onHostAction() { throw Object.assign(new Error('synthetic'), { code: 'SYNTHETIC_ACTION_FAILED' }); } });
  const browser = await f.open();
  const reply = new Promise(resolve => f.peers[0].child.on('protocol', packet => { if (packet.id === 'action-1') resolve(packet); }));
  f.peers[0].send({ type: 'host-action', id: 'action-1', ownerRef: ownerA });
  const result = await outcome(reply);
  assert.equal(result.value?.ok, false);
  assert.equal(result.value?.error?.code, 'SYNTHETIC_ACTION_FAILED');
  assert.equal((await browser.request('state')).ok, true);
  assert.equal(f.spawnCount, 1);
});

test('late main-process action completion after shutdown neither writes a dead pipe nor rejects unhandled', async t => {
  let entered, finish;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const action = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, { onHostAction() { entered(); return action; } });
  await f.open();
  f.peers[0].send({ type: 'host-action', id: 'late-action', ownerRef: ownerA });
  await enteredPromise;
  await f.runtime.shutdown({ timeoutMs: 500 });
  finish({ ok: true });
  await action; await delay(25);
  assert.equal(f.commands.some(packet => packet.id === 'late-action'), false);
});

test('a clean but unrequested native process exit invalidates every old facade and allows a fresh host', async t => {
  const f = fixture(t);
  const first = await f.open(), second = await f.open(ownerB);
  f.peers[0].child.exitCode = 0; f.peers[0].child.emit('exit', 0);
  assert.equal(f.runtime.get(ownerA), null);
  assert.equal(f.runtime.get(ownerB), null);
  for (const browser of [first, second]) {
    const result = await outcome(Promise.resolve().then(() => browser.request('state')));
    assert.equal(result.error?.code, 'PURCHASE_BROWSER_SESSION_STALE');
  }
  assert.equal((await f.open()).state.crashed, false);
  assert.equal(f.spawnCount, 2);
});

test('a single-owner close error stays visible and uses exact cleanup without stranding other owners on a dead pipe', async t => {
  const f = fixture(t, { onCommand(request, _respond, peer) {
    if (request.command === 'close' && request.payload.ownerRef === ownerA) {
      peer.send({ type: 'response', id: request.id, ok: false, error: { code: 'SYNTHETIC_OWNER_CLOSE_FAILED' } });
      return false;
    }
  } });
  const first = await f.open(), second = await f.open(ownerB);
  const result = await outcome(f.runtime.close(ownerA));
  assert.equal(result.error?.code, 'SYNTHETIC_OWNER_CLOSE_FAILED');
  assert.equal(f.commands.filter(command => command.command === 'force-close' && command.payload.ownerRef === ownerA).length, 1);
  assert.equal(f.runtime.get(ownerB), second);
  assert.equal((await second.request('state')).ok, true);
  assert.equal(f.spawnCount, 1);
  const reopened = await f.open();
  assert.notEqual(reopened.sessionId, first.sessionId);
  assert.equal((await second.request('state')).ok, true);
});

test('closing an owner immediately fences its old command and health facades while native teardown is pending', async t => {
  let completeClose, closeStarted;
  const started = new Promise(resolve => { closeStarted = resolve; });
  const f = fixture(t, { onCommand(request, respond) {
    if (request.command === 'close') { completeClose = respond; closeStarted(); return false; }
  } });
  const browser = await f.open();
  const closing = f.runtime.close(ownerA);
  await started;
  assert.throws(() => browser.request('state'), { code: 'PURCHASE_BROWSER_SESSION_STALE' });
  assert.throws(() => browser.health(), { code: 'PURCHASE_BROWSER_SESSION_STALE' });
  completeClose({ ok: true, closed: true });
  assert.equal((await closing).ok, true);
});

test('a late old shutdown cannot clear the replacement connection opened during teardown', async t => {
  let finishShutdown;
  const f = fixture(t, { onCommand(request, respond) {
    if (request.command === 'shutdown' && !finishShutdown) { finishShutdown = respond; return false; }
  } });
  await f.open();
  const stopped = await f.runtime.shutdown({ timeoutMs: 20 });
  assert.equal(stopped.timedOut, true);
  const oldOpen = f.open();
  oldOpen.catch(() => undefined);
  // Let ensureConnection retire the already-closing candidate before opening B.
  await Promise.resolve(); await Promise.resolve();
  const replacement = await f.open(ownerB);
  assert.equal(f.spawnCount, 2);
  finishShutdown({ ok: true });
  assert.equal((await outcome(oldOpen)).error?.code, 'PURCHASE_BROWSER_CEF_RUNTIME_CLOSED');
  assert.equal((await replacement.request('state')).ok, true);
  await f.open();
  assert.equal(f.spawnCount, 2);
});

test('reopening the same owner waits for its existing native close, without blocking another owner', async t => {
  let finishClose, startedClose;
  const started = new Promise(resolve => { startedClose = resolve; });
  const f = fixture(t, { onCommand(request, respond) {
    if (request.command === 'close' && request.payload.ownerRef === ownerA) {
      finishClose = respond; startedClose(); return false;
    }
  } });
  const old = await f.open();
  const closing = f.runtime.close(ownerA); await started;
  const reopening = f.open();
  const other = await f.open(ownerB);
  assert.equal((await other.request('state')).ok, true);
  const early = await outcome(reopening, 30);
  assert.equal(early.timedOut, true);
  assert.equal(f.commands.filter(command => command.command === 'close' && command.payload.ownerRef === ownerA).length, 1);
  assert.equal(f.commands.filter(command => command.command === 'launch' && command.payload.profile.ownerRef === ownerA).length, 1);
  finishClose({ ok: true, closed: true }); await closing;
  assert.notEqual((await reopening).sessionId, old.sessionId);
});

test('every native open waits for actual maintenance exit and visible opening cancels idle cleanup', async t => {
  let begin, exited, signal;
  const begun = new Promise(resolve => { begin = resolve; });
  const exit = new Promise(resolve => { exited = resolve; });
  const f = fixture(t, { cacheMaintenance: { run: args => { signal = args.signal; begin(); return exit; } } });
  const maintenance = f.runtime.runCacheMaintenance({ force: true }); await begun;
  const opening = f.open(ownerA, { initialBounds: { visible: true } });
  await Promise.resolve();
  assert.equal(signal.aborted, true);
  assert.equal(f.spawnCount, 0, 'native cannot start while the cache worker still owns files');
  exited({ ok: false, cancelled: true, removed: null, exitVerified: true });
  await maintenance; await opening;
  assert.equal(f.spawnCount, 1);
});

test('automatic maintenance never closes an active owner and retires an empty native host before filesystem work', async t => {
  let runs = 0;
  const f = fixture(t, { cacheMaintenance: { run: async () => {
    runs++;
    assert.equal(f.peers[0].child.exitCode, 0);
    return { ok: true, removed: 0, exitVerified: true };
  } } });
  await f.open();
  assert.equal((await f.runtime.runCacheMaintenance({ force: true })).status, 'deferred');
  assert.equal(runs, 0);
  assert.equal(f.peers[0].child.exitCode, null);
  await f.runtime.close(ownerA);
  const result = await f.runtime.runCacheMaintenance({ force: true });
  assert.equal(result.status, 'completed'); assert.equal(result.active, false); assert.equal(runs, 1);
  await f.open(ownerB); assert.equal(f.spawnCount, 2);
});

test('dispose and a subsequent awaited shutdown keep the old cache worker fenced until exit', async t => {
  let begin, exited, signal;
  const begun = new Promise(resolve => { begin = resolve; });
  const exit = new Promise(resolve => { exited = resolve; });
  const f = fixture(t, { cacheMaintenance: { run: args => { signal = args.signal; begin(); return exit; } } });
  const cleanup = f.runtime.runCacheMaintenance({ force: true }); await begun;
  const disposal = f.runtime.dispose();
  const stopped = f.runtime.shutdown();
  assert.equal(signal.aborted, true);
  assert.equal((await outcome(stopped, 20)).timedOut, true);
  exited({ ok: false, cancelled: true, exitVerified: true });
  await cleanup; await disposal; await stopped;
  assert.equal(f.runtime.getCacheMaintenanceStatus().enabled, false);
});

test('dispose rejects an earlier open queued behind maintenance instead of resurrecting a retired runtime', async t => {
  let begin, exited;
  const begun = new Promise(resolve => { begin = resolve; });
  const exit = new Promise(resolve => { exited = resolve; });
  const f = fixture(t, { cacheMaintenance: { run() { begin(); return exit; } } });
  const cleanup = f.runtime.runCacheMaintenance({ force: true }); await begun;
  const opening = f.open(); opening.catch(() => undefined);
  const disposal = f.runtime.dispose();
  exited({ ok: false, cancelled: true, removed: null, exitVerified: true });
  await cleanup; await disposal;
  const result = await outcome(opening);
  assert.equal(result.error?.code, 'PURCHASE_BROWSER_CEF_RUNTIME_CLOSED');
  assert.equal(f.spawnCount, 0, 'no old-runtime host may be created after disposal');
});

test('maintenance cannot begin after a crash while the retired native child has not exited', async t => {
  let runs = 0;
  const f = fixture(t, { holdNativeExit: true, cacheMaintenance: { run: async () => {
    runs++; return { ok: true, removed: 0, exitVerified: true };
  } } });
  await f.open();
  const crashed = new Promise(resolve => f.runtime.onEvent(event => { if (event === 'crashed') resolve(); }));
  f.peers[0].send({ type: 'fault', error: { code: 'SYNTHETIC_CRASH_WITH_LIVE_CHILD' } });
  await crashed;
  assert.equal(f.peers[0].child.exitCode, null);
  const check = await f.runtime.runCacheMaintenance({ force: true });
  assert.equal(runs, 0, 'dropping the current connection must not drop its retirement fence');
  assert.equal(check.status, 'deferred');
  f.peers[0].finishExit();
});

test('ordinary shutdown rejects earlier maintenance-waiting opens but allows a new explicit open afterward', async t => {
  let begin, exited;
  const begun = new Promise(resolve => { begin = resolve; });
  const exit = new Promise(resolve => { exited = resolve; });
  const f = fixture(t, { cacheMaintenance: { run() { begin(); return exit; } } });
  const cleanup = f.runtime.runCacheMaintenance({ force: true }); await begun;
  const oldOpen = f.open(); oldOpen.catch(() => undefined);
  const stopped = f.runtime.shutdown();
  exited({ ok: false, cancelled: true, removed: null, exitVerified: true });
  await cleanup;
  assert.equal((await stopped).exitVerified, true);
  assert.equal((await outcome(oldOpen)).error?.code, 'PURCHASE_BROWSER_CEF_RUNTIME_CLOSED');
  assert.equal(f.spawnCount, 0);
  assert.equal((await f.open(ownerB)).state.crashed, false);
  assert.equal(f.spawnCount, 1);
});

test('dispose is idempotent and never permits a new open on the retired runtime', async t => {
  const f = fixture(t);
  await f.open();
  const disposal = f.runtime.dispose();
  assert.equal(f.runtime.dispose(), disposal);
  assert.equal((await disposal).exitVerified, true);
  assert.equal((await outcome(f.open(ownerB))).error?.code, 'PURCHASE_BROWSER_CEF_RUNTIME_CLOSED');
  assert.equal(f.spawnCount, 1);
});

test('an empty runtime shutdown still provides an explicit native-exit receipt', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.runtime.shutdown(), { ok: true, exitVerified: true, pendingNativeExits: 0 });
  assert.equal(f.spawnCount, 0);
});

test('shutdown deadline and unverified native retirement never authorize a replacement cache worker', async t => {
  let runs = 0;
  const f = fixture(t, { holdNativeExit: true, cacheMaintenance: { run: async () => {
    runs++; return { ok: true, removed: 0, exitVerified: true };
  } } });
  await f.open();
  const deadline = await f.runtime.shutdown({ timeoutMs: 10 });
  assert.equal(deadline.ok, false);
  assert.equal(deadline.timedOut, true);
  assert.equal(deadline.exitVerified, false);
  const closed = await f.runtime.shutdown({ timeoutMs: 6000 });
  assert.equal(closed.ok, false);
  assert.equal(closed.exitVerified, false);
  assert.equal(closed.pendingNativeExits, 1);
  assert.equal((await f.runtime.runCacheMaintenance({ force: true })).status, 'deferred');
  assert.equal(runs, 0);
  f.peers[0].finishExit();
  assert.equal((await f.runtime.shutdown()).exitVerified, true);
});

test('forceTerminateAll retains its native-exit fence after current connection is cleared', async t => {
  let runs = 0;
  const f = fixture(t, { holdNativeExit: true, cacheMaintenance: { run: async () => {
    runs++; return { ok: true, removed: 0, exitVerified: true };
  } } });
  await f.open();
  const retiring = f.runtime.forceTerminateAll();
  const state = await f.runtime.runCacheMaintenance({ force: true });
  assert.equal(state.status, 'deferred');
  assert.equal(runs, 0);
  f.peers[0].finishExit();
  assert.equal((await retiring).exitVerified, true);
});

test('last-session close schedules sixty quiet seconds, rapid reopen keeps its native host, and dispose releases timers', async t => {
  let current = 0, timerId = 0, runs = 0;
  const timers = new Map(), intervals = new Map();
  async function advance(value) {
    let next;
    while ((next = [...timers.entries()].filter(([, item]) => item.at <= value).sort((a, b) => a[1].at - b[1].at)[0])) {
      timers.delete(next[0]); current = next[1].at; await next[1].callback();
    }
    current = value;
  }
  const f = fixture(t, { cacheMaintenance: {
    now: () => current,
    setTimeoutImpl(callback, wait) { const id = ++timerId; timers.set(id, { callback, at: current + wait }); return id; },
    clearTimeoutImpl(id) { timers.delete(id); },
    setIntervalImpl(callback) { const id = ++timerId; intervals.set(id, callback); return id; },
    clearIntervalImpl(id) { intervals.delete(id); },
    run: async () => { runs++; assert.equal(f.peers[0].child.exitCode, 0); return { ok: true, removed: 0, exitVerified: true }; },
  } });
  await f.open(ownerA); await f.open(ownerB);
  await f.runtime.close(ownerA); await advance(60000);
  assert.equal(runs, 0); assert.equal(timers.size, 0, 'one remaining owner still blocks every automatic check');
  await f.runtime.close(ownerB);
  assert.equal(f.runtime.getCacheMaintenanceStatus().scheduledAt, 120000);
  const staleTick = [...timers.values()][0].callback;
  await advance(119999); assert.equal(f.peers[0].child.exitCode, null);
  await f.open(ownerA, { initialBounds: { visible: true } });
  await staleTick(); await advance(180000);
  assert.equal(runs, 0); assert.equal(f.spawnCount, 1); assert.equal(f.peers[0].child.exitCode, null);
  await f.runtime.close(ownerA); await advance(239999); assert.equal(runs, 0);
  await advance(240000); assert.equal(runs, 1);
  assert.equal(f.runtime.getCacheMaintenanceStatus().lastSuccessAt, 240000);
  await f.runtime.dispose(); assert.equal(timers.size, 0); assert.equal(intervals.size, 0);
});
