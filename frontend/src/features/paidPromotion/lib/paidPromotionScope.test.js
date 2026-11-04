import { describe, expect, it } from 'vitest';

import {
  ALL_PROMOTION_SCOPE,
  buildScopedPromotionOrderReport,
  filterPromotionRowsByCampaign,
  filterPromotionRowsByKeyword,
  filterPromotionRowsByProductScope,
  getPromotionProductScopeOptions,
} from './paidPromotionScope.js';

describe('paid promotion visible scope', () => {
  it('builds stable product options and filters objects by the selected product identity', () => {
    const products = [
      { sku: '100', offerId: 'WZ-100', title: '商品一' },
      { sku: '200', offerId: 'WZ-200', title: '商品二' },
    ];
    const objects = [
      { objectId: 'o-1', sku: '100', title: '对象一' },
      { objectId: 'o-2', sku: '200', title: '对象二' },
    ];
    const options = getPromotionProductScopeOptions(products, objects);

    expect(options.map((item) => item.key)).toEqual(['sku:100', 'sku:200']);
    expect(filterPromotionRowsByProductScope(objects, 'sku:200')).toEqual([objects[1]]);
    expect(filterPromotionRowsByProductScope(objects, ALL_PROMOTION_SCOPE)).toEqual(objects);
  });

  it('keeps report plan and product filters independent from other page state', () => {
    const rows = [
      { campaignId: '1', sku: '100', productTitle: '红色尾灯' },
      { campaignId: '2', sku: '200', productTitle: '蓝色尾灯' },
    ];
    expect(filterPromotionRowsByCampaign(rows, '2')).toEqual([rows[1]]);
    expect(filterPromotionRowsByKeyword(rows, '红色')).toEqual([rows[0]]);
    expect(filterPromotionRowsByKeyword(rows, '200')).toEqual([rows[1]]);
  });

  it('recalculates a selected plan order report instead of reusing whole-shop totals', () => {
    const report = {
      ok: true,
      complete: true,
      summary: { orderCount: 3, revenue: 500, spent: 50 },
    };
    const rows = [
      { orderId: 'o-1', campaignId: '1', quantity: 2, revenue: 160, spent: 10 },
      { orderId: 'o-2', campaignId: '2', quantity: 1, revenue: 340, spent: 40 },
    ];
    const scopedRows = filterPromotionRowsByCampaign(rows, '1');
    const scoped = buildScopedPromotionOrderReport(report, scopedRows, true);

    expect(scoped.summary).toEqual({ rowCount: 1, orderCount: 1, itemQuantity: 2, revenue: 160, spent: 10 });
    expect(buildScopedPromotionOrderReport(report, rows, false)).toBe(report);
  });
});
