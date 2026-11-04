import { describe, expect, it } from 'vitest';
import {
  buildPurchaseOrderDetailUrl,
  normalizePurchasePlatformName,
  resolvePurchaseOrderDetailUrl,
} from './purchaseOrderDetailUrl';

describe('purchaseOrderDetailUrl', () => {
  it('builds direct purchase order detail urls for the four supported platforms', () => {
    expect(buildPurchaseOrderDetailUrl('天猫', 'tmall-001')).toBe(
      'https://trade.tmall.com/detail/orderDetail.htm?spm=tbpc.boughtlist.order_detail.1.21282e8ddrElZ2&bizOrderId=tmall-001'
    );
    expect(buildPurchaseOrderDetailUrl('淘宝', 'tb-001')).toBe(
      'https://trade.taobao.com/trade/detail/trade_order_detail.htm?spm=tbpc.boughtlist.order_detail.1.67b22e8dtmbxOB&biz_order_id=tb-001'
    );
    expect(buildPurchaseOrderDetailUrl('拼多多', 'pdd-001')).toBe(
      'https://mobile.yangkeduo.com/order.html?order_sn=pdd-001'
    );
    expect(buildPurchaseOrderDetailUrl('1688', 'ali-001')).toBe(
      'https://air.1688.com/app/ctf-page/trade-order-detail/index.html?orderId=ali-001'
    );
  });

  it('normalizes common platform aliases', () => {
    expect(normalizePurchasePlatformName('tmall')).toBe('天猫');
    expect(normalizePurchasePlatformName('taobao')).toBe('淘宝');
    expect(normalizePurchasePlatformName('PDD')).toBe('拼多多');
    expect(normalizePurchasePlatformName('阿里巴巴1688')).toBe('1688');
  });

  it('does not fabricate links without a supported platform and order number', () => {
    expect(buildPurchaseOrderDetailUrl('未知平台', 'x-1')).toBe('');
    expect(buildPurchaseOrderDetailUrl('淘宝', '未返回')).toBe('');
  });

  it('keeps explicit persisted purchase order urls above generated templates', () => {
    expect(
      resolvePurchaseOrderDetailUrl({
        platform: '拼多多',
        orderNumber: 'pdd-001',
        explicitUrl: 'https://mms.pinduoduo.com/orders/detail?orderSn=pdd-001',
      })
    ).toBe('https://mms.pinduoduo.com/orders/detail?orderSn=pdd-001');
  });
});
