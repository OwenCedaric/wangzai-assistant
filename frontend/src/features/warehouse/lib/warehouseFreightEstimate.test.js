import { describe, expect, it } from 'vitest';
import { calculateLogisticsFreight } from '../../../services/logisticsPricingService.js';
import {
  buildWarehouseFreightRouteText,
  completeWarehouseFreightCurrencyDraft,
  normalizeWarehouseFreightProductProfile,
  toWarehouseFreightDraft,
} from './warehouseFreightEstimate.js';

describe('warehouseFreightEstimate', () => {
  it('builds provider and route evidence from the selected Ozon delivery method', () => {
    expect(
      buildWarehouseFreightRouteText({
        name: 'GUOO Standard Extra Small',
        type: 'rFBS / GUOO',
        raw: {
          delivery_method_name: 'GUOO Standard Extra Small',
          tpl_provider_name: 'GUOO',
          delivery_type: 'Standard',
        },
      })
    ).toBe('GUOO Standard Extra Small rFBS / GUOO GUOO Standard');
  });

  it('normalizes Ozon grams, millimetres and RUB price into the unified calculator draft', () => {
    const profile = normalizeWarehouseFreightProductProfile(
      { productId: '101' },
      {
        detail: {
          weight: 450,
          weight_unit: 'g',
          depth: 220,
          width: 140,
          height: 80,
          dimension_unit: 'mm',
          price: '1990',
          currency_code: 'RUB',
        },
        source: 'ozon-live',
      }
    );

    expect(profile).toMatchObject({
      weightKg: 0.45,
      lengthCm: 22,
      widthCm: 14,
      heightCm: 8,
      productValueRub: 1990,
      productValueCny: null,
      source: 'ozon-live',
      complete: true,
    });
    expect(toWarehouseFreightDraft(profile)).toEqual({
      weightKg: '0.45',
      lengthCm: '22',
      widthCm: '14',
      heightCm: '8',
      productValueRub: '1990',
      productValueCny: '',
    });
  });

  it('converts a CNY-only Ozon price to RUB and returns the GUOO amount shown on the page', () => {
    const draft = completeWarehouseFreightCurrencyDraft(
      {
        weightKg: '0.15',
        lengthCm: '35',
        widthCm: '10',
        heightCm: '8',
        productValueRub: '',
        productValueCny: '34.06',
      },
      0.09
    );
    expect(draft.productValueRub).toBe('378.44');

    const result = calculateLogisticsFreight({
      ...draft,
      providerId: 'guoo',
      market: 'RU',
      serviceLevel: 'auto',
      routeText: '标准-超级轻小件-陆空联运到配送点 PUDO 未返回',
    });

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('guoo');
    expect(result.routeId).toBe('guoo-standard-extra-small');
    expect(result.amount).toBeGreaterThan(0);
  });
});
