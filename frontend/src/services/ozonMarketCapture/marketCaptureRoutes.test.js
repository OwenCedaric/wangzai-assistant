import { describe, expect, it } from 'vitest';
import {
  OZON_MARKET_CAPTURE_ROUTES,
  OZON_MARKET_PAGINATION_POLICIES,
  OZON_MARKET_REFRESH_BUDGET_MS,
} from './marketCaptureRoutes.js';

describe('Ozon market capture routes', () => {
  it('keeps a paginable direct keyword probe when the seller page request shape drifts', () => {
    const route = OZON_MARKET_CAPTURE_ROUTES.find((item) => item.id === 'all-queries');
    expect(route).toMatchObject({ preferProbe: true, datasets: ['keywords'] });
    expect(route.probes).toContainEqual(expect.objectContaining({
      path: '/api/site/searchteam/Stats/queries/search/v2',
      method: 'POST',
      body: expect.objectContaining({ limit: '50', offset: '0' }),
    }));
  });

  it('does not fake pagination for complete graph snapshots', () => {
    expect(OZON_MARKET_CAPTURE_ROUTES.find((item) => item.id === 'graphs')).toMatchObject({
      pagination: false,
    });
  });

  it('fully paginates the audited missing-items route', () => {
    expect(OZON_MARKET_CAPTURE_ROUTES.find((item) => item.id === 'market-bestsellers')).toMatchObject({
      preferProbe: true,
      paginationMode: 'complete',
    });
  });

  it('fully paginates cursor-backed lists and does not replay snapshot-only routes', () => {
    for (const routeId of ['all-queries', 'ozon-bestsellers', 'market-bestsellers']) {
      expect(OZON_MARKET_CAPTURE_ROUTES.find((item) => item.id === routeId)).toMatchObject({
        paginationMode: 'complete',
      });
    }
    for (const routeId of ['all-bestsellers', 'graphs']) {
      expect(OZON_MARKET_CAPTURE_ROUTES.find((item) => item.id === routeId)).toMatchObject({
        pagination: false,
      });
    }
  });

  it('uses bounded native page batches inside the shared refresh budget', () => {
    expect(OZON_MARKET_REFRESH_BUDGET_MS).toBe(20 * 60_000);
    expect(Object.values(OZON_MARKET_PAGINATION_POLICIES)
      .every((policy) => policy.batchPages === 5)).toBe(true);
  });
});
