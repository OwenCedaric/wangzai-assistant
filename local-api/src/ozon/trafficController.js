export const DEFAULT_SCHEDULER_PROFILES = Object.freeze({
  foreground: Object.freeze({
    shopConcurrency: 8,
    endpointConcurrency: 8,
    targetRps: 38,
    hardMaxRps: 45,
    queueTimeoutMs: 120_000,
  }),
  background: Object.freeze({
    shopConcurrency: 1,
    endpointConcurrency: 1,
    targetRps: 3,
    hardMaxRps: 5,
    queueTimeoutMs: 300_000,
  }),
  write: Object.freeze({
    shopConcurrency: 1,
    endpointConcurrency: 1,
    writeConcurrency: 1,
    targetRps: 2,
    hardMaxRps: 5,
    queueTimeoutMs: 300_000,
  }),
  readback: Object.freeze({
    shopConcurrency: 1,
    endpointConcurrency: 1,
    targetRps: 5,
    hardMaxRps: 8,
    queueTimeoutMs: 180_000,
  }),
});

const KNOWN_PROFILES = new Set(Object.keys(DEFAULT_SCHEDULER_PROFILES));
const DEFAULT_PROFILE_GLOBAL_CONCURRENCY = Object.freeze({
  foreground: 6,
  background: 2,
  write: 1,
  readback: 2,
});

function nowMs() {
  return Date.now();
}

function normalizeProfile(profile) {
  return KNOWN_PROFILES.has(profile) ? profile : 'foreground';
}

function positiveNumber(value, fallback) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function mergeProfiles(input = {}) {
  const output = {};
  for (const [profile, config] of Object.entries(DEFAULT_SCHEDULER_PROFILES)) {
    output[profile] = Object.freeze({
      ...config,
      globalConcurrency: DEFAULT_PROFILE_GLOBAL_CONCURRENCY[profile],
      ...(input?.[profile] || {}),
    });
  }
  return Object.freeze(output);
}

function intervalFromRps(rps) {
  return Math.max(1, Math.ceil(1000 / positiveNumber(rps, 1)));
}

function getEndpointBucket(ticket = {}) {
  return ticket.endpoint?.rate?.bucket || ticket.endpoint?.rateLimit?.bucket || ticket.endpointKey || 'unknown';
}

function getEndpointMinIntervalMs(ticket = {}) {
  return positiveNumber(ticket.endpoint?.rate?.minIntervalMs ?? ticket.endpoint?.rateLimit?.minIntervalMs, 0);
}

function isOzonCode8(error = {}) {
  const candidates = [
    error.ozonCode,
    error.ozon_code,
    error.code === 8 ? 8 : null,
    error.response?.code,
    error.response?.data?.code,
    error.response?.result?.code,
  ];
  return candidates.some((value) => String(value) === '8');
}

function retryAfterMsFromError(error = {}) {
  const value = error.retryAfterMs ?? error.retry_after_ms ?? error.response?.retryAfterMs;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? Math.floor(numberValue) : null;
}

function isRateLimitedError(error = {}) {
  return error.status === 429 || error.statusCode === 429 || error.status_code === 429 || isOzonCode8(error);
}

export function createSchedulerQueueOptions(options = {}) {
  const profiles = mergeProfiles(options.profiles);
  const maxProfile = (name, fallback) => Math.max(...Object.values(profiles).map((profile) => positiveNumber(profile[name], fallback)));
  return {
    globalConcurrency: positiveNumber(options.globalConcurrency, 8),
    shopConcurrency: positiveNumber(options.shopConcurrency, maxProfile('shopConcurrency', 2)),
    endpointConcurrency: positiveNumber(options.endpointConcurrency, maxProfile('endpointConcurrency', 2)),
    writeConcurrency: positiveNumber(options.writeConcurrency, profiles.write.writeConcurrency || 1),
    queueTimeoutMs: positiveNumber(options.queueTimeoutMs, profiles.background.queueTimeoutMs || 300_000),
    maxQueueSizePerShop: positiveNumber(options.maxQueueSizePerShop ?? options.maxQueueSize, 500),
    profiles,
  };
}

