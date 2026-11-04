// Snapshot of the pre-optimization hook for performance/result comparison only.
import React from 'react';
import { getProfitOrderRecordKey } from '../../../../entities/profit/profitOrderRecordRules.jsx';
import { createProfitShopCalculationLanes, runProfitShopCalculationLanes, selectChangedProfitShopLanes } from './profitShopCalculationLanes.baseline.js';
import { safeInfo, safeWarn } from '../../../../services/safeLog.js';
import { createProfitCalculationSignatures } from '../profitCalculationSignatures.js';

export function useProfitCalculationLanes({ isActive, baseProfitRows, calculateProfitRow, ...inputs }) {
  const { readableShops, profitLocalFinanceContexts, profitImageMap, profitFinanceRows, profitLedgerRows, profitLocalInputs, ratingPenaltyIndex } = inputs;
  const [rows, setRows] = React.useState([]);
  const [errors, setErrors] = React.useState([]);
  const [retryRevision, setRetryRevision] = React.useState(0);
  const cacheRef = React.useRef(new Map());
  const retry = React.useCallback(() => {
    for (const error of errors) {
      const cached = cacheRef.current.get(error.shopId);
      if (cached) cached.signature = null;
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
    const signatures = createProfitCalculationSignatures(lanes, {
      readableShops, profitLocalFinanceContexts, profitImageMap, profitFinanceRows, profitLedgerRows, profitLocalInputs, ratingPenaltyIndex,
    });
    for (const shopId of cacheRef.current.keys()) if (!signatures.has(shopId)) cacheRef.current.delete(shopId);
    const publishCompletedLanes = () => {
      const calculated = new Map();
      for (const cached of cacheRef.current.values()) for (const row of cached.rows) calculated.set(getProfitOrderRecordKey(row), row);
      setRows(baseProfitRows.map(order => calculated.get(getProfitOrderRecordKey(order))).filter(Boolean));
    };
    const changed = selectChangedProfitShopLanes(lanes, signatures, cacheRef.current);
    // Even unchanged calculations must reflect removal/reordering of the base view.
    publishCompletedLanes();
    if (!changed.length) return () => controller.abort();
    const changedRows = changed.flatMap(lane => lane.items.map(item => item.row));
    runProfitShopCalculationLanes(changedRows, calculateProfitRow, {
      signal: controller.signal, shopIds,
      onShopComplete(lane) {
        if (controller.signal.aborted) return;
        cacheRef.current.set(lane.shopId, { signature: signatures.get(lane.shopId), rows: lane.rows.map(item => item.row).filter(Boolean) });
        setErrors(current => current.filter(error => error.shopId !== lane.shopId));
        publishCompletedLanes();
        safeInfo(`[profit-calculation-lane-ready] ${JSON.stringify({ shopId: lane.shopId, rows: lane.rows.length, durationMs: lane.durationMs })}`);
      },
      onShopError(lane) {
        if (controller.signal.aborted) return;
        setErrors(current => [...current.filter(error => error.shopId !== lane.shopId), { shopId: lane.shopId, stale: true }]);
        safeWarn('利润独立计算通道失败', { shopId: lane.shopId, error: lane.reason });
      },
    }).catch(error => { if (!controller.signal.aborted) safeWarn('利润独立计算调度失败', error); });
    return () => controller.abort();
  }, [baseProfitRows, calculateProfitRow, isActive, profitFinanceRows, profitImageMap, profitLedgerRows, profitLocalFinanceContexts, profitLocalInputs, ratingPenaltyIndex, readableShops, retryRevision]);

  return { rows, errors, retry };
}
