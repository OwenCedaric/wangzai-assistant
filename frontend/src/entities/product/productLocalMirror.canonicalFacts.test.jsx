import { describe, expect, it } from 'vitest';

import { getOzonWarehouseStockQuantity } from './productAttributes.jsx';
import {
  applyOzonLocalCommissionSummary,
  applyOzonLocalProductEntity,
  normalizeLocalApiProductRows,
  resolveOzonLocalCommissionSnapshot,
} from './productLocalMirror.jsx';

describe('product SQLite canonical fact adapter', () => {
  it('always prefers the exact rFBS rate over a stale scalar FBS commission', () => {
    const snapshot = resolveOzonLocalCommissionSnapshot(
      {
        commissionRateMode: 'rFBS',
        commissionPercent: 17,
        commissionRateReadAt: '2026-08-15T00:00:00.000Z',
      },
      {
        commissionPercent: 17,
        commissionPercents: { fbo: 17, fbs: 17, rfbs: 12, fbp: 11 },
      }
    );

    expect(snapshot.mode.toLowerCase()).toBe('rfbs');
    expect(snapshot.rate).toBe(12);
  });

  it('fails closed when Ozon did not return an rFBS rate instead of borrowing an FBS scalar', () => {
    const snapshot = resolveOzonLocalCommissionSnapshot(
      {
        commissionRateMode: 'rFBS',
        commissionPercent: '未返回',
        commissionRateReadAt: '2026-08-15T00:00:00.000Z',
      },
      {
        commissionPercent: 17,
        commissionMode: 'FBS',
        commissionPercents: { fbo: 17, fbs: 17, rfbs: null, fbp: 11 },
      }
    );

    expect(snapshot.mode.toLowerCase()).toBe('rfbs');
    expect(snapshot.rate).toBeNull();
  });

  it('uses each SKU rFBS rate for a mixed-rate order instead of applying one scalar to the whole order', () => {
    const summary = applyOzonLocalCommissionSummary(
      { amountValue: 300, currencyCode: 'CNY', commissionMode: 'rFBS' },
      [
        { commissionPercent: 12, salesAmountValue: 100 },
        { commissionPercent: 17, salesAmountValue: 200 },
      ]
    );

    expect(summary.commissionPercent).toBe('多比例');
    expect(summary.commissionAmount).toContain('46.00');
    expect(summary.commissionSource).toBe('商品成交金额');
  });

  it.each([
    ['0120280788-0028-2', 31.44, 12, 3.7728],
    ['49887151-0126-1', 325, 17, 55.25],
    ['49376257-0289-1', 357, 14, 49.98],
    ['0207350261-0094-1', 90, 12, 10.8],
    ['38814751-0061-1', 763, 17, 129.71],
    ['41774072-0017-1', 263, 17, 44.71],
    ['69328135-0098-1', 263, 17, 44.71],
    ['0163292769-0114-2', 459, 13, 59.67],
    ['67185500-0317-1', 1250, 17, 212.5],
    ['64189833-1321-1', 217, 17, 36.89],
  ])('calculates verified rFBS commission for %s', (_postingNumber, salesAmount, rate, expectedCommission) => {
    const product = applyOzonLocalProductEntity(
      {
        amountValue: salesAmount,
        qty: 1,
        commissionRateMode: 'rFBS',
        commissionPercent: 18,
        commissionRateReadAt: '2026-08-15T00:00:00.000Z',
      },
      {
        commissionPercent: 18,
        commissionPercents: { fbo: 18, fbs: 18, rfbs: rate, fbp: 11 },
      }
    );

    expect(product.commissionPercent).toBe(rate);
    expect(product.commissionAmountValue).toBeCloseTo(expectedCommission, 6);
  });

  it('preserves four commission modes, fulfillment evidence and unavailable status', () => {
    const [row] = normalizeLocalApiProductRows(
      [
        {
          factSource: 'normalized-product-facts-v1',
          productId: '604',
          offerId: 'offer-604',
          name: '规范事实商品',
          visibility: 'ARCHIVED',
          statusLabel: '已下架',
          priceValue: 20.5,
          currencyCode: 'CNY',
          stockValue: 0,
          commissionPercent: 12,
          commissionPercents: { fbo: 12, fbs: null, rfbs: null, fbp: null },
          commissionStatuses: {
            fbo: 'returned',
            fbs: 'unavailable',
            rfbs: 'not_returned',
            fbp: 'contract_invalid',
          },
          commissionStatus: 'returned',
          commissionProvenance: { source: 'normalized-product-commission-facts' },
          acquiringFeeValue: null,
          acquiringStatus: 'unavailable',
          facetObservations: { prices: { status: 'returned', responseHash: 'price-hash' } },
          hydrationCoverage: {
            detail: true,
            pictures: true,
            prices: true,
            stocks: true,
            attributes: true,
          },
        },
      ],
      { id: 'shop-604', shopAlias: 'Ozon 604' },
      { label: '已下架', visibility: 'ARCHIVED' }
    );

    expect(row.factSource).toBe('normalized-product-facts-v1');
    expect(row.commissionPercent).toBe(12);
    expect(row.commissionPercents).toEqual({ fbo: 12, fbs: null, rfbs: null, fbp: null });
    expect(row.commissionStatuses).toEqual({
      fbo: 'returned',
      fbs: 'unavailable',
      rfbs: 'not_returned',
      fbp: 'contract_invalid',
    });
    expect(row.commissionFulfillmentType).toBe('FBO');
    expect(row.commissionEvidenceKind).toBe('ozon_direct');
    expect(row.commissionText).toBe('12%');
    expect(row.acquiringFeeValue).toBeNull();
    expect(row.acquiringStatus).toBe('unavailable');
    expect(row.stockValue).toBe(0);
    expect(row.liveHydrated).toBe(true);
  });

  it('renders a proven missing commission as Ozon not returned instead of zero', () => {
    const [row] = normalizeLocalApiProductRows(
      [
        {
          productId: '4674301534',
          offerId: 'mzr-20260520-638834907-9348',
          visibility: 'ARCHIVED',
          statusLabel: '已下架',
          commissionPercent: null,
          commissionPercents: { fbo: null, fbs: null, rfbs: null, fbp: null },
          commissionStatuses: {
            fbo: 'unavailable',
            fbs: 'unavailable',
            rfbs: 'unavailable',
            fbp: 'unavailable',
          },
          commissionStatus: 'unavailable',
        },
      ],
      { id: 'ozon-shop-1', shopAlias: 'Ozon 1店' },
      { label: '已下架', visibility: 'ARCHIVED' }
    );

    expect(row.commissionPercent).toBeNull();
    expect(row.commissionEvidenceKind).toBe('ozon_not_returned');
    expect(row.commissionText).toBe('Ozon 未返回');
    expect(row.commissionFulfillmentType).toBeNull();
  });

  it('keeps the backend all-warehouse total while preserving every warehouse quantity', () => {
    const [row] = normalizeLocalApiProductRows(
      [
        {
          productId: 'warehouse-product-1',
          offerId: 'offer-two-warehouses',
          stockValue: 10,
          stockJson: {
            present: 10,
            stocks: [
              { warehouse_id: 1001, present: 4, type: 'fbo' },
              { warehouse_id: 1002, present: 6, type: 'fbs' },
            ],
          },
          warehouseStocks: [
            { warehouseId: '1001', presentQuantity: 2, reservedQuantity: 1, freeQuantity: 1 },
            { warehouseId: '1002', presentQuantity: 4, reservedQuantity: 0, freeQuantity: 4 },
          ],
          sellerWarehouseStockTotal: 6,
          warehouseStockComplete: true,
          warehouseStockObservation: { status: 'returned', observedAt: '2026-07-17T02:00:00.000Z' },
        },
      ],
      { id: 'shop-warehouse', shopAlias: 'Ozon 多仓店' },
      { label: '全部商品', visibility: 'ALL' }
    );

    expect(row.stock).toBe(10);
    expect(row.stockValue).toBe(10);
    expect(row.stock).not.toBe(6);
    expect(row.stock).not.toBe(16);
    expect(row.warehouseId).toBe('1001');
    expect(row.warehouseIds).toEqual(['1001', '1002']);
    expect(getOzonWarehouseStockQuantity(row.raw.stockInfo, '1001')).toBe(2);
    expect(getOzonWarehouseStockQuantity(row.raw.stockInfo, '1002')).toBe(4);
    expect(row.warehouseStocks).toEqual([
      { warehouseId: '1001', presentQuantity: 2, reservedQuantity: 1, freeQuantity: 1 },
      { warehouseId: '1002', presentQuantity: 4, reservedQuantity: 0, freeQuantity: 4 },
    ]);
    expect(row.sellerWarehouseStockTotal).toBe(6);
    expect(row.warehouseStockComplete).toBe(true);
    expect(row.warehouseStockObservation).toMatchObject({ status: 'returned' });
    expect(row.raw.stockInfo.warehouse_stocks).toEqual(row.warehouseStocks);
    expect(row.raw.stockInfo.warehouseStockComplete).toBe(true);
    expect(row.raw.stockInfo.warehouseStockObservation).toMatchObject({ status: 'returned' });
    expect(row.raw.stockInfo.stocks.stocks).toEqual([
      { warehouse_id: 1001, present: 4, type: 'fbo' },
      { warehouse_id: 1002, present: 6, type: 'fbs' },
    ]);
  });
});
