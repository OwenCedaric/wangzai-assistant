import { describe, expect, it } from 'vitest';
import {
  marketKeywordPlatformMatches,
  parseSmartToolMarketKeywordItems,
} from './smartToolMarketKeywordQuery.js';

describe('smartToolMarketKeywordQuery', () => {
  it('parses the complete market-keyword Skill filter surface from plain Chinese rows', () => {
    expect(parseSmartToolMarketKeywordItems([
      '连衣裙',
      '日期：2026-04-01',
      '类目：15621031_200000933_93182',
      '搜索量>=10000',
      '卖家数<=50',
      '价格：1000~3000',
      '匹配：精准',
      '平台：Ozon',
      '排序：月搜增长降序',
    ])).toEqual({
      keywords: ['连衣裙'],
      categories: ['15621031_200000933_93182'],
      ranges: {
        searchVolume: { min: 10000 },
        sellers: { max: 50 },
        price: { min: 1000, max: 3000 },
      },
      searchDate: '2026-04-01',
      matchType: 0,
      platformFilter: [0],
      order: { field: 'count30GrowthRate', direction: 'DESC' },
    });
  });

  it('expands the blue-ocean preset without turning it into a keyword', () => {
    expect(parseSmartToolMarketKeywordItems(['蓝海词'])).toMatchObject({
      keywords: [],
      ranges: { searchVolume: { min: 10000 }, sellers: { max: 50 } },
      order: { field: 'searchVolume', direction: 'DESC' },
    });
  });

  it('applies the platform filter client-side because the API has no platform input', () => {
    expect(marketKeywordPlatformMatches({ platform: 0 }, [0])).toBe(true);
    expect(marketKeywordPlatformMatches({ platform: 1 }, [0])).toBe(false);
    expect(marketKeywordPlatformMatches({ platform: 1 }, [])).toBe(true);
  });
});
