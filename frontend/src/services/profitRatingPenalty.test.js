import { describe, expect, it } from 'vitest';
import { createOzonRatingPenaltyOperations, getOzonRatingDirectErrorFee } from './profitRatingPenalty.js';
import { getProfitPenaltyDetails } from './profitFinanceBreakdown.js';

describe('profitRatingPenalty', () => {
  it('uses Ozon rating error fee as direct CNY penalty amount', () => {
    const operations = createOzonRatingPenaltyOperations(
      {
        result: {
          items: [
            {
              posting_number: '0209987208-0062-1',
              error_type: '因卖家的过失而产生的取消',
              index: '87,1%',
              fine_amount: '13.5%',
              error_fee: '7,97 ¥',
            },
          ],
        },
      },
      { postingNumbers: ['0209987208-0062-1'] }
    );

    expect(operations).toHaveLength(1);
    expect(operations[0].error_fee_cny).toBe(7.97);
    expect(getProfitPenaltyDetails(operations).totalCny).toBe(7.97);
  });

  it('uses Ozon rating errors charge_price as the actual penalty fee', () => {
    const operations = createOzonRatingPenaltyOperations(
      {
        errors: [
          {
            posting_number: '0209987208-0062-1',
            product_price: 59,
            product_price_currency_code: 'CNY',
            delivery_schema: 'rFBS',
            posting_error_type: 'SELLER_CANCELLATION',
            index: 0.8709677457809448,
            charge_percent: 13.5,
            charge_price: 7.97,
            charge_price_currency_code: 'CNY',
            error_at: '2026-06-25T02:43:59.172913Z',
          },
        ],
      },
      { postingNumbers: ['0209987208-0062-1'] }
    );

    expect(operations).toHaveLength(1);
    expect(operations[0].operation_type).toBe('OzonRatingIndexErrorFee');
    expect(operations[0].operation_type_name).toBe('SELLER_CANCELLATION');
    expect(operations[0].operation_date).toBe('2026-06-25T02:43:59.172913Z');
    expect(operations[0].error_fee_cny).toBe(7.97);
    expect(getProfitPenaltyDetails(operations).totalCny).toBe(7.97);
  });

  it('does not treat rate or index fields as penalty money', () => {
    const row = {
      posting_number: '0209987208-0062-1',
      error_type: '因卖家的过失而产生的取消',
      index: '87,1%',
      fine_amount: '13.5%',
    };

    expect(getOzonRatingDirectErrorFee(row)).toBeNull();

    const operations = createOzonRatingPenaltyOperations({ items: [row] });
    const penaltyDetails = getProfitPenaltyDetails(operations);

    expect(penaltyDetails.status).toBe('pending');
    expect(penaltyDetails.totalCny).toBeNull();
  });

  it('matches child and base posting numbers for rating rows', () => {
    const operations = createOzonRatingPenaltyOperations(
      {
        items: [
          {
            posting_number: '0178345133-0174',
            error_fee: '3.25 ¥',
          },
        ],
      },
      { postingNumbers: ['0178345133-0174-1'] }
    );

    expect(operations).toHaveLength(1);
    expect(operations[0].posting_number).toBe('0178345133-0174');
    expect(operations[0].error_fee_cny).toBe(3.25);
  });
});
