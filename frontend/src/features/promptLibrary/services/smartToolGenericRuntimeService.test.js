import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCrossBorderOrderRecords: vi.fn(),
  getDomainCache: vi.fn(),
  listIntegrationProfiles: vi.fn(),
  listPerformanceAccounts: vi.fn(),
  readExternalIntegration: vi.fn(),
  readPerformanceOverview: vi.fn(),
  requestLocalApi: vi.fn(),
  requestLocalOzon: vi.fn(),
}));

vi.mock('../../../api/localApiClient.js', () => ({
  getCrossBorderOrderRecords: mocks.getCrossBorderOrderRecords,
  getDomainCache: mocks.getDomainCache,
  listIntegrationProfiles: mocks.listIntegrationProfiles,
  listPerformanceAccounts: mocks.listPerformanceAccounts,
  readExternalIntegration: mocks.readExternalIntegration,
  readPerformanceOverview: mocks.readPerformanceOverview,
  requestLocalApi: mocks.requestLocalApi,
  requestLocalOzon: mocks.requestLocalOzon,
}));

import {
  canUseSmartToolGenericRuntime,
  collectSmartToolGenericRuntimeContext,
  runSmartToolGenericRuntime,
} from './smartToolGenericRuntimeService.js';

const tool = {
  id: 'installed-product-skill',
  title: '通用商品优化 Skill',
  goal: '根据真实商品资料生成内容',
  body: '# Workflow\nRead facts and create content.',
  skillProfile: {
    installType: 'github-skill',
    runType: 'api-assisted-readonly',
    adapterKey: 'builtin.generic-local-preview',
    workflowSteps: ['读取真实商品', '生成内容'],
    outputs: ['商品标题', '待确认项'],
    safetyNotes: ['不得补造商品事实'],
    evidenceRules: ['缺少权威证据时标记待确认'],
    skuImageRules: ['SKU 图片必须与变体一致'],
    qaRules: ['检查俄语文案和图片一致性'],
    stopConditions: ['商品身份冲突时停止'],
    moduleAnalysis: {
      completed: true,
      moduleCount: 2,
      modules: [
        {
          id: 'product-truth-ledger',
          order: 1,
          title: '商品事实核对',
          kind: 'data-analysis',
          description: '读取并冻结真实商品资料。',
          requiredCapabilities: ['ozon.products.read'],
          requiredTools: [],
        },
        {
          id: 'image-generation',
          order: 2,
          title: '图片模型生成',
          kind: 'generation',
          description: '按已确认的位置生成商品图片。',
          requiredCapabilities: ['model.image.generate', 'product-image-storage'],
          requiredTools: ['$imagegen'],
        },
      ],
      referencedTools: [{ id: '$imagegen' }],
    },
    apiBindings: [
      { id: 'ozon.products.read', label: 'Ozon 商品读取', access: 'read' },
      { id: 'ozon.productImages.read', label: 'Ozon 商品图片读取', access: 'read' },
      { id: 'ozon.shops.read', label: 'Ozon 店铺读取', access: 'read' },
      { id: 'model.text.generate', label: '文本模型', access: 'read' },
    ],
  },
};

const runtimeContext = {
  selectedShop: { id: 'shop-2', shopAlias: 'Ozon 2店', apiKey: 'must-not-leak' },
  selectedProduct: {
    id: 'product-row',
    productId: '10001',
    offerId: 'WZ-10001',
    title: '保温杯',
    images: ['https://example.com/a.webp'],
    raw: { secret: 'must-not-leak' },
    skuOptions: [{ id: 'sku-row', sku: 'sku-1', label: '黑色', facts: '黑色 · 500ml' }],
  },
  selectedSku: { id: 'sku-row', sku: 'sku-1', label: '黑色', facts: '黑色 · 500ml' },
};

