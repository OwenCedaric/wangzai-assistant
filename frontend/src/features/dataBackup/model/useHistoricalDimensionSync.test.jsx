import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  previewHistoricalDimensionSync: vi.fn(),
  confirmHistoricalDimensionSync: vi.fn(),
}));

vi.mock('../services/historicalDimensionSyncClient.js', () => mocks);

import { useHistoricalDimensionSync } from './useHistoricalDimensionSync.js';

const completedImport = {
  importId: 'import-a',
  dimensionCandidates: [{
    selectionKey: '0:identity-a',
    rowIndex: 0,
    orderNumber: 'ozon-order-a',
    productIdentityId: 'identity-a',
    productId: '100',
    productName: '红色商品',
    values: { lengthCm: 12, weightKg: 0.4 },
  }],
};

describe('useHistoricalDimensionSync', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults to no Ozon return and requires select -> preview -> manual confirm', async () => {
    mocks.previewHistoricalDimensionSync.mockResolvedValue({
      operationId: 'sync-a',
      previewFingerprint: 'sync-fingerprint',
      items: [{
        selectionKey: 'identity-a',
        currentValues: { lengthCm: 10, weightKg: 0.3 },
        proposedValues: { lengthCm: 12, weightKg: 0.4 },
        source: { label: '历史订单导入', orderNumber: 'ozon-order-a' },
      }],
    });
    mocks.confirmHistoricalDimensionSync.mockResolvedValue({
      operationId: 'sync-a',
      verified: true,
      items: [{ readbackStatus: 'verified', readbackVerified: true }],
    });
    const { result } = renderHook(() => useHistoricalDimensionSync({
      shopId: 'shop-a',
      completedImport,
    }));

    expect(result.current.selectedKeys).toEqual([]);
    expect(result.current.canPreview).toBe(false);
    expect(mocks.previewHistoricalDimensionSync).not.toHaveBeenCalled();
    expect(mocks.confirmHistoricalDimensionSync).not.toHaveBeenCalled();

    act(() => result.current.toggleCandidate('0:identity-a'));
    expect(result.current.canPreview).toBe(true);
    await act(async () => result.current.runPreview());
    expect(mocks.previewHistoricalDimensionSync).toHaveBeenCalledWith({
      shopId: 'shop-a',
      importId: 'import-a',
      items: [{
        rowIndex: 0,
        orderNumber: 'ozon-order-a',
        productIdentityId: 'identity-a',
        productId: '100',
      }],
    });
    expect(result.current.canConfirm).toBe(true);

    await act(async () => result.current.runConfirm());
    expect(mocks.confirmHistoricalDimensionSync).toHaveBeenCalledWith({
      shopId: 'shop-a',
      previewId: 'sync-a',
      previewFingerprint: 'sync-fingerprint',
      confirm: true,
    });
    expect(result.current.status).toBe('completed');
    expect(result.current.message?.text).toMatch(/回读校验/u);
  });

  it('keeps a partial result visible when Ozon readback is not verified', async () => {
    mocks.previewHistoricalDimensionSync.mockResolvedValue({ previewFingerprint: 'fingerprint', items: [] });
    mocks.confirmHistoricalDimensionSync.mockResolvedValue({
      verified: false,
      items: [{ readbackStatus: 'failed', readbackVerified: false }],
    });
    const { result } = renderHook(() => useHistoricalDimensionSync({ shopId: 'shop-a', completedImport }));
    act(() => result.current.toggleCandidate('0:identity-a'));
    await act(async () => result.current.runPreview());
    await act(async () => result.current.runConfirm());
    expect(result.current.status).toBe('partial');
    expect(result.current.result?.items[0].readbackStatus).toBe('failed');
    expect(result.current.message?.text).toMatch(/未通过 Ozon 回读/u);
  });
});
