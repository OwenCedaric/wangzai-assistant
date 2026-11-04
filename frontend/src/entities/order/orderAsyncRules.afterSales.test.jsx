import { describe, expect, it } from 'vitest';
import { getAfterSalesStatusByRules, runIsolatedShopAsync } from './orderAsyncRules.jsx';

describe('runIsolatedShopAsync', () => {
  it('starts every shop in its own lane and preserves per-shop results', async () => {
    const shops = [{ id: 'shop-a' }, { id: 'shop-b' }, { id: 'shop-c' }];
    const started = [];
    const resolvers = new Map();

    const pending = runIsolatedShopAsync(shops, (shop) => {
      started.push(shop.id);
      return new Promise((resolve, reject) => {
        resolvers.set(shop.id, { resolve, reject });
      });
    });

    await Promise.resolve();
    expect(started).toEqual(['shop-a', 'shop-b', 'shop-c']);

    resolvers.get('shop-b').resolve({ shopId: 'shop-b', amount: 20 });
    resolvers.get('shop-c').reject(new Error('shop-c failed'));
    resolvers.get('shop-a').resolve({ shopId: 'shop-a', amount: 10 });

    const results = await pending;
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      status: 'fulfilled',
      value: { shopId: 'shop-a', amount: 10 },
    });
    expect(results[1]).toEqual({
      status: 'fulfilled',
      value: { shopId: 'shop-b', amount: 20 },
    });
    expect(results[2].status).toBe('rejected');
    expect(results[2].reason).toEqual(new Error('shop-c failed'));
  });

  it('keeps ten consecutive twenty-shop refreshes inside the three-shop pool', async () => {
    const shops = Array.from({ length: 20 }, (_, index) => ({ id: `shop-${index + 1}` }));
    for (let run = 0; run < 10; run += 1) {
      let active = 0;
      let maxActive = 0;
      const results = await runIsolatedShopAsync(shops, async (shop) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return shop.id;
      });

      expect(maxActive).toBe(3);
      expect(results).toHaveLength(20);
      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    }
  });

  it('opens the batch circuit and never starts untouched shops after a fatal transport failure', async () => {
    const shops = Array.from({ length: 20 }, (_, index) => ({ id: `shop-${index + 1}` }));
    const started = [];
    const transportError = Object.assign(new Error('无法连接本地 API'), {
      code: 'LOCAL_API_TRANSPORT_FAILED',
    });

    const results = await runIsolatedShopAsync(
      shops,
      async (shop) => {
        started.push(shop.id);
        if (shop.id === 'shop-1') throw transportError;
        await new Promise((resolve) => setTimeout(resolve, 2));
        return shop.id;
      },
      {
        getStopReason: (settled) =>
          settled.status === 'rejected' && settled.reason?.code === 'LOCAL_API_TRANSPORT_FAILED'
            ? settled.reason
            : null,
      }
    );

    expect(started).toEqual(['shop-1', 'shop-2', 'shop-3']);
    expect(results.slice(3).every((result) => result.reason?.code === 'LOCAL_API_BATCH_CIRCUIT_OPEN')).toBe(true);
  });
});

describe('getAfterSalesStatusByRules', () => {
  it('keeps delivered lifecycle above an explicit handover-refusal reason', () => {
    const result = getAfterSalesStatusByRules(
      {
        source: 'rfbs-return',
        return_id: 'explicit-refusal-with-delivered-lifecycle',
        reason: 'Покупатель отказался при вручении: неполная комплектация',
        status: 'UtilizingByOzon',
        originalOrderStatus: 'delivered',
        originalOrderSubstatus: 'posting_received',
        originalOrder: {
          status: 'delivered',
          substatus: 'posting_received',
        },
        financeRefundConfirmed: true,
        financeRefundEvidence: {
          checked: true,
          confirmed: true,
          signedRefundConfirmed: true,
          hasDeliveredSaleOperation: true,
        },
      },
      'rfbs-return'
    );

    expect(result.status).toBe('签收后退款');
    expect(result.deliveryEvidence.refused).toBe(true);
    expect(result.reason).toContain('签收状态优先于售后原因');
  });

  it('still classifies a wrong-item return after delivery as signed refund', () => {
    const result = getAfterSalesStatusByRules(
      {
        source: 'rfbs-return',
        return_id: 'wrong-item-after-delivery',
        reason: 'Привезли не тот товар',
        status: 'MoneyReturned',
        rejection_reason: [],
        rejection_comment: '',
        originalOrderStatus: 'delivered',
        originalOrderSubstatus: 'posting_received',
        originalOrder: {
          status: 'delivered',
          substatus: 'posting_received',
          delivering_date: null,
        },
      },
      'rfbs-return'
    );

    expect(result.status).toBe('签收后退款');
  });

  it('does not let a cancellation reason downgrade an already delivered return', () => {
    const result = getAfterSalesStatusByRules(
      {
        source: 'rfbs-return',
        return_id: 'delivered-return-with-cancel-reason',
        reason: 'Товар закончился на складе',
        originalOrderStatus: 'delivered',
        originalOrderSubstatus: 'posting_received',
      },
      'rfbs-return'
    );

    expect(result.status).toBe('签收后退款');
  });
});
