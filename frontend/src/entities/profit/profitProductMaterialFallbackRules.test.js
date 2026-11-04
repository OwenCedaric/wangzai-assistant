import { describe, expect, it } from 'vitest';
import {
  applyProfitProductMaterialFallbackToOrder,
  applyProfitProductSummaryMaterialToRows,
  hasCompleteProfitCrossBorderMaterial,
  hasProfitOrderProductMaterialGap,
} from './profitProductMaterialFallbackRules';
import { buildProfitPurchaseOrderForLogistics, getProfitLogisticsEstimateValueCny } from './profitFinanceEvidence.jsx';

describe('profitProductMaterialFallbackRules', () => {
  it('uses Ozon materialCandidates only as profit-page logistics fallback', () => {
    const order = {
      id: 'posting-1',
      products: [
        {
          offerId: 'offer-1',
          materialCandidates: [
            {
              source: 'ozon-initial-read',
              weight: '0.2',
              length: '20',
              width: '20',
              height: '20',
              applyToProduct: true,
            },
          ],
        },
      ],
    };

    const result = applyProfitProductMaterialFallbackToOrder(order);

    expect(result.products[0]).toMatchObject({
      weight: '0.2',
      length: '20',
      width: '20',
      height: '20',
      materialProfile: {
        source: 'ozon-initial-read',
        profitFallback: true,
      },
    });
    expect(order.products[0]).not.toHaveProperty('weight');
  });

  it('keeps cross-border bus package material higher priority than Ozon product fallback', () => {
    const order = {
      id: 'posting-1',
      packageWeight: '0.5 kg',
      packageSize: '30 x 20 x 10 cm',
      products: [
        {
          offerId: 'offer-1',
          materialCandidates: [
            {
              source: 'ozon-initial-read',
              weight: '0.2',
              length: '20',
              width: '20',
              height: '20',
            },
          ],
        },
      ],
    };

    expect(hasCompleteProfitCrossBorderMaterial(order)).toBe(true);
    expect(applyProfitProductMaterialFallbackToOrder(order)).toBe(order);
  });

  it('uses product summary weightKg/depthCm fields when no candidate profile exists', () => {
    const result = applyProfitProductMaterialFallbackToOrder({
      id: 'posting-1',
      products: [
        {
          offerId: 'offer-1',
          weightKg: 0.2,
          depthCm: 20,
          widthCm: 20,
          heightCm: 20,
        },
      ],
    });

    expect(result.products[0]).toMatchObject({
      weight: '0.2',
      length: '20',
      width: '20',
      height: '20',
      materialProfile: {
        source: 'ozon-initial-read',
        profitFallback: true,
      },
    });
  });

  it('merges local-api product summary material fields into profit rows without touching shared product rules', () => {
    const rows = [
      {
        id: 'posting-1',
        products: [{ offerId: 'offer-1' }],
      },
    ];
    const entityMap = new Map([
      [
        'posting-1:0',
        {
          weightKg: 0.2,
          depthCm: 20,
          widthCm: 20,
          heightCm: 20,
          materialCandidates: [{ source: 'ozon-initial-read', weight: '0.2', length: '20', width: '20', height: '20' }],
        },
      ],
    ]);

    const result = applyProfitProductSummaryMaterialToRows(rows, entityMap, (row) => row.id);

    expect(result[0].products[0]).toMatchObject({
      weight: '0.2',
      length: '20',
      width: '20',
      height: '20',
      weightKg: 0.2,
      depthCm: 20,
      widthCm: 20,
      heightCm: 20,
      materialCandidates: [{ source: 'ozon-initial-read' }],
      materialProfile: {
        source: 'ozon-initial-read',
        profitFallback: true,
      },
    });
    expect(rows[0].products[0]).not.toHaveProperty('weightKg');
  });

  it('detects only profit rows that still need product material supplementation', () => {
    expect(
      hasProfitOrderProductMaterialGap({
        id: 'posting-1',
        products: [{ offerId: 'offer-1' }],
      })
    ).toBe(true);
    expect(
      hasProfitOrderProductMaterialGap({
        id: 'posting-1',
        products: [{ offerId: 'offer-1', weight: '0.2', length: '20', width: '20', height: '20' }],
      })
    ).toBe(false);
    expect(
      hasProfitOrderProductMaterialGap({
        id: 'posting-1',
        packageWeight: '0.5 kg',
        packageSize: '30 x 20 x 10 cm',
        products: [{ offerId: 'offer-1' }],
      })
    ).toBe(false);
  });

  it('feeds Ozon fallback material into profit logistics calculation when cross-border material is missing', () => {
    const order = {
      id: '0102329766-0325-1',
      amountValue: 37,
      rubToCnyRate: 0.09428269723940262,
      logistics: '超级轻小件陆空联运',
      products: [
        {
          offerId: 'mz-26051410-231198',
          skuId: '4297775146',
          materialCandidates: [
            {
              source: 'ozon-initial-read',
              weight: '0.2',
              length: '20',
              width: '20',
              height: '20',
              applyToProduct: true,
            },
          ],
        },
      ],
    };

    const purchaseOrder = buildProfitPurchaseOrderForLogistics(order);
    expect(purchaseOrder.products[0]).toMatchObject({
      weight: '0.2',
      length: '20',
      width: '20',
      height: '20',
    });
    expect(getProfitLogisticsEstimateValueCny(order, {})).toBeGreaterThan(0);
  });
});
