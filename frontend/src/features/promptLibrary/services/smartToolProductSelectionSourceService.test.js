import { describe, expect, it, vi } from 'vitest';
import {
  buildProductSelection1688KeywordSearchUrl,
  encodeProductSelection1688Keyword,
  filterProductSelectionSourceCandidates,
  searchProductSelectionSources,
  selectProductSelectionSourceImage,
} from './smartToolProductSelectionSourceService.js';

describe('smartToolProductSelectionSourceService', () => {
  it('使用 1688 实际需要的 GBK 参数编码中文关键词', () => {
    expect(encodeProductSelection1688Keyword('遥控汽车')).toBe('%D2%A3%BF%D8%C6%FB%B3%B5');
    expect(buildProductSelection1688KeywordSearchUrl('遥控汽车')).toContain('keywords=%D2%A3%BF%D8%C6%FB%B3%B5');
  });

  it('优先使用销售额更高且有公网主图的 Ozon 代表商品', () => {
    const selected = selectProductSelectionSourceImage({
      topProducts: [
        { id: 'low', title: '低销售额', revenue: 100, imageUrl: 'https://img.example/low.jpg' },
        { id: 'high', title: '高销售额', revenue: 900, imageUrl: 'https://img.example/high.jpg' },
      ],
    });
    expect(selected).toEqual(expect.objectContaining({
      productId: 'high',
      title: '高销售额',
      imageUrl: 'https://img.example/high.jpg',
    }));
  });

  it('真实调用现有 1688 以图搜款桥并返回可点击候选链接', async () => {
    const requestBridge = vi.fn().mockResolvedValue({
      searchUrl: 'https://s.1688.com/youyuan/index.htm?imageId=source-image',
      results: [
        {
          offerId: 'offer-1',
          title: '遥控越野车源头货源',
          url: 'https://detail.1688.com/offer/1.html',
          imageUrl: 'https://cbu01.alicdn.com/img/1.jpg',
          price: '¥35.00',
          sales: '成交 200 件',
          shopName: '源头工厂',
        },
      ],
    });

    const sourcePlan = {
      selectedProductIds: ['ozon-1'],
      searches: [{
        query: '遥控越野车',
        titleZh: '遥控越野车',
        productId: 'ozon-1',
        matchGroups: [['遥控'], ['汽车', '越野车']],
        excludedTerms: ['童装'],
      }],
    };
    const result = await searchProductSelectionSources({
      topProducts: [{
        id: 'ozon-1',
        title: '遥控汽车',
        revenue: 1000,
        imageUrl: 'https://ir.ozone.ru/item.jpg',
      }],
    }, '遥控汽车', { requestBridge, sourcePlan });

    expect(requestBridge).toHaveBeenCalledWith('/api/purchase/image-search', expect.objectContaining({
      method: 'POST',
      force: true,
      data: expect.objectContaining({
        platform: '1688',
        imageUrl: 'https://ir.ozone.ru/item.jpg',
      }),
    }));
    expect(result).toMatchObject({
      status: 'ready',
      searchUrl: 'https://s.1688.com/youyuan/index.htm?imageId=source-image',
      candidates: [{
        id: 'offer-1',
        title: '遥控越野车源头货源',
        link: 'https://detail.1688.com/offer/1.html',
      }],
    });
  });

  it('识图被人物背景带偏时剔除童装，只保留符合商品概念的遥控车', () => {
    const candidates = filterProductSelectionSourceCandidates([
      { id: 'clothes', title: '儿童短袖汽车印花童装' },
      { id: 'car', title: '四驱高速遥控越野车儿童玩具汽车' },
      { id: 'belt', title: '彩色织带汽车安全带' },
    ], {
      searches: [{
        query: '儿童遥控越野车',
        matchGroups: [['遥控', 'RC'], ['汽车', '越野车']],
        excludedTerms: ['童装', '织带'],
      }],
    }, '遥控汽车');
    expect(candidates).toEqual([{ id: 'car', title: '四驱高速遥控越野车儿童玩具汽车' }]);
  });

  it('所有识图结果都不相关时不再展示垃圾候选，改用中文关键词搜索', async () => {
    const requestBridge = vi.fn().mockResolvedValue({
      searchUrl: 'https://s.1688.com/youyuan/index.htm?imageId=wrong',
      results: [{ offerId: 'bad-1', title: '儿童短袖汽车印花童装', url: 'https://detail.1688.com/offer/bad-1.html' }],
    });
    const result = await searchProductSelectionSources({
      topProducts: [{ id: 'ozon-1', title: 'Radio Controlled Toy', imageUrl: 'https://ir.ozone.ru/item.jpg' }],
    }, '遥控汽车', {
      requestBridge,
      sourcePlan: {
        selectedProductIds: ['ozon-1'],
        searches: [{
          query: '儿童遥控汽车玩具',
          productId: 'ozon-1',
          matchGroups: [['遥控'], ['汽车', '越野车']],
          excludedTerms: ['童装'],
        }],
      },
    });
    expect(result).toMatchObject({
      status: 'keyword-ready',
      candidates: [],
      rejectedCandidateCount: 1,
      imageSearchUrl: '',
    });
    expect(result.searchUrl).toBe(result.keywordSearchUrl);
    expect(result.keywordSearchUrl).toContain('keywords=');
  });

  it('没有主图时保留真实的 1688 关键词搜索入口', async () => {
    const requestBridge = vi.fn();
    const result = await searchProductSelectionSources({ records: [{ title: '遥控汽车' }] }, '遥控汽车', {
      requestBridge,
    });
    expect(requestBridge).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'keyword-only',
      candidates: [],
      searchUrl: buildProductSelection1688KeywordSearchUrl('遥控汽车'),
    });
  });
});
