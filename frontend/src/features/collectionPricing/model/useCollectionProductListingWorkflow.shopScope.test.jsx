import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useCollectionProductListingWorkflow } from './useCollectionProductListingWorkflow.js';

vi.mock('../services/collectionListingCatalogService.js', () => ({
  loadCollectionListingCategoryOptions: vi.fn(async () => []),
  loadCollectionListingWarehouses: vi.fn(async () => []),
  loadCollectionListingAttributeSchema: vi.fn(async () => ({ definitions: [], optionsByAttributeId: {} })),
  loadCollectionListingCategoryTemplate: vi.fn(async () => ({ definitions: [], optionsByAttributeId: {} })),
  resolveCollectedProductCategory: vi.fn(async () => null),
  searchCollectionListingAttributeOptions: vi.fn(async () => []),
  shouldReplaceAutoCollectedProductCategory: vi.fn(() => false),
}));

describe('collection listing shop isolation', () => {
  it('keeps the product master fixed while upload target shops change independently', async () => {
    const onPersist = vi.fn();
    const product = {
      id: '1688:shop-scope', title: '来源标题', currency: 'CNY', purchasePrice: '10',
      skus: [{ id: 'default', name: '默认款' }],
      ozonListingDraft: {
        shopId: 'shop-a', uploadShopIds: ['shop-a'], title: '商品主稿',
        descriptionCategoryId: '100', typeId: '10', categorySelectionSource: 'manual',
        attributeValues: { brand: { value: '无品牌' } },
        pricingDraft: { purchaseCost: '10', firstMileCost: '3' },
      },
      ozonListingDrafts: {
        'shop-a': { shopId: 'shop-a', title: 'A 原稿', pricingDraft: { purchaseCost: '10', firstMileCost: '3' } },
        'shop-b': { shopId: 'shop-b', title: 'B 原稿', pricingDraft: { purchaseCost: '10', firstMileCost: '7' } },
      },
    };
    const { result } = renderHook(() => useCollectionProductListingWorkflow({
      product,
      shops: [{ id: 'shop-a' }, { id: 'shop-b' }, { id: 'shop-new' }],
      activeShopId: 'shop-b',
      onPersist,
    }));
    await waitFor(() => expect(result.current.draft.shopId).toBe('shop-a'));

    expect(result.current.draft).toMatchObject({
      shopId: 'shop-a', title: '商品主稿', descriptionCategoryId: '100', typeId: '10',
      attributeValues: { brand: { value: '无品牌' } },
    });
    act(() => result.current.update({ title: '商品修改稿', pricingDraft: { ...result.current.draft.pricingDraft, firstMileCost: '4' } }));
    act(() => result.current.update({ shopId: 'shop-b' }));
    expect(result.current.draft).toMatchObject({ shopId: 'shop-a', title: '商品修改稿', pricingDraft: { firstMileCost: '4' } });
    act(() => result.current.updateUploadShopIds(['shop-b', 'shop-new']));
    expect(result.current.draft).toMatchObject({
      shopId: 'shop-a', uploadShopIds: ['shop-b', 'shop-new'], title: '商品修改稿',
      descriptionCategoryId: '100', typeId: '10', attributeValues: { brand: { value: '无品牌' } },
    });
    act(() => result.current.persist());
    expect(onPersist).toHaveBeenCalledWith('1688:shop-scope', expect.objectContaining({
      ozonListingDraft: expect.objectContaining({ shopId: 'shop-a', uploadShopIds: ['shop-b', 'shop-new'], title: '商品修改稿' }),
      ozonListingDrafts: expect.objectContaining({ 'shop-a': expect.any(Object) }),
    }));
  });
});
