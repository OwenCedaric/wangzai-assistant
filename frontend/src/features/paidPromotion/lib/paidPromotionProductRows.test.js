import { describe, expect, it } from 'vitest';

import {
  formatPromotionCampaignAssignment,
  getPromotionProductKey,
  mergePromotionProductRows,
  sumOptionalPromotionMetric,
} from './paidPromotionProductRows.js';

describe('付费推广全店商品聚合', () => {
  it('uses namespaced product identities and never drops an identifier-less returned row', () => {
    expect(getPromotionProductKey({ sku: '1001', productId: '2001' })).toBe('sku:1001');
    expect(getPromotionProductKey({ productId: '2001', offerId: 'A-1' })).toBe('product:2001');
    expect(getPromotionProductKey({ offerId: 'A-1' })).toBe('offer:A-1');
    expect(getPromotionProductKey({}, 'campaign-1:0')).toBe('fallback:campaign-1:0');
  });

  it('merges the same SKU across campaigns and preserves plan ownership', () => {
    const rows = mergePromotionProductRows([
      {
        id: '1',
        title: '计划一',
        products: [{ sku: '1001', title: '商品 A', status: 'active', statusLabel: '运行中', clicks: 2, spent: 10 }],
      },
      {
        id: '2',
        title: '计划二',
        products: [{ sku: '1001', title: '商品 A', status: 'paused', statusLabel: '已暂停', clicks: 3, spent: 15 }],
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sku: '1001',
      clicks: 5,
      spent: 25,
      campaignIds: ['1', '2'],
      campaignTitles: ['计划一', '计划二'],
      campaignCount: 2,
      statusLabel: '多计划状态',
    });
    expect(formatPromotionCampaignAssignment(rows[0])).toBe('计划一、计划二');
  });

  it('keeps missing metrics missing while preserving a real returned zero', () => {
    expect(sumOptionalPromotionMetric(null, undefined, '')).toBeNull();
    expect(sumOptionalPromotionMetric(null, 0)).toBe(0);
    const [missing] = mergePromotionProductRows([{ id: '1', title: '计划一', products: [{ sku: 'missing' }] }]);
    const [zero] = mergePromotionProductRows([
      { id: '1', title: '计划一', products: [{ sku: 'zero', impressions: 0, clicks: 0, spent: 0, orders: 0, revenue: 0 }] },
    ]);
    expect(missing.spent).toBeUndefined();
    expect(missing.ctr).toBeNull();
    expect(zero).toMatchObject({ spent: 0, ctr: 0, cpc: 0, acos: 0 });
  });

  it('formats a compact plan summary without hiding the total ownership count', () => {
    expect(formatPromotionCampaignAssignment({ campaignTitles: ['计划一', '计划二', '计划三', '计划四'] })).toBe(
      '计划一、计划二 等 4 个计划'
    );
  });
});
