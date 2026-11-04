import { describe, expect, it } from 'vitest';

import {
  resolvePurchaseDomesticLogistics,
  resolvePurchaseMaterialReadStatus,
  resolvePurchaseReturnedMaterial,
} from './usePurchaseSelectionDetailState.jsx';

describe('purchase order card domestic logistics presentation', () => {
  it('reads courier and tracking values independently from SKU fields', () => {
    expect(resolvePurchaseDomesticLogistics(
      { sku: '', carrierName: '中通快递', domesticTrackingNumber: 'ZT10001' },
      {},
    )).toEqual({ carrier: '中通快递', trackingNumber: 'ZT10001', status: '已发货' });
  });

  it('prefers the latest cross-border readback aliases', () => {
    expect(resolvePurchaseDomesticLogistics(
      { carrierName: '旧快递', domesticTrackingNumber: 'OLD-1' },
      { expressCompany: '圆通快递', logisticsOrder: 'YT20002' },
    )).toEqual({ carrier: '圆通快递', trackingNumber: 'YT20002', status: '已发货' });
  });

  it('keeps both fields readable when the backend has not returned data', () => {
    expect(resolvePurchaseDomesticLogistics({}, {})).toEqual({
      carrier: '未返回',
      trackingNumber: '未返回',
      status: '未返回',
    });
  });

  it('reduces forecast readback to the three required material states', () => {
    expect(resolvePurchaseMaterialReadStatus({}, {}, {})).toBe('未返回');
    expect(resolvePurchaseMaterialReadStatus(
      { crossBorderOrderFound: true, packageOrderId: 'BUS-1' },
      {},
      {},
    )).toBe('已读取');
    expect(resolvePurchaseMaterialReadStatus(
      { crossBorderOrderFound: true },
      {},
      { weightKg: 0.2, lengthCm: 10, heightCm: 20, widthCm: 30 },
    )).toBe('已返回');
  });

  it('does not mistake a negative forecast message for a successful read', () => {
    expect(resolvePurchaseMaterialReadStatus(
      {},
      { message: '未查到预报订单' },
      {},
    )).toBe('未返回');
  });

  it('does not use local product material as a cross-border return fallback', () => {
    expect(resolvePurchaseReturnedMaterial({ orderId: 'BUS-1' })).toMatchObject({
      weightText: '未返回',
      lengthText: '未返回',
      heightText: '未返回',
      widthText: '未返回',
      sizeText: '未返回',
    });
    expect(resolvePurchaseMaterialReadStatus(
      {
        products: [{
          materialProfile: { weight: 0.05, length: 10, height: 20, width: 20 },
        }],
      },
      { orderId: 'BUS-1' },
      resolvePurchaseReturnedMaterial({ orderId: 'BUS-1' }),
    )).toBe('已读取');
  });
});
