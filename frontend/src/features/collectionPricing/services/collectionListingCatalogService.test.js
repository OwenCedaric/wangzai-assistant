import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSharedCatalogCategoryTree: vi.fn(),
  readProductAttributeOptions: vi.fn(),
  readProductAttributeSchema: vi.fn(),
  readProductWarehouseOptions: vi.fn(),
}));

vi.mock('../../../api/localApiClient.js', () => ({
  getSharedCatalogCategoryTree: mocks.getSharedCatalogCategoryTree,
}));

vi.mock('../../../services/productReadClient.js', () => ({
  readProductAttributeOptions: mocks.readProductAttributeOptions,
  readProductAttributeSchema: mocks.readProductAttributeSchema,
  readProductWarehouseOptions: mocks.readProductWarehouseOptions,
}));

import {
  loadCollectionListingAttributeSchema,
  loadCollectionListingCategoryTemplate,
  loadCollectionListingWarehouses,
  rankCollectedProductCategoryOptions,
  resolveCollectedProductCategory,
  searchCollectionListingAttributeOptions,
  shouldReplaceAutoCollectedProductCategory,
  clearCollectionListingCategoryTemplateCache,
  countCollectionListingCategoryTemplateCacheEntriesForShop,
  removeCollectionListingCategoryTemplateCacheForShop,
} from './collectionListingCatalogService.js';

