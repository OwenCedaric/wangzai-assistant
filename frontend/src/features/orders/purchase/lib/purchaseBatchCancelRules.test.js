import { describe, expect, it } from 'vitest';
import {
  getCancellablePurchaseOrders,
  getPurchaseBatchCancelEligibility,
  getPurchaseBatchCancelKey,
  intersectPurchaseCancelReasons,
  intersectPurchaseBatchCancelReasons,
  isPurchaseBatchCancelOrderEligible,
  partitionPurchaseBatchCancelOrders,
  preparePurchaseBatchCancelOrders,
  resolveStrictPurchaseOrderShop,
  resolvePurchaseBatchCancelShop,
} from './purchaseBatchCancelRules';

function availableShop(overrides = {}) {
  return {
    id: 'shop-1',
    clientId: 'client-1',
    shopAlias: 'Ozon 1店',
    hasClientId: true,
    hasApiKey: true,
    ...overrides,
  };
}

function cancellableOrder(overrides = {}) {
  return {
    id: 'posting-1',
    status: '待拍单',
    fulfillment: 'FBS',
    shopId: 'shop-1',
    shopClientId: 'client-1',
    ...overrides,
  };
}

describe('purchase batch cancel eligibility', () => {
  it.each(['待拍单', '已拍单-待预报', '已拍单-待发货', '已拍单-未操作', '已拍单-售后单'])(
    'allows the existing single-order cancel status %s',
    (status) => {
      expect(isPurchaseBatchCancelOrderEligible(cancellableOrder({ status }))).toBe(true);
    }
  );

  it('also accepts an active raw Ozon status when the purchase status is absent', () => {
    expect(isPurchaseBatchCancelOrderEligible(cancellableOrder({ status: '', ozonRawStatus: 'awaiting_packaging' }))).toBe(
      true
    );
  });

  it('excludes FBO, shipped/closed terminal states, and locked split parents', () => {
    expect(getPurchaseBatchCancelEligibility(cancellableOrder({ fulfillment: 'FBO' })).code).toBe('fbo_order');
    expect(getPurchaseBatchCancelEligibility(cancellableOrder({ status: '已拍单-已发货' })).code).toBe(
      'terminal_status'
    );
    expect(getPurchaseBatchCancelEligibility(cancellableOrder({ status: '完结单' })).code).toBe('terminal_status');
    expect(getPurchaseBatchCancelEligibility(cancellableOrder({ status: '关闭单' })).code).toBe('terminal_status');
    expect(
      getPurchaseBatchCancelEligibility(
        cancellableOrder({ splitRole: 'parent', splitBusinessLocked: true, splitRelation: { parentOzonVisible: false } })
      ).code
    ).toBe('split_parent_locked');
  });

  it('lets an unlocked split parent and a split child follow the normal status rule', () => {
    expect(
      isPurchaseBatchCancelOrderEligible(
        cancellableOrder({ splitRole: 'parent', splitBusinessLocked: false, splitRelation: { parentOzonVisible: true } })
      )
    ).toBe(true);
    expect(isPurchaseBatchCancelOrderEligible(cancellableOrder({ splitRole: 'child' }))).toBe(true);
  });

  it('lets terminal Ozon truth override an otherwise cancellable purchase status', () => {
    const result = getPurchaseBatchCancelEligibility(cancellableOrder({ status: '已拍单-待发货', ozonRawStatus: 'delivered' }));
    expect(result).toMatchObject({ eligible: false, code: 'terminal_status', status: 'delivered' });
  });

  it('partitions eligible and excluded rows without changing order', () => {
    const eligible = cancellableOrder({ id: 'eligible' });
    const excluded = cancellableOrder({ id: 'excluded', status: '关闭单' });
    expect(partitionPurchaseBatchCancelOrders([eligible, excluded])).toMatchObject({
      eligibleOrders: [eligible],
      eligibleCount: 1,
      excludedCount: 1,
    });
    expect(getCancellablePurchaseOrders([eligible, excluded])).toEqual([eligible]);
    expect(getPurchaseBatchCancelKey(eligible)).toBe('shop-1::eligible');
    expect(getPurchaseBatchCancelKey(null)).toBe('');
  });
});

