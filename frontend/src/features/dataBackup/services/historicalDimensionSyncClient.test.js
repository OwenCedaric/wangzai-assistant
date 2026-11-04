import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestLocalApi = vi.hoisted(() => vi.fn());
vi.mock('../../../api/localApiClient.js', () => ({ requestLocalApi }));

import {
  confirmHistoricalDimensionSync,
  previewHistoricalDimensionSync,
} from './historicalDimensionSyncClient.js';

describe('historicalDimensionSyncClient', () => {
  beforeEach(() => requestLocalApi.mockReset());

  it('previews old/new/source values before any Ozon write', async () => {
    requestLocalApi.mockResolvedValue({
      ok: true,
      operationId: 'sync-a',
      previewFingerprint: 'sync-fingerprint',
      summary: { total: 1, changed: 1 },
      items: [{
        product: { productIdentityId: 'identity-a', productId: '100', name: '红色商品' },
        source: { importId: 'import-a', orderNumber: 'ozon-order-a', label: '历史订单导入' },
        currentValues: { lengthCm: 10, weightKg: 0.3 },
        proposedValues: { lengthCm: 12, weightKg: 0.4 },
        status: 'ready',
      }],
    });
    const input = {
      shopId: 'shop-a',
      importId: 'import-a',
      items: [{ productIdentityId: 'identity-a', orderNumber: 'ozon-order-a' }],
    };
    await expect(previewHistoricalDimensionSync(input)).resolves.toMatchObject({
      operationId: 'sync-a',
      previewFingerprint: 'sync-fingerprint',
      summary: { totalProducts: 1, changedProducts: 1 },
      items: [{
        source: { importId: 'import-a', orderNumber: 'ozon-order-a', label: '历史订单导入' },
        currentValues: { lengthCm: 10, weightKg: 0.3 },
        proposedValues: { lengthCm: 12, weightKg: 0.4 },
      }],
    });
    expect(requestLocalApi).toHaveBeenCalledWith('/api/products/historical-dimension-sync/preview', {
      method: 'POST',
      body: input,
      timeoutMs: 120_000,
      signal: undefined,
    });
  });

  it('normalizes per-product Ozon readback status after explicit confirmation', async () => {
    requestLocalApi.mockResolvedValue({
      ok: true,
      operationId: 'sync-a',
      status: 'completed',
      items: [{
        productIdentityId: 'identity-a',
        productId: '100',
        name: '红色商品',
        readbackStatus: 'verified',
        readbackValues: { lengthCm: 12, weightKg: 0.4 },
      }],
    });
    const input = {
      shopId: 'shop-a',
      operationId: 'sync-a',
      previewFingerprint: 'sync-fingerprint',
    };
    await expect(confirmHistoricalDimensionSync(input)).resolves.toMatchObject({
      operationId: 'sync-a',
      verified: true,
      items: [{
        readbackStatus: 'verified',
        readbackVerified: true,
        readbackValues: { lengthCm: 12, weightKg: 0.4 },
      }],
    });
    expect(requestLocalApi).toHaveBeenCalledWith('/api/products/historical-dimension-sync/confirm', {
      method: 'POST',
      body: input,
      timeoutMs: 120_000,
      signal: undefined,
    });
  });

  it('supports the backend targets contract and converts mm/g to cm/kg', async () => {
    requestLocalApi.mockResolvedValue({
      ok: true,
      previewId: 'write-preview-a',
      previewFingerprint: 'sync-fingerprint',
      productCount: 1,
      targets: [{
        productIdentityId: 'identity-a',
        productId: '100',
        before: { lengthMm: 101, widthMm: 202, heightMm: 303, weightG: 450 },
        after: { lengthMm: 120, widthMm: 220, heightMm: 320, weightG: 500 },
        changes: [{
          field: 'length',
          sourceType: 'historical_order_import',
          sourceName: 'historical-order-import',
        }],
      }],
    });

    await expect(previewHistoricalDimensionSync({ shopId: 'shop-a' })).resolves.toMatchObject({
      operationId: 'write-preview-a',
      items: [{
        productName: 'Ozon 商品 100',
        currentValues: { lengthCm: 10.1, widthCm: 20.2, heightCm: 30.3, weightKg: 0.45 },
        proposedValues: { lengthCm: 12, widthCm: 22, heightCm: 32, weightKg: 0.5 },
        source: { label: '历史订单导入' },
      }],
    });
  });

  it('combines result targets with the top-level readBack verdict', async () => {
    requestLocalApi.mockResolvedValue({
      ok: true,
      completed: true,
      previewId: 'write-preview-a',
      status: 'completed',
      targets: [{
        productIdentityId: 'identity-a',
        productId: '100',
        before: { lengthMm: 100, weightG: 300 },
        after: { lengthMm: 120, weightG: 400 },
      }],
      readBack: { status: 'merged', verified: true, rows: 1 },
    });

    await expect(confirmHistoricalDimensionSync({
      shopId: 'shop-a',
      previewId: 'write-preview-a',
      previewFingerprint: 'sync-fingerprint',
      confirm: true,
    })).resolves.toMatchObject({
      operationId: 'write-preview-a',
      verified: true,
      items: [{
        readbackStatus: 'merged',
        readbackVerified: true,
        readbackValues: { lengthCm: 12, weightKg: 0.4 },
      }],
    });
  });
});
