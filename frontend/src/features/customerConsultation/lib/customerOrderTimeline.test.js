import {
  buildCustomerOrderTimeline,
  buildCustomerOzonProductUrl,
  resolveCustomerOrderContext,
  resolveCustomerProductContext,
} from './customerOrderTimeline.js';
import { describe, expect, it } from 'vitest';

describe('customer order timeline', () => {
  it('builds a public Ozon product page only from Ozon urls or numeric SKU ids', () => {
    expect(buildCustomerOzonProductUrl('4213816529')).toBe('https://www.ozon.ru/product/4213816529/');
    expect(buildCustomerOzonProductUrl('https://www.ozon.ru/product/4213816529/')).toBe(
      'https://www.ozon.ru/product/4213816529/'
    );
    expect(buildCustomerOzonProductUrl('WZ-CASE-118')).toBe('');
    expect(buildCustomerOzonProductUrl('https://example.com/product/1')).toBe('');
  });

  it('prefers the matched SQLite order product and keeps the full posting number', () => {
    const conversation = {
      orderNumber: '59724481-0031-1',
      orderStatus: '待发货',
      productName: '旧商品名',
      sku: 'WZ-CASE-118',
    };
    const orderRow = {
      posting_number: '59724481-0031-1',
      status: 'awaiting_packaging',
      products: [
        {
          name: 'Ozon 回读商品',
          offer_id: 'seller-offer-1',
          sku: 4213816529,
          primary_image: 'https://ir.ozone.ru/a.jpg',
        },
      ],
    };

    expect(resolveCustomerOrderContext(conversation, orderRow)).toEqual({
      orderNumber: '59724481-0031-1',
      orderStatus: '等待备货',
    });
    expect(resolveCustomerProductContext(conversation, orderRow)).toMatchObject({
      name: 'Ozon 回读商品',
      sku: '4213816529',
      offerId: 'seller-offer-1',
      href: 'https://www.ozon.ru/product/4213816529/',
    });
  });

  it('sorts exact timestamps from order cache, status history and notifications without fabricating missing times', () => {
    const rows = buildCustomerOrderTimeline({
      conversation: {
        orderNumber: '59724481-0031-1',
        orderTimeline: [
          {
            id: 'forecast',
            type: 'forecasted',
            title: '完成订单预报',
            occurredAt: '2026-07-01T07:30:00.000Z',
          },
          { id: 'missing-time', type: 'shipment', title: '没有时间的节点' },
        ],
      },
      orderRow: {
        posting_number: '59724481-0031-1',
        in_process_at: '2026-07-01T07:00:00.000Z',
        shipment_date: '2026-07-02T07:00:00.000Z',
        raw: {
          status_history: [{ status: 'delivering', changed_at: '2026-07-01T09:00:00.000Z' }, { status: 'delivered' }],
        },
      },
      notifications: [
        {
          id: 'notification-1',
          postingNumber: '59724481-0031-1',
          eventType: 'delivery_update',
          title: '配送节点更新',
          summary: '包裹进入运输环节',
          createdAt: '2026-07-01T08:00:00.000Z',
        },
      ],
    });

    expect(rows.map((item) => item.title)).toEqual(['计划发货', '运输中', '配送节点更新', '完成订单预报', '买家下单']);
    expect(rows.some((item) => item.title === '没有时间的节点')).toBe(false);
    expect(rows.some((item) => item.title === '配送完成')).toBe(false);
    expect(rows[0]?.detail).toContain('不代表已经实际交付物流');
  });

  it('combines a base Ozon order with child postings, domestic purchase and logistics records', () => {
    const rows = buildCustomerOrderTimeline({
      conversation: {
        orderNumber: '75577421-0029',
        messages: [],
      },
      orderRows: [
        {
          posting_number: '75577421-0029-1',
          in_process_at: '2026-07-28T02:23:41.000Z',
          raw: { order_number: '75577421-0029' },
        },
      ],
      purchaseRows: [
        {
          id: 'purchase-1',
          purchasePlatform: '1688',
          purchaseOrderNumber: '1688-1001',
          updatedAt: '2026-07-28T03:00:00.000Z',
        },
      ],
      logisticsRows: [
        {
          recordId: 'logistics-1',
          purchaseOrderNumber: '1688-1001',
          trackingNumber: 'YT123456',
          warehouse: '义乌仓',
          routeName: '跨境巴士标准线',
          updatedAt: '2026-07-29T03:00:00.000Z',
        },
      ],
    });

    expect(rows.map((item) => item.title)).toEqual(['跨境物流路由', '国内快递已同步', '国内采购已关联', '买家下单']);
    expect(rows.find((item) => item.type === 'domestic_logistics')?.detail).toContain('YT123456');
  });
});
