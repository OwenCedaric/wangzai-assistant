import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  parseHistoricalOrderImportFile: vi.fn(),
  downloadHistoricalOrderImportTemplate: vi.fn(),
  getHistoricalOrderImportHistory: vi.fn(),
  preflightHistoricalOrderImport: vi.fn(),
  confirmHistoricalOrderImport: vi.fn(),
}));

vi.mock('../services/historicalOrderSpreadsheetService.js', () => ({
  parseHistoricalOrderImportFile: mocks.parseHistoricalOrderImportFile,
  downloadHistoricalOrderImportTemplate: mocks.downloadHistoricalOrderImportTemplate,
}));
vi.mock('../services/historicalOrderImportClient.js', () => ({
  getHistoricalOrderImportHistory: mocks.getHistoricalOrderImportHistory,
  preflightHistoricalOrderImport: mocks.preflightHistoricalOrderImport,
  confirmHistoricalOrderImport: mocks.confirmHistoricalOrderImport,
}));

import { useHistoricalOrderImport } from './useHistoricalOrderImport.js';

describe('useHistoricalOrderImport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getHistoricalOrderImportHistory.mockResolvedValue([]);
    mocks.parseHistoricalOrderImportFile.mockResolvedValue({
      fileName: '历史订单.xlsx',
      fileType: 'xlsx',
      fileSize: 1024,
      rows: [['ozon-order-a', 0, 12]],
      mappings: [
        { columnIndex: 0, sourceHeader: 'Ozon订单号', field: 'orderNumber' },
        { columnIndex: 1, sourceHeader: '商品成本', field: 'purchaseCostCny' },
        { columnIndex: 2, sourceHeader: '长度cm', field: 'lengthCm' },
      ],
    });
  });

  it('requires a product choice for a multi-product order, then saves locally without Ozon return', async () => {
    mocks.preflightHistoricalOrderImport
      .mockResolvedValueOnce({
        importId: 'import-a',
        previewFingerprint: 'fingerprint-a',
        requiresSelection: true,
        summary: { selectionRequiredRows: 1 },
        rows: [{
          rowIndex: 0,
          orderNumber: 'ozon-order-a',
          status: 'selection_required',
          requiresSelection: true,
          values: { purchaseCostCny: 0, lengthCm: 12 },
          productCandidates: [
            { productIdentityId: 'identity-a', productId: '100', name: '红色商品' },
            { productIdentityId: 'identity-b', productId: '200', name: '蓝色商品' },
          ],
        }],
      })
      .mockResolvedValueOnce({
        importId: 'import-b',
        previewFingerprint: 'fingerprint-b',
        requiresSelection: false,
        summary: { readyRows: 1 },
        rows: [{
          rowIndex: 0,
          orderNumber: 'ozon-order-a',
          status: 'ready',
          requiresSelection: false,
          values: { purchaseCostCny: 0, lengthCm: 12 },
          selectedProduct: { productIdentityId: 'identity-b', productId: '200', name: '蓝色商品' },
          productCandidates: [],
        }],
      });
    mocks.confirmHistoricalOrderImport.mockResolvedValue({
      importId: 'import-b',
      verified: true,
      summary: { importedRows: 1 },
      rows: [{ rowIndex: 0, committed: true, appliedValues: { purchaseCostCny: 0, lengthCm: 12 } }],
    });
    const onCompleted = vi.fn();
    const { result } = renderHook(() => useHistoricalOrderImport({
      shopId: 'shop-a',
      onCompleted,
    }));

    await waitFor(() => expect(mocks.getHistoricalOrderImportHistory).toHaveBeenCalled());
    await act(async () => result.current.selectFile({ name: '历史订单.xlsx' }));
    expect(result.current.localResult.rows).toEqual([{
      orderNumber: 'ozon-order-a',
      purchaseCostCny: 0,
      lengthCm: 12,
    }]);

    await act(async () => result.current.runPreflight());
    expect(result.current.status).toBe('selection-required');
    expect(result.current.canConfirm).toBe(false);

    act(() => result.current.updateProductSelection(0, 'identity-b'));
    expect(result.current.status).toBe('selection-dirty');
    await act(async () => result.current.runPreflight());
    expect(mocks.preflightHistoricalOrderImport).toHaveBeenLastCalledWith(expect.objectContaining({
      shopId: 'shop-a',
      columns: expect.arrayContaining([
        { sourceHeader: 'selectedProductId', field: 'selectedProductId' },
      ]),
      rows: [{
        orderNumber: 'ozon-order-a',
        purchaseCostCny: 0,
        lengthCm: 12,
        selectedProductId: 'identity-b',
      }],
    }));
    expect(result.current.canConfirm).toBe(true);

    await act(async () => result.current.runConfirm());
    expect(mocks.confirmHistoricalOrderImport).toHaveBeenCalledWith({
      shopId: 'shop-a',
      importId: 'import-b',
      previewFingerprint: 'fingerprint-b',
    });
    expect(result.current.message?.text).toBe('历史订单已保存到本地，没有回传 Ozon。');
    expect(result.current.completedImport).toMatchObject({
      importId: 'import-b',
      dimensionCandidates: [{
        productIdentityId: 'identity-b',
        productId: '200',
        orderNumber: 'ozon-order-a',
        values: { lengthCm: 12 },
      }],
    });
    expect(onCompleted).toHaveBeenCalled();
  });

  it('reopens a persisted historical import for dimension sync after restart', async () => {
    mocks.getHistoricalOrderImportHistory.mockResolvedValueOnce([{
      importId: 'persisted-import-1',
      status: 'completed',
      rows: [{
        rowIndex: 7,
        committed: true,
        orderNumber: 'persisted-order-1',
        appliedValues: { lengthCm: 18, weightKg: 0.6 },
        selectedProduct: {
          productIdentityId: 'persisted-identity-1',
          productId: '8801',
          name: '历史商品',
        },
      }],
    }]);
    const { result } = renderHook(() => useHistoricalOrderImport({ shopId: 'shop-a' }));
    await waitFor(() => expect(result.current.history).toHaveLength(1));
    act(() => result.current.resumeImport(result.current.history[0]));
    expect(result.current.completedImport).toMatchObject({
      importId: 'persisted-import-1',
      dimensionCandidates: [{
        rowIndex: 7,
        orderNumber: 'persisted-order-1',
        productIdentityId: 'persisted-identity-1',
        values: { lengthCm: 18, weightKg: 0.6 },
      }],
    });
    expect(result.current.message?.text).toMatch(/继续选择并回传尺寸/u);
  });
  it('clears parsed order data and completed import when the Ozon shop changes', async () => {
    const { result, rerender } = renderHook(
      ({ shopId }) => useHistoricalOrderImport({ shopId }),
      { initialProps: { shopId: 'shop-a' } },
    );
    await act(async () => result.current.selectFile({ name: '历史订单.xlsx' }));
    expect(result.current.sheet).not.toBeNull();
    rerender({ shopId: 'shop-b' });
    await waitFor(() => expect(result.current.sheet).toBeNull());
    expect(result.current.completedImport).toBeNull();
  });
});
