import { readSavedFeePlanState } from './feeSettingsRuntime.js';
import { readSavedLogisticsPricingSettings } from './logisticsPricingSettingsRuntime.js';
import { normalizeLogisticsPricingSettings } from './logisticsPricingSettingsStore.js';
import { getProductMaterialProfileKey, readProductMaterialProfiles } from './productMaterialProfileStore.js';
import { normalizeOzonSalesRowToPurchaseOrder, readPurchaseOrderLocalOverrides, selectPurchaseOrderLocalOverridesForOrder } from './purchaseOrderRuntime.js';
import { selectProfitLedgerPurchaseOverrides } from './profitLedgerService.js';
import { prepareProfitCalculationOrder } from './profitPartialCompensation.js';
import { getProfitPurchaseOrderOverride } from '../entities/profit/profitPurchaseOverrideRules.jsx';
import { getProfitOrderAfterSalesRows, getProfitOrderFinanceLookupGroups, getProfitProductPriceInfo } from '../entities/profit/profitFinanceEvidence.jsx';
import { getProfitOrderFinanceOperations, getProfitOrderPenaltyFinanceOperations, getProfitOrderRatingPenaltyOperations } from '../entities/profit/profitLedgerMapping.jsx';
import { createProfitCoreBatch, decodeProfitWire } from './profitCoreWire.js';

const text = value => String(value ?? '').trim();
const unique = values => [...new Set(values.map(text).filter(Boolean))];
const pick = (source, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(source ?? {}, key)).map(key => [key, source[key]]));

// Observe canonical read-only lookup helpers, never copy an entire shop index.
function trackedMap(source = new Map()) {
  if (!(source instanceof Map)) throw new Error('PROFIT_INPUT_MAP_REQUIRED');
  const selected = new Map();
  const read = key => { if (source.has(key)) selected.set(key, source.get(key)); return source.get(key); };
  return { selected, view: { get: read, has: key => { read(key); return source.has(key); } } };
}

export function createPrivateProfitInput(order, context = {}, extra = {}) {
  if (!order || typeof order !== 'object' || !text(order.shopId)) throw new Error('PROFIT_INPUT_OWNER_REQUIRED');
  if (context.shop && text(context.shop.id) !== text(order.shopId)) throw new Error('PROFIT_INPUT_OWNER_MISMATCH');
  const prepared = prepareProfitCalculationOrder(order, order.profitLedger);
  const overrides = context.purchaseLocalOverrides ?? context.purchaseOverrides ?? readPurchaseOrderLocalOverrides();
  const normalizedPurchase = normalizeOzonSalesRowToPurchaseOrder(prepared);
  const purchase = { ...normalizedPurchase, ...getProfitPurchaseOrderOverride(normalizedPurchase, overrides) };
  const purchases = [prepared, normalizedPurchase, purchase];
  const selectedOverrides = Object.assign({}, ...purchases.flatMap(row => [
    selectPurchaseOrderLocalOverridesForOrder(overrides, row), selectProfitLedgerPurchaseOverrides(row, overrides),
  ]));
  const maps = Object.fromEntries(['financeIndex', 'financeParentFallbackIndex', 'financeLookupCheckedIndex', 'ratingPenaltyIndex', 'afterSalesIndex', 'priceInfoMap']
    .map(key => [key, trackedMap(context[key] ?? new Map())]));
  getProfitOrderFinanceOperations(prepared, maps.financeIndex.view, { financeParentFallbackIndex: maps.financeParentFallbackIndex.view });
  getProfitOrderPenaltyFinanceOperations(prepared, maps.financeIndex.view);
  const ratingRows = new Set(getProfitOrderRatingPenaltyOperations(prepared, maps.ratingPenaltyIndex.view));
  const afterSalesRows = new Set(getProfitOrderAfterSalesRows(prepared, maps.afterSalesIndex.view));
  for (const [name, accepted] of [['ratingPenaltyIndex', ratingRows], ['afterSalesIndex', afterSalesRows]]) {
    for (const [key, rows] of maps[name].selected) if (Array.isArray(rows)) maps[name].selected.set(key, rows.filter(row => accepted.has(row)));
  }
  const groups = getProfitOrderFinanceLookupGroups(prepared);
  [...groups.exactKeys, ...groups.fallbackKeys].forEach(key => maps.financeLookupCheckedIndex.view.get(key));
  (prepared.products ?? []).forEach(product => getProfitProductPriceInfo(product, maps.priceInfoMap.view));
  const safeContext = {
    ...pick(context, ['orderKey', 'updatedAt', 'fetchedAt', 'profitFinanceVersion', 'rubToCnyRate', 'exchangeRate',
      'exchangeRates', 'estimatedExchangeRate', 'actualExchangeRate', 'amounts', 'allowZeroPurchaseCost', 'sourceRecords']),
    ...Object.fromEntries(Object.entries(maps).map(([key, value]) => [key, value.selected])),
    shop: { id: text(order.shopId) }, purchaseLocalOverrides: selectedOverrides,
    ...(context.purchaseOverrides ? { purchaseOverrides: selectedOverrides } : {}),
  };
  const materialSource = readProductMaterialProfiles();
  const materialKeys = unique(purchases.flatMap(row => (row.products ?? []).map(product =>
    getProductMaterialProfileKey(product, safeContext.shop))));
  const logistics = normalizeLogisticsPricingSettings(readSavedLogisticsPricingSettings());
  const shopIds = unique(purchases.flatMap(row => [row.shopId, row.shop_id, row.sourceOrder?.shopId, row.sourceOrder?.shop_id]));
  const accountIds = unique(purchases.flatMap(row => [row.accountId, row.shopClientId, row.clientId,
    row.sourceOrder?.accountId, row.sourceOrder?.shopClientId, row.sourceOrder?.clientId]));
  const input = { ...extra, order, context: safeContext, feePlanState: readSavedFeePlanState(),
    materialProfiles: pick(materialSource, materialKeys),
    logisticsPricingSettings: { ...logistics, shopSelections: pick(logistics.shopSelections, shopIds), accountSelections: pick(logistics.accountSelections, accountIds) },
  };
  // Deep snapshot plus credential rejection before queueing; no live objects or
  // shop API credentials survive into the request. Unknown secret fields fail.
  return decodeProfitWire(JSON.parse(createProfitCoreBatch([{ id: 'snapshot', operation: 'normalize', input }]).callsJson))[0].input;
}
