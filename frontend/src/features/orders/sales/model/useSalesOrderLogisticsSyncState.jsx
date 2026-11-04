import {
  syncSalesOrderPurchaseLogistics,
} from '../services/salesOrderLogisticsSyncClient.js';
import React from 'react';

const INITIAL_STATE = Object.freeze({
  running: false,
  message: '',
  completed: 0,
  total: 0,
  errors: 0,
  result: null,
});

export function useSalesOrderLogisticsSyncState({ setSalesNotice, purchaseOrders = [] } = {}) {
  const [logisticsSync, setLogisticsSync] = React.useState(INITIAL_STATE);

  const handleSyncLogistics = React.useCallback(async () => {
    setLogisticsSync({
      ...INITIAL_STATE,
      running: true,
      message: '正在读取跨境巴士待补物流订单',
    });
    try {
      const result = await syncSalesOrderPurchaseLogistics(purchaseOrders, {
        onProgress: (progress) => {
          setLogisticsSync((current) => ({
            ...current,
            running: true,
            message: String(progress?.message || current.message || ''),
            completed: Number(progress?.completed) || 0,
            total: Number(progress?.total) || 0,
          }));
        },
      });
      const synced = Number(result?.synced) || 0;
      const notShipped = Number(result?.notShipped) || 0;
      const supplierMatched = Number(result?.matched) || 0;
      const failed = Number(result?.failed) || 0;
      const pendingReadback = Number(result?.pendingReadback) || 0;
      const busFailed = Boolean(result?.busErrorCode);
      const message = `同步物流完成：跨境巴士成功 ${synced}，未发货 ${notShipped}；采购单补查成功 ${supplierMatched}，失败 ${failed}${pendingReadback ? `，待回读 ${pendingReadback}` : ''}${busFailed ? '；跨境巴士待补队列未完成' : ''}`;
      setLogisticsSync({
        running: false,
        message,
        completed: Number(result?.total) || 0,
        total: Number(result?.total) || 0,
        errors: failed + pendingReadback + (busFailed ? 1 : 0),
        result,
      });
      setSalesNotice?.({
        open: true,
        severity: failed || pendingReadback || busFailed ? 'warning' : 'success',
        message,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : '物流同步失败，未确认的订单没有写入。';
      setLogisticsSync((current) => ({
        ...current,
        running: false,
        message,
        errors: Math.max(1, current.errors),
      }));
      setSalesNotice?.({ open: true, severity: 'warning', message });
      return null;
    }
  }, [purchaseOrders, setSalesNotice]);

  return { logisticsSync, handleSyncLogistics };
}
