import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const imageSkillService = vi.hoisted(() => ({
  run: vi.fn(),
  facts: vi.fn(() => '当前商品事实'),
}));

const generatedImageService = vi.hoisted(() => ({
  hydrate: vi.fn(async (value) => value),
  persist: vi.fn(async (value) => ({ selections: value, replacements: new Map() })),
}));

vi.mock('../services/collectionProductImageSkillService.js', () => ({
  buildCollectionProductImageSkillFacts: imageSkillService.facts,
  runCollectionProductImageSkillBatch: imageSkillService.run,
}));

vi.mock('../services/collectionProductGeneratedImageService.js', () => ({
  hydrateCollectionProductGeneratedImageSelections: generatedImageService.hydrate,
  persistCollectionProductGeneratedImageSelections: generatedImageService.persist,
}));

vi.mock('../services/collectionListingCatalogService.js', () => ({
  loadCollectionListingCategoryOptions: vi.fn(async () => []),
  loadCollectionListingWarehouses: vi.fn(async () => []),
  loadCollectionListingAttributeSchema: vi.fn(async () => ({ definitions: [], optionsByAttributeId: {} })),
  loadCollectionListingCategoryTemplate: vi.fn(async () => ({ definitions: [], optionsByAttributeId: {} })),
  resolveCollectedProductCategory: vi.fn(async () => null),
  searchCollectionListingAttributeOptions: vi.fn(async () => []),
  shouldReplaceAutoCollectedProductCategory: vi.fn(() => false),
}));

import { useCollectionProductListingWorkflow } from './useCollectionProductListingWorkflow.js';

