const text = value => String(value ?? '').trim();

export const PROFIT_SHOP_CALCULATION_CHUNK_SIZE = 40;

function ownerOf(row = {}) {
  return text(row.shopId || row.orderSnapshot?.shopId || row.shopClientId || row.orderSnapshot?.shopClientId) || 'unassigned';
}

export function createProfitShopCalculationLanes(rows = [], preferredShopIds = []) {
  const lanes = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row, index) => {
    const shopId = ownerOf(row);
    if (!lanes.has(shopId)) lanes.set(shopId, []);
    lanes.get(shopId).push({ index, row });
  });
  const order = [...new Set((Array.isArray(preferredShopIds) ? preferredShopIds : []).map(text).filter(Boolean))];
  return [...lanes.entries()].sort(([left], [right]) => {
    const a = order.indexOf(left), b = order.indexOf(right);
    if (a >= 0 || b >= 0) return (a < 0 ? Number.MAX_SAFE_INTEGER : a) - (b < 0 ? Number.MAX_SAFE_INTEGER : b);
    return left.localeCompare(right);
  }).map(([shopId, items]) => ({ shopId, items }));
}

export function selectChangedProfitShopLanes(lanes = [], signatures = new Map(), cache = new Map()) {
  return (Array.isArray(lanes) ? lanes : []).filter((lane) => (
    cache.get(lane.shopId)?.signature !== signatures.get(lane.shopId)
  ));
}

export async function yieldProfitCalculationThread() {
  if (typeof globalThis.scheduler?.yield === 'function') {
    await globalThis.scheduler.yield();
    return;
  }
  await new Promise(resolve => setTimeout(resolve, 0));
}

export async function runProfitShopCalculationLanes(rows = [], calculate, options = {}) {
  if (typeof calculate !== 'function' && typeof options.calculateBatch !== 'function') throw new TypeError('profit calculation callback is required');
  const chunkSize = Math.max(1, Math.floor(Number(options.chunkSize) || PROFIT_SHOP_CALCULATION_CHUNK_SIZE));
  const yieldThread = typeof options.yieldThread === 'function' ? options.yieldThread : yieldProfitCalculationThread;
  const lanes = createProfitShopCalculationLanes(rows, options.shopIds);
  const startedAt = Date.now();
  const clock = typeof options.clock === 'function' ? options.clock : () => globalThis.performance?.now?.() ?? Date.now();
  const timeBudgetMs = Number(options.timeBudgetMs) > 0 ? Number(options.timeBudgetMs) : Infinity;
  let sliceSpentMs = 0, yielding = null;
  const yieldForBudget = shopId => {
    if (!yielding) yielding = Promise.resolve().then(() => yieldThread(shopId))
      .finally(() => { sliceSpentMs = 0; yielding = null; });
    return yielding;
  };
  const settled = await Promise.all(lanes.map(async lane => {
    const laneStartedAt = Date.now();
    const output = [];
    try {
      for (let offset = 0; offset < lane.items.length; offset += chunkSize) {
        if (options.signal?.aborted) return { status: 'cancelled', shopId: lane.shopId, rows: [] };
        const batch = lane.items.slice(offset, offset + chunkSize);
        if (typeof options.calculateBatch === 'function') {
          const calculated = await options.calculateBatch(batch.map(item => item.row), {
            shopId: lane.shopId, indexes: batch.map(item => item.index), signal: options.signal,
          });
          if (options.signal?.aborted) return { status: 'cancelled', shopId: lane.shopId, rows: [] };
          if (!Array.isArray(calculated) || calculated.length !== batch.length
            || calculated.some(row => row && typeof row.then === 'function')) throw new Error('PROFIT_CALCULATION_BATCH_INCOMPLETE');
          output.push(...batch.map((item, index) => ({ index: item.index, row: calculated[index] })));
          options.onBatchComplete?.({ shopId: lane.shopId, rows: output.slice(-batch.length) });
          continue;
        }
        for (const item of batch) {
          if (timeBudgetMs !== Infinity && sliceSpentMs >= timeBudgetMs) await yieldForBudget(lane.shopId);
          if (options.signal?.aborted) return { status: 'cancelled', shopId: lane.shopId, rows: [] };
          const itemStarted = timeBudgetMs === Infinity ? 0 : clock();
          try {
            const row = calculate(item.row, item.index, lane.shopId);
            if (row && typeof row.then === 'function') throw new Error('PROFIT_CALCULATION_ASYNC_REQUIRES_BATCH');
            output.push({ index: item.index, row });
          }
          finally { if (timeBudgetMs !== Infinity) sliceSpentMs += clock() - itemStarted; }
        }
        if (offset + chunkSize < lane.items.length) { await yieldThread(lane.shopId); sliceSpentMs = 0; }
      }
      const result = { status: 'fulfilled', shopId: lane.shopId, rows: output,
        durationMs: Date.now() - laneStartedAt };
      options.onShopComplete?.(result);
      return result;
    } catch (reason) {
      const result = { status: 'rejected', shopId: lane.shopId, rows: [], reason,
        durationMs: Date.now() - laneStartedAt };
      options.onShopError?.(result);
      return result;
    }
  }));
  return { settled, durationMs: Date.now() - startedAt };
}