describe('smartToolGenericRuntimeService', () => {
  beforeEach(() => {
    mocks.requestLocalApi.mockReset();
    mocks.requestLocalOzon.mockReset();
    mocks.getCrossBorderOrderRecords.mockReset();
    mocks.getDomainCache.mockReset();
    mocks.listIntegrationProfiles.mockReset();
    mocks.listPerformanceAccounts.mockReset();
    mocks.readExternalIntegration.mockReset();
    mocks.readPerformanceOverview.mockReset();
    mocks.requestLocalOzon.mockImplementation(async ({ endpoint }) => ({ endpoint, ok: true }));
  });

  it('migrates legacy preview adapters to the executable generic runtime', () => {
    expect(canUseSmartToolGenericRuntime(tool)).toBe(true);
  });

  it('never routes a native Skill through the generic runtime', () => {
    expect(
      canUseSmartToolGenericRuntime({
        id: 'ozon-skill-1688-channel-shopdata-get',
        title: 'Ozon 报表读取与分析',
        skillProfile: {
          adapterKey: 'builtin.generic-skill-runtime',
          apiBindings: [{ id: 'model.text.generate', label: '文本模型', access: 'read' }],
        },
      })
    ).toBe(false);
  });

  it('binds the current shop and product and performs real read calls', async () => {
    const context = await collectSmartToolGenericRuntimeContext(
      tool,
      { 模式: '完整商品卡' },
      {
        shopScope: { shopId: 'shop-2', shopName: 'Ozon 2店' },
        runtimeContext,
      }
    );

    expect(mocks.requestLocalOzon).toHaveBeenCalledTimes(4);
    expect(mocks.requestLocalOzon.mock.calls.map(([request]) => request.endpoint)).toEqual(
      expect.arrayContaining([
        '/v3/product/info/list',
        '/v4/product/info/attributes',
        '/v2/product/pictures/info',
        '/v1/seller/info',
      ])
    );
    expect(context.shop).toEqual({ shopId: 'shop-2', shopName: 'Ozon 2店' });
    expect(JSON.stringify(context)).not.toContain('must-not-leak');
    expect(context.executions.filter((item) => item.status === 'executed')).toHaveLength(3);
  });

  it('calls the selected model and returns structured output with an execution ledger', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      reportText: JSON.stringify({
        statusLabel: '商品卡已生成',
        summary: '已根据真实商品资料生成俄语内容。',
        sections: [{ title: '俄语标题', rows: ['Термокружка 500 мл'] }],
        nextActions: ['检查待确认属性'],
      }),
      model: 'gpt-test',
      accountId: 'account-1',
      usage: { total_tokens: 120 },
    });

    const draft = await runSmartToolGenericRuntime(
      tool,
      { 模式: '完整商品卡' },
      {
        shopScope: { shopId: 'shop-2', shopName: 'Ozon 2店' },
        runtimeContext,
        modelSelection: { ready: true, accountId: 'account-1', model: 'gpt-test' },
      }
    );

    expect(mocks.requestLocalApi).toHaveBeenCalledWith(
      '/api/integrations/analyze',
      expect.objectContaining({ method: 'POST', timeoutMs: 420000 })
    );
    const requestBody = mocks.requestLocalApi.mock.calls[0][1].body;
    expect(requestBody).toMatchObject({
      accountId: 'account-1',
      model: 'gpt-test',
      allowPaidFallback: false,
      templateId: 'generic-skill-runtime.v1',
    });
    expect(requestBody.templateInput).toMatchObject({
      skill: {
        title: '通用商品优化 Skill',
        body: expect.stringContaining('Read facts'),
        workflowSteps: ['读取真实商品', '生成内容'],
        safetyRules: ['不得补造商品事实'],
        modules: [
          expect.objectContaining({
            id: 'product-truth-ledger',
            order: 1,
            requiredCapabilities: ['ozon.products.read'],
          }),
          expect.objectContaining({
            id: 'image-generation',
            order: 2,
            requiredTools: ['$imagegen'],
          }),
        ],
        referencedTools: ['$imagegen'],
        evidenceRules: ['缺少权威证据时标记待确认'],
        skuImageRules: ['SKU 图片必须与变体一致'],
        qaRules: ['检查俄语文案和图片一致性'],
        stopConditions: ['商品身份冲突时停止'],
      },
      context: {
        product: expect.objectContaining({ title: '保温杯', offerId: 'WZ-10001' }),
      },
    });
    expect(JSON.stringify(requestBody.templateInput)).not.toContain('must-not-leak');
    expect(requestBody).not.toHaveProperty('systemPrompt');
    expect(requestBody).not.toHaveProperty('userPrompt');
    expect(draft.result.status).toBe('ready');
    expect(draft.result.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: '俄语标题' }),
        expect.objectContaining({ title: '本次步骤执行记录' }),
      ])
    );
    expect(draft.result.runtime.executions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'model.text.generate', status: 'executed' })])
    );
    expect(draft.result.runtime.billing).toBeNull();
  });

  it('bounds large installed Skill context and avoids sending the Skill body twice', async () => {
    const largeTool = {
      ...tool,
      body: '规则'.repeat(8_000),
      promptConfig: { systemPrompt: '规则'.repeat(8_000) },
      skillProfile: {
        ...tool.skillProfile,
        referenceFiles: [{ path: 'reference.md', content: '参考'.repeat(20_000) }],
      },
    };
    mocks.requestLocalOzon.mockImplementation(async ({ endpoint }) => ({
      endpoint,
      rows: Array.from({ length: 200 }, (_, index) => ({ index, text: '商品事实'.repeat(100) })),
    }));
    mocks.requestLocalApi.mockResolvedValue({ reportText: '已完成。' });

    await runSmartToolGenericRuntime(
      largeTool,
      { 模式: '完整商品卡' },
      {
        shopScope: { shopId: 'shop-2', shopName: 'Ozon 2店' },
        runtimeContext,
        modelSelection: { ready: true, accountId: 'account-1', model: 'gpt-test' },
      }
    );

    const requestBody = mocks.requestLocalApi.mock.calls[0][1].body;
    expect(requestBody.customRules).toBe('');
    expect(requestBody.templateInput.skill.body.length).toBeLessThanOrEqual(12_000);
    expect(JSON.stringify(requestBody.templateInput.context).length).toBeLessThan(40_000);
    expect(JSON.stringify(requestBody.templateInput).length).toBeLessThan(85_000);
  });

  it('enables the built-in points fallback only for the automatic model choice', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      reportText: '自动运行完成。',
      model: 'builtin-points',
      billing: { chargedPoints: 6, source: 'paid-cloud' },
    });

    await runSmartToolGenericRuntime(
      tool,
      { 模式: '完整商品卡' },
      {
        shopScope: { shopId: 'shop-2', shopName: 'Ozon 2店' },
        runtimeContext,
        modelSelection: {
          id: 'auto',
          ready: true,
          accountId: 'account-1',
          model: 'gpt-test',
        },
      }
    );

    expect(mocks.requestLocalApi.mock.calls[0][1].body).toMatchObject({
      accountId: 'builtin-points',
      model: 'builtin-points-text',
      allowPaidFallback: true,
    });
    const automaticDraft = await runSmartToolGenericRuntime(
      tool,
      { 模式: '完整商品卡' },
      {
        shopScope: { shopId: 'shop-2', shopName: 'Ozon 2店' },
        runtimeContext,
        modelSelection: {
          id: 'auto',
          ready: true,
          accountId: 'account-1',
          model: 'gpt-test',
        },
      }
    );
    expect(automaticDraft.result.runtime.billing).toEqual({ chargedPoints: 6, source: 'paid-cloud' });
    expect(automaticDraft.result.sections.at(-1).rows).toEqual(
      expect.arrayContaining([expect.stringContaining('内置积分模型（本次 6 积分）')])
    );
  });

  it('uses the same runtime contract for other preinstalled read capabilities', async () => {
    const broadTool = {
      id: 'installed-operations-skill',
      title: '经营巡检 Skill',
      skillProfile: {
        installType: 'skill-md',
        runType: 'api-assisted-readonly',
        apiBindings: [
          'ozon.warehouse.read',
          'ozon.salesOrders.read',
          'ozon.afterSales.read',
          'ozon.finance.read',
          'ozon.marketing.read',
          'ozon.analytics.read',
          'cross-border.read',
          'ozon.performance.read',
          'seerfar.market.read',
          'model.text.generate',
        ].map((id) => ({ id, label: id, access: 'read' })),
      },
    };
    mocks.getDomainCache.mockResolvedValue({ rows: [] });
    mocks.getCrossBorderOrderRecords.mockResolvedValue({ rows: [] });
    mocks.listPerformanceAccounts.mockResolvedValue({ accounts: [{ id: 'performance-1', shopId: 'shop-2' }] });
    mocks.readPerformanceOverview.mockResolvedValue({ ok: true, campaigns: [] });
    mocks.listIntegrationProfiles.mockResolvedValue({ profiles: [] });
    mocks.readExternalIntegration.mockResolvedValue({ ok: true, data: { records: [] } });

    const context = await collectSmartToolGenericRuntimeContext(
      broadTool,
      { 订单号: '12345-0001', 商品关键词: '保温杯' },
      {
        shopScope: { shopId: 'shop-2', shopName: 'Ozon 2店' },
        runtimeContext: { selectedShop: runtimeContext.selectedShop },
      }
    );

    expect(mocks.requestLocalOzon.mock.calls.map(([request]) => request.endpoint)).toEqual(
      expect.arrayContaining([
        '/v2/warehouse/list',
        '/v2/delivery-method/list',
        '/v3/posting/fbs/get',
        '/v2/posting/fbo/get',
        '/v1/returns/list',
        '/v3/finance/transaction/list',
        '/v1/actions',
        '/v1/seller-actions/list',
      ])
    );
    expect(mocks.getDomainCache).toHaveBeenCalledWith(
      'data-analysis',
      expect.objectContaining({ shopId: 'shop-2' }),
      expect.any(Object)
    );
    expect(mocks.getCrossBorderOrderRecords).toHaveBeenCalled();
    expect(mocks.readPerformanceOverview).toHaveBeenCalled();
    expect(mocks.readExternalIntegration).toHaveBeenCalled();
    expect(context.executions.filter((item) => item.status === 'executed')).toHaveLength(9);
    expect(context.executions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'model.text.generate', status: 'pending' })])
    );
  });

  it('never reports a failed read as a successful execution', async () => {
    mocks.requestLocalOzon.mockRejectedValueOnce(new Error('商品接口超时'));
    mocks.requestLocalApi.mockResolvedValue({ reportText: '只返回当前能够确认的内容。' });

    const draft = await runSmartToolGenericRuntime(
      tool,
      { 模式: '完整商品卡' },
      {
        shopScope: { shopId: 'shop-2', shopName: 'Ozon 2店' },
        runtimeContext,
        modelSelection: { ready: true, accountId: 'builtin-points', model: 'builtin-points-text' },
      }
    );

    expect(draft.result.status).toBe('partial_ready');
    expect(draft.result.summary).toContain('真实读取失败');
    expect(draft.result.runtime.executions).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'failed' })])
    );
  });

  it('routes image Skills away from the report engine before any model or image charge', async () => {
    const imageTool = {
      ...tool,
      skillProfile: {
        ...tool.skillProfile,
        apiBindings: [
          ...tool.skillProfile.apiBindings,
          { id: 'model.image.generate', label: '图片模型', access: 'read' },
          { id: 'product-image-storage', label: '商品图片安全存储', access: 'read' },
        ],
      },
    };
    await expect(
      runSmartToolGenericRuntime(
        imageTool,
        { 模式: '完整商品卡' },
        {
          shopScope: { shopId: 'shop-2', shopName: 'Ozon 2店' },
          runtimeContext,
          modelSelection: { ready: true, accountId: 'account-1', model: 'gpt-test' },
        }
      )
    ).rejects.toThrow('必须在商品内容工作台选择真实图片位置');
    expect(mocks.requestLocalApi).not.toHaveBeenCalled();
  });

  it('allows an installed image Skill to run its read-only analysis stage without starting image generation', async () => {
    const imageTool = {
      ...tool,
      skillProfile: {
        ...tool.skillProfile,
        apiBindings: [
          ...tool.skillProfile.apiBindings,
          { id: 'model.image.generate', label: '图片模型', access: 'read' },
          { id: 'product-image-storage', label: '商品图片安全存储', access: 'read' },
        ],
      },
    };
    mocks.requestLocalApi.mockResolvedValue({ reportText: '已完成数据分析。', model: 'gpt-test' });

    const draft = await runSmartToolGenericRuntime(
      imageTool,
      { 模式: '完整商品卡' },
      {
        operation: 'analysis',
        shopScope: { shopId: 'shop-2', shopName: 'Ozon 2店' },
        runtimeContext,
        modelSelection: { ready: true, accountId: 'account-1', model: 'gpt-test' },
      }
    );

    expect(mocks.requestLocalApi).toHaveBeenCalledTimes(1);
    expect(draft.result.status).toMatch(/ready/);
    expect(draft.result.runtime.executions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'model.image.generate', status: 'available' })])
    );
  });
});
