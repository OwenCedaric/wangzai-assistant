import { describe, expect, it } from 'vitest';
import {
  createSmartToolBoundProductValue,
  createSmartToolBoundShopValue,
  hasSmartToolBoundProductInput,
  isSmartToolBoundProductInput,
  isSmartToolBoundShopInput,
} from './smartToolUsageBindings.js';

describe('smartToolUsageBindings', () => {
  it('识别可以直接绑定的店铺和商品输入', () => {
    expect(isSmartToolBoundShopInput('店铺、市场与语言')).toBe(true);
    expect(isSmartToolBoundProductInput('商品、SPU/SKC 与 SKU 信息')).toBe(true);
    expect(
      hasSmartToolBoundProductInput({ skillProfile: { usageInputs: ['处理模式', '商品、SPU/SKC 与 SKU 信息'] } })
    ).toBe(true);
  });

  it('使用内部店铺简称并自动带出市场和语言', () => {
    expect(createSmartToolBoundShopValue({ id: 'shop-2', shopAlias: 'Ozon 2店' })).toBe('Ozon 2店 / 俄罗斯站 / 俄语');
  });

  it('把已选商品和 SKU 生成结构化运行输入', () => {
    expect(
      createSmartToolBoundProductValue(
        { id: 'product-1', title: '保温杯', offerId: 'WZ-1001' },
        { id: 'sku-row-1', sku: '123456', facts: '黑色 · 500ml' }
      )
    ).toBe('商品：保温杯；货号：WZ-1001；商品 ID：product-1；SKU：123456；规格：黑色 · 500ml');
  });
});
