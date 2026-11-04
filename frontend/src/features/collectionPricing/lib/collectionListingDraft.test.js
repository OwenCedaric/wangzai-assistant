import { describe, expect, it } from 'vitest';

import {
  buildCollectionListingCommands,
  validateCollectionListingDraft,
} from './collectionListingDraft.js';

const validDraft = {
  shopId: 'shop-1',
  offerId: 'SPB-123',
  title: 'Радиоуправляемая машина',
  description: 'Подробное описание',
  descriptionCategoryId: '17028669',
  typeId: '971',
  price: '999',
  oldPrice: '1599',
  minPrice: '700',
  currencyCode: 'CNY',
  vat: '0',
  weightG: '350',
  packageLengthCm: '20',
  packageWidthCm: '10',
  packageHeightCm: '8',
  imagesText: 'https://img.example/main.jpg\nhttps://img.example/second.jpg',
  attributesJson: '[{"id":85,"values":[{"dictionary_value_id":123}]}]',
  stock: '5',
  warehouseId: '12345',
};

describe('collection listing draft', () => {
  it('enforces Shopbang-style price and listing guards', () => {
    expect(validateCollectionListingDraft(validDraft).ok).toBe(true);
    const invalid = validateCollectionListingDraft({ ...validDraft, oldPrice: '900', minPrice: '100' });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join(' ')).toContain('划线价');
    expect(invalid.errors.join(' ')).toContain('50%');
  });

  it('builds immutable preview commands for info, price and stock writes', () => {
    const built = buildCollectionListingCommands(validDraft, 'operation-1');
    expect(built.commands.map((item) => item.command.endpointKey)).toEqual([
      'products.import',
      'products.updatePrices',
      'products.updateStocks',
    ]);
    expect(built.infoItem).toMatchObject({
      offer_id: 'SPB-123',
      currency_code: 'CNY',
      weight: 350,
      depth: 200,
      dimension_unit: 'mm',
    });
    expect(built.infoItem.attributes.some((item) => item.id === 4191)).toBe(true);
    expect(built.commands[2].command.payload.stocks[0]).toEqual({
      offer_id: 'SPB-123', stock: 5, warehouse_id: 12345,
    });
    expect(built.infoItem.primary_image).toBe('https://img.example/main.jpg');
    expect(built.infoItem.images).toEqual(['https://img.example/second.jpg']);
  });

  it('keeps each Ozon item at one primary image plus at most 29 non-duplicate additional images', () => {
    const imageUrls = Array.from({ length: 35 }, (_, index) => `https://img.example/${index + 1}.jpg`);
    const built = buildCollectionListingCommands({
      ...validDraft,
      imagesText: imageUrls.join('\n'),
      skus: [{
        sourceSkuId: 'with-own-primary', offerId: 'SPB-IMAGES', title: 'Товар с фотографиями',
        imageUrl: 'https://img.example/sku-primary.jpg', price: '999', oldPrice: '1599',
      }],
    }, 'operation-images');

    expect(built.infoItems[0].primary_image).toBe('https://img.example/sku-primary.jpg');
    expect(built.infoItems[0].images).toHaveLength(29);
    expect(built.infoItems[0].images).not.toContain(built.infoItems[0].primary_image);
    expect(new Set(built.infoItems[0].images).size).toBe(29);
  });

  it('rejects every invalid upload image instead of silently keeping the remaining URLs', () => {
    const commonInvalid = validateCollectionListingDraft({
      ...validDraft,
      imagesText: 'https://img.example/main.jpg\nhttp://img.example/unsafe.jpg',
    });
    const skuInvalid = validateCollectionListingDraft({
      ...validDraft,
      skus: [{
        sourceSkuId: 'future-link', offerId: 'SPB-FUTURE', title: 'Будущий товар',
        price: '999', oldPrice: '1599', imageUrl: 'not-a-url',
      }],
    });

    expect(commonInvalid.ok).toBe(false);
    expect(commonInvalid.errors).toContain('所有待上传商品图片都必须是有效的 HTTPS 地址。');
    expect(skuInvalid.ok).toBe(false);
    expect(skuInvalid.errors).toContain('所有待上传商品图片都必须是有效的 HTTPS 地址。');
  });

  it('uses RMB fields directly and never recalculates a cross-border listing into RUB', () => {
    const built = buildCollectionListingCommands({
      ...validDraft,
      currencyCode: 'RUB',
      price: '', oldPrice: '', minPrice: '',
      skus: [{
        sourceSkuId: 'red', offerId: 'SPB-CNY', title: 'Красный товар',
        priceCny: '58.8', oldPriceCny: '76.44', minPriceCny: '45.2', enabled: true,
      }],
    }, 'operation-cny');

    expect(built.infoItems[0]).toMatchObject({
      offer_id: 'SPB-CNY', price: '58.80', old_price: '76.44', currency_code: 'CNY',
    });
    expect(built.priceItems[0]).toEqual({
      offer_id: 'SPB-CNY', price: '58.80', old_price: '76.44', min_price: '45.20', currency_code: 'CNY',
    });
  });

  it('uploads the 50% activity pair as CNY 100 sale price and CNY 200 reference price', () => {
    const built = buildCollectionListingCommands({
      ...validDraft,
      activityPriceUpload: true,
      skus: [{
        sourceSkuId: 'activity', offerId: 'SPB-ACTIVITY', title: 'Акционный товар',
        priceCny: '100', oldPriceCny: '200', minPriceCny: '70', enabled: true,
      }],
    }, 'operation-activity');

    expect(built.priceItems[0]).toEqual({
      offer_id: 'SPB-ACTIVITY',
      price: '100',
      old_price: '200',
      min_price: '70',
      currency_code: 'CNY',
    });
  });

  it('removes invalid optional PDF, video and Rich Content fields from every SKU import item', () => {
    const built = buildCollectionListingCommands({
      ...validDraft,
      attributesJson: undefined,
      attributes: [
        { id: 8789, complex_id: 0, values: [{ value: 'Документ PDF отсутствует' }] },
        { id: 8790, complex_id: 0, values: [{ value: 'Документ PDF отсутствует' }] },
        { id: 11254, complex_id: 0, values: [{ value: '{"blocks":[]}' }] },
        { id: 21837, complex_id: 0, values: [{ value: 'Видео не предоставлено' }] },
        { id: 21841, complex_id: 0, values: [{ value: 'Ссылка на видео отсутствует' }] },
        { id: 21845, complex_id: 0, values: [{ value: 'Видео не предоставлено' }] },
        { id: 22273, complex_id: 0, values: [{ value: '907805856885' }] },
      ],
      skus: [
        { sourceSkuId: 'one', offerId: 'SPB-ONE', title: 'Первый товар', price: '999', oldPrice: '1599' },
        { sourceSkuId: 'two', offerId: 'SPB-TWO', title: 'Второй товар', price: '999', oldPrice: '1599' },
      ],
    }, 'operation-invalid-media');

    expect(built.infoItems).toHaveLength(2);
    built.infoItems.forEach((item) => {
      expect(item.attributes.map((attribute) => attribute.id)).not.toEqual(expect.arrayContaining([
        8789, 8790, 11254, 21837, 21841, 21845, 22273,
      ]));
    });
  });

  it('repairs the legacy half-cent minimum price before generating a preview command', () => {
    const draft = {
      ...validDraft,
      activityPriceUpload: true,
      skus: [{
        sourceSkuId: 'legacy-half-cent', offerId: 'SPB-HALF-CENT', title: 'Акционный товар',
        priceCny: '38.79', oldPriceCny: '77.58', minPriceCny: '19.39', enabled: true,
      }],
    };
    const validation = validateCollectionListingDraft(draft);
    const built = buildCollectionListingCommands(draft, 'operation-half-cent');

    expect(validation.ok).toBe(true);
    expect(validation.rows[0].minPriceCny).toBe('19.40');
    expect(built.priceItems[0]).toMatchObject({ price: '38.79', old_price: '77.58', min_price: '19.40' });
  });

  it('does not hide a genuinely underpriced minimum behind the legacy repair', () => {
    const validation = validateCollectionListingDraft({
      ...validDraft,
      skus: [{
        sourceSkuId: 'invalid-minimum', offerId: 'SPB-INVALID-MIN', title: 'Акционный товар',
        priceCny: '38.79', oldPriceCny: '77.58', minPriceCny: '19.38', enabled: true,
      }],
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('最低价必须位于售价的 50% 到 100% 之间。');
  });

  it('builds one immutable three-step write chain for multiple enabled SKUs', () => {
    const built = buildCollectionListingCommands({
      ...validDraft,
      stock: '',
      warehouseId: '',
      skus: [
        { sourceSkuId: 'red', offerId: 'SPB-RED', title: 'Красный товар', price: '999', oldPrice: '1599', minPrice: '700', stock: '5', warehouseId: '12345' },
        { sourceSkuId: 'blue', offerId: 'SPB-BLUE', title: 'Синий товар', price: '1099', oldPrice: '1699', minPrice: '800', stock: '3', warehouseId: '12345' },
        { sourceSkuId: 'off', offerId: 'SPB-OFF', price: '1', oldPrice: '2', enabled: false },
      ],
    }, 'operation-multi');
    expect(built.infoItems).toHaveLength(2);
    expect(built.priceItems.map((item) => item.offer_id)).toEqual(['SPB-RED', 'SPB-BLUE']);
    expect(built.stockItems).toEqual([
      { offer_id: 'SPB-RED', stock: 5, warehouse_id: 12345 },
      { offer_id: 'SPB-BLUE', stock: 3, warehouse_id: 12345 },
    ]);
    expect(built.commands[0].command.payload.items).toHaveLength(2);
    expect(built.commands[1].command.payload.prices).toHaveLength(2);
    expect(built.commands[2].command.payload.stocks).toHaveLength(2);
  });

  it('keeps each SKU aspect attributes separate in the Ozon import payload', () => {
    const built = buildCollectionListingCommands({
      ...validDraft,
      attributes: [{ id: 10, complex_id: 0, values: [{ value: '旺崽' }] }],
      attributesJson: undefined,
      skus: [
        {
          sourceSkuId: 'red', offerId: 'SPB-RED', title: 'Красный товар',
          price: '999', oldPrice: '1599',
          attributes: [{ id: 20, complex_id: 9, values: [{ dictionary_value_id: 201, value: '红色' }] }],
        },
        {
          sourceSkuId: 'blue', offerId: 'SPB-BLUE', title: 'Синий товар',
          price: '1099', oldPrice: '1699',
          attributes: [{ id: 20, complex_id: 9, values: [{ dictionary_value_id: 202, value: '蓝色' }] }],
        },
      ],
    }, 'operation-aspects');

    const items = built.commands[0].command.payload.items;
    expect(items).toHaveLength(2);
    expect(items[0].attributes).toEqual(expect.arrayContaining([
      { id: 10, complex_id: 0, values: [{ value: '旺崽' }] },
      { id: 20, complex_id: 9, values: [{ dictionary_value_id: 201, value: '红色' }] },
    ]));
    expect(items[1].attributes).toEqual(expect.arrayContaining([
      { id: 10, complex_id: 0, values: [{ value: '旺崽' }] },
      { id: 20, complex_id: 9, values: [{ dictionary_value_id: 202, value: '蓝色' }] },
    ]));
  });

  it('blocks duplicate SKU variation payloads again at the immutable preview boundary', () => {
    const validation = validateCollectionListingDraft({
      ...validDraft,
      attributes: [{ id: 9048, complex_id: 0, values: [{ value: 'Hat29 Hat30' }] }],
      attributesJson: undefined,
      skuAttributeIds: ['10096', '10097'],
      skus: [
        {
          sourceSkuId: 'blue', offerId: 'WZ-6114480788859', title: 'Синяя шапка',
          price: '75.04', oldPrice: '150.08',
          attributes: [
            { id: 10096, values: [{ dictionary_value_id: 61571, value: 'Белый' }] },
            { id: 10097, values: [{ value: 'Синий, серо-белый и светло-синий' }] },
          ],
        },
        {
          sourceSkuId: 'grey', offerId: 'WZ-6114480788860', title: 'Серо-белая шапка',
          price: '75.04', oldPrice: '150.08',
          attributes: [
            { id: 10096, values: [{ dictionary_value_id: 61571, value: 'Белый' }] },
            { id: 10097, values: [{ value: 'Синий, серо-белый и светло-синий' }] },
          ],
        },
      ],
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('SKU 变体属性组合重复'),
    ]));
  });
});
