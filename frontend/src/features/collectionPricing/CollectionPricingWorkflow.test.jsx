import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CollectionPricingPage,
  resolveCollectionPricingOwnerScopeKey,
} from './CollectionPricingPage.jsx';
import {
  captureCurrentCollectionProduct,
  collectCollectionProductFromLink,
} from './services/collectionBrowserService.js';
import {
  publishCollectionBrowserCapture,
  resetCollectionBrowserCaptureInboxForTests,
} from './services/collectionBrowserCaptureInbox.js';

const draftStore = vi.hoisted(() => ({
  load: vi.fn(async () => []),
  save: vi.fn(async () => ({})),
}));

const productWrites = vi.hoisted(() => ({
  preview: vi.fn(),
  confirm: vi.fn(),
  release: vi.fn(),
}));

const productImageAssets = vi.hoisted(() => ({
  importImage: vi.fn(),
  promoteImage: vi.fn(),
  readPreviews: vi.fn(),
}));

vi.mock('./services/collectionPricingDraftStore.js', () => ({
  COLLECTION_PRICING_DRAFT_LIMIT: 500,
  loadCollectionPricingDraft: draftStore.load,
  saveCollectionPricingDraft: draftStore.save,
}));

vi.mock('./services/collectionPricingQuoteService.js', () => ({
  requestCollectionPricingQuote: vi.fn(),
  requestCollectionSkuPricingQuotes: vi.fn(),
}));

vi.mock('./services/collectionBrowserService.js', () => ({
  openCollectionSourceInBrowser: vi.fn(),
  captureCurrentCollectionProduct: vi.fn(),
  collectCollectionProductFromLink: vi.fn(),
  getCollectionBrowserErrorMessage: (error) => error?.message || '内置浏览器失败',
}));

vi.mock('./services/collectionListingCatalogService.js', () => ({
  loadCollectionListingCategoryOptions: vi.fn(async () => [{
    descriptionCategoryId: '17028669', typeId: '971', name: '玩具汽车', pathText: '儿童用品 / 玩具 / 玩具汽车',
  }]),
  resolveCollectedProductCategory: vi.fn(async () => ({
    descriptionCategoryId: '17028669', typeId: '971', name: '玩具汽车', pathText: '儿童用品 / 玩具 / 玩具汽车',
  })),
  shouldReplaceAutoCollectedProductCategory: vi.fn(({
    currentDraft = {}, recommendation = null, selectionSource = '',
  } = {}) => (
    selectionSource !== 'manual'
    && recommendation?.typeId
    && (
      String(currentDraft.typeId || '') !== String(recommendation.typeId)
      || String(currentDraft.descriptionCategoryId || '') !== String(recommendation.descriptionCategoryId)
    )
  )),
  loadCollectionListingAttributeSchema: vi.fn(async () => ({
    definitions: [{ id: '100', name: '颜色', is_required: false, isAspect: false, isDictionary: false }],
    optionsByAttributeId: {},
  })),
  loadCollectionListingCategoryTemplate: vi.fn(async () => ({
    shopId: 'shop-1',
    descriptionCategoryId: '17028669',
    typeId: '971',
    categoryName: '玩具汽车',
    categoryPath: '儿童用品 / 玩具 / 玩具汽车',
    definitions: [{ id: '100', name: '颜色', is_required: false, isAspect: false, isDictionary: false }],
    optionsByAttributeId: {},
    dictionaryLoadedIds: [],
    dictionaryFailedIds: [],
    source: 'test',
    warning: '',
  })),
  loadCollectionListingWarehouses: vi.fn(async () => [{ id: 'warehouse-1', rawId: '12345', name: '莫斯科仓' }]),
  searchCollectionListingAttributeOptions: vi.fn(async () => []),
}));

vi.mock('../products/services/productImageAssetService.js', async (importOriginal) => ({
  ...await importOriginal(),
  importProductImage: productImageAssets.importImage,
  promoteProductImage: productImageAssets.promoteImage,
  readProductImageAssetPreviews: productImageAssets.readPreviews,
}));

vi.mock('../../services/productWriteClient.js', () => ({
  previewProductWrite: productWrites.preview,
  confirmProductWrite: productWrites.confirm,
  releaseProductWritePreview: productWrites.release,
}));

