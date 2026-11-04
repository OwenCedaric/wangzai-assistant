import { beforeEach, describe, expect, it } from 'vitest';
import { hydrateOzonCategoryIndexFromCacheNodes } from '../../data/ozonCategoryIndex.js';
import {
  buildOzonQueryTokens,
  expandOzonQueryValue,
  extractOzonSku,
  normalizeOzonQueryText,
  resolveOzonProductSearchQuery,
  resolveOzonSearchQueryPlanSync,
} from './ozonSearchQueryResolver.js';

describe('ozonSearchQueryResolver', () => {
  beforeEach(() => {
    hydrateOzonCategoryIndexFromCacheNodes([
      { nodeKind: 'category', categoryId: '17028973', title: '儿童用品' },
      { nodeKind: 'category', categoryId: '17028981', parentCategoryId: '17028973', title: '无线电遥控玩具' },
      { nodeKind: 'type', categoryId: '17028981', typeId: '95528', parentCategoryId: '17028981', title: '遥控玩具' },
      { nodeKind: 'category', categoryId: '17027495', title: '服装' },
      { nodeKind: 'category', categoryId: '17027496', parentCategoryId: '17027495', title: '服装' },
      { nodeKind: 'type', categoryId: '17027496', typeId: '93182', parentCategoryId: '17027496', title: '连衣裙' },
      { nodeKind: 'category', categoryId: '15621032', title: '鞋类' },
      { nodeKind: 'category', categoryId: '15621048', parentCategoryId: '15621032', title: '休闲鞋' },
      { nodeKind: 'category', categoryId: '15621049', parentCategoryId: '15621032', title: '运动鞋和工作鞋' },
      { nodeKind: 'type', categoryId: '15621048', typeId: '91248', parentCategoryId: '15621048', title: '运动鞋' },
      { nodeKind: 'category', categoryId: '17027483', title: '电子产品' },
      { nodeKind: 'category', categoryId: '17028000', parentCategoryId: '17027483', title: '保护套' },
      { nodeKind: 'type', categoryId: '17028000', typeId: '97011', parentCategoryId: '17028000', title: '智能手机壳' },
      { nodeKind: 'category', categoryId: '17029000', title: '宠物用品' },
      { nodeKind: 'category', categoryId: '17039636', title: '水冷却器' },
      { nodeKind: 'type', categoryId: '17039636', typeId: '97929', parentCategoryId: '17039636', title: '饮水机' },
    ]);
  });

  it('normalizes mixed punctuation and case without using a network translator', () => {
    expect(normalizeOzonQueryText('  SKU-123， Радио  ')).toBe('sku-123 радио');
  });

  it('expands common Chinese product queries into precise Russian aliases', () => {
    const result = expandOzonQueryValue('黑色遥控汽车');

    expect(result.tokens).toEqual(expect.arrayContaining([
      '黑色遥控汽车',
      'радиоуправляемая машина',
      'машинка на радиоуправлении',
    ]));
    expect(result.tokens).not.toContain('на');
    expect(result.aliases).not.toContain('автомобиль');
  });

  it('keeps SKU and Chinese aliases in one bounded query token set', () => {
    const result = buildOzonQueryTokens({ '关键词或 SKU': '3568698657 遥控汽车' });

    expect(result.tokens).toContain('3568698657');
    expect(result.tokens).toContain('радиоуправляемая');
    expect(result.tokens.length).toBeLessThanOrEqual(40);
  });

  it('chooses the first Russian alias for an actual background product query', () => {
    expect(resolveOzonProductSearchQuery({ '关键词或 SKU': '连衣裙' })).toMatchObject({
      input: '连衣裙',
      query: 'платье',
    });
    expect(resolveOzonProductSearchQuery({ '关键词或 SKU': '3568698657' }).query).toBe('3568698657');
    const remoteCarQuery = resolveOzonProductSearchQuery({ '关键词或 SKU': '遥控汽车' });
    expect(remoteCarQuery.categoryHints)
      .toEqual(expect.arrayContaining(['遥控玩具', '无线电遥控玩具']));
    expect(remoteCarQuery.categoryIds).toEqual(['95528']);
    const dressQuery = resolveOzonProductSearchQuery({ '关键词或 SKU': '连衣裙' });
    expect(dressQuery.aliases).toEqual(['платье', 'платья']);
    expect(dressQuery.categoryHints)
      .toEqual(expect.arrayContaining(['连衣裙', 'платье']));
    expect(dressQuery.categoryIds).toEqual(['93182']);
  });

  it('resolves arbitrary compound Chinese queries through the shared category catalog', () => {
    expect(resolveOzonSearchQueryPlanSync({ 商品线索: '夏季碎花连衣裙' })).toMatchObject({
      query: 'платье',
      categoryIds: ['93182'],
      categoryMatch: { name: '连衣裙', typeId: '93182' },
      matchSource: 'alias+shared-catalog',
    });
    expect(resolveOzonSearchQueryPlanSync({ 商品线索: '白色运动鞋' })).toMatchObject({
      query: 'кроссовки',
      categoryIds: ['91248'],
    });
    expect(resolveOzonSearchQueryPlanSync({ 商品线索: 'iPhone 手机壳' })).toMatchObject({
      query: 'чехол для телефона',
      categoryIds: ['97011'],
    });
  });

  it('extracts SKU from plain input and Ozon product links for SKU query plans', () => {
    expect(extractOzonSku('SKU：3568698657')).toBe('3568698657');
    expect(extractOzonSku('https://www.ozon.ru/product/test-3568698657/')).toBe('3568698657');
    expect(resolveOzonSearchQueryPlanSync(
      { 'Ozon SKU': 'SKU：3568698657' },
      { queryMode: 'sku' },
    ).query).toBe('3568698657');
  });

  it('does not attach an unrelated type id when another term constrains the category', () => {
    expect(resolveOzonSearchQueryPlanSync({ 商品线索: '宠物饮水机' })).toMatchObject({
      query: 'товары для животных',
      categoryIds: [],
      categoryMatch: { nodeKind: 'category', name: '宠物用品' },
    });
  });
});
