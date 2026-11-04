const TASK_PRIORITY = Object.freeze({
  background: 0,
  normal: 1,
  interactive: 2,
});

function text(value) {
  return String(value ?? '').trim();
}

function abortError() {
  const error = new Error('OZON_MARKET_COLLECTOR_TASK_CANCELLED');
  error.name = 'AbortError';
  error.code = 'OZON_MARKET_COLLECTOR_TASK_CANCELLED';
  return error;
}

function normalizedPriority(value) {
  const priority = text(value);
  return Object.hasOwn(TASK_PRIORITY, priority) ? priority : 'normal';
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function guardedCommand(command, item) {
  return async (input = {}) => {
    throwIfAborted(item.controller.signal);
    const response = await command({
      ...input,
      collectorPriority: item.priority,
      collectorTaskId: item.id,
    });
    throwIfAborted(item.controller.signal);
    return response;
  };
}

export function createOzonMarketCollectorCoordinator() {
  let sequence = 0;
  let active = null;
  const pending = [];

  const weight = (item) => TASK_PRIORITY[item.priority] || 0;

  function takeNext() {
    pending.sort((left, right) => weight(right) - weight(left) || left.sequence - right.sequence);
    return pending.shift() || null;
  }

  function pump() {
    if (active) return;
    const next = takeNext();
    if (next) start(next);
  }

  function settle(item, kind, value) {
    if (item.settled) return;
    item.settled = true;
    if (kind === 'resolve') item.resolve(value);
    else item.reject(value);
    if (active === item) {
      active = null;
      pump();
    }
  }

  function start(item) {
    active = item;
    item.startedAt = Date.now();
    const command = guardedCommand(item.command, item);
    Promise.resolve()
      .then(() => item.run({ command, signal: item.controller.signal, taskId: item.id }))
      .then(
        (value) => settle(item, 'resolve', value),
        (error) => settle(item, 'reject', error),
      );
  }

  function preemptActiveFor(item) {
    if (!active || weight(item) <= weight(active)) return false;
    const previous = active;
    previous.controller.abort();
    previous.preemptedBy = item.id;
    active = null;
    start(item);
    return true;
  }

  function run({
    name = 'market-task',
    priority = 'normal',
    profileId = '',
    command,
    task,
  } = {}) {
    if (typeof command !== 'function' || typeof task !== 'function') {
      return Promise.reject(new Error('OZON_MARKET_COLLECTOR_TASK_INVALID'));
    }
    const item = {
      id: `ozon_market_${++sequence}`,
      name: text(name) || 'market-task',
      profileId: text(profileId),
      priority: normalizedPriority(priority),
      sequence,
      command,
      run: task,
      controller: new AbortController(),
      startedAt: 0,
      preemptedBy: '',
      settled: false,
      resolve: null,
      reject: null,
    };
    const promise = new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
    });
    promise.catch(() => undefined);
    if (!active) start(item);
    else if (!preemptActiveFor(item)) pending.push(item);
    return promise;
  }

  function snapshot() {
    const publicTask = (item) => item ? {
      id: item.id,
      name: item.name,
      profileId: item.profileId,
      priority: item.priority,
      startedAt: item.startedAt,
    } : null;
    return {
      active: publicTask(active),
      pending: pending.map(publicTask),
    };
  }

  return Object.freeze({ run, snapshot });
}

const sharedCoordinator = createOzonMarketCollectorCoordinator();

export function runOzonMarketCollectorTask(task, options = {}) {
  return sharedCoordinator.run({
    name: options.name,
    priority: options.priority,
    profileId: options.profileId,
    command: options.command,
    task,
  });
}

export function readOzonMarketCollectorTaskState() {
  return sharedCoordinator.snapshot();
}
