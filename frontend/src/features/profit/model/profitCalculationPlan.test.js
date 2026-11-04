import { describe, expect, it } from 'vitest';
import { createProfitShopCalculationLanes } from '../../../services/profitShopCalculationLanes.js';
import { createProfitCalculationPlan, createProfitCalculationSignatures } from './profitCalculationSignatures.js';

function sample() {
  const shops = [1, 2, 3].map(n => ({ id: `shop-${n}`, clientId: `client-${n}`, name: `name-${n}` }));
  const rows = shops.flatMap(shop => Array.from({ length: 4 }, (_, n) => ({ id: `same-${n}`, shopId: shop.id,
    shopClientId: shop.clientId, amount: 100 + n, updatedAt: '2026-09-06T00:00:00Z' })));
  return { rows, inputs: { readableShops: shops,
    profitLocalFinanceContexts: { byShopId: new Map([['shop-1', { checked: new Set(['same-1']), at: new Date('2026-09-06') }]]), byClientId: new Map() },
    profitImageMap: new Map(), profitFinanceRows: {}, profitLedgerRows: {},
    profitLocalInputs: { purchaseLocalOverrides: { 'client-1:same-1': { shopId: 'shop-1', amount: 12 },
      unowned: { note: 'shared legacy input' } }, productSourceLinks: {} },
    ratingPenaltyIndex: new Map([['same-1', [{ shopId: 'shop-2', value: 7 }, { shopId: 'shop-1', value: 4 }]]]),
  } };
}

describe('row-level profit input planning', () => {
  it('preserves every value from the original full-shop signature', async () => {
    const { rows, inputs } = sample();
    rows[0].self = rows[0];
    const lanes = createProfitShopCalculationLanes(rows);
    const original = createProfitCalculationSignatures(lanes, inputs);
    const plans = await createProfitCalculationPlan(lanes, inputs);
    for (const [shopId, plan] of plans) {
      const reconstructed = { ...JSON.parse(plan.sharedSignature), rows: plan.items.map(item => JSON.parse(item.signature)) };
      expect(reconstructed).toEqual(JSON.parse(original.get(shopId)));
    }
  });

  it('separates same order numbers in different shops and repeated occurrences', async () => {
    const { rows, inputs } = sample();
    rows.push(rows[0]);
    const plans = await createProfitCalculationPlan(createProfitShopCalculationLanes(rows), inputs);
    const allKeys = [...plans.values()].flatMap(plan => plan.items.map(item => `${plan.shopId}:${item.cacheKey}`));
    expect(new Set(allKeys).size).toBe(rows.length);
  });

  it('yields preparation work and cancels before returning a stale plan', async () => {
    const { rows, inputs } = sample();
    const controller = new AbortController();
    let yields = 0;
    await expect(createProfitCalculationPlan(createProfitShopCalculationLanes(rows), inputs, {
      signal: controller.signal, yieldEvery: 2,
      yieldThread: async () => { yields += 1; controller.abort(); },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(yields).toBe(1);
  });
});
