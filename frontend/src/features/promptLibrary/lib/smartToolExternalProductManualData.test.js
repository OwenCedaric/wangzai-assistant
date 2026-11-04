import { describe, expect, it } from 'vitest';
import {
  calculateExternalProductUnitProfit,
  normalizeExternalProductManualData,
  validateExternalProductManualInput,
} from './smartToolExternalProductManualData.js';

describe('smartToolExternalProductManualData', () => {
  it('keeps every optional input empty without creating fake zero values', () => {
    expect(normalizeExternalProductManualData({})).toEqual({
      productCostRub: null,
      commissionRate: null,
      fulfillmentFeeRub: null,
      taxRate: null,
      returnCancelRate: null,
    });
    expect(calculateExternalProductUnitProfit(4490, {})).toBeNull();
  });

  it('validates amounts and percentages in plain Chinese', () => {
    expect(validateExternalProductManualInput('商品成本（₽）', '-1')).toBe('不能填写负数。');
    expect(validateExternalProductManualInput('平台佣金率（%）', '101')).toContain('0 到 100');
    expect(validateExternalProductManualInput('税费率（%）', 'abc')).toBe('请填写有效数字。');
    expect(validateExternalProductManualInput('退货取消率（%）', '')).toBe('');
  });

  it('calculates the single-unit base profit from complete manual costs', () => {
    expect(calculateExternalProductUnitProfit(4490, {
      productCostRub: 1800,
      commissionRate: 15,
      fulfillmentFeeRub: 420,
      taxRate: 6,
    })).toMatchObject({
      commissionAmountRub: 673.5,
      taxAmountRub: 269.4,
      estimatedUnitProfitRub: 1327.1,
    });
  });
});

