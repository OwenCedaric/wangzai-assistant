import { describe, expect, it } from 'vitest';

import { completeCollectionBeixiongSuggestions } from './collectionBeixiongFallbacks.js';

describe('collectionBeixiongFallbacks', () => {
  it('keeps only real source facts and leaves missing text, dictionary, title, description and tags unresolved', () => {
    const skus = Array.from({ length: 8 }, (_, index) => ({
      sourceSkuId: `sku-${index + 1}`,
      sourceSkuName: index % 2 ? '白色' : '黑色',
      title: '中文原标题',
      attributeValues: {},
    }));
    const result = completeCollectionBeixiongSuggestions({
      globalAttributes: [], skuAttributes: [], unresolved: [],
    }, {
      product: { title: '不锈钢平光眼镜', skus },
      draft: {
        categoryName: '平光眼镜', title: '中文原标题', description: '',
        weightG: '120', packageLengthCm: '20', packageWidthCm: '10', packageHeightCm: '5',
        attributeValues: {}, skus,
      },
      definitions: [
        { id: 'material', name: 'Материал', valueType: 'String' },
        { id: 'weight', name: 'Вес', valueType: 'Decimal' },
        { id: 'brand', name: 'Бренд', isDictionary: true },
        { id: 'color', name: 'Цвет', isDictionary: true, isAspect: true },
      ],
      optionsByAttributeId: {
        brand: [{ id: 'no-brand', label: 'Нет бренда' }],
        color: [{ id: 'black', label: 'Черный' }, { id: 'white', label: 'Белый' }],
      },
    });

    expect(result.globalAttributes).toEqual([
      expect.objectContaining({ attributeId: 'weight', value: expect.objectContaining({ value: '120' }) }),
    ]);
    expect(result.skuAttributes).toEqual([]);
    expect(result.skuTitles).toEqual([]);
    expect(result.title).toBe('');
    expect(result.description).toBe('');
    expect(result.tags).toEqual([]);
    expect(result.packageDefaults).toEqual({
      weightG: '120', packageLengthCm: '20', packageWidthCm: '10', packageHeightCm: '5',
    });
    expect(result.unresolved).toHaveLength(10);
    expect(result.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'global', attributeId: 'material' }),
      expect.objectContaining({ scope: 'global', attributeId: 'brand' }),
      expect.objectContaining({ scope: 'sku', sourceSkuId: 'sku-8', attributeId: 'color' }),
    ]));
  });

  it('does not invent text or select values when source facts are absent', () => {
    const result = completeCollectionBeixiongSuggestions({ globalAttributes: [], skuAttributes: [], unresolved: [] }, {
      product: { title: '商品' },
      draft: { title: '商品', attributeValues: {}, skus: [] },
      definitions: [
        { id: 'text', name: 'Материал', valueType: 'String' },
        { id: 'select', name: 'Неизвестный выбор', isDictionary: true },
      ],
      optionsByAttributeId: {},
    });
    expect(result.globalAttributes).toEqual([]);
    expect(result.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ attributeId: 'text', reason: expect.stringContaining('人工确认') }),
      expect.objectContaining({ attributeId: 'select', reason: expect.stringContaining('Ozon') }),
    ]));
  });

  it('reuses one verified Russian product title for untouched SKU titles when shared-title mode is enabled', () => {
    const skus = [
      { sourceSkuId: 'sku-1', title: '中文规格一', attributeValues: {} },
      { sourceSkuId: 'sku-2', title: 'Ручное название варианта', attributeValues: {} },
    ];
    const result = completeCollectionBeixiongSuggestions({
      title: 'Резинка для волос из текстиля с декоративными элементами',
      globalAttributes: [],
      skuAttributes: [],
      unresolved: [],
    }, {
      product: {},
      draft: { title: '中文原标题', attributeValues: {}, skus },
      definitions: [],
      sharedSkuTitle: true,
    });

    expect(result.skuTitles).toEqual([{
      sourceSkuId: 'sku-1',
      title: 'Резинка для волос из текстиля с декоративными элементами',
    }]);
  });

  it('keeps PDF but excludes supplier video and image media from Ozon Rich Content', () => {
    const result = completeCollectionBeixiongSuggestions({ globalAttributes: [], skuAttributes: [], unresolved: [] }, {
      product: {
        title: 'Очки',
        videoUrl: 'https://cdn.example.com/product.mp4',
        detailImages: ['https://cdn.example.com/detail.jpg'],
        documents: [{ url: 'https://cdn.example.com/manual.pdf', name: 'manual-real.pdf' }],
      },
      draft: {
        title: 'Очки', description: 'Описание товара основано на проверенных характеристиках.', attributeValues: {},
        skus: [{ sourceSkuId: 'sku-1', offerId: 'SKU-1', attributeValues: {} }],
      },
      definitions: [
        { id: 'rich', name: 'Rich-контент JSON', valueType: 'String' },
        { id: 'video-name', name: 'Озон.Видео: название', valueType: 'String' },
        { id: 'video-url', name: 'Озон.Видео: ссылка', valueType: 'String' },
        { id: 'video-products', name: 'Озон.Видео: товары на видео', valueType: 'String' },
        { id: 'pdf-name', name: 'Название файла PDF', valueType: 'String' },
        { id: 'pdf-url', name: 'Документ PDF', valueType: 'URL' },
      ],
      optionsByAttributeId: {},
    });
    const values = Object.fromEntries(result.globalAttributes.map((item) => [item.attributeId, item.value.value]));
    const richContent = JSON.parse(values.rich);
    expect(richContent).toMatchObject({ version: 0.3, content: expect.any(Array) });
    expect(JSON.stringify(richContent)).not.toMatch(/video|detail\.jpg/iu);
    expect(values['video-name']).toBeUndefined();
    expect(values['video-url']).toBeUndefined();
    expect(values['video-products']).toBeUndefined();
    expect(values['pdf-name']).toBe('manual-real.pdf');
    expect(values['pdf-url']).toBe('https://cdn.example.com/manual.pdf');
    expect(result.unresolved.map((item) => item.attributeId)).toEqual(expect.arrayContaining([
      'video-name', 'video-url', 'video-products',
    ]));
  });
});
