import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PromptLibrarySimpleEditorDialog } from './PromptLibrarySimpleEditorDialog.jsx';
import { getDefaultExternalOzonInsightConfig } from '../lib/smartToolExternalOzonInsightConfig.js';
import { normalizeProfitReviewPresentation } from '../lib/smartToolProfitReviewConfig.js';

describe('PromptLibrarySimpleEditorDialog', () => {
  it('shows only the global Skill and image position rule areas for an image Skill', () => {
    render(
      <PromptLibrarySimpleEditorDialog
        open
        onClose={vi.fn()}
        formError=""
        editorForm={{
          title: 'Ozon 商品图生成',
          systemPrompt: '你是商品图片规划师。\n\n一、商品身份锁定\n保持商品一致。',
          imagePositionRules: {
            main: [{ sourceIndex: 0, purpose: '主卖点图' }],
            detail: [],
          },
          attributeRules: {
            optimizationGoal: '只优化当前商品资料。',
          },
        }}
        isImageSkill
        onChangeField={() => vi.fn()}
        onSavePrompt={vi.fn()}
      />
    );

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '全局 Skill',
      '图片位置规则',
      '属性规则',
    ]);
    expect(screen.queryByText('模型和输入')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('分析 / 文案模型')).not.toBeInTheDocument();
    expect(screen.queryByText('使用时需要人工填写什么')).not.toBeInTheDocument();
    expect(screen.getByText('所有规则直接显示')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '图片位置规则' }));

    expect(screen.getByText('每张商品图片可以单独设置')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '主图规则 (1)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '详情图规则 (0)' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '属性规则' }));
    expect(screen.getByText('设置商品属性生成规则')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '优化目标属性规则' })).toHaveValue('只优化当前商品资料。');
  });

  it('shows and edits the complete analysis configuration for an external data Skill', () => {
    const emitChange = vi.fn();
    const onChangeField = vi.fn(() => emitChange);
    const config = getDefaultExternalOzonInsightConfig('linkfox-seerfar-ozon-market-keyword-search');

    render(
      <PromptLibrarySimpleEditorDialog
        open
        onClose={vi.fn()}
        formError=""
        editorForm={{
          title: 'Seerfar 市场热词',
          systemPrompt: '全局规则',
          externalInsightConfig: config,
        }}
        isExternalDataSkill
        onChangeField={onChangeField}
        onSavePrompt={vi.fn()}
      />
    );

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '通用规则',
      '分析报告',
    ]);

    fireEvent.click(screen.getByRole('tab', { name: '分析报告' }));

    expect(screen.getByText('分析方法和报告样式都能自己改')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '你希望这份报告回答什么' })).toHaveValue(config.analysisGoals.join('\n'));
    expect(screen.getByRole('textbox', { name: '分析时先看什么、再看什么' })).toHaveValue(config.workflowSteps.join('\n'));
    expect(screen.getByRole('textbox', { name: '哪些判断必须遵守' })).toHaveValue(config.analysisRules.join('\n'));
    expect(screen.getByRole('textbox', { name: '报告怎么写' })).toHaveValue(config.reportStyleRules.join('\n'));
    expect(screen.getByRole('textbox', { name: '报告顶部的小标题' })).toHaveValue('经营分析');
    expect(screen.getByText('报告分区')).toBeInTheDocument();
    fireEvent.click(screen.getByText('专业设置（一般不用改）'));
    expect(screen.getByRole('textbox', { name: '模型的总说明' })).toHaveValue(config.systemPrompt);
    expect(screen.getByRole('textbox', { name: '本次数据说明模板' })).toHaveValue(config.userPrompt);
    expect(screen.getByRole('textbox', { name: '报告内容对应关系' })).toHaveValue(config.outputSections.join('\n'));
    expect(screen.getByRole('textbox', { name: '系统返回要求' })).toHaveValue(config.outputRules.join('\n'));
    expect(screen.queryByText('模板可用变量')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('最多取多少条代表记录')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('代表记录最多字符数')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: '你希望这份报告回答什么' }), {
      target: { value: '目标一\n目标二' },
    });

    expect(onChangeField).toHaveBeenCalledWith('externalInsightConfig');
    expect(emitChange).toHaveBeenCalledWith(expect.objectContaining({
      target: { value: expect.objectContaining({ analysisGoals: ['目标一', '目标二'] }) },
    }));
  });

  it('shows both editable product-detail analysis plans', () => {
    const onChangeField = vi.fn(() => vi.fn());
    const config = getDefaultExternalOzonInsightConfig('linkfox-seerfar-ozon-product-detail-search');
    render(
      <PromptLibrarySimpleEditorDialog
        open
        onClose={vi.fn()}
        formError=""
        editorForm={{
          title: 'Seerfar 商品详情',
          systemPrompt: '全局规则',
          externalInsightConfig: config,
        }}
        isExternalDataSkill
        onChangeField={onChangeField}
        onSavePrompt={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('tab', { name: '分析报告' }));
    expect(screen.getByText('竞对商品和自己商品分别怎么分析')).toBeVisible();
    expect(screen.getByRole('textbox', { name: '竞对商品分析分析时先看什么、再看什么' }))
      .toHaveValue(config.analysisModes.competitor.workflowSteps.join('\n'));
    expect(screen.getByRole('textbox', { name: '自己商品分析哪些判断必须遵守' }))
      .toHaveValue(config.analysisModes.own.analysisRules.join('\n'));
    expect(document.querySelectorAll('.prompt-library-analysis-mode-block')).toHaveLength(2);
    document.querySelectorAll('.prompt-library-analysis-mode-block').forEach((block) => {
      expect(block.querySelectorAll('.prompt-library-analysis-mode-field')).toHaveLength(3);
    });
  });

  it('lets profit review users edit report presentation without changing the calculation', () => {
    const emitChange = vi.fn();
    const onChangeField = vi.fn(() => emitChange);
    const presentation = normalizeProfitReviewPresentation();
    render(
      <PromptLibrarySimpleEditorDialog
        open
        onClose={vi.fn()}
        formError=""
        editorForm={{
          title: '订单利润与商品投入评估',
          systemPrompt: '全局分析规则',
          profitReviewPresentation: presentation,
        }}
        isProfitReviewSkill
        onChangeField={onChangeField}
        onSavePrompt={vi.fn()}
      />
    );

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['全局 Skill', '报告样式']);
    fireEvent.click(screen.getByRole('tab', { name: '报告样式' }));
    expect(screen.getByText('报告排版可以自己调整')).toBeVisible();
    expect(screen.getByRole('textbox', { name: '顶部助手名称' })).toHaveValue('经营分析助手');
    expect(screen.getByRole('switch', { name: '长段正文首行缩进两字' })).toBeChecked();

    fireEvent.click(screen.getByRole('switch', { name: '长段正文首行缩进两字' }));
    expect(onChangeField).toHaveBeenCalledWith('profitReviewPresentation');
    expect(emitChange).toHaveBeenCalledWith(expect.objectContaining({
      target: { value: expect.objectContaining({ paragraphIndent: false }) },
    }));
  });
});
