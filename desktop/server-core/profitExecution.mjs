// Server-only build entry. Never included by desktop files/extraResources.
import { createProfitLedgerRow, mergeProfitLedgerRows, migrateProfitLedgerRowToCurrentVersion } from '../../frontend/src/services/profitLedgerService.js';
import { normalizeOzonProfitOrder, rebuildProfitLedgerWithManualOverride } from '../../frontend/src/entities/profit/profitDisplayRules.jsx';
import { rebuildProfitLedgerForFinalZeroActualSales } from '../../frontend/src/entities/profit/profitLedgerMapping.jsx';
import { withReadonlyFeePlanState } from '../../frontend/src/services/feeSettingsRuntime.js';
import { withReadonlyLogisticsPricingSettings } from '../../frontend/src/services/logisticsPricingSettingsRuntime.js';
import { withReadonlyProductMaterialProfiles } from '../../frontend/src/services/productMaterialProfileStore.js';
import { PRIVATE_PROFIT_VERSION, createProfitCoreBatch, decodeProfitWire, encodeProfitWire } from '../../frontend/src/services/profitCoreWire.js';

export function executeProfitBatch(request) {
  if (request?.calculationVersion !== PRIVATE_PROFIT_VERSION || typeof request.callsJson !== 'string') throw new Error('PROFIT_CORE_VERSION_INVALID');
  const calls = decodeProfitWire(JSON.parse(request.callsJson));
  createProfitCoreBatch(calls);
  const results = calls.map(call => {
    const input = call.input;
    if (!input || typeof input !== 'object' || Array.isArray(input) || !input.order || typeof input.order !== 'object') throw new Error('PROFIT_CORE_INPUT_INVALID');
    return withReadonlyFeePlanState(input.feePlanState, () => withReadonlyLogisticsPricingSettings(input.logisticsPricingSettings,
      () => withReadonlyProductMaterialProfiles(input.materialProfiles, () => {
      let value;
      if (call.operation === 'ledger') value = createProfitLedgerRow(input.order, input.context);
      else if (call.operation === 'normalize') value = normalizeOzonProfitOrder(input.order, input.context);
      else if (call.operation === 'rebuild-final') value = rebuildProfitLedgerForFinalZeroActualSales(input.order, input.ledger);
      else if (call.operation === 'manual-override') value = rebuildProfitLedgerWithManualOverride(input.order, input.fieldId, input.amountValue);
      else if (call.operation === 'merge-ledger') value = mergeProfitLedgerRows(input.cachedLedger ? [input.cachedLedger] : [], [input.ledger], { keepUnseenCached: false })[0] ?? null;
      else if (call.operation === 'migrate-ledger') value = migrateProfitLedgerRowToCurrentVersion(input.ledger);
      else throw new Error('PROFIT_CORE_OPERATION_INVALID');
      return { id: call.id, value };
    })));
  });
  return { calculationVersion: PRIVATE_PROFIT_VERSION, resultsJson: JSON.stringify(encodeProfitWire(results)) };
}
