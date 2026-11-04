import { describe, expect, it } from 'vitest';
import { resolvePrintShippingOrderFields } from './printShippingOrderFields.js';

describe('resolvePrintShippingOrderFields', () => {
  it('separates domestic tracking from the Ozon tracking number', () => {
    const result = resolvePrintShippingOrderFields(
      { raw: { tracking_number: 'OZON-TRACK-1' } },
      {
        purchaseInfo: { platform: '1688', orderNumber: 'BUY-100' },
        purchaseOverride: {
          crossBorderRecord: {
            tracking_number: 'CN-EXPRESS-1',
            sheet_order_sn: 'OZON-SHEET-1',
          },
        },
      }
    );

    expect(result).toEqual({
      sourcePlatform: '1688',
      purchaseOrderNumber: 'BUY-100',
      domesticTrackingNumber: 'CN-EXPRESS-1',
      ozonTrackingNumber: 'OZON-TRACK-1',
    });
  });

  it('uses synchronized cross-border fields and returns clear pending labels', () => {
    expect(resolvePrintShippingOrderFields({}, {
      purchaseInfo: {},
      purchaseOverride: {
        crossBorderRecord: {
          from_platform: 3,
          from_order: 'PDD-ORDER-8',
          logistics_order: 'CN-TRACK-8',
          sheet_order_sn: 'OZON-SHEET-8',
        },
      },
    })).toEqual({
      sourcePlatform: '拼多多',
      purchaseOrderNumber: 'PDD-ORDER-8',
      domesticTrackingNumber: 'CN-TRACK-8',
      ozonTrackingNumber: 'OZON-SHEET-8',
    });

    expect(resolvePrintShippingOrderFields()).toEqual({
      sourcePlatform: '待关联',
      purchaseOrderNumber: '待关联',
      domesticTrackingNumber: '待同步',
      ozonTrackingNumber: '待 Ozon 返回',
    });
  });

  it('shows the exact plugin tracking number from the shared local logistics record', () => {
    const result = resolvePrintShippingOrderFields(
      { id: '64720469-0563-1' },
      {
        purchaseInfo: { platform: '1688', orderNumber: '3316981152254029783' },
        purchaseOverride: {
          crossBorderRecord: {
            carrierName: '中通快递(ZTO)',
            trackingNumber: '79028134877723',
            domesticLogisticsStatus: '已发货',
          },
        },
      },
    );
    expect(result.domesticTrackingNumber).toBe('79028134877723');
  });
});
