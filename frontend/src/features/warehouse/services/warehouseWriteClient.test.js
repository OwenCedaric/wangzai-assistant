import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ preview: vi.fn(), confirm: vi.fn(), requestOzon: vi.fn() }));

vi.mock('../../../api/localApiClient.js', () => ({
  LocalApiError: class LocalApiError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.code = options.code;
      this.payload = options.payload;
    }
  },
  previewDomainWrite: api.preview,
  confirmDomainWrite: api.confirm,
  requestLocalOzon: api.requestOzon,
}));

import {
  getDeliveryMethodWriteEndpoint,
  isPausedRfbsWarehouse,
  isRfbsWarehouse,
  requestWarehouseWriteOperation,
  requestWarehouseReferenceData,
} from './warehouseWriteClient.js';

describe('warehouse write client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.preview.mockResolvedValue({ ok: true, previewId: 'preview-1' });
    api.confirm.mockResolvedValue({ ok: true, writeStatus: 'readback_merged', message: '完成' });
    api.requestOzon.mockResolvedValue({ points: [{ id: 'point-1' }] });
  });

  it('uses one preview-confirm transaction and requests a real logistics write', async () => {
    const result = await requestWarehouseWriteOperation({
      shopId: 'shop-a',
      action: 'warehouse.rfbs.pause',
      endpointKey: 'warehouse.rfbsPause',
      payload: { warehouse_id: 1020005007227510 },
    });
    expect(result.message).toBe('完成');
    expect(api.preview).toHaveBeenCalledWith('logistics', expect.objectContaining({
      shopId: 'shop-a', action: 'warehouse.rfbs.pause', endpointKey: 'warehouse.rfbsPause',
    }), {});
    expect(api.confirm).toHaveBeenCalledWith('logistics', expect.objectContaining({
      previewId: 'preview-1', confirm: true, realWrite: true, dryRun: false,
    }), {});
  });

  it('selects current rFBS and delivery-method variants from real response fields', () => {
    expect(isRfbsWarehouse({ raw: { is_rfbs: true } })).toBe(true);
    expect(isPausedRfbsWarehouse({ raw: { pause_at: '2026-08-28T00:00:00Z' } })).toBe(true);
    expect(getDeliveryMethodWriteEndpoint({ raw: { tpl_integration_type: 'aggregator' } }))
      .toBe('warehouse.erfbsAggregatorDeliveryMethodUpdate');
    expect(getDeliveryMethodWriteEndpoint({ raw: { tpl_integration_type: 'non_integrated' } }))
      .toBe('warehouse.erfbsNonIntegratedDeliveryMethodUpdate');
  });

  it('reads FBS creation reference data through the registered read endpoint', async () => {
    const result = await requestWarehouseReferenceData({
      shop: { id: 'shop-a' },
      endpoint: '/v1/warehouse/fbs/create/drop-off/list',
      body: { country_code: 'CN', is_kgt: false },
    });
    expect(result.points).toHaveLength(1);
    expect(api.requestOzon).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/v1/warehouse/fbs/create/drop-off/list',
      access: 'read',
      shop: { id: 'shop-a' },
    }), {});
  });
});
