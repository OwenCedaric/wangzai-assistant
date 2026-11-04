import { describe, expect, it } from 'vitest';
import {
  getPurchaseForecastFlowFromOrder,
  isPurchaseForecastCompleted,
  isPurchaseForecastLabelReady,
  isPurchaseForecastOzonPrepared,
  mergePurchaseForecastFlow,
  normalizePurchaseForecastFlow,
  purchaseForecastStages,
} from './purchaseForecastFlow.js';

const order = {
  id: '64720469-0563-1',
  posting: '64720469-0563-1',
  shopId: 'shop-3',
};

describe('purchase forecast flow', () => {
  it('keeps progress isolated by exact shop and posting', () => {
    const stored = {
      postingNumber: order.posting,
      shopId: order.shopId,
      stage: purchaseForecastStages.labelReady,
      sheetOrderSn: 'sheet-1',
      sheetUrl: 'https://example.test/sheet.pdf',
    };
    expect(normalizePurchaseForecastFlow(stored, { order })).toMatchObject(stored);
    expect(
      normalizePurchaseForecastFlow(stored, {
        order: { ...order, posting: 'another-posting', id: 'another-posting' },
      })
    ).toMatchObject({ stage: purchaseForecastStages.idle, sheetUrl: '' });
  });

  it('does not unlock forecast without both saved label number and URL', () => {
    const prepared = mergePurchaseForecastFlow(
      {},
      { stage: purchaseForecastStages.ozonPrepared, ozonPreparedAt: '2026-08-24T13:44:20.000Z' },
      { order }
    );
    expect(isPurchaseForecastOzonPrepared(prepared)).toBe(true);
    expect(isPurchaseForecastLabelReady(prepared)).toBe(false);

    const incompleteLabel = mergePurchaseForecastFlow(
      prepared,
      { stage: purchaseForecastStages.labelReady, sheetOrderSn: 'sheet-1' },
      { order }
    );
    expect(isPurchaseForecastLabelReady(incompleteLabel)).toBe(false);
  });

  it('restores a completed order directly from persisted order facts', () => {
    const restored = getPurchaseForecastFlowFromOrder({
      ...order,
      crossBorderOrderFound: true,
      packageOrderId: 'bus-order-1',
      crossBorderOrderNumber: 'bus-number-1',
      crossBorderUpdatedAt: '2026-08-24T14:00:00.000Z',
    });
    expect(isPurchaseForecastCompleted(restored)).toBe(true);
    expect(restored).toMatchObject({
      crossBorderOrderFound: true,
      crossBorderOrderId: 'bus-order-1',
      crossBorderOrderNumber: 'bus-number-1',
    });
  });

  it('keeps a created but not yet associated bus order resumable instead of marking it completed', () => {
    const submitting = mergePurchaseForecastFlow(
      {
        stage: purchaseForecastStages.labelReady,
        sheetOrderSn: 'sheet-1',
        sheetUrl: 'https://example.test/sheet.pdf',
      },
      {
        stage: purchaseForecastStages.forecastSubmitting,
        crossBorderOrderId: 'bus-order-pending',
      },
      { order },
    );
    expect(submitting.stage).toBe(purchaseForecastStages.forecastSubmitting);
    expect(isPurchaseForecastLabelReady(submitting)).toBe(true);
    expect(isPurchaseForecastCompleted(submitting)).toBe(false);
    expect(getPurchaseForecastFlowFromOrder({
      ...order,
      packageOrderId: 'bus-order-pending',
      purchaseForecastFlow: submitting,
    }).stage).toBe(purchaseForecastStages.forecastSubmitting);
  });
});
