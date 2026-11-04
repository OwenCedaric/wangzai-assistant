import { describe, expect, it } from 'vitest';
import { buildProductCardDiff, buildProductMaterialCandidates } from './productCardDiff';

describe('productCardDiff', () => {
  it('builds field-level preview changes without touching product list state', () => {
    const diff = buildProductCardDiff(
      {
        name: '旧名称',
        priceValue: 10,
        oldPriceValue: 12,
        stock: 3,
        weight: '0.1',
        length: '10',
        width: '8',
        height: '5',
        images: ['https://img.example/old.jpg'],
      },
      {
        name: '新名称',
        price: '11',
        oldPrice: '12',
        stock: '4',
        weight: '0.2',
        length: '10',
        width: '8',
        height: '5',
        images: ['https://img.example/new.jpg'],
        attributeRows: [{ id: 'color', label: '颜色', value: '红色' }],
        attributeValues: { color: '蓝色' },
      }
    );

    expect(diff.changed).toBe(true);
    expect(diff.summaryLabels).toEqual(['商品资料/图片/属性', '价格', '库存']);
    expect(diff.changes.map((item) => item.label)).toEqual(
      expect.arrayContaining(['商品名称', '产品重量 kg', '价格', '库存', '主图/轮播图', '颜色'])
    );
    expect(diff.changes.find((item) => item.field === 'price').writeLabel).toBe('安全门预览');
    expect(diff.changes.find((item) => item.field === 'attribute:color').policy.endpointKey).toBe('products.import');
  });

  it('sorts material candidates by expected source priority', () => {
    const candidates = buildProductMaterialCandidates(
      {
        weight: '0.1',
        length: '10',
        width: '8',
        height: '5',
        materialCandidates: [
          { source: 'ozon-readback', weight: '0.1', length: '10', width: '8', height: '5' },
          { source: 'cross-border-bus', weight: '0.3', length: '30', width: '28', height: '25' },
          { source: 'supplier-confirmed', weight: '0.2', length: '20', width: '18', height: '15' },
        ],
      },
      {
        materialSource: 'supplier-confirmed',
        weight: '0.25',
        length: '22',
        width: '18',
        height: '15',
      }
    );

    expect(candidates.map((item) => item.source).slice(0, 3)).toEqual([
      'cross-border-bus',
      'supplier-confirmed',
      'ozon-readback',
    ]);
    expect(candidates[0].label).toBe('跨境巴士实测');
  });
});