export function createTrafficController(options = {}) {
  const profiles = mergeProfiles(options.profiles);
  const rateLimitState = options.rateLimitState || null;
  const nextAllowedAt = new Map();
  const limitedUntil = new Map();
  const recentLimits = [];
  const timeNow = typeof options.now === 'function' ? options.now : nowMs;

  function profileFor(ticket = {}) {
    if (ticket.priority === 'WRITE') return 'write';
    return normalizeProfile(ticket.profile);
  }

  function profileConfig(ticket = {}) {
    return profiles[profileFor(ticket)] || profiles.foreground;
  }

  function limitScopes(ticket = {}) {
    const profile = profileFor(ticket);
    const config = profileConfig(ticket);
    const endpointBucket = getEndpointBucket(ticket);
    const clientIdHash = String(ticket.clientIdHash || '').trim();
    const shopId = String(ticket.shopId || '').trim();
    if (!shopId || !clientIdHash) {
      const error = new Error('Ozon traffic tickets require exact shopId and clientIdHash scopes.');
      error.code = 'OZON_TRAFFIC_SCOPE_REQUIRED';
      throw error;
    }
    const targetIntervalMs = intervalFromRps(config.targetRps);
    const hardIntervalMs = intervalFromRps(config.hardMaxRps || config.targetRps);
    const endpointIntervalMs = Math.max(getEndpointMinIntervalMs(ticket), hardIntervalMs);

    return [
      { key: `shop:${shopId}:profile:${profile}`, intervalMs: targetIntervalMs, type: 'shop', shopId },
      { key: `shop:${shopId}:client:${clientIdHash}:profile:${profile}`, intervalMs: targetIntervalMs, type: 'client', clientIdHash, shopId },
      { key: `shop:${shopId}:endpoint:${endpointBucket}:profile:${profile}`, intervalMs: endpointIntervalMs, type: 'endpoint', endpointBucket, shopId },
    ];
  }

  function dynamicScopes(ticket = {}) {
    const profile = profileFor(ticket);
    const shopId = String(ticket.shopId || '').trim();
    const clientIdHash = String(ticket.clientIdHash || '').trim();
    if (!shopId || !clientIdHash) {
      const error = new Error('Ozon traffic tickets require exact shopId and clientIdHash scopes.');
      error.code = 'OZON_TRAFFIC_SCOPE_REQUIRED';
      throw error;
    }
    return [
      `shop:${shopId}:profile:${profile}`,
      `shop:${shopId}:client:${clientIdHash}:profile:${profile}`,
      `shop:${shopId}:endpoint:${getEndpointBucket(ticket)}:profile:${profile}`,
    ];
  }

  function recordLimit(scopeKey, retryAfterMs, ticket = {}, error = {}) {
    const waitMs = Math.max(0, Number(retryAfterMs) || 0);
    const until = timeNow() + waitMs;
    limitedUntil.set(scopeKey, until);
    recentLimits.unshift({
      scopeKey,
      retryAfterMs: waitMs,
      until: new Date(until).toISOString(),
      shopId: ticket.shopId || null,
      endpointKey: ticket.endpointKey || null,
      profile: profileFor(ticket),
      errorCode: error.code || null,
      createdAt: new Date(timeNow()).toISOString(),
    });
    recentLimits.splice(50);
  }

  function reserve(ticket = {}) {
    const rateCheck = rateLimitState?.beforeRequest?.(ticket);
    if (rateCheck && rateCheck.allowed === false) {
      return {
        allowed: false,
        status: rateCheck.status || 'rate_limited',
        waitMs: Math.max(1, Math.ceil(rateCheck.retryAfterMs || 1000)),
        retryAfterMs: rateCheck.retryAfterMs || null,
        message: rateCheck.message || 'Rate limit state is blocking this request.',
      };
    }

    const now = timeNow();
    let waitMs = 0;
    let waitScope = null;
    for (const scopeKey of dynamicScopes(ticket)) {
      const until = limitedUntil.get(scopeKey) || 0;
      if (until <= now) {
        limitedUntil.delete(scopeKey);
        continue;
      }
      const scopeWaitMs = until - now;
      if (scopeWaitMs > waitMs) {
        waitMs = scopeWaitMs;
        waitScope = scopeKey;
      }
    }
    if (waitMs > 0) {
      return {
        allowed: false,
        status: 'rate_limited',
        waitMs,
        retryAfterMs: waitMs,
        message: `Traffic scope is cooling down: ${waitScope}`,
      };
    }

    const scopes = limitScopes(ticket);
    for (const scope of scopes) {
      const next = nextAllowedAt.get(scope.key) || now;
      if (next > now) {
        return {
          allowed: false,
          status: 'traffic_wait',
          waitMs: next - now,
          retryAfterMs: next - now,
          message: `Waiting for traffic permit: ${scope.key}`,
        };
      }
    }

    for (const scope of scopes) {
      const next = nextAllowedAt.get(scope.key) || now;
      nextAllowedAt.set(scope.key, Math.max(now, next) + scope.intervalMs);
    }

    return {
      allowed: true,
      status: 'ready',
      profile: profileFor(ticket),
      scopes: scopes.map((scope) => scope.key),
    };
  }

  function recordFailure(ticket = {}, error = {}) {
    if (!isRateLimitedError(error)) return;
    const retryAfterMs = retryAfterMsFromError(error) ?? (isOzonCode8(error) ? 1000 : 2000);
    for (const scopeKey of dynamicScopes(ticket)) {
      recordLimit(scopeKey, retryAfterMs, ticket, error);
    }
  }

  function recordSuccess(ticket = {}) {
    for (const scopeKey of dynamicScopes(ticket)) {
      const until = limitedUntil.get(scopeKey) || 0;
      if (until <= timeNow()) limitedUntil.delete(scopeKey);
    }
  }

  function getStatus() {
    const now = timeNow();
    const rateLimited = [...limitedUntil.entries()]
      .filter(([, until]) => until > now)
      .map(([scopeKey, until]) => ({
        scopeKey,
        retryAfterMs: until - now,
        until: new Date(until).toISOString(),
      }));
    const clientRps = {};
    for (const [scopeKey, next] of nextAllowedAt.entries()) {
      if (!scopeKey.includes(':client:')) continue;
      clientRps[scopeKey] = {
        nextAllowedAt: new Date(next).toISOString(),
        waitMs: Math.max(0, next - now),
      };
    }
    return {
      ok: true,
      isolationMode: 'per-shop',
      profiles,
      perShopRps: Object.fromEntries(Object.entries(profiles).map(([profile, config]) => [profile, {
        targetRps: config.targetRps,
        hardMaxRps: config.hardMaxRps,
      }])),
      clientRps,
      rateLimited,
      recentLimits: recentLimits.slice(0, 20),
    };
  }

  function shopScopeCount(shopId) {
    const prefix = `shop:${shopId}:`;
    return [...new Set([
      ...[...nextAllowedAt.keys()].filter((key) => key.startsWith(prefix)),
      ...[...limitedUntil.keys()].filter((key) => key.startsWith(prefix)),
    ])].length;
  }

  function clearShop(shopId) {
    const prefix = `shop:${shopId}:`;
    let removed = 0;
    for (const map of [nextAllowedAt, limitedUntil]) {
      for (const key of [...map.keys()]) {
        if (!key.startsWith(prefix)) continue;
        map.delete(key);
        removed += 1;
      }
    }
    for (let index = recentLimits.length - 1; index >= 0; index -= 1) {
      if (recentLimits[index]?.shopId !== shopId) continue;
      recentLimits.splice(index, 1);
      removed += 1;
    }
    return { ok: true, removed };
  }

  return {
    profiles,
    reserve,
    acquirePermit: reserve,
    recordFailure,
    recordSuccess,
    getStatus,
    countShopState: shopScopeCount,
    clearShop,
  };
}