beforeEach(() => {
  captureCurrentCollectionProduct.mockReset();
  collectCollectionProductFromLink.mockReset();
  resetCollectionBrowserCaptureInboxForTests();
  draftStore.load.mockReset().mockResolvedValue([]);
  draftStore.save.mockReset().mockResolvedValue({});
  productImageAssets.importImage.mockReset().mockImplementation(async (input = {}) => ({
    asset: {
      id: `temporary-${String(input.sourceUrl || input.dataBase64 || 'image').length}`,
      storageScope: 'temporary',
    },
  }));
  productImageAssets.promoteImage.mockReset().mockImplementation(async (input = {}) => ({
    provenanceProtected: true,
    asset: {
      id: `watermarked-${input.assetId || 'image'}`,
      storageScope: 'permanent',
      variant: 'provenance-watermarked',
      ozonUrl: `https://oss.example/${input.assetId || 'image'}-watermarked.png`,
    },
  }));
  productImageAssets.readPreviews.mockReset().mockResolvedValue([]);
  productWrites.preview.mockReset().mockResolvedValue({ ok: true, previewId: 'preview-1' });
  productWrites.confirm.mockReset().mockResolvedValue({
    ok: true, writeConnected: true, writeStatus: 'readback_merged', readBack: { status: 'merged' },
  });
  productWrites.release.mockReset().mockResolvedValue({ ok: true, released: true });
});

