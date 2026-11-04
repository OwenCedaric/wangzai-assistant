import { describe, expect, it } from 'vitest';
import { buildPromptLibraryOzonWorkbenchContext } from './promptLibraryOzonWorkbenchContext.js';

describe('promptLibraryOzonWorkbenchContext', () => {
  it('builds the shared Ozon workbench contract from the current search row', () => {
    const context = buildPromptLibraryOzonWorkbenchContext({
      id: '3568698657',
      title: 'Радиоуправляемая машина',
      link: 'https://www.ozon.ru/product/radio-car-3568698657/',
      imageUrl: 'https://cdn.example.test/car.jpg',
      category1: '儿童用品',
      category2: '遥控玩具',
      brand: 'RC Pro',
      seller: 'Test Seller',
      price: 1999,
      cardPrice: 1799,
      sales: 120,
      orders: 98,
      revenue: 239880,
      stock: 44,
      averageDailyRevenue: 7996,
      averageDailyUnits: 4,
      adSpendShare: 4.7,
      productCardViews: 1000,
      productCardToCartRate: 8.8,
      fulfillmentModel: 'FBO',
      packageDimensions: '100 × 200 × 300 mm',
      packageWeight: '850 g',
      followSellerCount: 2,
      followMinPrice: 1200,
      followMaxPrice: 1500,
    });

    expect(context).toMatchObject({
      sidebarKind: 'product-analysis',
      title: 'Ozon 商品分析操作台',
      product: {
        title: 'Радиоуправляемая машина',
        sku: '3568698657',
        productUrl: 'https://www.ozon.ru/product/radio-car-3568698657/',
      },
      productAnalysis: {
        category: '儿童用品 / 遥控玩具',
        price: '1 999 ₽',
        cardPrice: '1 799 ₽',
        sales: '120 件',
        orders: '98',
        revenue: '239 880 ₽',
        stock: '44 件',
        fulfillmentModel: 'FBO',
        packageDimensions: '100 × 200 × 300 mm',
        followSellerCount: '2',
        followPriceRange: '1 200 ₽–1 500 ₽',
      },
    });
  });

  it('keeps the real Card price currency instead of labelling CNY as rubles', () => {
    const context = buildPromptLibraryOzonWorkbenchContext({
      id: '2756412843',
      cardPrice: 2022.35,
      cardPriceCurrency: 'CNY',
    });

    expect(context.productAnalysis.cardPrice).toBe('¥2,022.35');
  });

  it('maps SF product-detail aliases instead of leaving available fields empty', () => {
    const context = buildPromptLibraryOzonWorkbenchContext({
      sku: 2962820304,
      sfSource: 'seerfar-open-api',
      title: '测试商品',
      price: 163,
      brandName: '品牌 A',
      sellerName: '卖家 A',
      reviewRating: 4.8,
      reviewCount: 123,
      drr: 5.5,
      sessionCount: 900,
      sessionCountSearch: 700,
      convToCartPdp: 12.3,
      convToCartSearch: 8.4,
      convViewToOrder: 4.2,
      fulfillment: ['FBO'],
      returnCancellationRate: 3.1,
      dimension: '10 × 8 × 2 cm',
      weight: 85,
      upDays: 120,
    });

    expect(context.productAnalysis).toMatchObject({
      brand: '品牌 A',
      seller: '卖家 A',
      rating: '4.8 分',
      reviews: '123 条',
      adSpendShare: '5.5%',
      productCardViews: '900',
      searchCatalogViews: '700',
      productCardToCartRate: '12.3%',
      searchCatalogToCartRate: '8.4%',
      impressionToOrderRate: '4.2%',
      fulfillmentModel: 'FBO',
      returnCancelRate: '3.1%',
      packageDimensions: '10 × 8 × 2 cm',
      packageWeight: '85 g',
      listingDays: '120 天',
    });
    expect(context.productAnalysis.visibleFields).toContain('price');
    expect(context.productAnalysis.visibleFields).not.toContain('cardPrice');
    expect(context.productAnalysis.visibleFields).not.toContain('orders');
  });
});
