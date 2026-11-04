import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createIdleCacheMaintenance } from '../runtime/idleCacheMaintenance.js';
import { createBoundedDiagnosticRelay } from '../runtime/boundedDiagnosticRelay.js';
export { pruneCefTransientCache, pruneCefTransientCacheInWorker } from './cefTransientCacheMaintenance.js';

const OWNER_REF_PATTERN = /^[a-f0-9]{40}$/u;
const SAFE_COMMAND = /^[a-z][a-z0-9-]{0,80}$/u;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function requiredText(value, code, maximum = 1200) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maximum || /[\u0000-\u001F\u007F]/u.test(text)) fail(code);
  return text;
}

function safeLog(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s]+/giu, '[url]')
    .replace(/[A-Za-z]:\\[^\r\n]+/gu, '[path]')
    .replace(/[^\x20-\x7E\u4E00-\u9FFF]/gu, ' ')
    .trim()
    .slice(0, 500);
}

async function terminateProcessTree(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const pid = Number(child?.pid);
  if (process.platform === 'win32' && Number.isInteger(pid) && pid > 0) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      const timer = setTimeout(resolve, 5_000);
      const done = () => { clearTimeout(timer); resolve(); };
      killer.once('error', done);
      killer.once('exit', done);
    });
  }
  try { child?.kill?.(); } catch { /* already exited */ }
}

function pipeName() {
  return 'wangzai-cef-' + process.pid + '-' + randomUUID();
}

export function createCefHostArguments({
  ipcPipe,
  rootCachePath,
  extensionsRoot,
  builtInExtensionDirectories = [],
} = {}) {
  const args = [
    '--wangzai-ipc-pipe=' + requiredText(ipcPipe, 'PURCHASE_BROWSER_CEF_PIPE_REQUIRED'),
    '--wangzai-root-cache=' + path.resolve(requiredText(rootCachePath, 'PURCHASE_BROWSER_CEF_ROOT_CACHE_REQUIRED')),
    '--wangzai-extensions-root=' + path.resolve(requiredText(extensionsRoot, 'PURCHASE_BROWSER_EXTENSIONS_ROOT_REQUIRED')),
  ];
  const directories = [...new Set((Array.isArray(builtInExtensionDirectories) ? builtInExtensionDirectories : [])
    .map((value) => path.resolve(requiredText(value, 'PURCHASE_BROWSER_BUILTIN_EXTENSION_REQUIRED'))))];
  for (const directory of directories) args.push('--wangzai-built-in-extension=' + directory);
  return args;
}

class CefHostConnection {
  constructor({
    executable,
    rootCachePath,
    extensionsRoot,
    builtInExtensionDirectories = [],
    appendLog,
    spawnProcess = spawn,
    onEvent = () => undefined,
    startupTimeoutMs = 30_000,
  } = {}) {
    this.executable = path.resolve(requiredText(executable, 'PURCHASE_BROWSER_CEF_HOST_REQUIRED'));
    this.rootCachePath = path.resolve(requiredText(rootCachePath, 'PURCHASE_BROWSER_CEF_ROOT_CACHE_REQUIRED'));
    this.extensionsRoot = path.resolve(requiredText(extensionsRoot, 'PURCHASE_BROWSER_EXTENSIONS_ROOT_REQUIRED'));
    this.builtInExtensionDirectories = [...builtInExtensionDirectories];
    this.appendLog = appendLog;
    this.diagnosticRelay = createBoundedDiagnosticRelay({
      write: line => this.appendLog('desktop-main', line),
    });
    this.spawnProcess = spawnProcess;
    this.onEvent = onEvent;
    this.startupTimeoutMs = Number.isFinite(Number(startupTimeoutMs)) && Number(startupTimeoutMs) > 0
      ? Math.max(10, Number(startupTimeoutMs)) : 30_000;
    this.server = null;
    this.socket = null;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.startPromise = null;
    this.closed = false;
    this.closing = false;
    this.closePromise = null;
    this.crashed = false;
    this.hostReady = null;
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A startup fault is also observed by start(); this prevents Node from
    // reporting an unhandled rejection during process teardown.
    this.readyPromise.catch(() => undefined);
  }

