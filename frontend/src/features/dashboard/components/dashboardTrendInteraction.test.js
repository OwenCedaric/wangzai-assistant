import { describe, expect, it } from 'vitest';

import { resolveDashboardTrendHover } from './dashboardTrendInteraction.js';

describe('resolveDashboardTrendHover', () => {
  const rect = { left: 420, width: 702 };

  it('maps the real visual plot bounds to the nearest time node', () => {
    expect(resolveDashboardTrendHover({ clientX: 420, rect, pointCount: 13 })).toEqual({ index: 0, ratio: 0 });
    expect(resolveDashboardTrendHover({ clientX: 1066, rect, pointCount: 13 })).toEqual({ index: 11, ratio: 11 / 12 });
    expect(resolveDashboardTrendHover({ clientX: 1122, rect, pointCount: 13 })).toEqual({ index: 12, ratio: 1 });
  });

  it('keeps pointer values outside the plot inside the valid node range', () => {
    expect(resolveDashboardTrendHover({ clientX: 0, rect, pointCount: 13 })).toEqual({ index: 0, ratio: 0 });
    expect(resolveDashboardTrendHover({ clientX: 9999, rect, pointCount: 13 })).toEqual({ index: 12, ratio: 1 });
  });

  it('returns null when the visual plot cannot be measured', () => {
    expect(resolveDashboardTrendHover({ clientX: 500, rect: { left: 0, width: 0 }, pointCount: 13 })).toBeNull();
  });
});
