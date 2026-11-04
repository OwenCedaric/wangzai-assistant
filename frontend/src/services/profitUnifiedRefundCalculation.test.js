import { describe, expect, it, vi } from 'vitest';

vi.mock('../entities/profit/profitFeeRules.jsx', () => ({
  getCrossBorderFixedFeeValue: () => 1.23,
}));
import {
  getProfitDetailRealStatusLabel,
  normalizeOzonProfitOrder,
} from '../entities/profit/profitDisplayRules.jsx';
import { buildAfterSalesRowIndex } from '../entities/profit/profitFinanceEvidence.jsx';
import {
  buildFinanceLookupCheckedIndex,
  buildFinanceOperationIndex,
} from '../entities/profit/profitLedgerMapping.jsx';

const postingNumber = '91092007-0181-1';
const orderNumber = '91092007-0181';
const rubToCnyRate = 0.08855435023245517;

function createOrder() {
  return {
    id: postingNumber,
    orderKey: postingNumber,
    recordKey: `client-a:${postingNumber}`,
    posting: postingNumber,
    postingNumber,
    salesOrder: orderNumber,
    shopId: 'shop-a',
    shopClientId: 'client-a',
    status: 'delivered',
    substatus: 'posting_received',
    amountValue: 24,
    currencyCode: 'CNY',
    products: [
      {
        offerId: 'mzr-20260506-575191965-4884',
        qty: 1,
        salesAmountValue: 24,
        currencyCode: 'CNY',
        commissionPercent: 12,
      },
    ],
  };
}

function createSignedRefundIndex() {
  return buildAfterSalesRowIndex([
    {
      id: '94973757',
      posting: postingNumber,
      postingNumber,
      salesOrder: orderNumber,
      status: '签收后退款',
      type: '签收后退款',
      reason: '配送了错误的商品',
      source: 'rfbs-return',
    },
  ]);
}

function createCompleteFinanceOperations() {
  return [
    {
      operation_id: 'delivered-income',
      posting_number: postingNumber,
      operation_type: 'OperationAgentDeliveredToCustomer',
      operation_date: '2026-07-14T00:00:00Z',
      amount: 222.64,
      accruals_for_sale: 253,
      sale_commission: -30.36,
    },
    {
      operation_id: 'delivery-service',
      posting_number: postingNumber,
      operation_type: 'OperationMarketplaceAgencyFeeAggregator3PLGlobal',
      operation_date: '2026-07-14T00:00:00Z',
      amount: -15,
    },
    {
      operation_id: 'international-logistics',
      posting_number: postingNumber,
      operation_type: 'MarketplaceRedistributionOfDeliveryServicesOperation',
      operation_date: '2026-07-14T00:00:00Z',
      amount: -53.38,
    },
    {
      operation_id: 'buyer-refund',
      posting_number: postingNumber,
      operation_type: 'ClientReturnAgentOperation',
      operation_date: '2026-07-14T00:00:00Z',
      amount: -222.64,
      accruals_for_sale: -253,
      sale_commission: 30.36,
    },
  ];
}

function normalizeRefundOrder(financeOperations, options = {}) {
  return normalizeOzonProfitOrder(createOrder(), {
    financeIndex: buildFinanceOperationIndex(financeOperations),
    financeLookupCheckedIndex: buildFinanceLookupCheckedIndex([postingNumber, orderNumber]),
    afterSalesIndex: options.includeAfterSales === false ? new Map() : createSignedRefundIndex(),
    estimatedExchangeRate: {
      mode: 'daily',
      date: '2026-07-14',
      rubToCnyRate,
      source: 'test-estimated',
    },
    actualExchangeRate: {
      mode: 'daily',
      date: '2026-07-14',
      rubToCnyRate,
      source: 'test-actual',
    },
    purchaseLocalOverrides: {
      [`client-a:${postingNumber}`]: {
        shopId: 'shop-a',
        orderKey: `client-a:${postingNumber}`,
        actualCrossBorderBusFeeCny: 1.23,
        actualCrossBorderBusFeeSource: 'cross-border-bus-ledger-cash-converted',
        crossBorderChargeEvidence: {
          source: 'cross-border-bus-ledger-cash-converted',
          collectionNumber: `refund-${postingNumber}`,
          actualFeeCny: 1.23,
        },
      },
    },
    amounts: {
      estimatedCrossBorderBusFeeCny: 1.23,
      crossBorderBusFeeCny: 1.23,
      actualCrossBorderBusFeeCny: 1.23,
    },
    profitFinanceVersion: 'refund-regression-v1',
    fetchedAt: '2026-07-15T07:18:00.000Z',
  });
}

