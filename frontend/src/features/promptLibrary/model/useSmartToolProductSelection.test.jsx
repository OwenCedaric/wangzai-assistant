import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSmartToolProductSelection } from './useSmartToolProductSelection.js';
import { filterLocalProductSearchRows, readLocalProductSearchRows } from '../services/smartToolProductSearchService.js';

vi.mock('../services/smartToolProductSearchService.js', () => ({
  filterLocalProductSearchRows: vi.fn((rows) => rows),
  readLocalProductSearchRows: vi.fn(),
}));

describe('useSmartToolProductSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the complete filtered product set while preserving the compact legacy preview', async () => {
    const products = Array.from({ length: 35 }, (_, index) => ({ id: `product-${index + 1}` }));
    const shops = [{ id: 'shop-a' }];
    readLocalProductSearchRows.mockResolvedValue(products);

    const { result } = renderHook(() => useSmartToolProductSelection({ enabled: true, shops }));

    await waitFor(() => expect(result.current.products).toHaveLength(35));
    expect(filterLocalProductSearchRows).toHaveBeenCalledWith(products, '');
    expect(result.current.filteredProducts).toHaveLength(35);
    expect(result.current.visibleProducts).toHaveLength(20);
  });
});
