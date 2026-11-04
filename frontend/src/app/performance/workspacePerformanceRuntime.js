const MAX_NAVIGATION_SAMPLES = 100;
const MAX_LONG_TASK_SAMPLES = 100;

function defaultNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function normalizePageId(value) {
  const pageId = String(value || '').trim();
  if (!pageId) throw new Error('WORKSPACE_PERFORMANCE_PAGE_ID_REQUIRED');
  return pageId;
}

function normalizeDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

function appendBounded(rows, value, limit) {
  rows.push(value);
  if (rows.length > limit) rows.splice(0, rows.length - limit);
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1));
  return ordered[index];
}

function publicNavigation(sample) {
  return {
    id: sample.id,
    pageId: sample.pageId,
    isColdStart: Boolean(sample.isColdStart),
    durationMs: sample.durationMs,
    completedAt: sample.completedAt,
  };
}

function publicLongTask(sample) {
  return {
    durationMs: sample.durationMs,
    name: sample.name || 'longtask',
    startedAt: sample.startedAt,
  };
}

/**
 * Renderer-only, bounded performance telemetry. It keeps aggregate navigation and long-task
 * evidence in memory; no business payload, DOM snapshot, localStorage, or remote request is used.
 */
export function createWorkspacePerformanceRuntime({
  now = defaultNow,
  performanceObserverFactory = () => globalThis.PerformanceObserver,
  navigationLimit = MAX_NAVIGATION_SAMPLES,
  longTaskLimit = MAX_LONG_TASK_SAMPLES,
} = {}) {
  const listeners = new Set();
  const pendingByPage = new Map();
  const navigationSamples = [];
  const longTaskSamples = [];
  const completedPageIds = new Set();
  let sequence = 0;

  function snapshot() {
    const navigationDurations = navigationSamples.map((sample) => sample.durationMs);
    const coldNavigationDurations = navigationSamples
      .filter((sample) => sample.isColdStart)
      .map((sample) => sample.durationMs);
    const warmNavigationDurations = navigationSamples
      .filter((sample) => !sample.isColdStart)
      .map((sample) => sample.durationMs);
    const longTaskDurations = longTaskSamples.map((sample) => sample.durationMs);
    const lastNavigation = navigationSamples.at(-1) || null;
    return {
      navigation: {
        count: navigationSamples.length,
        p95Ms: percentile(navigationDurations, 0.95),
        coldCount: coldNavigationDurations.length,
        coldP95Ms: percentile(coldNavigationDurations, 0.95),
        warmCount: warmNavigationDurations.length,
        warmP95Ms: percentile(warmNavigationDurations, 0.95),
        maxMs: navigationDurations.length ? Math.max(...navigationDurations) : 0,
        last: lastNavigation ? publicNavigation(lastNavigation) : null,
        samples: navigationSamples.slice(-20).map(publicNavigation),
      },
      longTasks: {
        count: longTaskSamples.length,
        over50ms: longTaskDurations.filter((duration) => duration > 50).length,
        over100ms: longTaskDurations.filter((duration) => duration > 100).length,
        maxMs: longTaskDurations.length ? Math.max(...longTaskDurations) : 0,
        samples: longTaskSamples.slice(-20).map(publicLongTask),
      },
      pendingPages: [...pendingByPage.keys()],
    };
  }

  function emit() {
    if (listeners.size === 0) return;
    const next = snapshot();
    listeners.forEach((listener) => listener(next));
  }

  function beginNavigation(pageIdInput) {
    const pageId = normalizePageId(pageIdInput);
    const pending = {
      id: `workspace-nav-${++sequence}`,
      pageId,
      isColdStart: !completedPageIds.has(pageId),
      startedAt: now(),
    };
    pendingByPage.set(pageId, pending);
    emit();
    return pending.id;
  }

  function markPageReady(pageIdInput) {
    const pageId = normalizePageId(pageIdInput);
    const pending = pendingByPage.get(pageId);
    if (!pending) return null;
    pendingByPage.delete(pageId);
    completedPageIds.add(pageId);
    const sample = {
      ...pending,
      durationMs: normalizeDuration(now() - pending.startedAt),
      completedAt: now(),
    };
    appendBounded(navigationSamples, sample, navigationLimit);
    emit();
    return publicNavigation(sample);
  }

  function recordLongTask(entry = {}) {
    const sample = {
      durationMs: normalizeDuration(entry.duration),
      name: String(entry.name || 'longtask'),
      startedAt: Number.isFinite(Number(entry.startTime)) ? Number(entry.startTime) : now(),
    };
    if (sample.durationMs <= 0) return null;
    appendBounded(longTaskSamples, sample, longTaskLimit);
    emit();
    return publicLongTask(sample);
  }

  function startLongTaskObserver() {
    const PerformanceObserverCtor = performanceObserverFactory?.();
    if (typeof PerformanceObserverCtor !== 'function') return () => {};
    let observer;
    try {
      observer = new PerformanceObserverCtor((entries) => {
        const rows = typeof entries?.getEntries === 'function' ? entries.getEntries() : [];
        rows.forEach(recordLongTask);
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      return () => {};
    }
    return () => observer?.disconnect?.();
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new Error('WORKSPACE_PERFORMANCE_LISTENER_REQUIRED');
    listeners.add(listener);
    listener(snapshot());
    return () => listeners.delete(listener);
  }

  function reset() {
    pendingByPage.clear();
    navigationSamples.splice(0, navigationSamples.length);
    longTaskSamples.splice(0, longTaskSamples.length);
    completedPageIds.clear();
    sequence = 0;
    emit();
  }

  return { beginNavigation, markPageReady, recordLongTask, startLongTaskObserver, subscribe, snapshot, reset };
}

export const workspacePerformanceRuntime = createWorkspacePerformanceRuntime();

export function getWorkspacePerformanceSnapshot() {
  return workspacePerformanceRuntime.snapshot();
}

export function subscribeWorkspacePerformance(listener) {
  return workspacePerformanceRuntime.subscribe(listener);
}