describe('purchase batch cancel strict shop resolution', () => {
  const shop1 = availableShop();
  const shop2 = availableShop({ id: 'shop-2', clientId: 'client-2', shopAlias: 'Ozon 2店' });

  it('requires all supplied strong identities to match the same shop', () => {
    expect(resolvePurchaseBatchCancelShop(cancellableOrder(), [shop1, shop2])).toMatchObject({
      ok: true,
      shop: shop1,
      matchedBy: 'strong-identity',
    });
    expect(resolveStrictPurchaseOrderShop(cancellableOrder(), [shop1, shop2])).toMatchObject({
      ok: true,
      shop: shop1,
    });
    expect(
      resolvePurchaseBatchCancelShop(cancellableOrder({ shopId: 'shop-1', shopClientId: '', clientId: 'client-1' }), [
        shop1,
        shop2,
      ])
    ).toMatchObject({ ok: true, shop: shop1 });
  });

  it('rejects conflicting shopClientId/clientId values inside the order', () => {
    const result = resolvePurchaseBatchCancelShop(
      cancellableOrder({ shopClientId: 'client-1', clientId: 'client-2' }),
      [shop1, shop2]
    );
    expect(result).toMatchObject({ ok: false, code: 'order_shop_identity_conflict' });
  });

  it('rejects a shopId and clientId that point to different shops', () => {
    const result = resolvePurchaseBatchCancelShop(
      cancellableOrder({ shopId: 'shop-1', shopClientId: 'client-2' }),
      [shop1, shop2]
    );
    expect(result).toMatchObject({ ok: false, code: 'order_shop_identity_conflict' });
  });

  it('never falls back when a strong identity is missing or unavailable', () => {
    expect(
      resolvePurchaseBatchCancelShop(cancellableOrder({ shopId: 'missing', shopClientId: '' }), [shop1])
    ).toMatchObject({ ok: false, code: 'shop_not_found' });
    expect(
      resolvePurchaseBatchCancelShop(cancellableOrder(), [{ ...shop1, hasApiKey: false }, shop2])
    ).toMatchObject({ ok: false, code: 'shop_unavailable' });
  });

  it('allows a unique exact label only when no strong identity exists', () => {
    const order = cancellableOrder({ shopId: '', shopClientId: '', clientId: '', shop: 'Ozon 2店' });
    expect(resolvePurchaseBatchCancelShop(order, [shop1, shop2])).toMatchObject({
      ok: true,
      shop: shop2,
      matchedBy: 'unique-label',
    });
  });

  it('rejects duplicate or mismatched weak labels instead of guessing', () => {
    const duplicate = availableShop({ id: 'shop-3', clientId: 'client-3', shopAlias: 'Ozon 1店' });
    const order = cancellableOrder({ shopId: '', shopClientId: '', clientId: '', shop: 'Ozon 1店' });
    expect(resolvePurchaseBatchCancelShop(order, [shop1, duplicate])).toMatchObject({
      ok: false,
      code: 'shop_ambiguous',
    });
    expect(resolvePurchaseBatchCancelShop({ ...order, shop: '不存在店铺' }, [shop1])).toMatchObject({
      ok: false,
      code: 'shop_label_not_found',
    });
  });

  it('uses the only available shop only when the order has no identity or label', () => {
    const order = cancellableOrder({ shopId: '', shopClientId: '', clientId: '', shop: '', shopName: '' });
    expect(resolvePurchaseBatchCancelShop(order, [shop1])).toMatchObject({
      ok: true,
      shop: shop1,
      matchedBy: 'only-available-shop',
    });
    expect(resolvePurchaseBatchCancelShop(order, [shop1, shop2])).toMatchObject({
      ok: false,
      code: 'shop_ambiguous',
    });
  });

  it('prepares only rows that pass both eligibility and strict shop resolution', () => {
    const ready = cancellableOrder({ id: 'ready' });
    const closed = cancellableOrder({ id: 'closed', status: '关闭单' });
    const missingShop = cancellableOrder({ id: 'missing', shopId: 'missing', shopClientId: '' });
    expect(preparePurchaseBatchCancelOrders([ready, closed, missingShop], [shop1])).toMatchObject({
      readyCount: 1,
      excludedCount: 2,
      shopCount: 1,
      readyOrders: [{ order: ready, shop: shop1 }],
    });
  });
});

describe('purchase batch cancel reason intersection', () => {
  it('keeps only common ids in first-list order and preserves the first rawLabel', () => {
    const first = [
      { id: '3', label: '原因三', rawLabel: 'raw-three', marker: 'first' },
      { id: '1', label: '原因一', rawLabel: 'raw-one' },
      { id: '2', label: '原因二', rawLabel: 'raw-two' },
    ];
    const result = intersectPurchaseBatchCancelReasons([
      first,
      [
        { id: 1, rawLabel: 'other-one' },
        { id: 3, rawLabel: 'other-three' },
      ],
      [
        { reason_id: '3' },
        { reason_id: '1' },
      ],
    ]);
    expect(result.map((item) => item.id)).toEqual(['3', '1']);
    expect(result[0]).toMatchObject({ rawLabel: 'raw-three', marker: 'first' });
    expect(result[1].rawLabel).toBe('raw-one');
    expect(intersectPurchaseCancelReasons([first, [{ id: '1' }]])).toMatchObject([{ id: '1', rawLabel: 'raw-one' }]);
  });

  it('deduplicates the first list and accepts Map/object collections', () => {
    const lists = new Map([
      ['shop-1', [{ id: '1', rawLabel: 'first' }, { id: 1, rawLabel: 'duplicate' }, { id: '2' }]],
      ['shop-2', [{ cancel_reason_id: '1' }]],
    ]);
    expect(intersectPurchaseBatchCancelReasons(lists)).toEqual([{ id: '1', rawLabel: 'first' }]);
    expect(
      intersectPurchaseBatchCancelReasons({ first: [{ id: '2', rawLabel: 'two' }], second: [{ id: 2 }] })
    ).toEqual([{ id: '2', rawLabel: 'two' }]);
  });

  it('returns an empty intersection for no shops, an empty shop list, or no common ids', () => {
    expect(intersectPurchaseBatchCancelReasons([])).toEqual([]);
    expect(intersectPurchaseBatchCancelReasons([[{ id: '1' }], []])).toEqual([]);
    expect(intersectPurchaseBatchCancelReasons([[{ id: '1' }], [{ id: '2' }]])).toEqual([]);
  });
});
