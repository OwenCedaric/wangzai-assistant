import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  enrichAfterSalesRowsWithCachedClassificationEvidence: vi.fn(),
}));

vi.mock('../services/afterSalesCachedClassificationService.js', () => serviceMocks);

import { useAfterSalesCachedClassification } from './useAfterSalesCachedClassification.js';

const shops = [{ id: 'shop-1', clientId: 'client-1' }];
const rawRows = Array.from({ length: 7 }, (_, index) => ({
  id: `after-sales-${index + 1}`,
  returnId: `after-sales-${index + 1}`,
  shopId: 'shop-1',
  status: '签收后退款',
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useAfterSalesCachedClassification', () => {
  it('keeps the classified four-row result while a cloned snapshot is being rechecked', async () => {
    let resolveSecond;
    serviceMocks.enrichAfterSalesRowsWithCachedClassificationEvidence
      .mockResolvedValueOnce({
        rows: rawRows.map((row, index) => ({ ...row, excludeFromAfterSales: index >= 4 })),
        errors: [],
      })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    const { result, rerender } = renderHook(
      ({ rows }) => useAfterSalesCachedClassification(rows, shops),
      { initialProps: { rows: rawRows } },
    );
    expect(result.current).toEqual({ rows: [], ready: false });
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
      expect(result.current.rows.filter((row) => !row.excludeFromAfterSales)).toHaveLength(4);
    });

    const clonedRows = rawRows.map((row) => ({ ...row }));
    rerender({ rows: clonedRows });
    expect(result.current.ready).toBe(true);
    expect(result.current.rows.filter((row) => !row.excludeFromAfterSales)).toHaveLength(4);

    await act(async () => {
      resolveSecond?.({
        rows: clonedRows.map((row, index) => ({ ...row, excludeFromAfterSales: index >= 4 })),
        errors: [],
      });
    });
    expect(result.current.rows.filter((row) => !row.excludeFromAfterSales)).toHaveLength(4);
  });
});
