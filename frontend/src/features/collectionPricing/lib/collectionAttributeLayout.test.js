import { describe, expect, it } from 'vitest';

import {
  collectionAttributeLayoutGroup,
  collectionAttributeLayoutSpan,
  groupCollectionAttributeDefinitions,
} from './collectionAttributeLayout.js';

describe('collectionAttributeLayout', () => {
  it('puts related Ozon eyewear fields into stable semantic groups', () => {
    const definitions = [
      { id: '85', name: 'Бренд' },
      { id: '5287', name: 'Материал оправы' },
      { id: '8016', name: 'Ширина линзы, мм', valueType: 'Integer' },
      { id: '4386', name: 'Упаковка' },
      { id: '23536', name: 'Нужен код маркировки' },
      { id: '4191', name: 'Аннотация' },
      { id: '21841', name: 'Озон.Видео: ссылка' },
    ];

    expect(definitions.map((item) => collectionAttributeLayoutGroup(item).title)).toEqual([
      '基础与归类',
      '材质、颜色与款式',
      '尺寸与重量',
      '包装与数量',
      '编码、合规与售后',
      '文案与展示',
      '视频与文件',
    ]);
    expect(groupCollectionAttributeDefinitions(definitions).map((group) => group.title)).toEqual([
      '基础与归类',
      '材质、颜色与款式',
      '尺寸与重量',
      '包装与数量',
      '编码、合规与售后',
      '文案与展示',
      '视频与文件',
    ]);
  });

  it('uses a strict two-column rhythm and reserves full rows for long fields', () => {
    expect(collectionAttributeLayoutSpan({ name: 'Вес товара, г', valueType: 'Decimal' })).toBe('standard');
    expect(collectionAttributeLayoutSpan({ name: 'Материал оправы' })).toBe('standard');
    expect(collectionAttributeLayoutSpan({ name: 'Название' })).toBe('wide');
    expect(collectionAttributeLayoutSpan({ name: 'Rich-контент JSON' })).toBe('wide');
  });
});
