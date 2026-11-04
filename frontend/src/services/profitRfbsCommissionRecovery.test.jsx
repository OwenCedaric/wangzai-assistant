import { describe, expect, it } from 'vitest';
import { applyOzonLocalProductEntitiesToRows } from '../entities/product/productLocalMirror.jsx';
import {
  createProfitOrderFromLedgerRow,
  normalizeOzonProfitOrder,
} from '../entities/profit/profitDisplayRules.jsx';
import { createProfitLedgerRow, mergeProfitLedgerRows } from './profitLedgerService.js';

describe('profit rFBS commission recovery', () => {
  it('restores commission from the order total when a cached single-SKU snapshot lost its line price', () => {
    const order = {
      id: '61683787-0268-1',
      shopId: 'ozon-shop-example-02',
      shopClientId: '4067587',
      amountValue: 88,
      currencyCode: 'CNY',
      fulfillment: 'FBS',
      products: [
        {
          offerId: 'SKU-202608060418-11-01',
          sku: 'SKU-202608060418-11-01',
          skuId: '5359748272',
          productId: '5831721344',
          qty: 1,
        },
      ],
    };
    const cachedLedger = createProfitLedgerRow(order, {
      amounts: {
        sourcePurchaseCostCny: 0,
        estimatedAcquiringFeeCny: 1.76,
        estimatedDeliveryServiceFeeCny: 1.22,
        logisticsFeeCny: 53.09,
        crossBorderBusFeeCny: 1.2,
      },
      allowZeroPurchaseCost: true,
    });
    expect(cachedLedger.amounts.estimatedCommissionFeeCny.status).toBe('pending');

    const cachedOrder = createProfitOrderFromLedgerRow(cachedLedger);
    const [enrichedOrder] = applyOzonLocalProductEntitiesToRows(
      [cachedOrder],
      new Map([
        [
          '61683787-0268-1:0',
          {
            productId: '5831721344',
            offerId: 'SKU-202608060418-11-01',
            sku: '5359748272',
            currencyCode: 'CNY',
            commissionPercent: 17,
            commissionPercents: { fbs: 17, rfbs: 12 },
          },
        ],
      ]),
      (row) => row.id,
      { commissionRateMode: 'rFBS' }
    );

    expect(enrichedOrder).toMatchObject({
      commissionMode: 'rFBS',
      commissionPercent: '12%',
      commissionAmount: '¥10.56',
    });
    expect(enrichedOrder.products[0]).toMatchObject({ commissionPercent: 12 });
    expect(enrichedOrder.products[0].commissionAmountValue).toBeNull();

    const normalized = normalizeOzonProfitOrder(enrichedOrder);
    expect(normalized.profitLedger.amounts.estimatedCommissionFeeCny).toMatchObject({
      value: 10.56,
      status: 'ready',
    });
    const [merged] = mergeProfitLedgerRows([cachedLedger], [normalized.profitLedger], {
      keepUnseenCached: false,
    });
    expect(merged.amounts.estimatedCommissionFeeCny).toMatchObject({
      value: 10.56,
      status: 'ready',
    });
  });
});
