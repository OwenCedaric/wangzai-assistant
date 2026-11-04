import { afterEach, describe, expect, it } from 'vitest';
import {
  clearOzonOrderSupplementCache,
  clearOzonOrderSupplementCacheForRows,
  createOzonAfterSalesChangeNotifications,
  createOzonOrderChangeNotifications,
  getOzonAfterSalesReasonRawText,
  getOzonAfterSalesReasonText,
  getOzonOrderExperienceKey,
  getOzonProductPictureLookupId,
  translateOzonAfterSalesReasonToChinese,
  mergeOzonAfterSalesCachedRows,
  normalizeOzonImageUrlsForPreload,
  readOzonOrderSupplementCache,
  readOzonOrderSupplementCacheRows,
  writeOzonOrderSupplementCache,
  writeOzonOrderSupplementCacheRows,
} from './ozonOrderExperience.js';

describe('ozonOrderExperience', () => {
  afterEach(() => {
    clearOzonOrderSupplementCache();
  });

  it('creates stable keys that keep shops separated', () => {
    expect(getOzonOrderExperienceKey({ recordKey: 'shop-a:posting-1' })).toBe('');
    expect(getOzonOrderExperienceKey({ shopId: 'shop-a', recordKey: 'shop-a:posting-1' })).toBe('shop-a:posting-1');
    expect(getOzonOrderExperienceKey({ shopId: 'shop-a', posting: 'posting-1' })).toBe('shop-a:posting-1');
    expect(getOzonOrderExperienceKey({ shopId: 'shop-b', posting: 'posting-1' })).toBe('shop-b:posting-1');
    expect(getOzonOrderExperienceKey({ raw: { client_id: 'shop-c', posting_number: 'posting-2' } })).toBe(
      'shop-c:posting-2'
    );
  });

  it('extracts nested Ozon after-sales and cancellation reasons', () => {
    expect(
      getOzonAfterSalesReasonText({
        detail: {
          cancellation: {
            cancel_reason: {
              id: 12,
              name: '您没有按时发送商品',
            },
          },
        },
        products: [{ name: '不应该作为售后原因的商品标题' }],
      })
    ).toBe('您没有按时发送商品');

    expect(
      getOzonAfterSalesReasonText({
        return_reason: {
          message: 'Buyer refused the goods at delivery',
        },
      })
    ).toBe('买家交付时拒收');
  });

  it('does not use finance evidence wording as the visible after-sales reason', () => {
    expect(
      getOzonAfterSalesReasonText({
        return_reason: { name: '配送了错误的商品' },
        reason: '财务流水已出现签收销售和退款扣款证据；已同时核查母单 75064957-0486',
        financeRefundEvidence: {
          reason: '财务流水已出现签收销售和退款扣款证据',
        },
      })
    ).toBe('配送了错误的商品');
  });

  it('lets fresh Ozon rFBS detail reason replace cached finance fallback wording', () => {
    const rows = mergeOzonAfterSalesCachedRows(
      [
        {
          id: '90652048',
          returnId: '90652048',
          shopClientId: '4616153',
          salesOrder: '75064957-0486-1',
          status: '签收后退款',
          type: '签收后退款',
          reason: '财务流水已出现签收销售和退款扣款证据；已同时核查母单 75064957-0486',
          financeRefundChecked: true,
          financeRefundConfirmed: true,
          financeRefundEvidence: {
            checked: true,
            confirmed: true,
            signedRefundConfirmed: true,
            reason: '财务流水已出现签收销售和退款扣款证据；已同时核查母单 75064957-0486',
          },
          raw: {
            return_id: '90652048',
            posting_number: '75064957-0486-1',
          },
        },
      ],
      [
        {
          id: '90652048',
          returnId: '90652048',
          shopClientId: '4616153',
          salesOrder: '75064957-0486-1',
          status: '签收后退款',
          type: '签收后退款',
          reason: '配送了错误的商品',
          return_reason: { id: 22, name: 'Привезли не тот товар' },
          raw: {
            return_id: '90652048',
            posting_number: '75064957-0486-1',
            return_reason: { id: 22, name: 'Привезли не тот товар' },
          },
        },
      ]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: '90652048',
      salesOrder: '75064957-0486-1',
      reason: '配送了错误的商品',
    });
  });

  it('does not use product titles as after-sales reasons', () => {
    expect(
      getOzonAfterSalesReasonText({
        reason: { id: 42 },
        products: [{ name: 'Product title only' }],
      })
    ).toBe('');
  });

  it('translates Ozon Russian after-sales reasons before returning them', () => {
    expect(
      getOzonAfterSalesReasonText({
        originalOrderCancellation: {
          cancel_reason: 'Покупатель отказался при вручении: товар не подошел',
        },
      })
    ).toBe('买家交付时拒收：商品不合适');

    expect(
      getOzonAfterSalesReasonText({
        originalOrderCancellation: {
          cancel_reason: 'Вы не отгрузили заказ вовремя',
        },
      })
    ).toBe('您未按时发货');

    expect(translateOzonAfterSalesReasonToChinese('Покупатель не забрал заказ')).toBe('买家未取件');
    expect(translateOzonAfterSalesReasonToChinese('Вы не отгрузили заказ вовремя')).toBe('您未按时发货');
    expect(translateOzonAfterSalesReasonToChinese('Утилизирован Ozon')).toBe('Ozon 已处置/销毁');
    expect(translateOzonAfterSalesReasonToChinese('Привезли не тот товар')).toBe('配送了错误的商品');
    expect(translateOzonAfterSalesReasonToChinese('Отправление не прошло таможенное оформление')).toBe(
      '货件未通过清关'
    );
    expect(translateOzonAfterSalesReasonToChinese('Проверка товара на соответствие описанию в карточке')).toBe(
      'Ozon 检查商品是否符合商品卡描述'
    );
    expect(translateOzonAfterSalesReasonToChinese('UtilizedByOzon')).toBe('Ozon 已处置/销毁');
    expect(translateOzonAfterSalesReasonToChinese('Неизвестная причина')).toBe('Неизвестная причина');
    expect(translateOzonAfterSalesReasonToChinese('Unknown Ozon return reason')).toBe('Unknown Ozon return reason');
  });

  it('prefers the complete Ozon return reason over an older generic label', () => {
    const source = {
      reason: '买家拒收',
      raw: {
        return_reason: {
          name: 'Покупатель отказался при вручении: недоволен качеством товара',
        },
      },
    };

    expect(getOzonAfterSalesReasonRawText(source)).toBe(
      'Покупатель отказался при вручении: недоволен качеством товара'
    );
    expect(getOzonAfterSalesReasonText(source)).toBe('买家交付时拒收：对商品质量不满意');
  });

  it('uses Ozon cancellation reason id when the text is missing or generic', () => {
    expect(
      getOzonAfterSalesReasonText({
        originalOrderCancellation: {
          cancel_reason_id: 940,
        },
      })
    ).toBe('货件未通过清关');

    expect(
      getOzonAfterSalesReasonText({
        cancellation: {
          cancel_reason_id: 992,
        },
      })
    ).toBe('Ozon 检查商品是否符合商品卡描述');
  });

  it('uses the stable Ozon reason id before a garbled localized reason name', () => {
    expect(
      getOzonAfterSalesReasonText({
        return_reason: {
          id: 587,
          name: '妤把快志抑扮快扶我快 我扶忱快抗扼忘',
        },
      })
    ).toBe('买家拒收：对商品质量不满意');
  });

  it('caches only compact supplement fields and expires by ttl', () => {
    const row = {
      shopId: 'shop-a',
      recordKey: 'shop-a:posting-1',
      status: 'awaiting_packaging',
      raw: { rawMarker: 'should-not-cache' },
      products: [
        {
          offerId: 'offer-1',
          name: 'A product',
          image: 'https://cdn.example/a.jpg',
          images: ['https://cdn.example/a.jpg', ''],
          raw: { large: 'should-not-cache' },
        },
      ],
      commissionAmount: 12.3,
      commissionSource: 'finance',
    };

    expect(writeOzonOrderSupplementCache(row, { now: 1000 })).toBe(true);

    const cached = readOzonOrderSupplementCache(
      { shopId: 'shop-a', recordKey: 'shop-a:posting-1' },
      { now: 1500, ttlMs: 1000 }
    );
    expect(cached).toEqual({
      shopId: 'shop-a',
      recordKey: 'shop-a:posting-1',
      commissionAmount: 12.3,
      commissionSource: 'finance',
      products: [
        {
          offerId: 'offer-1',
          name: 'A product',
          image: 'https://cdn.example/a.jpg',
          images: ['https://cdn.example/a.jpg'],
        },
      ],
    });

    expect(
      readOzonOrderSupplementCache({ shopId: 'shop-a', recordKey: 'shop-a:posting-1' }, { now: 2501, ttlMs: 1000 })
    ).toBeNull();
  });

  it('reads multiple cached supplements and can invalidate visible rows for manual refresh', () => {
    const rows = [
      {
        shopId: 'shop-a',
        recordKey: 'shop-a:posting-1',
        products: [{ offerId: 'a', image: 'https://cdn.example/a.jpg' }],
      },
      {
        shopId: 'shop-a',
        recordKey: 'shop-a:posting-2',
        products: [{ offerId: 'b', image: 'https://cdn.example/b.jpg' }],
      },
    ];

    expect(writeOzonOrderSupplementCacheRows(rows, { now: 1000 })).toBe(2);
    expect(readOzonOrderSupplementCacheRows(rows, { now: 1001 })).toHaveLength(2);
    expect(clearOzonOrderSupplementCacheForRows([rows[0]])).toBe(1);
    expect(readOzonOrderSupplementCacheRows(rows, { now: 1002 })).toEqual([
      {
        shopId: 'shop-a',
        recordKey: 'shop-a:posting-2',
        products: [{ offerId: 'b', image: 'https://cdn.example/b.jpg' }],
      },
    ]);
  });

  it('normalizes image preload urls without storing invalid or duplicate values', () => {
    expect(
      normalizeOzonImageUrlsForPreload(
        [
          '',
          'https://cdn.example/a.jpg',
          'https://cdn.example/a.jpg',
          'http://cdn.example/b.jpg',
          'data:image/png;base64,abc',
          'file:///tmp/a.jpg',
          'https://cdn.example/c.jpg',
        ],
        { limit: 2 }
      )
    ).toEqual(['https://cdn.example/a.jpg', 'http://cdn.example/b.jpg']);
  });

  it('uses order raw numeric product ids as picture lookup candidates', () => {
    expect(getOzonProductPictureLookupId({ productIdSource: 'orderRaw', productId: '4312160700' })).toBe(4312160700);
    expect(getOzonProductPictureLookupId({ productIdSource: 'unknown', productId: '4312160700' })).toBeNull();
    expect(getOzonProductPictureLookupId({ productIdSource: 'orderRaw', productId: '未返回' })).toBeNull();
  });

  it('creates notifications for new orders, status changes, and refund-like changes', () => {
    const previous = [
      { shopId: 'shop-a', recordKey: 'shop-a:posting-1', posting: 'posting-1', status: 'awaiting_packaging' },
      { shopId: 'shop-a', recordKey: 'shop-a:posting-2', posting: 'posting-2', status: 'delivered' },
      {
        shopId: 'shop-a',
        recordKey: 'shop-a:posting-3',
        posting: 'posting-3',
        status: 'delivered',
        refundStatus: '',
      },
    ];
    const next = [
      {
        shopId: 'shop-a',
        shopName: 'Ozon 1店',
        recordKey: 'shop-a:posting-1',
        posting: 'posting-1',
        status: 'awaiting_deliver',
        products: [
          {
            name: '儿童保温杯',
            offerId: 'WZ-9988',
            productId: '778899',
            image: 'https://cdn.example/product.webp',
          },
        ],
      },
      { shopId: 'shop-a', recordKey: 'shop-a:posting-2', posting: 'posting-2', status: 'cancelled' },
      {
        shopId: 'shop-a',
        recordKey: 'shop-a:posting-3',
        posting: 'posting-3',
        status: 'delivered',
        refundStatus: '退款申请中',
      },
      { shopId: 'shop-a', recordKey: 'shop-a:posting-4', posting: 'posting-4', status: 'awaiting_packaging' },
    ];

    const notifications = createOzonOrderChangeNotifications(previous, next, {
      createdAt: '2026-06-23T00:00:00.000Z',
    });

    expect(notifications.map((notification) => notification.type)).toEqual([
      'status_change',
      'refund_or_after_sale',
      'refund_or_after_sale',
      'new_order',
    ]);
    expect(notifications.map((notification) => notification.title)).toEqual([
      '订单状态变化',
      '订单售后/退款变化',
      '订单售后/退款变化',
      '新订单',
    ]);
    expect(notifications[0]).toMatchObject({
      postingNumber: 'posting-1',
      shopName: 'Ozon 1店',
      productName: '儿童保温杯',
      productSku: 'WZ-9988',
      productId: '778899',
      productImage: 'https://cdn.example/product.webp',
      oldValue: { status: 'awaiting_packaging' },
      newValue: { status: 'awaiting_deliver' },
    });
  });

  it('creates after-sales notifications without colliding with order notifications', () => {
    const previous = [{ shopId: 'shop-a', recordKey: 'shop-a:return-1', id: 'return-1', status: '发货后取消' }];
    const next = [
      { shopId: 'shop-a', recordKey: 'shop-a:return-1', id: 'return-1', status: '拒收后退款' },
      { shopId: 'shop-a', recordKey: 'shop-a:return-2', id: 'return-2', status: '发货后取消' },
    ];

    const notifications = createOzonAfterSalesChangeNotifications(previous, next, {
      createdAt: '2026-06-24T00:00:00.000Z',
    });

    expect(notifications.map((notification) => notification.id)).toEqual([
      'after-sales:refund:shop-a:return-1:发货后取消:拒收后退款',
      'after-sales:new:shop-a:return-2',
    ]);
    expect(notifications.map((notification) => notification.title)).toEqual(['售后状态变化', '新增售后/退款']);
    expect(notifications.map((notification) => notification.domain)).toEqual(['returns', 'returns']);
    expect(notifications.map((notification) => notification.eventType)).toEqual([
      'return_status_changed',
      'return_created',
    ]);
    expect(notifications[1].message).toContain('有新的售后/退款记录');
  });

  it('merges after-sales cache without downgrading confirmed refused refunds', () => {
    const cachedRows = [
      {
        id: 'return-1',
        shop: 'Ozon 1店',
        salesOrder: 'posting-1',
        status: '拒收后退款',
        type: '拒收后退款',
        tone: 'success',
        reason: '买家在交货时拒收',
        logistics: '商品已销毁',
        refusedEvidence: 'buyer refused delivery',
        destroyedEvidence: 'item destroyed',
        products: [{ offerId: 'offer-1', image: 'https://cdn.example/a.jpg' }],
      },
    ];
    const freshRows = [
      {
        id: 'return-1',
        shop: 'Ozon 1店',
        salesOrder: 'posting-1',
        status: '发货后取消',
        type: '发货后取消',
        tone: 'error',
        reason: '未返回',
        logistics: '未返回',
        products: [{ offerId: 'offer-1', image: '' }],
      },
      {
        id: 'return-2',
        shop: 'Ozon 1店',
        salesOrder: 'posting-2',
        status: '发货后取消',
        products: [{ offerId: 'offer-2' }],
      },
    ];

    const rows = mergeOzonAfterSalesCachedRows(cachedRows, freshRows);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'return-1',
      status: '拒收后退款',
      type: '拒收后退款',
      tone: 'success',
      reason: '买家在交货时拒收',
      logistics: '商品已销毁',
      refusedEvidence: 'buyer refused delivery',
      destroyedEvidence: 'item destroyed',
    });
    expect(rows[0].products[0].image).toBe('https://cdn.example/a.jpg');
    expect(rows[1]).toMatchObject({ id: 'return-2', status: '发货后取消' });
  });

  it('does not merge cancelled child postings that only share a mother posting', () => {
    const rows = mergeOzonAfterSalesCachedRows(
      [],
      [
        {
          source: 'order-cancelled',
          clientId: '4616153',
          recordKey: 'posting:67006620-0050-1',
          id: 'posting:67006620-0050-1',
          salesOrder: '67006620-0050-1',
          status: '发货前取消',
        },
        {
          source: 'order-cancelled',
          clientId: '4616153',
          recordKey: 'posting:67006620-0050-2',
          id: 'posting:67006620-0050-2',
          salesOrder: '67006620-0050-2',
          status: '发货前取消',
        },
      ]
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.salesOrder)).toEqual(['67006620-0050-1', '67006620-0050-2']);
  });

  it('keeps detailed after-sales classification when a later lightweight row has no evidence', () => {
    const rows = mergeOzonAfterSalesCachedRows(
      [
        {
          id: 'return-1',
          shop: 'Ozon 1店',
          salesOrder: 'posting-1',
          status: '发货前取消',
          type: '发货前取消',
          tone: 'warning',
          blockedEvidence: 'seller did not ship on time',
          products: [{ offerId: 'offer-1', image: 'https://cdn.example/a.jpg' }],
        },
      ],
      [
        {
          id: 'return-1',
          shop: 'Ozon 1店',
          salesOrder: 'posting-1',
          status: '发货后取消',
          type: '发货后取消',
          tone: 'error',
          products: [{ offerId: 'offer-1', image: '' }],
        },
      ]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: '发货前取消',
      type: '发货前取消',
      tone: 'warning',
      blockedEvidence: 'seller did not ship on time',
    });
    expect(rows[0].products[0].image).toBe('https://cdn.example/a.jpg');
  });

  it('merges legacy shop-name after-sales entities by return id and base posting without downgrading strong evidence', () => {
    const refusedRefund = '\u62d2\u6536\u540e\u9000\u6b3e';
    const afterShipCancel = '\u53d1\u8d27\u540e\u53d6\u6d88';
    const rows = mergeOzonAfterSalesCachedRows(
      [
        {
          recordKey: 'Ozon 1店:87750614',
          shop: 'Ozon 1店',
          id: '87750614',
          returnId: '87750614',
          salesOrder: '88181594-0239-2',
          status: refusedRefund,
          type: refusedRefund,
          tone: 'success',
          classificationVersion: 6,
          classificationConfidence: 90,
          refusedEvidence: 'buyer refused delivery',
          destroyedEvidence: 'item disposed',
          financeRefundChecked: true,
          financeRefundConfirmed: true,
          financeRefundEvidence: { checked: true, confirmed: true, reason: 'base posting chargeback closed' },
          raw: {
            return_id: '87750614',
            posting_number: '88181594-0239-2',
            refusedEvidence: 'buyer refused delivery',
          },
          products: [{ offerId: 'mz-26050101-000001', image: 'https://cdn.example/strong.jpg' }],
        },
      ],
      [
        {
          recordKey: 'SuperBaiss:87750614',
          shop: 'SuperBaiss',
          id: '87750614',
          returnId: '87750614',
          salesOrder: '88181594-0239-2',
          status: afterShipCancel,
          type: afterShipCancel,
          tone: 'error',
          classificationVersion: 6,
          classificationConfidence: 65,
          refusedEvidence: '',
          destroyedEvidence: 'item disposed',
          financeRefundChecked: true,
          financeRefundConfirmed: false,
          financeRefundEvidence: { checked: true, confirmed: false },
          raw: {
            return_id: '87750614',
            posting_number: '88181594-0239-2',
            destroyedEvidence: 'item disposed',
          },
          products: [{ offerId: 'mz-26050101-000001', image: '' }],
        },
      ]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: '87750614',
      salesOrder: '88181594-0239-2',
      status: refusedRefund,
      type: refusedRefund,
      refusedEvidence: 'buyer refused delivery',
      destroyedEvidence: 'item disposed',
      financeRefundChecked: true,
      financeRefundConfirmed: true,
    });
    expect(rows[0].financeRefundEvidence).toMatchObject({ checked: true, confirmed: true });
    expect(rows[0].raw).toMatchObject({
      return_id: '87750614',
      posting_number: '88181594-0239-2',
      refusedEvidence: 'buyer refused delivery',
      destroyedEvidence: 'item disposed',
    });
    expect(rows[0].products[0].image).toBe('https://cdn.example/strong.jpg');
  });

  it('lets versioned after-sales classifications replace older cached refund labels', () => {
    const rows = mergeOzonAfterSalesCachedRows(
      [
        {
          id: 'return-1',
          shop: 'Ozon 1店',
          salesOrder: '09869141-0270-1',
          status: '签收后退款',
          type: '签收后退款',
          refusedEvidence: 'buyer refused delivery',
          destroyedEvidence: 'item destroyed',
          products: [{ offerId: 'offer-1', image: 'https://cdn.example/a.jpg' }],
        },
      ],
      [
        {
          id: 'return-1',
          shop: 'Ozon 1店',
          salesOrder: '09869141-0270-1',
          status: '拒收后退款',
          type: '拒收后退款',
          tone: 'success',
          classificationVersion: 2,
          classificationConfidence: 85,
          classificationReason: '命中拒收/拒签或商品销毁/处置证据，按拒收后退款损失处理',
          refusedEvidence: 'buyer refused delivery',
          shippedEvidence: 'handover',
          products: [{ offerId: 'offer-1', image: '' }],
        },
      ]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: '拒收后退款',
      type: '拒收后退款',
      classificationVersion: 2,
      classificationConfidence: 85,
      refusedEvidence: 'buyer refused delivery',
      shippedEvidence: 'handover',
    });
    expect(rows[0].products[0].image).toBe('https://cdn.example/a.jpg');
  });

  it('lets fresh Ozon cancelled evidence correct stale signed-refund after-sales cache', () => {
    const rows = mergeOzonAfterSalesCachedRows(
      [
        {
          id: '86777870',
          returnId: '86777870',
          shopClientId: '4616153',
          salesOrder: '49225228-0329-1',
          status: '签收后退款',
          type: '签收后退款',
          tone: 'error',
          classificationVersion: 8,
          classificationConfidence: 98,
          classificationReason: '旧缓存误把收单费冲正当成签收后退款',
          originalOrderCancelledEvidence: 'cancelled_after_ship',
          originalOrderDeliveredEvidence: '',
          financeRefundChecked: true,
          financeRefundConfirmed: true,
          financeRefundEvidence: {
            checked: true,
            confirmed: true,
            reason: '旧缓存把 MarketplaceRedistributionOfAcquiringOperation 当成退款闭环',
          },
          products: [{ offerId: 'mz-26051410-231198', image: 'https://cdn.example/first-aid.jpg' }],
        },
      ],
      [
        {
          id: '86777870',
          returnId: '86777870',
          shopClientId: '4616153',
          salesOrder: '49225228-0329-1',
          status: '发货后取消',
          type: '发货后取消',
          tone: 'error',
          classificationVersion: 9,
          classificationConfidence: 85,
          classificationReason: 'Ozon 订单已取消且没有签收证据，按发货后取消处理',
          originalOrderCancelledEvidence: 'cancelled_after_ship',
          originalOrderDeliveredEvidence: '',
          financeRefundChecked: true,
          financeRefundConfirmed: false,
          financeRefundEvidence: {
            checked: true,
            confirmed: false,
            reason: '财务流水未确认退款/冲正闭环',
          },
          products: [{ offerId: 'mz-26051410-231198', image: '' }],
        },
      ]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      salesOrder: '49225228-0329-1',
      status: '发货后取消',
      type: '发货后取消',
      financeRefundChecked: true,
      financeRefundConfirmed: false,
      originalOrderDeliveredEvidence: '',
    });
    expect(rows[0].products[0].image).toBe('https://cdn.example/first-aid.jpg');
  });

  it('does not preserve stale signed-refund cache when fresh row is not signed refund', () => {
    const rows = mergeOzonAfterSalesCachedRows(
      [
        {
          id: 'stale-signed-refund',
          shop: 'Ozon 1店',
          salesOrder: '49225228-0329-1',
          status: '签收后退款',
          type: '签收后退款',
          tone: 'error',
          classificationVersion: 8,
          financeRefundChecked: true,
          financeRefundConfirmed: true,
          financeRefundEvidence: {
            checked: true,
            confirmed: true,
            signedRefundConfirmed: true,
          },
          originalOrderDeliveredEvidence: 'delivered',
          products: [{ offerId: 'offer-a', image: 'https://cdn.example/a.jpg' }],
        },
      ],
      [
        {
          id: 'stale-signed-refund',
          shop: 'Ozon 1店',
          salesOrder: '49225228-0329-1',
          status: '发货后取消',
          type: '发货后取消',
          tone: 'error',
          classificationVersion: 10,
          classificationConfidence: 90,
          classificationReason: 'Ozon 最新证据显示订单未签收，不按签收后退款处理',
          financeRefundChecked: true,
          financeRefundConfirmed: false,
          financeRefundEvidence: {
            checked: true,
            confirmed: false,
            signedRefundConfirmed: false,
          },
          originalOrderDeliveredEvidence: '',
          products: [{ offerId: 'offer-a', image: '' }],
        },
      ]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: '发货后取消',
      type: '发货后取消',
      classificationVersion: 10,
      financeRefundConfirmed: false,
    });
    expect(rows[0].financeRefundEvidence).toMatchObject({
      checked: true,
      confirmed: false,
      signedRefundConfirmed: false,
    });
    expect(rows[0].products[0].image).toBe('https://cdn.example/a.jpg');
  });

  it('lets v3 delivered evidence replace older refused-after-refund cache labels', () => {
    const rows = mergeOzonAfterSalesCachedRows(
      [
        {
          id: '88421705',
          shop: 'Ozon 1店',
          salesOrder: '09869141-0270-1',
          status: '拒收后退款',
          type: '拒收后退款',
          tone: 'success',
          classificationVersion: 2,
          classificationConfidence: 90,
          refusedEvidence: 'buyer refused handover',
          destroyedEvidence: 'UtilizingByOzon',
          products: [{ offerId: 'mz-26050513-463952', image: 'https://cdn.example/earplug.jpg' }],
        },
      ],
      [
        {
          id: '88421705',
          shop: 'Ozon 1店',
          salesOrder: '09869141-0270-1',
          status: '发货后取消',
          type: '发货后取消',
          tone: 'error',
          classificationVersion: 3,
          classificationConfidence: 95,
          classificationReason: '原订单已签收，不满足拒收后退款的已取消条件',
          excludeFromAfterSales: true,
          refusedEvidence: 'buyer refused handover',
          destroyedEvidence: 'UtilizingByOzon',
          originalOrderDeliveredEvidence: 'delivered_at',
          products: [{ offerId: 'mz-26050513-463952', image: '' }],
        },
      ]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: '发货后取消',
      type: '发货后取消',
      classificationVersion: 3,
      classificationConfidence: 95,
      excludeFromAfterSales: true,
      originalOrderDeliveredEvidence: 'delivered_at',
    });
    expect(rows[0].products[0].image).toBe('https://cdn.example/earplug.jpg');
  });

  it('lets newer after-sales evidence clear stale delivered evidence', () => {
    const rows = mergeOzonAfterSalesCachedRows(
      [
        {
          id: '80603326',
          shop: 'Ozon 1店',
          salesOrder: '38652143-0161-1',
          status: '发货后取消',
          type: '发货后取消',
          tone: 'error',
          classificationVersion: 3,
          classificationConfidence: 65,
          originalOrderDeliveredEvidence: 'вручен',
          products: [{ offerId: 'mz-26050813-905658', image: 'https://cdn.example/bushing.jpg' }],
        },
      ],
      [
        {
          id: '80603326',
          shop: 'Ozon 1店',
          salesOrder: '38652143-0161-1',
          status: '拒收后退款',
          type: '拒收后退款',
          tone: 'success',
          classificationVersion: 4,
          classificationConfidence: 90,
          classificationReason: 'confirmed refused destroyed refund',
          refusedEvidence: 'buyer refused delivery',
          destroyedEvidence: 'Utilized',
          originalOrderCancelledEvidence: 'cancelled_after_ship',
          originalOrderDeliveredEvidence: '',
          products: [{ offerId: 'mz-26050813-905658', image: '' }],
        },
      ]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: '拒收后退款',
      type: '拒收后退款',
      classificationVersion: 4,
      classificationConfidence: 90,
      originalOrderCancelledEvidence: 'cancelled_after_ship',
      originalOrderDeliveredEvidence: '',
    });
    expect(rows[0].products[0].image).toBe('https://cdn.example/bushing.jpg');
  });

  it('keeps direct CNY after-sales product amounts when later image supplements contain RUB-derived prices', () => {
    const rows = mergeOzonAfterSalesCachedRows(
      [
        {
          id: 'return-1',
          salesOrder: 'posting-1',
          products: [
            {
              offerId: 'offer-1',
              price: '¥40.00',
              priceValue: 40,
              currencyCode: 'CNY',
              sourceCurrencyCode: 'CNY',
            },
          ],
        },
      ],
      [
        {
          id: 'return-1',
          salesOrder: 'posting-1',
          products: [
            {
              offerId: 'offer-1',
              image: 'https://cdn.example/a.jpg',
              price: '¥3.79',
              priceValue: 3.79,
              currencyCode: 'CNY',
              sourceCurrencyCode: 'RUB',
            },
          ],
        },
      ]
    );

    expect(rows[0].products[0]).toMatchObject({
      offerId: 'offer-1',
      image: 'https://cdn.example/a.jpg',
      price: '¥40.00',
      priceValue: 40,
      currencyCode: 'CNY',
      sourceCurrencyCode: 'CNY',
    });
  });

  it('replaces an unmarked cached CNY amount with a fresh Ozon refund amount converted from RUB', () => {
    const rows = mergeOzonAfterSalesCachedRows(
      [
        {
          id: 'return-1',
          salesOrder: 'posting-1',
          products: [
            {
              offerId: 'offer-1',
              price: 'CNY 40.00',
              priceValue: 40,
              currencyCode: 'CNY',
              sourceCurrencyCode: 'CNY',
            },
          ],
        },
      ],
      [
        {
          id: 'return-1',
          salesOrder: 'posting-1',
          products: [
            {
              offerId: 'offer-1',
              price: 'CNY 3.79',
              priceValue: 3.79,
              currencyCode: 'CNY',
              sourceCurrencyCode: 'RUB',
              sourcePriceValue: 40,
              afterSalesAmountSource: 'ozon-return-rub',
            },
          ],
        },
      ]
    );

    expect(rows[0].products[0]).toMatchObject({
      offerId: 'offer-1',
      price: 'CNY 3.79',
      priceValue: 3.79,
      currencyCode: 'CNY',
      sourceCurrencyCode: 'RUB',
      sourcePriceValue: 40,
      afterSalesAmountSource: 'ozon-return-rub',
    });
  });

  it('keeps the original Russian reason when the public DTO masks it during translation', () => {
    expect(
      getOzonAfterSalesReasonRawText({
        reason: '售后原因翻译中',
        return_reason: '售后原因翻译中',
        reasonRaw: 'Заказ утерян при доставке',
      })
    ).toBe('Заказ утерян при доставке');
  });

  it('recovers nested Ozon evidence when a repeated normalization copied the pending label into reasonRaw', () => {
    expect(
      getOzonAfterSalesReasonRawText({
        reason: '售后原因翻译中',
        reasonRaw: '售后原因翻译中',
        reason_raw: '售后原因翻译中',
        return_reason: '售后原因翻译中',
        raw: {
          return_reason: {
            id: 23,
            name: 'Нет части товара или комплекта',
          },
        },
      })
    ).toBe('Нет части товара или комплекта');
  });
});
