import { describe, expect, it } from 'vitest';

import {
  buildCollectionCategoryAttributeRows,
  buildCollectionCategoryTree,
  getCollectionCategoryManagedFieldLabel,
  searchCollectionCategoryOptions,
} from './collectionCategoryTemplate.js';

const options = [
  { descriptionCategoryId: '10', typeId: '100', name: '电脑音响系统', pathText: '电子产品 > 音响和扬声器 > 电脑音响系统' },
  { descriptionCategoryId: '11', typeId: '101', name: '车载音响', pathText: '电子产品 > 音响和扬声器 > 车载音响' },
  { descriptionCategoryId: '12', typeId: '102', name: '电子烟配件', pathText: '吸烟产品和配件 > 电子烟和加热型 > 电子烟配件' },
];

describe('collectionCategoryTemplate', () => {
  it('builds a stable path tree and keeps the exact leaf contract', () => {
    const tree = buildCollectionCategoryTree(options);
    expect(tree.map((node) => node.name)).toEqual(['电子产品', '吸烟产品和配件']);
    const audio = tree[0].children.find((node) => node.name === '音响和扬声器');
    expect(audio.children.map((node) => node.option.typeId)).toEqual(['101', '100']);
  });

  it('searches both category name and full path', () => {
    expect(searchCollectionCategoryOptions(options, '电脑音响')).toHaveLength(1);
    expect(searchCollectionCategoryOptions(options, '吸烟产品').map((item) => item.typeId)).toEqual(['102']);
  });

  it('labels managed fields and dictionary loading state', () => {
    const rows = buildCollectionCategoryAttributeRows({
      definitions: [
        { id: '1', name: '原产国', is_required: true, isDictionary: true },
        { id: '2', name: '车身材料', isDictionary: true },
        { id: '3', name: '低音炮功率', valueType: 'DECIMAL' },
      ],
      optionsByAttributeId: { 2: [{ id: '20', label: '塑料' }] },
      dictionaryLoadedIds: ['1', '2'],
    });
    expect(rows.find((item) => item.id === '1')).toMatchObject({ status: 'managed', statusLabel: '系统填写：中国' });
    expect(rows.find((item) => item.id === '2')).toMatchObject({ status: 'loaded', statusLabel: '已加载', optionCount: 1 });
    expect(rows.find((item) => item.id === '3')).toMatchObject({ status: 'model', typeLabel: '小数' });
    expect(getCollectionCategoryManagedFieldLabel({ id: '85', name: '品牌' })).toBe('系统填写：无品牌');
  });
});
