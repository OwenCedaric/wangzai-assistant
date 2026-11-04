import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProfileSetting: vi.fn(),
  saveProfileSetting: vi.fn(),
}));

vi.mock('../api/localApiClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getProfileSetting: mocks.getProfileSetting,
  saveProfileSetting: mocks.saveProfileSetting,
}));
import {
  buildFinanceLookupCheckedIndex,
  buildFinanceOperationIndex,
} from '../entities/profit/profitLedgerMapping.jsx';
import { isProfitLedgerUsableForOrder, normalizeOzonProfitOrder } from '../entities/profit/profitDisplayRules.jsx';
import { getOrderCardPlatformFee } from '../features/orders/purchase/lib/purchaseImageRules.jsx';
import { loadFeePlanState, saveFeePlanState } from '../features/settings/lib/feeSettings.jsx';
import {
  buildOrderExchangeRateBundle,
  getOrderExchangeRateDateKeys,
  getOrderRubToCnyRateForMode,
} from './orderExchangeRateRules.js';

function saveCrossBorderFeeSettings() {
  saveFeePlanState({
    activeId: 'test-cross-border-plan',
    plans: [{
      id: 'test-cross-border-plan',
      name: '测试跨境费用',
      settings: {
        platform: 'crossBorderBus',
        labelFeeUnit: '0.5',
        rechargeAmount: '100',
        giftAmount: '0',
        forecastOrderFee: '0.73',
      },
    }],
  });
}

