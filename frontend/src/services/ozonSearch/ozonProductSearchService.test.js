import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOzonCategoryIndexProjection } from '../../data/ozonCategoryIndex.js';
import { searchOzonProductsFromInput } from './ozonProductSearchService.js';

describe('ozonProductSearchService', () => {
  beforeEach(() => resetOzonCategoryIndexProjection());

  it('hydrates the shared category catalog and passes one reusable query plan to the capture workflow', async () => {
    const categoryTreeLoader = vi.fn(async () => ({
      catalog: { locale: 'ZH_HANS', updatedAt: '2026-07-29T00:00:00.000Z' },
      nodes: [
        { nodeKind: 'category', categoryId: '15621032', title: '鞋类' },
        { nodeKind: 'category', categoryId: '15621048', parentCategoryId: '15621032', title: '休闲鞋' },
        { nodeKind: 'type', categoryId: '15621048', typeId: '91248', parentCategoryId: '15621048', title: '运动鞋' },
      ],
    }));
    const searchExecutor = vi.fn(async () => ({
      captureMode: 'product-search',
      datasets: [],
    }));

    const result = await searchOzonProductsFromInput(
      { 商品线索: '夏季白色运动鞋' },
      {
        queryMode: 'product',
        categoryTreeLoader,
        searchExecutor,
        captureOptions: { pagination: false },
      },
    );

    expect(categoryTreeLoader).toHaveBeenCalledOnce();
    expect(result.queryPlan).toMatchObject({
      query: 'кроссовки',
      categoryIds: ['91248'],
      categoryMatch: { name: '运动鞋', typeId: '91248' },
      catalogHydrated: true,
    });
    expect(searchExecutor).toHaveBeenCalledWith('кроссовки', expect.objectContaining({
      pagination: false,
      productPerformanceCategoryIds: ['91248'],
      productPerformancePreferCategoryOnly: true,
    }));
    const captureOptions = searchExecutor.mock.calls[0][1];
    expect(captureOptions).not.toHaveProperty('allowLegacyProductSearchFallback');
    expect(captureOptions).not.toHaveProperty('productSearchCategoryIds');
    expect(captureOptions).not.toHaveProperty('productSearchCategoryHints');
  });

  it('uses an exact SKU from a product URL without loading the category catalog', async () => {
    const categoryTreeLoader = vi.fn();
    const searchExecutor = vi.fn(async () => ({ datasets: [] }));

    const result = await searchOzonProductsFromInput(
      { 'Ozon SKU': 'https://www.ozon.ru/product/test-3568698657/' },
      { queryMode: 'sku', categoryTreeLoader, searchExecutor },
    );

    expect(categoryTreeLoader).not.toHaveBeenCalled();
    expect(result.queryPlan).toMatchObject({ query: '3568698657', sku: '3568698657' });
    expect(searchExecutor).toHaveBeenCalledWith('3568698657', expect.any(Object));
  });

  it('does not route seller, brand, keyword or snapshot modes into product search', async () => {
    for (const queryMode of ['seller', 'brand', 'keyword', 'snapshot', 'provider-category']) {
      const searchExecutor = vi.fn();
      const result = await searchOzonProductsFromInput(
        { 查询: 'test' },
        { queryMode, searchExecutor },
      );
      expect(result).toEqual({ queryPlan: null, snapshot: null });
      expect(searchExecutor).not.toHaveBeenCalled();
    }
  });

  it('keeps an unmatched product phrase usable without inventing a category id', async () => {
    const searchExecutor = vi.fn(async () => ({ datasets: [] }));
    const result = await searchOzonProductsFromInput(
      { 商品线索: '限量版宇宙风摆件' },
      {
        queryMode: 'product',
        loadCategoryCatalog: false,
        searchExecutor,
      },
    );

    expect(result.queryPlan).toMatchObject({
      query: '限量版宇宙风摆件',
      categoryIds: [],
      matchSource: 'input',
    });
    expect(searchExecutor).toHaveBeenCalledOnce();
  });
});
