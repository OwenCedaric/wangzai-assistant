import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearFollowSellerCaptureMemoryCache,
  enrichProductPerformanceFollowSellers,
  mergeFollowSellerCapture,
} from './followSellerCaptureService.js';

function snapshot(records) {
  return {
    datasets: [{
      sequence: 12,
      dataset: 'product-performance',
      quality: 'confirmed-data',
      records,
    }],
  };
}

describe('followSellerCaptureService', () => {
  beforeEach(() => clearFollowSellerCaptureMemoryCache());

  it('merges confirmed seller count and price range into the matching SKU only', () => {
    const result = mergeFollowSellerCapture(snapshot([
      { id: '1760246018', title: '商品 A' },
      { id: '1760246019', title: '商品 B' },
    ]), [{
      sku: '1760246018',
      confirmed: true,
      followSellerConfirmed: true,
      productFactsConfirmed: true,
      followSellerCount: 2,
      followMinPrice: 1200,
      followMaxPrice: 1500,
      followSellers: [{ id: 'seller-1', name: '卖家一', price: 1200 }],
      source: 'ozon-public-other-offers',
    }]);

    expect(result.datasets[0].records[0]).toMatchObject({
      id: '1760246018',
      followSellerCount: 2,
      followMinPrice: 1200,
      followMaxPrice: 1500,
      followSellerSource: 'ozon-public-other-offers',
    });
    expect(result.datasets[0].records[1]).toEqual({ id: '1760246019', title: '商品 B' });
  });

  it('keeps a confirmed zero-seller response as real data', () => {
    const result = mergeFollowSellerCapture(snapshot([{ id: '1760246018' }]), [{
      sku: '1760246018',
      confirmed: true,
      followSellerConfirmed: true,
      productFactsConfirmed: true,
      followSellerCount: 0,
      followMinPrice: null,
      followMaxPrice: null,
      followSellers: [],
    }]);

    expect(result.datasets[0].records[0]).toMatchObject({
      followSellerCount: 0,
      followMinPrice: null,
      followMaxPrice: null,
    });
  });

  it('merges exact Card price, rating, reviews and explicit orders from product facts', () => {
    const result = mergeFollowSellerCapture(snapshot([{ id: '1760246018', sales: 900 }]), [{
      sku: '1760246018',
      confirmed: true,
      followSellerConfirmed: false,
      productFactsConfirmed: true,
      cardPrice: 1799,
      cardPriceCurrency: 'CNY',
      rating: 4.8,
      reviews: 123,
      orders: 42,
      productFactsSource: 'ozon-public-product-page',
    }]);

    expect(result.datasets[0].records[0]).toMatchObject({
      cardPrice: 1799,
      cardPriceCurrency: 'CNY',
      rating: 4.8,
      reviews: 123,
      orders: 42,
      productFactsConfirmed: true,
      productFactsSource: 'ozon-public-product-page',
    });
  });

  it('merges exact seller-variant package facts and explicit Maozi-compatible commission tiers', () => {
    const result = mergeFollowSellerCapture(snapshot([{
      id: '1760246018',
      packageDimensions: '90 x 80 x 70 mm',
      packageWeight: '700 g',
    }]), [{
      sku: '1760246018',
      confirmed: true,
      followSellerConfirmed: false,
      productFactsConfirmed: false,
      productLogisticsConfirmed: true,
      packageDimensions: '100 x 200 x 300 mm',
      packageWeight: '1500 g',
      rfbsRate: {
        rfbs_leq_1500: 15,
        rfbs_leq_5000: 12,
        rfbs_gt_5000: 10,
      },
      fbpRate: {
        fbp_leq_1500: 18,
        fbp_leq_5000: 16,
        fbp_gt_5000: 14,
      },
      categoryCommission: { category_id: 17028922 },
      productLogisticsSource: 'ozon-seller-variant',
    }]);

    expect(result.datasets[0].records[0]).toMatchObject({
      packageDimensions: '100 x 200 x 300 mm',
      packageWeight: '1500 g',
      rfbsRate: {
        rfbs_leq_1500: 15,
        rfbs_leq_5000: 12,
        rfbs_gt_5000: 10,
      },
      fbpRate: {
        fbp_leq_1500: 18,
        fbp_leq_5000: 16,
        fbp_gt_5000: 14,
      },
      productLogisticsConfirmed: true,
      productLogisticsSource: 'ozon-seller-variant',
    });
  });

  it('does not infer orders from sales and does not erase existing real values with null facts', () => {
    const result = mergeFollowSellerCapture(snapshot([{
      id: '1760246018',
      sales: 900,
      cardPrice: 1888,
      orders: 31,
    }, {
      id: '1760246019',
      sales: 700,
    }]), [{
      sku: '1760246018',
      confirmed: true,
      followSellerConfirmed: false,
      productFactsConfirmed: true,
      cardPrice: null,
      rating: null,
      reviews: null,
      orders: null,
    }, {
      sku: '1760246019',
      confirmed: true,
      followSellerConfirmed: false,
      productFactsConfirmed: true,
      cardPrice: 999,
      rating: 4.6,
      reviews: 18,
      orders: null,
    }]);

    expect(result.datasets[0].records[0]).toMatchObject({ cardPrice: 1888, orders: 31 });
    expect(result.datasets[0].records[1]).toMatchObject({
      sales: 700,
      cardPrice: 999,
      rating: 4.6,
      reviews: 18,
    });
    expect(result.datasets[0].records[1]).not.toHaveProperty('orders');
  });

  it('keeps independently confirmed seller and product branches without fabricating the failed branch', () => {
    const productOnly = mergeFollowSellerCapture(snapshot([{ id: '1760246018' }]), [{
      sku: '1760246018',
      confirmed: true,
      followSellerConfirmed: false,
      productFactsConfirmed: true,
      cardPrice: 1200,
      rating: 4.7,
      reviews: 25,
    }]);
    const sellerOnly = mergeFollowSellerCapture(snapshot([{
      id: '1760246018',
      cardPrice: 1200,
      rating: 4.7,
      reviews: 25,
    }]), [{
      sku: '1760246018',
      confirmed: true,
      followSellerConfirmed: true,
      productFactsConfirmed: false,
      followSellerCount: 3,
      followMinPrice: 1100,
      followMaxPrice: 1400,
      followSellers: [],
    }]);

    expect(productOnly.datasets[0].records[0]).not.toHaveProperty('followSellerCount');
    expect(productOnly.datasets[0].records[0]).toMatchObject({ cardPrice: 1200, reviews: 25 });
    expect(sellerOnly.datasets[0].records[0]).toMatchObject({
      cardPrice: 1200,
      rating: 4.7,
      reviews: 25,
      followSellerCount: 3,
    });
  });

  it('requests the first page of SKUs once and reuses the short-lived memory cache', async () => {
    const command = vi.fn(async (input) => ({
      result: {
        ready: true,
        requested: input.skus.length,
        confirmed: input.skus.length,
        failed: 0,
        results: input.skus.map((sku, index) => ({
          sku,
          confirmed: true,
          followSellerConfirmed: true,
          productFactsConfirmed: true,
          followSellerCount: index,
          followMinPrice: 1000 + index,
          followMaxPrice: 1200 + index,
          followSellers: [],
          source: 'ozon-public-other-offers',
        })),
      },
    }));
    const source = snapshot(Array.from({ length: 60 }, (_, index) => ({
      id: String(1760246000 + index),
      title: `商品 ${index + 1}`,
    })));

    const first = await enrichProductPerformanceFollowSellers({
      command,
      tabId: 'collector-tab',
      snapshot: source,
      limit: 50,
      now: 1_000,
    });
    const second = await enrichProductPerformanceFollowSellers({
      command,
      tabId: 'collector-tab',
      snapshot: source,
      limit: 50,
      now: 2_000,
    });

    expect(command).toHaveBeenCalledTimes(2);
    expect(command.mock.calls[0][0]).toMatchObject({
      command: 'ozon-data-follow-sellers',
      tabId: 'collector-tab',
      concurrency: 6,
    });
    expect(command.mock.calls[0][0].skus).toHaveLength(50);
    expect(command.mock.calls[1][0].skus).toHaveLength(10);
    expect(first.followSellerCoverage).toMatchObject({
      totalProductCount: 60,
      requestedCount: 50,
      confirmedCount: 50,
      cachedCount: 0,
      failedCount: 0,
      limited: true,
    });
    expect(second.followSellerCoverage).toMatchObject({
      requestedCount: 10,
      confirmedCount: 60,
      cachedCount: 50,
      limited: false,
    });
    expect(second.datasets[0].records[0].followSellerCount).toBe(0);
    expect(second.datasets[0].records[49].followSellerCount).toBe(49);
    expect(second.datasets[0].records[50]).toHaveProperty('followSellerCount', 0);
  });

  it('requests all one thousand product SKUs in restart-safe batches instead of silently sampling fifty', async () => {
    const command = vi.fn(async (input) => ({
      result: {
        ready: true,
        requested: input.skus.length,
        confirmed: input.skus.length,
        failed: 0,
        results: input.skus.map((sku) => ({
          sku,
          confirmed: true,
          followSellerConfirmed: true,
          productFactsConfirmed: true,
          followSellerCount: 0,
          followMinPrice: null,
          followMaxPrice: null,
          followSellers: [],
          source: 'ozon-public-other-offers',
        })),
      },
    }));
    const source = snapshot(Array.from({ length: 1_000 }, (_, index) => ({
      id: String(1760246000 + index),
      title: `商品 ${index + 1}`,
    })));

    const result = await enrichProductPerformanceFollowSellers({
      command,
      tabId: 'collector-tab',
      snapshot: source,
    });

    expect(command).toHaveBeenCalledTimes(4);
    expect(command.mock.calls.map(([input]) => input.skus.length)).toEqual([250, 250, 250, 250]);
    expect(new Set(command.mock.calls.flatMap(([input]) => input.skus)).size).toBe(1_000);
    expect(result.followSellerCoverage).toMatchObject({
      status: 'ready',
      totalProductCount: 1_000,
      requestedCount: 1_000,
      confirmedCount: 1_000,
      failedCount: 0,
      limited: false,
    });
    expect(result.datasets[0].records).toHaveLength(1_000);
    expect(result.datasets[0].records.every((record) => record.followSellerCount === 0)).toBe(true);
  });

  it('keeps completed batches and resumes the missing SKUs after an interrupted browser command', async () => {
    let batchNumber = 0;
    const interruptedCommand = vi.fn(async (input) => {
      batchNumber += 1;
      if (batchNumber === 2) {
        throw Object.assign(new Error('cancelled'), { code: 'PURCHASE_BROWSER_COMMAND_CANCELLED' });
      }
      return {
        result: {
          ready: true,
          requested: input.skus.length,
          confirmed: input.skus.length,
          failed: 0,
          results: input.skus.map((sku) => ({
            sku,
            confirmed: true,
            followSellerConfirmed: true,
            productFactsConfirmed: true,
            followSellerCount: 2,
            followMinPrice: 900,
            followMaxPrice: 1100,
            followSellers: [],
          })),
        },
      };
    });
    const source = snapshot(Array.from({ length: 600 }, (_, index) => ({
      id: String(1760246000 + index),
      title: `商品 ${index + 1}`,
    })));

    const interrupted = await enrichProductPerformanceFollowSellers({
      command: interruptedCommand,
      tabId: 'collector-tab',
      snapshot: source,
      now: 1_000,
    });

    expect(interrupted.followSellerCoverage).toMatchObject({
      status: 'partial',
      totalProductCount: 600,
      requestedCount: 500,
      confirmedCount: 250,
      failedCount: 250,
      limited: true,
      errorCode: 'PURCHASE_BROWSER_COMMAND_CANCELLED',
    });
    expect(interrupted.datasets[0].records[0]).toHaveProperty('followSellerCount', 2);
    expect(interrupted.datasets[0].records[250]).not.toHaveProperty('followSellerCount');

    const recoveryCommand = vi.fn(async (input) => ({
      result: {
        ready: true,
        requested: input.skus.length,
        confirmed: input.skus.length,
        failed: 0,
        results: input.skus.map((sku) => ({
          sku,
          confirmed: true,
          followSellerConfirmed: true,
          productFactsConfirmed: true,
          followSellerCount: 1,
          followMinPrice: 950,
          followMaxPrice: 1050,
          followSellers: [],
        })),
      },
    }));
    const recovered = await enrichProductPerformanceFollowSellers({
      command: recoveryCommand,
      tabId: 'collector-tab',
      snapshot: source,
      now: 2_000,
    });

    expect(recoveryCommand).toHaveBeenCalledTimes(2);
    expect(recoveryCommand.mock.calls.map(([input]) => input.skus.length)).toEqual([250, 100]);
    expect(recovered.followSellerCoverage).toMatchObject({
      status: 'ready',
      requestedCount: 350,
      confirmedCount: 600,
      cachedCount: 250,
      failedCount: 0,
      limited: false,
    });
  });

  it('still requests product facts when a SKU only has a confirmed follow count', async () => {
    const command = vi.fn(async () => ({
      result: {
        ready: true,
        requested: 1,
        confirmed: 1,
        failed: 0,
        results: [{
          sku: '1760246018',
          confirmed: true,
          followSellerConfirmed: true,
          productFactsConfirmed: true,
          followSellerCount: 3,
          followMinPrice: 900,
          followMaxPrice: 1100,
          followSellers: [],
          cardPrice: 880,
          rating: 4.9,
          reviews: 321,
          orders: null,
        }],
      },
    }));
    const result = await enrichProductPerformanceFollowSellers({
      command,
      tabId: 'collector-tab',
      snapshot: snapshot([{
        id: '1760246018',
        followSellerCount: 3,
        followMinPrice: 900,
        followMaxPrice: 1100,
      }]),
    });

    expect(command).toHaveBeenCalledOnce();
    expect(result.datasets[0].records[0]).toMatchObject({
      cardPrice: 880,
      rating: 4.9,
      reviews: 321,
      followSellerCount: 3,
    });
    expect(result.datasets[0].records[0]).not.toHaveProperty('orders');
  });

  it('caches a verified branch-level miss instead of hammering the same unavailable product page', async () => {
    const command = vi.fn(async () => ({
      result: {
        ready: true,
        requested: 1,
        confirmed: 1,
        failed: 0,
        results: [{
          sku: '1760246018',
          confirmed: true,
          followSellerConfirmed: true,
          productFactsConfirmed: false,
          followSellerCount: 2,
          followMinPrice: 900,
          followMaxPrice: 1100,
          followSellers: [],
        }],
      },
    }));
    const source = snapshot([{ id: '1760246018' }]);

    await enrichProductPerformanceFollowSellers({
      command,
      tabId: 'collector-tab',
      snapshot: source,
      now: 1_000,
    });
    const second = await enrichProductPerformanceFollowSellers({
      command,
      tabId: 'collector-tab',
      snapshot: source,
      now: 2_000,
    });

    expect(command).toHaveBeenCalledOnce();
    expect(second.datasets[0].records[0]).toHaveProperty('followSellerCount', 2);
    expect(second.followSellerCoverage).toMatchObject({
      status: 'partial',
      requestedCount: 0,
      followSellerConfirmedCount: 1,
      productFactsConfirmedCount: 0,
      cachedCount: 1,
    });
  });

  it('does not request SKUs whose seller and product branches are confirmed', async () => {
    const command = vi.fn();
    const result = await enrichProductPerformanceFollowSellers({
      command,
      tabId: 'collector-tab',
      snapshot: snapshot([{
        id: '1760246018',
        followSellerCount: 3,
        followMinPrice: 900,
        followMaxPrice: 1100,
        productFactsConfirmed: true,
      }]),
    });

    expect(command).not.toHaveBeenCalled();
    expect(result.followSellerCoverage).toMatchObject({
      status: 'ready',
      totalProductCount: 1,
      requestedCount: 0,
      confirmedCount: 1,
      productLogisticsConfirmedCount: 0,
    });
  });
});
