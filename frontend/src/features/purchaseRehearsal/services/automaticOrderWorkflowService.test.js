import { describe, expect, it } from 'vitest';

import {
  automaticOrderSections,
  createAutomaticOrderFixtureRows,
  evaluateAutoPayProfitGate,
  executeAutomaticOrderAction,
  loadAutomaticOrderWorkspace,
  groupAutomaticOrderProducts,
} from './automaticOrderWorkflowService.js';

describe('automatic order workflow service', () => {
  it('runs a virtual order through purchase, stock and forecast without requiring a display SKU field', async () => {
    const workspace = await loadAutomaticOrderWorkspace({ fixture: { enabled: true } });
    const success = workspace.rows.find((row) => row.posting === 'VIRTUAL-ORDER-SUCCESS-1');
    expect(success).toMatchObject({ allBound: true, workflow: { 'auto-order': 'ready' } });

    const purchase = await executeAutomaticOrderAction(automaticOrderSections.autoOrder, success, { fixture: true });
    expect(purchase.patch).toMatchObject({
      manualBuyerPlatform: '拼多多',
      manualPurchaseOrderNo: 'VPO-VIRTUAL-ORDER-SUCCESS-1',
      manualPurchasePriceValue: 23.8,
      manualPurchaseOrderStatus: '已付款',
    });
    expect(purchase.patch).not.toHaveProperty('sku');

    const stock = await executeAutomaticOrderAction(automaticOrderSections.stock, success, { fixture: true });
    expect(stock.patch.purchaseForecastFlow.stage).toBe('ozon_prepared');

    const forecast = await executeAutomaticOrderAction(automaticOrderSections.forecast, success, { fixture: true });
    expect(forecast.patch).toMatchObject({
      crossBorderOrderFound: true,
      purchaseForecastFlow: { stage: 'completed' },
    });
  });

  it('keeps a missing SKU order visible and blocks only the auto-order action', async () => {
    const workspace = await loadAutomaticOrderWorkspace({ fixture: { enabled: true } });
    const unbound = workspace.rows.find((row) => row.posting === 'VIRTUAL-ORDER-NO-BINDING');
    expect(unbound.products[0].sku).toBe('');
    expect(unbound.workflow['auto-order']).toBe('blocked');
    expect(workspace.rows).toHaveLength(createAutomaticOrderFixtureRows().length);
  });

  it('returns a readable fail-closed error when the source price changes', async () => {
    const workspace = await loadAutomaticOrderWorkspace({ fixture: { enabled: true } });
    const changed = workspace.rows.find((row) => row.posting === 'VIRTUAL-ORDER-PRICE-ERROR');
    await expect(
      executeAutomaticOrderAction(automaticOrderSections.autoOrder, changed, { fixture: true }),
    ).rejects.toMatchObject({ code: 'AUTO_ORDER_SOURCE_PRICE_CHANGED' });
  });

  it('simulates Ozon status changes and label delays as independent recoverable errors', async () => {
    const workspace = await loadAutomaticOrderWorkspace({ fixture: { enabled: true } });
    const stockError = workspace.rows.find((row) => row.posting === 'VIRTUAL-STOCK-STATUS-ERROR');
    const labelError = workspace.rows.find((row) => row.posting === 'VIRTUAL-FORECAST-LABEL-ERROR');
    await expect(
      executeAutomaticOrderAction(automaticOrderSections.stock, stockError, { fixture: true }),
    ).rejects.toMatchObject({ code: 'AUTO_ORDER_OZON_STATUS_CHANGED' });
    await expect(
      executeAutomaticOrderAction(automaticOrderSections.forecast, labelError, { fixture: true }),
    ).rejects.toMatchObject({ code: 'AUTO_ORDER_LABEL_NOT_READY' });
  });

  it('enforces the configured profit and profit-rate gates from the existing profit ledger', () => {
    const row = {
      order: {
        profitLedger: {
          results: { estimatedProfitCny: { status: 'ready', value: 12 } },
          amounts: { salesAmountCny: { status: 'ready', value: 100 } },
        },
      },
    };
    expect(evaluateAutoPayProfitGate(row, { minProfit: 10, minProfitPercent: 10 }))
      .toEqual({ profit: 12, profitPercent: 12 });
    expect(() => evaluateAutoPayProfitGate(row, { minProfit: 13, minProfitPercent: 0 }))
      .toThrow(/13\.00/u);
    expect(() => evaluateAutoPayProfitGate(row, { minProfit: 1, minProfitPercent: 13 }))
      .toThrow(/13\.00%/u);
  });

  it('fails closed when the profit ledger is pending', () => {
    expect(() => evaluateAutoPayProfitGate({ order: { profitLedger: {} } }, { minProfit: 1 }))
      .toThrow(/预估利润尚未完整回读/u);
  });

  it('groups repeated source SKUs but keeps different source items as independent purchase orders', () => {
    const groups = groupAutomaticOrderProducts([
      { ozonSkuId: 'o-1', sourcePlatform: '淘宝', sourceUrl: 'https://item.taobao.com/item.htm?id=1', sourceSkuId: 's-1', sourceSkuName: '黑色', expectedUnitPrice: 10, quantity: 1 },
      { ozonSkuId: 'o-2', sourcePlatform: '淘宝', sourceUrl: 'https://item.taobao.com/item.htm?id=1', sourceSkuId: 's-1', sourceSkuName: '黑色', expectedUnitPrice: 10, quantity: 2 },
      { ozonSkuId: 'o-3', sourcePlatform: '1688', sourceUrl: 'https://detail.1688.com/offer/2.html', sourceSkuId: 's-2', sourceSkuName: '白色', expectedUnitPrice: 20, quantity: 1 },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ quantity: 3, ozonSkuIds: ['o-1', 'o-2'] });
    expect(groups[1]).toMatchObject({ sourcePlatform: '1688', quantity: 1 });
  });

  it('keeps an exact binding visible but blocks automatic payment for a non-payment marketplace', async () => {
    const orders = createAutomaticOrderFixtureRows();
    const unsupported = {
      ...orders[0],
      posting: 'VIRTUAL-UNSUPPORTED-PLATFORM',
      products: orders[0].products.map((product) => ({
        ...product,
        fixtureBinding: {
          binding: { sourcePlatform: 'Amazon', sourceUrl: 'https://www.amazon.com/dp/B000000001' },
          pair: { sourceSkuId: 'amazon-sku-1', sourceSkuName: 'Black', sourcePrice: '10', sourceCurrency: 'USD' },
        },
      })),
    };
    const workspace = await loadAutomaticOrderWorkspace({ fixture: { enabled: true, orders: [unsupported] } });
    expect(workspace.rows[0]).toMatchObject({
      allBound: true,
      autoOrderSupported: false,
      workflow: { 'auto-order': 'blocked' },
    });
  });

  it('uses the purchase-management pending status as the only automatic-order list source', async () => {
    const shops = [{ id: 'shop-a', clientId: 'client-a', shopAlias: '测试店', purchaseManagementStartedAt: '2026-01-01T00:00:00.000Z' }];
    const rawOrder = (posting, extra = {}) => ({
      posting,
      id: posting,
      shopId: 'shop-a',
      shop: '测试店',
      status: 'awaiting_packaging',
      ozonRawStatus: 'awaiting_packaging',
      paymentTime: '2026-08-27T00:00:00.000Z',
      products: [{ sku: `${posting}-sku`, offerId: `${posting}-offer`, name: posting, qty: 1, price: '100' }],
      ...extra,
    });
    const workspace = await loadAutomaticOrderWorkspace({
      shops,
      readSnapshot: async () => ({ rows: [
        rawOrder('PENDING-1'),
        rawOrder('PENDING-BLOCKED-1', { crossBorderOrderFound: true, crossBorderOrderNumber: 'CB-1' }),
        rawOrder('PAID-1', {
          manualBuyerPlatform: '1688',
          manualPurchaseOrderNo: '1688-ORDER-1',
          manualPurchasePriceValue: 20,
          manualPurchaseOrderStatus: '已付款',
        }),
        rawOrder('DELIVERY-1', { status: 'awaiting_delivery', ozonRawStatus: 'awaiting_delivery' }),
      ], errors: [], fetchedAt: '2026-08-27T00:00:00.000Z' }),
      readBindings: async () => ({ version: 2, bindings: [] }),
      readOverrides: async () => ({}),
      readProfitSnapshot: async () => ({ rowsByKey: {} }),
      readSourceLinks: async () => ({
        'shop-a:sku:PENDING-1-sku': {
          shopId: 'shop-a',
          sku: 'PENDING-1-sku',
          primaryIndex: 0,
          links: [{ link: 'https://detail.1688.com/offer/900001.html', platform: '1688' }],
        },
      }),
    });
    expect(workspace.rows.map((row) => row.posting)).toEqual(['PENDING-1', 'PENDING-BLOCKED-1']);
    expect(workspace.rows[0]).toMatchObject({ purchaseManagementStatus: '待拍单', purchaseManagementCanPurchase: true });
    expect(workspace.rows[0].products[0].savedSourceLink.link).toBe('https://detail.1688.com/offer/900001.html');
    expect(workspace.rows[1]).toMatchObject({ purchaseManagementStatus: '待拍单', purchaseManagementCanPurchase: false });
  });
});
