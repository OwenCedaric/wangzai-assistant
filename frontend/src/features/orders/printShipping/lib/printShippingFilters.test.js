import { describe, expect, it } from 'vitest';
import {
  hasActivePrintShippingFilters,
  normalizePrintShippingFacetOptions,
  normalizePrintShippingFilters,
} from './printShippingFilters.js';

describe('print shipping filters', () => {
  it('keeps only supported filter fields and normalizes text', () => {
    expect(normalizePrintShippingFilters({ warehouse: ' 莫斯科仓 ', unknown: 'ignored' })).toEqual({
      warehouse: '莫斯科仓',
      deliveryMethod: '',
      deadlineScope: '',
      trackingState: '',
      carriageState: '',
    });
  });

  it('detects an active filter and deduplicates facet rows', () => {
    expect(hasActivePrintShippingFilters({ trackingState: 'missing' })).toBe(true);
    expect(hasActivePrintShippingFilters({})).toBe(false);
    expect(normalizePrintShippingFacetOptions([
      { value: '仓库 A', total: 3 },
      { value: '仓库 A', total: 9 },
      { value: '', total: 1 },
      null,
    ])).toEqual([{ value: '仓库 A', total: 3 }]);
  });
});
