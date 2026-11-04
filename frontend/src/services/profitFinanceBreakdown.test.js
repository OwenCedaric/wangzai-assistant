import { describe, expect, it } from 'vitest';
import {
  getFinanceBreakdown,
  getProfitFinanceEvidenceSummary,
  getProfitDetailActualFeeBreakdown,
  getProfitPenaltyDetails,
} from './profitFinanceBreakdown.js';

describe('profitFinanceBreakdown', () => {
  it('nets acquiring charge and reversal before reporting actual fee', () => {
    const operations = [
      {
        operation_type: 'MarketplaceRedistributionOfAcquiringOperation',
        amount: -4.37,
        services: [{ name: 'MarketplaceRedistributionOfAcquiringOperation', price: -4.37 }],
      },
      {
        operation_type: 'MarketplaceRedistributionOfAcquiringOperation',
        amount: 4.37,
        services: [{ name: 'MarketplaceRedistributionOfAcquiringOperation', price: 4.37 }],
      },
    ];

    const summary = getFinanceBreakdown(operations);
    const detail = getProfitDetailActualFeeBreakdown(operations);

    expect(summary.platformNet).toBeCloseTo(0, 5);
    expect(summary.acquiring).toBe(0);
    expect(summary.total).toBe(0);
    expect(detail.acquiring).toBe(0);
  });

  it('recognizes only an exactly balanced acquiring redistribution pair as a final-zero closure', () => {
    const balanced = getProfitFinanceEvidenceSummary([
      { operation_type: 'MarketplaceRedistributionOfAcquiringOperation', amount: -3.31 },
      { operation_type: 'MarketplaceRedistributionOfAcquiringOperation', amount: 3.31 },
    ]);
    const single = getProfitFinanceEvidenceSummary([
      { operation_type: 'MarketplaceRedistributionOfAcquiringOperation', amount: -3.31 },
    ]);
    const unbalanced = getProfitFinanceEvidenceSummary([
      { operation_type: 'MarketplaceRedistributionOfAcquiringOperation', amount: -3.31 },
      { operation_type: 'MarketplaceRedistributionOfAcquiringOperation', amount: 3.3 },
    ]);

    expect(balanced.hasBalancedAcquiringRedistributionClosure).toBe(true);
    expect(single.hasBalancedAcquiringRedistributionClosure).toBe(false);
    expect(unbalanced.hasBalancedAcquiringRedistributionClosure).toBe(false);
    expect(balanced.hasRefundDeductionOperation).toBe(false);
    expect(balanced.hasSignedRefundClosure).toBe(false);
  });

  it('keeps only the unreversed negative remainder as actual expense', () => {
    const operations = [
      {
        operation_type: 'MarketplaceRedistributionOfAcquiringOperation',
        amount: -10,
        services: [{ name: 'MarketplaceRedistributionOfAcquiringOperation', price: -10 }],
      },
      {
        operation_type: 'MarketplaceRedistributionOfAcquiringOperation',
        amount: 4,
        services: [{ name: 'MarketplaceRedistributionOfAcquiringOperation', price: 4 }],
      },
      {
        operation_type: 'MarketplaceRedistributionOfDeliveryServicesOperation',
        amount: -6,
      },
    ];

    const summary = getFinanceBreakdown(operations);
    const detail = getProfitDetailActualFeeBreakdown(operations);

    expect(summary.acquiring).toBe(6);
    expect(summary.delivery).toBe(6);
    expect(summary.logistics).toBe(6);
    expect(summary.total).toBe(12);
    expect(detail.acquiring).toBe(6);
    expect(detail.logistics).toBe(6);
  });

  it('nets sale commission reversals before reporting commission expense', () => {
    const operations = [
      { operation_type: 'SaleCommission', amount: -20, sale_commission: -12 },
      { operation_type: 'SaleCommissionReturn', amount: 8, sale_commission: 5 },
    ];

    const summary = getFinanceBreakdown(operations);
    const detail = getProfitDetailActualFeeBreakdown(operations);

    expect(summary.salesCommission).toBe(7);
    expect(summary.total).toBe(7);
    expect(detail.salesCommission).toBe(7);
  });

  it('reads sale commission from every local-api canonical alias without falling back to zero', () => {
    const operations = [
      { operation_type: 'OperationAgentDeliveredToCustomer', amount: 100, saleCommissionCny: -12 },
      { operation_type: 'OperationAgentDeliveredToCustomer', amount: 40, sale_commission_cny: -5 },
      { operation_type: 'OperationAgentDeliveredToCustomer', amount: 20, raw: { saleCommission: -3 } },
    ];

    const summary = getFinanceBreakdown(operations);
    const detail = getProfitDetailActualFeeBreakdown(operations);

    expect(summary.salesCommission).toBe(20);
    expect(detail.salesCommission).toBe(20);
  });

  it('uses Ozon direct defect cancellation fee as CNY penalty amount', () => {
    const operations = [
      {
        operation_type: 'DefectFineCancellation',
        amount: '-87,10',
        error_fee: '7,97 ¥',
      },
    ];

    const detail = getProfitDetailActualFeeBreakdown(operations);
    const penaltyDetails = getProfitPenaltyDetails(operations);

    expect(detail.penalty).toBe(7.97);
    expect(detail.directPenaltyFeeCny).toBe(7.97);
    expect(penaltyDetails.status).toBe('ready');
    expect(penaltyDetails.totalCny).toBe(7.97);
  });

  it('uses defect cancellation finance transaction amount as RUB penalty money when direct fee is absent', () => {
    const operations = [
      {
        operation_type: 'DefectFineCancellation',
        amount: -87.39,
      },
    ];

    const detail = getProfitDetailActualFeeBreakdown(operations, { rubToCnyRate: 0.09 });
    const penaltyDetails = getProfitPenaltyDetails(operations, { rubToCnyRate: 0.09 });

    expect(detail.penalty).toBeCloseTo(7.8651, 5);
    expect(detail.directPenaltyFeeCny).toBeCloseTo(7.8651, 5);
    expect(penaltyDetails.status).toBe('ready');
    expect(penaltyDetails.totalCny).toBeCloseTo(7.8651, 5);
  });

  it('sums all ready Ozon penalty fee records once by operation id', () => {
    const operations = [
      {
        operation_id: 1001,
        operation_type: 'DefectFineCancellation',
        error_fee: '7.97 CNY',
      },
      {
        operation_id: 1001,
        operation_type: 'DefectFineCancellation',
        error_fee: '7.97 CNY',
      },
      {
        operation_id: 1002,
        operation_type: 'SellerPenalty',
        fine_fee: '3.50 CNY',
      },
    ];

    const penaltyDetails = getProfitPenaltyDetails(operations);
    const detail = getProfitDetailActualFeeBreakdown(operations);

    expect(penaltyDetails.count).toBe(2);
    expect(penaltyDetails.totalCny).toBeCloseTo(11.47, 5);
    expect(detail.penalty).toBeCloseTo(11.47, 5);
  });

  it('keeps explicit CNY penalty fields in CNY even when the operation currency is RUB', () => {
    const operations = [
      {
        operation_id: 1003,
        operation_type: 'DefectFineCancellation',
        currency_code: 'RUB',
        error_fee_cny: 7.97,
      },
    ];

    const penaltyDetails = getProfitPenaltyDetails(operations, { rubToCnyRate: 0.09 });

    expect(penaltyDetails.status).toBe('ready');
    expect(penaltyDetails.totalCny).toBe(7.97);
  });

  it('uses local-api amountTotal as finance operation amount for penalty cache rows', () => {
    const operations = [
      {
        operation_id: '54731936284',
        operation_type: 'DefectFineCancellation',
        operation_type_name: 'Превышение индекса ошибок: отмена',
        amountTotal: -87.39,
      },
    ];

    const penaltyDetails = getProfitPenaltyDetails(operations, { rubToCnyRate: 0.09 });

    expect(penaltyDetails.status).toBe('ready');
    expect(penaltyDetails.totalCny).toBeCloseTo(7.8651, 5);
  });

  it('does not let delivered-to-customer income offset actual logistics deductions', () => {
    const operations = [
      {
        operation_type: 'OperationAgentDeliveredToCustomer',
        operation_type_name: 'Доставка покупателю',
        amount: 345.84,
        sale_commission: -47.16,
      },
      {
        operation_type: 'OperationMarketplaceAgencyFeeAggregator3PLGlobal',
        amount: -15,
      },
      {
        operation_type: 'MarketplaceRedistributionOfDeliveryServicesOperation',
        amount: -68,
      },
    ];

    const summary = getFinanceBreakdown(operations);
    const detail = getProfitDetailActualFeeBreakdown(operations);

    expect(summary.platformNet).toBeCloseTo(262.84, 5);
    expect(summary.salesCommission).toBeCloseTo(47.16, 5);
    expect(summary.deliveryService).toBe(15);
    expect(summary.logistics).toBe(68);
    expect(summary.delivery).toBe(68);
    expect(detail.salesCommission).toBeCloseTo(47.16, 5);
    expect(detail.deliveryService).toBe(15);
    expect(detail.logistics).toBe(68);
  });
});
