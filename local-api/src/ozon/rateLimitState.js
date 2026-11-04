function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function nowIso() {
  return new Date().toISOString();
}

function requireShopId(value) {
  const shopId = String(value || '').trim();
  if (shopId) return shopId;
  throw createRateLimitError(
    'OZON_RATE_LIMIT_SCOPE_REQUIRED',
    'Ozon rate-limit state requires an exact shopId scope.',
  );
}

function stateKey({ shopId = null, endpointKey = 'unknown', bucket = 'default' } = {}) {
  return [requireShopId(shopId), endpointKey, bucket].join('::');
}

function parseIsoMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeRetryAfterMs(error) {
  const value = error?.retryAfterMs ?? error?.retry_after_ms ?? error?.response?.retryAfterMs;
  const numberValue = Number(value);
  if (Number.isFinite(numberValue) && numberValue >= 0) return Math.floor(numberValue);
  return null;
}

function createRateLimitError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'OzonRateLimitError';
  error.code = code;
  Object.assign(error, details);
  return error;
}

function toPublicRateRow(row) {
  return {
    id: row.id,
    shopId: row.shop_id || null,
    endpointKey: row.endpoint_key,
    bucket: row.bucket,
    state: row.state,
    pausedUntil: row.paused_until || null,
    retryAfterMs: row.retry_after_ms || null,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error || null,
    updatedAt: row.updated_at,
  };
}

function toPublicCircuitRow(row) {
  return {
    id: row.id,
    shopId: row.shop_id || null,
    endpointKey: row.endpoint_key,
    state: row.state,
    openedAt: row.opened_at || null,
    halfOpenAt: row.half_open_at || null,
    closedAt: row.closed_at || null,
    failureCount: row.failure_count,
    successCount: row.success_count,
    lastError: row.last_error || null,
    updatedAt: row.updated_at,
  };
}

