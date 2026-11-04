import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestOzonSalesOrderDetail: vi.fn(),
  requestProtectedOzonOrderOperation: vi.fn(),
}));

vi.mock('./marketingOrderFields.jsx', () => ({
  assertFbsSalesOrder: (order) => order.posting || order.id,
  buildOzonShipProducts: () => [{ product_id: 101, quantity: 1 }],
  buildSimulatedSalesOrderSplitResult: () => ({}),
  getSalesOrderRawStatus: (order) => order.rawStatus || '',
  isSalesOrderSplitUiTestOrder: () => false,
  parseSplitQuantityPlan: () => [],
  requestOzonSalesOrderDetail: mocks.requestOzonSalesOrderDetail,
  requestProtectedOzonOrderOperation: mocks.requestProtectedOzonOrderOperation,
}));

import { prepareOzonForPurchaseForecast } from './marketingSnapshotRuntime.jsx';

describe('prepare Ozon order for purchase forecast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestProtectedOzonOrderOperation.mockResolvedValue({ ok: true });
  });

  it('does not report prepared until Ozon readback confirms awaiting delivery', async () => {
    mocks.requestOzonSalesOrderDetail
      .mockResolvedValueOnce({ id: 'posting-1', rawStatus: 'awaiting_packaging' })
      .mockResolvedValueOnce({ id: 'posting-1', rawStatus: 'awaiting_packaging' })
      .mockResolvedValueOnce({ id: 'posting-1', rawStatus: 'awaiting_delivery' });

    const result = await prepareOzonForPurchaseForecast(
      { id: 'shop-1', clientId: 'client-1', apiKey: 'key-1' },
      { id: 'posting-1', posting: 'posting-1' },
      { readbackAttempts: 3, readbackDelayMs: 0 },
    );

    expect(mocks.requestProtectedOzonOrderOperation).toHaveBeenCalledTimes(1);
    expect(mocks.requestOzonSalesOrderDetail).toHaveBeenCalledTimes(3);
    expect(result.rawStatus).toBe('awaiting_delivery');
  });

  it('fails instead of claiming success when Ozon never confirms the transition', async () => {
    mocks.requestOzonSalesOrderDetail.mockResolvedValue({
      id: 'posting-2',
      rawStatus: 'awaiting_packaging',
    });

    await expect(
      prepareOzonForPurchaseForecast(
        { id: 'shop-1', clientId: 'client-1', apiKey: 'key-1' },
        { id: 'posting-2', posting: 'posting-2' },
        { readbackAttempts: 2, readbackDelayMs: 0 },
      ),
    ).rejects.toThrow('尚未确认备货成功');
    expect(mocks.requestProtectedOzonOrderOperation).toHaveBeenCalledTimes(1);
    expect(mocks.requestOzonSalesOrderDetail).toHaveBeenCalledTimes(3);
  });
});