describe('manual collection list workflow', () => {
  it('uses only the stable software user id for collection ownership', () => {
    expect(resolveCollectionPricingOwnerScopeKey({
      user: { id: 51, email: 'owner@example.com', username: 'owner-name' },
    })).toBe('51');
    expect(resolveCollectionPricingOwnerScopeKey({
      user: { userId: 'stable-user', email: 'owner@example.com' },
    })).toBe('stable-user');
    expect(resolveCollectionPricingOwnerScopeKey({
      user: { email: 'owner@example.com', username: 'owner-name' },
    })).toBe('');
  });

  it('receives toolbar capture into the list without populating optimization or listing fields', async () => {
    render(<CollectionPricingPage shops={[{ id: 'shop-1', name: '测试店铺' }]} activeShopId="shop-1" />);
    act(() => {
      publishCollectionBrowserCapture({
        platform: '1688',
        pageType: 'product',
        sourceUrl: 'https://detail.1688.com/offer/789.html',
        sourceProductId: '789',
        productTitle: '工具栏采集商品',
        purchasePrice: 35.5,
        currency: 'CNY',
        mainImages: ['https://img.example/product/item-main.jpg'],
        skuImages: [{ skuId: 'black', skuName: '黑色', imageUrl: 'https://img.example/product/black.jpg' }],
        detailImages: ['https://img.example/product/detail.jpg'],
        skus: [{ id: 'black', name: '黑色', price: 35.5, imageUrl: 'https://img.example/product/black.jpg' }],
      });
    });

    expect(await screen.findByText('工具栏采集商品')).toBeInTheDocument();
    expect(screen.getByText(/已从浏览器加入采集列表/u)).toBeInTheDocument();
    expect(screen.getByText('主图 1')).toBeInTheDocument();
    expect(screen.getByText('SKU 图 1')).toBeInTheDocument();
    expect(screen.getByText('详情图 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑：工具栏采集商品' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开来源：工具栏采集商品' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除：工具栏采集商品' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '工具栏采集商品' })).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(screen.queryByLabelText(/采购成本/u)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '生成上架预览' })).not.toBeInTheDocument();
  });

  it('edits a collected product from the directly visible row action', async () => {
    render(<CollectionPricingPage />);
    act(() => publishCollectionBrowserCapture({
      platform: '1688',
      pageType: 'product',
      sourceUrl: 'https://detail.1688.com/offer/789.html',
      sourceProductId: '789',
      productTitle: '编辑前标题',
      purchasePrice: 35.5,
      currency: 'CNY',
      mainImages: ['https://img.example/product/item-main.jpg'],
      skus: [{ id: 'black', name: '黑色', price: 35.5 }],
    }));

    fireEvent.click(await screen.findByRole('button', { name: '编辑：编辑前标题' }));
    fireEvent.change(screen.getByLabelText(/商品标题/u), { target: { value: '编辑后标题' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    expect(await screen.findByText('编辑后标题')).toBeInTheDocument();
    expect(screen.getByText('采集商品已更新。')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /编辑采集商品/u })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '已保存' })).toBeInTheDocument();
  });

  it('deletes a collected product directly from the outer list and persists the removal', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CollectionPricingPage />);
    act(() => publishCollectionBrowserCapture({
      platform: '1688',
      pageType: 'product',
      sourceUrl: 'https://detail.1688.com/offer/790.html',
      sourceProductId: '790',
      productTitle: '待删除商品',
      purchasePrice: 18.8,
      currency: 'CNY',
      mainImages: ['https://img.example/product/delete.jpg'],
      skus: [{ id: 'default', name: '默认款', price: 18.8 }],
    }));

    fireEvent.click(await screen.findByRole('button', { name: '删除：待删除商品' }));
    expect(window.confirm).toHaveBeenCalledWith('确定删除“待删除商品”吗？');
    await waitFor(() => expect(screen.queryByText('待删除商品')).not.toBeInTheDocument());
    await waitFor(() => expect(draftStore.save).toHaveBeenLastCalledWith([], 'local-default'));
  });

  it('runs the ordered setup-to-readback workflow and only completes after merged Ozon readback', async () => {
    render(<CollectionPricingPage shops={[{ id: 'shop-1', name: '测试店铺' }]} activeShopId="shop-1" />);
    act(() => publishCollectionBrowserCapture({
      platform: '1688', pageType: 'product', sourceUrl: 'https://detail.1688.com/offer/777.html', sourceProductId: '777',
      productTitle: '遥控汽车', purchasePrice: 35.5, currency: 'CNY', weightG: 500,
      packageLengthCm: 25, packageWidthCm: 14, packageHeightCm: 10,
      mainImages: ['https://img.example/product/car.jpg'],
      skus: [
        { id: 'red', name: '红色', price: 35.5 },
        { id: 'blue', name: '蓝色', price: 36.5 },
      ],
    }));

    fireEvent.click(await screen.findByRole('button', { name: '编辑：遥控汽车' }));
    let editor = screen.getByRole('dialog', { name: /编辑采集商品/u });
    expect(within(editor).getByRole('heading', { name: '类目与商品信息' })).toBeInTheDocument();
    fireEvent.click(await within(editor).findByRole('button', { name: '完整类目库' }));
    const categoryPicker = screen.getByRole('dialog', { name: /^选择 Ozon 类目/u });
    fireEvent.change(within(categoryPicker).getByLabelText('搜索类目名称'), { target: { value: '玩具汽车' } });
    fireEvent.click(within(categoryPicker).getByRole('button', { name: '儿童用品 / 玩具 / 玩具汽车' }));
    await waitFor(() => expect(within(categoryPicker).getByRole('button', { name: '确认选择' })).toBeEnabled());
    fireEvent.click(within(categoryPicker).getByRole('button', { name: '确认选择' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^选择 Ozon 类目/u })).not.toBeInTheDocument());
    editor = await screen.findByRole('dialog', { name: /编辑采集商品/u });
    await within(editor).findByText('儿童用品 / 玩具 / 玩具汽车');
    fireEvent.change(within(editor).getByLabelText(/Ozon 商品标题/u), { target: { value: 'Радиоуправляемая машина' } });
    fireEvent.click(within(editor).getByRole('button', { name: '下一步' }));
    expect(within(editor).getByText('图片工作区')).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('checkbox', { name: '上传原图：主图 1' }));
    fireEvent.click(within(editor).getByRole('button', { name: '下一步' }));
    expect(within(editor).getByRole('heading', { name: '设置 SKU 和人民币销售价' })).toBeInTheDocument();
    for (const index of [1, 2]) {
      fireEvent.change(within(editor).getByLabelText(`人民币销售价 ${index}`), { target: { value: String(99 + index) } });
      fireEvent.change(within(editor).getByLabelText(`人民币划线价 ${index}`), { target: { value: String(159 + index) } });
      fireEvent.change(within(editor).getByLabelText(`人民币最低价 ${index}`), { target: { value: '70' } });
    }
    fireEvent.click(within(editor).getByRole('button', { name: '下一步' }));
    expect(within(editor).queryByRole('button', { name: '生成上架预览' })).not.toBeInTheDocument();
    await waitFor(() => expect(productWrites.preview).toHaveBeenCalledTimes(2));
    expect(await within(editor).findByText(/共 2 个 SKU/u)).toBeInTheDocument();
    const confirmation = within(editor).getByRole('checkbox', { name: /我已核对 1 个上传店铺/u });
    fireEvent.click(confirmation);
    await waitFor(() => expect(confirmation).toBeChecked(), { timeout: 5_000 });
    await waitFor(() => expect(within(editor).getByRole('button', { name: '上传到 1 个店铺' })).toBeEnabled(), { timeout: 5_000 });
    fireEvent.click(within(editor).getByRole('button', { name: '上传到 1 个店铺' }));
    await waitFor(() => expect(productWrites.confirm).toHaveBeenCalledTimes(2));
    expect(await within(editor).findByText('1 个店铺均已通过 Ozon 回读校验。')).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('button', { name: '取消' }));
    expect(await screen.findByText('已上传')).toBeInTheDocument();
    expect(screen.getByText('测试店铺')).toBeInTheDocument();
  }, 45_000);

  it('uses the full image, attribute and SKU workbench and persists SKU edits', async () => {
    const skus = Array.from({ length: 12 }, (_, index) => ({
      id: `sku-${index + 1}`,
      name: `规格 ${index + 1}`,
      price: 8.4,
      imageUrl: `https://img.example/product/sku-${index + 1}.jpg`,
    }));
    render(<CollectionPricingPage />);
    act(() => publishCollectionBrowserCapture({
      platform: '1688', pageType: 'product', sourceUrl: 'https://detail.1688.com/offer/789.html', sourceProductId: '789',
      productTitle: '工作台编辑商品', purchasePrice: 8.4, currency: 'CNY',
      purchasePriceMin: 3.3, purchasePriceMax: 8.4,
      sourceCategoryId: '1033155', sourceCategoryName: '平光镜', sourceCategoryPath: '服饰配件、饰品 / 平光镜',
      weightG: 50, weightMinG: 50, weightMaxG: 50,
      shippingStatus: 'starting', shippingFeeMin: 3, shippingRuleText: '运费 ¥3 起，按收货地区结算',
      minimumOrderQuantity: 1, minimumOrderUnit: '副', mixedBatchStatus: 'unknown',
      deliveryLeadTimeHours: 48,
      mainImages: ['https://img.example/product/main.jpg'],
      skuImages: skus.map((sku) => ({ skuId: sku.id, skuName: sku.name, imageUrl: sku.imageUrl })),
      detailImages: ['https://img.example/product/detail.jpg'],
      attributes: [{ name: '材质', value: '金属' }], skus,
    }));

    fireEvent.click(await screen.findByRole('button', { name: '编辑：工作台编辑商品' }));
    const editor = screen.getByRole('dialog', { name: /编辑采集商品/u });
    expect(within(editor).getByLabelText('分析 / 文案模型')).toBeInTheDocument();
    expect(within(editor).getByLabelText('最低采购价')).toHaveValue('3.3');
    expect(within(editor).getByLabelText('最高采购价')).toHaveValue('8.4');
    expect(within(editor).getByLabelText('统一重量（g）')).toHaveValue('50');
    expect(within(editor).getByLabelText('来源类目')).toHaveValue('服饰配件、饰品 / 平光镜');
    expect(within(editor).getByText(/运费 ¥3 起/u)).toBeInTheDocument();
    expect(within(editor).getByTestId('shipping-rule-value')).toHaveTextContent('运费起步价');
    expect(within(editor).getByTestId('shipping-fee-value')).toHaveTextContent('3');
    expect(within(editor).getByTestId('delivery-hours-value')).toHaveTextContent('48');
    expect(within(editor).getByTestId('minimum-order-value')).toHaveTextContent('1');
    expect(within(editor).getByTestId('minimum-order-unit-value')).toHaveTextContent('副');
    expect(within(editor).getByTestId('mixed-batch-value')).toHaveTextContent('混批待确认');
    expect(within(editor).getByTestId('source-category-id-value')).toHaveTextContent('1033155');
    expect(within(editor).queryByLabelText('运费规则')).not.toBeInTheDocument();
    expect(within(editor).queryByLabelText('最低运费（¥）')).not.toBeInTheDocument();
    expect(within(editor).queryByLabelText('发货时效（小时）')).not.toBeInTheDocument();
    expect(within(editor).queryByLabelText('起批数量')).not.toBeInTheDocument();
    expect(within(editor).queryByLabelText('单位')).not.toBeInTheDocument();
    expect(within(editor).queryByLabelText('混批')).not.toBeInTheDocument();
    expect(within(editor).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(editor).queryByText('与智能工具的商品图生成共用模型配置')).not.toBeInTheDocument();
    expect(within(editor).queryByText('供应平台原始类目；Ozon 类目在上架步骤单独选择。')).not.toBeInTheDocument();
    expect(within(editor).queryByText(/可按 1副 起批/u)).not.toBeInTheDocument();
    expect(within(editor).queryByText(/保存后更新本地采集草稿/u)).not.toBeInTheDocument();
    expect(within(editor).getByRole('tab', { name: /图片/u })).toBeInTheDocument();
    expect(within(editor).getByText('生成结果与上传')).toBeInTheDocument();
    expect(within(editor).getByText('待生成 1')).toBeInTheDocument();
    expect(within(editor).getByTestId('source-image-grid')).toHaveAttribute('data-layout-rows', '2');
    expect(within(editor).getByTestId('pending-generation-grid')).toHaveAttribute('data-layout-rows', '2');
    const sourceImage = within(editor).getByAltText('主图 1');
    fireEvent.mouseEnter(sourceImage.closest('.collection-product-image-hover'));
    await waitFor(() => expect(document.body.querySelectorAll('img[alt="主图 1"]')).toHaveLength(2));
    fireEvent.mouseLeave(sourceImage.closest('.collection-product-image-hover'));
    await waitFor(() => expect(document.body.querySelectorAll('img[alt="主图 1"]')).toHaveLength(1));
    fireEvent.click(within(editor).getByRole('tab', { name: 'SKU 图 12' }));
    expect(await within(editor).findByText('生图参考 5 / 12')).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('button', { name: '全选' }));
    expect(within(editor).getByText('生图参考 12 / 12')).toBeInTheDocument();
    expect(within(editor).getByText('待生成 12')).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('button', { name: '取消全选' }));
    expect(within(editor).getByText('生图参考 0 / 12')).toBeInTheDocument();
    expect(within(editor).getByText('待选择 1')).toBeInTheDocument();
    expect(within(editor).getByText('待选择 10')).toBeInTheDocument();
    expect(within(editor).getByRole('tab', { name: /商品属性/u })).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('tab', { name: /SKU 编辑/u }));
    expect(within(editor).getByText('12 / 12 条')).toBeInTheDocument();
    fireEvent.change(within(editor).getByLabelText('SKU 价格 1'), { target: { value: '9.9' } });
    fireEvent.change(within(editor).getByLabelText('SKU 重量 1'), { target: { value: '55' } });
    fireEvent.click(within(editor).getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      const savedItems = draftStore.save.mock.calls.at(-1)?.[0] || [];
      expect(savedItems[0]?.skus?.[0]).toMatchObject({ id: 'sku-1', price: '9.9', weightG: '55' });
      expect(savedItems[0]?.skus).toHaveLength(12);
    });
  }, 45_000);

  it('restores collected products after restart and persists manual deletion', async () => {
    draftStore.load.mockResolvedValue([{
      platform: '1688', platformCode: '1688', pageType: 'product', sourceProductId: 'persisted-1',
      sourceUrl: 'https://detail.1688.com/offer/persisted-1.html', title: '重启后恢复商品',
      purchasePrice: '18.8', currency: 'CNY', mainImages: ['https://img.example/product/persisted.jpg'],
      skus: [{ id: 'persisted-sku', name: '默认款', price: '18.8' }], capturedAt: '2026-08-03T00:00:00.000Z',
    }]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<CollectionPricingPage />);
    expect(await screen.findByText('重启后恢复商品')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '编辑：重启后恢复商品' }));
    fireEvent.click(screen.getByRole('button', { name: '删除商品' }));

    expect(screen.queryByText('重启后恢复商品')).not.toBeInTheDocument();
    await waitFor(() => expect(draftStore.save).toHaveBeenLastCalledWith([], 'local-default'));
  });

  it('migrates legacy 1688 option dimensions and persists the one-to-one SKU mapping after load', async () => {
    draftStore.load.mockResolvedValue([{
      platform: '1688', platformCode: '1688', pageType: 'product', sourceProductId: '907805856885',
      sourceUrl: 'https://detail.1688.com/offer/907805856885.html', title: '6639感光变色眼镜框',
      purchasePrice: '8.4', currency: 'CNY', mainImages: ['https://img.example/product/glasses.jpg'],
      skus: Array.from({ length: 3 }, (_, index) => ({
        id: `sku-${index + 1}`, name: `规格 ${index + 1}`, price: '8.4',
        option: { length: 18, width: 8, height: 2, volume: 288, weight: 50 },
      })),
      capturedAt: '2026-08-03T00:00:00.000Z',
    }]);

    render(<CollectionPricingPage />);
    expect(await screen.findByText('6639感光变色眼镜框')).toBeInTheDocument();
    await waitFor(() => {
      const migrated = draftStore.save.mock.calls.at(-1)?.[0]?.[0];
      expect(migrated).toMatchObject({
        packageLengthCm: '18', packageWidthCm: '8', packageHeightCm: '2',
        packageDimensionEvidence: { source: 'sku-consensus', skuComparison: { allMatch: true } },
      });
      expect(migrated.skus).toHaveLength(3);
      expect(migrated.skus.every((sku) => (
        sku.packageLengthCm === '18' && sku.packageWidthCm === '8' && sku.packageHeightCm === '2'
      ))).toBe(true);
    });
  });

  it('supports pasted-link collection as the second manual entry', async () => {
    collectCollectionProductFromLink.mockResolvedValue({
      tabId: 'link-tab',
      product: {
        platform: '1688', platformCode: '1688', pageType: 'product', sourceProductId: '456',
        sourceUrl: 'https://detail.1688.com/offer/456.html', title: '链接商品', description: '商品描述', variant: '',
        purchasePrice: '29.9', currency: 'CNY', weightG: '400', packageLengthCm: '20', packageWidthCm: '12', packageHeightCm: '8',
        mainImages: ['https://img.example/product/1.jpg'], skuImages: [], detailImages: [],
        skus: [{ id: '456-default', name: '默认款', price: '29.9' }],
      },
    });

    render(<CollectionPricingPage shops={[{ id: 'shop-1', name: '测试店铺' }]} activeShopId="shop-1" />);
    fireEvent.click(screen.getByRole('button', { name: /复制链接采集/u }));
    fireEvent.change(screen.getByLabelText('商品链接'), { target: { value: 'https://detail.1688.com/offer/456.html' } });
    await act(async () => screen.getByRole('button', { name: '采集链接' }).click());

    expect(collectCollectionProductFromLink).toHaveBeenCalledWith('https://detail.1688.com/offer/456.html');
    expect(await screen.findByText('链接商品')).toBeInTheDocument();
    expect(screen.getByText(/链接采集完成/u)).toBeInTheDocument();
    expect(screen.getByText('本次已采集 1 件')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑：链接商品' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除：链接商品' })).toBeInTheDocument();
    expect(screen.getByText('未上传')).toBeInTheDocument();
  });

  it('counts and filters by platform and replaces duplicate platform-product records', async () => {
    render(<CollectionPricingPage />);
    const capture = (input) => act(() => publishCollectionBrowserCapture({
      pageType: 'product',
      purchasePrice: 10,
      currency: 'CNY',
      mainImages: ['https://img.example/product/main.jpg'],
      skus: [{ id: `${input?.sourceProductId || 'default'}-sku`, name: '默认款', price: 10 }],
      ...input,
    }));

    capture({ platform: '1688', sourceProductId: '100', sourceUrl: 'https://detail.1688.com/offer/100.html', productTitle: '1688 初次标题' });
    capture({ platform: '拼多多', sourceProductId: '200', sourceUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=200', productTitle: '拼多多商品' });
    capture({ platform: '1688', sourceProductId: '100', sourceUrl: 'https://detail.1688.com/offer/100.html?spm=again', productTitle: '1688 更新标题' });

    expect(await screen.findByText('1688 更新标题')).toBeInTheDocument();
    expect(screen.queryByText('1688 初次标题')).not.toBeInTheDocument();
    expect(screen.getByText('本次已采集 2 件')).toBeInTheDocument();

    const filters = screen.getByLabelText('采集平台筛选');
    expect(within(filters).getByRole('button', { name: '1688 1' })).toBeInTheDocument();
    expect(within(filters).getByRole('button', { name: '拼多多 1' })).toBeInTheDocument();
    fireEvent.click(within(filters).getByRole('button', { name: '拼多多 1' }));
    expect(screen.getByText('拼多多商品')).toBeInTheDocument();
    expect(screen.queryByText('1688 更新标题')).not.toBeInTheDocument();
  });
});
