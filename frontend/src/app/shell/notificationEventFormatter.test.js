import { describe, expect, it } from 'vitest';
import {
  formatNotificationEvent,
  formatNotificationMoney,
  getNotificationDomainLabel,
} from './notificationEventFormatter.js';

describe('notificationEventFormatter', () => {
  it('explains an order shipment with the exact order and product', () => {
    const result = formatNotificationEvent({
      domain: 'orders',
      eventType: 'order_status_changed',
      postingNumber: '123456-0001-1',
      shopName: 'Ozon 1店',
      productName: '儿童保温杯',
      productSku: 'WZ-9988',
      productImage: 'https://cdn.example/product.webp',
      oldValue: { status: 'awaiting_deliver' },
      newValue: { status: 'delivering' },
    });

    expect(result.headline).toBe('订单 123456-0001-1 已发货');
    expect(result.change).toEqual({ label: '订单状态', oldText: '等待发货', newText: '已发货' });
    expect(result.product).toMatchObject({
      name: '儿童保温杯',
      sku: 'WZ-9988',
      image: 'https://cdn.example/product.webp',
    });
  });

  it('explains a completed refund with amount and reason', () => {
    const result = formatNotificationEvent({
      domain: 'returns',
      eventType: 'return_status_changed',
      postingNumber: '987654-0002-2',
      refundAmount: 85.6,
      refundReason: '商品损坏',
      currencyCode: 'CNY',
      oldValue: { refundStatus: '退款处理中' },
      newValue: { refundStatus: 'MoneyReturned' },
    });

    expect(result.headline).toBe('订单 987654-0002-2 已退款 ¥85.60');
    expect(result.change).toEqual({ label: '售后状态', oldText: '退款处理中', newText: '已退款' });
    expect(result.facts).toEqual([
      { label: '退款金额', value: '¥85.60' },
      { label: '退款原因', value: '商品损坏' },
    ]);
  });

  it('shows Ozon after-sales lifecycle states in Chinese', () => {
    const onWay = formatNotificationEvent({
      domain: 'returns',
      eventType: 'return_status_changed',
      postingNumber: '40788041-0308-2',
      oldValue: { status: 'OnWayToOzon' },
      newValue: { status: 'OnWayToOzon' },
    });
    const partiallyCompensated = formatNotificationEvent({
      domain: 'returns',
      eventType: 'return_status_changed',
      postingNumber: '67185500-0317-1',
      oldValue: { status: 'PartialCompensationReturned' },
      newValue: { status: 'PartialCompensationReturned' },
    });
    const unknownForeignStatus = formatNotificationEvent({
      domain: 'returns',
      eventType: 'return_status_changed',
      postingNumber: 'unknown-status',
      newValue: { status: 'Неизвестный статус' },
    });

    expect(onWay.headline).toBe('订单 40788041-0308-2 售后状态变为“退货运输至 Ozon 中”');
    expect(onWay.change).toEqual({
      label: '售后状态',
      oldText: '退货运输至 Ozon 中',
      newText: '退货运输至 Ozon 中',
    });
    expect(partiallyCompensated.headline).toBe('订单 67185500-0317-1 售后状态变为“已向买家部分补偿”');
    expect(partiallyCompensated.change).toEqual({
      label: '售后状态',
      oldText: '已向买家部分补偿',
      newText: '已向买家部分补偿',
    });
    expect(unknownForeignStatus.change.newText).toBe('Ozon 返回的其他售后状态');
  });

  it('shows every order status and status summary in Chinese', () => {
    const paid = formatNotificationEvent({
      domain: 'orders',
      eventType: 'order_status_changed',
      postingNumber: '0209527587-0009',
      oldValue: { status: 'order_payment_pending' },
      newValue: { status: 'order_paid' },
      summary: '订单 0209527587-0009：订单状态已变化，当前状态 order_paid',
    });
    const verified = formatNotificationEvent({
      domain: 'orders',
      eventType: 'order_status_changed',
      postingNumber: '0209527587-0009',
      oldValue: { status: 'order_paid' },
      newValue: { status: 'order_verified' },
      summary: '订单 0209527587-0009：订单状态已变化，当前状态 order_verified',
    });
    const pickup = formatNotificationEvent({
      domain: 'orders',
      eventType: 'order_status_changed',
      postingNumber: '0159598469-0173-1',
      oldValue: { status: 'delivering' },
      newValue: { status: 'posting_in_pickup_point' },
    });
    const unknown = formatNotificationEvent({
      domain: 'orders',
      eventType: 'order_status_changed',
      postingNumber: 'UNKNOWN-1',
      newValue: { status: 'new_platform_status' },
      summary: 'current status new_platform_status',
    });

    expect(paid.headline).toBe('订单 0209527587-0009 状态变为“买家已付款”');
    expect(paid.change).toEqual({ label: '订单状态', oldText: '等待付款', newText: '买家已付款' });
    expect(paid.facts).toEqual([
      { label: '说明', value: '订单 0209527587-0009：订单状态已变化，当前状态 买家已付款' },
    ]);
    expect(verified.headline).toBe('订单 0209527587-0009 状态变为“订单已确认”');
    expect(verified.change).toEqual({ label: '订单状态', oldText: '买家已付款', newText: '订单已确认' });
    expect(verified.facts[0].value).not.toMatch(/order_/iu);
    expect(pickup.change.newText).toBe('已到提货点');
    expect(unknown.headline).toBe('订单 UNKNOWN-1 状态变为“Ozon 返回的其他订单状态”');
    expect(unknown.facts).toEqual([
      { label: '说明', value: '订单状态已更新为“Ozon 返回的其他订单状态”' },
    ]);
  });

  it('shows product and after-sales status codes in Chinese or a Chinese fallback', () => {
    const product = formatNotificationEvent({
      domain: 'products',
      eventType: 'product_status_changed',
      offerId: 'WZ-1002',
      oldValue: { visibility: 'TO_SUPPLY' },
      newValue: { visibility: 'VALIDATION_STATE_FAIL' },
    });
    const clarification = formatNotificationEvent({
      domain: 'returns',
      eventType: 'return_status_changed',
      postingNumber: 'RETURN-1',
      oldValue: { status: 'OfferedPartialCompensation' },
      newValue: { status: 'OnSellerClarificationAfterPartialCompensation' },
    });
    const invalidRefundText = formatNotificationEvent({
      domain: 'returns',
      eventType: 'return_status_changed',
      postingNumber: 'RETURN-2',
      oldValue: { refundStatus: '���', status: 'OnWayToOzon' },
      newValue: { refundStatus: '���', status: 'MoneyReturned' },
    });

    expect(product.change).toEqual({ label: '商品状态', oldText: '待补货', newText: '审核未通过' });
    expect(clarification.change).toEqual({
      label: '售后状态',
      oldText: '已提出部分补偿方案',
      newText: '部分补偿后等待卖家说明',
    });
    expect(invalidRefundText.change).toEqual({
      label: '售后状态',
      oldText: '退货运输至 Ozon 中',
      newText: '已退款',
    });
  });

  it('shows actual product price, stock and delisting changes', () => {
    const price = formatNotificationEvent({
      domain: 'products',
      eventType: 'product_price_changed',
      offerId: 'WZ-1001',
      oldValue: { name: '硅胶冰格', priceValue: 399, currencyCode: 'RUB' },
      newValue: {
        name: '硅胶冰格',
        priceValue: 349,
        currencyCode: 'RUB',
        primaryImageUrl: 'https://cdn.example/ice.webp',
      },
    });
    const stock = formatNotificationEvent({
      domain: 'products',
      eventType: 'product_stock_zero',
      offerId: 'WZ-1001',
      oldValue: { name: '硅胶冰格', stockValue: 12 },
      newValue: { name: '硅胶冰格', stockValue: 0 },
    });
    const status = formatNotificationEvent({
      domain: 'products',
      eventType: 'product_status_changed',
      offerId: 'WZ-1001',
      oldValue: { name: '硅胶冰格', visibility: 'VISIBLE' },
      newValue: { name: '硅胶冰格', visibility: 'NOT_FOR_SALE' },
    });

    expect(price.headline).toBe('商品“硅胶冰格”销售价已调整');
    expect(price.change).toEqual({ label: '销售价', oldText: '₽399.00', newText: '₽349.00' });
    expect(price.product.image).toBe('https://cdn.example/ice.webp');
    expect(stock.headline).toBe('商品“硅胶冰格”库存已降到 0');
    expect(stock.change).toEqual({ label: '库存', oldText: '12件', newText: '0件' });
    expect(status.headline).toBe('商品“硅胶冰格”已下架');
    expect(status.change).toEqual({ label: '商品状态', oldText: '销售中', newText: '已下架' });
  });

  it('keeps currency and category wording explicit', () => {
    expect(formatNotificationMoney('123.5', 'USD')).toBe('$123.50');
    expect(formatNotificationMoney('₽499', 'RUB')).toBe('₽499');
    expect(getNotificationDomainLabel('orders', '订单信息')).toBe('订单进度');
  });

  it('explains push-backed cancellation and buyer-message events in plain Chinese', () => {
    const cancelled = formatNotificationEvent({
      domain: 'orders',
      eventType: 'order_cancelled',
      postingNumber: '778899-0001-1',
      summary: '订单已取消',
    });
    const chat = formatNotificationEvent({
      domain: 'customer',
      eventType: 'chat_message_new',
      title: '买家新消息',
      summary: '会话 123：收到买家新消息',
    });

    expect(cancelled.headline).toBe('订单 778899-0001-1 已取消');
    expect(chat.headline).toBe('买家新消息');
    expect(getNotificationDomainLabel('customer')).toBe('买家消息');
  });
});
