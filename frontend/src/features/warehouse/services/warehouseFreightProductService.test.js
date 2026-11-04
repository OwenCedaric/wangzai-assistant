import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getRubCnyRealtimeRate: vi.fn(),
}));

vi.mock('../../../api/localApiClient.js', () => ({
  getRubCnyRealtimeRate: api.getRubCnyRealtimeRate,
}));

vi.mock('../../../entities/product/productOzonApi.jsx', () => ({
  requestOzonProductAttributes: vi.fn(),
  requestOzonProductDetails: vi.fn(),
  requestOzonProductPrices: vi.fn(),
}));

import { requestWarehouseFreightRubCnyRate } from './warehouseFreightProductService.js';

describe('warehouse freight realtime exchange rate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the current realtime RUB/CNY response', async () => {
    api.getRubCnyRealtimeRate.mockResolvedValue({
      ok: true,
      mode: 'realtime',
      rubToCnyRate: 0.080608,
      source: 'exchange-rate-api-open',
      fetchedAt: '2026-08-21T10:00:00.000Z',
    });

    await expect(requestWarehouseFreightRubCnyRate()).resolves.toEqual({
      rubToCnyRate: 0.080608,
      source: 'exchange-rate-api-open',
      fetchedAt: '2026-08-21T10:00:00.000Z',
    });
  });

  it('rejects a daily fallback so it cannot masquerade as the realtime rate', async () => {
    api.getRubCnyRealtimeRate.mockResolvedValue({
      ok: true,
      mode: 'daily-nearest',
      rubToCnyRate: 0.0799,
    });

    await expect(requestWarehouseFreightRubCnyRate()).rejects.toThrow('当日实时 RUB/CNY 汇率未返回');
  });
});
