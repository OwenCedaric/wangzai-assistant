import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  previewCustomerMessageSend: vi.fn(),
  confirmCustomerMessageSend: vi.fn(),
  readCustomerChatHistory: vi.fn(),
}));

vi.mock('../services/customerConsultationClient.js', () => ({
  previewCustomerMessageSend: mocks.previewCustomerMessageSend,
  confirmCustomerMessageSend: mocks.confirmCustomerMessageSend,
  readCustomerChatHistory: mocks.readCustomerChatHistory,
}));

import { useCustomerMessageSend } from './useCustomerMessageSend.js';

afterEach(() => vi.resetAllMocks());

const conversation = { id: 'shop-a::chat-1', chatId: 'chat-1', title: '买家 1' };

describe('customer message write safety flow', () => {
  it('requires preview and confirmation, and only clears after Ozon readback', async () => {
    const onReadbackConfirmed = vi.fn();
    mocks.previewCustomerMessageSend.mockResolvedValue({ ok: true, previewId: 'preview-1' });
    mocks.confirmCustomerMessageSend.mockResolvedValue({
      ok: true,
      readBack: { status: 'success', messageId: 'message-1' },
    });
    const { result } = renderHook(() => useCustomerMessageSend({ activeShopId: 'shop-a', onReadbackConfirmed }));

    await act(async () => {
      await result.current.requestSend({ conversation, text: '您好' });
    });
    expect(result.current.sendState.status).toBe('ready');
    expect(mocks.confirmCustomerMessageSend).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.confirmSend();
    });
    await waitFor(() => expect(result.current.sendState.status).toBe('success'));
    expect(onReadbackConfirmed).toHaveBeenCalledWith(conversation.id);
    expect(mocks.previewCustomerMessageSend).toHaveBeenCalledWith(
      { shopId: 'shop-a', chatId: 'chat-1', text: '您好' },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('does not report completion when the write has no readback confirmation', async () => {
    mocks.previewCustomerMessageSend.mockResolvedValue({ ok: true, previewId: 'preview-2' });
    mocks.confirmCustomerMessageSend.mockResolvedValue({
      ok: true,
      readBack: { status: 'pending' },
    });
    const { result } = renderHook(() => useCustomerMessageSend({ activeShopId: 'shop-a' }));
    await act(async () => {
      await result.current.requestSend({ conversation, text: '回复' });
    });
    await act(async () => {
      await result.current.confirmSend();
    });
    expect(result.current.sendState.status).toBe('pending');
  });

  it('retries only the Ozon readback without submitting the message again', async () => {
    const onReadbackConfirmed = vi.fn();
    mocks.previewCustomerMessageSend.mockResolvedValue({ ok: true, previewId: 'preview-3' });
    mocks.confirmCustomerMessageSend.mockResolvedValue({
      ok: true,
      readBack: { status: 'pending', messageId: 'message-3' },
    });
    mocks.readCustomerChatHistory.mockResolvedValue({
      ok: true,
      data: {
        messages: [{ message_id: 'message-3', user: { type: 'Seller', id: 'seller' }, data: ['只发一次'] }],
      },
    });
    const { result } = renderHook(() => useCustomerMessageSend({ activeShopId: 'shop-a', onReadbackConfirmed }));
    await act(async () => result.current.requestSend({ conversation, text: '只发一次' }));
    await act(async () => result.current.confirmSend());
    await act(async () => result.current.retrySendReadback());

    expect(result.current.sendState.status).toBe('success');
    expect(mocks.confirmCustomerMessageSend).toHaveBeenCalledTimes(1);
    expect(mocks.readCustomerChatHistory).toHaveBeenCalledTimes(1);
    expect(onReadbackConfirmed).toHaveBeenCalledWith(conversation.id);
  });
});
