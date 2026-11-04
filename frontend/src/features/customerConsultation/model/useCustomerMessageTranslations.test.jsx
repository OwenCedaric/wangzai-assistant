import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  translateCustomerChatMessages: vi.fn(),
}));

vi.mock('../services/customerConsultationClient.js', () => mocks);

import { useCustomerMessageTranslations } from './useCustomerMessageTranslations.js';

function createConversation(messages) {
  return { id: 'chat-a', messages };
}

describe('useCustomerMessageTranslations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('translates newest messages in small batches and preserves duplicate text fan-out', async () => {
    mocks.translateCustomerChatMessages.mockImplementation(async ({ messages }) => ({
      ok: true,
      rows: messages.map((message) => ({
        id: message.id,
        translated: true,
        translatedText: `中文-${message.text}`,
      })),
    }));
    const messages = Array.from({ length: 14 }, (_, index) => ({
      id: `message-${index}`,
      text: index === 0 ? 'Привет' : `Сообщение ${index}`,
    }));
    messages[13].text = 'Привет';

    const { result } = renderHook(() => useCustomerMessageTranslations(createConversation(messages)));
    await waitFor(() => expect(result.current.status).toBe('success'));

    expect(mocks.translateCustomerChatMessages).toHaveBeenCalledTimes(5);
    expect(mocks.translateCustomerChatMessages.mock.calls.every(([payload]) => payload.messages.length <= 3)).toBe(
      true
    );
    expect(result.current.translations['message-0']).toBe('中文-Привет');
    expect(result.current.translations['message-13']).toBe('中文-Привет');
  });

  it('retries only the failed group while retaining successful translations', async () => {
    mocks.translateCustomerChatMessages
      .mockResolvedValueOnce({
        ok: true,
        rows: [
          { id: 'ok', translated: true, translatedText: '已完成' },
          { id: 'bad', translated: false, translatedText: 'Срочно', error: '翻译未完成，请重试。' },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        rows: [{ id: 'bad', translated: true, translatedText: '你好' }],
      });
    const conversation = createConversation([
      { id: 'ok', text: 'Спасибо' },
      { id: 'bad', text: 'Срочно' },
    ]);
    const { result } = renderHook(() => useCustomerMessageTranslations(conversation));

    await waitFor(() => expect(result.current.status).toBe('partial'));
    expect(result.current.translations.ok).toBe('已完成');
    await act(async () => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('success'));

    expect(mocks.translateCustomerChatMessages).toHaveBeenCalledTimes(2);
    expect(mocks.translateCustomerChatMessages.mock.calls[1][0].messages).toEqual([{ id: 'bad', text: 'Срочно' }]);
    expect(result.current.translations).toMatchObject({ ok: '已完成', bad: '你好' });
  });

  it('publishes the first batch while the next batch is still running', async () => {
    let resolveSecondBatch;
    mocks.translateCustomerChatMessages
      .mockImplementationOnce(async ({ messages }) => ({
        ok: true,
        rows: messages.map((message) => ({
          id: message.id,
          translated: true,
          translatedText: `首批-${message.id}`,
        })),
      }))
      .mockImplementationOnce(
        ({ messages }) =>
          new Promise((resolve) => {
            resolveSecondBatch = () =>
              resolve({
                ok: true,
                rows: messages.map((message) => ({
                  id: message.id,
                  translated: true,
                  translatedText: `次批-${message.id}`,
                })),
              });
          })
      );
    const conversation = createConversation(
      Array.from({ length: 4 }, (_, index) => ({ id: `batch-${index}`, text: `Пакет ${index}` }))
    );
    const { result } = renderHook(() => useCustomerMessageTranslations(conversation));

    await waitFor(() => expect(mocks.translateCustomerChatMessages).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe('loading');
    expect(Object.keys(result.current.translations)).toHaveLength(3);
    await act(async () => resolveSecondBatch());
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(Object.keys(result.current.translations)).toHaveLength(4);
  });

  it('aborts the previous conversation request when the selected conversation changes', async () => {
    let resolveRequest;
    mocks.translateCustomerChatMessages.mockImplementation(
      (_payload, options) =>
        new Promise((resolve) => {
          resolveRequest = () => resolve({ ok: true, rows: [] });
          options.signal.addEventListener('abort', () => resolve({ ok: true, rows: [] }), { once: true });
        })
    );
    const { rerender } = renderHook(({ conversation }) => useCustomerMessageTranslations(conversation), {
      initialProps: { conversation: createConversation([{ id: 'a', text: 'Очень срочно' }]) },
    });
    await waitFor(() => expect(mocks.translateCustomerChatMessages).toHaveBeenCalledTimes(1));
    const firstSignal = mocks.translateCustomerChatMessages.mock.calls[0][1].signal;
    rerender({ conversation: { id: 'chat-b', messages: [{ id: 'b', text: 'Спасибо' }] } });
    expect(firstSignal.aborted).toBe(true);
    resolveRequest?.();
  });
});
