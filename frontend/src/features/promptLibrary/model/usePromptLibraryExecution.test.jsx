import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  runPlan: vi.fn(),
  runGeneration: vi.fn(),
  loadHistory: vi.fn(),
  saveHistory: vi.fn(),
  canUseBrowserData: vi.fn(),
  runBrowserData: vi.fn(),
  canUseExternalData: vi.fn(),
  runExternalData: vi.fn(),
  runExternalInsight: vi.fn(),
  canUsePerformanceAdData: vi.fn(),
  runPerformanceAdData: vi.fn(),
  canUseOperationalWorkflow: vi.fn(),
  requiresOperationalAnalysis: vi.fn(),
  runOperationalWorkflow: vi.fn(),
}));

vi.mock('../services/smartToolDraftService.js', () => ({
  runSmartToolDraft: vi.fn(),
}));

vi.mock('../services/smartToolOzonBrowserDataService.js', () => ({
  canUseSmartToolOzonBrowserData: serviceMocks.canUseBrowserData,
  runSmartToolDraftWithOzonBrowserData: serviceMocks.runBrowserData,
}));

vi.mock('../services/smartToolExternalOzonDataService.js', () => ({
  canUseSmartToolExternalOzonData: serviceMocks.canUseExternalData,
  runSmartToolDraftWithExternalOzonData: serviceMocks.runExternalData,
}));

vi.mock('../services/smartToolExternalOzonInsightService.js', () => ({
  runSmartToolExternalOzonInsight: serviceMocks.runExternalInsight,
}));

vi.mock('../services/smartToolPerformanceAdDataService.js', () => ({
  canUseSmartToolPerformanceAdData: serviceMocks.canUsePerformanceAdData,
  runSmartToolDraftWithPerformanceAdData: serviceMocks.runPerformanceAdData,
}));

vi.mock('../services/smartToolOperationalWorkflowService.js', () => ({
  canUseSmartToolOperationalWorkflow: serviceMocks.canUseOperationalWorkflow,
  requiresSmartToolOperationalAnalysis: serviceMocks.requiresOperationalAnalysis,
  runSmartToolOperationalWorkflow: serviceMocks.runOperationalWorkflow,
}));

vi.mock('../services/smartToolImagePromptPlanService.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runSmartToolImagePromptPlan: serviceMocks.runPlan,
}));

vi.mock('../services/smartToolImageGenerationService.js', async original => ({
  ...(await original()),
  runSmartToolImageGenerationBatch: serviceMocks.runGeneration,
}));

vi.mock('../services/smartToolProductDescriptionService.js', () => ({
  runSmartToolProductDescriptionGeneration: vi.fn(),
}));

vi.mock('../services/smartToolImageHistoryService.js', () => ({
  loadSmartToolImageGenerationHistory: serviceMocks.loadHistory,
  saveSmartToolImageGenerationHistory: serviceMocks.saveHistory,
  normalizeSmartToolImageHistoryEntry: (entry) => entry,
}));

import { usePromptLibraryExecution } from './usePromptLibraryExecution.js';

