import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildProductInfoWriteCommand: vi.fn(),
  submitProductInfoWrite: vi.fn(),
  isProductWriteReadbackComplete: vi.fn(),
  importProductImage: vi.fn(),
  promoteProductImage: vi.fn(),
  readStoredProductImagePreview: vi.fn(),
}));

vi.mock('../../../entities/product/productWriteHelpers.jsx', () => ({
  buildProductInfoWriteCommand: mocks.buildProductInfoWriteCommand,
}));
vi.mock('../../../services/productModuleClient.js', () => ({
  isProductWriteReadbackComplete: mocks.isProductWriteReadbackComplete,
  submitProductInfoWrite: mocks.submitProductInfoWrite,
}));
vi.mock('../../products/services/productImageAssetService.js', () => ({
  importProductImage: mocks.importProductImage,
  promoteProductImage: mocks.promoteProductImage,
}));
vi.mock('./smartToolImageGenerationService.js', () => ({
  readStoredProductImagePreview: mocks.readStoredProductImagePreview,
}));

import {
  OZON_RICH_CONTENT_ATTRIBUTE_ID,
  readSmartToolRichContent,
  replaceGeneratedProductImages,
  replaceSmartToolRichContentAttribute,
  replaceSmartToolRichContentImages,
} from './smartToolProductImageReplacementService.js';

const oldDetailUrl = 'https://cdn.ozon.ru/detail-old.jpg';
const newDetailUrl = 'https://cdn.ozon.ru/detail-new.jpg';

function richContent() {
  return {
    version: 2,
    content: [
      {
        widgetName: 'image',
        props: { src: oldDetailUrl, srcMobile: oldDetailUrl, alt: '保留这段文字' },
      },
      { widgetName: 'text', text: '商品卖点不应被改动' },
    ],
  };
}

function product(attributes = []) {
  return {
    shopId: 'shop-1',
    offerId: 'offer-1',
    productId: 'product-1',
    descriptionCategoryId: '123',
    typeId: '456',
    name: '测试商品',
    mainImages: ['https://cdn.ozon.ru/main.jpg'],
    detailImages: [oldDetailUrl],
    attributes,
    richContentJson: richContent(),
  };
}

