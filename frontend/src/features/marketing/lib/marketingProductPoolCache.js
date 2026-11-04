import { buildMarketingProductPoolCacheResult } from '../../../entities/order/orderShopScope.jsx';

function readDeclaredTotal(value) {
  if (value === null || value === undefined || value === '') return null;
  const total = Number(value);
  return Number.isFinite(total) && total >= 0 ? Math.floor(total) : null;
}

export function buildRetainedMarketingProductPoolResult(products = [], activity = {}) {
  const result = buildMarketingProductPoolCacheResult(products, activity);
  const declaredJoinedTotal = readDeclaredTotal(activity.count ?? activity.joinedCount);
  const declaredAvailableTotal = readDeclaredTotal(activity.available ?? activity.availableCount);
  return {
    ...result,
    joinedTotal: declaredJoinedTotal === null
      ? result.joinedTotal
      : Math.max(result.joinedTotal, declaredJoinedTotal),
    availableTotal: declaredAvailableTotal === null
      ? result.availableTotal
      : Math.max(result.availableTotal, declaredAvailableTotal),
  };
}
