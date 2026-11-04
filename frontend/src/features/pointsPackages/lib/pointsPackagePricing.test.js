import { describe, expect, it } from 'vitest';
import { estimatePackageLinks, formatMoney, formatPoints, getPointsPerLink } from './pointsPackagePricing.js';

describe('points package pricing', () => {
  it('uses customer-facing point rates without exposing upstream cost inputs', () => {
    expect(getPointsPerLink({ modelId: 'standard', imageCount: 16, includeRetryReserve: true })).toBe(1152);
    expect(getPointsPerLink({ modelId: 'standard', imageCount: 10, includeRetryReserve: false })).toBe(622);
  });

  it('estimates whole links from package points', () => {
    expect(estimatePackageLinks({ packagePoints: 10395, pointsPerLink: 1152 })).toBe(9);
    expect(estimatePackageLinks({ packagePoints: 52395, pointsPerLink: 1152 })).toBe(45);
  });

  it('formats customer-facing money and points', () => {
    expect(formatMoney(9.9)).toContain('9.90');
    expect(formatPoints(10395)).toBe('10,395');
  });
});