describe('smart tool product image replacement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildProductInfoWriteCommand.mockImplementation((shop, item, form) => ({
      shopId: shop.id,
      payload: { items: [{ images: form.images, attributes: form.attributes }] },
      form,
      item,
    }));
    mocks.submitProductInfoWrite.mockResolvedValue({ ok: true, readBack: { status: 'merged' } });
    mocks.isProductWriteReadbackComplete.mockReturnValue(true);
    mocks.promoteProductImage.mockResolvedValue({
      asset: { ozonUrl: 'https://private-oss.example/permanent.png?signature=ozon' },
    });
  });

  it('replaces both desktop and mobile Rich Content image URLs without changing other content', () => {
    const next = replaceSmartToolRichContentImages(richContent(), [
      { sourceUrl: oldDetailUrl, targetUrl: newDetailUrl },
    ]);

    expect(next.content[0].props.src).toBe(newDetailUrl);
    expect(next.content[0].props.srcMobile).toBe(newDetailUrl);
    expect(next.content[0].props.alt).toBe('保留这段文字');
    expect(next.content[1]).toEqual(richContent().content[1]);
    expect(next.version).toBe(2);
  });

  it('stops when a selected detail URL is not present in the current Rich Content', () => {
    expect(() => replaceSmartToolRichContentImages(richContent(), [
      { sourceUrl: 'https://cdn.ozon.ru/not-found.jpg', targetUrl: newDetailUrl },
    ])).toThrow('没有找到 1 张选中的详情图');
  });

  it('updates an existing Rich Content attribute or adds it when missing', () => {
    const next = replaceSmartToolRichContentAttribute(
      [{ id: 10, values: [{ value: 'Blue' }] }, { id: OZON_RICH_CONTENT_ATTRIBUTE_ID, values: [{ value: '{}' }] }],
      richContent(),
    );
    expect(next).toHaveLength(2);
    expect(JSON.parse(next[1].values[0].value)).toEqual(richContent());

    const added = replaceSmartToolRichContentAttribute([{ id: 10, values: [{ value: 'Blue' }] }], richContent());
    expect(added).toHaveLength(2);
    expect(added[1].id).toBe(OZON_RICH_CONTENT_ATTRIBUTE_ID);
    expect(JSON.parse(added[1].values[0].value)).toEqual(richContent());
  });

  it('submits detail replacements with unchanged main images and waits for Ozon readback', async () => {
    const result = await replaceGeneratedProductImages({
      shop: { id: 'shop-1' },
      product: product([{ id: 11254, values: [{ value: JSON.stringify(richContent()) }] }]),
      group: 'detail',
      generatedItems: [{ sourceIndex: 0, status: 'success', imageUrl: newDetailUrl }],
    });

    const command = mocks.buildProductInfoWriteCommand.mock.results[0].value;
    expect(command.form.images).toEqual(['https://cdn.ozon.ru/main.jpg']);
    const richAttribute = command.form.attributes.find((attribute) => String(attribute.id) === '11254');
    expect(JSON.parse(richAttribute.values[0].value).content[0].props.src).toBe(newDetailUrl);
    expect(result.detailImages).toEqual([newDetailUrl]);
    expect(mocks.submitProductInfoWrite).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.any(Object) }),
      expect.objectContaining({ humanConfirmed: true, realWrite: true, dryRun: false }),
    );
  });

  it('promotes a generated temporary asset before submitting instead of using its expiring preview URL', async () => {
    await replaceGeneratedProductImages({
      shop: { id: 'shop-1' },
      product: product(),
      group: 'main',
      generatedItems: [{
        sourceIndex: 0,
        status: 'success',
        assetId: 'pimg-temporary-generated',
        imageUrl: 'https://private-oss.example/temporary.png?signature=preview',
      }],
    });

    expect(mocks.promoteProductImage).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: 'pimg-temporary-generated',
        shopId: 'shop-1',
      }),
      expect.objectContaining({ shopId: 'shop-1' }),
    );
    const command = mocks.buildProductInfoWriteCommand.mock.results[0].value;
    expect(command.form.images[0]).toBe('https://private-oss.example/permanent.png?signature=ozon');
    expect(command.form.images[0]).not.toContain('temporary.png');
  });

  it('does not report success when the Ozon readback is incomplete', async () => {
    mocks.isProductWriteReadbackComplete.mockReturnValue(false);

    await expect(replaceGeneratedProductImages({
      shop: { id: 'shop-1' },
      product: product(),
      group: 'detail',
      generatedItems: [{ sourceIndex: 0, status: 'success', imageUrl: newDetailUrl }],
    })).rejects.toThrow('回读尚未确认成功');
  });

  it('refuses to submit any replacement when the product snapshot has no main images', async () => {
    await expect(replaceGeneratedProductImages({
      shop: { id: 'shop-1' },
      product: { ...product(), mainImages: [], images: [] },
      group: 'detail',
      generatedItems: [{ sourceIndex: 0, status: 'success', imageUrl: newDetailUrl }],
    })).rejects.toThrow('没有读取到商品主图');
    expect(mocks.submitProductInfoWrite).not.toHaveBeenCalled();
  });

  it('reads Rich Content from the Ozon attribute when no convenience field exists', () => {
    const item = product([
      { id: OZON_RICH_CONTENT_ATTRIBUTE_ID, values: [{ value: JSON.stringify(richContent()) }] },
    ]);
    delete item.richContentJson;
    expect(readSmartToolRichContent(item)).toEqual(richContent());
  });

  it('finds the Rich Content attribute in the nested Ozon response even when display attributes exist', () => {
    const item = product([{ id: 10, values: [{ value: 'Blue' }] }]);
    delete item.richContentJson;
    item.raw = {
      attributes: {
        attributes: [
          { id: OZON_RICH_CONTENT_ATTRIBUTE_ID, values: [{ value: JSON.stringify(richContent()) }] },
        ],
      },
    };
    expect(readSmartToolRichContent(item)).toEqual(richContent());
  });
});
