import { describe, expect, it } from 'vitest';
import {
  clearProfitLedgerSnapshotFromStore,
  createProfitLedgerHash,
  createProfitLedgerRow,
  createProfitLedgerSnapshot,
  PROFIT_LEDGER_CALCULATION_VERSION,
  getProfitLedgerSnapshotCacheKey,
  getProfitLedgerSnapshotCacheKeyCandidates,
  isEffectiveProfitLedgerValue,
  mergeProfitLedgerRows,
  mergeProfitLedgerSnapshotIntoStore,
  mergeProfitLedgerSnapshot,
  migrateProfitLedgerRowToCurrentVersion,
  readProfitLedgerSnapshotFromStore,
  selectBestProfitLedgerRow,
} from './profitLedgerService.js';

describe('profitLedgerService', () => {
  it('keeps ledger field hash stable when only fetch/update timestamps change', () => {
    const row = createProfitLedgerRow(
      { id: 'stable-hash-order', amountValue: 59, currencyCode: 'CNY', purchasePriceValue: 0 },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        updatedAt: '2026-06-24T10:00:00.000Z',
        amounts: {
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 7.64,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 1.23,
        },
      }
    );
    const moved = JSON.parse(JSON.stringify(row));
    moved.updatedAt = '2026-07-06T09:00:00.000Z';
    moved.fetchedAt = '2026-07-06T09:00:00.000Z';
    Object.values(moved.amounts).forEach((entry) => {
      entry.updatedAt = '2026-07-06T09:00:00.000Z';
    });
    Object.values(moved.results).forEach((entry) => {
      entry.updatedAt = '2026-07-06T09:00:00.000Z';
    });

    expect(createProfitLedgerHash(moved)).toBe(row.fieldHash);
  });

  it('stores estimated and actual RUB/CNY rates separately on the ledger', () => {
    const ledger = createProfitLedgerRow(
      {
        id: 'rate-split-order',
        paymentDate: '2026-06-22T22:38:14Z',
        amountValue: 27,
        currencyCode: 'CNY',
        purchasePriceValue: 0,
        products: [{ offerId: 'mz-rate', qty: 1 }],
      },
      {
        estimatedExchangeRate: { mode: 'daily', date: '2026-06-20', rubToCnyRate: 0.0925, source: 'estimated' },
        actualExchangeRate: { mode: 'daily', date: '2026-06-28', rubToCnyRate: 0.1, source: 'actual' },
        allowZeroPurchaseCost: true,
        hasActualFinance: true,
        amounts: {
          sourcePurchaseCostCny: 0,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 0,
          logisticsFeeCny: 0,
        },
      }
    );

    expect(ledger.exchangeRate.rubToCnyRate).toBe(0.0925);
    expect(ledger.exchangeRates.estimated.rubToCnyRate).toBe(0.0925);
    expect(ledger.exchangeRates.actual.rubToCnyRate).toBe(0.1);
    expect(ledger.orderSnapshot.exchangeRates.estimated.rubToCnyRate).toBe(0.0925);
    expect(ledger.orderSnapshot.exchangeRates.actual.rubToCnyRate).toBe(0.1);
  });

  it('uses order-level purchase cost when product rows do not carry source cost', () => {
    const ledger = createProfitLedgerRow(
      {
        id: '0123640791-0163-1',
        amountValue: 16,
        currencyCode: 'CNY',
        purchasePriceValue: 2.9,
        freightCostValue: 5.56,
        products: [{ offerId: 'mz-26050813-905658', qty: 1, purchasePriceValue: null }],
      },
      {
        hasActualFinance: true,
        amounts: {
          actualOzonFeeCny: 0.32,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0.32,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 1.23,
          logisticsFeeCny: 5.56,
          estimatedCommissionFeeCny: 1.92,
          estimatedAcquiringFeeCny: 0.32,
          estimatedDeliveryServiceFeeCny: 1.42,
        },
      }
    );

    expect(ledger.amounts.sourcePurchaseCostCny.value).toBe(2.9);
    expect(ledger.amounts.sourcePurchaseCostCny.source).toBe('order-total');
    expect(ledger.results.actualProfitCny.value).toBeCloseTo(11.55, 5);
    expect(ledger.results.bestProfitCny.value).toBeCloseTo(11.55, 5);
  });

  it('uses product source records as purchase cost when order rows have no cost', () => {
    const ledger = createProfitLedgerRow(
      {
        id: 'source-record-order',
        amountValue: 27,
        currencyCode: 'CNY',
        products: [{ offerId: 'mz-26050910-195318', qty: 2 }],
      },
      {
        sourceRecords: [
          {
            offerId: 'mz-26050910-195318',
            purchasePriceValue: 6.96,
            sourcePriceValue: 6.96,
          },
        ],
        hasActualFinance: true,
        amounts: {
          actualOzonFeeCny: 0.54,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0.54,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 1.23,
          logisticsFeeCny: 6.76,
        },
      }
    );

    expect(ledger.amounts.sourcePurchaseCostCny.value).toBeCloseTo(13.92, 5);
    expect(ledger.amounts.sourcePurchaseCostCny.source).toBe('order-products');
    expect(ledger.results.actualProfitCny.value).toBeCloseTo(11.31, 5);
  });

  it('ignores generic source price from order products when resolving purchase cost', () => {
    const ledger = createProfitLedgerRow(
      {
        id: '73445798-0218-1',
        amountValue: 27,
        currencyCode: 'CNY',
        products: [
          {
            offerId: 'mz-26050910-195318',
            qty: 1,
            purchasePriceValue: 0,
            purchasePrice: '未返回',
            sourcePriceValue: 30,
            sourcePrice: '￥30.00',
            afterSalesAmountSource: 'ozon-return-cny',
          },
        ],
      },
      {
        purchaseOverrides: {
          '73445798-0218-1': {
            purchasePriceValue: 13.8,
          },
        },
        hasActualFinance: true,
        amounts: {
          actualOzonFeeCny: 0,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 1.23,
          logisticsFeeCny: 6.76,
        },
      }
    );

    expect(ledger.amounts.sourcePurchaseCostCny.value).toBeCloseTo(13.8, 5);
    expect(ledger.amounts.sourcePurchaseCostCny.source).toBe('purchase-override');
    expect(ledger.amounts.sourcePurchaseCostCny.value).not.toBe(30);
  });

  it('uses purchase override cost before confirmed zero placeholder in profit rows', () => {
    const ledger = createProfitLedgerRow(
      {
        id: '06477778-0475-1',
        amountValue: 27,
        currencyCode: 'CNY',
        products: [
          {
            offerId: 'mz-26050910-195318',
            qty: 1,
            purchasePriceValue: 0,
            purchasePrice: '未返回',
          },
        ],
      },
      {
        allowZeroPurchaseCost: true,
        purchaseOverrides: {
          '06477778-0475-1': {
            sourceCostCny: 13.8,
            source_cost_cny: 13.8,
            cost: 13.8,
          },
        },
        amounts: {
          sourcePurchaseCostCny: 0,
          estimatedCommissionFeeCny: 3.24,
          estimatedAcquiringFeeCny: 0.54,
          estimatedDeliveryServiceFeeCny: 1.31,
          estimatedCrossBorderBusFeeCny: 1.23,
          logisticsFeeCny: 8.8,
        },
      }
    );

    expect(ledger.amounts.sourcePurchaseCostCny.value).toBeCloseTo(13.8, 5);
    expect(ledger.amounts.sourcePurchaseCostCny.source).toBe('purchase-override');
    expect(ledger.results.estimatedProfitCny.value).toBeCloseTo(-1.92, 5);
  });

  it('does not turn generic source price into purchase cost without purchase evidence', () => {
    const ledger = createProfitLedgerRow(
      {
        id: 'generic-source-price-only',
        amountValue: 27,
        currencyCode: 'CNY',
        products: [
          {
            offerId: 'offer-1',
            qty: 1,
            sourcePriceValue: 30,
            sourcePrice: '￥30.00',
          },
        ],
      },
      {
        hasActualFinance: true,
        amounts: {
          actualOzonFeeCny: 0,
          crossBorderBusFeeCny: 1.23,
          logisticsFeeCny: 6.76,
        },
      }
    );

    expect(ledger.amounts.sourcePurchaseCostCny.status).toBe('ready');
    expect(ledger.amounts.sourcePurchaseCostCny.value).toBe(0);
    expect(ledger.amounts.sourcePurchaseCostCny.source).toBe('missing-purchase-cost-zero');
  });

  it('treats missing purchase cost as zero instead of blocking profit calculation', () => {
    const ledger = createProfitLedgerRow(
      {
        id: 'missing-cost',
        amountValue: 27,
        currencyCode: 'CNY',
        products: [{ offerId: 'offer-1', qty: 1, purchasePrice: '待确认' }],
      },
      {
        hasActualFinance: true,
        actualFinanceStatus: 'confirmed',
        amounts: {
          actualOzonFeeCny: 0.54,
          crossBorderBusFeeCny: 1.23,
          logisticsFeeCny: 6.76,
        },
      }
    );

    expect(ledger.amounts.sourcePurchaseCostCny.status).toBe('ready');
    expect(ledger.amounts.sourcePurchaseCostCny.value).toBe(0);
    expect(ledger.amounts.sourcePurchaseCostCny.source).toBe('missing-purchase-cost-zero');
    expect(ledger.results.actualProfitCny.status).toBe('ready');
    expect(ledger.results.actualProfitCny.value).toBeCloseTo(25.77, 5);
    expect(ledger.results.bestProfitCny.value).toBeCloseTo(25.77, 5);
  });

  it('accepts zero purchase cost when the order is confirmed not purchased', () => {
    const ledger = createProfitLedgerRow(
      {
        id: 'pre-shipment-canceled',
        amountValue: 0,
        currencyCode: 'CNY',
        products: [{ offerId: 'offer-1', qty: 1 }],
      },
      {
        hasActualFinance: true,
        allowZeroPurchaseCost: true,
        amounts: {
          sourcePurchaseCostCny: 0,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 6.5,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 0,
          logisticsFeeCny: 0,
        },
      }
    );

    expect(ledger.amounts.sourcePurchaseCostCny.status).toBe('ready');
    expect(ledger.amounts.sourcePurchaseCostCny.value).toBe(0);
    expect(ledger.results.actualProfitCny.value).toBe(-6.5);
  });

  it('keeps actual profit pending for in-progress orders even when temporary fees are present', () => {
    const ledger = createProfitLedgerRow(
      {
        id: 'shipping-risk',
        amountValue: 16,
        currencyCode: 'CNY',
        purchasePriceValue: 2.9,
      },
      {
        hasActualFinance: true,
        actualFinanceStatus: 'provisional',
        forceActualProfitPending: true,
        amounts: {
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0.32,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 1.23,
          logisticsFeeCny: 5.56,
        },
      }
    );

    expect(ledger.amounts.actualAcquiringFeeCny.status).toBe('provisional');
    expect(ledger.amounts.actualAcquiringFeeCny.value).toBe(0.32);
    expect(ledger.results.actualProfitCny.status).toBe('pending');
    expect(ledger.results.actualProfitCny.value).toBeNull();
  });

  it('uses actual order income for actual profit without changing estimated sales income', () => {
    const ledger = createProfitLedgerRow(
      {
        id: 'refunded-with-zero-income',
        amountValue: 57,
        currencyCode: 'CNY',
        products: [{ offerId: 'offer-1', qty: 1 }],
      },
      {
        hasActualFinance: true,
        allowZeroPurchaseCost: true,
        amounts: {
          salesAmountCny: 57,
          actualSalesAmountCny: 0,
          sourcePurchaseCostCny: 0,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 0,
          logisticsFeeCny: 0,
          estimatedCommissionFeeCny: 6.84,
          estimatedAcquiringFeeCny: 1.14,
          estimatedDeliveryServiceFeeCny: 1.42,
        },
      }
    );

    expect(ledger.amounts.salesAmountCny.value).toBe(57);
    expect(ledger.amounts.actualSalesAmountCny.value).toBe(0);
    expect(ledger.results.actualProfitCny.value).toBe(0);
    expect(ledger.results.bestProfitCny.value).toBe(0);
  });

  it('keeps order status fields in profit ledger snapshots for later actual income decisions', () => {
    const ledger = createProfitLedgerRow(
      {
        id: 'closed-status-order',
        amountValue: 57,
        currencyCode: 'CNY',
        status: '关闭订单',
        statusLabel: '关闭订单',
        ozonStatus: 'cancelled',
        rawStatus: 'cancelled',
        rawSubstatus: 'posting_canceled',
        products: [{ offerId: 'offer-1', qty: 1 }],
      },
      {
        hasActualFinance: true,
        allowZeroPurchaseCost: true,
        amounts: {
          salesAmountCny: 57,
          actualSalesAmountCny: 0,
          sourcePurchaseCostCny: 0,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 7.7,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 0,
        },
      }
    );

    expect(ledger.orderSnapshot.status).toBe('关闭订单');
    expect(ledger.orderSnapshot.ozonStatus).toBe('cancelled');
    expect(ledger.orderSnapshot.rawStatus).toBe('cancelled');
    expect(ledger.orderSnapshot.rawSubstatus).toBe('posting_canceled');
    expect(ledger.amounts.actualCrossBorderBusFeeCny).toMatchObject({
      value: 0,
      status: 'ready',
      source: 'cross-border-final-no-exact-charge',
    });
    expect(ledger.results.actualProfitCny.value).toBeCloseTo(-7.7, 5);
    expect(ledger.results.actualProfitCny.status).toBe('ready');
  });

  it('calculates closed refunded orders with penalties as a real loss', () => {
    const ledger = createProfitLedgerRow(
      {
        id: 'closed-refunded-penalty',
        amountValue: 75,
        currencyCode: 'CNY',
        products: [{ offerId: 'offer-1', qty: 1 }],
      },
      {
        hasActualFinance: true,
        allowZeroPurchaseCost: true,
        amounts: {
          salesAmountCny: 75,
          actualSalesAmountCny: 0,
          sourcePurchaseCostCny: 0,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 20.33,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 0,
          logisticsFeeCny: 0,
        },
      }
    );

    expect(ledger.results.actualProfitCny.value).toBeCloseTo(-20.33, 5);
    expect(ledger.results.bestProfitCny.value).toBeCloseTo(-20.33, 5);
    expect(ledger.status).toBe('loss');
  });

  it('stores actual finance detail amounts in the ledger row', () => {
    const ledger = createProfitLedgerRow(
      {
        id: 'actual-detail-order',
        amountValue: 38,
        currencyCode: 'CNY',
        purchasePriceValue: 10,
      },
      {
        hasActualFinance: true,
        amounts: {
          actualOzonFeeCny: 4.5,
          actualCommissionFeeCny: 1.7,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0.4,
          actualDeliveryServiceFeeCny: 1.2,
          actualLogisticsFeeCny: 1.2,
          platformNetCny: 33.5,
          crossBorderBusFeeCny: 1.23,
          logisticsFeeCny: 5.56,
        },
      }
    );

    expect(ledger.amounts.actualCommissionFeeCny.value).toBe(1.7);
    expect(ledger.amounts.actualPenaltyFeeCny.value).toBe(0);
    expect(ledger.amounts.actualAcquiringFeeCny.value).toBe(0.4);
    expect(ledger.amounts.actualDeliveryServiceFeeCny.value).toBe(1.2);
    expect(ledger.amounts.actualLogisticsFeeCny.value).toBe(1.2);
    expect(ledger.amounts.platformNetCny.value).toBe(33.5);
  });

  it('stores a compact order snapshot so cached profit rows can render without a fresh order list', () => {
    const ledger = createProfitLedgerRow(
      {
        id: '0123640791-0163-1',
        salesOrder: '0123640791-0163',
        shop: 'Ozon 1店',
        product: 'silent block',
        amountValue: 16,
        currencyCode: 'CNY',
        paymentTime: '2026/06/24 13:02:00',
        afterSalesSearchText: '85302026 0153819294-0312-1',
        afterSalesSearchValues: ['85302026', '0153819294-0312-1'],
        products: [
          {
            name: 'silent block',
            offerId: 'mz-26050813-905658',
            skuId: '4228739826',
            qty: 1,
            image: 'https://cdn.example.test/sku.jpg',
          },
        ],
      },
      {
        hasActualFinance: true,
        amounts: {
          actualOzonFeeCny: 0.32,
          crossBorderBusFeeCny: 1.23,
          logisticsFeeCny: 5.56,
        },
      }
    );

    expect(ledger.orderSnapshot.id).toBe('0123640791-0163-1');
    expect(ledger.orderSnapshot.shop).toBe('Ozon 1店');
    expect(ledger.orderSnapshot.product).toBe('silent block');
    expect(ledger.orderSnapshot.paymentTime).toBe('2026/06/24 13:02:00');
    expect(ledger.orderSnapshot.afterSalesSearchText).toBe('85302026 0153819294-0312-1');
    expect(ledger.orderSnapshot.afterSalesSearchValues).toEqual(['85302026', '0153819294-0312-1']);
    expect(ledger.orderSnapshot.products[0]).toMatchObject({
      offerId: 'mz-26050813-905658',
      skuId: '4228739826',
      image: 'https://cdn.example.test/sku.jpg',
    });
  });

  it('keeps cached ready values when a fresh row only returns pending placeholders', () => {
    const cached = createProfitLedgerRow(
      {
        id: '06477778-0475-1',
        amountValue: 27,
        currencyCode: 'CNY',
        purchasePriceValue: 13.8,
        freightCostValue: 6.76,
      },
      {
        hasActualFinance: true,
        amounts: {
          actualOzonFeeCny: 6.43,
          actualCommissionFeeCny: 3.24,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0.54,
          actualDeliveryServiceFeeCny: 1.42,
          actualLogisticsFeeCny: 1.23,
          crossBorderBusFeeCny: 1.23,
          logisticsFeeCny: 6.76,
        },
      }
    );
    const fresh = createProfitLedgerRow(
      {
        id: '06477778-0475-1',
        amountValue: 27,
        currencyCode: 'CNY',
        products: [{ offerId: 'offer-1', qty: 1, purchasePrice: '待确认' }],
      },
      {
        hasActualFinance: true,
        amounts: {
          actualOzonFeeCny: null,
          crossBorderBusFeeCny: 1.23,
          logisticsFeeCny: null,
        },
      }
    );

    const [merged] = mergeProfitLedgerRows([cached], [fresh]);

    expect(merged.amounts.sourcePurchaseCostCny.value).toBe(13.8);
    expect(merged.amounts.actualOzonFeeCny.value).toBe(6.43);
    expect(merged.amounts.logisticsFeeCny.value).toBe(6.76);
    expect(merged.results.actualProfitCny.value).toBeCloseTo(5.54, 5);
    expect(merged.status).toBe('profit');
  });

  it('keeps cached order snapshot fields when a fresh row misses display metadata', () => {
    const cached = createProfitLedgerRow({
      id: 'cached-order-1',
      shop: 'Ozon 1店',
      product: 'cached product',
      amountValue: 16,
      currencyCode: 'CNY',
      paymentTime: '2026/06/24 13:02:00',
      products: [{ name: 'cached product', offerId: 'offer-1', image: 'https://cdn.example.test/a.jpg' }],
    });
    const fresh = createProfitLedgerRow({
      id: 'cached-order-1',
      amountValue: 16,
      currencyCode: 'CNY',
      product: '待确认',
      products: [],
    });

    const [merged] = mergeProfitLedgerRows([cached], [fresh]);

    expect(merged.orderSnapshot.shop).toBe('Ozon 1店');
    expect(merged.orderSnapshot.product).toBe('cached product');
    expect(merged.orderSnapshot.paymentTime).toBe('2026/06/24 13:02:00');
    expect(merged.orderSnapshot.products[0].image).toBe('https://cdn.example.test/a.jpg');
  });

  it('keeps cached product images when a fresh row returns the same product without images', () => {
    const cached = createProfitLedgerRow({
      id: 'image-kept-order',
      amountValue: 38,
      currencyCode: 'CNY',
      products: [
        {
          name: 'image product',
          offerId: 'offer-image-1',
          skuId: 'sku-image-1',
          image: 'https://cdn.example.test/kept.jpg',
          skuImage: 'https://cdn.example.test/kept-sku.jpg',
          primaryImage: 'https://cdn.example.test/kept-primary.jpg',
          images: ['https://cdn.example.test/kept-list.jpg'],
        },
      ],
    });
    const fresh = createProfitLedgerRow({
      id: 'image-kept-order',
      amountValue: 38,
      currencyCode: 'CNY',
      products: [
        {
          name: 'image product',
          offerId: 'offer-image-1',
          skuId: 'sku-image-1',
          image: '',
          skuImage: '',
          primaryImage: '',
          images: [],
        },
      ],
    });

    const [merged] = mergeProfitLedgerRows([cached], [fresh]);
    const product = merged.orderSnapshot.products[0];

    expect(product.image).toBe('https://cdn.example.test/kept.jpg');
    expect(product.skuImage).toBe('https://cdn.example.test/kept-sku.jpg');
    expect(product.primaryImage).toBe('https://cdn.example.test/kept-primary.jpg');
    expect(product.images).toContain('https://cdn.example.test/kept-list.jpg');
  });

  it('lets fresh confirmed fields override cached stale fields', () => {
    const cached = createProfitLedgerRow(
      { id: 'order-1', amountValue: 27, currencyCode: 'CNY', purchasePriceValue: 13.8, freightCostValue: 6.76 },
      {
        hasActualFinance: true,
        amounts: {
          actualOzonFeeCny: 7,
          actualCommissionFeeCny: 4,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 1,
          actualDeliveryServiceFeeCny: 1,
          actualLogisticsFeeCny: 1,
          crossBorderBusFeeCny: 1.23,
          logisticsFeeCny: 6.76,
        },
      }
    );
    const fresh = createProfitLedgerRow(
      { id: 'order-1', amountValue: 27, currencyCode: 'CNY', purchasePriceValue: 13.8, freightCostValue: 6.76 },
      {
        hasActualFinance: true,
        amounts: {
          actualOzonFeeCny: 6.43,
          actualCommissionFeeCny: 3.24,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0.54,
          actualDeliveryServiceFeeCny: 1.42,
          actualLogisticsFeeCny: 1.23,
          crossBorderBusFeeCny: 1.23,
          logisticsFeeCny: 6.76,
        },
      }
    );

    const [merged] = mergeProfitLedgerRows([cached], [fresh]);

    expect(merged.amounts.actualOzonFeeCny.value).toBe(6.43);
    expect(merged.amounts.actualAcquiringFeeCny.value).toBe(0.54);
    expect(merged.results.actualProfitCny.value).toBeCloseTo(5.54, 5);
  });

  it('keeps provisional zero actual fees temporary until real finance values arrive', () => {
    const provisional = createProfitLedgerRow(
      { id: 'in-progress-order', amountValue: 27, currencyCode: 'CNY', purchasePriceValue: 13.8 },
      {
        actualFinanceStatus: 'provisional',
        hasActualFinance: true,
        amounts: {
          actualOzonFeeCny: 0,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 1.23,
        },
      }
    );
    const confirmed = createProfitLedgerRow(
      { id: 'in-progress-order', amountValue: 27, currencyCode: 'CNY', purchasePriceValue: 13.8 },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        amounts: {
          actualOzonFeeCny: 0.54,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0.54,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 1.23,
        },
      }
    );

    expect(provisional.amounts.actualAcquiringFeeCny.status).toBe('provisional');
    expect(provisional.results.actualProfitCny.value).toBeNull();

    const [merged] = mergeProfitLedgerRows([provisional], [confirmed]);

    expect(merged.amounts.actualAcquiringFeeCny.status).toBe('ready');
    expect(merged.amounts.actualAcquiringFeeCny.value).toBe(0.54);
    expect(merged.results.actualProfitCny.value).toBeCloseTo(11.43, 5);
  });

  it('does not let provisional zero actual fees overwrite cached confirmed values', () => {
    const confirmed = createProfitLedgerRow(
      { id: 'signed-order', amountValue: 27, currencyCode: 'CNY', purchasePriceValue: 13.8 },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        amounts: {
          actualOzonFeeCny: 0.54,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0.54,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 1.23,
        },
      }
    );
    const provisional = createProfitLedgerRow(
      { id: 'signed-order', amountValue: 27, currencyCode: 'CNY', purchasePriceValue: 13.8 },
      {
        actualFinanceStatus: 'provisional',
        hasActualFinance: true,
        amounts: {
          actualOzonFeeCny: 0,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 1.23,
        },
      }
    );

    const [merged] = mergeProfitLedgerRows([confirmed], [provisional]);

    expect(merged.amounts.actualAcquiringFeeCny.status).toBe('ready');
    expect(merged.amounts.actualAcquiringFeeCny.value).toBe(0.54);
  });

  it('keeps signed completed orders pending when real finance fees have not returned', () => {
    const row = createProfitLedgerRow(
      { id: 'delivered-order', amountValue: 27, currencyCode: 'CNY', purchasePriceValue: 13.8 },
      {
        actualFinanceStatus: 'pending',
        hasActualFinance: false,
        amounts: {
          actualCommissionFeeCny: null,
          actualPenaltyFeeCny: null,
          actualAcquiringFeeCny: null,
          actualDeliveryServiceFeeCny: null,
          actualLogisticsFeeCny: null,
          crossBorderBusFeeCny: 1.23,
        },
      }
    );

    expect(row.amounts.actualAcquiringFeeCny.status).toBe('pending');
    expect(row.amounts.actualAcquiringFeeCny.value).toBeNull();
    expect(row.results.actualProfitCny.status).toBe('pending');
    expect(row.results.actualProfitCny.value).toBeNull();
  });

  it('does not treat dirty pending ledger values from old cache as effective amounts', () => {
    expect(isEffectiveProfitLedgerValue({ status: 'pending', value: 0, source: 'ozon-finance-detail' })).toBe(false);
    expect(isEffectiveProfitLedgerValue({ status: 'pending', value: 0.53, source: 'ozon-finance-detail' })).toBe(false);
    expect(isEffectiveProfitLedgerValue({ status: 'provisional', value: 0, source: 'ozon-finance-detail' })).toBe(true);
    expect(isEffectiveProfitLedgerValue({ status: 'ready', value: 0, source: 'ozon-finance-detail' })).toBe(true);
  });

  it('allows confirmed zero actual fees for closed or refunded orders when finance lookup proves no fee rows', () => {
    const row = createProfitLedgerRow(
      { id: 'closed-refunded-order', amountValue: 0, currencyCode: 'CNY', purchasePriceValue: 13.8 },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        amounts: {
          actualOzonFeeCny: 0,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 1.23,
        },
      }
    );

    expect(row.amounts.actualCommissionFeeCny.status).toBe('ready');
    expect(row.amounts.actualCommissionFeeCny.value).toBe(0);
    expect(row.results.actualProfitCny.value).toBeCloseTo(-15.03, 5);
  });

  it('defaults missing confirmed actual fee details to ready zero amounts', () => {
    const row = createProfitLedgerRow(
      { id: 'closed-no-fee-rows', amountValue: 16, currencyCode: 'CNY', purchasePriceValue: 2.9 },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        amounts: {
          crossBorderBusFeeCny: 1.23,
        },
      }
    );

    expect(row.amounts.actualCommissionFeeCny.status).toBe('ready');
    expect(row.amounts.actualCommissionFeeCny.value).toBe(0);
    expect(row.amounts.actualPenaltyFeeCny.status).toBe('ready');
    expect(row.amounts.actualPenaltyFeeCny.value).toBe(0);
    expect(row.amounts.actualAcquiringFeeCny.status).toBe('ready');
    expect(row.amounts.actualAcquiringFeeCny.value).toBe(0);
    expect(row.results.actualProfitCny.value).toBeCloseTo(11.87, 5);
  });

  it('keeps penalty pending when a defect fine operation has no direct Ozon fee amount', () => {
    const row = createProfitLedgerRow(
      { id: 'defect-fine-missing-direct-fee', amountValue: 59, currencyCode: 'CNY', purchasePriceValue: 0 },
      {
        actualFinanceStatus: 'confirmed',
        actualPenaltyFeeRequiresDirectAmount: true,
        hasActualFinance: true,
        allowZeroPurchaseCost: true,
        amounts: {
          sourcePurchaseCostCny: 0,
          actualCommissionFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 0,
        },
      }
    );

    expect(row.amounts.actualPenaltyFeeCny.status).toBe('pending');
    expect(row.amounts.actualPenaltyFeeCny.value).toBeNull();
    expect(row.results.actualProfitCny.status).toBe('pending');
    expect(row.results.actualProfitCny.value).toBeNull();
  });

  it('keeps Ozon penalty detail evidence on the penalty fee ledger entry', () => {
    const row = createProfitLedgerRow(
      { id: 'penalty-ready-row', amountValue: 59, currencyCode: 'CNY', purchasePriceValue: 0 },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        allowZeroPurchaseCost: true,
        penaltyDetails: [
          {
            dedupeKey: 'operation:penalty-1',
            status: 'ready',
            operationId: 'penalty-1',
            postingNumber: 'penalty-ready-row',
            operationType: 'DefectFineCancellation',
            operationName: 'seller fault cancellation',
            amountCny: 7.97,
            currencyCode: 'CNY',
            amountPath: 'error_fee',
          },
        ],
        penaltySummary: { totalCny: 7.97, status: 'ready' },
        amounts: {
          sourcePurchaseCostCny: 0,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 7.97,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 0,
        },
      }
    );

    expect(row.amounts.actualPenaltyFeeCny.value).toBe(7.97);
    expect(row.amounts.actualPenaltyFeeCny.evidence.records).toHaveLength(1);
    expect(row.penaltyDetails[0].dedupeKey).toBe('operation:penalty-1');
    expect(row.results.actualProfitCny.value).toBeCloseTo(51.03, 5);
  });

  it('derives the actual penalty amount from exact child penalty details', () => {
    const row = createProfitLedgerRow(
      { id: '0122157650-0182-1', amountValue: 47, currencyCode: 'CNY', purchasePriceValue: 0 },
      {
        actualFinanceStatus: 'confirmed',
        actualPenaltyFeeRequiresDirectAmount: true,
        hasActualFinance: true,
        allowZeroPurchaseCost: true,
        penaltyDetails: [
          {
            dedupeKey: 'operation:0122157650-0182-1',
            status: 'ready',
            operationId: '0122157650-0182-1',
            postingNumber: '0122157650-0182-1',
            amountCny: 6.35,
            currencyCode: 'CNY',
          },
          {
            dedupeKey: 'operation:0122157650-0182-3',
            status: 'ready',
            operationId: '0122157650-0182-3',
            postingNumber: '0122157650-0182-3',
            amountCny: 6.35,
            currencyCode: 'CNY',
          },
        ],
        amounts: {
          sourcePurchaseCostCny: 0,
          actualCommissionFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 0,
        },
      }
    );

    expect(row.penaltyDetails).toHaveLength(1);
    expect(row.penaltyDetails[0].postingNumber).toBe('0122157650-0182-1');
    expect(row.amounts.actualPenaltyFeeCny.value).toBeCloseTo(6.35, 5);
    expect(row.amounts.actualOzonFeeCny.value).toBeCloseTo(6.35, 5);
    expect(row.results.actualProfitCny.value).toBeCloseTo(40.65, 5);
  });

  it('repairs stale zero penalty amounts from row-scoped penalty details during merge', () => {
    const staleZero = createProfitLedgerRow(
      { id: '0122157650-0182-1', amountValue: 47, currencyCode: 'CNY', purchasePriceValue: 0 },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        allowZeroPurchaseCost: true,
        amounts: {
          sourcePurchaseCostCny: 0,
          actualOzonFeeCny: 0,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 0,
        },
      }
    );
    const staleWithMixedPenaltyDetails = {
      ...staleZero,
      ledgerKey: '4616153:0122157650-0182-1',
      orderKey: '4616153:0122157650-0182-1',
      penaltyDetails: [
        {
          dedupeKey: 'operation:0122157650-0182-1',
          status: 'ready',
          operationId: '0122157650-0182-1',
          postingNumber: '0122157650-0182-1',
          amountCny: 6.35,
          currencyCode: 'CNY',
        },
        {
          dedupeKey: 'operation:0122157650-0182-3',
          status: 'ready',
          operationId: '0122157650-0182-3',
          postingNumber: '0122157650-0182-3',
          amountCny: 6.35,
          currencyCode: 'CNY',
        },
      ],
    };

    const [merged] = mergeProfitLedgerRows([], [staleWithMixedPenaltyDetails]);

    expect(merged.penaltyDetails).toHaveLength(1);
    expect(merged.penaltyDetails[0].postingNumber).toBe('0122157650-0182-1');
    expect(merged.amounts.actualPenaltyFeeCny.value).toBeCloseTo(6.35, 5);
    expect(merged.amounts.actualOzonFeeCny.value).toBeCloseTo(6.35, 5);
    expect(merged.results.actualProfitCny.value).toBeCloseTo(40.65, 5);
  });

  it('lets fresh pending penalty evidence replace stale cached ready penalty fees', () => {
    const cached = createProfitLedgerRow(
      { id: 'penalty-pending-row', amountValue: 59, currencyCode: 'CNY', purchasePriceValue: 0 },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        allowZeroPurchaseCost: true,
        amounts: {
          sourcePurchaseCostCny: 0,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 8.27,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 0,
        },
      }
    );
    const fresh = createProfitLedgerRow(
      { id: 'penalty-pending-row', amountValue: 59, currencyCode: 'CNY', purchasePriceValue: 0 },
      {
        actualFinanceStatus: 'confirmed',
        actualPenaltyFeeRequiresDirectAmount: true,
        hasActualFinance: true,
        allowZeroPurchaseCost: true,
        penaltyDetails: [
          {
            dedupeKey: 'operation:penalty-pending-1',
            status: 'pending',
            operationId: 'penalty-pending-1',
            postingNumber: 'penalty-pending-row',
            operationType: 'DefectFineCancellation',
            operationName: 'seller fault cancellation',
            amountCny: null,
            reason: 'penalty event without Ozon direct fee amount',
          },
        ],
        penaltySummary: { status: 'pending', totalCny: null },
        amounts: {
          sourcePurchaseCostCny: 0,
          actualCommissionFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 0,
        },
      }
    );

    const [merged] = mergeProfitLedgerRows([cached], [fresh]);

    expect(merged.amounts.actualPenaltyFeeCny.status).toBe('pending');
    expect(merged.amounts.actualPenaltyFeeCny.value).toBeNull();
    expect(merged.amounts.actualPenaltyFeeCny.source).toBe('ozon-finance-penalty-detail');
    expect(merged.amounts.actualPenaltyFeeCny.evidence.records[0].dedupeKey).toBe('operation:penalty-pending-1');
    expect(merged.results.actualProfitCny.status).toBe('pending');
    expect(merged.results.actualProfitCny.value).toBeNull();
  });

  it('does not let a zero finance fallback overwrite a ready rating penalty fee', () => {
    const ratingPenalty = createProfitLedgerRow(
      { id: 'rating-penalty-row', amountValue: 57, currencyCode: 'CNY', purchasePriceValue: 0 },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        allowZeroPurchaseCost: true,
        penaltyDetails: [
          {
            dedupeKey: 'operation:rating-penalty-1',
            status: 'ready',
            operationId: 'rating-penalty-1',
            postingNumber: 'rating-penalty-row',
            operationType: 'OzonRatingIndexErrorFee',
            operationName: 'SELLER_CANCELLATION',
            amountCny: 7.7,
            currencyCode: 'CNY',
          },
        ],
        penaltySummary: { status: 'ready', hasPenaltyEvent: true, totalCny: 7.7 },
        amounts: {
          sourcePurchaseCostCny: 0,
          actualPenaltyFeeCny: 7.7,
          actualCommissionFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 0,
        },
      }
    );
    const zeroFinanceFallback = createProfitLedgerRow(
      { id: 'rating-penalty-row', amountValue: 57, currencyCode: 'CNY', purchasePriceValue: 0 },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        allowZeroPurchaseCost: true,
        amounts: {
          sourcePurchaseCostCny: 0,
          actualPenaltyFeeCny: 0,
          actualCommissionFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 0,
        },
      }
    );

    const [merged] = mergeProfitLedgerRows([ratingPenalty], [zeroFinanceFallback]);

    expect(merged.amounts.actualPenaltyFeeCny.value).toBe(7.7);
    expect(merged.amounts.actualPenaltyFeeCny.source).toBe('ozon-finance-penalty-detail');
    expect(merged.results.actualProfitCny.value).toBeCloseTo(49.3, 5);
  });

  it('selects the penalty-evidence ledger over a stale zero ledger for display', () => {
    const staleZeroLedger = createProfitLedgerRow(
      { id: 'rating-penalty-row', amountValue: 57, currencyCode: 'CNY', purchasePriceValue: 0 },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        allowZeroPurchaseCost: true,
        updatedAt: '2026-06-26T06:16:11.879Z',
        amounts: {
          sourcePurchaseCostCny: 0,
          actualPenaltyFeeCny: 0,
          actualCommissionFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 0,
        },
      }
    );
    const penaltyLedger = createProfitLedgerRow(
      { id: 'rating-penalty-row', amountValue: 57, currencyCode: 'CNY', purchasePriceValue: 0 },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        allowZeroPurchaseCost: true,
        updatedAt: '2026-06-27T01:09:04.307Z',
        penaltyDetails: [
          {
            dedupeKey: 'operation:rating-penalty-1',
            status: 'ready',
            operationId: 'rating-penalty-1',
            postingNumber: 'rating-penalty-row',
            operationType: 'OzonRatingIndexErrorFee',
            operationName: 'SELLER_CANCELLATION',
            amountCny: 7.7,
            currencyCode: 'CNY',
          },
        ],
        penaltySummary: { status: 'ready', hasPenaltyEvent: true, totalCny: 7.7 },
        amounts: {
          sourcePurchaseCostCny: 0,
          actualPenaltyFeeCny: 7.7,
          actualCommissionFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 0,
        },
      }
    );

    const selected = selectBestProfitLedgerRow([staleZeroLedger, penaltyLedger]);

    expect(selected).toBe(penaltyLedger);
    expect(selected.amounts.actualPenaltyFeeCny.value).toBe(7.7);
    expect(selected.results.actualProfitCny.value).toBeCloseTo(49.3, 5);
  });

  it('selects the ledger with the more complete finance operation set when evidence scores tie', () => {
    const order = { id: 'finance-completeness-row', amountValue: 24, currencyCode: 'CNY', purchasePriceValue: 0 };
    const commonContext = {
      actualFinanceStatus: 'confirmed',
      hasActualFinance: true,
      allowZeroPurchaseCost: true,
      amounts: {
        sourcePurchaseCostCny: 0,
        actualCommissionFeeCny: 0,
        actualPenaltyFeeCny: 0,
        actualAcquiringFeeCny: 0,
        actualLogisticsFeeCny: 0,
        crossBorderBusFeeCny: 0,
      },
    };
    const stalePartialLedger = createProfitLedgerRow(order, {
      ...commonContext,
      financeOperationCount: 1,
      updatedAt: '2026-07-14T01:00:00.000Z',
      amounts: { ...commonContext.amounts, actualDeliveryServiceFeeCny: 0 },
    });
    const completeLedger = createProfitLedgerRow(order, {
      ...commonContext,
      financeOperationCount: 4,
      updatedAt: '2026-07-15T01:00:00.000Z',
      amounts: { ...commonContext.amounts, actualDeliveryServiceFeeCny: 1.33 },
    });

    expect(selectBestProfitLedgerRow([stalePartialLedger, completeLedger])).toBe(completeLedger);
  });

  it('selects newer refund evidence over an older confirmed profit ledger', () => {
    const order = { id: 'new-refund-row', amountValue: 24, currencyCode: 'CNY', purchasePriceValue: 0 };
    const staleProfitLedger = createProfitLedgerRow(order, {
      actualFinanceStatus: 'confirmed',
      hasActualFinance: true,
      allowZeroPurchaseCost: true,
      financeOperationCount: 3,
      afterSalesCount: 0,
      updatedAt: '2026-07-14T01:00:00.000Z',
      amounts: {
        sourcePurchaseCostCny: 0,
        actualSalesAmountCny: 24,
        actualCommissionFeeCny: 0,
        actualPenaltyFeeCny: 0,
        actualAcquiringFeeCny: 0,
        actualDeliveryServiceFeeCny: 0,
        actualLogisticsFeeCny: 0,
        crossBorderBusFeeCny: 0,
      },
    });
    const freshRefundLedger = createProfitLedgerRow(
      { ...order, afterSalesStatus: '签收后退款' },
      {
        actualFinanceStatus: 'pending',
        hasActualFinance: false,
        allowZeroPurchaseCost: true,
        financeLookupChecked: true,
        financeOperationCount: 1,
        afterSalesCount: 1,
        updatedAt: '2026-07-15T01:00:00.000Z',
        amounts: {
          sourcePurchaseCostCny: 0,
          actualSalesAmountCny: 0,
        },
      }
    );

    const selected = selectBestProfitLedgerRow([staleProfitLedger, freshRefundLedger]);

    expect(selected).toBe(freshRefundLedger);
    expect(selected.amounts.actualSalesAmountCny.value).toBe(0);
    expect(selected.results.actualProfitCny.status).toBe('pending');
  });

  it('selects a ledger with real purchase cost over a newer missing-cost zero ledger', () => {
    const realCostLedger = createProfitLedgerRow(
      { id: 'real-cost-row', amountValue: 27, currencyCode: 'CNY', purchasePriceValue: 13.8 },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        updatedAt: '2026-06-26T06:16:11.879Z',
        amounts: {
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 1.23,
        },
      }
    );
    const missingCostLedger = createProfitLedgerRow(
      {
        id: 'real-cost-row',
        amountValue: 27,
        currencyCode: 'CNY',
        products: [{ offerId: 'offer-1', qty: 1, purchasePrice: '待确认' }],
      },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        updatedAt: '2026-06-27T01:09:04.307Z',
        amounts: {
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          crossBorderBusFeeCny: 1.23,
        },
      }
    );

    const selected = selectBestProfitLedgerRow([missingCostLedger, realCostLedger]);

    expect(selected).toBe(realCostLedger);
    expect(selected.amounts.sourcePurchaseCostCny.value).toBe(13.8);
  });

  it('stores penalty details in the local profit penalty index', () => {
    const row = createProfitLedgerRow(
      { id: 'penalty-index-row', amountValue: 59, currencyCode: 'CNY', purchasePriceValue: 0 },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        allowZeroPurchaseCost: true,
        penaltyDetails: [
          {
            dedupeKey: 'operation:penalty-1',
            status: 'ready',
            operationId: 'penalty-1',
            postingNumber: 'penalty-index-row',
            operationType: 'DefectFineCancellation',
            amountCny: 7.97,
            currencyCode: 'CNY',
          },
        ],
        amounts: {
          sourcePurchaseCostCny: 0,
          actualPenaltyFeeCny: 7.97,
        },
      }
    );
    const snapshot = createProfitLedgerSnapshot([row], { sourceKey: 'shop-1' });
    const { store } = mergeProfitLedgerSnapshotIntoStore({}, 'shop-1', snapshot);

    expect(store.profitPenaltyDetails['operation:penalty-1'].amountCny).toBe(7.97);
  });

  it('defaults missing provisional actual fee details to temporary zero amounts', () => {
    const row = createProfitLedgerRow(
      { id: 'in-progress-no-fee-rows', amountValue: 16, currencyCode: 'CNY', purchasePriceValue: 2.9 },
      {
        actualFinanceStatus: 'provisional',
        hasActualFinance: true,
        amounts: {
          crossBorderBusFeeCny: 1.23,
        },
      }
    );

    expect(row.amounts.actualCommissionFeeCny.status).toBe('provisional');
    expect(row.amounts.actualCommissionFeeCny.value).toBe(0);
    expect(row.amounts.actualAcquiringFeeCny.status).toBe('provisional');
    expect(row.amounts.actualAcquiringFeeCny.value).toBe(0);
    expect(row.results.actualProfitCny.status).toBe('pending');
    expect(row.results.actualProfitCny.value).toBeNull();
  });

  it('keeps previous snapshot rows when a refresh fails with no rows', () => {
    const cachedRow = createProfitLedgerRow({
      id: 'cached-order',
      amountValue: 16,
      currencyCode: 'CNY',
      purchasePriceValue: 2.9,
    });
    const cached = createProfitLedgerSnapshot([cachedRow], { sourceKey: 'shop-1' });
    const merged = mergeProfitLedgerSnapshot(cached, {
      rows: [],
      errors: [{ label: 'Ozon', message: 'timeout' }],
      fetchedAt: '2026-06-25T00:00:00.000Z',
    });

    expect(merged.rows).toHaveLength(1);
    expect(merged.rows[0].ledgerKey).toBe('cached-order');
    expect(merged.errors).toHaveLength(1);
  });

  it('does not put api keys into profit ledger cache keys', () => {
    const sensitiveFieldName = ['api', 'Key'].join('');
    const hiddenToken = ['cache', 'token', 'must', 'stay', 'out'].join('-');
    const key = getProfitLedgerSnapshotCacheKey([
      {
        id: 'shop-1',
        clientId: 'client-a',
        [sensitiveFieldName]: hiddenToken,
        shopAlias: 'Example Shop',
      },
    ]);

    expect(key).toContain('client-a');
    expect(key).toBe('ozon-profit-ledger-v1:ozon-shop:client:client-a');
    expect(key).not.toContain(hiddenToken);
    expect(key).not.toContain('Example Shop');
  });

  it('returns stable profit ledger key first and old shop id keys as read candidates', () => {
    const sensitiveFieldName = ['api', 'Key'].join('');
    const hiddenToken = ['cache', 'token', 'must', 'stay', 'out'].join('-');
    const candidates = getProfitLedgerSnapshotCacheKeyCandidates([
      {
        id: 'ozon-shop-1',
        clientId: 'client-a',
        [sensitiveFieldName]: hiddenToken,
        shopAlias: 'Ozon 1店',
      },
    ]);

    expect(candidates[0]).toBe('ozon-profit-ledger-v1:ozon-shop:client:client-a');
    expect(candidates).toContain('ozon-profit-ledger-v1:ozon-shop-1:client-a:Ozon 1店');
    expect(candidates.join('|')).not.toContain(hiddenToken);
  });

  it('stores profit ledger snapshots in the local data layer without touching other domains', () => {
    const row = createProfitLedgerRow({
      id: 'ledger-order',
      amountValue: 16,
      currencyCode: 'CNY',
      purchasePriceValue: 2.9,
    });
    const sourceStore = {
      snapshots: { 'ozon-sales-orders:shop-1': { rowKeys: ['ledger-order'] } },
      products: { sku1: { fields: { sku: 'sku1' } } },
    };
    const { store, snapshot, stats } = mergeProfitLedgerSnapshotIntoStore(
      sourceStore,
      'profit:shop-1',
      createProfitLedgerSnapshot([row], { sourceKey: 'shop-1' })
    );

    expect(stats.rowCount).toBe(1);
    expect(snapshot.rows[0].ledgerKey).toBe('ledger-order');
    expect(store.snapshots).toBe(sourceStore.snapshots);
    expect(store.products).toBe(sourceStore.products);
    expect(readProfitLedgerSnapshotFromStore(store, 'profit:shop-1').rows).toHaveLength(1);
  });

  it('keeps only the newest rolling snapshot for one logical profit query', () => {
    let currentStore = {};
    for (let index = 0; index < 7; index += 1) {
      const day = String(index + 1).padStart(2, '0');
      const timestamp = new Date(Date.parse('2026-06-25T00:00:00.000Z') + index * 1000).toISOString();
      currentStore = mergeProfitLedgerSnapshotIntoStore(
        currentStore,
        `profit:shop-a:range:2026-06-${day}_2026-09-${day}:filter:all`,
        createProfitLedgerSnapshot(
          [
            {
              id: `profit-order-${day}`,
              amountValue: 16,
              currencyCode: 'CNY',
            },
          ],
          { sourceKey: `profit:shop-a:range:2026-06-${day}_2026-09-${day}:filter:all`, fetchedAt: timestamp }
        )
      ).store;
    }

    expect(Object.keys(currentStore.profitLedgerSnapshots)).toEqual([
      'profit:shop-a:range:2026-06-07_2026-09-07:filter:all',
    ]);
    expect(
      readProfitLedgerSnapshotFromStore(currentStore, 'profit:shop-a:range:2026-06-07_2026-09-07:filter:all').rows[0]
        .ledgerKey
    ).toBe('profit-order-07');
    expect(readProfitLedgerSnapshotFromStore(currentStore, 'profit:shop-a:range:2026-06-01_2026-09-01:filter:all')).toBeNull();
  });

  it('keeps distinct shop and filter scopes while pruning their stale date ranges', () => {
    const createScopeSnapshot = (key, id, fetchedAt) =>
      createProfitLedgerSnapshot([{ id, amountValue: 16, currencyCode: 'CNY' }], { sourceKey: key, fetchedAt });
    const oldShopA = 'profit:shop-a:range:2026-06-01_2026-09-01:filter:all';
    const currentShopA = 'profit:shop-a:range:2026-06-02_2026-09-02:filter:all';
    const shopB = 'profit:shop-b:range:2026-06-02_2026-09-02:filter:all';
    const filteredShopA = 'profit:shop-a:range:2026-06-02_2026-09-02:filter:refunded';
    let store = mergeProfitLedgerSnapshotIntoStore({}, oldShopA, createScopeSnapshot(oldShopA, 'shop-a-old', '2026-06-01T00:00:00.000Z')).store;
    store = mergeProfitLedgerSnapshotIntoStore(store, currentShopA, createScopeSnapshot(currentShopA, 'shop-a-current', '2026-06-02T00:00:00.000Z')).store;
    store = mergeProfitLedgerSnapshotIntoStore(store, shopB, createScopeSnapshot(shopB, 'shop-b', '2026-06-03T00:00:00.000Z')).store;
    store = mergeProfitLedgerSnapshotIntoStore(store, filteredShopA, createScopeSnapshot(filteredShopA, 'shop-a-refunded', '2026-06-04T00:00:00.000Z')).store;

    expect(Object.keys(store.profitLedgerSnapshots).sort()).toEqual([currentShopA, filteredShopA, shopB].sort());
    expect(readProfitLedgerSnapshotFromStore(store, currentShopA).rows[0].ledgerKey).toBe('shop-a-current');
    expect(readProfitLedgerSnapshotFromStore(store, shopB).rows[0].ledgerKey).toBe('shop-b');
    expect(readProfitLedgerSnapshotFromStore(store, filteredShopA).rows[0].ledgerKey).toBe('shop-a-refunded');
  });

  it('bounds independent logical profit queries and marks an unchanged refresh for compaction', () => {
    let store = {};
    for (let index = 0; index < 13; index += 1) {
      const key = `profit:shop-${index}:range:2026-06-01_2026-09-01:filter:all`;
      store = mergeProfitLedgerSnapshotIntoStore(
        store,
        key,
        createProfitLedgerSnapshot([{ id: `profit-order-${index}`, amountValue: 16, currencyCode: 'CNY' }], {
          sourceKey: key,
          fetchedAt: new Date(Date.parse('2026-06-25T00:00:00.000Z') + index * 1000).toISOString(),
        })
      ).store;
    }

    expect(Object.keys(store.profitLedgerSnapshots)).toHaveLength(12);
    expect(readProfitLedgerSnapshotFromStore(store, 'profit:shop-12:range:2026-06-01_2026-09-01:filter:all').rows).toHaveLength(1);
    expect(readProfitLedgerSnapshotFromStore(store, 'profit:shop-0:range:2026-06-01_2026-09-01:filter:all')).toBeNull();

    const currentKey = 'profit:shop-12:range:2026-06-02_2026-09-02:filter:all';
    const currentSnapshot = createProfitLedgerSnapshot(
      [{ id: 'profit-order-current', amountValue: 16, currencyCode: 'CNY' }],
      { sourceKey: currentKey, fetchedAt: '2026-07-01T00:00:00.000Z' }
    );
    const withOldRange = {
      profitLedgerSnapshots: {
        [currentKey]: currentSnapshot,
        'profit:shop-12:range:2026-06-01_2026-09-01:filter:all': createProfitLedgerSnapshot(
          [{ id: 'profit-order-old', amountValue: 16, currencyCode: 'CNY' }],
          { fetchedAt: '2026-06-30T00:00:00.000Z' }
        ),
      },
    };
    const compacted = mergeProfitLedgerSnapshotIntoStore(withOldRange, currentKey, currentSnapshot);

    expect(compacted.stats.changed).toBe(false);
    expect(compacted.stats.compacted).toBe(true);
    expect(Object.keys(compacted.store.profitLedgerSnapshots)).toEqual([currentKey]);
  });

  it('keeps the just-refreshed scope even when its source timestamp is older than the retained cache', () => {
    let store = {};
    for (let index = 0; index < 12; index += 1) {
      const key = `profit:shop-${index}:range:2026-06-01_2026-09-01:filter:all`;
      store = mergeProfitLedgerSnapshotIntoStore(
        store,
        key,
        createProfitLedgerSnapshot([{ id: `profit-order-${index}`, amountValue: 16, currencyCode: 'CNY' }], {
          sourceKey: key,
          fetchedAt: new Date(Date.parse('2026-06-25T00:00:00.000Z') + index * 1000).toISOString(),
        })
      ).store;
    }

    const refreshedKey = 'profit:shop-refreshed:range:2020-06-01_2020-09-01:filter:all';
    const result = mergeProfitLedgerSnapshotIntoStore(
      store,
      refreshedKey,
      createProfitLedgerSnapshot([{ id: 'refreshed-order', amountValue: 16, currencyCode: 'CNY' }], {
        sourceKey: refreshedKey,
        fetchedAt: '2020-06-25T00:00:00.000Z',
      })
    );

    expect(Object.keys(result.store.profitLedgerSnapshots)).toHaveLength(12);
    expect(readProfitLedgerSnapshotFromStore(result.store, refreshedKey).rows[0].ledgerKey).toBe('refreshed-order');
    expect(readProfitLedgerSnapshotFromStore(result.store, 'profit:shop-0:range:2026-06-01_2026-09-01:filter:all')).toBeNull();
  });

  it('invalidates v6 rows so final-zero finance metadata is rebuilt from complete evidence', () => {
    const store = {
      profitLedgerSnapshots: {
        'profit:shop-1': {
          rows: [
            {
              ledgerKey: '0102329766-0325-1',
              orderKey: '0102329766-0325-1',
              calculationVersion: 'profit-ledger-v6-confirmed-split-logistics',
              amounts: { logisticsFeeCny: { status: 'pending', value: null, reason: '缺物流费用' } },
              results: { estimatedProfitCny: { status: 'pending', value: null } },
            },
          ],
        },
      },
    };

    expect(readProfitLedgerSnapshotFromStore(store, 'profit:shop-1').rows).toHaveLength(0);
  });

  it('keeps v12 estimated profit visible while rebuilding only actual commission evidence', () => {
    const store = {
      profitLedgerSnapshots: {
        'profit:shop-rfbs': {
          rows: [
            {
              ledgerKey: 'ozon-shop-2:0120367693-0177-1',
              orderKey: 'ozon-shop-2:0120367693-0177-1',
              calculationVersion: 'profit-ledger-v12-explicit-no-forecast-evidence',
              amounts: {
                estimatedCommissionFeeCny: { status: 'ready', value: 14.96 },
                actualCommissionFeeCny: { status: 'provisional', value: 0 },
              },
              results: { estimatedProfitCny: { status: 'ready', value: 20 } },
            },
          ],
        },
      },
    };

    const [migrated] = readProfitLedgerSnapshotFromStore(store, 'profit:shop-rfbs').rows;

    expect(migrated.calculationVersion).toBe(PROFIT_LEDGER_CALCULATION_VERSION);
    expect(migrated.migratedFromCalculationVersion).toBe(
      'profit-ledger-v12-explicit-no-forecast-evidence'
    );
    expect(migrated.amounts.estimatedCommissionFeeCny).toMatchObject({
      value: 14.96,
      status: 'ready',
    });
    expect(migrated.amounts.actualCommissionFeeCny).toMatchObject({
      value: null,
      status: 'pending',
      source: 'ozon-finance-sale-commission',
    });
    expect(migrated.results.estimatedProfitCny.status).toBe('pending');
  });

  it('migrates a v13 cancelled row without losing commission evidence and zeros a missing exact bus charge', () => {
    const legacy = createProfitLedgerRow(
      {
        id: '0133107681-0024-1',
        posting: '0133107681-0024-1',
        shopId: 'ozon-shop-example-02',
        status: 'cancelled',
        raw: { cancellation: { cancelled_after_ship: true } },
        amountValue: 167,
        currencyCode: 'CNY',
        purchasePriceValue: 0,
      },
      {
        actualFinanceStatus: 'confirmed',
        financeLookupChecked: true,
        amounts: {
          estimatedCommissionFeeCny: 28.39,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          estimatedCrossBorderBusFeeCny: 1.2,
          crossBorderBusFeeCny: 1.2,
        },
      }
    );
    legacy.calculationVersion = 'profit-ledger-v13-rfbs-finance-commission';
    legacy.amounts.actualCrossBorderBusFeeCny = {
      value: 1.2,
      status: 'ready',
      source: 'cross-border-bus-settings',
      reason: '',
      updatedAt: legacy.updatedAt,
      evidence: null,
    };
    legacy.results.actualProfitCny = {
      ...legacy.results.actualProfitCny,
      value: -1.2,
      status: 'ready',
      reason: '',
      missing: [],
    };

    const migrated = migrateProfitLedgerRowToCurrentVersion(legacy);

    expect(migrated.calculationVersion).toBe(PROFIT_LEDGER_CALCULATION_VERSION);
    expect(migrated.migratedFromCalculationVersion).toBe(
      'profit-ledger-v13-rfbs-finance-commission'
    );
    expect(migrated.amounts.actualCommissionFeeCny).toMatchObject({ value: 0, status: 'ready' });
    expect(migrated.amounts.actualCrossBorderBusFeeCny).toMatchObject({
      value: 0,
      status: 'ready',
      source: 'cross-border-final-no-exact-charge',
    });
    expect(migrated.results.actualProfitCny).toMatchObject({ value: 0, status: 'ready' });
    expect(migrated.status).not.toBe('loss');
  });

  it('migrates a v14 cancelled row without invalidating its verified commission evidence', () => {
    const legacy = createProfitLedgerRow(
      {
        id: '0133107681-0024-1',
        status: 'cancelled',
        substatus: 'posting_canceled',
        afterSalesStatus: '拒收后退款',
        raw: {
          status: 'cancelled',
          substatus: 'posting_canceled',
          cancellation: { cancelled_after_ship: true },
        },
        amountValue: 167,
        currencyCode: 'CNY',
        purchasePriceValue: 0,
      },
      {
        actualFinanceStatus: 'confirmed',
        financeLookupChecked: true,
        amounts: {
          actualSalesAmountCny: 0,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          estimatedCrossBorderBusFeeCny: 1.2,
          crossBorderBusFeeCny: 1.2,
        },
      }
    );
    legacy.calculationVersion = 'profit-ledger-v14-final-cross-border-charge-evidence';
    legacy.amounts.actualCrossBorderBusFeeCny = {
      value: null,
      status: 'pending',
      source: 'cross-border-charge-pending',
      reason: '缺跨境巴士实际扣费流水',
      updatedAt: legacy.updatedAt,
      evidence: null,
    };

    const migrated = migrateProfitLedgerRowToCurrentVersion(legacy);

    expect(migrated.migratedFromCalculationVersion).toBe(
      'profit-ledger-v14-final-cross-border-charge-evidence'
    );
    expect(migrated.amounts.actualCommissionFeeCny).toMatchObject({ value: 0, status: 'ready' });
    expect(migrated.amounts.actualCrossBorderBusFeeCny).toMatchObject({
      value: 0,
      status: 'ready',
      source: 'cross-border-final-no-exact-charge',
    });
    expect(migrated.results.actualProfitCny).toMatchObject({ value: 0, status: 'ready' });
  });

  it('migrates compatible v8 rows while invalidating only commission-dependent evidence', () => {
    const v8Row = createProfitLedgerRow(
      {
        id: 'v8-confirmed-order',
        status: '已完成',
        amountValue: 25,
        currencyCode: 'CNY',
        purchasePriceValue: 2.9,
      },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        financeLookupChecked: true,
        financeOperationCount: 4,
        profitFinanceVersion: 'v4-strict-posting-finance',
        amounts: {
          estimatedCommissionFeeCny: 3,
          estimatedAcquiringFeeCny: 0.5,
          estimatedDeliveryServiceFeeCny: 1.37,
          logisticsFeeCny: 7.3,
          actualCommissionFeeCny: 3.11,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0.25,
          actualDeliveryServiceFeeCny: 1.41,
          actualLogisticsFeeCny: 10.26,
          estimatedCrossBorderBusFeeCny: 1.6,
          actualCrossBorderBusFeeCny: 1.6,
          crossBorderBusFeeCny: 1.6,
        },
      }
    );
    v8Row.calculationVersion = 'profit-ledger-v8-finance-metadata-monotonic-shop-isolated';

    const migrated = migrateProfitLedgerRowToCurrentVersion(v8Row);

    expect(migrated.calculationVersion).toBe(PROFIT_LEDGER_CALCULATION_VERSION);
    expect(migrated.migratedFromCalculationVersion).toBe(
      'profit-ledger-v8-finance-metadata-monotonic-shop-isolated'
    );
    expect(migrated.actualFinanceStatus).toBe('confirmed');
    expect(migrated.financeLookupChecked).toBe(true);
    expect(migrated.financeOperationCount).toBe(4);
    expect(migrated.amounts.estimatedCommissionFeeCny).toMatchObject({ value: 3, status: 'ready' });
    expect(migrated.amounts.actualCommissionFeeCny).toMatchObject({ value: null, status: 'pending' });
    expect(migrated.amounts.actualOzonFeeCny).toMatchObject({ value: null, status: 'pending' });
    expect(migrated.amounts.actualAcquiringFeeCny.value).toBe(0.25);
    expect(migrated.amounts.actualDeliveryServiceFeeCny.value).toBe(1.41);
    expect(migrated.amounts.actualLogisticsFeeCny.value).toBe(10.26);
    expect(migrated.results.estimatedProfitCny.status).toBe('ready');
    expect(migrated.results.actualProfitCny.status).toBe('pending');
    expect(migrated.status).toBe('profit');
  });

  it('keeps non-commission v8 finance fields while applying only a fresh bus cash charge', () => {
    const confirmedV8 = createProfitLedgerRow(
      {
        id: 'v8-bus-reprice-order',
        status: '已完成',
        amountValue: 25,
        currencyCode: 'CNY',
        purchasePriceValue: 2.9,
      },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        financeLookupChecked: true,
        financeOperationCount: 4,
        profitFinanceVersion: 'v4-strict-posting-finance',
        amounts: {
          estimatedCommissionFeeCny: 3,
          estimatedAcquiringFeeCny: 0.5,
          estimatedDeliveryServiceFeeCny: 1.37,
          logisticsFeeCny: 7.3,
          actualCommissionFeeCny: 3.11,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0.25,
          actualDeliveryServiceFeeCny: 1.41,
          actualLogisticsFeeCny: 10.26,
          estimatedCrossBorderBusFeeCny: 1.6,
          actualCrossBorderBusFeeCny: 1.6,
          crossBorderBusFeeCny: 1.6,
        },
      }
    );
    confirmedV8.calculationVersion = 'profit-ledger-v8-finance-metadata-monotonic-shop-isolated';
    const cached = readProfitLedgerSnapshotFromStore(
      { profitLedgerSnapshots: { 'profit:shop-1': { rows: [confirmedV8] } } },
      'profit:shop-1'
    ).rows[0];
    const partialV9 = JSON.parse(JSON.stringify(cached));
    partialV9.actualFinanceStatus = 'pending';
    partialV9.hasActualFinance = false;
    partialV9.financeLookupChecked = false;
    partialV9.financeOperationCount = 0;
    partialV9.profitFinanceVersion = '';
    [
      'actualCommissionFeeCny',
      'actualPenaltyFeeCny',
      'actualAcquiringFeeCny',
      'actualDeliveryServiceFeeCny',
      'actualLogisticsFeeCny',
    ].forEach((field) => {
      partialV9.amounts[field] = { value: null, status: 'pending', reason: `missing ${field}` };
    });
    partialV9.amounts.actualCrossBorderBusFeeCny = {
      value: 1.2,
      status: 'ready',
      source: 'cross-border-charge-exact',
      reason: '',
    };

    const merged = mergeProfitLedgerRows([cached], [partialV9])[0];

    expect(merged.actualFinanceStatus).toBe('confirmed');
    expect(merged.financeLookupChecked).toBe(true);
    expect(merged.financeOperationCount).toBe(4);
    expect(merged.amounts.actualCommissionFeeCny).toMatchObject({ value: null, status: 'pending' });
    expect(merged.amounts.actualPenaltyFeeCny.value).toBe(0);
    expect(merged.amounts.actualAcquiringFeeCny.value).toBe(0.25);
    expect(merged.amounts.actualDeliveryServiceFeeCny.value).toBe(1.41);
    expect(merged.amounts.actualLogisticsFeeCny.value).toBe(10.26);
    expect(merged.amounts.actualCrossBorderBusFeeCny.value).toBe(1.2);
    expect(merged.results.actualProfitCny.status).toBe('pending');
    expect(merged.status).toBe('profit');
  });

  it('replaces invalidated legacy commission with fresh current rFBS and finance evidence', () => {
    const legacy = createProfitLedgerRow(
      {
        id: 'legacy-commission-refresh',
        status: '已完成',
        amountValue: 88,
        currencyCode: 'CNY',
        purchasePriceValue: 10,
      },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        financeLookupChecked: true,
        amounts: {
          estimatedCommissionFeeCny: 14.96,
          actualCommissionFeeCny: 14.96,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 1,
          actualDeliveryServiceFeeCny: 1,
          actualLogisticsFeeCny: 1,
        },
      }
    );
    legacy.calculationVersion = 'profit-ledger-v12-explicit-no-forecast-evidence';
    const migrated = migrateProfitLedgerRowToCurrentVersion(legacy);
    const fresh = createProfitLedgerRow(
      {
        id: 'legacy-commission-refresh',
        status: '已完成',
        amountValue: 88,
        currencyCode: 'CNY',
        purchasePriceValue: 10,
      },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        financeLookupChecked: true,
        amounts: {
          estimatedCommissionFeeCny: 10.56,
          actualCommissionFeeCny: 10.56,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 1,
          actualDeliveryServiceFeeCny: 1,
          actualLogisticsFeeCny: 1,
        },
      }
    );

    const [merged] = mergeProfitLedgerRows([migrated], [fresh], { keepUnseenCached: false });

    expect(merged.amounts.estimatedCommissionFeeCny.value).toBe(10.56);
    expect(merged.amounts.actualCommissionFeeCny.value).toBe(10.56);
  });

  it('migrates more than one thousand compatible rows without truncation or cross-shop key loss', () => {
    const base = createProfitLedgerRow(
      { id: 'bulk-base', status: '已完成', amountValue: 25, currencyCode: 'CNY', purchasePriceValue: 2.9 },
      {
        shopId: 'shop-a',
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        financeLookupChecked: true,
        amounts: {
          estimatedCommissionFeeCny: 3,
          estimatedAcquiringFeeCny: 0.5,
          estimatedDeliveryServiceFeeCny: 1.37,
          estimatedCrossBorderBusFeeCny: 1.2,
          logisticsFeeCny: 7.3,
          actualCommissionFeeCny: 3.11,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0.25,
          actualDeliveryServiceFeeCny: 1.41,
          actualLogisticsFeeCny: 10.26,
          actualCrossBorderBusFeeCny: 1.2,
        },
      }
    );
    const rows = Array.from({ length: 1005 }, (_, index) => ({
      ...JSON.parse(JSON.stringify(base)),
      calculationVersion: 'profit-ledger-v8-finance-metadata-monotonic-shop-isolated',
      ledgerKey: `${index % 2 ? 'shop-b' : 'shop-a'}:bulk-${index}`,
      orderKey: `${index % 2 ? 'shop-b' : 'shop-a'}:bulk-${index}`,
      shopId: index % 2 ? 'shop-b' : 'shop-a',
    }));
    const snapshot = readProfitLedgerSnapshotFromStore(
      { profitLedgerSnapshots: { 'profit:multi-shop': { rows } } },
      'profit:multi-shop'
    );

    expect(snapshot.rows).toHaveLength(1005);
    expect(new Set(snapshot.rows.map((row) => row.ledgerKey)).size).toBe(1005);
    expect(snapshot.rows.filter((row) => row.shopId === 'shop-a')).toHaveLength(503);
    expect(snapshot.rows.filter((row) => row.shopId === 'shop-b')).toHaveLength(502);
    expect(snapshot.rows.every((row) => row.calculationVersion === PROFIT_LEDGER_CALCULATION_VERSION)).toBe(true);
    expect(snapshot.rows.every((row) => row.results.actualProfitCny.status === 'pending')).toBe(true);
  });

  it('persists a compatible v8 snapshot migration even when its financial values are unchanged', () => {
    const v8Row = createProfitLedgerRow({
      id: 'persist-v8-migration',
      status: '已完成',
      amountValue: 16,
      currencyCode: 'CNY',
      purchasePriceValue: 2.9,
    });
    v8Row.calculationVersion = 'profit-ledger-v8-finance-metadata-monotonic';
    const legacyStore = {
      profitLedgerSnapshots: {
        'profit:shop-1': {
          calculationVersion: 'profit-ledger-v8-finance-metadata-monotonic',
          rows: [v8Row],
        },
      },
    };
    const migratedSnapshot = readProfitLedgerSnapshotFromStore(legacyStore, 'profit:shop-1');
    const first = mergeProfitLedgerSnapshotIntoStore(legacyStore, 'profit:shop-1', migratedSnapshot);
    const second = mergeProfitLedgerSnapshotIntoStore(first.store, 'profit:shop-1', first.snapshot);

    expect(first.stats.changed).toBe(true);
    expect(first.stats.migrated).toBe(true);
    expect(first.store.profitLedgerSnapshots['profit:shop-1'].calculationVersion).toBe(
      PROFIT_LEDGER_CALCULATION_VERSION
    );
    expect(first.store.profitLedgerSnapshots['profit:shop-1'].rows[0].calculationVersion).toBe(
      PROFIT_LEDGER_CALCULATION_VERSION
    );
    expect(second.stats.changed).toBe(false);
    expect(second.stats.migrated).toBe(false);
  });

  it('keeps cached profit ledger rows when a fresh snapshot only contains errors', () => {
    const row = createProfitLedgerRow({
      id: 'error-kept-order',
      amountValue: 16,
      currencyCode: 'CNY',
      purchasePriceValue: 2.9,
    });
    const first = mergeProfitLedgerSnapshotIntoStore(
      {},
      'profit:shop-1',
      createProfitLedgerSnapshot([row], { sourceKey: 'shop-1' })
    ).store;
    const second = mergeProfitLedgerSnapshotIntoStore(first, 'profit:shop-1', {
      rows: [],
      errors: [{ label: 'Ozon', message: 'temporary failure' }],
      fetchedAt: '2026-06-25T00:00:00.000Z',
    }).store;

    const snapshot = readProfitLedgerSnapshotFromStore(second, 'profit:shop-1');
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].ledgerKey).toBe('error-kept-order');
    expect(snapshot.errors).toHaveLength(1);
  });

  it('clears only the selected profit ledger snapshot from the local data layer', () => {
    const row = createProfitLedgerRow({
      id: 'clear-order',
      amountValue: 16,
      currencyCode: 'CNY',
      purchasePriceValue: 2.9,
    });
    const store = mergeProfitLedgerSnapshotIntoStore(
      {
        snapshots: { 'ozon-sales-orders:shop-1': { rowKeys: ['clear-order'] } },
        products: { sku1: { fields: { sku: 'sku1' } } },
        profitLedgerSnapshots: {
          'profit:other-shop': createProfitLedgerSnapshot([{ id: 'other-order', amountValue: 1, currencyCode: 'CNY' }]),
        },
      },
      'profit:shop-1',
      createProfitLedgerSnapshot([row], { sourceKey: 'shop-1' })
    ).store;

    const cleared = clearProfitLedgerSnapshotFromStore(store, 'profit:shop-1');

    expect(cleared.stats.changed).toBe(true);
    expect(readProfitLedgerSnapshotFromStore(cleared.store, 'profit:shop-1')).toBeNull();
    expect(readProfitLedgerSnapshotFromStore(cleared.store, 'profit:other-shop').rows).toHaveLength(1);
    expect(cleared.store.snapshots).toBe(store.snapshots);
    expect(cleared.store.products).toBe(store.products);
  });

  it('reads and clears legacy profit ledger snapshots through candidate keys', () => {
    const row = createProfitLedgerRow({
      id: 'legacy-order',
      amountValue: 16,
      currencyCode: 'CNY',
      purchasePriceValue: 2.9,
    });
    const candidates = getProfitLedgerSnapshotCacheKeyCandidates([
      {
        id: 'ozon-shop-1',
        clientId: 'client-a',
        shopAlias: 'Ozon 1店',
      },
    ]);
    const legacyKey = candidates[1];
    const store = {
      snapshots: { 'ozon-sales-orders:shop-1': { rowKeys: ['legacy-order'] } },
      profitLedgerSnapshots: {
        [legacyKey]: createProfitLedgerSnapshot([row], { sourceKey: legacyKey }),
      },
    };

    const snapshot = readProfitLedgerSnapshotFromStore(store, candidates);
    expect(snapshot.rows[0].ledgerKey).toBe('legacy-order');

    const cleared = clearProfitLedgerSnapshotFromStore(store, candidates);
    expect(cleared.stats.changed).toBe(true);
    expect(readProfitLedgerSnapshotFromStore(cleared.store, candidates)).toBeNull();
    expect(cleared.store.snapshots).toBe(store.snapshots);
  });

  it('reads legacy profit ledger snapshot keys that used a secret-like segment without requiring the secret again', () => {
    const row = createProfitLedgerRow({
      id: 'legacy-secret-key-order',
      amountValue: 16,
      currencyCode: 'CNY',
      purchasePriceValue: 2.9,
    });
    const oldSecretLikeSegment = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const legacyKey = `ozon-profit-ledger-v1:ozon-shop-1:client-a:${oldSecretLikeSegment}`;
    const store = {
      profitLedgerSnapshots: {
        [legacyKey]: createProfitLedgerSnapshot([row], { sourceKey: legacyKey }),
      },
    };

    const snapshot = readProfitLedgerSnapshotFromStore(store, 'ozon-profit-ledger-v1:ozon-shop-1:client-a');

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].ledgerKey).toBe('legacy-secret-key-order');
  });

  it('keeps missing estimated commission pending instead of converting it to zero', () => {
    const ledger = createProfitLedgerRow(
      {
        id: 'missing-commission',
        amountValue: 27,
        currencyCode: 'CNY',
        products: [{ offerId: 'offer-1', qty: 1 }],
      },
      {
        amounts: {
          estimatedCommissionFeeCny: null,
          estimatedAcquiringFeeCny: 0.54,
          estimatedDeliveryServiceFeeCny: 1.42,
          crossBorderBusFeeCny: 1.23,
          logisticsFeeCny: 6.76,
        },
      }
    );

    expect(ledger.amounts.estimatedCommissionFeeCny.status).toBe('pending');
    expect(ledger.amounts.estimatedCommissionFeeCny.value).toBeNull();
    expect(ledger.results.estimatedProfitCny.status).toBe('pending');
    expect(ledger.results.estimatedProfitCny.value).toBeNull();
  });

  it('keeps ready actual finance from the ledger when a stale page row is still pending', () => {
    const order = {
      id: '0139229900-0042-1',
      posting: '0139229900-0042-1',
      softwareOrderId: '0139229900-0042',
      shopClientId: '4616153',
      status: '成功订单',
      amountValue: 58.93,
      currencyCode: 'CNY',
      products: [{ offerId: 'mz-26051511-399401', qty: 1 }],
    };
    const readyLedger = createProfitLedgerRow(order, {
      updatedAt: '2026-06-28T13:42:37.921Z',
      actualFinanceStatus: 'confirmed',
      amounts: {
        estimatedCommissionFeeCny: 7.6609,
        estimatedAcquiringFeeCny: 1.18,
        estimatedDeliveryServiceFeeCny: 1.42,
        actualCommissionFeeCny: 7.6427091,
        actualPenaltyFeeCny: 0,
        actualAcquiringFeeCny: 0.1467385,
        actualDeliveryServiceFeeCny: 1.42005,
        actualLogisticsFeeCny: 20.8378137,
        crossBorderBusFeeCny: 1.23,
      },
    });
    const stalePageLedger = createProfitLedgerRow(order, {
      updatedAt: '2026-06-27T13:05:10.852Z',
      amounts: {
        estimatedCommissionFeeCny: 7.6609,
      },
    });

    const selectedLedger = selectBestProfitLedgerRow([stalePageLedger, readyLedger]);
    const [mergedLedger] = mergeProfitLedgerRows([readyLedger], [stalePageLedger], {
      keepUnseenCached: true,
    });

    expect(selectedLedger.results.actualProfitCny.status).toBe('ready');
    expect(selectedLedger.results.actualProfitCny.value).toBeCloseTo(27.65, 1);
    expect(mergedLedger.results.actualProfitCny.status).toBe('ready');
    expect(mergedLedger.amounts.actualCommissionFeeCny.value).toBeCloseTo(7.6427091, 5);
  });

  it('never downgrades confirmed finance metadata when the page recalculates without a finance index', () => {
    const order = {
      id: 'delivered-finance-metadata-order',
      status: 'delivered',
      amountValue: 47,
      currencyCode: 'CNY',
      purchasePriceValue: 0,
    };
    const confirmed = createProfitLedgerRow(order, {
      actualFinanceStatus: 'confirmed',
      hasActualFinance: true,
      financeLookupChecked: true,
      financeOperationCount: 3,
      profitFinanceVersion: 'finance-snapshot-v1',
      allowZeroPurchaseCost: true,
      amounts: {
        actualCommissionFeeCny: 5.64,
        actualPenaltyFeeCny: 0,
        actualAcquiringFeeCny: 0.94,
        actualDeliveryServiceFeeCny: 1.42,
        actualLogisticsFeeCny: 10.4,
        crossBorderBusFeeCny: 1.23,
      },
    });
    const financeLessPageRecalculation = createProfitLedgerRow(order, {
      actualFinanceStatus: 'pending',
      hasActualFinance: false,
      financeLookupChecked: false,
      financeOperationCount: 0,
      allowZeroPurchaseCost: true,
      amounts: {
        estimatedCommissionFeeCny: 5.64,
        estimatedAcquiringFeeCny: 0.94,
        estimatedDeliveryServiceFeeCny: 1.42,
      },
    });

    const [merged] = mergeProfitLedgerRows([confirmed], [financeLessPageRecalculation], {
      keepUnseenCached: false,
    });

    expect(merged.actualFinanceStatus).toBe('confirmed');
    expect(merged.hasActualFinance).toBe(true);
    expect(merged.financeLookupChecked).toBe(true);
    expect(merged.financeOperationCount).toBe(3);
    expect(merged.profitFinanceVersion).toBe('finance-snapshot-v1');
    expect(merged.results.actualProfitCny.status).toBe('ready');
  });

  it('merges legacy Client-Id and canonical internal-shop ledgers without losing confirmed finance', () => {
    const posting = '38652143-0161-1';
    const shopId = 'ozon-shop-example-01';
    const shopClientId = '4616153';
    const order = {
      id: posting,
      posting,
      shopId,
      shopClientId,
      status: 'cancelled',
      amountValue: 16,
      currencyCode: 'CNY',
      purchasePriceValue: 0,
    };
    const confirmed = createProfitLedgerRow(
      {
        ...order,
        recordKey: `${shopClientId}:${posting}`,
        profitRecordKey: `${shopClientId}:${posting}`,
      },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        financeLookupChecked: true,
        financeOperationCount: 2,
        profitFinanceVersion: 'v4-strict-posting-finance',
        allowZeroPurchaseCost: true,
        actualCrossBorderBusFeeSource: 'cross-border-bus-ledger-cash-converted',
        crossBorderChargeEvidence: {
          source: 'cross-border-bus-ledger-cash-converted',
          collectionNumber: 'zero-charge-38652143',
          actualFeeCny: 0,
        },
        amounts: {
          actualSalesAmountCny: 0,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          actualOzonFeeCny: 0,
          platformNetCny: 0,
          actualCrossBorderBusFeeCny: 0,
        },
      }
    );
    const pending = createProfitLedgerRow(
      {
        ...order,
        recordKey: `${shopId}:${posting}`,
        profitRecordKey: `${shopId}:${posting}`,
      },
      {
        actualFinanceStatus: 'pending',
        financeLookupChecked: false,
        financeOperationCount: 0,
        allowZeroPurchaseCost: true,
      }
    );

    expect(confirmed.ledgerKey).toBe(`${shopClientId}:${posting}`);
    expect(pending.ledgerKey).toBe(`${shopId}:${posting}`);

    const [merged] = mergeProfitLedgerRows([confirmed], [pending], { keepUnseenCached: false });

    expect(merged.ledgerKey).toBe(`${shopId}:${posting}`);
    expect(merged.orderKey).toBe(`${shopId}:${posting}`);
    expect(merged.orderSnapshot.recordKey).toBe(`${shopId}:${posting}`);
    expect(merged.actualFinanceStatus).toBe('confirmed');
    expect(merged.financeLookupChecked).toBe(true);
    expect(merged.financeOperationCount).toBe(2);
    expect(merged.results.actualProfitCny.status).toBe('ready');
  });

  it('migrates v10 ledger aliases to the canonical internal shop key', () => {
    const posting = '0157472217-0008-1';
    const row = createProfitLedgerRow(
      {
        id: posting,
        posting,
        shopId: 'ozon-shop-example-02',
        shopClientId: '4067587',
        recordKey: `4067587:${posting}`,
        profitRecordKey: `4067587:${posting}`,
        status: 'cancelled',
        amountValue: 150,
        currencyCode: 'CNY',
      },
      {
        actualFinanceStatus: 'confirmed',
        financeLookupChecked: true,
        amounts: { actualSalesAmountCny: 0 },
      }
    );
    row.calculationVersion = 'profit-ledger-v10-cross-border-source-authority';

    const migrated = migrateProfitLedgerRowToCurrentVersion(row);

    expect(migrated.calculationVersion).toBe(PROFIT_LEDGER_CALCULATION_VERSION);
    expect(migrated.migratedFromCalculationVersion).toBe('profit-ledger-v10-cross-border-source-authority');
    expect(migrated.ledgerKey).toBe(`ozon-shop-example-02:${posting}`);
    expect(migrated.orderSnapshot.profitRecordKey).toBe(`ozon-shop-example-02:${posting}`);
    expect(migrated.financeLookupChecked).toBe(true);
  });

  it('keeps delivered successful orders ready instead of treating them as in-progress', () => {
    const ledger = createProfitLedgerRow(
      {
        id: '0139229900-0042-1',
        posting: '0139229900-0042-1',
        softwareOrderId: '0139229900-0042',
        shopClientId: '4616153',
        status: 'delivered',
        statusLabel: '成功订单',
        amountValue: 58.93,
        currencyCode: 'CNY',
        products: [{ offerId: 'mz-26051511-399401', qty: 1 }],
      },
      {
        actualFinanceStatus: 'confirmed',
        allowZeroPurchaseCost: true,
        amounts: {
          sourcePurchaseCostCny: 0,
          actualCommissionFeeCny: 7.6427091,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0.1467385,
          actualDeliveryServiceFeeCny: 1.42005,
          actualLogisticsFeeCny: 20.8378137,
          crossBorderBusFeeCny: 1.225,
        },
      }
    );

    expect(ledger.results.actualProfitCny.status).toBe('ready');
    expect(ledger.results.actualProfitCny.value).toBeCloseTo(27.6576887, 5);
  });

  it('sanitizes cached ready actual profit for shipped but unfinished orders', () => {
    const store = {
      profitLedgerSnapshots: {
        'profit:shop-1': {
          rows: [
            {
              schemaVersion: 1,
              calculationVersion: PROFIT_LEDGER_CALCULATION_VERSION,
              ledgerKey: '4616153:06477778-0475-1',
              orderKey: '4616153:06477778-0475-1',
              orderSnapshot: {
                id: '06477778-0475-1',
                posting: '06477778-0475-1',
                status: '已经发货',
                fulfillment: 'FBS',
              },
              amounts: {
                salesAmountCny: { value: 27, status: 'ready' },
                actualSalesAmountCny: { value: 27, status: 'ready' },
                sourcePurchaseCostCny: { value: 13.8, status: 'ready' },
                estimatedCommissionFeeCny: { value: 3.24, status: 'ready' },
                estimatedAcquiringFeeCny: { value: 0.54, status: 'ready' },
                estimatedDeliveryServiceFeeCny: { value: 1.42, status: 'ready' },
                logisticsFeeCny: { value: 6.76, status: 'ready' },
                crossBorderBusFeeCny: { value: 1.23, status: 'ready' },
                actualCommissionFeeCny: { value: 0, status: 'ready' },
                actualPenaltyFeeCny: { value: 0, status: 'ready' },
                actualAcquiringFeeCny: { value: 0.53, status: 'ready' },
                actualDeliveryServiceFeeCny: { value: 0, status: 'ready' },
                actualLogisticsFeeCny: { value: 0, status: 'ready' },
              },
              results: {
                estimatedProfitCny: { value: 0.01, status: 'ready' },
                actualProfitCny: { value: 11.45, status: 'ready' },
                bestProfitCny: { value: 11.45, status: 'ready' },
              },
            },
          ],
        },
      },
    };

    const snapshot = readProfitLedgerSnapshotFromStore(store, 'profit:shop-1');
    const row = snapshot.rows[0];

    expect(row.results.actualProfitCny.status).toBe('pending');
    expect(row.results.actualProfitCny.value).toBeNull();
    expect(row.results.bestProfitCny.status).toBe('ready');
    expect(row.results.bestProfitCny.value).toBeCloseTo(0.01);
    expect(row.status).toBe('profit');
  });

  it('keeps estimated and actual cross-border bus fees separated on one ledger row', () => {
    const ledger = createProfitLedgerRow(
      {
        id: 'closed-no-forecast',
        status: '关闭订单',
        amountValue: 27,
        currencyCode: 'CNY',
        purchasePriceValue: 13.8,
        products: [{ offerId: 'mz-bus-split', qty: 1 }],
      },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        actualCrossBorderBusFeeSource: 'cross-border-bus-ledger-cash-converted',
        crossBorderChargeEvidence: {
          source: 'cross-border-bus-ledger-cash-converted',
          collectionNumber: 'zero-charge-closed-no-forecast',
          actualFeeCny: 0,
        },
        amounts: {
          estimatedCommissionFeeCny: 3.24,
          estimatedAcquiringFeeCny: 0.54,
          estimatedDeliveryServiceFeeCny: 1.42,
          estimatedCrossBorderBusFeeCny: 1.23,
          actualCrossBorderBusFeeCny: 0,
          logisticsFeeCny: 8.8,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
        },
      }
    );

    expect(ledger.amounts.estimatedCrossBorderBusFeeCny.value).toBe(1.23);
    expect(ledger.amounts.actualCrossBorderBusFeeCny.value).toBe(0);
    expect(ledger.results.estimatedProfitCny.value).toBeCloseTo(-2.03, 5);
    expect(ledger.amounts.actualSalesAmountCny.value).toBe(0);
    expect(ledger.results.actualProfitCny.value).toBeCloseTo(-13.8, 5);
  });

  it('keeps the configured estimated bus fee fallback for non-final successful orders', () => {
    const ledger = createProfitLedgerRow(
      {
        id: '0209987208-0062-1',
        status: 'delivered',
        statusLabel: '成功订单',
        amountValue: 59,
        currencyCode: 'CNY',
        purchasePriceValue: 0,
        products: [{ offerId: 'mz-26050912-969116', qty: 1 }],
      },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        amounts: {
          estimatedCommissionFeeCny: 7.08,
          estimatedAcquiringFeeCny: 1.18,
          estimatedDeliveryServiceFeeCny: 1.36,
          estimatedCrossBorderBusFeeCny: 1.23,
          actualCrossBorderBusFeeCny: null,
          logisticsFeeCny: 11.49,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 7.91,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
        },
      }
    );

    expect(ledger.amounts.estimatedCrossBorderBusFeeCny.value).toBe(1.23);
    expect(ledger.amounts.actualCrossBorderBusFeeCny).toMatchObject({
      value: 1.23,
      status: 'ready',
      source: 'cross-border-bus-settings',
    });
    expect(ledger.results.actualProfitCny.status).toBe('ready');
    expect(ledger.results.actualProfitCny.value).toBeCloseTo(49.86, 5);
  });

  it('repairs a cached pending bus fee from the configured estimate for non-final successful orders', () => {
    const cached = createProfitLedgerRow(
      {
        id: '0209987208-0062-1',
        status: 'delivered',
        statusLabel: '成功订单',
        amountValue: 59,
        currencyCode: 'CNY',
        purchasePriceValue: 0,
        products: [{ offerId: 'mz-26050912-969116', qty: 1 }],
      },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        amounts: {
          estimatedCommissionFeeCny: 7.08,
          estimatedAcquiringFeeCny: 1.18,
          estimatedDeliveryServiceFeeCny: 1.36,
          estimatedCrossBorderBusFeeCny: 1.23,
          crossBorderBusFeeCny: 1.23,
          actualCrossBorderBusFeeCny: 1.23,
          logisticsFeeCny: 11.49,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 7.91,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
        },
      }
    );
    const stale = JSON.parse(JSON.stringify(cached));
    stale.amounts.actualCrossBorderBusFeeCny = {
      value: null,
      status: 'pending',
      source: 'cross-border-bus-settings',
      reason: '缺实际巴士费用',
      updatedAt: cached.updatedAt,
      evidence: null,
    };
    stale.results.actualProfitCny = {
      value: null,
      status: 'pending',
      reason: '缺实际巴士费用',
      missing: ['缺实际巴士费用'],
      formula: cached.results.actualProfitCny.formula,
      updatedAt: cached.updatedAt,
    };

    const [recomputed] = mergeProfitLedgerRows([], [stale]);

    expect(recomputed.amounts.actualCrossBorderBusFeeCny).toMatchObject({
      value: 1.23,
      status: 'ready',
      source: 'cross-border-bus-settings',
    });
    expect(recomputed.results.actualProfitCny.status).toBe('ready');
    expect(recomputed.results.actualProfitCny.value).toBeCloseTo(49.86, 5);
  });

  it('repairs cached pending actual bus fee to zero for final cancelled rows without a forecast id', () => {
    const cached = createProfitLedgerRow(
      {
        id: '0223908490-0032-2',
        status: 'cancelled',
        substatus: 'posting_canceled',
        readStatus: '已回查无预报记录',
        amountValue: 57,
        currencyCode: 'CNY',
        purchasePriceValue: 0,
        products: [{ offerId: 'mz-26050917-186129', qty: 1 }],
      },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        amounts: {
          actualSalesAmountCny: 0,
          estimatedCommissionFeeCny: 6.84,
          estimatedAcquiringFeeCny: 1.14,
          estimatedDeliveryServiceFeeCny: 1.39,
          estimatedCrossBorderBusFeeCny: 1.23,
          crossBorderBusFeeCny: 1.23,
          actualCrossBorderBusFeeCny: 0,
          logisticsFeeCny: 6.03,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 7.64,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
        },
      }
    );
    const stale = JSON.parse(JSON.stringify(cached));
    stale.amounts.actualCrossBorderBusFeeCny = {
      value: null,
      status: 'pending',
      source: 'cross-border-bus-settings',
      reason: '缺实际巴士费用',
      updatedAt: cached.updatedAt,
      evidence: null,
    };

    const [recomputed] = mergeProfitLedgerRows([], [stale]);

    expect(recomputed.amounts.actualCrossBorderBusFeeCny.value).toBe(0);
    expect(recomputed.amounts.actualCrossBorderBusFeeCny.source).toBe('cross-border-no-forecast');
    expect(recomputed.results.actualProfitCny.status).toBe('ready');
    expect(recomputed.results.actualProfitCny.value).toBeCloseTo(-7.64, 5);
  });

  it('uses zero only when a final cancelled row has explicit no-forecast evidence', () => {
    const ledger = createProfitLedgerRow(
      {
        id: '0223908490-0032-2',
        status: 'cancelled',
        substatus: 'posting_canceled',
        readStatus: '已回查无预报记录',
        amountValue: 57,
        currencyCode: 'CNY',
        purchasePriceValue: 0,
        products: [{ offerId: 'mz-26050917-186129', qty: 1 }],
      },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        amounts: {
          actualSalesAmountCny: 0,
          estimatedCommissionFeeCny: 6.84,
          estimatedAcquiringFeeCny: 1.14,
          estimatedDeliveryServiceFeeCny: 1.39,
          estimatedCrossBorderBusFeeCny: 1.23,
          crossBorderBusFeeCny: 1.23,
          logisticsFeeCny: 6.03,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 7.64,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
        },
      }
    );

    expect(ledger.amounts.estimatedCrossBorderBusFeeCny.value).toBe(1.23);
    expect(ledger.amounts.crossBorderBusFeeCny.value).toBe(1.23);
    expect(ledger.amounts.actualCrossBorderBusFeeCny.value).toBe(0);
    expect(ledger.amounts.actualCrossBorderBusFeeCny.source).toBe('cross-border-no-forecast');
    expect(ledger.results.actualProfitCny.value).toBeCloseTo(-7.64, 5);
  });

  it('keeps zero for a definitive pre-shipment cancellation without a cross-border forecast', () => {
    const ledger = createProfitLedgerRow(
      {
        id: 'pre-shipment-cancelled-order',
        status: 'cancelled',
        substatus: 'posting_canceled',
        afterSalesStatus: '发货前取消',
        raw: {
          status: 'cancelled',
          substatus: 'posting_canceled',
          cancellation: { cancelled_after_ship: false },
        },
        amountValue: 57,
        currencyCode: 'CNY',
        purchasePriceValue: 0,
      },
      {
        actualFinanceStatus: 'confirmed',
        financeLookupChecked: true,
        amounts: {
          actualSalesAmountCny: 0,
          estimatedCrossBorderBusFeeCny: 1.23,
          crossBorderBusFeeCny: 1.23,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
        },
      }
    );

    expect(ledger.orderSnapshot.cancelledAfterShip).toBe(false);
    expect(ledger.amounts.actualCrossBorderBusFeeCny).toMatchObject({
      value: 0,
      source: 'cross-border-no-forecast',
    });
    expect(ledger.results.actualProfitCny.value).toBe(0);
  });

  it('uses zero actual bus fee for a buyer-refunded final order when no exact charge exists', () => {
    const stale = createProfitLedgerRow(
      {
        id: '38652143-0161-1',
        status: 'cancelled',
        substatus: 'posting_canceled',
        afterSalesStatus: '拒收后退款',
        raw: {
          status: 'cancelled',
          substatus: 'posting_canceled',
          cancellation: { cancelled_after_ship: true },
        },
        amountValue: 57,
        currencyCode: 'CNY',
        purchasePriceValue: 0,
      },
      {
        actualFinanceStatus: 'confirmed',
        financeLookupChecked: true,
        amounts: {
          actualSalesAmountCny: 0,
          estimatedCrossBorderBusFeeCny: 1.23,
          crossBorderBusFeeCny: 1.23,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
        },
      }
    );
    stale.amounts.actualCrossBorderBusFeeCny = {
      value: 0,
      status: 'ready',
      source: 'cross-border-no-forecast',
      reason: '',
      updatedAt: stale.updatedAt,
      evidence: null,
    };
    stale.results.actualProfitCny = {
      ...stale.results.actualProfitCny,
      value: 0,
      status: 'ready',
      reason: '',
      missing: [],
    };

    const [recomputed] = mergeProfitLedgerRows([], [stale]);

    expect(recomputed.amounts.actualCrossBorderBusFeeCny).toMatchObject({
      value: 0,
      status: 'ready',
      source: 'cross-border-final-no-exact-charge',
    });
    expect(recomputed.results.actualProfitCny.status).toBe('ready');
    expect(recomputed.results.actualProfitCny.value).toBe(0);
  });

  it('overrides stale ready actual bus fee to zero for final cancelled rows without a forecast id', () => {
    const stale = createProfitLedgerRow(
      {
        id: '0223908490-0032-2',
        status: 'cancelled',
        substatus: 'posting_canceled',
        readStatus: '已回查无预报记录',
        amountValue: 57,
        currencyCode: 'CNY',
        purchasePriceValue: 0,
        products: [{ offerId: 'mz-26050917-186129', qty: 1 }],
      },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        amounts: {
          actualSalesAmountCny: 0,
          estimatedCommissionFeeCny: 6.84,
          estimatedAcquiringFeeCny: 1.14,
          estimatedDeliveryServiceFeeCny: 1.39,
          estimatedCrossBorderBusFeeCny: 1.23,
          crossBorderBusFeeCny: 1.23,
          actualCrossBorderBusFeeCny: 0,
          logisticsFeeCny: 6.03,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 7.64,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
        },
      }
    );
    stale.amounts.actualCrossBorderBusFeeCny = {
      value: 1.23,
      status: 'ready',
      source: 'cross-border-bus-settings',
      reason: '',
      updatedAt: stale.updatedAt,
      evidence: null,
    };
    stale.results.actualProfitCny = {
      value: -8.87,
      status: 'ready',
      reason: '',
      missing: [],
      formula: stale.results.actualProfitCny.formula,
      updatedAt: stale.updatedAt,
    };

    const [recomputed] = mergeProfitLedgerRows([], [stale]);

    expect(stale.amounts.actualCrossBorderBusFeeCny.value).toBe(1.23);
    expect(recomputed.amounts.actualCrossBorderBusFeeCny.value).toBe(0);
    expect(recomputed.amounts.actualCrossBorderBusFeeCny.source).toBe('cross-border-no-forecast');
    expect(recomputed.results.actualProfitCny.value).toBeCloseTo(-7.64, 5);
  });

  it('recomputes final cancelled cached rows with finance evidence to zero actual income and zero bus fee', () => {
    const stale = createProfitLedgerRow(
      {
        id: '0223908490-0032-2',
        status: 'cancelled',
        substatus: 'posting_canceled',
        readStatus: '已回查无预报记录',
        amountValue: 57,
        currencyCode: 'CNY',
        purchasePriceValue: 0,
      },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        amounts: {
          estimatedCrossBorderBusFeeCny: 1.23,
          crossBorderBusFeeCny: 1.23,
          actualCrossBorderBusFeeCny: 0,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 7.64,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
        },
      }
    );
    stale.amounts.actualSalesAmountCny = {
      value: 57,
      status: 'ready',
      source: 'old-cache',
      reason: '',
      updatedAt: stale.updatedAt,
      evidence: null,
    };
    stale.amounts.actualCrossBorderBusFeeCny = {
      value: 1.23,
      status: 'ready',
      source: 'cross-border-bus-settings',
      reason: '',
      updatedAt: stale.updatedAt,
      evidence: null,
    };

    const [recomputed] = mergeProfitLedgerRows([], [stale]);

    expect(recomputed.amounts.actualSalesAmountCny.value).toBe(0);
    expect(recomputed.amounts.actualCrossBorderBusFeeCny.value).toBe(0);
    expect(recomputed.amounts.actualCrossBorderBusFeeCny.source).toBe('cross-border-no-forecast');
    expect(recomputed.results.actualProfitCny.value).toBeCloseTo(-7.64, 5);
  });

  it('does not treat historical forecast identity as an actual bus charge', () => {
    const ledger = createProfitLedgerRow(
      {
        id: 'forecasted-cancelled-order',
        status: 'cancelled',
        substatus: 'posting_canceled',
        amountValue: 57,
        currencyCode: 'CNY',
        purchasePriceValue: 0,
        crossBorderOrderId: '49531424',
      },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        amounts: {
          actualSalesAmountCny: 0,
          estimatedCrossBorderBusFeeCny: 1.23,
          crossBorderBusFeeCny: 1.23,
          actualCrossBorderBusFeeCny: 1.23,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 7.64,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
        },
      }
    );

    expect(ledger.amounts.actualCrossBorderBusFeeCny).toMatchObject({
      value: 0,
      status: 'ready',
      source: 'cross-border-final-no-exact-charge',
    });
    expect(ledger.results.actualProfitCny.status).toBe('ready');
    expect(ledger.results.actualProfitCny.value).toBeCloseTo(-7.64, 5);
    expect(ledger.orderSnapshot.crossBorderOrderId).toBe('49531424');

    const [recomputed] = mergeProfitLedgerRows([], [ledger]);
    expect(recomputed.amounts.actualCrossBorderBusFeeCny).toMatchObject({
      value: 0,
      status: 'ready',
      source: 'cross-border-final-no-exact-charge',
    });
  });

  it('keeps an exact cash-converted charge on a final order even when the sales snapshot lacks forecast ids', () => {
    const ledger = createProfitLedgerRow(
      {
        id: '96606108-0082-1',
        status: 'cancelled',
        substatus: 'posting_canceled',
        amountValue: 61,
        currencyCode: 'CNY',
        purchasePriceValue: 0,
      },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        financeLookupChecked: true,
        actualCrossBorderBusFeeSource: 'cross-border-bus-ledger-cash-converted',
        crossBorderChargeEvidence: {
          source: 'cross-border-bus-ledger-cash-converted',
          collectionNumber: '56185',
          statementCount: 1,
          ledgerNetCny: 1.5,
          actualFeeCny: 1.13,
        },
        amounts: {
          actualSalesAmountCny: 0,
          estimatedCrossBorderBusFeeCny: 1.23,
          actualCrossBorderBusFeeCny: 1.13,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
        },
      }
    );

    expect(ledger.amounts.actualCrossBorderBusFeeCny).toMatchObject({
      value: 1.13,
      status: 'ready',
      source: 'cross-border-bus-ledger-cash-converted',
    });
    expect(ledger.amounts.actualCrossBorderBusFeeCny.evidence.collectionNumber).toBe('56185');
  });

  it('does not let a fresh no-forecast zero overwrite an exact cached charge', () => {
    const exact = createProfitLedgerRow(
      { id: '96606108-0082-2', status: 'cancelled', amountValue: 61, currencyCode: 'CNY' },
      {
        actualFinanceStatus: 'confirmed',
        financeLookupChecked: true,
        actualCrossBorderBusFeeSource: 'cross-border-bus-ledger-cash-converted',
        crossBorderChargeEvidence: {
          source: 'cross-border-bus-ledger-cash-converted',
          collectionNumber: '55981',
          actualFeeCny: 1.13,
        },
        amounts: {
          actualCrossBorderBusFeeCny: 1.13,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
        },
      }
    );
    const freshFallback = JSON.parse(JSON.stringify(exact));
    freshFallback.amounts.actualCrossBorderBusFeeCny = {
      value: 0,
      status: 'ready',
      source: 'cross-border-no-forecast',
      reason: '',
      evidence: null,
      updatedAt: '2026-08-11T11:30:19.000Z',
    };

    const [merged] = mergeProfitLedgerRows([exact], [freshFallback]);

    expect(merged.amounts.actualCrossBorderBusFeeCny.value).toBe(1.13);
    expect(merged.amounts.actualCrossBorderBusFeeCny.source).toBe('cross-border-bus-ledger-cash-converted');
    expect(merged.amounts.actualCrossBorderBusFeeCny.evidence.collectionNumber).toBe('55981');
  });

  it('allows a new exact zero after full reversal to replace an older exact positive charge', () => {
    const current = createProfitLedgerRow(
      { id: 'exact-reversal-order', status: 'cancelled', amountValue: 61, currencyCode: 'CNY' },
      {
        actualFinanceStatus: 'confirmed',
        financeLookupChecked: true,
        actualCrossBorderBusFeeSource: 'cross-border-bus-ledger-cash-converted',
        crossBorderChargeEvidence: {
          source: 'cross-border-bus-ledger-cash-converted',
          collectionNumber: 'old-collection',
          actualFeeCny: 1.13,
        },
        amounts: { actualCrossBorderBusFeeCny: 1.13 },
      }
    );
    const exactZero = JSON.parse(JSON.stringify(current));
    exactZero.amounts.actualCrossBorderBusFeeCny = {
      value: 0,
      status: 'ready',
      source: 'cross-border-bus-ledger-cash-converted',
      reason: '',
      updatedAt: '2026-08-11T12:00:00.000Z',
      evidence: {
        source: 'cross-border-bus-ledger-cash-converted',
        collectionNumber: 'old-collection',
        statementCount: 2,
        ledgerNetCny: 0,
        actualFeeCny: 0,
      },
    };

    const [merged] = mergeProfitLedgerRows([current], [exactZero]);

    expect(merged.amounts.actualCrossBorderBusFeeCny.value).toBe(0);
    expect(merged.amounts.actualCrossBorderBusFeeCny.source).toBe('cross-border-bus-ledger-cash-converted');
    expect(merged.amounts.actualCrossBorderBusFeeCny.evidence.statementCount).toBe(2);
  });

  it('keeps exact charges isolated and stable across split siblings and repeated refreshes', () => {
    const exactRows = Array.from({ length: 5 }, (_, index) => createProfitLedgerRow(
      {
        id: `96606108-0082-${index + 1}`,
        status: 'cancelled',
        amountValue: 61,
        currencyCode: 'CNY',
      },
      {
        orderKey: `shop-a:96606108-0082-${index + 1}`,
        shopId: 'shop-a',
        actualFinanceStatus: 'confirmed',
        financeLookupChecked: true,
        actualCrossBorderBusFeeSource: 'cross-border-bus-ledger-cash-converted',
        crossBorderChargeEvidence: {
          source: 'cross-border-bus-ledger-cash-converted',
          collectionNumber: String(56000 + index),
          actualFeeCny: 1.13,
        },
        amounts: { actualCrossBorderBusFeeCny: 1.13 },
      }
    ));
    const fallbackRows = exactRows.map((row) => ({
      ...JSON.parse(JSON.stringify(row)),
      amounts: {
        ...row.amounts,
        actualCrossBorderBusFeeCny: {
          value: 0,
          status: 'ready',
          source: 'cross-border-no-forecast',
          reason: '',
          evidence: null,
          updatedAt: '2026-08-11T11:30:19.000Z',
        },
      },
    }));

    const firstRefresh = mergeProfitLedgerRows(exactRows, fallbackRows);
    const secondRefresh = mergeProfitLedgerRows(firstRefresh, fallbackRows);

    expect(firstRefresh.map((row) => row.amounts.actualCrossBorderBusFeeCny.value)).toEqual([1.13, 1.13, 1.13, 1.13, 1.13]);
    expect(secondRefresh.map((row) => row.amounts.actualCrossBorderBusFeeCny.value)).toEqual([1.13, 1.13, 1.13, 1.13, 1.13]);
    expect(new Set(secondRefresh.map((row) => row.ledgerKey)).size).toBe(5);
    expect(secondRefresh.every((row) => row.shopId === 'shop-a')).toBe(true);
  });
});
