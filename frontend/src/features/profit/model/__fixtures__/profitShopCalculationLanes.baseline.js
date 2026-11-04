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
  if (typeof calculate !== 'function') throw new TypeError('profit calculation callback is required');
  const chunkSize = Math.max(1, Math.floor(Number(options.chunkSize) || PROFIT_SHOP_CALCULATION_CHUNK_SIZE));
  const yieldThread = typeof options.yieldThread === 'function' ? options.yieldThread : yieldProfitCalculationThread;
  const lanes = createProfitShopCalculationLanes(rows, options.shopIds);
  const startedAt = Date.now();
  const settled = await Promise.all(lanes.map(async lane => {
    const laneStartedAt = Date.now();
    const output = [];
    try {
      for (let offset = 0; offset < lane.items.length; offset += chunkSize) {
        if (options.signal?.aborted) return { status: 'cancelled', shopId: lane.shopId, rows: [] };
        const batch = lane.items.slice(offset, offset + chunkSize);
        for (const item of batch) output.push({ index: item.index, row: calculate(item.row, item.index, lane.shopId) });
        if (offset + chunkSize < lane.items.length) await yieldThread(lane.shopId);
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
