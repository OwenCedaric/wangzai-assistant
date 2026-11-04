import hookSource from './useSalesOrderLogisticsSyncState.jsx?raw';
import { describe, expect, it } from 'vitest';

describe('物流同步页面隔离', () => {
  it('只显示当前按钮自己发起的同步状态，不订阅其他页面的全局进度', () => {
    expect(hookSource).not.toContain('subscribeSalesOrderLogisticsProgress');
    expect(hookSource).toContain('syncSalesOrderPurchaseLogistics(purchaseOrders');
    expect(hookSource).toContain('onProgress: (progress) =>');
  });
});
