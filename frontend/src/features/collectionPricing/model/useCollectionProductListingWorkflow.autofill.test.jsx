import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCollectionProductListingWorkflow } from './useCollectionProductListingWorkflow.js';

const catalog = vi.hoisted(() => ({
  loadCategories: vi.fn(),
  loadSchema: vi.fn(),
  loadTemplate: vi.fn(),
  resolveCategory: vi.fn(),
}));

const autofill = vi.hoisted(() => ({
  run: vi.fn(),
  preload: vi.fn(async ({ optionsByAttributeId = {} }) => ({ optionsByAttributeId, requestCount: 0 })),
  apply: vi.fn((draft, suggestions) => ({
    draft: {
      ...draft,
      attributeValues: {
        ...draft.attributeValues,
        ...Object.fromEntries((suggestions.globalAttributes || []).map((item) => [item.attributeId, item.value])),
      },
    },
    appliedAttributeCount: (suggestions.globalAttributes || []).length,
    appliedTextCount: 0,
    appliedCount: (suggestions.globalAttributes || []).length,
  })),
}));

vi.mock('../services/collectionListingCatalogService.js', () => ({
  loadCollectionListingCategoryOptions: catalog.loadCategories,
  loadCollectionListingAttributeSchema: catalog.loadSchema,
  loadCollectionListingCategoryTemplate: catalog.loadTemplate,
  loadCollectionListingWarehouses: vi.fn(async () => []),
  resolveCollectedProductCategory: catalog.resolveCategory,
  searchCollectionListingAttributeOptions: vi.fn(async () => []),
  shouldReplaceAutoCollectedProductCategory: ({ currentDraft, recommendation, selectionSource }) => (
    selectionSource !== 'manual'
    && recommendation
    && (
      String(currentDraft.descriptionCategoryId) !== String(recommendation.descriptionCategoryId)
      || String(currentDraft.typeId) !== String(recommendation.typeId)
    )
  ),
}));

vi.mock('../services/collectionAttributeAutofillService.js', () => ({
  runCollectionAttributeAutofill: autofill.run,
  preloadCollectionAttributeAutofillDictionaryOptions: autofill.preload,
  applyCollectionAttributeAutofillResult: autofill.apply,
}));

const wrongDefinition = { id: 'old-field', name: '旧字段', is_required: true, isAspect: false };
const correctDefinition = { id: 'brand', name: '品牌', is_required: true, isAspect: false };

function createProduct() {
  return {
    id: '1688:glasses',
    sourceProductId: 'glasses',
    title: '感光变色平光眼镜',
    skus: [{ id: 'black', name: '黑色' }],
    ozonListingDrafts: {
      'shop-a': {
        shopId: 'shop-a',
        descriptionCategoryId: 'wrong-category',
        typeId: 'wrong-type',
        categorySelectionSource: 'auto',
        categoryPath: '旧类目',
        title: '感光变色平光眼镜',
        skus: [{ sourceSkuId: 'black', sourceSkuName: '黑色' }],
      },
    },
  };
}

function successfulAutofill(overrides = {}) {
  return {
    suggestions: {
      title: '',
      description: '',
      globalAttributes: [{ attributeId: 'brand', value: { value: '无品牌', source: 'ai' } }],
      skuAttributes: [],
      unresolved: [{ scope: 'global', attributeId: 'model', reason: '来源没有型号' }],
    },
    optionsByAttributeId: {},
    modelLabel: '测试模型',
    pipeline: {
      reviewedAttributeCellCount: 2,
      schemaCellCount: 2,
      visionWarning: '图片读取超时',
    },
    ...overrides,
  };
}

