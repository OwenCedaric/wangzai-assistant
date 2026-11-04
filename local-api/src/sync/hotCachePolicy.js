const MINUTE_MS = 60 * 1000;

function isoBefore(now, days) {
  const to = new Date(now);
  const from = new Date(to.getTime() - days * 24 * 60 * MINUTE_MS);
  return { from: from.toISOString(), to: to.toISOString() };
}

function dateKeysBefore(now, days) {
  const end = new Date(now);
  const start = new Date(end.getTime() - (Math.max(1, days) - 1) * 24 * 60 * MINUTE_MS);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function policy(id, domain, cadenceMinutes, payload, startupPayload = payload) {
  return Object.freeze({
    id,
    domain,
    cadenceMs: cadenceMinutes * MINUTE_MS,
    payload,
    startupPayload,
  });
}

/**
 * 已登录店铺的后台预热计划。
 *
 * bootstrap 只在 local-api 启动时入队一次，用较大时间范围补齐本机缓存；
 * steady 之后只拉近期增量。所有条目仍由领域 service -> scheduler 执行，
 * 因此不会绕过限流、去重、锁或 SQLite 合并逻辑。
 */
export const DEFAULT_HOT_CACHE_POLICY = Object.freeze([
  policy(
    'products:all',
    'products',
    5,
    {
      visibility: 'ALL',
      hydrate: true,
      hydrationMode: 'fast',
      hydrationConcurrency: 2,
      maxPages: 1,
    },
    {
      allStatuses: true,
      hydrate: true,
      hydrationMode: 'full',
      hydrationConcurrency: 2,
      pageSize: 1000,
      maxPages: 'all',
    },
  ),
  policy(
    'orders:fbs',
    'orders',
    5,
    { endpointKey: 'orders.fbsList', defaultDays: 7, pageSize: 100, maxPages: 10 },
    { endpointKey: 'orders.fbsList', defaultDays: 90, pageSize: 100, maxPages: 100 },
  ),
  policy(
    'orders:fbo',
    'orders',
    15,
    { endpointKey: 'orders.fboList', defaultDays: 7, pageSize: 100, maxPages: 10 },
    { endpointKey: 'orders.fboList', defaultDays: 90, pageSize: 100, maxPages: 100 },
  ),
  policy(
    'returns:standard',
    'returns',
    15,
    { endpointKey: 'returns.list', defaultDays: 7, pageSize: 100, maxPages: 10 },
    { endpointKey: 'returns.list', defaultDays: 90, pageSize: 100, maxPages: 100 },
  ),
  policy(
    'returns:rfbs',
    'returns',
    30,
    { endpointKey: 'returns.rfbsList', defaultDays: 7, pageSize: 100, maxPages: 10 },
    { endpointKey: 'returns.rfbsList', defaultDays: 90, pageSize: 100, maxPages: 100 },
  ),
  policy(
    'finance:transactions',
    'finance',
    15,
    ({ now }) => ({ ...isoBefore(now, 14), windowDays: 7, pageSize: 1000, maxPages: 10 }),
    ({ now }) => ({ ...isoBefore(now, 90), windowDays: 7, pageSize: 1000, maxPages: 50 }),
  ),
  policy('logistics:warehouses', 'logistics', 60, { endpointKey: 'warehouse.list' }),
  policy('logistics:delivery-methods', 'logistics', 60, { endpointKey: 'deliveryMethod.list' }),
  policy('marketing:activities', 'marketing', 30, { scope: 'activities' }),
  policy(
    'customer-service:chats',
    'customerService',
    5,
    { endpointKey: 'chat.list', pageSize: 100, maxPages: 2 },
    { endpointKey: 'chat.list', pageSize: 100, maxPages: 10 },
  ),
  policy('profit:rating-penalties', 'profit', 60, { endpointKey: 'rating.fbsPostingList' }),
  policy(
    'data-analysis:dashboard',
    'data-analysis',
    5,
    ({ now }) => ({ ...dateKeysBefore(now, 30), analysisType: 'all' }),
  ),
]);

function resolvePayload(value, context) {
  if (typeof value === 'function') return value(context) || {};
  return value && typeof value === 'object' ? value : {};
}

export function buildHotCacheSyncInput(policyEntry, {
  shopId,
  now,
  startup = false,
  recoveryReconcile = null,
} = {}) {
  const payload = resolvePayload(
    startup ? policyEntry.startupPayload : policyEntry.payload,
    { shopId, now, startup, policy: policyEntry },
  );
  const recovery = recoveryReconcile && typeof recoveryReconcile === 'object'
    ? recoveryReconcile
    : null;
  return {
    ...payload,
    shopId,
    priority: payload.priority || (recovery ? 'P2' : 'P3'),
    profile: payload.profile || 'background',
    schedulerProfile: payload.schedulerProfile || payload.profile || 'background',
    requestedBy: recovery ? 'recovery-reconcile' : 'continuous-sync',
    source: recovery ? 'recovery-reconcile' : 'continuous-sync',
    syncMode: recovery ? 'recovery-reconcile' : startup ? 'bootstrap' : 'steady',
    cachePolicyId: policyEntry.id,
    ...(recovery ? {
      recoveryRestoreId: recovery.restoreId,
      recoveryGenerationId: recovery.generationId,
      recoveryOverlapMinutes: recovery.overlapMinutes,
    } : {}),
  };
}

export function listHotCachePolicy(policyEntries = DEFAULT_HOT_CACHE_POLICY) {
  return policyEntries.map((entry) => ({
    id: entry.id,
    domain: entry.domain,
    cadenceMs: entry.cadenceMs,
  }));
}
