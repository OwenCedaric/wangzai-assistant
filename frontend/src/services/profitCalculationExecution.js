import { normalizeOzonProfitOrder, rebuildProfitLedgerWithManualOverride } from '../entities/profit/profitDisplayRules.jsx';
import { rebuildProfitLedgerForFinalZeroActualSales } from '../entities/profit/profitLedgerMapping.jsx';
import { createProfitLedgerRow, mergeProfitLedgerRows } from './profitLedgerService.js';
import { createPrivateProfitInput } from './privateProfitInputSnapshot.js';
import { executePrivateProfitBatches } from './privateProfitBatchClient.js';
import { getProfitOrderRecordKey } from '../entities/profit/profitOrderRecordRules.jsx';

// Build-time pilot choice, deliberately off in the existing distribution. This
// only selects execution; it is not proof that private code has been stripped.
import { usesPrivateProfitExecution } from './privateProfitMode.js';
export { usesPrivateProfitExecution } from './privateProfitMode.js';

export function runLocalProfitCalculation(iterator) {
  if (usesPrivateProfitExecution) throw new Error('PROFIT_LOCAL_EXECUTION_DISABLED');
  let state = iterator.next();
  for (let step = 0; !state.done; step++) {
    if (step >= 8) throw new Error('PROFIT_CALCULATION_STEP_LIMIT');
    const { operation, input } = state.value;
    let result;
    if (operation === 'normalize') result = normalizeOzonProfitOrder(input.order, input.context);
    else if (operation === 'rebuild-final') result = rebuildProfitLedgerForFinalZeroActualSales(input.order, input.ledger);
    else if (operation === 'ledger') result = createProfitLedgerRow(input.order, input.context);
    else if (operation === 'manual-override') result = rebuildProfitLedgerWithManualOverride(input.order, input.fieldId, input.amountValue);
    else if (operation === 'merge-ledger') result = mergeProfitLedgerRows(input.cachedLedger ? [input.cachedLedger] : [], [input.ledger], { keepUnseenCached: false })[0] ?? null;
    else throw new Error('PROFIT_CALCULATION_OPERATION_INVALID');
    state = iterator.next(result);
  }
  return state.value;
}

export async function runRemoteProfitCalculations(iterators, options = {}) {
  if (!Array.isArray(iterators) || iterators.length > 64) throw new Error('PROFIT_CALCULATION_BATCH_SIZE_INVALID');
  const execute = options.execute ?? executePrivateProfitBatches;
  const cancelled = () => { if (options.signal?.aborted) throw Object.assign(new Error('PROFIT_CALCULATION_CANCELLED'), { name: 'AbortError' }); };
  cancelled();
  let states = iterators.map(iterator => iterator.next());
  const settings = new Map();
  try {
    for (let step = 0; states.some(state => !state.done); step++) {
      cancelled();
      if (step >= 8) throw new Error('PROFIT_CALCULATION_STEP_LIMIT');
      const pending = states.flatMap((state, index) => state.done ? [] : [{ index, request: state.value }]);
      const calls = pending.map(({ index, request }) => {
        const input = createPrivateProfitInput(request.input.order, request.input.context, request.input);
        if (!settings.has(index)) settings.set(index, { feePlanState: input.feePlanState,
          logisticsPricingSettings: input.logisticsPricingSettings, materialProfiles: input.materialProfiles });
        return { id: `row-${index}-step-${step}`, operation: request.operation, input: { ...input, ...settings.get(index) } };
      });
      const values = await execute(calls, { signal: options.signal });
      cancelled();
      if (!Array.isArray(values) || values.length !== calls.length) throw new Error('PROFIT_CALCULATION_BATCH_INCOMPLETE');
      values.forEach((value, index) => {
        if (calls[index].operation === 'normalize'
          && (!value || value.shopId !== calls[index].input.order.shopId
            || getProfitOrderRecordKey(value) !== getProfitOrderRecordKey(calls[index].input.order))) throw new Error('PROFIT_CALCULATION_OWNER_MISMATCH');
        if (calls[index].operation !== 'normalize' && value != null
          && (value.schemaVersion !== 1 || value.shopId !== calls[index].input.order.shopId
            || !value.orderSnapshot || getProfitOrderRecordKey(value.orderSnapshot) !== getProfitOrderRecordKey(calls[index].input.order))) throw new Error('PROFIT_CALCULATION_OWNER_MISMATCH');
      });
      const next = [...states];
      pending.forEach(({ index }, i) => { next[index] = iterators[index].next(values[i]); });
      states = next;
    }
    return states.map(state => state.value);
  } finally { iterators.forEach(iterator => iterator.return?.()); }
}

export function rebuildProfitLedgerForExecution(order, fieldId, amountValue, options = {}) {
  if (!usesPrivateProfitExecution) return rebuildProfitLedgerWithManualOverride(order, fieldId, amountValue);
  return runRemoteProfitCalculations([(function* () {
    return yield { operation: 'manual-override', input: { order, fieldId, amountValue } };
  })()], options).then(rows => rows[0]);
}

export async function normalizeProfitOrdersForExecution(items, options = {}) {
  if (!usesPrivateProfitExecution) return items.map(({ order, context }) => normalizeOzonProfitOrder(order, context));
  const output = [];
  for (let offset = 0; offset < items.length; offset += 40) {
    const values = await runRemoteProfitCalculations(items.slice(offset, offset + 40).map(({ order, context }) => (function* () {
      return yield { operation: 'normalize', input: { order, context } };
    })()), options);
    output.push(...values);
  }
  return output;
}
