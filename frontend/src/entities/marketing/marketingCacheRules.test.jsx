import { describe, expect, it } from 'vitest';
import { countJoinedMarketingActivities } from './marketingCacheRules.jsx';

describe('marketing activity cache rules', () => {
  it('counts joined activities from visible activity rows instead of stale summary totals', () => {
    const activities = [
      { id: 'boost', title: '弹性提升', count: 33 },
      { id: 'discount', title: '大幅折扣', count: '2' },
      { id: 'school', title: '学校活动', count: 0 },
      { id: 'discount', title: '大幅折扣', count: 2 },
    ];

    expect(countJoinedMarketingActivities(activities)).toBe(2);
  });

  it('keeps official and seller activities with the same id in separate summary buckets', () => {
    expect(
      countJoinedMarketingActivities([
        { id: 'same-id', sourceType: 'official', count: 1 },
        { id: 'same-id', sourceType: 'seller', count: 1 },
      ])
    ).toBe(2);
  });
});