describe('orderExchangeRateRules', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getProfileSetting.mockResolvedValue({ setting: null });
    mocks.saveProfileSetting.mockImplementation(async (_namespace, value) => ({
      setting: { namespace: 'fee-settings', value },
    }));
    await loadFeePlanState();
  });

  it('keeps a cached estimated order rate instead of replacing it with a later realtime rate', () => {
    const order = {
      paymentDate: '2026-06-22T22:38:14Z',
      estimatedExchangeRate: { mode: 'daily', date: '2026-06-20', rubToCnyRate: 0.0925, source: 'cached-daily' },
    };
    const context = {
      todayKey: '2026-07-04',
      realtime: { mode: 'realtime', rubToCnyRate: 0.0876, source: 'unit-realtime' },
      dailyRates: new Map([['2026-06-22', { mode: 'daily', rubToCnyRate: 0.091, source: 'unit-daily' }]]),
    };

    const bundle = buildOrderExchangeRateBundle(order, context);

    expect(bundle.estimated.rubToCnyRate).toBe(0.0925);
    expect(bundle.estimated.source).toBe('cached-daily');
  });

  it('calculates actual rate from finance operation date without falling back to estimated rate', () => {
    const order = {
      paymentDate: '2026-06-22T22:38:14Z',
      estimatedExchangeRate: { mode: 'daily', date: '2026-06-20', rubToCnyRate: 0.0925, source: 'cached-daily' },
    };
    const financeOperations = [{ operation_date: '2026-06-28T08:00:00Z' }];
    const context = {
      todayKey: '2026-07-04',
      realtime: { mode: 'realtime', rubToCnyRate: 0.0876, source: 'unit-realtime' },
      dailyRates: new Map([['2026-06-28', { mode: 'daily', rubToCnyRate: 0.095, source: 'actual-daily' }]]),
    };

    const bundle = buildOrderExchangeRateBundle(order, context, { financeOperations });

    expect(bundle.estimated.rubToCnyRate).toBe(0.0925);
    expect(bundle.actual.rubToCnyRate).toBe(0.095);
    expect(getOrderRubToCnyRateForMode(order, context, { mode: 'actual' })).toBeNull();
    expect(getOrderExchangeRateDateKeys([order], { financeOperations })).toEqual(['2026-06-22', '2026-06-28']);
  });

  it('recalculates actual rate from newer finance operations instead of reusing an old cached actual rate', () => {
    const order = {
      paymentDate: '2026-06-22T22:38:14Z',
      actualExchangeRate: { mode: 'daily', date: '2026-06-24', rubToCnyRate: 0.091, source: 'old-actual' },
    };
    const financeOperations = [{ operation_date: '2026-06-28T08:00:00Z' }];
    const context = {
      dailyRates: new Map([['2026-06-28', { mode: 'daily', rubToCnyRate: 0.095, source: 'new-actual' }]]),
    };

    const bundle = buildOrderExchangeRateBundle(order, context, { financeOperations });

    expect(bundle.actual.rubToCnyRate).toBe(0.095);
    expect(bundle.actual.source).toBe('new-actual');
  });

  it('lets order card platform fee use estimated rate so the UI does not show pending', () => {
    saveCrossBorderFeeSettings();
    const platformFee = getOrderCardPlatformFee({
      amount: '27.00',
      estimatedExchangeRate: { rubToCnyRate: 0.09254118082546733, source: 'unit-daily' },
      commissionPercent: 12,
      products: [{ salesAmountValue: 27, commissionPercent: 12, qty: 1 }],
    });

    expect(platformFee.display).not.toBe('待确认');
    expect(platformFee.mileageValue).toBeCloseTo(15 * 0.09254118082546733, 5);
  });

  it('rejects stale cached ledgers that still miss the rate-based delivery fee', () => {
    const order = {
      id: '06477778-0475-1',
      amountValue: 27,
      estimatedExchangeRate: { rubToCnyRate: 0.09254118082546733, source: 'unit-daily' },
    };
    const staleLedger = {
      results: { estimatedProfitCny: { status: 'pending', value: null } },
      amounts: {
        estimatedDeliveryServiceFeeCny: { status: 'pending', value: null },
      },
      orderSnapshot: { products: [] },
    };

    expect(isProfitLedgerUsableForOrder(order, staleLedger)).toBe(false);
  });

  it('uses the actual completion rate for actual finance deductions', () => {
    const financeIndex = buildFinanceOperationIndex([
      {
        posting_number: '0209987208-0062-1',
        operation_type: 'OperationAgentDeliveredToCustomer',
        operation_date: '2026-06-28T08:00:00Z',
        amount: 590,
        accruals_for_sale: 590,
      },
      {
        posting_number: '0209987208-0062-1',
        operation_type: 'MarketplaceRedistributionOfAcquiringOperation',
        operation_date: '2026-06-28T08:00:00Z',
        amount: -50,
      },
    ]);

    const order = normalizeOzonProfitOrder(
      {
        id: '0209987208-0062-1',
        posting: '0209987208-0062-1',
        status: 'delivered',
        amountValue: 59,
        currencyCode: 'CNY',
        products: [{ offerId: 'mz-test', qty: 1, salesAmountValue: 59, commissionPercent: 12 }],
      },
      {
        financeIndex,
        financeLookupCheckedIndex: buildFinanceLookupCheckedIndex(['0209987208-0062-1']),
        estimatedExchangeRate: { mode: 'daily', date: '2026-06-22', rubToCnyRate: 0.09, source: 'estimated' },
        actualExchangeRate: { mode: 'daily', date: '2026-06-28', rubToCnyRate: 0.1, source: 'actual' },
        amounts: {
          sourcePurchaseCostCny: 0,
          logisticsFeeCny: 0,
          crossBorderBusFeeCny: 0,
        },
      }
    );

    expect(order.profitLedger.exchangeRates.estimated.rubToCnyRate).toBe(0.09);
    expect(order.profitLedger.exchangeRates.actual.rubToCnyRate).toBe(0.1);
    expect(order.profitLedger.amounts.actualAcquiringFeeCny.value).toBeCloseTo(5, 5);
  });

  it('reads raw Ozon product price and currency_code as CNY sales income', () => {
    const order = normalizeOzonProfitOrder(
      {
        id: 'raw-local-api-order',
        postingNumber: 'raw-local-api-order',
        status: 'delivered',
        products: [{ price: '57.0000', quantity: 1, currency_code: 'CNY', offer_id: 'mz-raw' }],
      },
      {
        estimatedExchangeRate: { mode: 'daily', date: '2026-06-23', rubToCnyRate: 0.09, source: 'estimated' },
        amounts: {
          sourcePurchaseCostCny: 0,
          logisticsFeeCny: 0,
          crossBorderBusFeeCny: 0,
        },
      }
    );

    expect(order.profitLedger.amounts.salesAmountCny.value).toBe(57);
    expect(order.salesAmount).toBe('￥57.00');
  });

  it('uses finance defect cancellation as actual penalty fee with the actual finance rate', () => {
    const financeIndex = buildFinanceOperationIndex([
      {
        operation_id: '54731936284',
        posting_number: '0209987208-0062-1',
        operation_type: 'DefectFineCancellation',
        operation_type_name: 'Превышение индекса ошибок: отмена',
        operation_date: '2026-06-26T00:00:00Z',
        amount: -87.39,
      },
      {
        operation_id: '54572469951',
        posting_number: '0209987208-0062',
        operation_type: 'MarketplaceRedistributionOfAcquiringOperation',
        operation_date: '2026-06-24T00:00:00Z',
        amount: -4.37,
        services: [{ name: 'MarketplaceRedistributionOfAcquiringOperation', price: -4.37 }],
      },
      {
        operation_id: '54652373616',
        posting_number: '0209987208-0062',
        operation_type: 'MarketplaceRedistributionOfAcquiringOperation',
        operation_date: '2026-06-25T00:00:00Z',
        amount: 4.37,
        services: [{ name: 'MarketplaceRedistributionOfAcquiringOperation', price: 4.37 }],
      },
    ]);

    const order = normalizeOzonProfitOrder(
      {
        id: '0209987208-0062-1',
        posting: '0209987208-0062-1',
        salesOrder: '0209987208-0062',
        status: 'cancelled',
        readStatus: '已回查无预报记录',
        amountValue: 59,
        currencyCode: 'CNY',
        products: [{ offerId: 'mz-test', qty: 1, salesAmountValue: 59, commissionPercent: 12 }],
      },
      {
        financeIndex,
        financeLookupCheckedIndex: buildFinanceLookupCheckedIndex(['0209987208-0062-1']),
        estimatedExchangeRate: { mode: 'daily', date: '2026-06-24', rubToCnyRate: 0.09, source: 'estimated' },
        actualExchangeRate: { mode: 'daily', date: '2026-06-26', rubToCnyRate: 0.09, source: 'actual' },
        amounts: {
          sourcePurchaseCostCny: 0,
          logisticsFeeCny: 0,
          crossBorderBusFeeCny: 0,
        },
      }
    );

    expect(order.profitLedger.amounts.actualPenaltyFeeCny.status).toBe('ready');
    expect(order.profitLedger.amounts.actualPenaltyFeeCny.value).toBeCloseTo(7.8651, 5);
    expect(order.profitLedger.amounts.actualAcquiringFeeCny.value).toBe(0);
  });

  it('sets actual bus fee to zero for a cancelled order with checked finance and no cross-border forecast record', () => {
    saveCrossBorderFeeSettings();
    const financeIndex = buildFinanceOperationIndex([
      {
        operation_id: '54731941601',
        posting_number: '0223908490-0032-2',
        operation_type: 'DefectFineCancellation',
        operation_type_name: 'Превышение индекса ошибок: отмена',
        operation_date: '2026-06-26T00:00:00Z',
        amount: -84.42,
      },
    ]);

    const order = normalizeOzonProfitOrder(
      {
        id: '0223908490-0032-2',
        posting: '0223908490-0032-2',
        salesOrder: '0223908490-0032',
        status: 'cancelled',
        substatus: 'posting_canceled',
        readStatus: '已回查无预报记录',
        amountValue: 57,
        currencyCode: 'CNY',
        products: [{ offerId: 'mz-test', qty: 1, salesAmountValue: 57, commissionPercent: 12 }],
      },
      {
        financeIndex,
        financeLookupCheckedIndex: buildFinanceLookupCheckedIndex(['0223908490-0032-2']),
        estimatedExchangeRate: { mode: 'daily', date: '2026-06-23', rubToCnyRate: 0.09, source: 'estimated' },
        actualExchangeRate: { mode: 'daily', date: '2026-06-26', rubToCnyRate: 0.09, source: 'actual' },
        amounts: {
          sourcePurchaseCostCny: 0,
          logisticsFeeCny: 6.03,
        },
      }
    );

    expect(order.profitLedger.amounts.estimatedCrossBorderBusFeeCny.value).toBeCloseTo(1.23, 5);
    expect(order.profitLedger.amounts.actualCrossBorderBusFeeCny.value).toBe(0);
    expect(order.profitLedger.results.actualProfitCny.status).toBe('ready');
    expect(order.profitLedger.results.actualProfitCny.value).toBeCloseTo(-7.5978, 5);
  });
});
