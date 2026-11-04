import { getOzonLocalUniqueValues } from '../product/productLocalData.jsx';
import { OZON_AFTER_SALES_SNAPSHOT_RULE_VERSION } from './orderAsyncRules.jsx';
import {
  appendOzonSnapshotScopeKey,
  getOzonSnapshotSourceKey,
  getOzonSnapshotSourceKeyCandidates,
} from './orderShopScope.jsx';

function appendOzonAfterSalesSnapshotRuleVersion(cacheKey = '') {
  return cacheKey ? `${cacheKey}:rule:${OZON_AFTER_SALES_SNAPSHOT_RULE_VERSION}` : '';
}

export function getOzonAfterSalesSnapshotCacheKey(shop, scope = null) {
  return appendOzonAfterSalesSnapshotRuleVersion(
    appendOzonSnapshotScopeKey(`ozon-after-sales:${getOzonSnapshotSourceKey(shop)}`, scope)
  );
}

export function getOzonAfterSalesBackgroundSnapshotCacheKey(shop, scope = null) {
  const displayKey = getOzonAfterSalesSnapshotCacheKey(shop, scope);
  return displayKey ? `${displayKey}:background-latest` : '';
}

export function getOzonAfterSalesBackgroundSnapshotReadKeys(shop, scope = null) {
  return getOzonLocalUniqueValues([
    getOzonAfterSalesBackgroundSnapshotCacheKey(shop, scope),
    getOzonAfterSalesBackgroundSnapshotCacheKey(shop),
  ]);
}

export function getOzonAfterSalesSnapshotCacheKeys(shop, scope = null) {
  return getOzonSnapshotSourceKeyCandidates(shop).map((sourceKey) =>
    appendOzonAfterSalesSnapshotRuleVersion(appendOzonSnapshotScopeKey(`ozon-after-sales:${sourceKey}`, scope))
  );
}

export function getOzonAfterSalesSnapshotReadKeys(shop, scope = null) {
  return getOzonLocalUniqueValues([
    ...getOzonAfterSalesSnapshotCacheKeys(shop, scope),
    ...getOzonAfterSalesSnapshotCacheKeys(shop),
  ]);
}
