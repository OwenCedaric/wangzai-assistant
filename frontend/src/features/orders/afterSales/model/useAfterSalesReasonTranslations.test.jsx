import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestAfterSalesReasonTranslations: vi.fn(),
}));

vi.mock('../services/afterSalesReasonTranslationService.js', async (importOriginal) => ({
  ...(await importOriginal()),
  requestAfterSalesReasonTranslations: mocks.requestAfterSalesReasonTranslations,
}));

import { useAfterSalesReasonTranslations } from './useAfterSalesReasonTranslations.js';

describe('useAfterSalesReasonTranslations', () => {
  it('keeps one semantic translation request alive when the page recreates the same row array', async () => {
    let resolveRequest;
    mocks.requestAfterSalesReasonTranslations.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const createRows = () => [{
      id: 'return-a',
      shopId: 'shop-a',
      reason: '售后原因翻译中',
      reasonRaw: 'Заказ утерян при доставке',
    }];
    const { result, rerender } = renderHook(
      ({ rows }) => useAfterSalesReasonTranslations(rows),
      { initialProps: { rows: createRows() } },
    );

    rerender({ rows: createRows() });
    expect(mocks.requestAfterSalesReasonTranslations).toHaveBeenCalledTimes(1);
    expect(mocks.requestAfterSalesReasonTranslations.mock.calls[0][1].signal.aborted).toBe(false);

    await act(async () => {
      resolveRequest({
        ok: true,
        rows: [{
          id: 'after-sales-reason-1',
          text: 'Заказ утерян при доставке',
          translated: true,
          translatedText: '订单在配送途中丢失',
          provider: 'translation-test',
        }],
      });
    });

    await waitFor(() => expect(result.current[0].reason).toBe('订单在配送途中丢失'));
  });
});