describe('usePromptLibraryExecution image generation', () => {
  beforeEach(() => {
    serviceMocks.runPlan.mockReset();
    serviceMocks.runGeneration.mockReset();
    serviceMocks.loadHistory.mockReset().mockResolvedValue({});
    serviceMocks.saveHistory.mockReset().mockResolvedValue({});
    serviceMocks.canUseBrowserData.mockReset().mockReturnValue(false);
    serviceMocks.runBrowserData.mockReset();
    serviceMocks.canUseExternalData.mockReset().mockReturnValue(false);
    serviceMocks.runExternalData.mockReset();
    serviceMocks.runExternalInsight.mockReset();
    serviceMocks.canUsePerformanceAdData.mockReset().mockReturnValue(false);
    serviceMocks.runPerformanceAdData.mockReset();
    serviceMocks.canUseOperationalWorkflow.mockReset().mockReturnValue(false);
    serviceMocks.requiresOperationalAnalysis.mockReset().mockReturnValue(false);
    serviceMocks.runOperationalWorkflow.mockReset();
  });

  it('compiles the complete preset position rule locally and sends it straight to the image model', async () => {
    serviceMocks.runPlan.mockResolvedValue({
      version: '1.0',
      items: [{ sourceIndex: 0, purpose: 'SKU 专属主卖点图', prompt: '直接执行的图片提示词' }],
    });
    serviceMocks.runGeneration.mockResolvedValue({
      count: 1,
      successCount: 1,
      failedCount: 0,
      items: [{ sourceIndex: 0, status: 'success', imageUrl: 'data:image/png;base64,aW1hZ2U=' }],
    });

    const selectedPrompt = {
      id: 'ozon-product-image-generation',
      promptConfig: {
        systemPrompt: '完整 Skill 规则',
        safetyRules: ['不得改变商品事实'],
        imagePositionRules: {
          main: [
            {
              sourceIndex: 0,
              purpose: 'SKU 专属主卖点图',
              instructions: '真实汽车使用场景',
              visibleText: '一个简短自然的俄语主标题',
            },
          ],
          detail: [],
        },
      },
    };
    const { result } = renderHook(() =>
      usePromptLibraryExecution(selectedPrompt, {
        shop: { id: 'shop-a', shopAlias: 'Ozon A店' },
      })
    );

    await act(async () => {
      await result.current.onGenerateImage({
        group: 'main',
        count: 1,
        sourceImageIndexes: [0],
        productImageUrls: ['https://img.example/product.jpg'],
        plannerModelSelection: { accountId: 'text-account', model: 'gpt-5.5', ready: true },
        modelSelection: { accountId: 'image-account', model: 'gpt-image-2', ready: true },
      });
    });

    await waitFor(() => expect(serviceMocks.runGeneration).toHaveBeenCalledTimes(1));
    expect(serviceMocks.runPlan).not.toHaveBeenCalled();
    expect(serviceMocks.runGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: 'shop-a',
        group: 'main',
        promptPlan: expect.objectContaining({
          version: 'compiled-skill-1.0',
          items: [
            expect.objectContaining({
              purpose: 'SKU 专属主卖点图',
              prompt: expect.stringMatching(/真实汽车使用场景.*俄语/su),
            }),
          ],
        }),
      }),
      1,
      expect.objectContaining({ onItemSettled: expect.any(Function) })
    );
    await waitFor(() => expect(result.current.imageGeneration?.main?.status).toBe('success'));
    expect(result.current.imagePromptPlan?.main).toBeUndefined();
  });

  it('compiles every selected position without waiting for the remote text planner', async () => {
    serviceMocks.runPlan.mockResolvedValue({
      ok: false,
      partial: true,
      version: '1.0',
      items: [{ sourceIndex: 0, purpose: '已分析位置', prompt: '直接执行的图片提示词' }],
      plannerFallbackCount: 1,
      failedSourceIndexes: [1],
      plannerFailures: [{ sourceImageIndexes: [1], message: '分析模型响应超时' }],
    });
    serviceMocks.runGeneration.mockResolvedValue({
      count: 2,
      successCount: 2,
      failedCount: 0,
      items: [
        { sourceIndex: 0, status: 'success', imageUrl: 'data:image/png;base64,Zmlyc3Q=' },
        { sourceIndex: 1, status: 'success', imageUrl: 'data:image/png;base64,c2Vjb25k' },
      ],
    });

    const selectedPrompt = {
      id: 'ozon-product-image-generation',
      promptConfig: { systemPrompt: '完整 Skill 规则', imagePositionRules: { main: [], detail: [] } },
    };
    const { result } = renderHook(() =>
      usePromptLibraryExecution(selectedPrompt, {
        shop: { id: 'shop-a', shopAlias: 'Ozon A店' },
      })
    );

    await act(async () => {
      await result.current.onGenerateImage({
        group: 'main',
        count: 2,
        sourceImageIndexes: [0, 1],
        productImageUrls: ['https://img.example/0.jpg', 'https://img.example/1.jpg'],
        plannerModelSelection: { accountId: 'text-account', model: 'gpt-5.5', ready: true },
        modelSelection: { accountId: 'image-account', model: 'gpt-image-2', ready: true },
      });
    });

    await waitFor(() => expect(result.current.imageGeneration?.main?.status).toBe('success'));
    expect(serviceMocks.runPlan).not.toHaveBeenCalled();
    expect(serviceMocks.runGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        promptPlan: expect.objectContaining({
          version: 'compiled-skill-1.0',
          items: [expect.objectContaining({ sourceIndex: 0 }), expect.objectContaining({ sourceIndex: 1 })],
        }),
      }),
      2,
      expect.objectContaining({ onItemSettled: expect.any(Function) })
    );
  });

  it('keeps previously generated positions when a later run generates different positions', async () => {
    serviceMocks.runPlan.mockImplementation(async (input) => ({
      version: '1.0',
      items: input.sourceImageIndexes.map((sourceIndex) => ({
        sourceIndex,
        purpose: '位置规则',
        prompt: `执行位置 ${sourceIndex + 1}`,
      })),
    }));
    serviceMocks.runGeneration
      .mockResolvedValueOnce({
        count: 1,
        successCount: 1,
        failedCount: 0,
        items: [{ sourceIndex: 0, status: 'success', imageUrl: 'data:image/png;base64,first' }],
      })
      .mockResolvedValueOnce({
        count: 2,
        successCount: 2,
        failedCount: 0,
        items: [
          { sourceIndex: 1, status: 'success', imageUrl: 'data:image/png;base64,second' },
          { sourceIndex: 2, status: 'success', imageUrl: 'data:image/png;base64,third' },
        ],
      });

    const selectedPrompt = {
      id: 'ozon-product-image-generation',
      promptConfig: { systemPrompt: '规则', imagePositionRules: { main: [], detail: [] } },
    };
    const { result } = renderHook(() =>
      usePromptLibraryExecution(selectedPrompt, {
        shop: { id: 'shop-a', shopAlias: 'Ozon A店' },
      })
    );
    const baseInput = {
      group: 'main',
      plannerModelSelection: { accountId: 'text-account', model: 'gpt-5.5', ready: true },
      modelSelection: { accountId: 'image-account', model: 'gpt-image-2', ready: true },
    };

    await act(async () => {
      await result.current.onGenerateImage({
        ...baseInput,
        count: 1,
        sourceImageIndexes: [0],
        productImageUrls: ['https://img.example/0.jpg'],
      });
    });
    await waitFor(() => expect(result.current.imageGeneration?.main?.result?.items).toHaveLength(1));

    await act(async () => {
      await result.current.onGenerateImage({
        ...baseInput,
        count: 2,
        sourceImageIndexes: [1, 2],
        productImageUrls: ['https://img.example/1.jpg', 'https://img.example/2.jpg'],
      });
    });
    await waitFor(() => expect(result.current.imageGeneration?.main?.result?.items).toHaveLength(3));

    expect(result.current.imageGeneration.main.result.items.map((item) => item.sourceIndex)).toEqual([0, 1, 2]);
    expect(result.current.imageGeneration.main.result.items[0].imageUrl).toContain('first');
  });

  it('loads captured Ozon browser data for a supported Skill and stores the result', async () => {
    serviceMocks.canUseBrowserData.mockReturnValue(true);
    serviceMocks.runBrowserData.mockResolvedValue({
      toolId: 'ozon-product-selection',
      result: {
        status: 'browser_data_ready',
        statusLabel: 'Ozon 商品数据读取完成',
        summary: '已读取真实商品数据',
        productAnalysis: {
          recordCount: 1,
          decision: {
            opportunity: {
              label: '可小批测试',
              recommendation: '先做小批量验证。',
              actions: ['测试首批商品'],
            },
          },
        },
        sections: [],
      },
    });
    const selectedPrompt = {
      id: 'ozon-product-selection',
      title: 'Ozon 选品助手',
      skillProfile: {
        usageInputs: ['商品关键词、SKU 或 Ozon 链接', 'Seerfar 市场复核', '1688 货源链接（可选）'],
      },
    };
    const { result } = renderHook(() => usePromptLibraryExecution(selectedPrompt));

    let request;
    await act(async () => {
      result.current.onChangeValue('商品关键词、SKU 或 Ozon 链接', '遥控汽车');
    });
    await act(async () => {
      request = result.current.onRunDraft();
      expect(result.current.browserDataEnabled).toBe(true);
      await request;
    });

    expect(serviceMocks.runBrowserData).toHaveBeenCalledWith(
      selectedPrompt,
      { '关键词或 SKU': '遥控汽车' },
      expect.objectContaining({
        shopScope: expect.any(Object),
      })
    );
    expect(result.current.draft?.result).toMatchObject({
      status: 'browser_data_ready',
      statusLabel: '选品分析完成',
      viewType: 'product-selection',
    });
  });

  it('runs a configured external data tool without taking the background browser', async () => {
    serviceMocks.canUseExternalData.mockReturnValue(true);
    serviceMocks.runExternalData.mockResolvedValue({
      toolId: 'linkfox-seerfar-ozon-market-keyword-search',
      result: { status: 'ready', statusLabel: '查询完成', sections: [] },
    });
    const selectedPrompt = {
      id: 'linkfox-seerfar-ozon-market-keyword-search',
      title: '市场热词',
      skillProfile: { usageInputs: ['关键词或筛选条件（可多个）'] },
    };
    const { result } = renderHook(() => usePromptLibraryExecution(selectedPrompt));

    await act(async () => {
      await result.current.onRunDraft();
    });

    expect(result.current.externalDataEnabled).toBe(true);
    expect(serviceMocks.runExternalData).toHaveBeenCalledWith(
      selectedPrompt,
      {
        '关键词或筛选条件（可多个）': '',
      },
      expect.objectContaining({ onProgress: expect.any(Function) })
    );
    expect(serviceMocks.runBrowserData).not.toHaveBeenCalled();
    expect(result.current.draft?.result.status).toBe('ready');
  });

  it('广告分析优先走 Performance API，不读取浏览器快照或本地 adapter', async () => {
    serviceMocks.canUsePerformanceAdData.mockReturnValue(true);
    serviceMocks.canUseBrowserData.mockReturnValue(false);
    serviceMocks.runPerformanceAdData.mockResolvedValue({
      toolId: 'ozon-ad-analyzer',
      result: {
        status: 'ready',
        statusLabel: 'Performance API 广告分析完成',
        source: 'ozon-performance-realtime',
        sections: [],
      },
    });
    const selectedPrompt = {
      id: 'ozon-ad-analyzer',
      title: 'Ozon 广告分析',
      skillProfile: { usageInputs: ['广告计划名称或 ID（可选）'] },
    };
    const { result } = renderHook(() => usePromptLibraryExecution(selectedPrompt));

    const modelSelection = {
      id: 'model-option',
      accountId: 'model-account',
      model: 'gpt-5.6-sol',
      ready: true,
    };
    await act(async () => {
      await result.current.onRunDraft(modelSelection);
    });

    expect(result.current.performanceAdEnabled).toBe(true);
    expect(result.current.browserDataEnabled).toBe(true);
    expect(serviceMocks.runPerformanceAdData).toHaveBeenCalledWith(
      selectedPrompt,
      expect.objectContaining({
        '广告计划名称或 ID（可选）': '',
        统计范围: '7',
      }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        modelSelection,
        onStage: expect.any(Function),
      })
    );
    expect(serviceMocks.runBrowserData).not.toHaveBeenCalled();
    expect(serviceMocks.runExternalData).not.toHaveBeenCalled();
    expect(result.current.draft?.result).toMatchObject({
      status: 'ready',
      source: 'ozon-performance-realtime',
    });
  });

  it('读取 Ozon 报表后直接使用所选文本模型生成经营分析', async () => {
    serviceMocks.canUseOperationalWorkflow.mockReturnValue(true);
    serviceMocks.requiresOperationalAnalysis.mockReturnValue(true);
    serviceMocks.runOperationalWorkflow.mockImplementation(async (_tool, _values, options) => {
      options.onStage?.({
        statusLabel: '报表已读取，正在生成经营分析',
        summary: '已读取 206 行真实报表。',
      });
      return {
        toolId: 'ozon-skill-1688-channel-shopdata-get',
        result: {
          status: 'ready',
          statusLabel: 'Ozon 报表读取与分析完成',
          viewType: 'operational-report',
          operationalReportInsight: {
            status: 'ready',
            report: { executiveSummary: '库存周转是当前最优先问题。' },
          },
          sections: [],
        },
      };
    });
    const selectedPrompt = {
      id: 'ozon-skill-1688-channel-shopdata-get',
      title: 'Ozon 报表读取与分析',
      skillProfile: { usageInputs: ['报告内容', '统计范围'] },
    };
    const shop = { id: 'shop-1', name: '测试店铺' };
    const modelSelection = {
      id: 'model-option',
      accountId: 'model-account',
      model: 'gpt-5.6-sol',
      ready: true,
    };
    const { result } = renderHook(() => usePromptLibraryExecution(selectedPrompt, { shop }));

    await act(async () => {
      await result.current.onRunDraft(modelSelection);
    });

    expect(result.current.operationalWorkflowEnabled).toBe(true);
    expect(result.current.operationalAnalysisRequired).toBe(true);
    expect(serviceMocks.runOperationalWorkflow).toHaveBeenCalledWith(
      selectedPrompt,
      { 报告内容: 'all', 统计范围: '30' },
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        modelSelection,
        shopScope: expect.objectContaining({ shopId: 'shop-1' }),
        onStage: expect.any(Function),
      })
    );
    expect(result.current.draft?.result).toMatchObject({
      status: 'ready',
      viewType: 'operational-report',
      operationalReportInsight: {
        status: 'ready',
        report: { executiveSummary: '库存周转是当前最优先问题。' },
      },
    });
  });

  it('generates an external insight report and clears it when query inputs change', async () => {
    serviceMocks.canUseExternalData.mockReturnValue(true);
    serviceMocks.runExternalData.mockResolvedValue({
      toolId: 'linkfox-seerfar-ozon-market-keyword-search',
      createdAt: '07/31 12:00',
      result: {
        status: 'ready',
        statusLabel: '查询完成',
        keywordAnalysis: { kind: 'keywords', records: [{ query: 'платье', searchVolume: 1200 }] },
      },
    });
    let finishInsight;
    serviceMocks.runExternalInsight.mockReturnValue(
      new Promise((resolve) => {
        finishInsight = resolve;
      })
    );
    const label = '关键词或筛选条件（可多个）';
    const selectedPrompt = {
      id: 'linkfox-seerfar-ozon-market-keyword-search',
      title: '市场热词',
      skillProfile: { usageInputs: [label] },
    };
    const { result } = renderHook(() => usePromptLibraryExecution(selectedPrompt));

    await act(async () => {
      await result.current.onRunDraft();
    });
    let insightRequest;
    act(() => {
      insightRequest = result.current.onGenerateExternalInsight({
        id: 'auto',
        accountId: 'account-1',
        model: 'gpt-5.6-sol',
        ready: true,
      });
    });
    expect(result.current.externalInsight).toMatchObject({ status: 'loading', model: 'gpt-5.6-sol' });

    await act(async () => {
      finishInsight({
        status: 'ready',
        model: 'gpt-5.6-sol',
        report: { title: '市场热词分析', executiveSummary: '需求正在增长。' },
      });
      await insightRequest;
    });
    expect(serviceMocks.runExternalInsight).toHaveBeenCalledWith(
      selectedPrompt,
      expect.objectContaining({ result: expect.objectContaining({ status: 'ready' }) }),
      expect.objectContaining({ accountId: 'account-1', model: 'gpt-5.6-sol' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(result.current.externalInsight).toMatchObject({
      status: 'ready',
      report: { title: '市场热词分析' },
    });

    act(() => {
      result.current.onChangeValue(label, '遥控汽车');
    });
    expect(result.current.externalInsight).toBeNull();
  });

  it('shows the backend analysis message instead of reducing it to HTTP 400', async () => {
    serviceMocks.canUseExternalData.mockReturnValue(true);
    serviceMocks.runExternalData.mockResolvedValue({
      toolId: 'linkfox-seerfar-ozon-market-keyword-search',
      createdAt: '07/31 12:10',
      result: {
        status: 'ready',
        keywordAnalysis: { kind: 'keywords', records: [{ query: 'keyboard', searchVolume: 100 }] },
      },
    });
    serviceMocks.runExternalInsight.mockRejectedValue(
      Object.assign(new Error('local-api 请求失败：400'), {
        status: 400,
        payload: { error: { message: '分析内容超过模型上下文限制，请缩小查询范围。' } },
      })
    );
    const selectedPrompt = {
      id: 'linkfox-seerfar-ozon-market-keyword-search',
      title: '市场热词',
      skillProfile: { usageInputs: ['关键词'] },
    };
    const { result } = renderHook(() => usePromptLibraryExecution(selectedPrompt));

    await act(async () => {
      await result.current.onRunDraft();
    });
    await act(async () => {
      await result.current.onGenerateExternalInsight({
        id: 'auto',
        accountId: 'account-1',
        model: 'gpt-5.6-sol',
        ready: true,
      });
    });

    expect(result.current.externalInsight).toMatchObject({
      status: 'error',
      message: '分析内容超过模型上下文限制，请缩小查询范围。',
    });
  });

  it('shows the first external page immediately while the full query continues', async () => {
    serviceMocks.canUseExternalData.mockReturnValue(true);
    let finishRequest;
    serviceMocks.runExternalData.mockImplementation((_tool, _values, options) => {
      queueMicrotask(() => {
        options.onPartialDraft({
          toolId: 'linkfox-seerfar-ozon-market-keyword-search',
          result: {
            status: 'loading',
            statusLabel: '首批数据已返回，正在继续读取',
            summary: '首批 100 条已可查看',
            sections: [{ title: '关键词结果', rows: ['关键词 платье'] }],
          },
        });
      });
      return new Promise((resolve) => {
        finishRequest = resolve;
      });
    });
    const selectedPrompt = {
      id: 'linkfox-seerfar-ozon-market-keyword-search',
      title: '市场热词',
      skillProfile: { usageInputs: ['关键词或筛选条件（可多个）'] },
    };
    const { result } = renderHook(() => usePromptLibraryExecution(selectedPrompt));

    let request;
    act(() => {
      request = result.current.onRunDraft();
    });
    await waitFor(() => expect(result.current.draft?.result.sections?.[0]?.rows).toEqual(['关键词 платье']));

    await act(async () => {
      finishRequest({
        toolId: selectedPrompt.id,
        result: { status: 'ready', statusLabel: '查询完成', sections: [] },
      });
      await request;
    });
    expect(result.current.draft?.result.status).toBe('ready');
  });

  it('keeps the visible first page when a later external page fails', async () => {
    serviceMocks.canUseExternalData.mockReturnValue(true);
    serviceMocks.runExternalData.mockImplementation(
      (_tool, _values, options) =>
        new Promise((_resolve, reject) => {
          queueMicrotask(() => {
            options.onPartialDraft({
              toolId: 'linkfox-seerfar-ozon-market-keyword-search',
              result: {
                status: 'loading',
                statusLabel: '首批数据已返回，正在继续读取',
                summary: '首批 100 条已可查看',
                sections: [{ title: '关键词结果', rows: ['关键词 платье'] }],
                viewType: 'market-keywords',
                marketKeywordAnalysis: { records: [{ query: 'платье' }] },
              },
            });
            queueMicrotask(() =>
              reject(
                Object.assign(new Error('local-api 请求失败：429'), {
                  status: 429,
                  payload: { error: { status: 429, message: 'Too Many Requests' } },
                })
              )
            );
          });
        })
    );
    const selectedPrompt = {
      id: 'linkfox-seerfar-ozon-market-keyword-search',
      title: '市场热词',
      skillProfile: { usageInputs: ['关键词或筛选条件（可多个）'] },
    };
    const { result } = renderHook(() => usePromptLibraryExecution(selectedPrompt));

    await act(async () => {
      await result.current.onRunDraft();
    });

    expect(result.current.draft?.result).toMatchObject({
      status: 'partial_ready',
      statusLabel: '已保留已返回数据',
      viewType: 'market-keywords',
      marketKeywordAnalysis: { records: [{ query: 'платье' }] },
    });
    expect(result.current.draft?.result.summary).toContain('Too Many Requests');
  });

  it('shows automatic retry progress without clearing the visible first page', async () => {
    serviceMocks.canUseExternalData.mockReturnValue(true);
    let finishRequest;
    serviceMocks.runExternalData.mockImplementation((_tool, _values, options) => {
      queueMicrotask(() => {
        options.onPartialDraft({
          toolId: 'linkfox-seerfar-ozon-market-keyword-search',
          result: {
            status: 'loading',
            statusLabel: '首批数据已返回，正在继续读取',
            summary: '首批 100 条已可查看',
            sections: [{ title: '关键词结果', rows: ['关键词 платье'] }],
          },
        });
        options.onRetry({
          page: 2,
          retry: 1,
          retryLimit: 2,
          delayMs: 2000,
          reason: 'network',
        });
      });
      return new Promise((resolve) => {
        finishRequest = resolve;
      });
    });
    const selectedPrompt = {
      id: 'linkfox-seerfar-ozon-market-keyword-search',
      title: '市场热词',
      skillProfile: { usageInputs: ['关键词或筛选条件（可多个）'] },
    };
    const { result } = renderHook(() => usePromptLibraryExecution(selectedPrompt));

    let request;
    act(() => {
      request = result.current.onRunDraft();
    });
    await waitFor(() =>
      expect(result.current.draft?.result).toMatchObject({
        status: 'loading',
        statusLabel: '连接波动，正在自动重试',
        sections: [{ rows: ['关键词 платье'] }],
      })
    );
    expect(result.current.draft?.result.summary).toContain('第 2 页网络连接波动');
    expect(result.current.draft?.result.summary).toContain('（1/2）');

    await act(async () => {
      finishRequest({
        toolId: selectedPrompt.id,
        result: { status: 'ready', statusLabel: '查询完成', sections: [] },
      });
      await request;
    });
    expect(result.current.draft?.result.status).toBe('ready');
  });

  it('cancels the stale paid query when the user changes its input', async () => {
    serviceMocks.canUseExternalData.mockReturnValue(true);
    let firstSignal;
    serviceMocks.runExternalData
      .mockImplementationOnce((_tool, _values, options) => {
        firstSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              const error = new Error('请求已取消');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        });
      })
      .mockResolvedValueOnce({
        toolId: 'linkfox-seerfar-ozon-market-keyword-search',
        result: { status: 'ready', statusLabel: '查询完成', sections: [] },
      });
    const label = '关键词或筛选条件（可多个）';
    const selectedPrompt = {
      id: 'linkfox-seerfar-ozon-market-keyword-search',
      title: '市场热词',
      skillProfile: { usageInputs: [label] },
    };
    const { result } = renderHook(() => usePromptLibraryExecution(selectedPrompt));

    act(() => {
      result.current.onRunDraft();
    });
    act(() => {
      result.current.onChangeValue(label, '连衣裙');
    });
    expect(firstSignal.aborted).toBe(true);
    expect(result.current.draft).toBeNull();

    await act(async () => {
      await result.current.onRunDraft();
    });
    expect(serviceMocks.runExternalData).toHaveBeenCalledTimes(2);
    expect(result.current.draft?.result.status).toBe('ready');
  });

  it('reuses an in-flight paid query instead of sending the same tool twice', async () => {
    serviceMocks.canUseExternalData.mockReturnValue(true);
    let finishRequest;
    serviceMocks.runExternalData.mockReturnValue(
      new Promise((resolve) => {
        finishRequest = resolve;
      })
    );
    const selectedPrompt = {
      id: 'linkfox-seerfar-ozon-market-keyword-search',
      title: '市场热词',
      skillProfile: { usageInputs: ['关键词或筛选条件（可多个）'] },
    };
    const { result } = renderHook(() => usePromptLibraryExecution(selectedPrompt));

    let firstRun;
    let secondRun;
    act(() => {
      firstRun = result.current.onRunDraft();
      secondRun = result.current.onRunDraft();
    });

    expect(secondRun).toBe(firstRun);
    expect(serviceMocks.runExternalData).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishRequest({
        toolId: selectedPrompt.id,
        result: { status: 'ready', statusLabel: '查询完成', sections: [] },
      });
      await firstRun;
    });
    expect(result.current.draft?.result.status).toBe('ready');
  });

  it('shows the real external API validation message instead of a generic 400', async () => {
    serviceMocks.canUseExternalData.mockReturnValue(true);
    serviceMocks.runExternalData.mockRejectedValue(
      Object.assign(new Error('local-api 请求失败：400'), {
        payload: { error: { message: '店铺 ID 必须是整数。' } },
      })
    );
    const selectedPrompt = {
      id: 'linkfox-seerfar-ozon-shop-search',
      title: '店铺商品',
      skillProfile: { usageInputs: ['店铺 ID 或链接'] },
    };
    const { result } = renderHook(() => usePromptLibraryExecution(selectedPrompt));

    await act(async () => {
      await result.current.onRunDraft();
    });

    expect(result.current.draft?.result).toMatchObject({
      status: 'external_data_error',
      summary: '店铺 ID 必须是整数。',
    });
  });

  it('keeps the last successful product result when a repeated live refresh fails', async () => {
    serviceMocks.canUseBrowserData.mockReturnValue(true);
    serviceMocks.runBrowserData
      .mockResolvedValueOnce({
        toolId: 'ozon-product-search',
        result: {
          status: 'browser_data_ready',
          statusLabel: '已使用浏览器插件真实数据',
          productAnalysis: { recordCount: 692, records: [{ id: 'sku-1' }] },
        },
      })
      .mockResolvedValueOnce({
        toolId: 'ozon-product-search',
        result: {
          status: 'browser_data_error',
          statusLabel: 'Ozon 浏览器数据读取失败',
          summary: 'OZON_DATA_OBSERVER_PROBE_FAILED',
          errorCode: 'OZON_DATA_OBSERVER_PROBE_FAILED',
        },
      });
    const selectedPrompt = {
      id: 'ozon-product-search',
      title: 'Ozon 商品搜索',
      skillProfile: { usageInputs: ['关键词或 SKU'] },
    };
    const { result } = renderHook(() => usePromptLibraryExecution(selectedPrompt));

    await act(async () => {
      await result.current.onRunDraft();
    });
    await act(async () => {
      await result.current.onRunDraft();
    });

    expect(result.current.draft?.result).toMatchObject({
      status: 'browser_data_ready',
      statusLabel: '已保留上次真实数据',
      refreshWarning: 'OZON_DATA_OBSERVER_PROBE_FAILED',
      productAnalysis: { recordCount: 692 },
    });
  });
});
