import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPromptLibraryShopOptions,
  usePromptLibraryShopScope,
} from './usePromptLibraryShopScope.js';

const shops = [
  { id: 'shop-1', name: '第一店', clientId: '1001' },
  { id: 'shop-2', shopAlias: '第二店', sellerName: '第二店正式名', clientId: '1002' },
];

describe('prompt library shop scope', () => {
  it('normalizes and deduplicates dynamic shop options without a fixed shop count', () => {
    expect(buildPromptLibraryShopOptions([...shops, shops[0], { id: 'shop-3', name: '第三店' }]))
      .toMatchObject([
        { shopId: 'shop-1', displayName: '第一店' },
        { shopId: 'shop-2', displayName: '第二店' },
        { shopId: 'shop-3', displayName: '第三店' },
      ]);
  });

  it('starts from the active shop, switches locally, and follows a later app-level shop change', () => {
    const onActiveShopChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ activeShopId }) => usePromptLibraryShopScope({ shops, activeShopId, onActiveShopChange }),
      { initialProps: { activeShopId: 'shop-1' } }
    );

    expect(result.current.selectedShopId).toBe('shop-1');
    act(() => result.current.selectShop('shop-2'));
    expect(result.current.selectedShopId).toBe('shop-2');
    expect(onActiveShopChange).toHaveBeenCalledWith('shop-2');

    rerender({ activeShopId: 'shop-2' });
    rerender({ activeShopId: 'shop-1' });
    expect(result.current.selectedShopId).toBe('shop-1');
  });

  it('falls forward to the first current shop when a removed shop is selected', () => {
    const { result, rerender } = renderHook(
      ({ rows }) => usePromptLibraryShopScope({ shops: rows, activeShopId: 'shop-2' }),
      { initialProps: { rows: shops } }
    );
    expect(result.current.selectedShopId).toBe('shop-2');

    rerender({ rows: [shops[0]] });
    expect(result.current.selectedShopId).toBe('shop-1');
  });
});
