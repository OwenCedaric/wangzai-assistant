import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  subscribeSalesOrderLogisticsProgress,
  syncSalesOrderPurchaseLogistics,
} from './salesOrderLogisticsSyncClient.js';

describe('sales order logistics sync client', () => {
  beforeEach(() => {
    globalThis.window.wangzaiDesktop = undefined;
  });

  it('dispatches one desktop sync command', async () => {
    const command = vi.fn(async () => ({ ok: true, total: 2, synced: 2 }));
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };

    await expect(syncSalesOrderPurchaseLogistics()).resolves.toMatchObject({ synced: 2 });
    expect(command).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith({
      command: 'cross-border-logistics-sync',
      restoreVisible: false,
    });
  });

  it('subscribes through the real onEvent bridge and filters unrelated events', () => {
    let browserListener;
    const unsubscribe = vi.fn();
    const onEvent = vi.fn((listener) => {
      browserListener = listener;
      return unsubscribe;
    });
    const listener = vi.fn();
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { onEvent } };

    const stop = subscribeSalesOrderLogisticsProgress(listener);
    browserListener({ event: 'opened' });
    browserListener({ event: 'cross-border-logistics-progress', stage: 'supplier-read' });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ stage: 'supplier-read' }));
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('opens the isolated cross-border login profile when login is required', async () => {
    const loginError = Object.assign(new Error('CROSS_BORDER_LOGIN_REQUIRED'), {
      code: 'CROSS_BORDER_LOGIN_REQUIRED',
    });
    const command = vi.fn()
      .mockRejectedValueOnce(loginError)
      .mockResolvedValueOnce({ ok: true });
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };

    await expect(syncSalesOrderPurchaseLogistics()).resolves.toMatchObject({
      ok: false,
      busErrorCode: 'CROSS_BORDER_LOGIN_REQUIRED',
    });
    expect(command).toHaveBeenNthCalledWith(2, {
      command: 'open',
      accountId: 'builtin-cross-border-logistics',
      ownerType: 'builtin_cross_border_profile',
      url: 'https://www.kuajing84.com/',
    });
  });

  it('runs the full bus sync and supplier supplement through the same button call', async () => {
    const command = vi.fn(async (input) => {
      if (input.command === 'cross-border-logistics-sync') {
        return { ok: true, synced: 1, failed: 0, pendingReadback: 0 };
      }
      if (input.command === 'cross-border-purchase-read') {
        return {
          ok: true,
          matched: 1,
          failed: 0,
          results: [{
            ok: true,
            platformLabel: '1688',
            purchaseOrderNumber: '3316981152254029783',
            purchasePrice: 5.69,
            purchaseOrderStatus: '已发货',
            logistics: { carrier: '中通快递(ZTO)', trackingNumber: '79028134877723' },
          }],
        };
      }
      throw new Error(`unexpected ${input.command}`);
    });
    globalThis.window.wangzaiDesktop = { purchaseBrowser: { command } };

    const result = await syncSalesOrderPurchaseLogistics([{
      id: '64720469-0563-1',
      purchasePlatform: '1688',
      purchaseOrderNumber: '3316981152254029783',
    }]);

    expect(result).toMatchObject({ ok: true, synced: 1, matched: 1, failed: 0 });
    expect(command.mock.calls.map(([input]) => input.command)).toEqual([
      'cross-border-logistics-sync',
      'cross-border-purchase-read',
    ]);
  });
});
