import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PromptLibraryQuickRunPanel } from './PromptLibraryQuickRunPanel.jsx';
import { analyzeOzonProductRecords } from '../lib/smartToolOzonProductAnalysis.js';

describe('PromptLibraryQuickRunPanel standard Skill workspace', () => {
  it('lets product detail switch between competitor and own-product analysis', () => {
    const onChangeValue = vi.fn();
    render(
      <PromptLibraryQuickRunPanel
        open
        selectedPrompt={{
          id: 'linkfox-seerfar-ozon-product-detail-search',
          title: 'Seerfar 商品详情',
          goal: '查看单个 Ozon SKU 的完整表现和每日趋势',
          skillProfile: {},
        }}
        usageInputs={[
          '分析对象',
          '商品 SKU 或链接',
          '商品成本（₽）',
          '平台佣金率（%）',
          '履约费用（₽/单）',
          '税费率（%）',
          '退货取消率（%）',
        ]}
        values={{ 分析对象: 'competitor', '商品 SKU 或链接': '' }}
        browserDataEnabled
        externalDataEnabled
        onChangeValue={onChangeValue}
      />
    );

    fireEvent.mouseDown(screen.getByRole('combobox', { name: '分析对象' }));
    expect(screen.getByRole('option', { name: '竞对商品分析' })).toBeVisible();
    fireEvent.click(screen.getByRole('option', { name: '自己商品分析' }));
    expect(onChangeValue).toHaveBeenCalledWith('分析对象', 'own');
    expect(screen.getByText('补充经营数据（可选）')).toBeVisible();
    expect(screen.getByLabelText('商品成本（₽）')).toBeVisible();
    expect(screen.getByLabelText('平台佣金率（%）')).toBeVisible();
    expect(screen.getByLabelText('履约费用（₽/单）')).toBeVisible();
    expect(screen.getByLabelText('税费率（%）')).toBeVisible();
    expect(screen.getByLabelText('退货取消率（%）')).toBeVisible();
    expect(screen.queryByText('当前功能')).not.toBeInTheDocument();
  });

  it('uses the shared left rail and exposes a runnable result workspace', () => {
    const onRunDraft = vi.fn();
    render(
      <PromptLibraryQuickRunPanel
        open
        selectedPrompt={{
          id: 'custom-text-skill',
          title: '自定义文本工具',
          goal: '按设定处理输入内容',
          skillProfile: { installType: 'skill-md', modelCapability: 'text-generation' },
          promptConfig: { defaultModelId: 'auto' },
        }}
        usageInputs={['处理内容']}
        values={{ 处理内容: '测试内容' }}
        onChangeValue={vi.fn()}
        onRunDraft={onRunDraft}
        textModelOptions={[
          {
            id: 'auto',
            accountId: 'model-account',
            model: 'gpt-5.5',
            ready: true,
            statusLabel: '默认已配置',
          },
        ]}
      />
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.closest('.prompt-library-run-dialog')).toHaveClass('is-standard-skill');
    expect(dialog.querySelector('.prompt-library-standard-fixed-sidebar')).toBeTruthy();
    expect(within(dialog).getByText('使用前设置')).toBeVisible();
    expect(within(dialog).getByText('Skill 执行模型')).toBeVisible();
    expect(within(dialog).getByLabelText('执行模型')).toBeVisible();
    expect(dialog).toHaveTextContent('自动选择 · 管理端托管 · 按量积分');
    expect(dialog).toHaveTextContent('后台更换接口地址后下一次运行立即生效');
    expect(within(dialog).getByLabelText('处理内容')).toHaveValue('测试内容');
    const emptyWorkspace = dialog.querySelector('.prompt-library-standard-empty-workspace');
    expect(emptyWorkspace).toBeTruthy();
    expect(emptyWorkspace.childElementCount).toBeGreaterThan(0);
    expect(dialog).toHaveTextContent('运行 Skill：自定义文本工具');
    within(dialog).getByRole('button', { name: '运行 Skill' }).click();
    expect(onRunDraft).toHaveBeenCalledTimes(1);
    expect(onRunDraft).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'auto', accountId: 'model-account', model: 'gpt-5.5' })
    );
    expect(dialog).toHaveTextContent('真实接口和模型执行记录');
    expect(dialog).not.toHaveTextContent('清空预览');
  });

  it('routes an installed image Skill into the real slot workbench and only generates selected positions', () => {
    const onGenerateImage = vi.fn();
    const onSelectedShopChange = vi.fn();
    const product = {
      id: 'product-1',
      shopId: 'shop-1',
      title: '测试商品',
      offerId: 'OFFER-1',
      image: 'https://example.com/source-1.webp',
      mainImages: ['https://example.com/source-1.webp', 'https://example.com/source-2.webp'],
      detailImages: ['https://example.com/detail-1.webp'],
      skuOptions: [{ id: 'sku-1', sku: 'SKU-1', label: '黑色', facts: '黑色 · 1 件' }],
    };
    render(
      <PromptLibraryQuickRunPanel
        open
        genericRuntimeEnabled
        selectedPrompt={{
          id: 'installed-image-skill',
          title: '商品图工作流',
          goal: '生成完整商品图套组',
          body: [
            'Generate product images from verified product facts.',
            '1. **Primary/CTR image**: Show the truthful product.',
            '2. **Structure image**: Show product construction.',
          ].join('\n'),
          promptConfig: {
            imagePositionRules: {
              main: [
                {
                  sourceIndex: 0,
                  purpose: '俄语场景首图',
                  instructions: '突出商品主体',
                  visibleText: '俄语短标题',
                  mustAvoid: '禁止虚构参数',
                },
              ],
              detail: [],
            },
          },
          skillProfile: {
            installType: 'github-skill',
            sourceName: 'ozon-card-optimizer',
            parserVersion: 3,
            runType: 'api-assisted-readonly',
            usageInputs: ['处理模式', '店铺、市场与语言', '商品、SPU/SKC 与 SKU 信息'],
            operatingModes: [
              { value: 'full-card', label: '完整商品卡' },
              { value: 'step4-images', label: '只做商品图' },
            ],
            apiBindings: [
              { id: 'model.text.generate', label: '文本模型', access: 'read' },
              { id: 'model.image.generate', label: '图片模型', access: 'read' },
              { id: 'product-image-storage', label: '图片安全存储', access: 'read' },
            ],
          },
        }}
        values={{ 处理模式: 'full-card', 'SKU 信息': '黑色 · 1 件' }}
        onChangeValue={vi.fn()}
        onGenerateImage={onGenerateImage}
        shops={[{ id: 'shop-1', name: '测试店铺' }]}
        selectedShop={{ id: 'shop-1', name: '测试店铺' }}
        availableShops={[
          { id: 'shop-1', name: '测试店铺' },
          { id: 'shop-2', name: '备用店铺' },
        ]}
        onSelectedShopChange={onSelectedShopChange}
        productSelection={{
          selectedProduct: product,
          selectedSku: product.skuOptions[0],
          visibleProducts: [product],
          hasLocalProducts: true,
          query: '',
          onQueryChange: vi.fn(),
          onSelectProduct: vi.fn(),
          onSelectSku: vi.fn(),
          onRefresh: vi.fn(),
        }}
        textModelOptions={[
          { id: 'auto', accountId: 'text-account', model: 'gpt-test', ready: true, statusLabel: '可用' },
        ]}
        imageModelOptions={[
          { id: 'auto', accountId: 'image-account', model: 'gpt-image-test', ready: true, statusLabel: '可用' },
        ]}
      />
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.closest('.prompt-library-run-dialog')).toHaveClass('is-installed-product-image-workspace');
    expect(dialog.closest('.prompt-library-run-dialog')).not.toHaveClass('is-product-content-workbench');
    expect(screen.queryByText('Skill 目标')).not.toBeInTheDocument();
    expect(screen.getAllByText('俄语场景首图')[0]).toBeVisible();
    expect(screen.getAllByText('结构展示图')[0]).toBeVisible();
    expect(screen.getAllByText('详情图位置 1')[0]).toBeVisible();
    expect(screen.getAllByText('测试商品')[0]).toBeVisible();
    expect(screen.getAllByText('货号 OFFER-1 · SKU SKU-1')[0]).toBeVisible();
    expect(screen.getByLabelText('选择店铺')).toHaveTextContent('测试店铺');
    fireEvent.mouseDown(screen.getByLabelText('选择店铺'));
    fireEvent.click(screen.getByRole('option', { name: '备用店铺' }));
    expect(onSelectedShopChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'shop-2' }));
    expect(screen.queryByText('直接读取软件内已绑定店铺，不需要填写 API Key。')).not.toBeInTheDocument();
    expect(screen.getByLabelText('图片生成模型')).toBeVisible();
    expect(screen.getByRole('button', { name: '请选择主图' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: '选择俄语场景首图' }));
    fireEvent.click(screen.getByRole('button', { name: '生成 1 张主图' }));
    expect(onGenerateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: 'shop-1',
        productKey: 'OFFER-1',
        productImageUrls: ['https://example.com/source-1.webp'],
        sourceImageIndexes: [0],
        imageSlotInstructions: [
          expect.objectContaining({
            sourceIndex: 0,
            title: '俄语场景首图',
            instruction: '突出商品主体\n画面文字：俄语短标题\n禁止内容：禁止虚构参数',
          }),
        ],
        skillExecutionContext: expect.objectContaining({
          imageSlots: expect.arrayContaining([expect.objectContaining({ sourceIndex: 0, title: '俄语场景首图' })]),
        }),
        sku: 'SKU-1',
        modelSelection: expect.objectContaining({ accountId: 'image-account', model: 'gpt-image-test' }),
      })
    );
    fireEvent.click(screen.getByRole('button', { name: '编辑文案与属性' }));
    expect(screen.getByText('商品资料智能填写')).toBeVisible();
  });

  it('shows adapter requirements and removes the run action for an unadapted script Skill', () => {
    const onRunDraft = vi.fn();
    render(
      <PromptLibraryQuickRunPanel
        open
        selectedPrompt={{
          id: 'prompt-custom-script',
          title: '外部查询脚本',
          goal: '读取外部商品数据',
          skillProfile: {
            installType: 'skill-md',
            runType: 'external-or-script',
            inputs: ['关键词'],
          },
        }}
        usageInputs={['关键词']}
        values={{ 关键词: '雨刮器' }}
        onRunDraft={onRunDraft}
      />
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Skill 接入状态：外部查询脚本');
    expect(dialog).toHaveTextContent('等待脚本安全适配');
    expect(within(dialog).getByRole('region', { name: 'Skill 接入要求' })).toBeVisible();
    expect(dialog).toHaveTextContent('在 services 层实现并通过测试后');
    expect(
      within(dialog).queryByRole('button', { name: /^(生成本地预览|生成本地结果|开始查询|读取插件数据并运行)$/u })
    ).not.toBeInTheDocument();
    expect(onRunDraft).not.toHaveBeenCalled();
  });

  it('routes write Skills to the business safety integration screen', () => {
    render(
      <PromptLibraryQuickRunPanel
        open
        selectedPrompt={{
          id: 'prompt-custom-write',
          title: '修改商品脚本',
          goal: '修改商品资料',
          skillProfile: { installType: 'skill-md', runType: 'guard-required' },
        }}
      />
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('需要业务安全接入');
    expect(dialog).toHaveTextContent('预览 → 用户确认 → 提交 → 平台回读 → 审计记录');
    expect(
      within(dialog).queryByRole('button', { name: /^(生成本地预览|生成本地结果|提交)$/u })
    ).not.toBeInTheDocument();
  });

  it('keeps native Skills out of the generic execution plan and adapter screens', () => {
    render(
      <PromptLibraryQuickRunPanel
        open
        genericRuntimeEnabled
        selectedPrompt={{
          id: 'ozon-skill-1688-channel-shopdata-get',
          title: 'Ozon 报表读取与分析',
          goal: '按店铺读取 Ozon 完整经营报表并直接生成经营分析',
          status: '可用',
          skillProfile: { runType: 'local-readonly' },
          toolMeta: {
            apiCapabilityMatch: {
              executionPlan: {
                version: 1,
                totalCount: 1,
                executableCount: 0,
                missingConfigurationCount: 0,
                unsupportedCount: 1,
                steps: [],
                canStart: false,
              },
            },
          },
        }}
        usageInputs={['报告内容', '统计范围']}
        values={{ 报告内容: '全部经营数据', 统计范围: '最近 7 天' }}
      />
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('使用功能：Ozon 报表读取与分析');
    expect(dialog).not.toHaveTextContent('Skill 执行计划');
    expect(dialog).not.toHaveTextContent('缺少执行器');
    expect(dialog).not.toHaveTextContent('Skill 接入状态');
  });

  it('shows captured browser data status and records for a connected Ozon Skill', () => {
    render(
      <PromptLibraryQuickRunPanel
        open
        selectedPrompt={{
          id: 'ozon-product-selection',
          title: 'Ozon 选品助手',
          goal: '读取畅销榜',
          skillProfile: {},
        }}
        browserDataEnabled
        textModelOptions={[
          {
            id: 'auto',
            accountId: 'model-account',
            model: 'gpt-5.6-sol',
            ready: true,
            statusLabel: '已配置',
          },
        ]}
        draft={{
          result: {
            status: 'browser_data_ready',
            statusLabel: '已使用浏览器插件真实数据',
            summary: '已读取 1000 条真实商品数据。',
            productAnalysis: analyzeOzonProductRecords([
              {
                id: '3568698657',
                title: '遥控汽车',
                price: 1999,
                sales: 120,
                revenue: 239880,
                stock: 44,
              },
            ]),
          },
        }}
      />
    );

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: '开始选品分析' })).toBeVisible();
    expect(within(dialog).getByText('商品市场分析')).toBeVisible();
    expect(within(dialog).getByText(/3568698657/u)).toBeVisible();
  });

  it('forwards product-title clicks to the shared Ozon workbench action', () => {
    const onOpenOzonProduct = vi.fn();
    render(
      <PromptLibraryQuickRunPanel
        open
        selectedPrompt={{
          id: 'ozon-product-search',
          title: 'Ozon 商品搜索',
          goal: '搜索商品',
          skillProfile: {},
        }}
        browserDataEnabled
        draft={{
          result: {
            status: 'browser_data_ready',
            productAnalysis: analyzeOzonProductRecords([
              {
                id: '3568698657',
                title: '遥控汽车',
                price: 1999,
                sales: 120,
                revenue: 239880,
                stock: 44,
              },
            ]),
          },
        }}
        onOpenOzonProduct={onOpenOzonProduct}
      />
    );

    within(screen.getByRole('dialog')).getByRole('button', { name: '打开商品操作台：遥控汽车' }).click();
    expect(onOpenOzonProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '3568698657',
        title: '遥控汽车',
        revenue: 239880,
      })
    );
  });

  it('keeps the Ozon product-search rail compact with two inputs and no function card', () => {
    render(
      <PromptLibraryQuickRunPanel
        open
        selectedPrompt={{
          id: 'ozon-product-search',
          title: 'Ozon 商品搜索',
          goal: '搜索商品',
          skillProfile: {},
        }}
        browserDataEnabled
        usageInputs={['关键词或 SKU', '产品链接（可选）']}
        values={{ '关键词或 SKU': '连衣裙', '产品链接（可选）': '' }}
        textModelOptions={[{ id: 'auto', model: 'gpt-5.6-sol', ready: true, statusLabel: '已配置' }]}
      />
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('关键词或 SKU')).toBeVisible();
    expect(within(dialog).getByLabelText('产品链接（可选）')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: '搜索并分析' })).toBeVisible();
    expect(within(dialog).queryByText('当前功能')).not.toBeInTheDocument();
  });

  it('shows Seerfar batch input as compact repeatable rows and validates before querying', () => {
    const onRunDraft = vi.fn();
    const selectedPrompt = {
      id: 'linkfox-seerfar-ozon-keyword-back-search',
      title: 'Seerfar 关键词反查',
      goal: '按 SKU 反查流量词',
      skillProfile: {},
    };
    const usageInputs = ['商品 SKU 或链接（最多20个）'];
    const { rerender } = render(
      <PromptLibraryQuickRunPanel
        open
        selectedPrompt={selectedPrompt}
        browserDataEnabled
        usageInputs={usageInputs}
        values={{ '商品 SKU 或链接（最多20个）': '' }}
        onChangeValue={vi.fn()}
        onRunDraft={onRunDraft}
      />
    );

    const dialog = screen.getByRole('dialog');
    const batchInput = within(dialog).getByLabelText('商品 SKU 或链接（最多20个）');
    expect(batchInput.tagName).toBe('INPUT');
    expect(within(dialog).getByRole('button', { name: '增加商品 SKU 或链接（最多20个）' })).toBeVisible();
    expect(within(dialog).getByText(/已输入 0\/20/u)).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: '开始查询' }));
    expect(onRunDraft).not.toHaveBeenCalled();
    expect(within(dialog).getByText('请先填写这个项目。')).toBeVisible();

    rerender(
      <PromptLibraryQuickRunPanel
        open
        selectedPrompt={selectedPrompt}
        browserDataEnabled
        usageInputs={usageInputs}
        values={{ '商品 SKU 或链接（最多20个）': '4380710124\n175924376' }}
        onChangeValue={vi.fn()}
        onRunDraft={onRunDraft}
      />
    );
    expect(within(screen.getByRole('dialog')).getByLabelText('商品 SKU 或链接（最多20个） 第2条')).toHaveValue(
      '175924376'
    );
    expect(within(screen.getByRole('dialog')).getByText(/已输入 2\/20/u)).toBeVisible();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '开始查询' }));
    expect(onRunDraft).toHaveBeenCalledTimes(1);
  });

  it('keeps external API tools on their own query path and exposes the analysis model selector', () => {
    render(
      <PromptLibraryQuickRunPanel
        open
        selectedPrompt={{
          id: 'linkfox-seerfar-ozon-market-keyword-search',
          title: '市场热词',
          goal: '查看市场关键词',
          skillProfile: {},
        }}
        browserDataEnabled
        externalDataEnabled
        usageInputs={['关键词或筛选条件（可多个）']}
        values={{ '关键词或筛选条件（可多个）': '' }}
        textModelOptions={[
          {
            id: 'auto',
            accountId: 'account-1',
            model: 'gpt-5.6-sol',
            ready: true,
            statusLabel: '默认已配置',
          },
        ]}
      />
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.closest('.prompt-library-run-dialog')).toHaveClass('is-external-data');
    expect(within(dialog).getByLabelText('分析模型')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: '开始查询' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: '增加关键词或筛选条件（可多个）' })).toBeVisible();
    expect(dialog).toHaveTextContent('每次点击只执行一次真实数据查询');
  });

  it('flips an external result into the model report and returns to the raw data', () => {
    const onGenerateExternalInsight = vi.fn();
    render(
      <PromptLibraryQuickRunPanel
        open
        selectedPrompt={{
          id: 'linkfox-seerfar-ozon-market-keyword-search',
          title: '市场热词',
          goal: '查看市场关键词',
          skillProfile: {},
        }}
        browserDataEnabled
        externalDataEnabled
        draft={{
          createdAt: '07/31 12:00',
          result: {
            status: 'ready',
            statusLabel: '查询完成',
            summary: '已读取 1000 条关键词数据。',
            viewType: 'market-keywords',
            keywordAnalysis: {
              kind: 'keywords',
              records: [{ query: 'платье', searchVolume: 1200 }],
              overview: { total: 1000 },
            },
            marketKeywordAnalysis: {
              kind: 'keywords',
              records: [{ query: 'платье', searchVolume: 1200 }],
              overview: { total: 1000 },
            },
          },
        }}
        externalInsight={{ status: 'loading', model: 'gpt-5.6-sol' }}
        textModelOptions={[
          {
            id: 'auto',
            accountId: 'account-1',
            model: 'gpt-5.6-sol',
            ready: true,
            statusLabel: '默认已配置',
          },
        ]}
        onGenerateExternalInsight={onGenerateExternalInsight}
      />
    );

    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '数据分析' }));
    expect(onGenerateExternalInsight).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'account-1',
        model: 'gpt-5.6-sol',
        ready: true,
      })
    );
    expect(within(dialog).getByText('正在整理数据分析报告')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: '返回数据' })).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: '开始查询' })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '返回数据' }));
    expect(within(dialog).getByText('查询完成')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: '数据分析' })).toBeVisible();
  });
});
