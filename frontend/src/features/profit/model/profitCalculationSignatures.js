import { getProfitOrderRecordKey } from '../../../entities/profit/profitOrderRecordRules.jsx';

const text = value => String(value ?? '').trim();
const scopeValues = value => [value?.shopId, value?.shopClientId, value?.clientId, value?.id, value?.shopName, value?.shop, value?.name, value?.alias].map(text).filter(Boolean);

// Preserve all values, including timestamps used for evidence freshness. Unlike a
// reference ID, equal snapshots from another read keep the same calculation key.
export function stableProfitInput(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  let result;
  if (value instanceof Map) result = [...value].map(([key, item]) => [key, stableProfitInput(item, seen)]).sort(([a], [b]) => text(a).localeCompare(text(b)));
  else if (value instanceof Set) result = [...value].map(item => stableProfitInput(item, seen)).sort();
  else if (Array.isArray(value)) result = value.map(item => stableProfitInput(item, seen));
  else if (value instanceof Date) result = value.toISOString();
  else result = Object.fromEntries(Object.keys(value).sort().map(key => [key, stableProfitInput(value[key], seen)]));
  seen.delete(value);
  return result;
}

function scopedRecords(records, ownScopes, knownScopes) {
  const belongs = (value, key) => {
    const owners = [value?.shopId, value?.shopClientId, value?.clientId].map(text).filter(Boolean);
    if (owners.some(owner => ownScopes.has(owner))) return true;
    if (owners.some(owner => knownScopes.has(owner))) return false;
    const prefix = text(key).split(':')[0];
    return !knownScopes.has(prefix) || ownScopes.has(prefix);
  };
  const entries = records instanceof Map ? [...records] : Object.entries(records || {});
  return Object.fromEntries(entries.flatMap(([key, value]) => {
    if (Array.isArray(value)) {
      const items = value.filter(item => belongs(item, key));
      return items.length ? [[key, items]] : [];
    }
    return belongs(value, key) ? [[key, value]] : [];
  }));
}

export function createProfitCalculationSignatures(lanes, {
  readableShops, profitLocalFinanceContexts, profitImageMap, profitFinanceRows, profitLedgerRows,
  profitLocalInputs, ratingPenaltyIndex,
}) {
  const knownScopes = new Set(readableShops.flatMap(scopeValues));
  return new Map(lanes.map(lane => {
    const first = lane.items[0]?.row || {};
    const shop = readableShops.find(item => text(item.id) === lane.shopId || (first.shopClientId && text(item.clientId) === text(first.shopClientId)));
    const ownScopes = new Set([lane.shopId, ...scopeValues(shop), ...lane.items.flatMap(({ row }) => [row.shopId, row.shopClientId, row.shopName, row.shop].map(text).filter(Boolean))]);
    const inputs = {
      rows: lane.items.map(({ row }) => {
        const key = getProfitOrderRecordKey(row);
        return [row, profitImageMap.get(key), profitFinanceRows[key], profitLedgerRows[key]];
      }),
      finance: profitLocalFinanceContexts.byShopId.get(first.shopId) ?? profitLocalFinanceContexts.byClientId.get(first.shopClientId),
      purchase: scopedRecords(profitLocalInputs.purchaseLocalOverrides, ownScopes, knownScopes),
      sources: scopedRecords(profitLocalInputs.productSourceLinks, ownScopes, knownScopes),
      penalties: scopedRecords(ratingPenaltyIndex, ownScopes, knownScopes),
      shop,
    };
    return [lane.shopId, JSON.stringify(stableProfitInput(inputs))];
  }));
}

/** Row-granular input identity. Uses the same complete input fields as the
 * existing shop signature; no fee, status or exchange-rate fields are omitted. */
export async function createProfitCalculationPlan(lanes, {
  readableShops, profitLocalFinanceContexts, profitImageMap, profitFinanceRows, profitLedgerRows,
  profitLocalInputs, ratingPenaltyIndex,
}, { signal, yieldThread = () => new Promise(resolve => setTimeout(resolve, 0)), yieldEvery = null,
  timeBudgetMs = 8, clock = () => globalThis.performance?.now?.() ?? Date.now() } = {}) {
  const knownScopes = new Set(readableShops.flatMap(scopeValues));
  const plans = new Map();
  const seen = new WeakSet();
  let work = 0;
  let sliceStarted = clock();
  const needsYield = () => {
    work += 1;
    return yieldEvery ? work % yieldEvery === 0 : work % 32 === 0 && clock() - sliceStarted >= timeBudgetMs;
  };
  const check = () => {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
  };
  for (const lane of lanes) {
    check();
    const first = lane.items[0]?.row || {};
    const shop = readableShops.find(item => text(item.id) === lane.shopId || (first.shopClientId && text(item.clientId) === text(first.shopClientId)));
    const ownScopes = new Set([lane.shopId, ...scopeValues(shop)]);
    for (const { row } of lane.items) {
      for (const value of [row.shopId, row.shopClientId, row.shopName, row.shop]) {
        if (text(value)) ownScopes.add(text(value));
      }
      if (needsYield()) { await yieldThread(); sliceStarted = clock(); check(); }
    }
    const shared = {
      finance: profitLocalFinanceContexts.byShopId.get(first.shopId) ?? profitLocalFinanceContexts.byClientId.get(first.shopClientId),
      purchase: scopedRecords(profitLocalInputs.purchaseLocalOverrides, ownScopes, knownScopes),
      sources: scopedRecords(profitLocalInputs.productSourceLinks, ownScopes, knownScopes),
      penalties: scopedRecords(ratingPenaltyIndex, ownScopes, knownScopes),
      shop,
    };
    const items = [], occurrences = new Map();
    for (const item of lane.items) {
      const key = getProfitOrderRecordKey(item.row);
      const ordinal = occurrences.get(key) || 0;
      occurrences.set(key, ordinal + 1);
      items.push({ ...item, key, cacheKey: JSON.stringify([key, ordinal]),
        signature: JSON.stringify(stableProfitInput([item.row, profitImageMap.get(key), profitFinanceRows[key], profitLedgerRows[key]], seen)) });
      if (needsYield()) { await yieldThread(); sliceStarted = clock(); check(); }
    }
    // Empty-finance receipts expire as wall time advances. Retain the existing
    // whole-shop refresh for that case instead of reusing potentially expired
    // per-order results; their verification/calculation rules remain unchanged.
    plans.set(lane.shopId, { shopId: lane.shopId, sharedSignature: JSON.stringify(stableProfitInput(shared)),
      rowCacheSafe: !shared.finance?.emptyFinanceReceipts?.size, items });
  }
  check();
  return plans;
}
