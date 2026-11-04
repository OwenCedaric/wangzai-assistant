function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeSequence(value) {
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 0;
}

function uniqueText(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizeText).filter(Boolean))];
}

function createAbortError() {
  const error = new Error("客服消息等待已取消。");
  error.name = "AbortError";
  error.code = "CUSTOMER_SERVICE_REALTIME_ABORTED";
  return error;
}

/**
 * Process-local notification channel. It carries only a shop-scoped cache
 * refresh signal; canonical chat data stays in the customer-service cache.
 */
export function createCustomerServiceRealtimeHub({
  waitTimeoutMs = 25_000,
  maxWaitTimeoutMs = 30_000,
  maxEventsPerShop = 64,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const shops = new Map();
  let closed = false;

  function stateFor(shopId) {
    let state = shops.get(shopId);
    if (!state) {
      state = { sequence: 0, events: [], waiters: new Set() };
      shops.set(shopId, state);
    }
    return state;
  }

  function settleWaiter(waiter, payload, error = null) {
    if (waiter.settled) return;
    waiter.settled = true;
    clearTimeoutFn(waiter.timer);
    waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
    waiter.state.waiters.delete(waiter);
    if (error) waiter.reject(error);
    else waiter.resolve(payload);
  }

  function findNextEvent(state, afterSequence) {
    return state.events.find((event) => event.sequence > afterSequence) || null;
  }

  function publish({ shopId, chatIds = [], messageTypes = [], occurredAt } = {}) {
    const normalizedShopId = normalizeText(shopId);
    if (closed || !normalizedShopId) return null;
    const state = stateFor(normalizedShopId);
    const event = Object.freeze({
      sequence: state.sequence + 1,
      shopId: normalizedShopId,
      chatIds: uniqueText(chatIds),
      messageTypes: uniqueText(messageTypes),
      occurredAt: normalizeText(occurredAt) || new Date(now()).toISOString(),
    });
    state.sequence = event.sequence;
    state.events.push(event);
    if (state.events.length > Math.max(1, maxEventsPerShop)) {
      state.events.splice(0, state.events.length - Math.max(1, maxEventsPerShop));
    }
    for (const waiter of [...state.waiters]) {
      const nextEvent = findNextEvent(state, waiter.afterSequence);
      if (nextEvent) {
        settleWaiter(waiter, {
          ok: true,
          sequence: nextEvent.sequence,
          event: nextEvent,
          timedOut: false,
        });
      }
    }
    return event;
  }

  function getCursor(shopId) {
    const normalizedShopId = normalizeText(shopId);
    if (!normalizedShopId) {
      return {
        ok: false,
        error: {
          code: "CUSTOMER_SERVICE_REALTIME_SHOP_REQUIRED",
          message: "请选择需要接收客服消息的 Ozon 店铺。",
        },
      };
    }
    const state = stateFor(normalizedShopId);
    return { ok: true, sequence: state.sequence, event: null, initialized: true };
  }

  function waitForEvent({ shopId, afterSequence = 0, timeoutMs = waitTimeoutMs, signal } = {}) {
    const normalizedShopId = normalizeText(shopId);
    if (!normalizedShopId) {
      return Promise.reject(
        Object.assign(new Error("请选择需要接收客服消息的 Ozon 店铺。"), {
          code: "CUSTOMER_SERVICE_REALTIME_SHOP_REQUIRED",
        }),
      );
    }
    if (signal?.aborted) return Promise.reject(createAbortError());
    const state = stateFor(normalizedShopId);
    const normalizedAfterSequence = normalizeSequence(afterSequence);
    const nextEvent = findNextEvent(state, normalizedAfterSequence);
    if (nextEvent) {
      return Promise.resolve({
        ok: true,
        sequence: nextEvent.sequence,
        event: nextEvent,
        timedOut: false,
      });
    }
    if (closed) {
      return Promise.resolve({ ok: true, sequence: state.sequence, event: null, closed: true });
    }

    const boundedTimeoutMs = Math.max(
      100,
      Math.min(Number(timeoutMs) || waitTimeoutMs, Math.max(100, maxWaitTimeoutMs)),
    );
    return new Promise((resolve, reject) => {
      const waiter = {
        state,
        afterSequence: normalizedAfterSequence,
        signal,
        resolve,
        reject,
        settled: false,
        timer: null,
        onAbort: null,
      };
      waiter.onAbort = () => settleWaiter(waiter, null, createAbortError());
      waiter.timer = setTimeoutFn(() => {
        settleWaiter(waiter, {
          ok: true,
          sequence: state.sequence,
          event: null,
          timedOut: true,
        });
      }, boundedTimeoutMs);
      waiter.timer?.unref?.();
      signal?.addEventListener?.("abort", waiter.onAbort, { once: true });
      state.waiters.add(waiter);
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const state of shops.values()) {
      for (const waiter of [...state.waiters]) {
        settleWaiter(waiter, {
          ok: true,
          sequence: state.sequence,
          event: null,
          closed: true,
        });
      }
    }
  }

  return { publish, getCursor, waitForEvent, close };
}
