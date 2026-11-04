import { describe, expect, it } from 'vitest';
import {
  mergePromotionCampaignSnapshot,
  mergePromotionDetailRead,
  mergePromotionSummary,
} from './paidPromotionOverviewMerge.js';

describe('paid promotion overview detail merge', () => {
  it('keeps independently completed object and bid reads', () => {
    expect(
      mergePromotionDetailRead(
        { products: true, objects: true, bidInsights: false, finishedAt: 'old' },
        { products: true, objects: false, bidInsights: true, finishedAt: 'new' }
      )
    ).toEqual({ products: true, objects: true, bidInsights: true, finishedAt: 'new' });
  });

  it('uses a returned empty product list as authoritative instead of restoring removed products', () => {
    const merged = mergePromotionCampaignSnapshot(
      { id: '1', products: [{ sku: 'old' }], objects: [], detailRead: { products: true } },
      { id: '1', products: [], objects: [], detailRead: { products: true } }
    );
    expect(merged.products).toEqual([]);
    expect(merged.productCount).toBe(0);
  });

  it('does not let a skipped object read erase an earlier object result', () => {
    const merged = mergePromotionCampaignSnapshot(
      {
        id: '1',
        objects: [{ objectId: 'o1', clicks: 7 }],
        detailRead: { objects: true },
        detailAvailability: { objects: { status: 'success' } },
      },
      {
        id: '1',
        objects: [],
        detailRead: { objects: false, bidInsights: true },
        detailAvailability: { bidInsights: { status: 'empty' } },
      }
    );
    expect(merged.objects).toEqual([{ objectId: 'o1', clicks: 7 }]);
    expect(merged.detailRead.objects).toBe(true);
    expect(merged.detailRead.bidInsights).toBe(true);
    expect(merged.detailAvailability).toEqual({
      objects: { status: 'success' },
      bidInsights: { status: 'empty' },
    });
  });

  it('keeps a verified metric when a later partial response omits it but accepts real zero', () => {
    const omitted = mergePromotionCampaignSnapshot(
      {
        id: '1',
        products: [{ sku: 's1', clicks: 8, spent: 4 }],
        detailRead: { products: true },
      },
      {
        id: '1',
        products: [{ sku: 's1', clicks: null, spent: null }],
        detailRead: { products: true },
      }
    );
    expect(omitted.products[0]).toMatchObject({ clicks: 8, spent: 4 });

    const zero = mergePromotionCampaignSnapshot(omitted, {
      id: '1',
      products: [{ sku: 's1', clicks: 0, spent: 0 }],
      detailRead: { products: true },
    });
    expect(zero.products[0]).toMatchObject({ clicks: 0, spent: 0 });
  });

  it('does not present a dashboard productCount zero as authoritative before the product catalog is read', () => {
    expect(
      mergePromotionSummary(
        { total: 39, productCount: 30 },
        { total: 40, productCount: 0 },
        { hasCompleteProductCatalog: true, productCount: 31 }
      )
    ).toMatchObject({ total: 40, productCount: 31 });

    expect(
      mergePromotionSummary(
        { total: 40, productCount: 31 },
        { total: 40, productCount: 0 },
        { hasCompleteProductCatalog: false }
      )
    ).toMatchObject({ total: 40, productCount: null, productCountState: 'unavailable' });

    expect(
      mergePromotionSummary(
        { total: 40, productCount: null },
        { total: 40, productCount: null },
        { hasCompleteProductCatalog: false, productCount: 1 }
      )
    ).toMatchObject({ total: 40, productCount: 1, productCountState: 'partial' });
  });

  it('keeps unknown product and object counts unavailable until Ozon returns an authoritative list', () => {
    const dashboard = mergePromotionCampaignSnapshot(
      { id: '1', productCount: null, objectCount: null, products: [], objects: [], detailRead: {} },
      { id: '1', productCount: null, objectCount: null, products: [], objects: [], detailRead: {} }
    );
    expect(dashboard.productCount).toBeNull();
    expect(dashboard.objectCount).toBeNull();

    const detail = mergePromotionCampaignSnapshot(dashboard, {
      id: '1',
      products: [],
      objects: [],
      detailRead: { products: true, objects: true },
    });
    expect(detail.productCount).toBe(0);
    expect(detail.objectCount).toBe(0);

    expect(
      mergePromotionSummary(
        { total: 1, productCount: 7, productCountState: 'complete' },
        { total: 1, productCount: null },
        { hasCompleteProductCatalog: true, productCount: 7 }
      )
    ).toMatchObject({ total: 1, productCount: 7, productCountState: 'complete' });
  });

  it('keeps an accurately returned or calculated budget when a later partial read omits it', () => {
    const merged = mergePromotionCampaignSnapshot(
      {
        id: '1',
        weeklyBudget: 100,
        budgetRemaining: 87.5,
        budgetRemainingSource: 'calculated',
        budgetRemainingPeriod: { kind: 'weekly', dateFrom: '2026-08-10', dateTo: '2026-08-12' },
        budgetStatus: '预算正常',
      },
      {
        id: '1',
        weeklyBudget: null,
        budgetRemaining: null,
        budgetRemainingSource: 'unavailable',
        budgetRemainingPeriod: null,
        budgetStatus: '未返回',
      }
    );

    expect(merged).toMatchObject({
      weeklyBudget: 100,
      budgetRemaining: 87.5,
      budgetRemainingSource: 'calculated',
      budgetRemainingPeriod: { kind: 'weekly', dateFrom: '2026-08-10', dateTo: '2026-08-12' },
      budgetStatus: '预算正常',
    });
  });
});
