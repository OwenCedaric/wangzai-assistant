const ACTUAL_FINANCE_DEPENDENCY_KEYS = ['actualCommissionFeeCny', 'actualLogisticsFeeCny'];

export function areProfitFinanceContextsEqual(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  const sameMap = (a, b) => a instanceof Map && b instanceof Map && a.size === b.size
    && [...a].every(([key, value]) => b.get(key) === value);
  const oldErrors = left.errors ?? [], newErrors = right.errors ?? [];
  // `partial` tracks runner completion, not financial inputs. The page updates
  // its completion ref separately; identical map values need no recalculation.
  return sameMap(left.byShopId, right.byShopId) && sameMap(left.byClientId, right.byClientId)
    && (left.matchedRowCount || 0) === (right.matchedRowCount || 0)
    && oldErrors.length === newErrors.length && oldErrors.every((error, index) => error === newErrors[index]);
}

function hasResolvedLedgerEntry(entry = null) {
  if (!entry || typeof entry !== 'object') return false;
  if (!['ready', 'provisional'].includes(String(entry.status || '').trim())) return false;
  if (entry.value === null || entry.value === undefined || entry.value === '') return false;
  return Number.isFinite(Number(entry.value));
}

export function hasPendingProfitCommissionOrLogistics(ledger = null) {
  const amounts = ledger?.amounts && typeof ledger.amounts === 'object' ? ledger.amounts : {};
  return ACTUAL_FINANCE_DEPENDENCY_KEYS.some((key) => !hasResolvedLedgerEntry(amounts[key]));
}

export function shouldHydrateCachedProfitFinanceOrder(order = {}, { revalidateConfirmed = false } = {}) {
  // The page displays saved results immediately and verifies finance once in
  // the background. A previously "confirmed" flag is not proof of a fresh read.
  if (revalidateConfirmed) return true;
  const ledger = order?.profitLedger;
  if (!ledger) return true;
  if (ledger.financeLookupChecked !== true) return true;
  if (Number(ledger.financeOperationCount) <= 0) return true;
  if (!['confirmed', 'provisional'].includes(String(ledger.actualFinanceStatus || '').trim())) return true;
  return hasPendingProfitCommissionOrLogistics(ledger);
}

// One local read at a time. Keep completed batches between retries and stop
// on page/scope cleanup, so a transient failure is not a permanent cache miss.
export function startProfitFinanceHydration({ read, onValue, onError, initialContexts = null,
  retryDelaysMs = [1000, 3000, 10000, 30000] }) {
  const controller = new AbortController();
  let stopped = false;
  let timer;
  let retryIndex = 0;
  let previousContexts = initialContexts;
  const retry = () => {
    if (stopped) return;
    const delay = retryDelaysMs[Math.min(retryIndex++, retryDelaysMs.length - 1)] ?? 30000;
    timer = globalThis.setTimeout(run, Math.max(1, delay));
  };
  const run = async () => {
    if (stopped) return;
    try {
      const contexts = await read({ signal: controller.signal, previousContexts, onShopContext(context) {
        if (stopped || !context?.shop?.id) return;
        const byShopId = new Map(previousContexts?.byShopId ?? []);
        const byClientId = new Map(previousContexts?.byClientId ?? []);
        byShopId.set(context.shop.id, context);
        const clientId = String(context.clientId || context.shop.clientId || '').trim();
        if (clientId) byClientId.set(clientId, context);
        previousContexts = { byShopId, byClientId, partial: true,
          errors: [...byShopId.values()].flatMap(value => value.errors ?? []),
          matchedRowCount: [...byShopId.values()].reduce((sum, value) => sum + (value.matchedRowCount || 0), 0) };
        onValue(previousContexts);
      } });
      if (stopped) return;
      if (!contexts || !Array.isArray(contexts.errors)) throw new Error('PROFIT_FINANCE_READBACK_INVALID');
      previousContexts = contexts;
      onValue(contexts);
      if (contexts.errors.length) retry();
    } catch (error) {
      if (stopped) return;
      onError?.(error);
      retry();
    }
  };
  void run();
  return () => {
    stopped = true;
    globalThis.clearTimeout(timer);
    controller.abort();
  };
}
