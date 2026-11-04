import { describe, expect, it } from 'vitest';
import {
  getSmartToolOzonBrowserDataProfile,
  SMART_TOOL_OZON_BROWSER_DATA_PROFILES,
  usesActiveOzonProductQueryProfile,
} from './smartToolOzonBrowserDataProfiles.js';

describe('smartToolOzonBrowserDataProfiles', () => {
  it('gives every browser profile an explicit query mode', () => {
    expect(Object.values(SMART_TOOL_OZON_BROWSER_DATA_PROFILES).every((profile) => profile.queryMode)).toBe(true);
  });

  it('routes only browser-backed product tools into active product search', () => {
    expect(usesActiveOzonProductQueryProfile('ozon-product-search')).toBe(true);
    expect(usesActiveOzonProductQueryProfile('ozon-product-selection')).toBe(true);

    expect(usesActiveOzonProductQueryProfile('linkfox-seerfar-ozon-product-detail-search')).toBe(false);
    expect(usesActiveOzonProductQueryProfile('linkfox-seerfar-ozon-shop-search')).toBe(false);
    expect(usesActiveOzonProductQueryProfile('linkfox-seerfar-ozon-keyword-mining')).toBe(false);
    expect(usesActiveOzonProductQueryProfile('linkfox-seerfar-ozon-category-search')).toBe(false);
  });

  it('keeps paid API tools out of the shared background browser', () => {
    expect(Object.keys(SMART_TOOL_OZON_BROWSER_DATA_PROFILES).some((id) => id.includes('-seerfar-'))).toBe(false);
    expect(getSmartToolOzonBrowserDataProfile('ozon-ad-analyzer')).toBeNull();
  });

  it('accepts only the canonical product-performance dataset for every active product query profile', () => {
    for (const [toolId, profile] of Object.entries(SMART_TOOL_OZON_BROWSER_DATA_PROFILES)) {
      if (!usesActiveOzonProductQueryProfile(toolId)) continue;
      expect(profile.datasets, toolId).toEqual(['product-performance']);
      expect(getSmartToolOzonBrowserDataProfile(toolId)).toBe(profile);
    }
  });
});
