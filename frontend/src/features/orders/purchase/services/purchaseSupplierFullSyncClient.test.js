import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectPurchaseSupplierCandidates,
  createPurchaseSupplierLogisticsPatch,
  readPurchaseSupplierOrders,
} from './purchaseSupplierFullSyncClient.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('采购单全量同步客户端', () => {
  it('只把原插件明确返回的快递公司、单号和状态映射到订单共用字段', () => {
    expect(createPurchaseSupplierLogisticsPatch({
      logistics: {
        carrier: '中通快递(ZTO)',
        trackingNumber: '79028134877723',
        sourceMethod: 'cross-border-bus-plugin-original-v1.0.8',
      },
      localMirror: { saved: 1 },
    }, '2026-08-26T03:00:00.000Z')).toMatchObject({
      domesticCourierCompany: '中通快递(ZTO)',
      domesticTrackingNumber: '79028134877723',
      domesticLogisticsStatus: '已发货',
      domesticLogisticsSyncStatus: '已保存',
      domesticLogisticsSource: 'cross-border-bus-plugin-original-v1.0.8',
    });
    expect(createPurchaseSupplierLogisticsPatch({ logistics: { carrier: '中通快递' } })).toBeNull();
  });
  it('只收集页面内同时存在采购平台和采购单号的订单', () => {
    const rows = collectPurchaseSupplierCandidates([
      { id: 'a', buyerPlatform: '拼多多', purchaseOrderNo: '2601-1' },
      { id: 'b', manualBuyerPlatform: '淘宝', manualPurchaseOrderNo: '33001' },
      { id: 'c', buyerPlatform: '待拍单', purchaseOrderNo: '33002' },
      { id: 'd', buyerPlatform: '1688', purchaseOrderNo: '' },
    ]);
    expect(rows.map((row) => [row.order.id, row.platform, row.purchaseOrderNumber])).toEqual([
      ['a', '拼多多', '2601-1'],
      ['b', '淘宝', '33001'],
    ]);
  });

  it('按平台和每100条分批调用插件并汇总精确结果', async () => {
    const command = vi.fn(async (input) => ({
      ok: true,
      results: input.orderNumbers.map((purchaseOrderNumber) => ({
        ok: true,
        platformLabel: input.platform,
        purchaseOrderNumber,
        purchasePrice: 12.5,
        purchaseOrderStatus: '交易成功',
      })),
    }));
    vi.stubGlobal('window', { wangzaiDesktop: { purchaseBrowser: { command } } });
    const candidates = [
      ...Array.from({ length: 21 }, (_, index) => ({
        platform: '拼多多',
        purchaseOrderNumber: `PDD-${index + 1}`,
      })),
      { platform: '淘宝', purchaseOrderNumber: 'TB-1' },
    ];
    const progress = [];
    const result = await readPurchaseSupplierOrders(candidates, {
      onProgress: (value) => progress.push(value),
    });
    expect(result).toMatchObject({ ok: true, total: 22, matched: 22, failed: 0 });
    expect(command).toHaveBeenCalledTimes(2);
    expect(command.mock.calls.map(([input]) => [input.platform, input.orderNumbers.length])).toEqual([
      ['拼多多', 21],
      ['淘宝', 1],
    ]);
    expect(progress.at(-1)).toMatchObject({ completed: 22, total: 22 });
  });

  it('同一平台100条采购单通过一次插件批量命令提交', async () => {
    const command = vi.fn(async (input) => ({
      ok: true,
      results: input.orderNumbers.map((purchaseOrderNumber) => ({
        ok: true,
        platformLabel: input.platform,
        purchaseOrderNumber,
        purchasePrice: 10,
        purchaseOrderStatus: '已发货',
      })),
    }));
    vi.stubGlobal('window', { wangzaiDesktop: { purchaseBrowser: { command } } });
    const candidates = Array.from({ length: 100 }, (_, index) => ({
      platform: '1688',
      purchaseOrderNumber: `1688-${String(index + 1).padStart(3, '0')}`,
    }));

    const result = await readPurchaseSupplierOrders(candidates);

    expect(result).toMatchObject({ ok: true, total: 100, matched: 100, failed: 0 });
    expect(command).toHaveBeenCalledOnce();
    expect(command.mock.calls[0][0].orderNumbers).toHaveLength(100);
  });

  it('一个采购平台读取失败时继续同步其他平台', async () => {
    const command = vi.fn(async (input) => {
      if (input.platform === '拼多多') throw new Error('fixture failure');
      return {
        ok: true,
        results: [{
          ok: true,
          platformLabel: input.platform,
          purchaseOrderNumber: input.orderNumbers[0],
          purchasePrice: 8.8,
          purchaseOrderStatus: '待发货',
        }],
      };
    });
    vi.stubGlobal('window', { wangzaiDesktop: { purchaseBrowser: { command } } });
    const result = await readPurchaseSupplierOrders([
      { platform: '拼多多', purchaseOrderNumber: 'PDD-1' },
      { platform: '淘宝', purchaseOrderNumber: 'TB-1' },
    ]);
    expect(result).toMatchObject({ ok: false, total: 2, matched: 1, failed: 1 });
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ ok: false, platformLabel: '拼多多', purchaseOrderNumber: 'PDD-1' }),
      expect.objectContaining({ ok: true, platformLabel: '淘宝', purchaseOrderNumber: 'TB-1' }),
    ]));
  });

  it('插件瞬时未返回时只重试失败采购单并保留成功结果', async () => {
    let attempts = 0;
    const command = vi.fn(async (input) => {
      attempts += 1;
      return {
        ok: attempts > 1,
        results: input.orderNumbers.map((purchaseOrderNumber) => ({
          ok: attempts > 1,
          platformLabel: input.platform,
          purchaseOrderNumber,
          ...(attempts > 1 ? {
            purchasePrice: 5.69,
            purchaseOrderStatus: '已发货',
            logistics: { carrier: '中通快递(ZTO)', trackingNumber: '79028134877723' },
          } : { status: '暂未返回' }),
        })),
      };
    });
    vi.stubGlobal('window', { wangzaiDesktop: { purchaseBrowser: { command } } });

    const result = await readPurchaseSupplierOrders([{
      platform: '1688',
      purchaseOrderNumber: '3316981152254029783',
    }]);

    expect(result).toMatchObject({ ok: true, matched: 1, failed: 0 });
    expect(command).toHaveBeenCalledTimes(2);
    expect(result.results[0].logistics.trackingNumber).toBe('79028134877723');
  });
});
