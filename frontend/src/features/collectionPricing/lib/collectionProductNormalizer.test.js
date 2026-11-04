import { describe, expect, it } from 'vitest';

import {
  isProductImageUrl,
  normalizeCollectedProduct,
} from './collectionProductNormalizer.js';
import { normalizeCollectionProductPricingDraft } from './collectionProductPricingDraft.js';

describe('collection product normalizer', () => {
  it('maps the built-in browser capture into a normalized collection product', () => {
    const product = normalizeCollectedProduct({
      platform: '1688',
      pageType: 'product',
      sourceUrl: 'https://detail.1688.com/offer/123.html?spm=abc#private',
      sourceProductId: '123',
      productTitle: '遥控汽车',
      purchasePrice: 25.5,
      currency: 'CNY',
      imageUrl: 'https://img.example/main.jpg',
      images: ['https://img.example/main.jpg', 'https://img.example/second.jpg'],
      weightKg: 0.35,
      lengthCm: 20,
      widthCm: 10,
      heightCm: 8,
      skus: [{ id: 'red', name: '红色', price: 25.5 }],
    });
    expect(product.images).toHaveLength(2);
    expect(product.weightG).toBe('350');
    expect(product.sourceUrl).not.toContain('#private');
    expect(product.sourceUrl).not.toContain('spm=');
    expect(product.purchasePrice).toBe('25.5');
    expect(product.images.join('\n')).toContain('main.jpg');
  });

  it('preserves the per-product Ozon listing workflow draft after local normalization', () => {
    const product = normalizeCollectedProduct({
      id: 'collected-1',
      platform: '1688',
      sourceProductId: '123',
      productTitle: '遥控汽车',
      mainImages: ['https://img.example/main.jpg'],
      skus: [{ id: 'red', name: '红色', price: 25.5 }],
      ozonListingDraft: {
        shopId: 'shop-2',
        descriptionCategoryId: '17028922',
        typeId: '97081675',
        title: '遥控越野汽车儿童玩具',
        skus: [{
          sourceSkuId: 'red', offerId: 'CAR-RED', price: '1999', oldPrice: '2399',
          stock: '12', warehouseId: 'warehouse-1', enabled: true,
        }],
      },
    });

    expect(product.ozonListingDraft).toMatchObject({
      shopId: 'shop-2',
      descriptionCategoryId: '17028922',
      typeId: '97081675',
      title: '遥控越野汽车儿童玩具',
    });
    expect(product.ozonListingDraft.skus[0]).toMatchObject({
      sourceSkuId: 'red', offerId: 'CAR-RED', price: '1999', oldPrice: '2399',
      stock: '', warehouseId: '', enabled: true,
      inventoryByShopId: {
        'shop-2': { stock: '12', warehouseId: 'warehouse-1' },
      },
    });
  });

  it('does not mix an Ozon RUB competitor price into the CNY quote contract', () => {
    const product = normalizeCollectedProduct({
      platform: 'Ozon买家',
      sourceUrl: 'https://www.ozon.ru/product/test-123/',
      productTitle: 'Тест',
      purchasePrice: 999,
      currency: 'RUB',
    });
    const pricingDraft = normalizeCollectionProductPricingDraft({}, product);
    expect(product.sourceUrl).toContain('ozon.ru');
    expect(pricingDraft.purchaseCost).toBe('');
    expect(pricingDraft.currentPrice).toBe('');
  });

  it('never silently treats an unknown foreign marketplace price as CNY', () => {
    const foreign = normalizeCollectedProduct({
      platform: 'Amazon',
      sourceUrl: 'https://www.amazon.com/dp/B0ABC12345',
      sourceProductId: 'B0ABC12345',
      productTitle: 'Amazon 咖啡机',
      purchasePrice: 89.99,
      mainImages: ['https://img.example/amz-main.jpg'],
      skus: [{ id: 'B0ABC12345', name: '标准款', price: 89.99 }],
    });
    const domestic = normalizeCollectedProduct({
      platform: '京东',
      sourceUrl: 'https://item.jd.com/50005.html',
      sourceProductId: '50005',
      productTitle: '京东机械键盘',
      purchasePrice: 299,
      mainImages: ['https://img.example/jd-main.jpg'],
      skus: [{ id: '50005', name: '红轴', price: 299 }],
    });

    expect(foreign.currency).toBe('UNKNOWN');
    expect(normalizeCollectionProductPricingDraft({}, foreign).purchaseCost).toBe('');
    expect(domestic.currency).toBe('CNY');
    expect(normalizeCollectionProductPricingDraft({}, domestic).purchaseCost).toBe('299');
  });

  it('keeps main, SKU and detail images separated while removing UI icon noise', () => {
    const product = normalizeCollectedProduct({
      platform: '淘宝',
      pageType: 'product',
      sourceUrl: 'https://item.taobao.com/item.htm?id=456&utm_source=test',
      sourceProductId: '456',
      productTitle: '测试眼镜',
      purchasePrice: 19.9,
      mainImages: [
        'https://img.example/product/main-1.jpg',
        'https://img.example/assets/icon-cart.png',
        'https://img.example/product/main-1.jpg',
      ],
      skuImages: [
        { skuId: 'black', skuName: '黑色', imageUrl: 'https://img.example/product/sku-black.jpg' },
        { skuId: 'logo', skuName: '错误图', imageUrl: 'https://img.example/shop/logo.png' },
      ],
      detailImages: [
        'https://img.example/product/detail-1.jpg',
        'https://img.example/product/main-1.jpg',
        'https://img.example/service/badge-7day.png',
      ],
      attributes: [{ name: '镜框材质', value: '合金' }],
      skus: [{ id: 'black', name: '黑色', price: 19.9, imageUrl: 'https://img.example/product/sku-black.jpg' }],
    });

    expect(product.mainImages).toEqual(['https://img.example/product/main-1.jpg']);
    expect(product.skuImages).toEqual([{
      skuId: 'black', skuName: '黑色', imageUrl: 'https://img.example/product/sku-black.jpg',
    }]);
    expect(product.detailImages).toEqual(['https://img.example/product/detail-1.jpg']);
    expect(product.images).toHaveLength(3);
    expect(product.completeness.status).toBe('complete');
    expect(product.sourceUrl).not.toContain('utm_source');
  });

  it('rejects vector, icon, avatar and tracking-pixel URLs', () => {
    expect(isProductImageUrl('https://img.example/product/photo.jpg')).toBe(true);
    expect(isProductImageUrl('https://img.example/icons/menu.svg')).toBe(false);
    expect(isProductImageUrl('https://img.example/shop/avatar.png')).toBe(false);
    expect(isProductImageUrl('https://img.example/analytics/pixel.gif')).toBe(false);
  });

  it('preserves structured SKU package data recovered by the built-in browser', () => {
    const product = normalizeCollectedProduct({
      platform: '1688', pageType: 'product', sourceProductId: '789',
      sourceUrl: 'https://detail.1688.com/offer/789.html', productTitle: '金属眼镜', purchasePrice: 8.4,
      mainImages: ['https://img.example/glasses.jpg'], videoUrl: 'https://video.example/glasses.mp4',
      skus: [{ id: 'silver-100', name: '银框 / 近视100度', price: 8.4, weightG: 180,
        imageUrl: 'https://img.example/silver.jpg', option: { unitWeight: 0.18 } }],
    });

    expect(product.skus[0]).toMatchObject({
      id: 'silver-100', price: '8.4', weightG: '180', option: { unitWeight: 0.18 },
    });
    expect(product.videoUrl).toBe('https://video.example/glasses.mp4');
  });

  it('preserves structured SKU attribute names and values for model filling', () => {
    const product = normalizeCollectedProduct({
      platform: '1688', sourceProductId: 'structured-sku-attributes',
      skus: [{
        id: 'tea-250', name: '金框【变色茶】-近视250度',
        attributes: [
          { name: '镜框颜色', value: '金框' },
          { name: '镜片颜色', value: '变色茶' },
          { name: '度数', value: '近视250度' },
        ],
      }],
    });

    expect(product.skus[0].attributes).toEqual([
      { name: '镜框颜色', value: '金框' },
      { name: '镜片颜色', value: '变色茶' },
      { name: '度数', value: '近视250度' },
    ]);
  });

  it('keeps the full source price range and purchase rules instead of only one teaser price', () => {
    const product = normalizeCollectedProduct({
      platform: '1688', pageType: 'product', sourceProductId: 'rules-1688',
      sourceUrl: 'https://detail.1688.com/offer/rules-1688.html', productTitle: '规则完整商品',
      purchasePrice: '5.40-8.40', purchasePriceMin: 3.3, purchasePriceMax: 8.4,
      sourceCategoryId: '1033155', sourceCategoryName: '平光镜', sourceCategoryPath: '服饰配件、饰品 / 平光镜',
      shippingStatus: 'starting', shippingFeeMin: 3, shippingRuleText: '运费 ¥3 起，按收货地区结算',
      minimumOrderQuantity: 1, minimumOrderUnit: '副', mixedBatchStatus: 'yes',
      perSkuMinimumQuantity: 2, purchaseMultiple: 2, deliveryLeadTimeHours: 48, deliveryText: '承诺48小时内发货',
      attributes: [{ name: '产品类别', value: '平光镜' }],
      mainImages: ['https://img.example/rules-main.jpg'],
      skus: [
        { id: 'cheap', name: '基础款', price: 3.3, weight: '0.05 kg' },
        { id: 'high', name: '升级款', price: 8.4, weightG: 50 },
      ],
    });

    expect(product).toMatchObject({
      purchasePrice: '3.3', purchasePriceMin: '3.3', purchasePriceMax: '8.4',
      sourceCategoryId: '1033155', sourceCategoryName: '平光镜',
      sourceCategoryPath: '服饰配件、饰品 / 平光镜',
      shippingStatus: 'starting', shippingFeeMin: '3', shippingRuleText: '运费 ¥3 起，按收货地区结算',
      minimumOrderQuantity: '1', minimumOrderUnit: '副', mixedBatchStatus: 'yes',
      perSkuMinimumQuantity: '2', purchaseMultiple: '2', deliveryLeadTimeHours: '48',
      weightG: '50', weightMinG: '50', weightMaxG: '50',
    });
    expect(product.priceRangeEvidence).toMatchObject({ source: 'sku-range', pricedSkuCount: 2 });
    expect(product.weightEvidence).toMatchObject({ source: 'sku-consensus', measuredSkuCount: 2, normalizedUnit: 'g' });
  });

  it('normalizes supplier weight units and keeps a SKU weight range when variants differ', () => {
    const product = normalizeCollectedProduct({
      platform: '1688', sourceProductId: 'weight-units',
      attributes: [{ name: '产品类别', value: '收纳盒' }],
      skus: [
        { id: 'kg', name: '千克', price: 10, weight: '0.2 kg' },
        { id: 'jin', name: '市斤', price: 12, weight: '1斤' },
        { id: 'oz', name: '盎司', price: 14, weight: '10 oz' },
      ],
    });

    expect(product.skus.map((sku) => sku.weightG)).toEqual(['200', '500', '283.495']);
    expect(product.weightG).toBe('');
    expect(product.weightMinG).toBe('200');
    expect(product.weightMaxG).toBe('500');
    expect(product.sourceCategoryName).toBe('收纳盒');
  });

  it('backfills every 1688 SKU from its raw option dimensions and builds a product consensus', () => {
    const product = normalizeCollectedProduct({
      platform: '1688', pageType: 'product', sourceProductId: '907805856885',
      sourceUrl: 'https://detail.1688.com/offer/907805856885.html', productTitle: '6639感光变色眼镜框', purchasePrice: 8.4,
      mainImages: ['https://img.example/glasses-main.jpg'],
      skus: Array.from({ length: 82 }, (_, index) => ({
        id: `sku-${index + 1}`, name: `眼镜规格 ${index + 1}`, price: 8.4,
        option: { skuId: `sku-${index + 1}`, length: 18, width: 8, height: 2, volume: 288, weight: 50 },
      })),
    });

    expect(product).toMatchObject({
      packageLengthCm: '18', packageWidthCm: '8', packageHeightCm: '2',
      packageDimensionEvidence: {
        source: 'sku-consensus', calculatedVolumeCm3: '288',
        skuComparison: {
          totalSkuCount: 82, completeSkuCount: 82, matchingSkuCount: 82,
          differentSkuCount: 0, missingSkuCount: 0, allMatch: true,
        },
      },
    });
    expect(product.skus).toHaveLength(82);
    expect(product.skus.every((sku) => (
      sku.packageLengthCm === '18' && sku.packageWidthCm === '8' && sku.packageHeightCm === '2'
    ))).toBe(true);
    expect(product.skus[0]).toMatchObject({
      weightG: '50',
      packageDimensionEvidence: {
        source: 'sku-option', inherited: false, matchesSourceOption: true,
        reportedVolumeCm3: '288', calculatedVolumeCm3: '288', volumeMatches: true,
      },
    });
  });

  it('keeps different SKU dimensions separate instead of inventing a product consensus', () => {
    const product = normalizeCollectedProduct({
      platform: '1688', sourceProductId: 'mixed-dimensions',
      skus: [
        { id: 'small', name: '小号', price: 3, option: { length: 18, width: 8, height: 2, volume: 288 } },
        { id: 'large', name: '大号', price: 4, option: { length: 20, width: 9, height: 3, volume: 540 } },
      ],
    });

    expect([product.packageLengthCm, product.packageWidthCm, product.packageHeightCm]).toEqual(['', '', '']);
    expect(product.skus.map((sku) => [sku.packageLengthCm, sku.packageWidthCm, sku.packageHeightCm])).toEqual([
      ['18', '8', '2'], ['20', '9', '3'],
    ]);
    expect(product.packageDimensionEvidence.skuComparison.allMatch).toBe(false);
  });

  it('inherits supplied product dimensions only for missing SKU fields and records the source', () => {
    const product = normalizeCollectedProduct({
      platform: '1688', sourceProductId: 'product-dimensions',
      packageLengthCm: 30, packageWidthCm: 20, packageHeightCm: 10,
      skus: [
        { id: 'missing', name: '未单独提供尺寸', price: 3 },
        { id: 'own', name: '单独提供尺寸', price: 4, lengthCm: 31, widthCm: 21, heightCm: 11 },
      ],
    });

    expect(product.skus[0]).toMatchObject({
      packageLengthCm: '30', packageWidthCm: '20', packageHeightCm: '10',
      packageDimensionEvidence: { source: 'product-inherited', inherited: true },
    });
    expect(product.skus[1]).toMatchObject({
      packageLengthCm: '31', packageWidthCm: '21', packageHeightCm: '11',
      packageDimensionEvidence: { source: 'sku-structured', inherited: false },
    });
    expect(product.packageDimensionEvidence.skuComparison).toMatchObject({
      matchingSkuCount: 1, differentSkuCount: 1, missingSkuCount: 0, allMatch: false,
    });
  });

  it('converts explicitly-unitized SKU dimensions to cm and exposes volume mismatches', () => {
    const product = normalizeCollectedProduct({
      platform: '1688', sourceProductId: 'unitized-dimensions',
      skus: [{
        id: 'mm-size', name: '毫米尺寸', price: 3,
        option: { lengthMm: 180, widthMm: 80, heightMm: 20, volume: 300 },
      }],
    });

    expect(product.skus[0]).toMatchObject({
      packageLengthCm: '18', packageWidthCm: '8', packageHeightCm: '2',
      packageDimensionEvidence: { calculatedVolumeCm3: '288', reportedVolumeCm3: '300', volumeMatches: false },
    });
  });

  it('preserves more than 200 structured SKUs for large 1688 variant matrices', () => {
    const product = normalizeCollectedProduct({
      platform: '1688', pageType: 'product', sourceProductId: 'large-1688',
      sourceUrl: 'https://detail.1688.com/offer/999.html', productTitle: '大规格矩阵商品', purchasePrice: 9.9,
      mainImages: ['https://img.example/large-main.jpg'],
      skus: Array.from({ length: 260 }, (_, index) => ({
        id: `sku-${index + 1}`, name: `规格${index + 1}`, price: 9.9,
      })),
    });
    expect(product.skus).toHaveLength(260);
    expect(product.skus[0].enabled).toBe(true);
    expect(product.skus.at(-1).id).toBe('sku-260');
  });
});
