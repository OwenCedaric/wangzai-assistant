import { randomUUID } from 'node:crypto';

function commandError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeTimeout(value, fallback) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? Math.max(1, Math.floor(timeout)) : fallback;
}

/**
 * Serializes native-browser operations and gives high priority lifecycle
 * operations (hide/close) a way to cancel a stale active request.  The queue
 * deliberately does not know anything about Electron or CEF; callers
 * receive an AbortSignal and must fence late results at their session layer.
 */
export function createPurchaseBrowserCommandQueue({
  defaultTimeoutMs = 20_000,
  onStateChanged = () => undefined,
  now = () => Date.now(),
} = {}) {
  let disposed = false;
  let active = null;
  let sequence = 0;
  let lastError = null;
  const pending = [];
  const drainWaiters = new Set();

  function state() {
    return disposed
      ? 'closed'
      : active?.priority === 'high'
        ? 'closing'
        : active || pending.length
          ? 'busy'
          : lastError
            ? 'error'
            : 'idle';
  }

  function snapshot() {
    return Object.freeze({
      state: state(),
      active: active
        ? Object.freeze({
            id: active.id,
            name: active.name,
            priority: active.priority,
            startedAt: active.startedAt,
          })
        : null,
      pending: pending.map((item) => Object.freeze({
        id: item.id,
        name: item.name,
        priority: item.priority,
      })),
      lastError,
    });
  }

  function emit() {
    try {
      onStateChanged(snapshot());
    } catch {
      // State telemetry must never break the command being executed.
    }
    if (!active && pending.length === 0) {
      for (const resolve of drainWaiters) resolve();
      drainWaiters.clear();
    }
  }

  function rejectDisposed() {
    return Promise.reject(commandError('PURCHASE_BROWSER_QUEUE_CLOSED'));
  }

  function removePending(item) {
    const index = pending.indexOf(item);
    if (index >= 0) pending.splice(index, 1);
  }

  function takeNext() {
    pending.sort((left, right) => (
      (right.priorityWeight - left.priorityWeight) || (left.sequence - right.sequence)
    ));
    return pending.shift() || null;
  }

  function finish(item, kind, value, { pumpNext = true } = {}) {
    if (item.finished) return;
    item.finished = true;
    if (item.timer) clearTimeout(item.timer);
    if (active === item) active = null;
    if (!item.callerSettled) {
      item.callerSettled = true;
      if (kind === 'resolve') {
        lastError = null;
        item.resolve(value);
      } else {
        const code = String(value?.code || 'PURCHASE_BROWSER_COMMAND_FAILED');
        if (!['PURCHASE_BROWSER_COMMAND_CANCELLED', 'PURCHASE_BROWSER_COMMAND_SUPERSEDED', 'PURCHASE_BROWSER_QUEUE_CLOSED'].includes(code)) {
          lastError = code;
        }
        item.reject(value);
      }
    }
    emit();
    if (pumpNext) pump();
  }

  function run(item) {
    active = item;
    item.startedAt = now();
    item.controller = new AbortController();
    emit();
    let taskPromise;
    try {
      taskPromise = Promise.resolve(item.task({
        signal: item.controller.signal,
        requestId: item.id,
      }));
    } catch (error) {
      taskPromise = Promise.reject(error);
    }
    // Always attach both handlers immediately.  A timed-out native request
    // may reject later, but it must never become an unhandled rejection.
    taskPromise.then(
      (value) => finish(item, 'resolve', value),
      (error) => finish(item, 'reject', error),
    );
    item.timer = setTimeout(() => {
      item.controller.abort();
      if (item.callerSettled) return;
      item.callerSettled = true;
      lastError = 'PURCHASE_BROWSER_COMMAND_TIMEOUT';
      item.reject(commandError('PURCHASE_BROWSER_COMMAND_TIMEOUT'));
      // Keep the native lane occupied until the underlying task really
      // settles. Starting the next command here lets a timed-out CEF script
      // mutate the same page after its caller has already failed.
      emit();
    }, item.timeoutMs);
  }

  function pump() {
    if (disposed || active) return;
    const next = takeNext();
    if (next) run(next);
    else emit();
  }

  function enqueue(name, task, {
    timeoutMs = defaultTimeoutMs,
    priority = 'normal',
    latestKey = '',
    coalesceKey = '',
    supersedePendingKeys = [],
    preemptActive = false,
    scope = null,
  } = {}) {
    if (disposed) return rejectDisposed();
    if (typeof task !== 'function') return Promise.reject(commandError('PURCHASE_BROWSER_QUEUE_TASK_REQUIRED'));
    const normalizedCoalesceKey = String(coalesceKey || '');
    if (normalizedCoalesceKey) {
      const existing = active?.coalesceKey === normalizedCoalesceKey
        ? active
        : pending.find((item) => item.coalesceKey === normalizedCoalesceKey);
      if (existing && !existing.finished) return existing.promise;
    }
    lastError = null;
    const lifecycleName = new Set(['close', 'force-close', 'hide']).has(String(name || '').trim());
    const normalizedPriority = priority === 'high' || lifecycleName ? 'high' : 'normal';
    const pendingKeysToSupersede = new Set(
      (Array.isArray(supersedePendingKeys) ? supersedePendingKeys : [supersedePendingKeys])
        .map((value) => String(value || ''))
        .filter(Boolean),
    );
    if (pendingKeysToSupersede.size) {
      for (const item of [...pending]) {
        if (!pendingKeysToSupersede.has(item.latestKey)) continue;
        removePending(item);
        item.reject(commandError('PURCHASE_BROWSER_COMMAND_SUPERSEDED'));
      }
    }
    if (latestKey) {
      for (const item of [...pending]) {
        if (item.latestKey !== latestKey) continue;
        removePending(item);
        item.reject(commandError('PURCHASE_BROWSER_COMMAND_SUPERSEDED'));
      }
    }
    let shouldPreemptActive = lifecycleName || preemptActive === true;
    if (!shouldPreemptActive && typeof preemptActive === 'function' && active) {
      try {
        shouldPreemptActive = preemptActive(Object.freeze({
          id: active.id,
          name: active.name,
          priority: active.priority,
          startedAt: active.startedAt,
        })) === true;
      } catch {
        // A priority predicate is advisory. A bad predicate must not cancel
        // the active browser command or prevent the new command from queuing.
        shouldPreemptActive = false;
      }
    }
    if (shouldPreemptActive && active) {
      active.controller?.abort();
      // Do not let finishing the cancelled task start another normal command
      // before the high-priority lifecycle command is inserted below.
      finish(active, 'reject', commandError('PURCHASE_BROWSER_COMMAND_CANCELLED'), { pumpNext: false });
    }
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    pending.push({
      id: `purchase_cmd_${randomUUID()}`,
      name: String(name || 'command'),
      task,
      resolve: resolvePromise,
      reject: rejectPromise,
      promise,
      timeoutMs: normalizeTimeout(timeoutMs, defaultTimeoutMs),
      priority: normalizedPriority,
      priorityWeight: normalizedPriority === 'high' ? 1 : 0,
      latestKey: String(latestKey || ''),
      coalesceKey: normalizedCoalesceKey,
      sequence: sequence++,
      startedAt: 0,
      controller: null,
      timer: null,
      finished: false,
      callerSettled: false,
      scope: scope && typeof scope === 'object' ? Object.freeze({ ...scope }) : null,
    });
    emit();
    pump();
    promise.catch(() => undefined);
    return promise;
  }

  function cancelPending(reason = 'PURCHASE_BROWSER_COMMAND_CANCELLED') {
    const error = commandError(reason);
    for (const item of pending.splice(0)) {
      item.reject(error);
    }
    emit();
  }

  function cancelActive(reason = 'PURCHASE_BROWSER_COMMAND_CANCELLED') {
    if (!active) return false;
    active.controller?.abort();
    finish(active, 'reject', commandError(reason));
    return true;
  }

  function cancelMatching(predicate, reason = 'PURCHASE_BROWSER_COMMAND_CANCELLED') {
    if (typeof predicate !== 'function') throw commandError('PURCHASE_BROWSER_QUEUE_PREDICATE_REQUIRED');
    let canceled = 0;
    for (const item of [...pending]) {
      if (!predicate({ name: item.name, scope: item.scope })) continue;
      removePending(item);
      item.reject(commandError(reason));
      canceled += 1;
    }
    if (active && predicate({ name: active.name, scope: active.scope })) {
      active.controller?.abort();
      finish(active, 'reject', commandError(reason), { pumpNext: false });
      canceled += 1;
    }
    emit();
    pump();
    return { canceled };
  }

  function drain() {
    if (!active && pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => drainWaiters.add(resolve));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelPending('PURCHASE_BROWSER_QUEUE_CLOSED');
    if (active) {
      active.controller?.abort();
      finish(active, 'reject', commandError('PURCHASE_BROWSER_QUEUE_CLOSED'));
    }
    emit();
  }

  return Object.freeze({
    cancelActive,
    cancelMatching,
    cancelPending,
    dispose,
    drain,
    enqueue,
    getSnapshot: snapshot,
  });
}

