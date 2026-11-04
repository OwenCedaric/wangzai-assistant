import { describe, expect, it } from 'vitest';

import { buildRetainedMarketingProductPoolResult } from './marketingProductPoolCache.js';

describe('buildRetainedMarketingProductPoolResult', () => {
  it('keeps Ozon activity totals when the visible cache contains only one product scope', () => {
    const result = buildRetainedMarketingProductPoolResult(
      Array.from({ length: 20 }, (_, index) => ({ id: `joined-${index}`, status: '已添加' })),
      { id: 'activity-1', count: 1387, available: 547, hasAvailableCount: true }
    );

    expect(result.products).toHaveLength(20);
    expect(result.joinedTotal).toBe(1387);
    expect(result.availableTotal).toBe(547);
  });

  it('keeps explicit zero totals and never truncates rows already present', () => {
    expect(buildRetainedMarketingProductPoolResult([], { count: 0, available: 0 })).toMatchObject({
      joinedTotal: 0,
      availableTotal: 0,
    });
    expect(
      buildRetainedMarketingProductPoolResult(
        [{ id: 'joined-1', status: '已添加' }, { id: 'available-1', status: '可添加' }],
        { count: 0, available: 0 }
      )
    ).toMatchObject({ joinedTotal: 1, availableTotal: 1 });
  });
});
