import { describe, expect, it } from 'vitest';
import { readSplitAppSource } from '../test/appSource';

const appSource = readSplitAppSource();

function getFunctionSource(name) {
  const start = appSource.indexOf(`function ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextFunction = appSource.indexOf('\nfunction ', start + 1);
  return appSource.slice(start, nextFunction > start ? nextFunction : undefined);
}

describe('profit product summary rules', () => {
  it('uses Ozon product acquiring from product price cache before falling back to generic rate', () => {
    const source = getFunctionSource('getProfitProductEstimatedFees');
    expect(source).toContain('const priceInfoAcquiringValue = getOzonAcquiringFee(priceInfo);');
    expect(source.indexOf('getOzonAcquiringFee(priceInfo)')).toBeLessThan(source.indexOf('calculateAcquiringFeeCny({'));
    expect(source).toContain('convertProfitAmountToCny(priceInfoAcquiringValue, currencyCode, options)');
    expect(source).toContain('rubToCnyRate: options.rubToCnyRate');
    expect(source).toContain('ORDER_CARD_ACQUIRING_RATE');
  });
});
