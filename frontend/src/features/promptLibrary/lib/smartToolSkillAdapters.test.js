import { describe, expect, it } from 'vitest';
import { listSmartToolSkillAdapterIds, runSmartToolSkillAdapter } from './smartToolSkillAdapters.js';
import { getSmartToolSkillExecutionState, SMART_TOOL_ADAPTER_STATUS } from './smartToolAdapterRegistry.js';

const baseMeta = {
  skillProfile: {
    sourceName: '测试来源',
    runType: 'local-ai-preview',
    capabilities: ['能力 A'],
    inputs: ['关键词'],
  },
};

describe('smartToolSkillAdapters', () => {
  it('registers runnable adapters for every default skill', () => {
    expect(listSmartToolSkillAdapterIds()).toEqual(
      expect.arrayContaining([
        'ozon-product-search',
        'ozon-product-selection',
        'ozon-ad-analyzer',
        'ozon-product-image-generation',
        'profit-risk-review',
        'linkfox-seerfar-ozon-shop-search',
        'linkfox-seerfar-ozon-product-detail-search',
        'linkfox-seerfar-ozon-category-search',
        'linkfox-seerfar-ozon-product-report-search',
        'linkfox-seerfar-ozon-keyword-mining',
        'linkfox-seerfar-ozon-market-keyword-search',
        'linkfox-seerfar-ozon-keyword-back-search',
      ])
    );
  });

  it('runs Ozon product search with the internal browser-capture rules and no vendor dependency', () => {
    const result = runSmartToolSkillAdapter(
      {
        ...baseMeta,
        id: 'ozon-product-search',
        title: 'Ozon 商品搜索',
        skillProfile: {
          runType: 'browser-capture-readonly',
          capabilities: ['按关键词搜索 Ozon 商品'],
          usageInputs: ['关键词或 SKU'],
        },
      },
      '关键词或 SKU：雨刮器'
    );

    expect(result.status).toBe('browser_data_pending');
    expect(result.statusLabel).toContain('后台搜索');
    expect(result.sections[0].rows.join('\n')).toContain('product-performance');
    expect(result.sections[0].rows.join('\n')).toContain('七个维度');
    expect(result.integrationNeeds).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/LinkFox|Clawec/u);
  });

  it('builds a local image PromptPlan without calling an image model', () => {
    const result = runSmartToolSkillAdapter(
      {
        ...baseMeta,
        id: 'ozon-product-image-generation',
        title: 'Ozon 商品图生成',
      },
      '商品图片或商品 SKU：https://img.example/product.jpg\nSKU 信息：黑色 500ml\n目标场景（可选）：户外露营'
    );

    expect(result.status).toBe('ready');
    expect(result.statusLabel).toContain('PromptPlan');
    expect(result.summary).toContain('没有调用图片模型');
    expect(result.sections.map((section) => section.title)).toEqual(
      expect.arrayContaining(['商品身份锁定', '当前选中图片的逐图 Prompt', '可选图片职责', '负面提示词', '生图前验收'])
    );
    expect(result.sections[1].rows.join('\n')).toContain('3:4');
    expect(result.sections[2].rows.join('\n')).toContain('不固定数量');
  });

  it('runs profit review from order number without asking for fee fields', () => {
    const result = runSmartToolSkillAdapter(
      {
        ...baseMeta,
        id: 'profit-risk-review',
        title: '低利润订单复核',
      },
      '订单号：0123456789-0001'
    );

    expect(result.status).toBe('dedicated_runner_ready');
    expect(result.summary).toContain('0123456789-0001');
    expect(result.missingInputs).toEqual([]);
    expect(result.sections[0].rows.join('\n')).toContain('专用运行器读取真实利润账本');
    expect(JSON.stringify(result)).not.toContain('粗算利润');
  });

  it('routes an installed declarative Skill through the generic runtime', () => {
    const tool = {
      id: 'prompt-custom-local-preview',
      title: '自定义商品整理',
      skillProfile: {
        runType: 'local-ai-preview',
        usageInputs: ['商品关键词'],
        workflowSteps: ['整理输入', '输出结构化预览'],
        outputs: ['商品摘要', '待核对项'],
      },
    };

    expect(getSmartToolSkillExecutionState(tool)).toMatchObject({
      status: SMART_TOOL_ADAPTER_STATUS.READY,
      adapterKey: 'builtin.generic-skill-runtime',
    });
    const result = runSmartToolSkillAdapter(tool, '商品关键词：雨刮器');
    expect(result.status).toBe('generic_runtime_required');
    expect(result.summary).toContain('真实接口和模型调用由异步服务执行');
  });

  it('blocks an installed script Skill until a registered adapter exists', () => {
    const tool = {
      id: 'prompt-custom-script',
      title: '外部查询脚本',
      skillProfile: { runType: 'external-or-script', inputs: ['关键词'] },
    };
    const state = getSmartToolSkillExecutionState(tool);
    expect(state.status).toBe(SMART_TOOL_ADAPTER_STATUS.NEEDS_ADAPTER);
    const result = runSmartToolSkillAdapter(tool, '关键词：雨刮器');
    expect(result.status).toBe(SMART_TOOL_ADAPTER_STATUS.NEEDS_ADAPTER);
    expect(result.summary).toContain('不能直接运行');
  });

  it('routes an unknown declarative read-only Skill to the generic runtime', () => {
    const state = getSmartToolSkillExecutionState({
      id: 'linkfox-unregistered-custom-skill',
      title: '未登记扩展',
      skillProfile: { runType: 'external-readonly' },
    });

    expect(state.status).toBe(SMART_TOOL_ADAPTER_STATUS.READY);
    expect(state.adapterKey).toBe('builtin.generic-skill-runtime');
  });

  it('routes write Skills to the business safety gate instead of generic execution', () => {
    const tool = {
      id: 'prompt-custom-write',
      title: '修改商品脚本',
      skillProfile: { runType: 'guard-required' },
    };
    const result = runSmartToolSkillAdapter(tool, '商品：123');
    expect(result.status).toBe(SMART_TOOL_ADAPTER_STATUS.GUARD_REQUIRED);
    expect(result.integrationNeeds.join('\n')).toContain('preview');
  });
});