describe('unified signed-refund profit calculation', () => {
  it('calculates order 91092007-0181-1 as a loss from the complete refund and fee closure', () => {
    const order = normalizeRefundOrder(createCompleteFinanceOperations());
    const ledger = order.profitLedger;

    expect(order.afterSalesStatus).toBe('签收后退款');
    expect(getProfitDetailRealStatusLabel(order)).toBe('签收后退款');
    expect(order.hasAfterSalesRefund).toBe(true);
    expect(ledger.actualFinanceStatus).toBe('confirmed');
    expect(ledger.financeOperationCount).toBe(4);
    expect(ledger.amounts.salesAmountCny.value).toBe(24);
    expect(ledger.amounts.actualSalesAmountCny.value).toBe(0);
    expect(ledger.amounts.actualCommissionFeeCny.value).toBeCloseTo(0, 8);
    expect(ledger.amounts.actualAcquiringFeeCny.value).toBeCloseTo(0, 8);
    expect(ledger.amounts.actualDeliveryServiceFeeCny.value).toBeCloseTo(15 * rubToCnyRate, 8);
    expect(ledger.amounts.actualLogisticsFeeCny.value).toBeCloseTo(53.38 * rubToCnyRate, 8);
    expect(ledger.amounts.actualOzonFeeCny.value).toBeCloseTo(68.38 * rubToCnyRate, 8);
    expect(ledger.amounts.actualCrossBorderBusFeeCny.value).toBe(1.23);
    expect(ledger.results.actualProfitCny.status).toBe('ready');
    expect(ledger.results.actualProfitCny.value).toBeCloseTo(-(68.38 * rubToCnyRate + 1.23), 8);
    expect(order.actualProfitValue).toBeLessThan(0);
    expect(order.type).toBe('loss');
  });

  it('keeps a signed refund pending when only an acquiring row exists', () => {
    const order = normalizeRefundOrder([
      {
        operation_id: 'partial-acquiring-only',
        posting_number: postingNumber,
        operation_type: 'MarketplaceRedistributionOfAcquiringOperation',
        operation_date: '2026-06-01T00:00:00Z',
        amount: -4.73,
      },
    ]);

    expect(order.profitLedger.actualFinanceStatus).toBe('pending');
    expect(order.profitLedger.amounts.actualSalesAmountCny.value).toBe(0);
    expect(order.profitLedger.results.actualProfitCny.status).toBe('pending');
    expect(order.actualProfitValue).toBeNull();
  });

  it('keeps a signed refund pending even when generic acquiring redistribution rows fully cancel out', () => {
    const order = normalizeRefundOrder([
      {
        operation_id: 'balanced-acquiring-charge',
        posting_number: postingNumber,
        operation_type: 'MarketplaceRedistributionOfAcquiringOperation',
        operation_date: '2026-06-01T00:00:00Z',
        amount: -4.73,
      },
      {
        operation_id: 'balanced-acquiring-reversal',
        posting_number: postingNumber,
        operation_type: 'MarketplaceRedistributionOfAcquiringOperation',
        operation_date: '2026-06-02T00:00:00Z',
        amount: 4.73,
      },
    ]);

    expect(order.profitLedger.actualFinanceStatus).toBe('pending');
    expect(order.profitLedger.financeOperationCount).toBe(2);
    expect(order.profitLedger.results.actualProfitCny.status).toBe('pending');
  });

  it('confirms a final canceled order when its acquiring redistribution charge and reversal fully cancel out', () => {
    const canceledOrder = {
      ...createOrder(),
      status: 'cancelled',
      substatus: 'posting_canceled',
    };
    const financeOperations = [
      {
        operation_id: 'final-zero-acquiring-charge',
        posting_number: postingNumber,
        operation_type: 'MarketplaceRedistributionOfAcquiringOperation',
        operation_date: '2026-06-01T00:00:00Z',
        amount: -3.31,
      },
      {
        operation_id: 'final-zero-acquiring-reversal',
        posting_number: postingNumber,
        operation_type: 'MarketplaceRedistributionOfAcquiringOperation',
        operation_date: '2026-06-02T00:00:00Z',
        amount: 3.31,
      },
    ];
    const order = normalizeOzonProfitOrder(canceledOrder, {
      financeIndex: buildFinanceOperationIndex(financeOperations),
      financeLookupCheckedIndex: buildFinanceLookupCheckedIndex([postingNumber, orderNumber]),
      afterSalesIndex: new Map(),
      estimatedExchangeRate: { mode: 'daily', date: '2026-06-02', rubToCnyRate, source: 'test-estimated' },
      actualExchangeRate: { mode: 'daily', date: '2026-06-02', rubToCnyRate, source: 'test-actual' },
      purchaseLocalOverrides: {
        [`client-a:${postingNumber}`]: {
          shopId: 'shop-a',
          orderKey: `client-a:${postingNumber}`,
          actualCrossBorderBusFeeCny: 0,
          actualCrossBorderBusFeeSource: 'cross-border-bus-ledger-cash-converted',
          crossBorderChargeEvidence: {
            source: 'cross-border-bus-ledger-cash-converted',
            collectionNumber: `final-zero-${postingNumber}`,
            actualFeeCny: 0,
          },
        },
      },
      profitFinanceVersion: 'final-zero-balanced-acquiring-v1',
      fetchedAt: '2026-06-03T00:00:00.000Z',
    });

    expect(order.profitLedger.actualFinanceStatus).toBe('confirmed');
    expect(order.profitLedger.financeOperationCount).toBe(2);
    expect(order.profitLedger.amounts.platformNetCny.value).toBe(0);
    expect(order.profitLedger.results.actualProfitCny.status).toBe('ready');
  });

  it('zeros actual income from the finance refund closure even when the after-sales cache is temporarily missing', () => {
    const order = normalizeRefundOrder(createCompleteFinanceOperations(), { includeAfterSales: false });

    expect(order.afterSalesStatus).toBe('');
    expect(order.hasAfterSalesRefund).toBe(false);
    expect(order.hasFinanceRefund).toBe(true);
    expect(order.profitLedger.amounts.actualSalesAmountCny.value).toBe(0);
    expect(order.profitLedger.results.actualProfitCny.value).toBeCloseTo(-(68.38 * rubToCnyRate + 1.23), 8);
  });
});
