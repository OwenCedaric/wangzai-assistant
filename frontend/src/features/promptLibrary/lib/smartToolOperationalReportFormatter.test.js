import { describe, expect, it } from 'vitest';
import { buildOperationalReportSections } from './smartToolOperationalReportFormatter.js';

function flatten(sections) {
  return sections.flatMap((item) => item.rows).join('\n');
}

describe('smartToolOperationalReportFormatter', () => {
  it('使用真实业务字段展开销售、商品、费用、售后和营销明细', () => {
    const rows = flatten(buildOperationalReportSections({
      overview: { metrics: [{ label: '订单数', value: 8, unit: 'count', status: 'confirmed' }] },
      sales: {
        metrics: [],
        trend: [{ date: '2026-08-01', orderCount: 2, effectiveOrderCount: 1, cancelledOrderCount: 1, itemCount: 3, sales: { value: 99, currency: 'CNY' } }],
        statusBreakdown: [{ key: '已送达', count: 6 }],
        productRanking: [{ rank: 1, name: '遥控汽车', offerId: 'car-1', sku: '40001', quantity: 5, orderCount: 4, sales: { value: 280, currency: 'CNY' } }],
      },
      products: {
        metrics: [],
        visibilityBreakdown: [{ key: 'TO_SUPPLY', count: 27 }],
        categoryBreakdown: [{ category: '玩具 > 遥控玩具', count: 18 }],
        priceBands: [{ id: '20-50', label: '20–50', min: 20, max: 50, count: 9, currency: 'CNY' }],
        stockRiskRows: [{ name: '遥控汽车', offerId: 'car-1', sku: '40001', stock: 0, visibility: 'TO_SUPPLY' }],
        replenishmentRanking: [{ name: '遥控汽车', offerId: 'car-1', sku: '40001', stock: 0, quantity: 5, sales: { value: 280, currency: 'CNY' } }],
      },
      finance: {
        metrics: [],
        operationBreakdown: [{ code: 'OperationAgentDeliveredToCustomer', count: 65, amount: { value: 2192.47, currency: 'CNY' } }],
        largestDeductions: [{ operationId: '57047350051', postingNumber: '0199113584-0102-1', operationType: 'SetOffNonResident', operationDate: '2026-07-15 00:00:00', amount: -476.59, currency: 'CNY' }],
      },
      afterSales: {
        metrics: [],
        statusBreakdown: [{ key: '已退款', count: 4 }],
        reasonCodeBreakdown: [{ reasonId: '578', reasonLabel: '买家收货时拒收：商品不合适', count: 5, isDefect: false }],
        recentRows: [{ returnId: '98262584', postingNumber: '0199113584-0102-1', status: 'MoneyReturned', createdAt: '2026-07-23T10:00:00.000Z', productName: '遥控汽车', offerId: 'car-1', sku: '40001', amount: 37, currency: 'CNY' }],
      },
      marketing: {
        metrics: [],
        activityTypeBreakdown: [{ key: 'ELASTIC_BOOSTING', count: 1 }],
        activityRows: [{ activityId: '1977747', title: '夏季促销', startDate: '2026-07-01', endDate: '2026-08-31', active: true, joinedCount: 33, availableCount: 8, cachedProductCount: 33, actionType: 'ELASTIC_BOOSTING' }],
        productRows: [{ activityId: '1977747', productId: '4460375004', offerId: 'car-1', sku: '40001', name: '遥控汽车', rowStatus: '已添加', price: 226.12, activityPrice: 113.06, discountAmount: 113.06, currency: 'CNY', stock: 0 }],
      },
    }));

    expect(rows).toContain('遥控汽车｜商家货号 car-1｜商品编码 40001');
    expect(rows).toContain('待销售｜数量 27个商品');
    expect(rows).toContain('商品送达结算｜发生 65笔｜合计 ￥2,192.47');
    expect(rows).toContain('订单 0199113584-0102-1｜扣费金额 ￥-476.59｜流水号 57047350051');
    expect(rows).toContain('买家收货时拒收：商品不合适｜数量 5单｜原因编号 578｜非质量问题');
    expect(rows).toContain('售后编号 98262584');
    expect(rows).toContain('夏季促销｜进行中｜2026-07-01 至 2026-08-31');
    expect(rows).toContain('原价 ￥226.12｜活动价 ￥113.06｜优惠 ￥113.06');
    expect(rows).not.toMatch(/第 \d+ 项/u);
  });

  it('真实名称缺失时保留业务编号并说明缺少哪个字段', () => {
    const rows = flatten(buildOperationalReportSections({
      finance: {
        operationBreakdown: [{ count: 2, amount: { value: -10, currency: 'CNY' } }],
        largestDeductions: [{ operationId: 'fee-1', amount: -10, currency: 'CNY' }],
      },
      products: {
        stockRiskRows: [{ offerId: 'offer-1', stock: 0 }],
      },
      marketing: {
        activityRows: [{ activityId: 'activity-1', joinedCount: 1 }],
      },
    }));

    expect(rows).toContain('费用类型未返回');
    expect(rows).toContain('商品名称未返回（商品标识 offer-1）');
    expect(rows).toContain('活动名称未返回（活动编号 activity-1）');
    expect(rows).not.toMatch(/第 \d+ 项/u);
  });
});