describe('collection listing one-click attribute autofill', () => {
  beforeEach(() => {
    catalog.loadCategories.mockReset().mockResolvedValue([
      { descriptionCategoryId: 'wrong-category', typeId: 'wrong-type', pathText: '旧类目' },
      { descriptionCategoryId: '17027904', typeId: '971081388', name: '平光眼镜', pathText: '小百货和配饰 > 配饰 > 平光眼镜' },
    ]);
    catalog.loadSchema.mockReset().mockImplementation(async ({ descriptionCategoryId }) => ({
      definitions: descriptionCategoryId === '17027904' ? [correctDefinition] : [wrongDefinition],
      optionsByAttributeId: {},
    }));
    catalog.resolveCategory.mockReset().mockResolvedValue(null);
    catalog.loadTemplate.mockReset().mockResolvedValue({
      shopId: 'shop-a',
      descriptionCategoryId: '17027904',
      typeId: '971081388',
      categoryName: '平光眼镜',
      categoryPath: '小百货和配饰 > 配饰 > 平光眼镜',
      definitions: [correctDefinition],
      optionsByAttributeId: {},
      dictionaryLoadedIds: [],
      dictionaryFailedIds: [],
      source: 'ozon-scoped-sync',
      warning: '',
    });
    autofill.run.mockReset().mockResolvedValue(successfulAutofill());
    autofill.preload.mockClear();
    autofill.apply.mockClear();
  });

  it('loads a complete category template before the user confirms the leaf category', async () => {
    const category = {
      descriptionCategoryId: '17027904',
      typeId: '971081388',
      name: '平光眼镜',
      pathText: '小百货和配饰 > 配饰 > 平光眼镜',
    };
    const { result } = renderHook(() => useCollectionProductListingWorkflow({
      product: createProduct(),
      shops: [{ id: 'shop-a', name: 'A店' }],
      activeShopId: 'shop-a',
    }));

    await act(async () => {
      await result.current.previewCategoryTemplate(category);
    });

    expect(catalog.loadTemplate).toHaveBeenCalledWith(expect.objectContaining({
      shopId: 'shop-a',
      descriptionCategoryId: '17027904',
      typeId: '971081388',
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result.current.categoryTemplateState).toMatchObject({
      status: 'ready',
      categoryKey: '17027904:971081388',
      template: { definitions: [correctDefinition] },
    });
  });

  it('commits a category only after the complete catalog confirmation callback', async () => {
    const category = {
      descriptionCategoryId: '200001542',
      typeId: '96686',
      name: '视力眼镜',
      pathText: '医疗保健 > 光学 > 视力眼镜',
    };
    catalog.loadSchema.mockResolvedValueOnce({ definitions: [correctDefinition], optionsByAttributeId: {} });
    const { result } = renderHook(() => useCollectionProductListingWorkflow({
      product: createProduct(),
      shops: [{ id: 'shop-a' }],
      activeShopId: 'shop-a',
    }));
    await waitFor(() => expect(result.current.categoryState.status).toBe('ready'));

    expect(result.current.draft.descriptionCategoryId).toBe('');
    act(() => result.current.selectCategory(category));

    await waitFor(() => expect(result.current.definitions).toEqual([correctDefinition]));
    expect(result.current.draft).toMatchObject({
      descriptionCategoryId: '200001542',
      typeId: '96686',
      categorySelectionSource: 'manual',
      categoryPath: '医疗保健 > 光学 > 视力眼镜',
    });
    expect(catalog.resolveCategory).not.toHaveBeenCalled();
  });

  it('does not scan or fill the SKU matrix while confirming a category', async () => {
    const category = {
      descriptionCategoryId: '200001542',
      typeId: '96686',
      name: '发圈',
      pathText: '小百货和配饰 > 发饰 > 发圈',
    };
    const colorDefinition = {
      id: 'color', name: '颜色', is_required: true, isAspect: true, isDictionary: false,
    };
    catalog.loadSchema.mockResolvedValueOnce({
      definitions: [colorDefinition],
      optionsByAttributeId: {},
    });
    const product = createProduct();
    product.skus = [{
      id: 'black',
      name: '黑色',
      color: '黑色',
      attributes: [{ name: '颜色', value: '黑色' }],
    }];
    const { result } = renderHook(() => useCollectionProductListingWorkflow({
      product,
      shops: [{ id: 'shop-a' }],
      activeShopId: 'shop-a',
    }));
    await waitFor(() => expect(result.current.categoryState.status).toBe('ready'));

    act(() => result.current.selectCategory(category));

    await waitFor(() => expect(result.current.definitions).toEqual([colorDefinition]));
    expect(result.current.draft.skus).toHaveLength(1);
    expect(result.current.draft.skus[0].attributeValues).toEqual({});
    expect(result.current.attributeState.mappedCount).toBe(0);
  });

  it('clears an old automatic category and requires confirmation through the complete catalog', async () => {
    const { result } = renderHook(() => useCollectionProductListingWorkflow({
      product: createProduct(),
      shops: [{ id: 'shop-a' }],
      activeShopId: 'shop-a',
    }));
    await waitFor(() => expect(result.current.categoryState.status).toBe('ready'));

    expect(result.current.draft).toMatchObject({
      descriptionCategoryId: '', typeId: '', categorySelectionSource: '', categoryPath: '',
    });
    expect(result.current.definitions).toEqual([]);

    await act(async () => result.current.analyzeAndFillAttributes());

    expect(result.current.attributeAutofillState).toMatchObject({
      status: 'error',
      error: expect.stringContaining('完整类目库'),
    });
    expect(autofill.run).not.toHaveBeenCalled();
    expect(catalog.resolveCategory).not.toHaveBeenCalled();
  });

  it('runs the full autofill only after a category is manually confirmed', async () => {
    const product = createProduct();
    product.ozonListingDrafts['shop-a'] = {
      ...product.ozonListingDrafts['shop-a'],
      descriptionCategoryId: '17027904',
      typeId: '971081388',
      categoryPath: '小百货和配饰 > 配饰 > 平光眼镜',
      categorySelectionSource: 'manual',
    };
    const { result } = renderHook(() => useCollectionProductListingWorkflow({
      product,
      shops: [{ id: 'shop-a' }],
      activeShopId: 'shop-a',
    }));
    await waitFor(() => expect(result.current.definitions).toEqual([correctDefinition]));

    await act(async () => result.current.analyzeAndFillAttributes());

    expect(autofill.run).toHaveBeenCalledTimes(1);
    expect(autofill.run.mock.calls[0][1]).toMatchObject({
      enableVision: false,
      skuBatchSize: 11,
      splitGlobalJobs: true,
      globalAttributeBatchSize: 5,
      sharedSkuTitle: true,
      modelConcurrency: 15,
      modelRequestsPerWindow: 30,
    });
    expect(result.current.attributeAutofillState.status).toBe('success');
    expect(result.current.attributeAutofillState.message).toContain('智能填充已完成');
  });

  it('does not apply an old analysis after the user changes the Ozon category', async () => {
    let finish;
    autofill.run.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const product = createProduct();
    product.ozonListingDrafts['shop-a'] = {
      ...product.ozonListingDrafts['shop-a'],
      descriptionCategoryId: '17027904',
      typeId: '971081388',
      categorySelectionSource: 'manual',
    };
    product.ozonListingDrafts['shop-b'] = {
      ...product.ozonListingDrafts['shop-a'],
      shopId: 'shop-b',
      categorySelectionSource: 'manual',
    };
    const { result } = renderHook(() => useCollectionProductListingWorkflow({
      product,
      shops: [{ id: 'shop-a' }, { id: 'shop-b' }],
      activeShopId: 'shop-a',
    }));
    await waitFor(() => expect(result.current.definitions).toEqual([correctDefinition]));

    let pending;
    act(() => { pending = result.current.analyzeAndFillAttributes(); });
    await waitFor(() => {
      expect(result.current.attributeAutofillState.status).toBe('running');
      expect(autofill.run).toHaveBeenCalledTimes(1);
    });
    act(() => result.current.update({ descriptionCategoryId: '200', typeId: '20' }));
    await act(async () => {
      finish(successfulAutofill());
      await pending;
    });

    expect(result.current.draft).toMatchObject({ shopId: 'shop-a', descriptionCategoryId: '200', typeId: '20' });
    expect(autofill.apply).not.toHaveBeenCalled();
    expect(result.current.attributeAutofillState.status).toBe('idle');
  });

  it('does not call category recommendation or overwrite the category during one-click analysis', async () => {
    const { result } = renderHook(() => useCollectionProductListingWorkflow({
      product: createProduct(),
      shops: [{ id: 'shop-a' }],
      activeShopId: 'shop-a',
    }));
    await waitFor(() => expect(result.current.categoryState.status).toBe('ready'));

    await act(async () => result.current.analyzeAndFillAttributes());

    expect(result.current.attributeAutofillState).toMatchObject({
      status: 'error',
      error: expect.stringContaining('完整类目库'),
    });
    expect(catalog.resolveCategory).not.toHaveBeenCalled();
    expect(autofill.run).not.toHaveBeenCalled();
  });

  it('keeps deterministic Ozon option matches when the text model request fails', async () => {
    const product = createProduct();
    product.ozonListingDrafts['shop-a'] = {
      ...product.ozonListingDrafts['shop-a'],
      descriptionCategoryId: '17027904',
      typeId: '971081388',
      categorySelectionSource: 'manual',
    };
    autofill.run.mockRejectedValueOnce(new Error('fetch failed'));
    const { result } = renderHook(() => useCollectionProductListingWorkflow({
      product,
      shops: [{ id: 'shop-a' }],
      activeShopId: 'shop-a',
    }));
    await waitFor(() => expect(result.current.definitions).toEqual([correctDefinition]));

    await act(async () => result.current.analyzeAndFillAttributes());

    expect(result.current.attributeAutofillState).toMatchObject({
      status: 'success',
      warning: 'fetch failed',
      appliedAttributeCount: 1,
    });
    expect(result.current.draft.attributeValues.brand).toMatchObject({
      value: 'Нет бренда',
      dictionaryValueId: '126745801',
      source: 'managed-default',
    });
  });
});
