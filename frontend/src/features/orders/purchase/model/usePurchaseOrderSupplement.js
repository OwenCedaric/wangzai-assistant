import React from 'react';
import { getSalesOrderRecordKey } from '../../../../entities/order/orderRecordRules.jsx';
import {
  getOzonLocalRowsWithEstimatedCommissions, getOzonLocalRowsWithProductImages,
  hasOzonOrderRowEstimatedCommission, hasOzonOrderRowProductImage, readOzonLocalProductEntityRows,
} from '../../../../entities/product/productLocalMirror.jsx';
import { getOzonApiErrorMessage } from '../../../../entities/product/productOzonApi.jsx';
import { readOzonOrderSupplementCacheRows, writeOzonOrderSupplementCacheRows } from '../../../../services/ozonOrderExperience';
import { recordRequestFailure, shouldAttemptRequest } from '../../../../services/requestCooldown';
import { LOCAL_OZON_DATA_LAYER_FILE_KEY } from '../../../../shared/config/appConfigCore.jsx';
import { purchaseSupplementCooldown } from '../../../../shared/config/appConfigRuntime.jsx';

export function usePurchaseOrderSupplement({ isActive, loading, refreshing, snapshotAt, scopeKey, orderKey,
  visibleOrders, readableShops, imageMap, setImageMap, setError }) {
  const latest = React.useRef(null);
  const resetEpoch = React.useRef(0);
  if (latest.current && imageMap.size === 0 && latest.current.imageMap !== imageMap) resetEpoch.current += 1;
  const imageResetKey = resetEpoch.current;
  latest.current = { visibleOrders, readableShops, imageMap };
  React.useEffect(() => {
    const { visibleOrders, readableShops, imageMap } = latest.current;
    if (!isActive || loading || refreshing || !visibleOrders.length || !readableShops.length) return undefined;
    const cachedRows = readOzonOrderSupplementCacheRows(visibleOrders);
    if (cachedRows.length) {
      setImageMap(current => {
        let changed = false;
        const next = new Map(current);
        for (const row of cachedRows) {
          const key = getSalesOrderRecordKey(row);
          if (key && !next.has(key)) { next.set(key, row); changed = true; }
        }
        return changed ? next : current;
      });
    }
    const imageKeys = getOzonLocalRowsWithProductImages(cachedRows, getSalesOrderRecordKey);
    const commissionKeys = getOzonLocalRowsWithEstimatedCommissions(cachedRows, getSalesOrderRecordKey);
    const candidates = visibleOrders.filter(order => {
      const key = getSalesOrderRecordKey(order), enhanced = key ? imageMap.get(key) : null;
      const needsImage = !hasOzonOrderRowProductImage(enhanced) && !imageKeys.has(key);
      const needsCommission = !hasOzonOrderRowEstimatedCommission(enhanced) && !commissionKeys.has(key)
        && !hasOzonOrderRowEstimatedCommission(order);
      return key && (needsImage || needsCommission) && shouldAttemptRequest(purchaseSupplementCooldown, key);
    });
    if (!candidates.length) return undefined;
    let cancelled = false;
    readOzonLocalProductEntityRows(LOCAL_OZON_DATA_LAYER_FILE_KEY, candidates, readableShops, getSalesOrderRecordKey)
      .then(result => {
        if (cancelled) return;
        if (result.rows.length) {
          writeOzonOrderSupplementCacheRows(result.rows);
          setImageMap(current => {
            let changed = false;
            const next = new Map(current);
            for (const row of result.rows) {
              const key = getSalesOrderRecordKey(row);
              if (key && next.get(key) !== row) { next.set(key, row); changed = true; }
            }
            return changed ? next : current;
          });
        }
        setError('');
      })
      .catch(error => {
        if (cancelled) return;
        for (const row of candidates) {
          const key = getSalesOrderRecordKey(row);
          if (key) recordRequestFailure(purchaseSupplementCooldown, key, { error });
        }
        setError(`补充信息读取失败：${getOzonApiErrorMessage(error)}`);
      });
    return () => { cancelled = true; };
    // A result (even one with no image/commission) must not trigger its own
    // request again. New snapshot, owner, page, refresh or re-entry still reads.
  }, [isActive, loading, refreshing, snapshotAt, scopeKey, orderKey, imageResetKey, setImageMap, setError]);
}
