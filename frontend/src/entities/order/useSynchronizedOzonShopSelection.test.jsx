import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveActiveOzonShopSelection,
  useSynchronizedOzonShopSelection,
} from './useSynchronizedOzonShopSelection.jsx';

function shop(id, clientId, extra = {}) {
  return {
    id,
    clientId,
    apiKey: `key-${id}`,
    hasClientId: true,
    hasApiKey: true,
    shopAlias: id,
    ...extra,
  };
}

const shops = [shop('shop-a', 'client-a'), shop('shop-b', 'client-b')];

describe('useSynchronizedOzonShopSelection', () => {
  it('normalizes a global client id to the canonical internal shop id', () => {
    expect(resolveActiveOzonShopSelection(shops, 'client-b')).toBe('shop-b');
    expect(resolveActiveOzonShopSelection(shops, 'missing')).toBe('all');
  });

  it('starts on the active shop and preserves a manual page selection until the global shop changes', () => {
    const onScopeChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ activeShopId, sourceShops }) => useSynchronizedOzonShopSelection({
        shops: sourceShops,
        activeShopId,
        onScopeChange,
      }),
      { initialProps: { activeShopId: 'shop-a', sourceShops: shops } },
    );

    expect(result.current[0]).toBe('shop-a');
    act(() => result.current[1]('all'));
    expect(result.current[0]).toBe('all');

    rerender({ activeShopId: 'shop-a', sourceShops: [...shops] });
    expect(result.current[0]).toBe('all');
    expect(onScopeChange).not.toHaveBeenCalled();

    rerender({ activeShopId: 'shop-b', sourceShops: shops });
    expect(result.current[0]).toBe('shop-b');
    expect(onScopeChange).toHaveBeenCalledTimes(1);
    expect(onScopeChange.mock.calls[0][0].selection).toBe('shop-b');
  });

  it('follows a delayed shop list and fails closed when the active shop is removed', () => {
    const onScopeChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ sourceShops }) => useSynchronizedOzonShopSelection({
        shops: sourceShops,
        activeShopId: 'shop-b',
        onScopeChange,
      }),
      { initialProps: { sourceShops: [] } },
    );

    expect(result.current[0]).toBe('all');
    rerender({ sourceShops: shops });
    expect(result.current[0]).toBe('shop-b');

    rerender({ sourceShops: [shops[0]] });
    expect(result.current[0]).toBe('all');
    expect(onScopeChange).toHaveBeenCalledTimes(2);
  });

  it('resets on a generation change even when the internal shop id is reused', () => {
    const onScopeChange = vi.fn();
    const first = [shop('shop-a', 'client-a', { shopIncarnation: 'inc-1', credentialRevision: 1 })];
    const second = [shop('shop-a', 'client-a', { shopIncarnation: 'inc-2', credentialRevision: 2 })];
    const { result, rerender } = renderHook(
      ({ sourceShops }) => useSynchronizedOzonShopSelection({
        shops: sourceShops,
        activeShopId: 'shop-a',
        onScopeChange,
      }),
      { initialProps: { sourceShops: first } },
    );

    act(() => result.current[1]('all'));
    rerender({ sourceShops: second });
    expect(result.current[0]).toBe('shop-a');
    expect(onScopeChange).toHaveBeenCalledTimes(1);
  });
});
