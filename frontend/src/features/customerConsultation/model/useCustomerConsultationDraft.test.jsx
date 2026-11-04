import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCustomerConsultationDraft } from './useCustomerConsultationDraft.js';

afterEach(() => vi.useRealTimers());

describe('customer consultation draft filters', () => {
  it('debounces search locally without creating a request and resets on account scope change', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ scope }) => useCustomerConsultationDraft('', scope), {
      initialProps: { scope: 'shop-a' },
    });

    act(() => result.current.setSearchText('订单 123'));
    expect(result.current.debouncedSearchText).toBe('');
    act(() => vi.advanceTimersByTime(249));
    expect(result.current.debouncedSearchText).toBe('');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.debouncedSearchText).toBe('订单 123');

    act(() => {
      result.current.updateDraft('shop-a::chat-1', '草稿');
      result.current.selectConversation('shop-a::chat-1');
    });
    rerender({ scope: 'shop-b' });
    expect(result.current.selectedConversationId).toBe('');
    expect(result.current.searchText).toBe('');
    expect(result.current.draftsByConversation).toEqual({});
  });
});
