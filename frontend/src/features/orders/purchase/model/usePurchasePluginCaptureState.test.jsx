import { describe, expect, it } from 'vitest';
import { findPurchasePluginCaptureOrder } from './usePurchasePluginCaptureState.jsx';

const POSTING = '06477778-0475-1';

function order(shopId, shopClientId) {
  return {
    id: POSTING,
    recordKey: `${shopClientId}:${POSTING}`,
    salesOrder: POSTING,
    shipmentNo: POSTING,
    shopId,
    shopClientId,
  };
}

describe('purchase plugin capture target scope', () => {
  it('rejects an ambiguous plain posting when two internal shops have the same order key', () => {
    const shopAOrder = order('shop-a', 'client-a');
    const shopBOrder = order('shop-b', 'client-b');

    expect(
      findPurchasePluginCaptureOrder([shopAOrder, shopBOrder], {
        orderKey: POSTING,
      })
    ).toBeNull();
  });

  it('selects only the candidate matching both internal shop and client scope', () => {
    const shopAOrder = order('shop-a', 'client-a');
    const shopBOrder = order('shop-b', 'client-b');

    expect(
      findPurchasePluginCaptureOrder([shopAOrder, shopBOrder], {
        orderKey: POSTING,
        shopId: 'shop-b',
        shopClientId: 'client-b',
      })
    ).toBe(shopBOrder);
    expect(
      findPurchasePluginCaptureOrder([shopAOrder, shopBOrder], {
        orderKey: POSTING,
        shopId: 'shop-b',
        shopClientId: 'client-a',
      })
    ).toBeNull();
  });
});
