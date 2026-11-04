import { describe, expect, it } from 'vitest';

import source from './useMarketingProductPoolState.jsx?raw';
import listStateSource from './useMarketingActivityListState.jsx?raw';

describe('marketing first-entry auto-read rules', () => {
  it('waits for SQLite restoration, then starts exactly one local-first read for a new configured shop', () => {
    expect(listStateSource).toContain('const [isMarketingCacheRestoring, setIsMarketingCacheRestoring] = React.useState(true);');
    expect(listStateSource).toContain('setIsMarketingCacheRestoring(false)');
    expect(source).toContain('if (!isActive || isMarketingCacheRestoring || hasLiveActivityData || isReadingActivities) return;');
    expect(source).toContain('if (!canUseOzonShop(selectedShop)) return;');
    expect(source).toContain("if (!shopKey || autoReadShopKeyRef.current === shopKey) return;");
    expect(source).toContain('autoReadActivitiesRef.current?.(selectedShop, { keepExisting: false });');
  });

  it('restores the selected activity product pool independently from the lightweight page snapshot', () => {
    expect(source).toContain('autoReadProductPoolKeyRef');
    expect(source).toContain('productPool.length > 0');
    expect(source).toContain('cacheOnly: true');
    expect(source).toContain('cacheTimeoutMs: 15_000');
    expect(source).toContain('营销活动首屏商品池恢复失败');
  });
});
