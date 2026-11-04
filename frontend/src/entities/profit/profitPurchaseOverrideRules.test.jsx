import { describe, expect, it } from 'vitest';
import { getProfitActualCrossBorderBusFeeValueCny, upsertProfitManualOverrideAmount } from './profitFinanceEvidence.jsx';
import { normalizeOzonProfitOrder } from './profitDisplayRules.jsx';
import { getProfitPurchaseOrderOverride } from './profitPurchaseOverrideRules.jsx';
import { createProfitLedgerRow, mergeProfitLedgerRows, resolveProfitPurchaseCost } from '../../services/profitLedgerService.js';

const POSTING = '06477778-0475-1';

function order(shopId, clientId) {
  return {
    id: POSTING,
    orderKey: POSTING,
    recordKey: `${clientId}:${POSTING}`,
    posting: POSTING,
    postingNumber: POSTING,
    salesOrder: POSTING,
    shopId,
    shopClientId: clientId,
    product: '真实商品',
  };
}

describe('profit purchase override isolation', () => {
  it.each(['1', '2', '3'])('keeps shop %s purchase costs after ledger keys change from client id to internal shop id', (id) => {
    const original = { ...order(`shop-${id}`, `client-${id}`), recordKey: `shop-${id}:${POSTING}` };
    const overrides = Object.fromEntries(['1', '2', '3'].map((other) => [`client-${other}:${POSTING}`, {
      shopId: `shop-${other}`, orderKey: `client-${other}:${POSTING}`, sourceCostCny: Number(other) + 2.9,
    }]));
    expect(resolveProfitPurchaseCost(original, { purchaseOverrides: overrides }).value).toBe(Number(id) + 2.9);
    const collisionKey = `shop-${id}:client-${id}:${POSTING}`;
    expect(resolveProfitPurchaseCost(original, { purchaseOverrides: { [collisionKey]: overrides[`client-${id}:${POSTING}`] } }).value)
      .toBe(Number(id) + 2.9);
    expect(resolveProfitPurchaseCost(original, { purchaseOverrides: {
      [`client-${id}:${POSTING}`]: { shopId: 'removed-shop', sourceCostCny: 999 },
    } }).value).toBe(0);
  });

  it('does not turn an unhydrated purchase-cache miss into confirmed zero and overwrite saved cost', () => {
    const original = { ...order('shop-1', 'client-1'), status: 'delivered', amountValue: 16, currencyCode: 'CNY' };
    const cached = createProfitLedgerRow(original, { amounts: { sourcePurchaseCostCny: 2.9 } });
    const fresh = normalizeOzonProfitOrder(original, { purchaseLocalOverrides: {} }).profitLedger;
    expect(fresh.amounts.sourcePurchaseCostCny).toMatchObject({ value: 0, source: 'missing-purchase-cost-zero' });
    expect(mergeProfitLedgerRows([cached], [fresh])[0].amounts.sourcePurchaseCostCny.value).toBe(2.9);
  });

  it('restores business evidence without allowing canonical override identity to replace the real order', () => {
    const original = order('shop-a', 'client-a');
    const override = getProfitPurchaseOrderOverride(original, {
      [`client-a:${POSTING}`]: {
        id: 'override-row-id',
        shopId: 'shop-a',
        orderKey: `client-a:${POSTING}`,
        postingNumber: `client-a:${POSTING}`,
        product: '错误覆盖商品',
        sourceCostCny: 18.6,
        packageOrderId: 'bus-a',
        packageWeight: '0.156 kg',
      },
    });
    const merged = { ...original, ...override };

    expect(merged).toMatchObject({
      id: POSTING,
      orderKey: POSTING,
      postingNumber: POSTING,
      shopId: 'shop-a',
      product: '真实商品',
      sourceCostCny: 18.6,
      manualPurchasePrice: 18.6,
      packageOrderId: 'bus-a',
      packageWeight: '0.156 kg',
    });
  });

  it('does not read or mutate another internal shop that shares the posting number', () => {
    const shopAOverride = {
      shopId: 'shop-a',
      orderKey: `client-a:${POSTING}`,
      postingNumber: `client-a:${POSTING}`,
      manualProfitLogisticsFeeCny: 3.2,
    };
    const overrides = { [`client-a:${POSTING}`]: shopAOverride };

    expect(getProfitPurchaseOrderOverride(order('shop-b', 'client-b'), overrides)).toEqual({});
    const result = upsertProfitManualOverrideAmount(
      order('shop-b', 'client-b'),
      'logisticsFeeCny',
      5.5,
      {
        overrides,
        persist: false,
        shop: { id: 'shop-b', clientId: 'client-b' },
      }
    );

    expect(result.key).toBe(`client-b:${POSTING}`);
    expect(result.allOverrides[`client-a:${POSTING}`]).toBe(shopAOverride);
    expect(result.allOverrides[`client-b:${POSTING}`]).toMatchObject({
      shopId: 'shop-b',
      manualProfitLogisticsFeeCny: 5.5,
    });
  });

  it('fails closed when a profit write lacks a verified internal shop id', () => {
    const result = upsertProfitManualOverrideAmount(
      { id: POSTING, posting: POSTING, shopClientId: 'client-a' },
      'logisticsFeeCny',
      5.5,
      {
        overrides: {},
        persist: false,
        shop: { id: 'shop-a', clientId: 'client-a' },
      }
    );

    expect(result).toBeNull();
  });

  it('uses only attributed cross-border ledger amounts, including an exact zero', () => {
    const original = order('shop-a', 'client-a');
    expect(getProfitActualCrossBorderBusFeeValueCny(original, {
      purchaseLocalOverrides: {
        [`client-a:${POSTING}`]: {
          shopId: 'shop-a',
          orderKey: `client-a:${POSTING}`,
          actualCrossBorderBusFeeCny: 1.5,
          actualCrossBorderBusFeeSource: 'cross-border-bus-ledger',
        },
      },
    })).toBe(1.5);
    expect(getProfitActualCrossBorderBusFeeValueCny(original, {
      purchaseLocalOverrides: {
        [`client-a:${POSTING}`]: {
          shopId: 'shop-a',
          orderKey: `client-a:${POSTING}`,
          actualCrossBorderBusFeeCny: 0,
          actualCrossBorderBusFeeSource: 'cross-border-bus-ledger-cash-converted',
        },
      },
    })).toBe(0);
    expect(getProfitActualCrossBorderBusFeeValueCny(original, {
      purchaseLocalOverrides: {
        [`client-a:${POSTING}`]: {
          shopId: 'shop-a',
          orderKey: `client-a:${POSTING}`,
          actualCrossBorderBusFeeCny: 1.2,
        },
      },
    })).toBeNull();
    expect(getProfitActualCrossBorderBusFeeValueCny(
      { ...original, status: 'cancelled', substatus: 'posting_canceled' },
      {
        financeLookupChecked: true,
        purchaseLocalOverrides: {
          [`client-a:${POSTING}`]: {
            shopId: 'shop-a',
            orderKey: `client-a:${POSTING}`,
            actualCrossBorderBusFeeCny: 1.2,
          },
        },
      }
    )).toBe(0);
  });

  it('propagates the exact charge source and evidence into a freshly normalized profit ledger row', () => {
    const original = {
      ...order('shop-a', 'client-a'),
      status: 'cancelled',
      substatus: 'posting_canceled',
      amountValue: 61,
      currencyCode: 'CNY',
      products: [{ offerId: 'mz-26050917-186129', qty: 1, price: 61, currencyCode: 'CNY' }],
    };
    const normalized = normalizeOzonProfitOrder(original, {
      purchaseLocalOverrides: {
        [`client-a:${POSTING}`]: {
          shopId: 'shop-a',
          orderKey: `client-a:${POSTING}`,
          actualCrossBorderBusFeeCny: 1.13,
          actualCrossBorderBusFeeSource: 'cross-border-bus-ledger-cash-converted',
          crossBorderChargeEvidence: {
            source: 'cross-border-bus-ledger-cash-converted',
            collectionNumber: '56185',
            statementCount: 1,
            ledgerNetCny: 1.5,
            actualFeeCny: 1.13,
          },
        },
      },
      financeLookupCheckedIndex: new Map([[POSTING, true]]),
    });

    expect(normalized.profitLedger.amounts.actualCrossBorderBusFeeCny).toMatchObject({
      value: 1.13,
      status: 'ready',
      source: 'cross-border-bus-ledger-cash-converted',
    });
    expect(normalized.profitLedger.amounts.actualCrossBorderBusFeeCny.evidence.collectionNumber).toBe('56185');
  });
});
