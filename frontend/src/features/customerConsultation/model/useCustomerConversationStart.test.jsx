import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  confirmCustomerConversationStart: vi.fn(),
  previewCustomerConversationStart: vi.fn(),
  readCustomerOrderContext: vi.fn(),
  readCustomerChatHistory: vi.fn(),
}));

vi.mock('../services/customerConsultationClient.js', () => ({
  confirmCustomerConversationStart: mocks.confirmCustomerConversationStart,
  previewCustomerConversationStart: mocks.previewCustomerConversationStart,
  readCustomerOrderContext: mocks.readCustomerOrderContext,
  readCustomerChatHistory: mocks.readCustomerChatHistory,
}));

import { getCustomerOrderPostingNumber, useCustomerConversationStart } from './useCustomerConversationStart.js';

afterEach(() => {
  vi.resetAllMocks();
});

describe('useCustomerConversationStart', () => {
  it('uses the exact Ozon posting number instead of the conversation base order number', () => {
    expect(
      getCustomerOrderPostingNumber({
        orderNumber: '75577421-0029',
        postingNumber: '75577421-0029-1',
      })
    ).toBe('75577421-0029-1');
  });

  it('prefills the selected real posting number when opening', async () => {
    mocks.readCustomerOrderContext.mockResolvedValue({ ok: true, rows: [] });
    const { result } = renderHook(() => useCustomerConversationStart({ activeShopId: 'shop-a' }));

    act(() => result.current.openStart('0146426393-0087-1'));

    expect(result.current.startState).toMatchObject({
      open: true,
      shopId: 'shop-a',
      postingNumber: '0146426393-0087-1',
    });
  });

  it('loads real current-shop orders for direct selection', async () => {
    mocks.readCustomerOrderContext.mockResolvedValue({
      ok: true,
      rows: [{ postingNumber: '0146426393-0087-1', status: 'delivering' }],
    });
    const { result } = renderHook(() => useCustomerConversationStart({ activeShopId: 'shop-a' }));
    act(() => result.current.openStart());
    await waitFor(() => expect(result.current.startState.ordersStatus).toBe('success'));
    expect(result.current.startState.orders).toHaveLength(1);
    expect(result.current.startState.postingNumber).toBe('0146426393-0087-1');
    expect(mocks.readCustomerOrderContext).toHaveBeenCalledWith(
      { shopId: 'shop-a' },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('blocks an unknown posting number before creating a write preview', async () => {
    mocks.readCustomerOrderContext.mockResolvedValue({ ok: true, rows: [], total: 0 });
    const { result } = renderHook(() => useCustomerConversationStart({ activeShopId: 'shop-a' }));

    act(() => result.current.openStart('LIVE-PREVIEW-123'));
    await act(async () => {
      await result.current.requestStart();
    });

    await waitFor(() => expect(result.current.startState.status).toBe('error'));
    expect(result.current.startState.error).toContain('当前店铺没有找到这个发货单');
    expect(mocks.previewCustomerConversationStart).not.toHaveBeenCalled();
  });

  it('creates a confirmation preview only after an exact current-shop order match', async () => {
    mocks.readCustomerOrderContext.mockResolvedValue({
      ok: true,
      rows: [{ postingNumber: '0146426393-0087-1', shopId: 'shop-a' }],
      total: 1,
    });
    mocks.previewCustomerConversationStart.mockResolvedValue({ ok: true, previewId: 'preview-1' });
    const { result } = renderHook(() => useCustomerConversationStart({ activeShopId: 'shop-a' }));

    act(() => result.current.openStart('0146426393-0087-1'));
    await act(async () => {
      await result.current.requestStart();
    });

    await waitFor(() => expect(result.current.startState.status).toBe('ready'));
    expect(mocks.readCustomerOrderContext).toHaveBeenCalledWith(
      { shopId: 'shop-a', postingNumber: '0146426393-0087-1' },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(mocks.previewCustomerConversationStart).toHaveBeenCalledTimes(1);
    expect(result.current.startState.verifiedOrder).toMatchObject({ postingNumber: '0146426393-0087-1' });
  });
});
