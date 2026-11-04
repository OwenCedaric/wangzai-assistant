import { describe, expect, it } from 'vitest';
import {
  getAfterSalesDetailView,
  translateAfterSalesDetailReason,
  translateAfterSalesDetailStatus,
} from './afterSalesDetailView.js';

describe('afterSalesDetailView', () => {
  it('turns Ozon return status and reason values into Chinese', () => {
    expect(translateAfterSalesDetailStatus('В пути')).toBe('运输中');
    expect(translateAfterSalesDetailStatus('MoneyReturned')).toBe('已退款给买家');
    expect(translateAfterSalesDetailReason('Товар закончился на складе')).toBe('仓库商品已售完');
  });

  it('builds a readable detail model and keeps buyer evidence photos', () => {
    const detail = getAfterSalesDetailView(
      { shop: 'Ozon 2店', raw: {} },
      {
        returnId: 107755240,
        actions: [],
        raw: {
          created_at: '2026-08-21T02:24:04.808Z',
          posting_number: '40788041-0308-2',
          state: { state: 'OnWayToOzon', state_name: 'В пути' },
          return_reason: { id: 352, name: 'Товар закончился на складе' },
          product: { name: '商品', offer_id: 'SKU-1', sku: 5317491569, price: 601, currency_code: 'CNY' },
          client_photo: [{ url: 'https://cdn.example.test/evidence.jpg' }],
        },
      }
    );

    expect(detail.fields).toEqual(expect.arrayContaining([
      ['售后申请号', '107755240'],
      ['货件号', '40788041-0308-2'],
      ['售后状态', '退货运输至 Ozon 中'],
      ['售后原因', '仓库商品已售完'],
    ]));
    expect(detail.product).toMatchObject({ offerId: 'SKU-1', sku: '5317491569', currency: 'CNY' });
    expect(detail.clientPhotos).toEqual(['https://cdn.example.test/evidence.jpg']);
  });

  it('uses the already translated Chinese reason for a new Ozon reason', () => {
    const detail = getAfterSalesDetailView(
      {
        reasonZh: '买家反馈包装破损',
        raw: { return_reason: { name: 'Новая причина Ozon' } },
      },
      null
    );

    expect(detail.fields).toContainEqual(['售后原因', '买家反馈包装破损']);
  });
});
