import {
  derivePurchaseOrderStatus,
  isConfirmedPurchasePlatformStatus,
} from './purchaseOrderRuntime.js';
import { describe, expect, it } from 'vitest';

describe('采购平台真实付款状态', () => {
  it('把插件返回的交易成功识别为已经真实拍单', () => {
    expect(isConfirmedPurchasePlatformStatus('交易成功')).toBe(true);
    expect(derivePurchaseOrderStatus({
      ozonStatus: 'awaiting_packaging',
      buyerPlatform: '拼多多',
      purchaseOrderNo: '260613-430440476292967',
      purchasePrice: '18.80',
      purchaseOrderStatus: '交易成功',
    })).toBe('已拍单-待预报');
  });

  it('退款和关闭状态仍然回到未确认采购', () => {
    expect(isConfirmedPurchasePlatformStatus('退款成功')).toBe(false);
    expect(isConfirmedPurchasePlatformStatus('交易关闭')).toBe(false);
  });
});
