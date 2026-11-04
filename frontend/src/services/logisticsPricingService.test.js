import { describe, expect, it } from 'vitest';
import {
  LOGISTICS_PRICING_PROVIDERS,
  LOGISTICS_PRICING_ROUTES,
} from '../shared/config/logisticsPricingPresets.js';
import {
  calculateLogisticsFreight,
} from './logisticsPricingService.js';

const baseParcel = {
  weightKg: 0.1,
  lengthCm: 10,
  widthCm: 10,
  heightCm: 10,
  productValueRub: 100,
};

describe('unified logistics pricing presets', () => {
  it('installs every supplied provider with 133 deduplicated destination routes', () => {
    expect(LOGISTICS_PRICING_PROVIDERS.map((provider) => provider.id)).toEqual([
      'cel', 'guoo', 'zto', 'ural', 'xingyuan',
    ]);
    expect(LOGISTICS_PRICING_ROUTES).toHaveLength(133);
    expect(new Set(LOGISTICS_PRICING_ROUTES.map((route) => route.id)).size).toBe(133);
  });

  it.each([
    ['CEL', 'CEL Standard Extra Small', 'cel', 'cel-ru-standard-extra-small', 7.3],
    ['GUOO', 'GUOO Standard Extra Small', 'guoo', 'guoo-standard-extra-small', 7.3],
    ['ZTO', 'ZTO Standard Extra Small', 'zto', 'zto-ru-standard-extra-small', 7.3],
    ['兴远', 'XY Standard Extra Small', 'xingyuan', 'xingyuan-ru-standard-extra-small', 7.3],
  ])('matches the %s full Ozon route name before fuzzy classification', (_label, routeText, providerId, routeId, amount) => {
    expect(calculateLogisticsFreight({ ...baseParcel, routeText })).toMatchObject({
      ok: true,
      providerId,
      routeId,
      matchedBy: 'exact-alias',
      confidence: 1,
      amount,
    });
  });

  it('matches URAL by the selected provider and product classification', () => {
    expect(calculateLogisticsFreight({
      ...baseParcel,
      weightKg: 0.4,
      providerId: 'ural',
      market: 'RU',
      serviceLevel: 'economy',
    })).toMatchObject({
      ok: true,
      providerId: 'ural',
      routeId: 'ural-ru-economy-extra-small',
      chargeWeight: 0.4,
      amount: 13.52,
    });
  });

  it('uses ZTO Economy Premium Small divisor 24000 and rounds weight to grams', () => {
    const result = calculateLogisticsFreight({
      routeText: 'ZTO Economy Premium Small',
      weightKg: 0.5,
      lengthCm: 40,
      widthCm: 30,
      heightCm: 20,
      productValueRub: 8000,
    });
    expect(result).toMatchObject({
      ok: true,
      routeId: 'zto-ru-economy-premium-small',
      volumeWeight: 1,
      chargeWeight: 1,
      amount: 52.81,
    });
  });

  it.each([
    [
      'GUOO Economy Premium Small',
      'guoo-economy-premium-small',
      { weightKg: 5.37, lengthCm: 50, widthCm: 40, heightCm: 40, productValueRub: 8000 },
    ],
    [
      'GUOO Economy Small',
      'guoo-economy-small',
      { weightKg: 2.1, lengthCm: 103, widthCm: 19, heightCm: 10, productValueRub: 3000 },
    ],
  ])('prices an Ozon-confirmed %s route by actual charge weight even past local selection bounds', (routeText, routeId, parcel) => {
    const result = calculateLogisticsFreight({ routeText, ...parcel });
    expect(result).toMatchObject({
      ok: true,
      routeId,
      matchedBy: 'exact-alias',
      confidence: 1,
      actualWeight: parcel.weightKg,
      routeConfirmed: true,
    });
    expect(result.amount).toBeGreaterThan(0);
  });

  it('keeps preset bounds for local fuzzy route selection', () => {
    const result = calculateLogisticsFreight({
      providerId: 'guoo',
      market: 'RU',
      serviceLevel: 'economy',
      weightKg: 80,
      lengthCm: 200,
      widthCm: 100,
      heightCm: 100,
      productValueRub: 3000,
    });
    expect(result.ok).toBe(false);
  });

  it('uses CEL HK 0.1kg upward billing and only applies volume above 60cm', () => {
    const actualOnly = calculateLogisticsFreight({
      routeText: 'CEL Express HK',
      weightKg: 0.11,
      lengthCm: 20,
      widthCm: 20,
      heightCm: 20,
      productValueRub: 100,
    });
    expect(actualOnly).toMatchObject({ ok: true, chargeWeight: 0.2, amount: 38.2 });

    const volumetric = calculateLogisticsFreight({
      routeText: 'CEL Express HK',
      weightKg: 0.11,
      lengthCm: 21,
      widthCm: 20,
      heightCm: 20,
      productValueRub: 100,
    });
    expect(volumetric).toMatchObject({ ok: true, volumeWeight: 1.4, chargeWeight: 1.4, amount: 153.4 });
  });

  it('uses Xingyuan gram rounding and always rounds the final amount upward to cents', () => {
    expect(calculateLogisticsFreight({
      routeText: 'XY Economy Extra Small',
      weightKg: 0.333,
      lengthCm: 10,
      widthCm: 10,
      heightCm: 10,
      productValueRub: 100,
    })).toMatchObject({
      ok: true,
      chargeWeight: 0.333,
      amount: 12.73,
    });
  });

  it('returns ambiguous candidates instead of silently taking the cheapest service level', () => {
    const result = calculateLogisticsFreight({
      ...baseParcel,
      providerId: 'cel',
      market: 'RU',
    });
    expect(result).toMatchObject({
      ok: false,
      ambiguous: true,
      reason: '匹配到多条物流线路',
    });
    expect(result.candidates.length).toBeGreaterThanOrEqual(3);
  });
});
