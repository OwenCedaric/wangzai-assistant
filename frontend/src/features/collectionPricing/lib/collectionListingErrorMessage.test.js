import { describe, expect, it } from 'vitest';

import { normalizeCollectionListingErrorMessage } from './collectionListingErrorMessage.js';

describe('collection listing Ozon error message', () => {
  it('deduplicates repeated Boolean and picture-limit errors into concise Chinese guidance', () => {
    const message = normalizeCollectionListingErrorMessage(
      'SKU-1: VALUE_MUST_BE_BOOLEAN: Значение должно быть булевым (true/false); '
      + 'SKU-1: pics_PIC_limit_exceeded: Максимальное количество дополнительных фото – 29 штук; '
      + 'SKU-2: VALUE_MUST_BE_BOOLEAN',
    );

    expect(message).toContain('布尔属性');
    expect(message).toContain('1 张主图加 29 张附加图');
    expect(message.match(/布尔属性/gu)).toHaveLength(1);
    expect(message).not.toContain('Значение');
  });

  it('translates the Ozon protobuf Boolean string-type rejection', () => {
    const message = normalizeCollectionListingErrorMessage(
      'Ozon write request failed with HTTP 400. proto: invalid value for string field value: false; Ozon code 3',
    );

    expect(message).toContain('字符串 true/false');
    expect(message).not.toContain('proto:');
  });

  it('explains that an Ozon company block cannot be removed by the desktop software', () => {
    expect(normalizeCollectionListingErrorMessage(
      'Ozon write request failed with HTTP 403. Company is blocked, please contact support; Ozon code 7',
    )).toBe('该 Ozon 店铺的公司状态已被平台限制（Ozon code 7），请联系 Ozon 客服解除；软件无法代为解封。');
  });

  it('translates repeated Ozon merger errors without exposing Russian text', () => {
    const message = normalizeCollectionListingErrorMessage(
      'WZ-1: double_without_merger_offer: Не удалось объединить с другими товарами. '
      + 'Есть товары, у которых вариативные характеристики заполнены также: WZ-2; '
      + 'WZ-2: double_without_merger_offer: Не удалось объединить с другими товарами.',
    );

    expect(message).toContain('变体属性完全相同');
    expect(message.match(/变体属性完全相同/gu)).toHaveLength(1);
    expect(message).not.toContain('Не удалось');
    expect(message).not.toContain('double_without_merger_offer');
  });
});
