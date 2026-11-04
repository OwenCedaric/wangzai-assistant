import { describe, expect, it, vi } from 'vitest';
import {
  createFallbackProductSelectionSourcePlan,
  createProductSelectionSourcePlanRequest,
  parseProductSelectionSourcePlan,
  planProductSelectionSources,
} from './smartToolProductSelectionSourcePlanService.js';

const productAnalysis = {
  topProducts: [
    {
      id: 'rc-1',
      title: 'DASDORRIO Radio Controlled Toy',
      category: 'Kids Products / 遥控玩具',
      sales: 1091,
      revenue: 5945413,
      imageUrl: 'https://ir.ozone.ru/rc-1.jpg',
    },
    {
      id: 'dress-1',
      title: 'Summer Dress',
      category: 'Clothing / Dresses',
      sales: 9000,
      revenue: 9000000,
      imageUrl: 'https://ir.ozone.ru/dress-1.jpg',
    },
  ],
};

describe('smartToolProductSelectionSourcePlanService', () => {
  it('模型未配置时仍保留原始中文商品词和严格匹配组', () => {
    const plan = createFallbackProductSelectionSourcePlan(productAnalysis, '遥控汽车');
    expect(plan.searches[0]).toMatchObject({ query: '遥控汽车' });
    expect(plan.searches[0].matchGroups).toEqual(
      expect.arrayContaining([expect.arrayContaining(['遥控']), expect.arrayContaining(['汽车'])])
    );
  });

  it('把 Ozon 热销商品交给所选模型生成中文采购词', () => {
    const request = createProductSelectionSourcePlanRequest(productAnalysis, '遥控汽车', {
      accountId: 'text-account',
      model: 'gpt-5.6-sol',
      ready: true,
    });
    expect(request).toMatchObject({
      accountId: 'text-account',
      model: 'gpt-5.6-sol',
      templateId: 'product-selection-source-plan.v1',
    });
    expect(request.templateInput.query).toBe('遥控汽车');
    expect(request.templateInput.products).toEqual(
      expect.arrayContaining([expect.objectContaining({ productId: 'rc-1', title: 'DASDORRIO Radio Controlled Toy' })])
    );
    expect(request.templateInput.outputContract).toEqual(
      expect.objectContaining({
        normalizedQuery: '',
        searches: expect.any(Array),
      })
    );
  });

  it('只接受真实 Ozon 商品 ID，并保留用于过滤错误类目的匹配组', () => {
    const plan = parseProductSelectionSourcePlan(
      JSON.stringify({
        normalizedQuery: '遥控汽车',
        searches: [
          {
            productId: 'rc-1',
            titleZh: '儿童遥控汽车玩具',
            query: '儿童遥控越野汽车玩具',
            matchGroups: [
              ['遥控', 'RC'],
              ['汽车', '越野车'],
            ],
            excludedTerms: ['童装', '泳衣'],
          },
          { productId: 'fake-id', query: '无关商品' },
        ],
      }),
      productAnalysis,
      '遥控汽车'
    );
    expect(plan).toMatchObject({
      status: 'ready',
      selectedProductIds: ['rc-1'],
      searches: [
        {
          productId: 'rc-1',
          query: '儿童遥控越野汽车玩具',
        },
      ],
    });
    expect(plan.searches[0].matchGroups).toEqual(
      expect.arrayContaining([expect.arrayContaining(['遥控']), expect.arrayContaining(['汽车'])])
    );
    expect(plan.searches[0].excludedTerms).toEqual(expect.arrayContaining(['童装', '泳衣', '织带']));
  });

  it('模型异常时回退到用户输入词，不中断选品链路', async () => {
    const requestAnalysis = vi.fn().mockRejectedValue(new Error('timeout'));
    const plan = await planProductSelectionSources(
      productAnalysis,
      '遥控汽车',
      {
        accountId: 'text-account',
        model: 'gpt-5.6-sol',
        ready: true,
      },
      { requestAnalysis }
    );
    expect(requestAnalysis).toHaveBeenCalledTimes(1);
    expect(plan).toMatchObject({ status: 'fallback', normalizedQuery: '遥控汽车' });
  });
});