describe('collectionListingCatalogService attribute schema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCollectionListingCategoryTemplateCache();
    mocks.readProductAttributeSchema.mockResolvedValue({
      definitions: [
        { id: '1', name: '材质', isRequired: true, is_required: true, isDictionary: false },
        { id: '2', name: '颜色', isRequired: true, is_required: true, isDictionary: true, isAspect: true },
      ],
      source: 'ozon-scoped-sync',
      warning: '',
      sync: { status: 'success' },
    });
    mocks.readProductAttributeOptions.mockResolvedValue([
      { id: '200', value: '黑色', label: '黑色' },
    ]);
  });

  it('builds one complete category template and preloads every dictionary field', async () => {
    mocks.readProductAttributeOptions.mockImplementation(async ({ attributeId }) => (
      attributeId === '2' ? [{ id: '200', value: '黑色', label: '黑色' }] : []
    ));

    const result = await loadCollectionListingCategoryTemplate({
      shopId: 'shop-1',
      descriptionCategoryId: '10',
      typeId: '20',
      categoryName: '电脑音响系统',
      categoryPath: '电子产品 > 音响和扬声器 > 电脑音响系统',
    });

    expect(result.definitions).toHaveLength(2);
    expect(result.dictionaryLoadedIds).toEqual(['2']);
    expect(result.optionsByAttributeId['2']).toEqual([{ id: '200', value: '黑色', label: '黑色' }]);
    expect(mocks.readProductAttributeOptions).toHaveBeenCalledWith(expect.objectContaining({
      shopId: 'shop-1', categoryId: '10', typeId: '20', attributeId: '2', search: '',
    }), expect.objectContaining({ refresh: false, limit: 200 }));
  });

  it('counts and removes category templates only for the exact Ozon shop', async () => {
    await loadCollectionListingCategoryTemplate({
      shopId: 'shop-1', descriptionCategoryId: '10', typeId: '20',
    });
    await loadCollectionListingCategoryTemplate({
      shopId: 'shop-2', descriptionCategoryId: '10', typeId: '20',
    });

    expect(countCollectionListingCategoryTemplateCacheEntriesForShop('shop-1')).toBe(1);
    expect(countCollectionListingCategoryTemplateCacheEntriesForShop('shop-2')).toBe(1);
    expect(removeCollectionListingCategoryTemplateCacheForShop('shop-1')).toBe(1);
    expect(countCollectionListingCategoryTemplateCacheEntriesForShop('shop-1')).toBe(0);
    expect(countCollectionListingCategoryTemplateCacheEntriesForShop('shop-2')).toBe(1);
  });

  it('returns the real scoped schema without blocking initial render on dictionary values', async () => {
    const result = await loadCollectionListingAttributeSchema({
      shopId: 'shop-1',
      descriptionCategoryId: '10',
      typeId: '20',
      sourceProduct: { attributes: [{ name: '颜色', value: '黑色' }] },
    });

    expect(mocks.readProductAttributeSchema).toHaveBeenCalledWith({
      shopId: 'shop-1', categoryId: '10', typeId: '20',
    }, {});
    expect(mocks.readProductAttributeOptions).not.toHaveBeenCalled();
    expect(result.optionsByAttributeId).toEqual({});
    expect(result.source).toBe('ozon-scoped-sync');
    expect(result.warning).toBe('');
  });

  it('does not fan out dictionary requests across large collected SKU sets', async () => {
    const sourceProduct = {
      attributes: [{ name: '颜色', value: '黑色' }],
      skus: Array.from({ length: 82 }, (_, index) => ({
        id: `sku-${index + 1}`,
        attributes: [{ name: '颜色', value: index % 2 ? '白色' : '黑色' }],
      })),
    };
    const result = await loadCollectionListingAttributeSchema({
      shopId: 'shop-1',
      descriptionCategoryId: '10',
      typeId: '20',
      sourceProduct,
    });

    expect(mocks.readProductAttributeSchema).toHaveBeenCalledTimes(1);
    expect(mocks.readProductAttributeOptions).not.toHaveBeenCalled();
    expect(result.definitions).toHaveLength(2);
  });

  it('loads dictionary values only when a dropdown or autofill explicitly searches', async () => {
    const result = await searchCollectionListingAttributeOptions({
      shopId: 'shop-1',
      descriptionCategoryId: '10',
      typeId: '20',
      attributeId: '2',
      search: '黑色',
    });

    expect(mocks.readProductAttributeOptions).toHaveBeenCalledTimes(1);
    expect(mocks.readProductAttributeOptions).toHaveBeenCalledWith({
      shopId: 'shop-1', categoryId: '10', typeId: '20', attributeId: '2', search: '黑色',
    }, expect.objectContaining({ refresh: true, limit: 100 }));
    expect(result).toEqual([{ id: '200', value: '黑色', label: '黑色' }]);
  });

  it('allows autofill to read the local dictionary cache before starting a remote refresh', async () => {
    await searchCollectionListingAttributeOptions({
      shopId: 'shop-1',
      descriptionCategoryId: '10',
      typeId: '20',
      attributeId: '2',
      search: '黑色',
    }, { refresh: false });

    expect(mocks.readProductAttributeOptions).toHaveBeenCalledWith({
      shopId: 'shop-1', categoryId: '10', typeId: '20', attributeId: '2', search: '黑色',
    }, expect.objectContaining({ refresh: false, limit: 100 }));
  });

  it('forwards an explicit warehouse refresh to the exact shop read service', async () => {
    mocks.readProductWarehouseOptions.mockResolvedValue([{ rawId: 'w-1', name: '一号仓' }]);

    await expect(loadCollectionListingWarehouses('shop-1', { refresh: true })).resolves.toEqual([
      { rawId: 'w-1', name: '一号仓' },
    ]);
    expect(mocks.readProductWarehouseOptions).toHaveBeenCalledWith('shop-1', { refresh: true });
  });
});

