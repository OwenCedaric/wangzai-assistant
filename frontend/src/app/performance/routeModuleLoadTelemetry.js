const ROUTE_MODULE_MEASURE_PREFIX = 'wangzai-route-module:';
const ROUTE_RENDER_MEASURE_PREFIX = 'wangzai-route-render:';
const ROUTE_PHASE_MEASURE_PREFIX = 'wangzai-route-phase:';

function normalizeRouteId(value) {
  return String(value || '').trim();
}

function resolveNow(performanceApi) {
  return typeof performanceApi?.now === 'function' ? performanceApi.now() : Date.now();
}

/** Records only a bounded browser performance entry; it never stores route or business data. */
export function measureRouteModuleLoad(routeIdInput, startedAt, options = {}) {
  const routeId = normalizeRouteId(routeIdInput);
  const performanceApi = options.performanceApi || globalThis.performance;
  if (!routeId || typeof performanceApi?.measure !== 'function') return null;

  const endedAt = Number.isFinite(Number(options.endedAt)) ? Number(options.endedAt) : resolveNow(performanceApi);
  const started = Number.isFinite(Number(startedAt)) ? Number(startedAt) : endedAt;
  const duration = Math.max(0, endedAt - started);
  const name = `${ROUTE_MODULE_MEASURE_PREFIX}${routeId}`;
  try {
    performanceApi.measure(name, { start: started, duration });
    return { name, durationMs: duration };
  } catch {
    return null;
  }
}

export function getRouteModuleMeasureName(routeId) {
  return `${ROUTE_MODULE_MEASURE_PREFIX}${normalizeRouteId(routeId)}`;
}

/** Measures a route's first React render through its first committed DOM tree. */
export function measureRouteRenderCommit(routeIdInput, startedAt, options = {}) {
  const routeId = normalizeRouteId(routeIdInput);
  const performanceApi = options.performanceApi || globalThis.performance;
  if (!routeId || typeof performanceApi?.measure !== 'function') return null;

  const endedAt = Number.isFinite(Number(options.endedAt)) ? Number(options.endedAt) : resolveNow(performanceApi);
  const started = Number.isFinite(Number(startedAt)) ? Number(startedAt) : endedAt;
  const duration = Math.max(0, endedAt - started);
  const name = `${ROUTE_RENDER_MEASURE_PREFIX}${routeId}`;
  try {
    performanceApi.measure(name, { start: started, duration });
    return { name, durationMs: duration };
  } catch {
    return null;
  }
}

export function getRouteRenderMeasureName(routeId) {
  return `${ROUTE_RENDER_MEASURE_PREFIX}${normalizeRouteId(routeId)}`;
}

export function measureRouteRenderPhase(routeIdInput, phaseInput, startedAt, options = {}) {
  const routeId = normalizeRouteId(routeIdInput);
  const phase = normalizeRouteId(phaseInput);
  const performanceApi = options.performanceApi || globalThis.performance;
  if (!routeId || !phase || typeof performanceApi?.measure !== 'function') return null;

  const endedAt = Number.isFinite(Number(options.endedAt)) ? Number(options.endedAt) : resolveNow(performanceApi);
  const started = Number.isFinite(Number(startedAt)) ? Number(startedAt) : endedAt;
  const duration = Math.max(0, endedAt - started);
  const name = `${ROUTE_PHASE_MEASURE_PREFIX}${routeId}:${phase}`;
  try {
    performanceApi.measure(name, { start: started, duration });
    return { name, durationMs: duration };
  } catch {
    return null;
  }
}

export function getRouteRenderPhaseMeasureName(routeId, phase) {
  return `${ROUTE_PHASE_MEASURE_PREFIX}${normalizeRouteId(routeId)}:${normalizeRouteId(phase)}`;
}
