import { describe, expect, it } from 'vitest';
import { createProfitLedgerRow } from '../../services/profitLedgerService.js';
import {
  rebuildProfitLedgerForFinalZeroActualSales,
  shouldRebuildProfitLedgerForFinalZeroActualSales,
} from './profitLedgerMapping.jsx';

describe('final-zero finance closure', () => {
  it('closes a cancelled order with an exact penalty and removes a stale bus fee without forecast evidence', () => {
    const penaltyDetails = [
      {
        schemaVersion: 1,
        dedupeKey: 'operation:54085237975',
        status: 'ready',
        operationId: '54085237975',
        postingNumber: '24475374-0093-1',
        orderId: '24475374-0093-1',
        operationType: 'defectfinecancellation',
        amountCny: 3.3451,
        currencyCode: 'CNY',
        source: 'ozon-finance-penalty-detail',
      },
    ];
    const stale = createProfitLedgerRow(
      {
        id: '24475374-0093-1',
        posting: '24475374-0093-1',
        status: 'cancelled',
        substatus: 'posting_canceled',
        readStatus: '已回查无预报记录',
        amountValue: 25,
        currencyCode: 'CNY',
        purchasePriceValue: 0,
        // Simulates the stale row that incorrectly retained the configured bus fee.
        crossBorderOrderId: 'legacy-stale-forecast-id',
      },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        financeLookupChecked: true,
        allowZeroPurchaseCost: true,
        penaltyDetails,
        amounts: {
          actualSalesAmountCny: 0,
          sourcePurchaseCostCny: 0,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 3.3451,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          estimatedCrossBorderBusFeeCny: 1.225,
          actualCrossBorderBusFeeCny: 1.225,
          crossBorderBusFeeCny: 1.225,
        },
      }
    );

    stale.actualFinanceStatus = 'pending';
    stale.hasActualFinance = false;
    stale.financeLookupChecked = false;
    stale.orderSnapshot.crossBorderOrderId = '';
    stale.results.actualProfitCny = {
      ...stale.results.actualProfitCny,
      value: null,
      status: 'pending',
      reason: '缺财务流水扣费',
      missing: ['缺财务流水扣费'],
    };

    expect(shouldRebuildProfitLedgerForFinalZeroActualSales(stale.orderSnapshot, stale)).toBe(true);

    const rebuilt = rebuildProfitLedgerForFinalZeroActualSales(stale.orderSnapshot, stale);

    expect(rebuilt.actualFinanceStatus).toBe('confirmed');
    expect(rebuilt.hasActualFinance).toBe(true);
    expect(rebuilt.financeLookupChecked).toBe(true);
    expect(rebuilt.amounts.actualSalesAmountCny.value).toBe(0);
    expect(rebuilt.amounts.actualPenaltyFeeCny.value).toBeCloseTo(3.3451, 4);
    expect(rebuilt.amounts.actualCrossBorderBusFeeCny.value).toBe(0);
    expect(rebuilt.amounts.actualCrossBorderBusFeeCny.source).toBe('cross-border-no-forecast');
    expect(rebuilt.results.actualProfitCny.status).toBe('ready');
    expect(rebuilt.results.actualProfitCny.value).toBeCloseTo(-3.3451, 4);
  });

  it('keeps a buyer-refunded actual bus fee pending until an exact charge record exists', () => {
    const ledger = createProfitLedgerRow(
      {
        id: '38652143-0161-1',
        posting: '38652143-0161-1',
        salesOrder: '38652143-0161',
        status: 'cancelled',
        substatus: 'posting_canceled',
        afterSalesStatus: '拒收后退款',
        raw: {
          status: 'cancelled',
          substatus: 'posting_canceled',
          cancellation: { cancelled_after_ship: true },
        },
        amountValue: 16,
        currencyCode: 'CNY',
        purchasePriceValue: 0,
      },
      {
        actualFinanceStatus: 'confirmed',
        hasActualFinance: true,
        financeLookupChecked: true,
        amounts: {
          actualSalesAmountCny: 0,
          estimatedCrossBorderBusFeeCny: 1.225,
          crossBorderBusFeeCny: 1.225,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
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
    expect(ledger.orderSnapshot.cancelledAfterShip).toBe(true);
    expect(ledger.results.actualProfitCny.status).toBe('ready');
    expect(ledger.results.actualProfitCny.value).toBe(0);
  });

  it('preserves an authoritative cross-border charge while closing final finance fields', () => {
    const stale = createProfitLedgerRow(
      {
        id: '96606108-0082-1',
        posting: '96606108-0082-1',
        status: 'cancelled',
        substatus: 'posting_canceled',
        amountValue: 61,
        currencyCode: 'CNY',
        purchasePriceValue: 0,
      },
      {
        actualFinanceStatus: 'confirmed',
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
          actualSalesAmountCny: 61,
          sourcePurchaseCostCny: 0,
          actualCommissionFeeCny: 0,
          actualPenaltyFeeCny: 0,
          actualAcquiringFeeCny: 0,
          actualDeliveryServiceFeeCny: 0,
          actualLogisticsFeeCny: 0,
          actualCrossBorderBusFeeCny: 1.13,
        },
      }
    );

    const rebuilt = rebuildProfitLedgerForFinalZeroActualSales(stale.orderSnapshot, stale);

    expect(rebuilt.amounts.actualSalesAmountCny.value).toBe(0);
    expect(rebuilt.amounts.actualCrossBorderBusFeeCny).toMatchObject({
      value: 1.13,
      source: 'cross-border-bus-ledger-cash-converted',
    });
    expect(rebuilt.amounts.actualCrossBorderBusFeeCny.evidence.collectionNumber).toBe('56185');
    expect(rebuilt.results.actualProfitCny.value).toBeCloseTo(-1.13, 5);
  });
});
