import { describe, expect, it, vi } from 'vitest';

import { validateCollectionAttributeCandidate } from '../lib/collectionAttributeSchemaValidator.js';
import { matchCollectedProductAttributes } from './collectionAttributeMatchingService.js';

describe('collectionAttributeMatchingService', () => {
  it('matches arbitrary product and SKU facts only to live Ozon dictionary ids', async () => {
    const searchAttributeOptions = vi.fn(async (attributeId) => ({
      10: [{ id: '1001', value: 'Металл' }, { id: '1002', value: 'Пластик' }],
      20: [{ id: '2001', value: 'Красный' }, { id: '2002', value: 'Синий' }],
    }[attributeId] || []));
    const result = await matchCollectedProductAttributes({
      product: {
        attributes: [{ name: '材质', value: '金属、塑料' }],
        skus: [
          { id: 'sku-red', attributes: [{ name: '颜色', value: '红色' }] },
          { id: 'sku-blue', attributes: [{ name: '颜色', value: '蓝色' }] },
        ],
      },
      draft: {
        attributeValues: {},
        skus: [
          { sourceSkuId: 'sku-red', attributeValues: {} },
          { sourceSkuId: 'sku-blue', attributeValues: {} },
        ],
      },
      definitions: [
        { id: '10', name: 'Материал', isDictionary: true, isCollection: true },
        { id: '20', name: 'Цвет', isDictionary: true, isAspect: true },
      ],
      searchAttributeOptions,
    });

    expect(result.attributeValues[10]).toMatchObject({ dictionaryValueIds: ['1001', '1002'] });
    expect(result.skus[0].attributeValues[20]).toMatchObject({ dictionaryValueId: '2001' });
    expect(result.skus[1].attributeValues[20]).toMatchObject({ dictionaryValueId: '2002' });
    expect(result.mappedCount).toBe(3);
    expect(result.pipeline.strategy).toBe('live-schema-source-facts-dictionary-verified');
    expect(searchAttributeOptions).toHaveBeenCalledTimes(2);
  });

  it('does not flatten different SKU values into a global attribute', async () => {
    const result = await matchCollectedProductAttributes({
      product: {
        skus: [
          { id: 'sku-red', attributes: [{ name: '颜色', value: '红色' }] },
          { id: 'sku-blue', attributes: [{ name: '颜色', value: '蓝色' }] },
        ],
      },
      draft: {
        attributeValues: {},
        skus: [{ sourceSkuId: 'sku-red' }, { sourceSkuId: 'sku-blue' }],
      },
      definitions: [{ id: '20', name: '颜色', isDictionary: true, isCollection: false }],
      optionsByAttributeId: {
        20: [{ id: '2001', value: '红色' }, { id: '2002', value: '蓝色' }],
      },
    });

    expect(result.attributeValues).toEqual({});
    expect(result.mappedCount).toBe(0);
  });

  it('preserves existing values and never replaces them during automatic matching', async () => {
    const result = await matchCollectedProductAttributes({
      product: { attributes: [{ name: '材质', value: '金属' }] },
      draft: { attributeValues: { 10: { value: '用户已确认材质', source: 'manual' } }, skus: [] },
      definitions: [{ id: '10', name: '材质', isDictionary: false }],
    });

    expect(result.attributeValues[10]).toMatchObject({ value: '用户已确认材质', source: 'manual' });
    expect(result.mappedCount).toBe(0);
  });

  it('rejects dictionary ids that are not returned by the current live schema', () => {
    const result = validateCollectionAttributeCandidate(
      { id: '10', name: 'Цвет', isDictionary: true },
      { value: 'Красный', dictionaryValueId: 'unknown', confidence: 1 },
      [{ id: '2001', value: 'Красный' }],
    );

    expect(result).toEqual({ valid: false, reason: 'dictionary-value-not-in-live-schema' });
  });

  it('matches 100 SKUs after loading every category dictionary once in North Bear batches', async () => {
    const colors = [
      ['红色', 'Красный', '2001'],
      ['蓝色', 'Синий', '2002'],
      ['黑色', 'Черный', '2003'],
      ['白色', 'Белый', '2004'],
    ];
    const product = {
      attributes: [{ name: '材质', value: '金属' }],
      skus: Array.from({ length: 100 }, (_, index) => ({
        id: `sku-${index + 1}`,
        attributes: [{ name: '颜色', value: colors[index % colors.length][0] }],
      })),
    };
    const searchAttributeOptions = vi.fn(async (attributeId) => {
      if (attributeId === '10') return [{ id: '1001', value: 'Металл' }];
      if (attributeId === '20') return colors.map(([, value, id]) => ({ id, value }));
      return [];
    });
    const result = await matchCollectedProductAttributes({
      product,
      draft: {
        attributeValues: {},
        skus: product.skus.map((sku) => ({ sourceSkuId: sku.id, attributeValues: {} })),
      },
      definitions: [
        { id: '10', name: 'Материал', isDictionary: true },
        { id: '20', name: 'Цвет', isDictionary: true, isAspect: true },
        ...Array.from({ length: 58 }, (_, index) => ({
          id: String(100 + index),
          name: `Неприменимое поле ${index + 1}`,
          isDictionary: index % 2 === 0,
        })),
      ],
      searchAttributeOptions,
    });

    expect(result.mappedCount).toBe(101);
    expect(searchAttributeOptions).toHaveBeenCalledTimes(31);
    expect(searchAttributeOptions.mock.calls.every(([, query]) => query === '')).toBe(true);
    expect(result.skus.every((sku) => sku.attributeValues[20]?.dictionaryValueId)).toBe(true);
  });

  it('loads cold category dictionaries in exact batches of five without term searches', async () => {
    let active = 0;
    let maximumActive = 0;
    const searchAttributeOptions = vi.fn(async (_attributeId, query) => {
      expect(query).toBe('');
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => { globalThis.setTimeout(resolve, 5); });
      active -= 1;
      return [{ id: 'value-1', value: 'Стандарт' }];
    });
    const definitions = Array.from({ length: 12 }, (_item, index) => ({
      id: String(1000 + index),
      name: `Словарь ${index + 1}`,
      isDictionary: true,
    }));

    await matchCollectedProductAttributes({
      product: {},
      draft: { attributeValues: {}, skus: [] },
      definitions,
      searchAttributeOptions,
    });

    expect(searchAttributeOptions).toHaveBeenCalledTimes(12);
    expect(maximumActive).toBe(5);
  });
});
