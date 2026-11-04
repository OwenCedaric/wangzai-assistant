import { describe, expect, it } from 'vitest';
import {
  ORDER_CARD_ACQUIRING_RATE,
  calculateAcquiringFeeCny,
  calculateActualProfitCny,
  calculateCommissionFeeCny,
  calculateCrossBorderBusFeeCny,
  calculateDeliveryServiceFeeCny,
  calculateEstimatedProfitCny,
  calculateGuooFreightCny,
  calculateOrderPreDeductionFeeCny,
  calculateRefundLossCny,
  convertFeeAmountToCny,
  normalizeEstimatedCommissionPercent,
  toFeeNumber,
} from './feeCalculationService.js';

describe('feeCalculationService', () => {
  it('converts RUB and CNY amounts without mixing unknown currencies', () => {
    expect(convertFeeAmountToCny(100, 'RUB', { rubToCnyRate: 0.1 })).toBe(10);
    expect(convertFeeAmountToCny(100, 'RUB')).toBeNull();
    expect(convertFeeAmountToCny(0, 'RUB')).toBe(0);
    expect(convertFeeAmountToCny('12.5', 'CNY')).toBe(12.5);
    expect(convertFeeAmountToCny(100, 'USD')).toBeNull();
  });

  it('returns null when required fee fields are missing', () => {
    expect(toFeeNumber('')).toBeNull();
    expect(calculateEstimatedProfitCny({ orderPaymentCny: 100, sourcePurchaseCostCny: 20 })).toBeNull();
    expect(
      calculateActualProfitCny({
        orderPaymentCny: 100,
        sourcePurchaseCostCny: 20,
        platformRealDeductionTotalCny: null,
        crossBorderBusFeeCny: 8,
      })
    ).toBeNull();
  });

  it('does not treat zero commission as a valid estimated fee rate', () => {
    expect(normalizeEstimatedCommissionPercent(0)).toBeNull();
    expect(normalizeEstimatedCommissionPercent('0%')).toBeNull();
    expect(normalizeEstimatedCommissionPercent('未返回')).toBeNull();
    expect(normalizeEstimatedCommissionPercent('12%')).toBe(12);
  });

  it('keeps purchase order card platform fee pending when real Ozon commission is missing', () => {
    const orderPaymentCny = 27;
    const commissionFeeCny = calculateCommissionFeeCny({
      orderAmountCny: orderPaymentCny,
      commissionPercent: normalizeEstimatedCommissionPercent('0%'),
    });
    const acquiringFeeCny = calculateAcquiringFeeCny({
      orderPaymentCny,
      acquiringRate: ORDER_CARD_ACQUIRING_RATE,
    });
    const deliveryServiceFeeCny = calculateDeliveryServiceFeeCny({ rubToCnyRate: 0.1 });

    expect(commissionFeeCny).toBeNull();
    expect(
      calculateOrderPreDeductionFeeCny({
        commissionFeeCny,
        acquiringFeeCny,
        deliveryServiceFeeCny,
        crossBorderBusFeeCny: 1.23,
      })
    ).toBeNull();
  });

  it('locks purchase order card platform fee formula after real Ozon commission returns', () => {
    const orderPaymentCny = 27;
    const commissionFeeCny = calculateCommissionFeeCny({
      orderAmountCny: orderPaymentCny,
      commissionPercent: normalizeEstimatedCommissionPercent('12%'),
    });
    const acquiringFeeCny = calculateAcquiringFeeCny({
      orderPaymentCny,
      acquiringRate: ORDER_CARD_ACQUIRING_RATE,
    });
    const deliveryServiceFeeCny = calculateDeliveryServiceFeeCny({ rubToCnyRate: 0.1 });

    expect(
      calculateOrderPreDeductionFeeCny({
        commissionFeeCny,
        acquiringFeeCny,
        deliveryServiceFeeCny,
        crossBorderBusFeeCny: 1.23,
      })
    ).toBeCloseTo(6.51, 5);
  });

  it('keeps cross-border bus fee as CNY and never applies RUB exchange rate again', () => {
    expect(
      calculateCrossBorderBusFeeCny({
        labelFeeUnit: 0.5,
        rechargeAmount: 100,
        giftAmount: 0,
        forecastOrderFee: 0.73,
      })
    ).toBeCloseTo(1.23, 5);
  });

  it('converts every Cross-Border Bus balance fee by the recharge gift ratio', () => {
    expect(
      calculateCrossBorderBusFeeCny({
        labelFeeUnit: 1.5,
        rechargeAmount: 300,
        giftAmount: 100,
        forecastOrderFee: 0.1,
      })
    ).toBeCloseTo(1.2, 5);
  });

  it('sums multi-parcel Guoo freight using the same route pricing', () => {
    const result = calculateGuooFreightCny({
      kgFee: 10,
      ticketFee: 2,
      parcels: [
        { weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10 },
        { weightKg: 2, lengthCm: 20, widthCm: 10, heightCm: 10 },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.amount).toBe(34);
    expect(result.parcels).toHaveLength(2);
  });

  it('calculates refund loss from purchase, bus, and deduction amounts', () => {
    expect(
      calculateRefundLossCny({
        sourcePurchaseCostCny: 35,
        crossBorderBusFeeCny: 8,
        orderDeductionFeeCny: 4.5,
      })
    ).toBe(47.5);
  });
});
