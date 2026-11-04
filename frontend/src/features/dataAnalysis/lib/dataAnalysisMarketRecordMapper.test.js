import { describe, expect, it } from 'vitest';
import { mergeMarketRecords, normalizeMarketRecord, resolveMarketDatasetId } from './dataAnalysisMarketRecordMapper.js';

describe('dataAnalysisMarketRecord', () => {
  it('merges repeated SKU captures without dropping older non-empty fields', () => {
    expect(mergeMarketRecords(
      { id: 'sku-1', sequence: 1, title: '旧标题', sales: 10, rating: 4.8 },
      { id: 'sku-1', sequence: 2, title: '新标题', price: 999 },
    )).toMatchObject({
      id: 'sku-1',
      sequence: 2,
      title: '新标题',
      price: 999,
      sales: 10,
      rating: 4.8,
    });
  });

  it('keeps search category directories separate from measurable keyword rows', () => {
    const endpoint = '/api/site/searchstat/Stats/queries/groups';
    expect(resolveMarketDatasetId('keywords', endpoint, {})).toBe('keyword-groups');
    expect(normalizeMarketRecord({ id: 'group-1', title: 'Бытовая техника' }, 'keywords', 1, '', endpoint)).toMatchObject({
      dataset: 'keyword-groups',
      id: 'group-1',
      title: 'Бытовая техника',
    });
  });

  it('maps Ozon keyword fields into stable business semantics without exposing raw fields', () => {
    const result = normalizeMarketRecord({
      raw: {
        query: '遥控汽车',
        count: 206405,
        itemsViews: 59,
        ord: 8852,
        gmv: 28013602,
        searchUsersToOrdUsers: 4,
        avgCaRub: 2680,
        uniqSellers: 41,
        usersWithoutInterectionShare: 45.9,
      },
    }, 'keywords', 3, '2026-07-22T08:00:00.000Z');

    expect(result).toMatchObject({
      dataset: 'keywords',
      title: '遥控汽车',
      searches: 206405,
      views: 59,
      orders: 8852,
      revenue: 28013602,
      conversion: 4,
      averageRevenue: 2680,
      uniqueSellers: 41,
      noInteractionShare: 45.9,
    });
    expect(result).not.toHaveProperty('raw');
    expect(result).not.toHaveProperty('sourceFields');
  });

  it('maps missing-items totalItems to sold units and preserves every returned market field', () => {
    const result = normalizeMarketRecord({
      raw: {
        productId: 'p-1',
        productName: '测试商品',
        totalItems: '4085',
        avgPrice: 5331.9479,
        gmvSum: 21781007.5799,
        gmvGrowth: -3.27,
        adsDays: 269996.451,
        adqDays: '12',
        category1Name: '服装',
        category2Name: '女装',
        category3Name: '连衣裙',
      },
    }, 'missing-items');

    expect(result).toMatchObject({
      sales: 4085,
      averagePrice: 5331.9479,
      revenue: 21781007.5799,
      growth: -3.27,
      averageDailyRevenue: 269996.451,
      averageDailyUnits: 12,
      category: '连衣裙',
      category1: '服装',
      category2: '女装',
      category3: '连衣裙',
    });
    expect(result.productCount).toBeUndefined();
  });

  it('classifies price-segmentation rows separately from competitor comparison', () => {
    const record = { raw: { key: 1, from: 0, to: 199 } };
    expect(resolveMarketDatasetId('comparison', '/api/site/exar-api/v2/gb/price_segmentation', record)).toBe('price-segments');
    expect(normalizeMarketRecord(record, 'comparison')).toMatchObject({
      dataset: 'price-segments',
      title: '0–199 ₽',
      priceFrom: 0,
      priceTo: 199,
    });
  });

  it('maps chart revenue from nested Ozon money metrics', () => {
    expect(normalizeMarketRecord({
      raw: {
        date: '2026-07-15',
        metrics: { revenueV2: { units: '12', nanos: 500000000 } },
      },
    }, 'trends')).toMatchObject({
      id: '2026-07-15',
      date: '2026-07-15',
      revenue: 12.5,
    });
  });

  it('routes charts by_sku rows into product details and preserves recommendations', () => {
    const endpoint = '/api/site/seller-analytics/charts/v3/table/by_sku';
    expect(resolveMarketDatasetId('trends', endpoint, {})).toBe('products');
    expect(normalizeMarketRecord({
      id: '4146125120',
      title: 'Soft Toy',
      article: 'mz-26050109-135366',
      imageUrl: 'https://ir-20.ozonstatic.cn/product.jpg',
      sales: 7,
      orders: 7,
      revenue: 1250.5,
      recommendation: 'add_to_promo',
    }, 'trends', 8, '2026-07-22T10:00:00.000Z', endpoint)).toMatchObject({
      dataset: 'products',
      id: '4146125120',
      title: 'Soft Toy',
      article: 'mz-26050109-135366',
      sales: 7,
      orders: 7,
      revenue: 1250.5,
      recommendation: 'add_to_promo',
    });
  });

  it('maps Ozon product-performance fields into the dedicated product dataset', () => {
    const result = normalizeMarketRecord({
      raw: {
        skuId: '778899',
        productName: '遥控汽车',
        brandName: 'RC Pro',
        sellerName: 'Test Seller',
        vendorCode: 'RC-001',
        categoryName: 'Радиоуправляемые игрушки',
        productFeature: '销售领导者',
        searchResultPosition: 12,
        orderedAmount: { units: '24500', nanos: 500000000 },
        salesDynamics: -3.5,
        orderedProductCount: 17,
        averagePurchasePrice: 1441.21,
        periodDays: 28,
        avgOrdersOnAccDays: 4.5,
        avgGmvOnAccDays: 6200.25,
        drr: 4.7,
        daysInPromo: 8,
        discount: 12.5,
        promoRevenueShare: 27.1,
        daysWithTrafarets: 4,
        views: 5000,
        qtyViewPdp: 1000,
        convToCartPdp: 8.8,
        sessionCountSearch: 4500,
        convToCartSearch: 3.2,
        convViewToOrder: 1.9,
        salesSchema: 'FBO',
        nullableRedemptionRate: 94.2,
        nullableCreateDate: '2026-06-30T00:00:00.000Z',
        attributes: [
          { key: '9454', value: 100 },
          { key: '9455', value: 200 },
          { key: '9456', value: 300 },
          { key: '4497', value: 1500 },
        ],
        followCount: 2,
        follow_min_price: 1200,
        follow_max_price: 1500,
        rfbs_rate: { low: 15, middle: 12, high: 10 },
        category_commission: { low: 15, middle: 12, high: 10 },
      },
    }, 'product-performance', 11, '2026-07-22T12:00:00.000Z');

    expect(result).toMatchObject({
      dataset: 'product-performance',
      id: '778899',
      title: '遥控汽车',
      brand: 'RC Pro',
      seller: 'Test Seller',
      article: 'RC-001',
      category: 'Радиоуправляемые игрушки',
      feature: '销售领导者',
      searchPosition: 12,
      orderAmount: 24500.5,
      dynamics: -3.5,
      orderedProducts: 17,
      averagePurchasePrice: 1441.21,
      periodDays: 28,
      averageDailyUnits: 4.5,
      averageDailyRevenue: 6200.25,
      adSpendShare: 4.7,
      promoDays: 8,
      promoDiscount: 12.5,
      promoRevenueShare: 27.1,
      paidPromotionDays: 4,
      productCardViews: 1000,
      productCardToCartRate: 8.8,
      searchCatalogViews: 4500,
      searchCatalogToCartRate: 3.2,
      impressionToOrderRate: 1.9,
      clickThroughRate: 20,
      fulfillmentModel: 'FBO',
      redemptionRate: 94.2,
      packageDimensions: '100 × 200 × 300 mm',
      packageWeight: '1500 g',
      listedAt: '2026-06-30T00:00:00.000Z',
      listingDays: 22,
      followSellerCount: 2,
      followMinPrice: 1200,
      followMaxPrice: 1500,
      rfbsRate: '15% / 12% / 10%',
      categoryCommission: { low: 15, middle: 12, high: 10 },
    });
    expect(result.returnCancelRate).toBeCloseTo(5.8, 8);
    expect(result).not.toHaveProperty('raw');
  });

  it('derives follow seller count from the original follow_info shape', () => {
    const result = normalizeMarketRecord({
      id: '1760246018',
      follow_info: {
        count: 4,
        sellers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      },
      follow_min_price: 899,
      follow_max_price: 1299,
    }, 'product-performance');

    expect(result).toMatchObject({
      followSellerCount: 4,
      followMinPrice: 899,
      followMaxPrice: 1299,
    });
  });
});