  async start() {
    if (this.closed || this.closing || this.crashed) fail('PURCHASE_BROWSER_CEF_RUNTIME_CLOSED');
    if (this.hostReady) return this;
    if (this.startPromise) return this.startPromise;
    const connected = new Promise((resolve, reject) => {
      const name = pipeName();
      const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\' + name : path.join('/tmp', name);
      this.server = createServer((socket) => this.attachSocket(socket, resolve));
      this.server.once('error', reject);
      this.server.listen(endpoint, () => {
        try {
          if (this.closed || this.closing || this.crashed) fail('PURCHASE_BROWSER_CEF_RUNTIME_CLOSED');
          if (!fs.existsSync(this.executable)) fail('PURCHASE_BROWSER_CEF_HOST_MISSING');
          this.child = this.spawnProcess(this.executable, createCefHostArguments({
            ipcPipe: name,
            rootCachePath: this.rootCachePath,
            extensionsRoot: this.extensionsRoot,
            builtInExtensionDirectories: this.builtInExtensionDirectories,
          }), {
            cwd: path.dirname(this.executable),
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          this.child.stderr?.setEncoding?.('utf8');
          this.child.stderr?.on?.('data', (chunk) => {
            const line = safeLog(chunk);
            if (line) this.diagnosticRelay.append('[cef-host] ' + line + '\n');
          });
          this.child.stderr?.once?.('end', () => { void this.diagnosticRelay.close(); });
          this.child.once('error', (error) => {
            this.crash(error);
            reject(error);
          });
          this.child.once('exit', (code) => {
            if (!this.closed && !this.closing) {
              this.crash(new Error('PURCHASE_BROWSER_CEF_HOST_EXIT_' + code));
            }
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    // Start the deadline before pipe connection. Native early exit and shutdown
    // reject readyPromise even when connected never settles.
    this.startPromise = Promise.race([
      connected.then(() => this.readyPromise),
      this.waitUntilReady(),
    ]).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async waitUntilReady() {
    if (this.hostReady) return this;
    let timer;
    try {
      return await Promise.race([
        this.readyPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(
            new Error('PURCHASE_BROWSER_CEF_READY_TIMEOUT'),
            { code: 'PURCHASE_BROWSER_CEF_READY_TIMEOUT' },
          )), this.startupTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  attachSocket(socket, resolve) {
    if (this.socket || this.closed || this.closing || this.crashed) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.consume(chunk));
    // Keep an error listener for the whole pipe lifetime. A single EPIPE can
    // race already queued response writes; using once() removed the listener
    // and turned the next queued write into an uncaught exception.
    socket.on('error', (error) => this.crash(error));
    socket.once('close', () => {
      if (!this.closed && !this.closing) this.crash(new Error('PURCHASE_BROWSER_CEF_PROTOCOL_CLOSED'));
    });
    resolve(this);
  }

  consume(chunk) {
    if (this.closed || this.crashed) return;
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let payload;
      try { payload = JSON.parse(line); }
      catch {
        this.crash(new Error('PURCHASE_BROWSER_CEF_PROTOCOL_INVALID'));
        return;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        this.crash(new Error('PURCHASE_BROWSER_CEF_PROTOCOL_INVALID'));
        return;
      }
      if (payload.type === 'fault') {
        this.crash(new Error(payload.error?.code || 'PURCHASE_BROWSER_CEF_HOST_FAILED'));
        return;
      }
      if (payload.type === 'ready') {
        this.hostReady = payload;
        this.resolveReady?.(this);
        this.resolveReady = null;
        this.rejectReady = null;
        continue;
      }
      if (payload.type === 'host-action') {
        const reply = (value) => {
          if (this.closed || this.closing || this.crashed || !this.socket?.writable || this.socket.destroyed) return;
          try { this.write(value); } catch (error) { this.crash(error); }
        };
        Promise.resolve().then(() => this.onEvent('host-action', payload))
          .then((data) => reply({
            type: 'host-action-result',
            id: payload.id,
            ok: true,
            data: data ?? null,
          }), (error) => reply({
            type: 'host-action-result',
            id: payload.id,
            ok: false,
            error: { code: String(error?.code || error?.message || 'PURCHASE_BROWSER_CEF_HOST_ACTION_FAILED') },
          }));
        continue;
      }
      if (payload.type === 'event') {
        this.onEvent(payload.event || 'state', payload);
        continue;
      }
      if (payload.type !== 'response') continue;
      const pending = this.pending.get(payload.id);
      if (!pending) continue;
      this.pending.delete(payload.id);
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener?.('abort', pending.abortHandler);
      if (payload.ok === true) pending.resolve(payload.data);
      else {
        const error = new Error(payload.error?.code || 'PURCHASE_BROWSER_CEF_FAILED');
        error.code = payload.error?.code || 'PURCHASE_BROWSER_CEF_FAILED';
        pending.reject(error);
      }
    }
  }

  crash(error) {
    if (this.closed || this.crashed || this.closing) return;
    this.crashed = true;
    const code = String(error?.code || error?.message || 'PURCHASE_BROWSER_CEF_HOST_FAILED')
      .replace(/[^A-Z0-9_]/gu, '')
      .slice(0, 120) || 'PURCHASE_BROWSER_CEF_HOST_FAILED';
    this.appendLog('desktop-main', '[cef-host] failed code=' + code + '\n');
    this.rejectReady?.(Object.assign(new Error(code), { code }));
    this.resolveReady = null;
    this.rejectReady = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener?.('abort', pending.abortHandler);
      const failure = new Error(code);
      failure.code = code;
      pending.reject(failure);
    }
    this.pending.clear();
    this.onEvent('crashed', { code, state: { crashed: true, loading: false } });
    // A crashed host cannot be reused. Tear down its pipe and process now so
    // the runtime can create a clean connection on the next open attempt.
    this.socket?.destroy();
    this.server?.close();
    // Keep the child attached to the same close promise. Dropping it before
    // terminate/exit finishes makes an empty runtime falsely look idle.
    void this.close().catch(() => undefined);
  }

  write(value) {
    if (this.crashed || !this.socket || this.socket.destroyed || !this.socket.writable) {
      fail('PURCHASE_BROWSER_CEF_PROTOCOL_UNAVAILABLE');
    }
    this.socket.write(JSON.stringify(value) + '\n', 'utf8', (error) => {
      if (error) this.crash(error);
    });
  }

  request(command, payload = {}, timeoutMs = 20_000, signal) {
    if (!SAFE_COMMAND.test(String(command || ''))) fail('PURCHASE_BROWSER_COMMAND_INVALID');
    if (signal?.aborted) fail('PURCHASE_BROWSER_COMMAND_CANCELLED');
    const id = 'cef_' + randomUUID();
    const cancellableCrossBorder = command.startsWith('cross-border-') && command !== 'cross-border-cancel';
    const wirePayload = cancellableCrossBorder ? { ...payload, operationId: id } : payload;
    let cancellationSent = false;
    const cancelNative = () => {
      if (!cancellableCrossBorder || cancellationSent || !payload.ownerRef) return;
      cancellationSent = true;
      void this.request('cross-border-cancel', { ownerRef: payload.ownerRef, operationId: id }, 5000).catch(() => undefined);
    };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cancelNative();
        this.pending.delete(id);
        signal?.removeEventListener?.('abort', abortHandler);
        const error = new Error('PURCHASE_BROWSER_COMMAND_TIMEOUT');
        error.code = error.message;
        reject(error);
      }, Math.max(1000, Number(timeoutMs) || 20_000));
      const abortHandler = () => {
        if (!this.pending.has(id)) return;
        const pending = this.pending.get(id);
        if (pending) pending.aborted = true;
        cancelNative();
        // The command queue already reports cancellation to its caller. Keep
        // this transport promise pending until native CEF acknowledges the
        // command, so the next command cannot overlap a still-running script.
      };
      this.pending.set(id, { resolve, reject, timer, abortHandler, signal, aborted: false });
      signal?.addEventListener?.('abort', abortHandler, { once: true });
      try { this.write({ id, command, payload: wirePayload }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        signal?.removeEventListener?.('abort', abortHandler);
        reject(error);
      }
    });
    promise.catch(() => undefined);
    return promise;
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return;
    this.closing = true;
    this.closePromise = (async () => {
      try {
        if (this.socket && !this.socket.destroyed) {
          await this.request('shutdown', {}, 2_500).catch(() => undefined);
        }
      } finally {
        this.closed = true;
        this.rejectReady?.(Object.assign(
          new Error('PURCHASE_BROWSER_CEF_RUNTIME_CLOSED'),
          { code: 'PURCHASE_BROWSER_CEF_RUNTIME_CLOSED' },
        ));
        this.resolveReady = null;
        this.rejectReady = null;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.signal?.removeEventListener?.('abort', pending.abortHandler);
          pending.reject(new Error('PURCHASE_BROWSER_CEF_RUNTIME_CLOSED'));
        }
        this.pending.clear();
        this.socket?.destroy();
        this.server?.close();
        await terminateProcessTree(this.child);
        this.child = null;
      }
    })();
    return this.closePromise;
  }
}

function profilePayload(profile, profileRoot, downloadsDirectory, url, initialBounds, workbench) {
  const ownerRef = requiredText(profile?.ownerRef, 'PURCHASE_BROWSER_OWNER_REF_INVALID', 40);
  if (!OWNER_REF_PATTERN.test(ownerRef)) fail('PURCHASE_BROWSER_OWNER_REF_INVALID');
  const storageRef = requiredText(profile?.storageRef || ownerRef, 'PURCHASE_BROWSER_STORAGE_REF_INVALID', 40);
  if (!OWNER_REF_PATTERN.test(storageRef)) fail('PURCHASE_BROWSER_STORAGE_REF_INVALID');
  const embedded = workbench?.displayMode === 'embedded';
  return {
    profile: { ...profile, storageRef },
    profileDirectory: path.join(path.resolve(profileRoot), storageRef),
    downloadsDirectory: path.resolve(downloadsDirectory),
    url: String(url || 'about:blank'),
    parentHwnd: '0',
    initialBounds: {
      x: Number(initialBounds?.x) || 0,
      y: Number(initialBounds?.y) || 0,
      width: Math.max(embedded ? 320 : 960, Number(initialBounds?.width) || 1280),
      height: Math.max(embedded ? 240 : 620, Number(initialBounds?.height) || 800),
      visible: initialBounds?.visible === true,
    },
    workbench: workbench && typeof workbench === 'object' && !Array.isArray(workbench) ? workbench : null,
  };
}

function nativeWindowHandleDecimal(hostWindow) {
  const value = hostWindow?.getNativeWindowHandle?.();
  if (!Buffer.isBuffer(value) || ![4, 8].includes(value.length)) return '0';
  const handle = value.length === 8
    ? value.readBigUInt64LE(0)
    : BigInt(value.readUInt32LE(0));
  return handle > 0n ? handle.toString(10) : '0';
}

export function createCefBrowserRuntime({
  executable,
  rootCachePath,
  extensionsRoot = path.join(path.dirname(path.resolve(rootCachePath || '.')), 'extensions'),
  builtInExtensionDirectories = [],
  appendLog = () => undefined,
  spawnProcess = spawn,
  onHostAction = async () => null,
  startupTimeoutMs = 30_000,
  cacheMaintenance = null,
} = {}) {
  const sessions = new Map();
  const events = new Set();
  let connection = null;
  let shutdownPromise = null;
  let disposePromise = null;
  let disposed = false;
  let openGeneration = 0;
  const retiringConnections = new Map();

  const childExited = child => !child || child.exitCode != null || child.signalCode != null;
  function exitReceipt() {
    const pendingNativeExits = [...retiringConnections.values()].filter(record => !record.exitVerified).length;
    return { ok: pendingNativeExits === 0, exitVerified: pendingNativeExits === 0, pendingNativeExits,
      ...(pendingNativeExits ? { code: 'PURCHASE_BROWSER_CACHE_NATIVE_EXIT_UNVERIFIED' } : {}) };
  }
  function retireConnection(candidate) {
    if (!candidate) return Promise.resolve({ ok: true, exitVerified: true });
    const existing = retiringConnections.get(candidate);
    if (existing) return existing.promise;
    const child = candidate.child;
    const record = { child, exitVerified: childExited(child), promise: null };
    let observedExit;
    const exited = new Promise(resolve => { observedExit = resolve; });
    const markExited = () => {
      record.exitVerified = true;
      observedExit(true);
      if (retiringConnections.get(candidate) === record) {
        retiringConnections.delete(candidate);
        maintenance.notifyIdle({ reason: 'native-exit-verified' });
      }
    };
    retiringConnections.set(candidate, record);
    if (!record.exitVerified && typeof child?.once === 'function') child.once('exit', markExited);
    if (record.exitVerified) observedExit(true);
    record.promise = (async () => {
      await candidate.close().catch(() => undefined);
      if (childExited(child)) markExited();
      if (!record.exitVerified) {
        let timer;
        try {
          await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(false), 5_000); })]);
        } finally { clearTimeout(timer); }
      }
      if (record.exitVerified) markExited();
      // An unverified child remains registered. A later real exit clears its
      // fence; a timeout is never treated as permission to touch its cache.
      return { ok: record.exitVerified, exitVerified: record.exitVerified,
        ...(!record.exitVerified ? { code: 'PURCHASE_BROWSER_CACHE_NATIVE_EXIT_UNVERIFIED' } : {}) };
    })();
    return record.promise;
  }
  function assertOpenGeneration(generation) {
    if (disposed || generation !== openGeneration) fail('PURCHASE_BROWSER_CEF_RUNTIME_CLOSED');
  }
  const maintenance = createIdleCacheMaintenance({
    run: cacheMaintenance?.run,
    onResult: cacheMaintenance?.onResult,
    checkIntervalMs: cacheMaintenance?.checkIntervalMs,
    minimumIntervalMs: cacheMaintenance?.minimumIntervalMs,
    idleQuietMs: cacheMaintenance?.idleQuietMs,
    retryDelayMs: cacheMaintenance?.retryDelayMs,
    maxRetryDelayMs: cacheMaintenance?.maxRetryDelayMs,
    now: cacheMaintenance?.now,
    setIntervalImpl: cacheMaintenance?.setIntervalImpl,
    clearIntervalImpl: cacheMaintenance?.clearIntervalImpl,
    setTimeoutImpl: cacheMaintenance?.setTimeoutImpl,
    clearTimeoutImpl: cacheMaintenance?.clearTimeoutImpl,
    isIdle: () => !disposed && sessions.size === 0 && !shutdownPromise && retiringConnections.size === 0
      && !connection?.startPromise && !connection?.pending?.size,
    prepare: async () => {
      const idleConnection = connection;
      if (idleConnection) {
        const receipt = await retireConnection(idleConnection);
        if (!receipt.exitVerified) fail('PURCHASE_BROWSER_CACHE_NATIVE_EXIT_UNVERIFIED');
        if (connection === idleConnection) connection = null;
      }
      if (retiringConnections.size) fail('PURCHASE_BROWSER_CACHE_NATIVE_EXIT_UNVERIFIED');
    },
  });
  maintenance.start();

  function emit(event, details) {
    for (const listener of events) {
      try { listener(event, details); } catch { /* one observer cannot crash the pipe reader */ }
    }
  }

  function handleHostEvent(event, details) {
    if (details?.ownerRef) {
      const session = sessions.get(details.ownerRef);
      if (session && details.state && !session.invalidated) session.state = { ...session.state, ...details.state };
      if (session && ['crashed', 'renderer-crashed'].includes(event)) {
        session.invalidated = true;
        session.state = { ...session.state, crashed: true, loading: false };
      }
    }
    if (event === 'renderer-crashed') {
      // A renderer failure belongs to one owner, not the shared native process.
      // Existing UI observes its usual failure event without killing owner B.
      if (details?.ownerRef && sessions.has(details.ownerRef)) emit('crashed', details);
      return null;
    }
    if (event === 'host-action') return onHostAction(details);
    if (event === 'crashed') {
      // One native host owns every CEF session. Once that process disappears,
      // every browser facade is bound to the dead pipe even when the crash
      // event has no ownerRef. Fence and remove them all so the next explicit
      // open creates a clean host/session. The failed command is never replayed
      // here; submission callers keep their own pre-send retry safeguards.
      for (const session of sessions.values()) session.invalidated = true;
      sessions.clear();
      const failedConnection = connection;
      if (failedConnection) {
        connection = null;
        void retireConnection(failedConnection);
      }
    }
    emit(event, details);
    return null;
  }

  async function ensureConnection() {
    if (!connection) {
      const created = new CefHostConnection({
        executable,
        rootCachePath,
        extensionsRoot,
        builtInExtensionDirectories,
        appendLog,
        spawnProcess,
        startupTimeoutMs,
        onEvent: (event, details) => connection === created ? handleHostEvent(event, details) : null,
      });
      connection = created;
    }
    const candidate = connection;
    try {
      await candidate.start();
      return candidate;
    } catch (error) {
      if (connection === candidate) connection = null;
      await retireConnection(candidate);
      throw error;
    }
  }

  function get(ownerRef) {
    return sessions.get(ownerRef)?.browser || null;
  }

  async function openSession({
    profile,
    profileRoot,
    downloadsDirectory,
    hostWindow,
    url = 'about:blank',
    initialBounds = {},
    workbench = null,
    signal,
  } = {}, admittedGeneration = openGeneration) {
    assertOpenGeneration(admittedGeneration);
    const ownerRef = requiredText(profile?.ownerRef, 'PURCHASE_BROWSER_OWNER_REF_INVALID', 40);
    if (!OWNER_REF_PATTERN.test(ownerRef)) fail('PURCHASE_BROWSER_OWNER_REF_INVALID');
    let host = await ensureConnection();
    assertOpenGeneration(admittedGeneration);
    let session = sessions.get(ownerRef);
    if (session?.invalidated) {
      await close(ownerRef);
      assertOpenGeneration(admittedGeneration);
      host = await ensureConnection();
      assertOpenGeneration(admittedGeneration);
      session = sessions.get(ownerRef);
    }
    if (!session) {
      const payload = profilePayload(
        profile,
        profileRoot,
        downloadsDirectory,
        url,
        initialBounds,
        workbench,
      );
      payload.parentHwnd = nativeWindowHandleDecimal(hostWindow);
      const state = await host.request('launch', payload, 60_000, signal);
      assertOpenGeneration(admittedGeneration);
      session = {
        ownerRef,
        sessionId: 'cef_session_' + randomUUID(),
        generation: 1,
        state: { ...state, crashed: false },
        invalidated: false,
      };
      const browser = {
        sessionId: session.sessionId,
        get state() { return session.state; },
        onEvent(listener) {
          const wrapped = (event, details = {}) => {
            if (details?.ownerRef && details.ownerRef !== ownerRef) return;
            if (session.invalidated && event !== 'crashed') return;
            listener(event, details);
          };
          events.add(wrapped);
          return () => events.delete(wrapped);
        },
        request(command, payload = {}, timeoutMs = 20_000, requestSignal) {
          if (session.invalidated && command !== 'close') fail('PURCHASE_BROWSER_SESSION_STALE');
          return host.request(command, { ...payload, ownerRef }, timeoutMs, requestSignal)
            .then((result) => {
              if (result && typeof result === 'object') session.state = { ...session.state, ...result };
              return result;
            });
        },
        health: () => {
          if (session.invalidated) fail('PURCHASE_BROWSER_SESSION_STALE');
          return host.request('health', { ownerRef }, 5_000);
        },
      };
      session.browser = browser;
      sessions.set(ownerRef, session);
    } else if (url && url !== 'about:blank' && url !== session.state?.url) {
      const navigated = await session.browser.request('navigate', { url }, 20_000, signal);
      assertOpenGeneration(admittedGeneration);
      session.state = {
        ...session.state,
        ...navigated,
        url,
      };
    }
    return session.browser;
  }

  function open(input = {}) {
    const admittedGeneration = openGeneration;
    return maintenance.withAccess(() => openSession(input, admittedGeneration), {
      interrupt: input.initialBounds?.visible === true,
    }).catch(error => { assertOpenGeneration(admittedGeneration); throw error; });
  }

  async function close(ownerRef) {
    const session = sessions.get(ownerRef);
    if (!session) return { ok: true, existed: false };
    if (session.closePromise) return session.closePromise;
    session.invalidated = true;
    const currentConnection = connection;
    session.closePromise = (async () => {
    try {
      await currentConnection?.request('close', { ownerRef }, 5_000);
    } catch (error) {
      if (error?.code === 'PURCHASE_BROWSER_CEF_SESSION_NOT_FOUND') {
        return { ok: true, existed: true, alreadyClosed: true };
      }
      try {
        const forced = await currentConnection?.request('force-close', { ownerRef }, 3_000);
        if (forced?.closed !== true) fail('PURCHASE_BROWSER_CEF_CLOSE_NOT_VERIFIED');
      } catch {
        // If even targeted teardown cannot be acknowledged, retire the shared
        // transport and every facade bound to it. Never leave owner B pointing
        // at a pipe that this close operation has silently destroyed.
        if (connection === currentConnection) {
          for (const current of sessions.values()) current.invalidated = true;
          sessions.clear();
          connection = null;
          emit('crashed', { code: 'PURCHASE_BROWSER_CEF_CLOSE_NOT_VERIFIED', state: { crashed: true, loading: false } });
          await retireConnection(currentConnection);
        }
      }
      // Forced cleanup does not prove the original graceful close/storage
      // flush succeeded. Keep that original error actionable to the caller.
      throw error;
    } finally {
      session.invalidated = true;
      if (sessions.get(ownerRef) === session) sessions.delete(ownerRef);
      if (sessions.size === 0) maintenance.notifyIdle({ reason: 'last-session-closed' });
    }
    return { ok: true, existed: true };
    })();
    return session.closePromise;
  }

  function health(ownerRef) {
    const session = sessions.get(ownerRef);
    if (!session) return { ok: false, existed: false, health: 'missing' };
    return session.browser.health();
  }

  function invalidate(ownerRef, code = 'PURCHASE_BROWSER_SESSION_STALE') {
    const session = sessions.get(ownerRef);
    if (!session) return { ok: true, existed: false };
    session.invalidated = true;
    session.generation += 1;
    emit('crashed', { ownerRef, code, state: { crashed: true, loading: false } });
    return { ok: true, existed: true, sessionId: session.sessionId };
  }

  function forceTerminate(ownerRef) {
    const session = sessions.get(ownerRef);
    if (!session) return { ok: true, existed: false };
    sessions.delete(ownerRef);
    session.invalidated = true;
    void connection?.request('force-close', { ownerRef }, 3_000).catch(() => undefined)
      .finally(() => { if (sessions.size === 0) maintenance.notifyIdle({ reason: 'last-session-force-closed' }); });
    return { ok: true, existed: true, sessionId: session.sessionId };
  }

  function forceTerminateAll() {
    const count = sessions.size;
    for (const session of sessions.values()) session.invalidated = true;
    sessions.clear();
    const currentConnection = connection;
    connection = null;
    return retireConnection(currentConnection).then(receipt => {
      maintenance.notifyIdle({ reason: 'all-sessions-retired' });
      return { ...receipt, closed: count };
    });
  }

  function nativeWindowHandle(hostWindow) {
    return nativeWindowHandleDecimal(hostWindow);
  }

  function onEvent(listener) {
    events.add(listener);
    return () => events.delete(listener);
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    openGeneration += 1;
    void maintenance.stop();
    const priorShutdown = shutdownPromise;
    disposePromise = Promise.all([priorShutdown, drainCurrentRuntime()]).then(() => exitReceipt());
    return disposePromise;
  }

  async function drainCurrentRuntime() {
    for (const session of sessions.values()) session.invalidated = true;
    sessions.clear();
    const closingConnection = connection;
    const activeRetirements = [...retiringConnections.values()].map(record => record.promise);
    await Promise.all([retireConnection(closingConnection), ...activeRetirements, maintenance.cancel()]);
    if (connection === closingConnection) connection = null;
    await maintenance.cancel();
    return exitReceipt();
  }

  async function shutdown({ timeoutMs = 3_000 } = {}) {
    if (!shutdownPromise) {
      openGeneration += 1;
      shutdownPromise = drainCurrentRuntime().finally(() => { shutdownPromise = null; });
    }
    let timer;
    try {
      return await Promise.race([
        shutdownPromise,
        new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, timedOut: true, exitVerified: false }), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  return Object.freeze({
    close,
    dispose,
    forceTerminate,
    forceTerminateAll,
    get,
    health,
    invalidate,
    runCacheMaintenance: maintenance.request,
    getCacheMaintenanceStatus: () => ({ ...maintenance.snapshot(), retiredNativeHosts: retiringConnections.size,
      nativeExitVerified: retiringConnections.size === 0 }),
    nativeWindowHandle,
    onEvent,
    open,
    shutdown,
  });
}
