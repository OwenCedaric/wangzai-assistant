import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { analyzeOzonProductRecords } from '../lib/smartToolOzonProductAnalysis.js';
import { PromptLibraryStandardRun } from './PromptLibraryStandardRun.jsx';

const selectedPrompt = {
  id: 'ozon-product-selection',
  title: 'Ozon 选品助手',
  goal: '读取 Ozon 真实市场数据，判断商品值不值得测试',
  skillProfile: { modelCapability: 'text-generation' },
  promptConfig: { defaultModelId: 'auto' },
};

const usageInputs = ['商品关键词、SKU 或 Ozon 链接', 'Seerfar 市场复核', '1688 货源链接（可选）'];
const values = {
  '商品关键词、SKU 或 Ozon 链接': '遥控汽车',
  'Seerfar 市场复核': 'skip',
  '1688 货源链接（可选）': '',
};
const modelOptions = [
  {
    id: 'auto',
    accountId: 'default-account',
    model: 'gpt-5.5',
    ready: true,
    statusLabel: '默认已配置',
  },
  {
    id: 'second-account::gpt-5.6-sol',
    accountId: 'second-account',
    model: 'gpt-5.6-sol',
    ready: true,
    statusLabel: '已配置',
  },
];

describe('PromptLibraryStandardRun product selection Skill', () => {
  it('要求选择分析模型，并把当前模型交给完整选品链路', () => {
    const onRunDraft = vi.fn();
    render(<PromptLibraryStandardRun
      selectedPrompt={selectedPrompt}
      usageInputs={usageInputs}
      values={values}
      browserDataEnabled
      textModelOptions={modelOptions}
      onRunDraft={onRunDraft}
    />);

    const modelSelect = screen.getByRole('combobox', { name: '分析模型' });
    fireEvent.mouseDown(modelSelect);
    fireEvent.click(screen.getByRole('option', { name: 'Chat-GPT-5.6-Sol · 已配置' }));
    fireEvent.click(screen.getByRole('button', { name: '开始选品分析' }));

    expect(onRunDraft).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'second-account',
      model: 'gpt-5.6-sol',
      ready: true,
    }));
  });

  it('同时展示模型选品报告、Ozon 固定评分、Seerfar 状态和 1688 候选货源', () => {
    const productAnalysis = analyzeOzonProductRecords([{
      id: 'ozon-1',
      title: '遥控汽车竞品',
      price: 1999,
      sales: 320,
      revenue: 639680,
      growth: 12,
      stock: 44,
    }]);
    render(<PromptLibraryStandardRun
      selectedPrompt={selectedPrompt}
      usageInputs={usageInputs}
      values={values}
      browserDataEnabled
      textModelOptions={modelOptions}
      draft={{
        result: {
          status: 'browser_data_ready',
          viewType: 'product-selection',
          productAnalysis,
          productSelectionInsight: {
            status: 'ready',
            model: 'gpt-5.6-sol',
            generatedAt: '2026-08-02T12:00:00.000Z',
            report: {
              title: '遥控汽车选品决策',
              executiveSummary: '当前适合小批测试，不适合直接压货。',
              marketAssessment: '需求存在，但证据覆盖仍有限。',
              keyFindings: [{ title: '销量存在', evidence: '真实样本有销量', action: '验证关键词' }],
              opportunities: [],
              risks: [],
              actionPlan: [{ priority: '高', title: '小批测试', evidence: '固定评分支持测试', action: '首批不超过 20 件' }],
              dataGaps: [],
            },
          },
          sourceProduct: {
            platform: '1688',
            productTitle: '高速遥控汽车货源',
            capturedPrice: 35,
            currency: 'CNY',
            suggestedSalePriceRub: 1999,
            dimensions: '30 × 20 × 12 cm',
            weightKg: 0.8,
            logisticsEstimateStatus: '已取得计费尺寸，等待匹配物流线路价格',
          },
          sourceSearch: {
            status: 'ready',
            statusLabel: '已找到 1 个候选货源',
            message: '候选货源来自当前 Ozon 代表商品的真实以图搜款结果。',
            sourceImage: { title: '遥控汽车竞品' },
            searchUrl: 'https://s.1688.com/youyuan/index.htm?imageId=1',
            imageSearchUrl: 'https://s.1688.com/youyuan/index.htm?imageId=1',
            keywordSearchUrl: 'https://s.1688.com/selloffer/offer_search.htm?keywords=test',
            searches: [{
              query: '儿童遥控汽车玩具',
              url: 'https://s.1688.com/selloffer/offer_search.htm?keywords=test',
            }],
            candidates: [{
              id: 'source-search-1',
              title: '遥控越野车源头货源',
              link: 'https://detail.1688.com/offer/1.html',
              hint: '¥35 · 成交 200 件 · 源头工厂',
            }],
          },
          seerfarReview: {
            status: 'skipped',
            statusLabel: '未使用，不消耗积分',
            summary: '本次只使用 Ozon 内置浏览器真实数据。',
          },
        },
      }}
    />);

    expect(screen.getByRole('heading', { level: 1, name: '遥控汽车选品决策' })).toBeVisible();
    expect(screen.getByText('当前适合小批测试，不适合直接压货。')).toBeVisible();
    expect(screen.getAllByText('1688 候选货源').length).toBeGreaterThan(0);
    expect(screen.getByText('遥控越野车源头货源')).toBeVisible();
    expect(screen.getByRole('button', { name: '儿童遥控汽车玩具' })).toBeVisible();
    expect(screen.getByRole('button', { name: '查看货源' })).toBeVisible();
    expect(screen.getByText('高速遥控汽车货源')).toBeVisible();
    expect(screen.getByText(/Seerfar 市场复核：未使用，不消耗积分/u)).toBeVisible();
    expect(screen.getByText('商品市场分析')).toBeVisible();
  });
});
