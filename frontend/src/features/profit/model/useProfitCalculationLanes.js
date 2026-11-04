import React from 'react';
import { getProfitOrderRecordKey } from '../../../entities/profit/profitOrderRecordRules.jsx';
import { createProfitShopCalculationLanes, runProfitShopCalculationLanes, yieldProfitCalculationThread } from '../../../services/profitShopCalculationLanes.js';
import { safeInfo, safeWarn } from '../../../services/safeLog.js';
import { createProfitCalculationPlan } from './profitCalculationSignatures.js';

export function useProfitCalculationLanes({ isActive, baseProfitRows, calculateProfitRow, calculateProfitBatch, ...inputs }) {
  const { readableShops, profitLocalFinanceContexts, profitImageMap, profitFinanceRows, profitLedgerRows, profitLocalInputs, ratingPenaltyIndex } = inputs;
  const [rows, setRows] = React.useState([]);
  const [errors, setErrors] = React.useState([]);
  const [retryRevision, setRetryRevision] = React.useState(0);
  const cacheRef = React.useRef(new Map());
  const retry = React.useCallback(() => {
    for (const error of errors) {
      const cached = cacheRef.current.get(error.shopId);
      if (cached) cached.sharedSignature = null;
    }
    setRetryRevision(current => current + 1);
  }, [errors]);

  React.useEffect(() => {
    if (!isActive) return undefined;
    if (!baseProfitRows.length) {
      cacheRef.current.clear(); setRows([]); setErrors([]);
      return undefined;
    }
    const controller = new AbortController();
    const shopIds = readableShops.map(shop => String(shop?.id || '').trim()).filter(Boolean);
    const lanes = createProfitShopCalculationLanes(baseProfitRows, shopIds);
    for (const shopId of cacheRef.current.keys()) if (!lanes.some(lane => lane.shopId === shopId)) cacheRef.current.delete(shopId);
    const publishCompletedLanes = () => {
      if (controller.signal.aborted) return;
      const calculated = new Map();
      for (const cached of cacheRef.current.values()) for (const row of cached.rows) calculated.set(getProfitOrderRecordKey(row), row);
      setRows(baseProfitRows.map(order => calculated.get(getProfitOrderRecordKey(order))).filter(Boolean));
    };
    // Keep the existing display and update membership immediately during refresh.
    publishCompletedLanes();
    let publishPending = false;
    const schedulePublish = () => {
      if (publishPending) return;
      publishPending = true;
      queueMicrotask(() => { publishPending = false; publishCompletedLanes(); });
    };
    createProfitCalculationPlan(lanes, {
      readableShops, profitLocalFinanceContexts, profitImageMap, profitFinanceRows, profitLedgerRows, profitLocalInputs, ratingPenaltyIndex,
    }, { signal: controller.signal, yieldThread: yieldProfitCalculationThread }).then(plans => {
      if (controller.signal.aborted) return;
      const pending = new Map(), workRows = [], workItems = [];
      for (const plan of plans.values()) {
        const previous = cacheRef.current.get(plan.shopId);
        const sharedUnchanged = plan.rowCacheSafe && previous?.sharedSignature === plan.sharedSignature;
        const entries = new Map(), changed = [];
        for (const item of plan.items) {
          const saved = sharedUnchanged ? previous?.entries.get(item.cacheKey) : null;
          if (saved?.signature === item.signature) entries.set(item.cacheKey, saved);
          else changed.push(item);
        }
        const commit = () => {
          cacheRef.current.set(plan.shopId, { sharedSignature: plan.sharedSignature, entries,
            rows: plan.items.map(item => entries.get(item.cacheKey)?.row).filter(Boolean) });
        };
        if (!changed.length) { commit(); continue; }
        pending.set(plan.shopId, { plan, entries, commit });
        for (const item of changed) {
          workRows.push(item.row);
          workItems.push(item);
        }
      }
      schedulePublish();
      if (!workRows.length) return;
      return runProfitShopCalculationLanes(workRows, (row, index, shopId) => {
        // The scheduler preserves the original work-array index even when it
        // groups shops. No extra map/array allocation is needed per order.
        const item = workItems[index];
        const calculated = calculateProfitRow(row, index, shopId);
        pending.get(shopId).entries.set(item.cacheKey, { signature: item.signature, row: calculated });
        return calculated;
      }, {
        signal: controller.signal, shopIds, timeBudgetMs: 8,
        ...(calculateProfitBatch ? {
          calculateBatch: async (batch, metadata) => {
            const calculated = await calculateProfitBatch(batch, metadata);
            if (controller.signal.aborted) return [];
            if (!Array.isArray(calculated) || calculated.length !== batch.length) throw new Error('PROFIT_CALCULATION_BATCH_INCOMPLETE');
            for (const [offset, row] of calculated.entries()) {
              if (row && getProfitOrderRecordKey(row) !== getProfitOrderRecordKey(batch[offset])) throw new Error('PROFIT_CALCULATION_BATCH_IDENTITY_MISMATCH');
            }
            calculated.forEach((row, offset) => {
              const item = workItems[metadata.indexes[offset]];
              pending.get(metadata.shopId).entries.set(item.cacheKey, { signature: item.signature, row });
            });
            return calculated;
          },
        } : {}),
        onShopComplete(lane) {
          if (controller.signal.aborted) return;
          pending.get(lane.shopId).commit();
          setErrors(current => current.filter(error => error.shopId !== lane.shopId));
          schedulePublish();
          safeInfo(`[profit-calculation-lane-ready] ${JSON.stringify({ shopId: lane.shopId, rows: pending.get(lane.shopId).plan.items.length, recalculatedRows: lane.rows.length, durationMs: lane.durationMs })}`);
        },
        onShopError(lane) {
          if (controller.signal.aborted) return;
          setErrors(current => [...current.filter(error => error.shopId !== lane.shopId), { shopId: lane.shopId, stale: true }]);
          safeWarn('利润独立计算通道失败', { shopId: lane.shopId, error: lane.reason });
        },
      });
    }).catch(error => {
      if (controller.signal.aborted) return;
      setErrors(shopIds.map(shopId => ({ shopId, stale: true })));
      safeWarn('利润独立计算调度失败', error);
    });
    return () => controller.abort();
  }, [baseProfitRows, calculateProfitRow, calculateProfitBatch, isActive, profitFinanceRows, profitImageMap, profitLedgerRows, profitLocalFinanceContexts, profitLocalInputs, ratingPenaltyIndex, readableShops, retryRevision]);

  return { rows, errors, retry };
}
