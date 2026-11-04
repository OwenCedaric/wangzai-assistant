import { describe, expect, it } from 'vitest';

import {
  applyCollectionProductManagedDefaults,
  OZON_CHINA_VALUE_ID,
  OZON_NO_BRAND_VALUE_ID,
} from './collectionProductManagedDefaults.js';
import {
  buildListingAttributeList,
  validateListingAttributeValues,
} from './collectionProductAttributeSchema.js';

describe('collectionProductManagedDefaults', () => {
  const definitions = [
    { id: '85', name: 'Бренд', isDictionary: true },
    { id: '4180', name: 'Название' },
    { id: '11650', name: 'Количество заводских упаковок' },
    { id: '23249', name: 'Количество товара в УЕИ' },
    { id: '9070', name: 'Признак 18+' },
    { id: '999', name: 'Страна-изготовитель', isDictionary: true },
  ];

  it('uses the official no-brand value for every collected product', () => {
    const result = applyCollectionProductManagedDefaults({
      product: { brand: '其他' },
      draft: { title: 'Очки' },
      definitions,
      optionsByAttributeId: {
        85: [{ id: OZON_NO_BRAND_VALUE_ID, value: 'Нет бренда' }],
        999: [{ id: 'china-id', value: 'Китай' }],
      },
      currentValues: { 85: { value: 'Другой бренд', dictionaryValueId: '99', source: 'ai' } },
    });

    expect(result.values[85]).toMatchObject({
      value: 'Нет бренда',
      dictionaryValueId: OZON_NO_BRAND_VALUE_ID,
      source: 'managed-default',
    });
    expect(result.values[999]).toMatchObject({
      value: 'Китай',
      dictionaryValueId: 'china-id',
      source: 'managed-default',
    });
  });

  it('fills verified retail defaults and the generated Ozon product name', () => {
    const result = applyCollectionProductManagedDefaults({
      product: { minimumOrderQuantity: '1' },
      draft: { title: 'Очки без диоптрий' },
      definitions,
      fillProductName: true,
    });

    expect(result.values).toMatchObject({
      4180: { value: 'Очки без диоптрий', source: 'managed-default' },
      11650: { value: '1', source: 'managed-default' },
      23249: { value: '1', source: 'managed-default' },
      9070: { value: 'false', source: 'managed-default' },
    });
  });

  it('binds the official product type to the manually confirmed Ozon leaf type', () => {
    const result = applyCollectionProductManagedDefaults({
      draft: { typeId: '98348' },
      definitions: [{ id: '8229', name: 'Тип', is_required: true, isDictionary: true }],
      optionsByAttributeId: {
        8229: [
          { id: '98347', value: 'Коврик в багажник' },
          { id: '98348', value: 'Коврики в салон автомобиля' },
          { id: '970731612', value: 'Чехол в багажник' },
        ],
      },
      currentValues: {
        8229: { value: 'Коврик в багажник', dictionaryValueId: '98347', source: 'ai' },
      },
    });

    expect(result.values[8229]).toEqual({
      value: 'Коврики в салон автомобиля',
      dictionaryValueId: '98348',
      values: [],
      dictionaryValueIds: [],
      source: 'category-selection',
    });
    expect(result.appliedCount).toBe(1);
  });

  it('preserves a manual product type even when the leaf type has a matching option', () => {
    const manual = {
      value: 'Коврик в багажник',
      dictionaryValueId: '98347',
      values: [],
      dictionaryValueIds: [],
      source: 'manual',
    };
    const result = applyCollectionProductManagedDefaults({
      draft: { typeId: '98348' },
      definitions: [{ id: '8229', name: 'Тип', is_required: true, isDictionary: true }],
      optionsByAttributeId: {
        8229: [{ id: '98348', value: 'Коврики в салон автомобиля' }],
      },
      currentValues: { 8229: manual },
    });

    expect(result.values[8229]).toEqual(manual);
    expect(result.appliedCount).toBe(0);
  });

  it('binds China to the official Ozon dictionary id even before options finish loading', () => {
    const countryDefinition = definitions.find((item) => item.id === '999');
    const result = applyCollectionProductManagedDefaults({
      definitions: [countryDefinition],
      optionsByAttributeId: {},
      currentValues: {
        999: { value: 'Китай', dictionaryValueId: '', source: 'source-attribute' },
      },
    });

    expect(result.values[999]).toEqual({
      value: 'Китай',
      dictionaryValueId: OZON_CHINA_VALUE_ID,
      values: [],
      dictionaryValueIds: [],
      source: 'managed-default',
    });
    expect(validateListingAttributeValues(result.values, [countryDefinition])).toMatchObject({
      ok: true,
      errors: [],
    });
    expect(buildListingAttributeList(result.values, [countryDefinition])).toEqual([{
      complex_id: 0,
      id: 999,
      values: [{ dictionary_value_id: Number(OZON_CHINA_VALUE_ID), value: 'Китай' }],
    }]);
  });

  it('fills the real collection-type manufacturer country with a collection dictionary id', () => {
    const countryDefinition = {
      id: '4389',
      name: 'Страна-изготовитель',
      is_required: true,
      isDictionary: true,
      isCollection: true,
    };
    const result = applyCollectionProductManagedDefaults({
      definitions: [countryDefinition],
      optionsByAttributeId: {},
      currentValues: {},
    });

    expect(result.values[4389]).toEqual({
      value: 'Китай',
      dictionaryValueId: '',
      values: ['Китай'],
      dictionaryValueIds: [OZON_CHINA_VALUE_ID],
      source: 'managed-default',
    });
    expect(validateListingAttributeValues(result.values, [countryDefinition])).toMatchObject({
      ok: true,
      errors: [],
    });
    expect(buildListingAttributeList(result.values, [countryDefinition])).toEqual([{
      complex_id: 0,
      id: 4389,
      values: [{ dictionary_value_id: Number(OZON_CHINA_VALUE_ID), value: 'Китай' }],
    }]);
  });

  it('removes legacy package dimensions from optical fields but preserves exact source facts', () => {
    const opticalDefinitions = [
      { id: '8018', name: 'Высота линзы, мм' },
      { id: '8016', name: 'Ширина линзы, мм' },
    ];
    const result = applyCollectionProductManagedDefaults({
      definitions: opticalDefinitions,
      currentValues: {
        8018: { value: '2', source: 'source-field' },
        8016: { value: '52', source: 'source-attribute' },
      },
    });

    expect(result.values[8018]).toBeUndefined();
    expect(result.values[8016]).toMatchObject({ value: '52', source: 'source-attribute' });
    expect(result.removedCount).toBe(1);
  });
});