describe('collectionListingCatalogService category recommendation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSharedCatalogCategoryTree.mockResolvedValue({
      catalog: { locale: 'ZH_HANS' },
      nodes: [
        { nodeKind: 'category', categoryId: 'fashion-root', title: '服饰鞋包', parentCategoryId: '' },
        { nodeKind: 'category', categoryId: '17027904', title: '配饰', parentCategoryId: 'fashion-root' },
        { nodeKind: 'type', categoryId: '17027904', typeId: '971081388', title: '平光眼镜', parentCategoryId: '17027904' },
        { nodeKind: 'category', categoryId: 'home-root', title: '住宅和花园', parentCategoryId: '' },
        { nodeKind: 'category', categoryId: '17027906', title: '装饰和房间内饰', parentCategoryId: 'home-root' },
        { nodeKind: 'type', categoryId: '17027906', typeId: '970713862', title: '镜框', parentCategoryId: '17027906' },
      ],
    });
  });

  it('uses source category evidence instead of a short title substring', async () => {
    const product = {
      title: '感光变色眼镜框新款金属男防蓝光平光镜眼镜架',
      sourceCategoryName: '平光镜',
      sourceCategoryPath: '服饰配件、饰品 / 平光镜',
      category: '平光镜',
    };

    await expect(resolveCollectedProductCategory(product, { force: true })).resolves.toMatchObject({
      descriptionCategoryId: '17027904',
      typeId: '971081388',
      name: '平光眼镜',
    });
  });

  it('keeps a real home mirror-frame product in the mirror-frame category', async () => {
    await expect(resolveCollectedProductCategory({
      title: '客厅装饰镜框 壁挂镜子边框',
      sourceCategoryName: '镜框',
      category: '镜框',
    }, { force: true })).resolves.toMatchObject({
      descriptionCategoryId: '17027906',
      typeId: '970713862',
      name: '镜框',
    });
  });

  it('applies the same ranking to an unrelated toy category without term rewrites', () => {
    const ranked = rankCollectedProductCategoryOptions({
      title: '儿童遥控汽车玩具模型充电越野车',
      sourceCategoryName: '遥控车',
      sourceCategoryPath: '玩具 / 电动玩具 / 遥控车',
    }, [
      {
        descriptionCategoryId: 'vehicle', typeId: 'car-parts', name: '汽车配件',
        pathText: '汽车用品 > 汽车配件',
      },
      {
        descriptionCategoryId: 'toys', typeId: 'remote-cars', name: '遥控汽车',
        pathText: '儿童用品 > 玩具 > 遥控汽车',
      },
      {
        descriptionCategoryId: 'toys', typeId: 'toy-cars', name: '玩具汽车',
        pathText: '儿童用品 > 玩具 > 玩具汽车',
      },
    ]);

    expect(ranked[0]).toMatchObject({ typeId: 'remote-cars', confidence: 'high', ambiguous: false });
  });

  it('uses the full source path to disambiguate duplicate type names', () => {
    const ranked = rankCollectedProductCategoryOptions({
      title: '透明防摔保护壳',
      sourceCategoryName: '保护壳',
      sourceCategoryPath: '数码配件 / 手机配件 / 保护壳',
    }, [
      {
        descriptionCategoryId: 'phone', typeId: 'phone-case', name: '保护壳',
        pathText: '电子产品 > 手机配件 > 保护壳',
      },
      {
        descriptionCategoryId: 'tablet', typeId: 'tablet-case', name: '保护壳',
        pathText: '电子产品 > 平板电脑配件 > 保护壳',
      },
    ]);

    expect(ranked[0]).toMatchObject({ typeId: 'phone-case', confidence: 'high', ambiguous: false });
  });

  it('fails closed when generic evidence cannot distinguish close categories', () => {
    const ranked = rankCollectedProductCategoryOptions({
      title: '金属桌面可调节支架',
      sourceCategoryName: '支架',
      sourceCategoryPath: '数码配件 / 支架',
    }, [
      {
        descriptionCategoryId: 'phone', typeId: 'phone-stand', name: '手机支架',
        pathText: '电子产品 > 数码配件 > 手机支架',
      },
      {
        descriptionCategoryId: 'tablet', typeId: 'tablet-stand', name: '平板支架',
        pathText: '电子产品 > 数码配件 > 平板支架',
      },
    ]);

    expect(ranked[0]).toMatchObject({ confidence: 'low', ambiguous: true });
  });

  it('never replaces a manually selected category but can repair an earlier automatic choice', () => {
    const input = {
      currentDraft: { descriptionCategoryId: 'old-category', typeId: 'old-type' },
      recommendation: { descriptionCategoryId: 'new-category', typeId: 'new-type' },
    };

    expect(shouldReplaceAutoCollectedProductCategory({ ...input, selectionSource: 'manual' })).toBe(false);
    expect(shouldReplaceAutoCollectedProductCategory({ ...input, selectionSource: 'auto' })).toBe(true);
    expect(shouldReplaceAutoCollectedProductCategory(input)).toBe(true);
  });
});
