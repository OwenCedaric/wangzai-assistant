import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProfileSetting: vi.fn(),
  saveProfileSetting: vi.fn(),
}));

vi.mock('../api/localApiClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getProfileSetting: mocks.getProfileSetting,
  saveProfileSetting: mocks.saveProfileSetting,
}));

import { getOrderCardPlatformFee } from '../features/orders/purchase/lib/purchaseImageRules.jsx';
import { normalizeOzonSalesRowToPurchaseOrder } from '../features/orders/purchase/lib/purchaseOrderNormalize.jsx';
import { loadFeePlanState, saveFeePlanState } from '../features/settings/lib/feeSettings.jsx';

function saveCrossBorderFeeSettings() {
  saveFeePlanState({
    activeId: 'test-cross-border-plan',
    plans: [{
      id: 'test-cross-border-plan',
      name: '测试跨境费用',
      settings: {
        platform: 'crossBorderBus',
        labelFeeUnit: '0.5',
        rechargeAmount: '100',
        giftAmount: '0',
        forecastOrderFee: '0.73',
      },
    }],
  });
}

describe('purchase order platform fee display rules', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getProfileSetting.mockResolvedValue({ setting: null });
    mocks.saveProfileSetting.mockImplementation(async (_namespace, value) => ({
      setting: { namespace: 'fee-settings', value },
    }));
    await loadFeePlanState();
  });

  it('uses exchange rate and product summary commission so platform fee is not left pending', () => {
    saveCrossBorderFeeSettings();
    const normalizedOrder = normalizeOzonSalesRowToPurchaseOrder({
      posting: '06477778-0475-1',
      amount: '27.00',
      rubToCnyRate: 0.09254118082546733,
      exchangeRate: { rubToCnyRate: 0.09254118082546733, source: 'unit-daily' },
      commissionPercent: '12%',
      products: [
        {
          name: '测试商品',
          offerId: 'mz-26050910-195318',
          sku: '4240695405',
          qty: 1,
          price: '27.00',
          salesAmountValue: 27,
          commissionPercent: 12,
        },
      ],
    });

    const platformFee = getOrderCardPlatformFee(normalizedOrder);

    expect(platformFee.display).not.toBe('待确认');
    expect(platformFee.commissionValue).toBeCloseTo(3.24, 5);
    expect(platformFee.acquiringValue).toBeCloseTo(0.54, 5);
    expect(platformFee.mileageValue).toBeCloseTo(15 * 0.09254118082546733, 5);
    expect(platformFee.crossBorderValue).toBeCloseTo(1.23, 5);
    expect(platformFee.totalValue).toBeCloseTo(3.24 + 0.54 + 15 * 0.09254118082546733 + 1.23, 5);
  });
});
