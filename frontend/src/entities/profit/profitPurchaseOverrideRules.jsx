import {
  findPurchaseOrderLocalOverride,
  getCanonicalPurchaseOrderOverrideKey,
  readPurchaseOrderLocalOverrides,
  sanitizePurchaseOrderLocalOverrideForMerge,
} from '../../services/purchaseOrderRuntime.js';

export function getProfitPurchaseOrderOverrideKeys(order = {}) {
  const canonicalKey = getCanonicalPurchaseOrderOverrideKey(order);
  return canonicalKey ? [canonicalKey] : [];
}

export function getProfitPurchaseOrderOverride(order = {}, localOverrides = null) {
  const overrides =
    localOverrides && typeof localOverrides === 'object' ? localOverrides : readPurchaseOrderLocalOverrides();
  const override = findPurchaseOrderLocalOverride(overrides, order);
  return override ? sanitizePurchaseOrderLocalOverrideForMerge(override) : {};
}
