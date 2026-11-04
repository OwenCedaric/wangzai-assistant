const RENDER_TREE_MEASURE_PREFIX = 'wangzai-render-tree:';
const RENDER_TREE_TELEMETRY_FLAG = '__wangzaiRendererTreeTelemetryEnabled';

export function isRendererTreeTelemetryEnabled() {
  return globalThis[RENDER_TREE_TELEMETRY_FLAG] === true;
}

export function getRendererTreeMeasureName(metric) {
  return `${RENDER_TREE_MEASURE_PREFIX}${String(metric || '').trim()}`;
}

/** Opt-in only: performance fixtures enable the global flag before route navigation. */
export function markRendererTreeRender(metric, startedAt) {
  if (!isRendererTreeTelemetryEnabled() || typeof performance === 'undefined') return null;
  const start = Number(startedAt);
  const endedAt = performance.now();
  if (!Number.isFinite(start) || endedAt < start || typeof performance.measure !== 'function') return null;
  const name = getRendererTreeMeasureName(metric);
  const durationMs = endedAt - start;
  performance.measure(name, { start, duration: durationMs });
  return { name, durationMs };
}