describe('collection listing image Skill workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generatedImageService.hydrate.mockImplementation(async (value) => value);
    generatedImageService.persist.mockImplementation(async (value) => ({ selections: value, replacements: new Map() }));
    imageSkillService.run.mockImplementation(async (_input, options) => {
      options.onPhase({ phase: 'planning', message: '正在按 Skill 规划…' });
      options.onPhase({ phase: 'generating', message: '正在按逐图规则生图…' });
      options.onItemSettled({
        sourceIndex: 0, status: 'success', imageUrl: 'https://img.example/generated.png',
        taskId: 'task-a', persistenceStatus: 'pending',
      });
      setTimeout(() => options.onItemSettled({
        sourceIndex: 0, status: 'success', imageUrl: 'https://oss.example/generated.png',
        assetId: 'asset-a', taskId: 'task-a', persistenceStatus: 'completed',
      }), 0);
      return {
        count: 1,
        successCount: 1,
        failedCount: 0,
        items: [{
          sourceIndex: 0, status: 'success', imageUrl: 'https://img.example/generated.png',
          taskId: 'task-a', persistenceStatus: 'pending',
        }],
      };
    });
  });

  it('passes the exact shop, Skill rules, planner model and image model through the generation chain', async () => {
    const imageSkill = {
      id: 'ozon-product-image-generation',
      promptConfig: { plannerModelId: 'planner-a', imageModelId: 'image-a' },
    };
    const product = {
      id: '1688:image-skill',
      sourceProductId: 'image-skill',
      sourceUrl: 'https://detail.1688.com/offer/image-skill.html',
      title: '眼镜',
      skus: [{ id: 'black', name: '黑色' }],
      mainImages: ['https://img.example/source.png'],
      ozonListingDrafts: {
        'shop-a': { shopId: 'shop-a', title: 'Русское название товара' },
      },
    };
    const onPersist = vi.fn();
    const { result } = renderHook(() => useCollectionProductListingWorkflow({
      product,
      shops: [{ id: 'shop-a' }],
      activeShopId: 'shop-a',
      textModelId: 'auto',
      textModelOptions: [{ id: 'planner-a', accountId: 'text-account', model: 'text-model', ready: true }],
      imageModelOptions: [{ id: 'image-a', accountId: 'image-account', model: 'image-model', ready: true }],
      imageSkill,
      onPersist,
    }));
    await waitFor(() => expect(result.current.draft.shopId).toBe('shop-a'));

    await act(async () => {
      await result.current.generateImages({
        group: 'main',
        rows: [{ imageUrl: 'https://img.example/source.png', label: '主图 1' }],
        selectedIndexes: [0],
        editorSettings: { imageModelId: 'auto', imageSize: '1008x1344', imageQuality: 'high' },
      });
    });

    expect(imageSkillService.run).toHaveBeenCalledWith(expect.objectContaining({
      skill: imageSkill,
      shopId: 'shop-a',
      productTitle: 'Русское название товара',
      productKey: 'image-skill',
      productImageUrl: 'https://img.example/source.png',
      productImageUrls: ['https://img.example/source.png'],
      sourceImageIndexes: [0],
      count: 1,
      draft: expect.objectContaining({ title: 'Русское название товара' }),
      plannerModelSelection: expect.objectContaining({ accountId: 'text-account', model: 'text-model' }),
      modelSelection: expect.objectContaining({ accountId: 'image-account', model: 'image-model' }),
      allowPaidFallback: false,
    }), expect.objectContaining({
      onPhase: expect.any(Function),
      onItemSettled: expect.any(Function),
    }));
    expect(result.current.generationState).toMatchObject({
      status: 'success',
      phase: 'complete',
      message: 'Skill 已完成：成功生成 1 张图片。',
    });
    expect(result.current.draft.images).toContain('https://img.example/generated.png');
    expect(result.current.draft.generatedImageSelections.main).toMatchObject({
      historyEntryId: expect.stringMatching(/^collection-image-/u),
      items: [expect.objectContaining({ sourceIndex: 0 })],
    });
    await waitFor(() => expect(result.current.imageHistory).toMatchObject({ imageCount: 1, batchCount: 1 }));
    await waitFor(() => expect(result.current.imageHistory.entries[0].items[0]).toMatchObject({
      assetId: 'asset-a',
      persistenceStatus: 'completed',
    }));
    expect(result.current.imageHistory.entries[0]).toMatchObject({
      shopId: 'shop-a',
      productKey: '1688:image-skill',
      sourceUrl: 'https://detail.1688.com/offer/image-skill.html',
    });
    expect(onPersist).toHaveBeenCalledWith('1688:image-skill', expect.objectContaining({
      ozonListingDrafts: expect.objectContaining({
        'shop-a': expect.objectContaining({ imageGenerationHistory: expect.any(Array) }),
      }),
    }));

    act(() => {
      const restored = result.current.restoreImageHistoryBatch({
        ...result.current.imageHistory.entries[0],
        items: [{
          ...result.current.imageHistory.entries[0].items[0],
          previewUrl: 'https://private.example/restored.png',
          imageUrl: 'https://private.example/restored.png',
        }],
      });
      expect(restored).toMatchObject({ ok: true, group: 'main', sourceIndexes: [0] });
    });
    expect(result.current.generationState.itemsByGroup.main[0]).toMatchObject({
      sourceIndex: 0,
      status: 'success',
      imageUrl: 'https://private.example/restored.png',
      restoredFromHistory: true,
    });
    expect(result.current.draft.generatedImageSelections.main.items[0]).toMatchObject({
      sourceIndex: 0,
      imageUrl: 'https://private.example/restored.png',
    });
  });

  it('restores saved generated slots when the same product editor is opened again', async () => {
    const product = {
      id: '1688:saved-images',
      sourceProductId: 'saved-images',
      title: '已保存图片商品',
      mainImages: ['https://img.example/source.png'],
      ozonListingDrafts: {
        'shop-a': {
          shopId: 'shop-a',
          generatedImageSelections: {
            main: {
              historyEntryId: 'saved-batch',
              items: [{
                sourceIndex: 0,
                assetId: 'permanent-asset',
                imageUrl: '/api/product-images/preview/permanent-asset?shopId=shop-a',
                previewUrl: 'https://oss.example/signed-saved.png',
                storageScope: 'permanent',
                persistenceStatus: 'completed',
              }],
            },
          },
        },
      },
    };
    const { result } = renderHook(() => useCollectionProductListingWorkflow({
      product,
      shops: [{ id: 'shop-a' }],
      activeShopId: 'shop-a',
    }));

    await waitFor(() => expect(result.current.generationState.itemsByGroup.main?.[0]).toMatchObject({
      sourceIndex: 0,
      assetId: 'permanent-asset',
      imageUrl: '/api/product-images/preview/permanent-asset?shopId=shop-a',
      previewUrl: 'https://oss.example/signed-saved.png',
      restoredFromDraft: true,
    }));
    expect(generatedImageService.hydrate).toHaveBeenCalledWith(
      expect.objectContaining({ main: expect.any(Object) }),
      expect.objectContaining({ shopId: 'shop-a' }),
    );
  });

  it('shows the first real slot error and lets automatic image selection use the built-in fallback', async () => {
    imageSkillService.run.mockResolvedValueOnce({
      count: 2,
      successCount: 0,
      failedCount: 2,
      fallbackCount: 0,
      items: [
        { sourceIndex: 0, status: 'error', message: 'API Key 不存在或已被停用' },
        { sourceIndex: 1, status: 'error', message: 'API Key 不存在或已被停用' },
      ],
    });
    const product = {
      id: '1688:image-errors',
      title: '眼镜',
      mainImages: ['https://img.example/1.png', 'https://img.example/2.png'],
    };
    const { result } = renderHook(() => useCollectionProductListingWorkflow({
      product,
      shops: [{ id: 'shop-a' }],
      activeShopId: 'shop-a',
      textModelOptions: [{ id: 'auto', accountId: 'text-account', model: 'text-model', ready: true }],
      imageModelOptions: [{ id: 'auto', accountId: 'image-account', model: 'gpt-image-2', ready: true }],
      imageSkill: { id: 'ozon-product-image-generation', promptConfig: { imageModelId: 'auto' } },
    }));
    await waitFor(() => expect(result.current.draft.shopId).toBe('shop-a'));

    await act(async () => {
      await result.current.generateImages({
        group: 'main',
        rows: product.mainImages.map((imageUrl) => ({ imageUrl })),
        selectedIndexes: [0, 1],
        editorSettings: { imageModelId: 'auto' },
      });
    });

    expect(imageSkillService.run).toHaveBeenCalledWith(expect.objectContaining({ allowPaidFallback: true }), expect.any(Object));
    expect(result.current.generationState).toMatchObject({
      status: 'partial',
      error: '2 张生成失败：API Key 不存在或已被停用',
    });
  });

  it('does not reuse an old generated image when the same requested position fails', async () => {
    imageSkillService.run.mockImplementationOnce(async (_input, options) => {
      const items = [
        { sourceIndex: 0, status: 'success', imageUrl: 'https://img.example/new-zero.png' },
        { sourceIndex: 1, status: 'error', message: '第二张生成失败' },
      ];
      items.forEach(options.onItemSettled);
      return { count: 2, successCount: 1, failedCount: 1, items };
    });
    const product = {
      id: '1688:replace-failed-slot',
      title: '汽车脚垫',
      mainImages: ['https://img.example/source-zero.png', 'https://img.example/source-one.png'],
      ozonListingDrafts: {
        'shop-a': {
          shopId: 'shop-a',
          generatedImageSelections: {
            main: {
              historyEntryId: 'old-batch',
              items: [
                { sourceIndex: 0, imageUrl: 'https://img.example/old-zero.png' },
                { sourceIndex: 1, imageUrl: 'https://img.example/old-one.png' },
              ],
            },
          },
        },
      },
    };
    const { result } = renderHook(() => useCollectionProductListingWorkflow({
      product,
      shops: [{ id: 'shop-a' }],
      activeShopId: 'shop-a',
      textModelOptions: [{ id: 'auto', accountId: 'text-account', model: 'text-model', ready: true }],
      imageModelOptions: [{ id: 'auto', accountId: 'image-account', model: 'gpt-image-2', ready: true }],
      imageSkill: { id: 'ozon-product-image-generation', promptConfig: { imageModelId: 'auto' } },
    }));
    await waitFor(() => expect(result.current.draft.shopId).toBe('shop-a'));

    await act(async () => result.current.generateImages({
      group: 'main',
      rows: product.mainImages.map((imageUrl) => ({ imageUrl })),
      selectedIndexes: [0, 1],
      editorSettings: { imageModelId: 'auto' },
    }));

    expect(result.current.draft.generatedImageSelections.main.items).toEqual([
      expect.objectContaining({ sourceIndex: 0, imageUrl: 'https://img.example/new-zero.png' }),
    ]);
    expect(result.current.draft.images).not.toContain('https://img.example/old-one.png');
  });

  it('keeps generated history on the hidden source shop when upload targets change', async () => {
    let settleItem;
    imageSkillService.run.mockImplementationOnce(async (_input, options) => {
      settleItem = options.onItemSettled;
      options.onItemSettled({
        sourceIndex: 0, status: 'success', imageUrl: 'https://provider.example/pending.png',
        taskId: 'task-late', persistenceStatus: 'pending',
      });
      return {
        count: 1, successCount: 1, failedCount: 0,
        items: [{
          sourceIndex: 0, status: 'success', imageUrl: 'https://provider.example/pending.png',
          taskId: 'task-late', persistenceStatus: 'pending',
        }],
      };
    });
    const product = {
      id: '1688:late-shop', sourceProductId: 'late-shop', sourceUrl: 'https://detail.1688.com/offer/late-shop.html',
      title: '眼镜', mainImages: ['https://img.example/source.png'],
    };
    const { result } = renderHook(() => useCollectionProductListingWorkflow({
      product,
      shops: [{ id: 'shop-a' }, { id: 'shop-b' }],
      activeShopId: 'shop-a',
      textModelOptions: [{ id: 'auto', accountId: 'text-account', model: 'text-model', ready: true }],
      imageModelOptions: [{ id: 'auto', accountId: 'image-account', model: 'image-model', ready: true }],
      imageSkill: { id: 'ozon-product-image-generation', promptConfig: { imageModelId: 'auto' } },
    }));
    await waitFor(() => expect(result.current.draft.shopId).toBe('shop-a'));

    await act(async () => result.current.generateImages({
      group: 'main', rows: [{ imageUrl: 'https://img.example/source.png' }], selectedIndexes: [0],
      editorSettings: { imageModelId: 'auto' },
    }));
    expect(result.current.imageHistory.imageCount).toBe(1);

    act(() => result.current.updateUploadShopIds(['shop-b']));
    expect(result.current.draft).toMatchObject({ shopId: 'shop-a', uploadShopIds: ['shop-b'] });
    expect(result.current.imageHistory).toMatchObject({ shopId: 'shop-a', imageCount: 1 });
    act(() => settleItem({
      sourceIndex: 0, status: 'success', imageUrl: 'https://oss.example/late.png',
      assetId: 'asset-late', taskId: 'task-late', persistenceStatus: 'completed',
    }));
    expect(result.current.imageHistory).toMatchObject({ shopId: 'shop-a', imageCount: 1 });
    expect(result.current.imageHistory.entries[0].items[0]).toMatchObject({ assetId: 'asset-late' });
  });

  it('refuses to restore image history from another shop or product', async () => {
    const product = {
      id: '1688:current-product',
      title: '眼镜',
      mainImages: ['https://img.example/source.png'],
    };
    const { result } = renderHook(() => useCollectionProductListingWorkflow({
      product,
      shops: [{ id: 'shop-a' }, { id: 'shop-b' }],
      activeShopId: 'shop-a',
    }));
    await waitFor(() => expect(result.current.draft.shopId).toBe('shop-a'));

    let restored;
    act(() => {
      restored = result.current.restoreImageHistoryBatch({
        id: 'foreign-history',
        shopId: 'shop-b',
        productKey: '1688:other-product',
        group: 'main',
        createdAt: new Date().toISOString(),
        items: [{ sourceIndex: 0, imageUrl: 'https://private.example/foreign.png' }],
      });
    });

    expect(restored.ok).toBe(false);
    expect(result.current.generationState).toMatchObject({ status: 'error', phase: 'error' });
  });

  it('builds the upload payload from explicit source selections and removes only the generated slot', async () => {
    const product = {
      id: '1688:selection-controls',
      sourceProductId: 'selection-controls',
      title: '眼镜',
      mainImages: ['https://img.example/source-a.png', 'https://img.example/source-b.png'],
    };
    const { result } = renderHook(() => useCollectionProductListingWorkflow({
      product,
      shops: [{ id: 'shop-a' }],
      activeShopId: 'shop-a',
      imageSkill: { id: 'ozon-product-image-generation', promptConfig: { imageModelId: 'auto' } },
    }));
    await waitFor(() => expect(result.current.draft.shopId).toBe('shop-a'));

    act(() => {
      result.current.updateOriginalImageSelection({
        group: 'main', sourceIndex: 1, sourceImageUrl: product.mainImages[1], selected: true,
        sourceProduct: product,
      });
    });
    expect(result.current.draft.images).toEqual([product.mainImages[1]]);

    await act(async () => {
      await result.current.generateImages({
        group: 'main', rows: product.mainImages.map((imageUrl) => ({ imageUrl })), selectedIndexes: [0],
        sourceProduct: product, editorSettings: { imageModelId: 'auto' },
      });
    });
    expect(result.current.draft.images).toEqual([
      'https://img.example/generated.png', product.mainImages[1],
    ]);

    act(() => result.current.updateGeneratedImageSelection({
      group: 'main', sourceIndex: 0, imageUrl: 'https://img.example/generated.png', selected: false,
      sourceProduct: product,
    }));
    expect(result.current.draft.images).toEqual([product.mainImages[1]]);
    await waitFor(() => expect(result.current.generationState.itemsByGroup.main).toEqual([
      expect.objectContaining({ sourceIndex: 0, status: 'success' }),
    ]));

    const visibleGeneratedImage = result.current.generationState.itemsByGroup.main[0];
    act(() => result.current.updateGeneratedImageSelection({
      group: 'main', ...visibleGeneratedImage, selected: true, sourceProduct: product,
    }));
    expect(result.current.draft.images).toEqual([
      visibleGeneratedImage.imageUrl, product.mainImages[1],
    ]);

    act(() => result.current.removeGeneratedImage({ group: 'main', sourceIndex: 0, imageUrl: 'https://img.example/generated.png', sourceProduct: product }));
    expect(result.current.draft.images).toEqual([product.mainImages[1]]);
    expect(result.current.generationState.itemsByGroup.main).toEqual([]);
  });
});