export function createRateLimitState(db, options = {}) {
  const nextAllowedAt = new Map();
  const failureThreshold = Number(options.failureThreshold) || 3;
  const circuitCooldownMs = Number(options.circuitCooldownMs) || 30_000;
  const maxWaitMs = Number(options.maxWaitMs) || 30_000;

  function memoryShopCount(shopId) {
    const prefix = `${requireShopId(shopId)}::`;
    return [...nextAllowedAt.keys()].filter((key) => key.startsWith(prefix)).length;
  }

  function clearMemoryShop(shopId) {
    const prefix = `${requireShopId(shopId)}::`;
    let removed = 0;
    for (const key of [...nextAllowedAt.keys()]) {
      if (!key.startsWith(prefix)) continue;
      nextAllowedAt.delete(key);
      removed += 1;
    }
    return { ok: true, removed };
  }

  function getBucket(ticket = {}) {
    return ticket.endpoint?.rate?.bucket || ticket.endpoint?.rateLimit?.bucket || ticket.endpointKey || 'default';
  }

  function getRateRow(ticket = {}) {
    const key = stateKey({ ...ticket, bucket: getBucket(ticket) });
    return db.prepare('SELECT * FROM ozon_rate_limit_state WHERE id = ?').get(key) || null;
  }

  function getCircuitRow(ticket = {}) {
    const key = stateKey({ ...ticket, bucket: 'circuit' });
    return db.prepare('SELECT * FROM ozon_circuit_breakers WHERE id = ?').get(key) || null;
  }

  function upsertRate(ticket = {}, patch = {}) {
    const bucket = getBucket(ticket);
    const id = stateKey({ ...ticket, bucket });
    const existing = db.prepare('SELECT * FROM ozon_rate_limit_state WHERE id = ?').get(id);
    const timestamp = nowIso();
    db.prepare(`
      INSERT INTO ozon_rate_limit_state (
        id, shop_id, endpoint_key, bucket, state, paused_until, retry_after_ms,
        consecutive_failures, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        paused_until = excluded.paused_until,
        retry_after_ms = excluded.retry_after_ms,
        consecutive_failures = excluded.consecutive_failures,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      id,
      requireShopId(ticket.shopId),
      ticket.endpointKey || 'unknown',
      bucket,
      patch.state || existing?.state || 'ready',
      patch.pausedUntil === undefined ? existing?.paused_until || null : patch.pausedUntil,
      patch.retryAfterMs === undefined ? existing?.retry_after_ms || null : patch.retryAfterMs,
      patch.consecutiveFailures === undefined ? existing?.consecutive_failures || 0 : patch.consecutiveFailures,
      patch.lastError === undefined ? existing?.last_error || null : patch.lastError,
      timestamp,
    );
    return getRateRow(ticket);
  }

  function upsertCircuit(ticket = {}, patch = {}) {
    const id = stateKey({ ...ticket, bucket: 'circuit' });
    const existing = db.prepare('SELECT * FROM ozon_circuit_breakers WHERE id = ?').get(id);
    const timestamp = nowIso();
    db.prepare(`
      INSERT INTO ozon_circuit_breakers (
        id, shop_id, endpoint_key, state, opened_at, half_open_at, closed_at,
        failure_count, success_count, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        opened_at = excluded.opened_at,
        half_open_at = excluded.half_open_at,
        closed_at = excluded.closed_at,
        failure_count = excluded.failure_count,
        success_count = excluded.success_count,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      id,
      requireShopId(ticket.shopId),
      ticket.endpointKey || 'unknown',
      patch.state || existing?.state || 'closed',
      patch.openedAt === undefined ? existing?.opened_at || null : patch.openedAt,
      patch.halfOpenAt === undefined ? existing?.half_open_at || null : patch.halfOpenAt,
      patch.closedAt === undefined ? existing?.closed_at || null : patch.closedAt,
      patch.failureCount === undefined ? existing?.failure_count || 0 : patch.failureCount,
      patch.successCount === undefined ? existing?.success_count || 0 : patch.successCount,
      patch.lastError === undefined ? existing?.last_error || null : patch.lastError,
      timestamp,
    );
    return getCircuitRow(ticket);
  }

  return {
    beforeRequest(ticket = {}) {
      const circuit = getCircuitRow(ticket);
      if (circuit?.state === 'open') {
        const elapsed = Date.now() - parseIsoMs(circuit.opened_at);
        if (elapsed < circuitCooldownMs) {
          return {
            allowed: false,
            status: 'circuit_open',
            retryAfterMs: circuitCooldownMs - elapsed,
            message: 'Circuit breaker is open for this shop and endpoint.',
          };
        }
        upsertCircuit(ticket, { state: 'half_open', halfOpenAt: nowIso() });
      }

      const rate = getRateRow(ticket);
      const pausedUntilMs = parseIsoMs(rate?.paused_until);
      if (pausedUntilMs > Date.now()) {
        return {
          allowed: false,
          status: 'rate_limited',
          retryAfterMs: pausedUntilMs - Date.now(),
          message: 'Rate limit pause is active for this shop and endpoint.',
        };
      }

      return { allowed: true, status: 'ready' };
    },

    async waitForTurn(ticket = {}) {
      const check = this.beforeRequest(ticket);
      if (!check.allowed) {
        if (check.status === 'rate_limited' && check.retryAfterMs <= maxWaitMs) {
          await sleep(check.retryAfterMs);
          return this.waitForTurn(ticket);
        }
        throw createRateLimitError(
          check.status === 'circuit_open' ? 'OZON_CIRCUIT_OPEN' : 'OZON_RATE_LIMITED',
          check.message,
          { status: check.status, retryAfterMs: check.retryAfterMs, endpointKey: ticket.endpointKey },
        );
      }

      const minIntervalMs = Number(ticket.endpoint?.rate?.minIntervalMs ?? ticket.endpoint?.rateLimit?.minIntervalMs) || 0;
      if (minIntervalMs > 0) {
        const key = stateKey({ ...ticket, bucket: getBucket(ticket) });
        const now = Date.now();
        const next = nextAllowedAt.get(key) || now;
        const waitMs = Math.max(0, next - now);
        nextAllowedAt.set(key, Math.max(now, next) + minIntervalMs);
        if (waitMs > 0) await sleep(waitMs);
      }

      return { allowed: true, status: 'ready' };
    },

    recordSuccess(ticket = {}) {
      upsertRate(ticket, {
        state: 'ready',
        pausedUntil: null,
        retryAfterMs: null,
        consecutiveFailures: 0,
        lastError: null,
      });
      const circuit = getCircuitRow(ticket);
      upsertCircuit(ticket, {
        state: 'closed',
        openedAt: null,
        halfOpenAt: null,
        closedAt: nowIso(),
        failureCount: 0,
        successCount: (circuit?.success_count || 0) + 1,
        lastError: null,
      });
    },

    recordFailure(ticket = {}, error = {}) {
      const currentRate = getRateRow(ticket);
      const consecutiveFailures = (currentRate?.consecutive_failures || 0) + 1;
      const retryAfterMs = normalizeRetryAfterMs(error);
      const nextRetryAfterMs = retryAfterMs ?? currentRate?.retry_after_ms ?? null;
      const status = error?.status === 429 || nextRetryAfterMs != null ? 'rate_limited' : 'ready';
      const pausedUntil = retryAfterMs != null ? new Date(Date.now() + retryAfterMs).toISOString() : currentRate?.paused_until || null;
      const message = error instanceof Error ? error.message : String(error?.message || error || 'unknown error');
      upsertRate(ticket, {
        state: status,
        pausedUntil,
        retryAfterMs: nextRetryAfterMs,
        consecutiveFailures,
        lastError: message,
      });

      const circuit = getCircuitRow(ticket);
      const failureCount = (circuit?.failure_count || 0) + 1;
      if (failureCount >= failureThreshold) {
        upsertCircuit(ticket, {
          state: 'open',
          openedAt: nowIso(),
          failureCount,
          lastError: message,
        });
      } else {
        upsertCircuit(ticket, {
          state: circuit?.state || 'closed',
          failureCount,
          lastError: message,
        });
      }
    },

    getStatus(filters = {}) {
      const rates = db.prepare(`
        SELECT * FROM ozon_rate_limit_state
        WHERE (? IS NULL OR shop_id = ?) AND (? IS NULL OR endpoint_key = ?)
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(
        filters.shopId || null,
        filters.shopId || null,
        filters.endpointKey || null,
        filters.endpointKey || null,
        Math.min(Number(filters.limit) || 100, 500),
      );
      const circuits = db.prepare(`
        SELECT * FROM ozon_circuit_breakers
        WHERE (? IS NULL OR shop_id = ?) AND (? IS NULL OR endpoint_key = ?)
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(
        filters.shopId || null,
        filters.shopId || null,
        filters.endpointKey || null,
        filters.endpointKey || null,
        Math.min(Number(filters.limit) || 100, 500),
      );
      return {
        ok: true,
        rateLimits: rates.map(toPublicRateRow),
        circuitBreakers: circuits.map(toPublicCircuitRow),
      };
    },
    countMemoryShopState: memoryShopCount,
    clearMemoryShopState: clearMemoryShop,
  };
}
