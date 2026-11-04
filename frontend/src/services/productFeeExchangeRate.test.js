import { describe, expect, it } from 'vitest';
import {
  applyProductFeeExchangeRateToRows,
  normalizeOzonProductRow,
  setProductFeeRubToCnyRate,
} from '../features/products/lib/productEditing.jsx';

describe('product fee exchange rate rules', () => {
  it('uses the shared RUB/CNY rate for product mileage fee instead of a fixed fallback', () => {
    setProductFeeRubToCnyRate(null);
    const product = {
      product_id: 1001,
      id: 1001,
      offer_id: 'mz-rate-test',
      name: 'rate test product',
      price: 34.06,
      currency_code: 'CNY',
      commissions: { sales_percent_rfbs: 12 },
      acquiring: 0.34,
    };

    const pendingRow = normalizeOzonProductRow(product, product, product, product, product, product, {
      id: 'ozon-shop-1',
    });
    expect(pendingRow.mileageFee).toBe('待确认');
    expect(pendingRow.feeTotal).toBe('待确认');

    const ratedRow = normalizeOzonProductRow(
      product,
      product,
      product,
      product,
      product,
      product,
      { id: 'ozon-shop-1' },
      '',
      new Map(),
      {
        rubToCnyRate: 0.1,
      }
    );

    expect(ratedRow.mileageFeeValue).toBeCloseTo(1.5, 5);
    expect(ratedRow.mileageFee).toBe('¥1.50');
    expect(ratedRow.feeTotalValue).toBeCloseTo(5.9272, 5);
    expect(ratedRow.feeTotal).toBe('¥5.93');
  });

  it('can reprice cached product rows after the exchange rate arrives', () => {
    setProductFeeRubToCnyRate(null);
    const rows = [
      {
        productId: 1002,
        offerId: 'mz-cached-rate-test',
        priceValue: 34.06,
        currencyCode: 'CNY',
        commissionPercent: 12,
        commissionAmountValue: 4.0872,
        acquiringFeeValue: 0.34,
        mileageFee: '待确认',
        feeTotal: '待确认',
      },
    ];

    const [row] = applyProductFeeExchangeRateToRows(rows, 0.1);

    expect(row.mileageFee).toBe('¥1.50');
    expect(row.feeTotal).toBe('¥5.93');
  });

  it('shows explicit Ozon-unavailable status for archived zero sentinels while retaining the positive price', () => {
    const listItem = {
      product_id: 4674301534,
      offer_id: 'mzr-20260520-638834907-9348',
      visibility: 'ARCHIVED',
    };
    const priceInfo = {
      product_id: 4674301534,
      offer_id: 'mzr-20260520-638834907-9348',
      price: {
        marketing_price: 0,
        marketing_seller_price: 0,
        price: 55.16,
        currency_code: 'RUB',
      },
      commissions: {
        sales_percent_fbo: 0,
        sales_percent_fbs: 0,
        sales_percent_rfbs: 0,
        sales_percent_fbp: 0,
      },
      commission_status: 'unavailable',
      commission_provenance: { sourceReason: 'ozon-zero-commission-sentinel' },
      acquiring: 0,
      acquiring_status: 'unavailable',
    };

    const row = normalizeOzonProductRow(
      listItem,
      listItem,
      listItem,
      listItem,
      priceInfo,
      { ...listItem, stocks: [{ present: 0 }] },
      { id: 'ozon-shop-1' }
    );

    expect(row.priceValue).toBe(55.16);
    expect(row.commissionPercent).toBeNull();
    expect(row.commissionStatus).toBe('unavailable');
    expect(row.commissionText).toBe('Ozon 未返回');
    expect(row.commissionProvenance.sourceReason).toBe('ozon-zero-commission-sentinel');
    expect(row.acquiringFeeValue).toBeNull();
    expect(row.acquiringFee).toBe('Ozon 未返回');
    expect(row.stockValue).toBe(0);
  });
});
