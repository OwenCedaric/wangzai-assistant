import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestLocalApi = vi.hoisted(() => vi.fn());
vi.mock('../../../api/localApiClient.js', () => ({ requestLocalApi }));

import {
  confirmHistoricalOrderImport,
  getHistoricalOrderImportHistory,
  normalizeHistoricalOrderImportSummary,
  preflightHistoricalOrderImport,
} from './historicalOrderImportClient.js';

describe('historicalOrderImportClient', () => {
  beforeEach(() => requestLocalApi.mockReset());

  it('preflights order rows and exposes multi-product selection candidates', async () => {
    requestLocalApi.mockResolvedValue({
      ok: true,
      importId: 'import-a',
      shopId: 'shop-a',
      previewFingerprint: 'fingerprint-a',
      rowCount: 1,
      summary: { selectionRequired: 1 },
      rows: [{
        rowIndex: 0,
        status: 'selection_required',
        orderNumber: 'ozon-order-a',
        productCandidates: [
          { productIdentityId: 'identity-a', productId: '100', name: '红色商品' },
          { productIdentityId: 'identity-b', productId: '200', name: '蓝色商品' },
        ],
        values: { purchaseCostCny: 0, lengthCm: 12 },
        errorCode: 'HISTORICAL_ORDER_IMPORT_PRODUCT_SELECTION_REQUIRED',
      }],
    });
    const input = {
      shopId: 'shop-a',
      rows: [{ orderNumber: 'ozon-order-a', purchaseCostCny: 0, lengthCm: 12 }],
    };
    await expect(preflightHistoricalOrderImport(input)).resolves.toMatchObject({
      importId: 'import-a',
      previewFingerprint: 'fingerprint-a',
      requiresSelection: true,
      summary: { totalRows: 1, selectionRequiredRows: 1 },
      rows: [{
        rowIndex: 0,
        orderNumber: 'ozon-order-a',
        requiresSelection: true,
        values: { purchaseCostCny: 0, lengthCm: 12 },
        productCandidates: [
          { productIdentityId: 'identity-a', productId: '100', name: '红色商品' },
          { productIdentityId: 'identity-b', productId: '200', name: '蓝色商品' },
        ],
      }],
    });
    expect(requestLocalApi).toHaveBeenCalledWith('/api/app/historical-order-import/preflight', {
      method: 'POST',
      body: input,
      timeoutMs: 120_000,
      signal: undefined,
    });
  });

  it('confirms only the local historical-order import contract', async () => {
    requestLocalApi.mockResolvedValue({
      ok: true,
      verified: true,
      import: {
        importId: 'import-a',
        status: 'completed',
        summary: { committed: 1 },
        result: { verified: true, committed: 1 },
      },
      rows: [{
        rowIndex: 0,
        status: 'committed',
        committed: true,
        orderNumber: 'ozon-order-a',
        selectedProduct: { productIdentityId: 'identity-a', productId: '100', name: '红色商品' },
        appliedValues: { lengthCm: 12, weightKg: 0.4 },
      }],
    });
    const input = { shopId: 'shop-a', importId: 'import-a', previewFingerprint: 'fingerprint-a' };
    await expect(confirmHistoricalOrderImport(input)).resolves.toMatchObject({
      importId: 'import-a',
      verified: true,
      summary: { importedRows: 1 },
      rows: [{ committed: true, appliedValues: { lengthCm: 12, weightKg: 0.4 } }],
    });
    expect(requestLocalApi).toHaveBeenCalledWith('/api/app/historical-order-import/confirm', {
      method: 'POST',
      body: input,
      timeoutMs: 120_000,
      signal: undefined,
    });
  });

  it('reads shop-scoped historical-order import history', async () => {
    requestLocalApi.mockResolvedValue({
      ok: true,
      imports: [{
        importId: 'import-a',
        shopId: '店铺/a',
        source: { fileName: '历史订单.xlsx' },
        completedAt: '2026-07-17T12:00:00.000Z',
        status: 'completed',
        summary: { committed: 2 },
        result: { verified: true, committed: 2 },
      }],
    });
    await expect(getHistoricalOrderImportHistory('店铺/a')).resolves.toEqual([
      expect.objectContaining({
        id: 'import-a',
        operationType: 'historical-order-import',
        fileName: '历史订单.xlsx',
        verified: true,
        summary: expect.objectContaining({ importedRows: 2 }),
      }),
    ]);
    expect(requestLocalApi.mock.calls[0][0]).toBe(
      '/api/app/historical-order-import/history?shopId=%E5%BA%97%E9%93%BA%2Fa',
    );
  });

  it('fails closed without exposing an unknown internal error code', async () => {
    requestLocalApi.mockResolvedValue({ ok: false, error: { code: 'PRIVATE_ORDER_IMPORT_ERROR' } });
    await expect(preflightHistoricalOrderImport({ shopId: 'shop-a' })).rejects.toMatchObject({
      code: 'PRIVATE_ORDER_IMPORT_ERROR',
      message: '操作失败，请重试。',
    });
  });

  it('normalizes the backend insert/update/selection and unmatched counters', () => {
    expect(normalizeHistoricalOrderImportSummary({
      insert: 1,
      update: 1,
      unchanged: 1,
      selectionRequired: 2,
      orderNotFound: 1,
      productUnmatched: 1,
      invalid: 1,
      duplicate: 1,
      noData: 1,
    }, { rowCount: 10 })).toEqual({
      totalRows: 10,
      readyRows: 3,
      matchedRows: 5,
      selectionRequiredRows: 2,
      unmatchedRows: 2,
      conflictRows: 0,
      skippedRows: 5,
      invalidRows: 2,
      importedRows: 0,
      failedRows: 0,
    });
  });
});
