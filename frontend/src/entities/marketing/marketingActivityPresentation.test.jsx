import { describe, expect, it } from 'vitest';
import {
  getMarketingActivityDisplayDescription,
  getMarketingActivityDisplaySource,
  getMarketingActivityDisplayTitle,
} from './marketingActivityPresentation.jsx';

describe('marketing activity presentation', () => {
  it('renders restored Russian activity metadata as compact Chinese copy', () => {
    const activity = {
      id: '60564',
      title: 'Эластичный бустинг. Без ограничения срока действия',
      originalTitle: 'Эластичный бустинг. Без ограничения срока действия',
      description: 'Очень длинное описание акции из Ozon.',
    };

    expect(getMarketingActivityDisplayTitle(activity)).toBe('弹性提升');
    expect(getMarketingActivityDisplayDescription(activity)).toBe('适合稳定长期促销，优先处理已选择商品。');
    expect(getMarketingActivityDisplaySource({ sourceType: 'seller', source: 'Продавец' })).toBe('商家自主');
  });
});
