import { describe, expect, it } from 'vitest';

import {
  AFTER_SALES_REASON_TRANSLATING_LABEL,
  applyAfterSalesReasonTranslations,
  buildAfterSalesReasonTranslationMessages,
  createAfterSalesReasonTranslationMap,
} from './afterSalesReasonTranslationService.js';

describe('after-sales automatic reason translations', () => {
  it('never exposes an unknown Cyrillic reason while automatic translation is pending', () => {
    const rows = [{ shopId: 'shop-a', reason: 'Заказ утерян при доставке', reasonRaw: 'Заказ утерян при доставке' }];
    expect(buildAfterSalesReasonTranslationMessages(rows)).toEqual([
      {
        id: 'after-sales-reason-1',
        shopId: 'shop-a',
        text: 'Заказ утерян при доставке',
      },
    ]);
    expect(applyAfterSalesReasonTranslations(rows)[0]).toMatchObject({
      reason: AFTER_SALES_REASON_TRANSLATING_LABEL,
      reasonTranslationStatus: 'pending',
    });
  });

  it('fans one dynamic translation out to every matching row without changing the raw evidence', () => {
    const payload = {
      rows: [{
        text: 'Заказ утерян при доставке',
        translatedText: '订单在配送过程中丢失',
        translated: true,
        provider: 'fixture',
      }],
    };
    const rows = [
      { shopId: 'shop-a', reasonRaw: 'Заказ утерян при доставке' },
      { shopId: 'shop-b', reasonRaw: 'Заказ утерян при доставке' },
    ];
    const translated = applyAfterSalesReasonTranslations(rows, createAfterSalesReasonTranslationMap(payload));
    expect(translated.map((row) => row.reason)).toEqual([
      '订单在配送过程中丢失',
      '订单在配送过程中丢失',
    ]);
    expect(translated.every((row) => row.reasonRaw === 'Заказ утерян при доставке')).toBe(true);
  });

  it('does not call the dynamic provider for an already translated deterministic reason', () => {
    expect(buildAfterSalesReasonTranslationMessages([{
      shopId: 'shop-a',
      reason: '买家未取件',
      reasonRaw: 'Покупатель не забрал заказ',
    }])).toEqual([]);
  });
});
