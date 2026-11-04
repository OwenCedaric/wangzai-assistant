import { describe, expect, it } from 'vitest';

import {
  getCollectedProductAttributeSourceValue,
  mapCollectedProductAttributeValues,
  mapCollectedProductSkuAttributeValues,
} from './collectionProductAttributeMapper.js';

describe('collectionProductAttributeMapper', () => {
  const product = {
    brand: '旺崽',
    attributes: [
      { name: '材质', value: '金属' },
      { name: '颜色', value: '黑色' },
      { name: '适用性别', value: '通用' },
    ],
  };

  it('maps collected 1688 fields into matching Ozon text and dictionary fields', () => {
    const result = mapCollectedProductAttributeValues({
      product,
      definitions: [
        { id: '1', name: '材质', is_required: true, isDictionary: false },
        { id: '2', name: '颜色', is_required: true, isDictionary: true },
        { id: '3', name: '品牌', is_required: false, isDictionary: false },
      ],
      optionsByAttributeId: {
        2: [{ id: '200', value: '黑色', label: '黑色' }],
      },
    });

    expect(result.mappedCount).toBe(3);
    expect(result.values).toMatchObject({
      1: { value: '金属', dictionaryValueId: '' },
      2: { value: '黑色', dictionaryValueId: '200' },
      3: { value: '旺崽', dictionaryValueId: '' },
    });
  });

  it('does not invent an Ozon dictionary id when the source value has no real match', () => {
    const result = mapCollectedProductAttributeValues({
      product,
      definitions: [{ id: '2', name: '颜色', is_required: true, isDictionary: true }],
      optionsByAttributeId: { 2: [{ id: '201', value: '白色', label: '白色' }] },
    });

    expect(result.mappedCount).toBe(0);
    expect(result.values).toEqual({});
  });

  it('preserves a user-entered value instead of overwriting it from collected data', () => {
    const result = mapCollectedProductAttributeValues({
      product,
      definitions: [{ id: '1', name: '材质', is_required: true, isDictionary: false }],
      currentValues: { 1: { value: '钛合金', dictionaryValueId: '' } },
    });

    expect(result.mappedCount).toBe(0);
    expect(result.values[1].value).toBe('钛合金');
  });

  it('returns a source value for dictionary value search', () => {
    expect(getCollectedProductAttributeSourceValue(product, { name: '颜色商品' })).toBe('黑色');
  });

  it('maps source SKU values into separate Ozon aspect values', () => {
    const result = mapCollectedProductSkuAttributeValues({
      product: {
        attributes: [{ name: '颜色', value: '黑色' }],
        skus: [
          { name: '红色', attributes: [{ name: '颜色', value: '红色' }] },
          { name: '蓝色', attributes: [{ name: '颜色', value: '蓝色' }] },
        ],
      },
      skus: [{ attributeValues: {} }, { attributeValues: {} }],
      definitions: [{ id: '20', name: '颜色', isAspect: true, isDictionary: true }],
      optionsByAttributeId: {
        20: [
          { id: '201', value: '红色', label: '红色' },
          { id: '202', value: '蓝色', label: '蓝色' },
        ],
      },
    });

    expect(result.skus[0].attributeValues[20]).toMatchObject({ value: '红色', dictionaryValueId: '201' });
    expect(result.skus[1].attributeValues[20]).toMatchObject({ value: '蓝色', dictionaryValueId: '202' });
  });

  it('maps explicit piece counts from every SKU specification and repairs non-manual AI values', () => {
    const sourceSkus = [
      '黑色-加大加厚4个',
      '灰色-加大加厚4个',
      '黑色-加大加厚20个',
      '黑色-加大加厚10个',
      '灰色-加大加厚16个',
      '灰色-加大加厚20个',
      '黑色-加大加厚16个',
      '灰色-加大加厚10个',
    ].map((name) => ({ name, attributes: [{ name: '规格', value: name }] }));
    const wrongAiValues = ['16', '16', '2000', '20', '16', '2000', '16', '10'];
    const result = mapCollectedProductSkuAttributeValues({
      product: { skus: sourceSkus },
      skus: sourceSkus.map((sourceSku, index) => ({
        sourceSkuId: sourceSku.name,
        attributeValues: {
          7202: {
            value: wrongAiValues[index],
            dictionaryValueId: `wrong-${index}`,
            source: 'ai',
          },
        },
      })),
      definitions: [{ id: '7202', name: 'Количество, шт', isAspect: true, isDictionary: true }],
      optionsByAttributeId: {
        7202: [4, 10, 16, 20].map((value) => ({ id: `qty-${value}`, value: String(value) })),
      },
    });

    expect(result.skus.map((sku) => sku.attributeValues[7202].value)).toEqual([
      '4', '4', '20', '10', '16', '20', '16', '10',
    ]);
    expect(result.skus.map((sku) => sku.attributeValues[7202].dictionaryValueId)).toEqual([
      'qty-4', 'qty-4', 'qty-20', 'qty-10', 'qty-16', 'qty-20', 'qty-16', 'qty-10',
    ]);
    expect(result.mappedCount).toBe(8);
  });

  it('does not overwrite a manually selected SKU quantity', () => {
    const result = mapCollectedProductSkuAttributeValues({
      product: { skus: [{ name: '加大加厚4个', attributes: [{ name: '规格', value: '加大加厚4个' }] }] },
      skus: [{
        sourceSkuId: '加大加厚4个',
        attributeValues: {
          7202: { value: '10', dictionaryValueId: 'qty-10', source: 'manual' },
        },
      }],
      definitions: [{ id: '7202', name: 'Количество, шт', isAspect: true, isDictionary: true }],
      optionsByAttributeId: {
        7202: [{ id: 'qty-4', value: '4' }, { id: 'qty-10', value: '10' }],
      },
    });

    expect(result.skus[0].attributeValues[7202]).toMatchObject({
      value: '10', dictionaryValueId: 'qty-10', source: 'manual',
    });
    expect(result.mappedCount).toBe(0);
  });

  it('matches a 109-SKU matrix against large cached dictionaries without blocking the renderer', () => {
    const colors = Array.from({ length: 651 }, (_item, index) => ({
      id: `color-${index}`,
      value: index === 0 ? 'Черный' : `Цвет ${index}`,
      label: index === 0 ? 'Черный' : `Цвет ${index}`,
    }));
    const materials = Array.from({ length: 656 }, (_item, index) => ({
      id: `material-${index}`,
      value: index === 0 ? 'Полиэстер' : `Материал ${index}`,
      label: index === 0 ? 'Полиэстер' : `Материал ${index}`,
    }));
    const sourceSkus = Array.from({ length: 109 }, (_item, index) => ({
      id: `sku-${index}`,
      name: `黑色款 ${index}`,
      attributes: [
        { name: '颜色', value: '黑色' },
        { name: '材质', value: '聚酯纤维' },
      ],
    }));
    const startedAt = Date.now();
    const result = mapCollectedProductSkuAttributeValues({
      product: { skus: sourceSkus },
      skus: sourceSkus.map((item) => ({ sourceSkuId: item.id, attributeValues: {} })),
      definitions: [
        { id: '10096', name: 'Цвет товара', isAspect: true, isDictionary: true, isCollection: true },
        { id: '5309', name: 'Материал', isAspect: true, isDictionary: true, isCollection: true },
      ],
      optionsByAttributeId: { 10096: colors, 5309: materials },
    });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.skus).toHaveLength(109);
    expect(result.mappedCount).toBe(218);
    expect(result.skus[0].attributeValues).toMatchObject({
      10096: { dictionaryValueIds: ['color-0'] },
      5309: { dictionaryValueIds: ['material-0'] },
    });
  });

  it('maps explicit product and package measurements without mixing their scopes', () => {
    const result = mapCollectedProductAttributeValues({
      product: {
        productWeightG: 45,
        packageWeightG: 50,
        packageLengthCm: 18,
        packageWidthCm: 8,
        packageHeightCm: 2,
      },
      definitions: [
        { id: '4383', name: 'Вес товара, г', valueType: 'Decimal' },
        { id: '4497', name: 'Вес с упаковкой, г', valueType: 'Decimal' },
        { id: '8414', name: 'Высота упаковки, см', valueType: 'Decimal' },
        { id: '8416', name: 'Ширина упаковки, см', valueType: 'Decimal' },
        { id: '8417', name: 'Длина упаковки, см', valueType: 'Decimal' },
      ],
    });

    expect(result.mappedCount).toBe(5);
    expect(result.values).toMatchObject({
      4383: { value: '45', source: 'source-field' },
      4497: { value: '50', source: 'source-field' },
      8414: { value: '2', source: 'source-field' },
      8416: { value: '8', source: 'source-field' },
      8417: { value: '18', source: 'source-field' },
    });
  });

  it('uses reusable component semantics instead of copying one material into every part', () => {
    const source = {
      attributes: [
        { name: '外壳材质', value: '金属' },
        { name: '手柄材质', value: '硅胶' },
        { name: '货号', value: 'GB02' },
      ],
    };
    expect(getCollectedProductAttributeSourceValue(source, { name: 'Материал корпуса' })).toBe('金属');
    expect(getCollectedProductAttributeSourceValue(source, { name: 'Материал ручки' })).toBe('硅胶');
    expect(getCollectedProductAttributeSourceValue(source, { name: 'Название модели (для объединения в одну карточку)' })).toBe('GB02');
  });

  it('does not confuse frame material with lens material', () => {
    const source = { attributes: [{ name: '镜框材质', value: '金属' }] };
    expect(getCollectedProductAttributeSourceValue(source, { name: 'Материал оправы' })).toBe('金属');
    expect(getCollectedProductAttributeSourceValue(source, { name: 'Материал линзы' })).toBe('');
  });

  it('does not copy the model number into the generic Ozon product name', () => {
    const source = { attributes: [{ name: '货号', value: 'GB02' }] };
    expect(getCollectedProductAttributeSourceValue(source, { name: 'Название модели' })).toBe('GB02');
    expect(getCollectedProductAttributeSourceValue(source, { name: 'Название' })).toBe('');
  });

  it('keeps package dimensions out of part-specific product attributes', () => {
    const result = mapCollectedProductAttributeValues({
      product: { packageHeightCm: 2, packageWidthCm: 8, packageLengthCm: 18 },
      definitions: [
        { id: '8018', name: 'Высота линзы, мм', valueType: 'Decimal' },
        { id: '8014', name: 'Общая ширина, мм', valueType: 'Decimal' },
        { id: '8016', name: 'Ширина линзы, мм', valueType: 'Decimal' },
      ],
    });

    expect(result.mappedCount).toBe(0);
    expect(result.values).toEqual({});
  });

  it('maps reusable cross-language facts to official Russian dictionary values across categories', () => {
    const result = mapCollectedProductAttributeValues({
      product: {
        title: '男女通用成人方形金属收纳用品',
        minimumOrderQuantity: '1',
        attributes: [
          { name: '材质', value: '金属、塑料' },
          { name: '颜色', value: '黑色、白色' },
          { name: '适用人群', value: '成人' },
          { name: '产地', value: '中国' },
          { name: '形状', value: '方形' },
          { name: '上市年份/季节', value: '2026年春季' },
        ],
      },
      definitions: [
        { id: '9163', name: 'Пол', isDictionary: true, isCollection: true, maxValueCount: 2 },
        { id: '5287', name: 'Материал', isDictionary: true, isCollection: true },
        { id: '4389', name: 'Страна-изготовитель', isDictionary: true, isCollection: true },
        { id: '9390', name: 'Целевая аудитория', isDictionary: true, isCollection: true },
        { id: '9751', name: 'Форма', isDictionary: true },
        { id: '6586', name: 'Цвет', isDictionary: true, isCollection: true },
        { id: '9725', name: 'Коллекция', isDictionary: true },
      ],
      optionsByAttributeId: {
        9163: [{ id: '22880', value: 'Мужской' }, { id: '22881', value: 'Женский' }],
        5287: [{ id: '61936', value: 'Металл' }, { id: '61937', value: 'Пластик' }],
        4389: [{ id: '90296', value: 'Китай' }],
        9390: [{ id: '43241', value: 'Взрослая' }],
        9751: [{ id: '971154145', value: 'Квадратные' }],
        6586: [{ id: '30805', value: 'Черный' }, { id: '30806', value: 'Белый' }],
        9725: [{ id: '972836453', value: 'Весна-лето 2026' }],
      },
    });

    expect(result.values).toMatchObject({
      9163: { dictionaryValueIds: ['22880', '22881'] },
      5287: { dictionaryValueIds: ['61936', '61937'] },
      4389: { dictionaryValueIds: ['90296'] },
      9390: { dictionaryValueIds: ['43241'] },
      9751: { dictionaryValueId: '971154145' },
      6586: { dictionaryValueIds: ['30805', '30806'] },
      9725: { dictionaryValueId: '972836453' },
    });
  });
});
