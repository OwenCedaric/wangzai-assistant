import { describe, expect, it } from 'vitest';
import {
  createSmartToolImageExecutionContext,
  createSmartToolImageSlotDefinitions,
  isSmartToolProductImageWorkbench,
  resolveSmartToolWorkbench,
  SMART_TOOL_WORKBENCH_KIND,
  SMART_TOOL_WORKBENCH_MODULE,
} from './smartToolWorkbenchRegistry.js';

describe('smartToolWorkbenchRegistry', () => {
  it('routes every installed image-capable Skill into the product content workbench', () => {
    const workbench = resolveSmartToolWorkbench({
      id: 'installed-random-skill-id',
      title: '任意商品图片 Skill',
      body: 'Create listing copy and product images.',
      skillProfile: {
        installType: 'github-skill',
        apiBindings: [
          { id: 'model.text.generate', label: '文本模型', access: 'read' },
          { id: 'model.image.generate', label: '图片模型', access: 'read' },
          { id: 'product-image-storage', label: '图片安全存储', access: 'read' },
        ],
      },
    });

    expect(workbench.kind).toBe(SMART_TOOL_WORKBENCH_KIND.PRODUCT_CONTENT);
    expect(workbench.modules).toContain(SMART_TOOL_WORKBENCH_MODULE.IMAGE_SLOTS);
    expect(workbench.modules).toContain(SMART_TOOL_WORKBENCH_MODULE.LISTING_FIELDS);
    expect(workbench.requiresExplicitImageSelection).toBe(true);
    expect(isSmartToolProductImageWorkbench(workbench)).toBe(true);
  });

  it('extracts Skill image jobs and maps every real product image position', () => {
    const workbench = resolveSmartToolWorkbench({
      id: 'installed-card-skill',
      body: [
        '1. **Primary/CTR image**: Show the truthful product.',
        '2. **Structure image**: Show product construction.',
        '3. **Function/use image**: Show real use.',
      ].join('\n'),
      skillProfile: {
        installType: 'skill-md',
        apiBindings: [{ id: 'model.image.generate', label: '图片模型', access: 'read' }],
        referenceFiles: [
          {
            path: 'references/image-set.md',
            content: 'Every slot must preserve product identity and use exact verified copy.',
          },
        ],
      },
    });
    const slots = createSmartToolImageSlotDefinitions(workbench, 'main', 5, { sku: 'SKU-1' });

    expect(slots).toHaveLength(5);
    expect(slots.map((item) => item.title)).toEqual([
      '首图 / 点击图',
      '结构展示图',
      '功能使用图',
      'SKU 图位置 4',
      'SKU 图位置 5',
    ]);
    expect(slots.every((item, index) => item.sourceIndex === index)).toBe(true);
    expect(workbench.imageExecutionContext.referenceFiles).toContainEqual(
      expect.objectContaining({
        path: 'references/image-set.md',
        content: expect.stringContaining('preserve product identity'),
      })
    );
    expect(workbench.imageExecutionContext.imageSlots[0]).toEqual(
      expect.objectContaining({ sourceIndex: 0, title: '首图 / 点击图', instruction: 'Show the truthful product.' })
    );
  });

  it('uses saved installed-Skill position rules in the real generation slots', () => {
    const workbench = resolveSmartToolWorkbench({
      id: 'installed-image-rule-skill',
      body: 'Create product images.',
      skillProfile: {
        installType: 'skill-md',
        apiBindings: [{ id: 'model.image.generate', label: '图片模型', access: 'read' }],
      },
      promptConfig: {
        imagePositionRules: {
          main: [
            {
              sourceIndex: 0,
              purpose: '俄罗斯场景首图',
              instructions: '突出商品主体',
              visibleText: '俄语短标题',
              mustAvoid: '禁止虚构参数',
            },
          ],
          detail: [],
        },
      },
    });

    const [slot] = createSmartToolImageSlotDefinitions(workbench, 'main', 1);
    expect(slot.title).toBe('俄罗斯场景首图');
    expect(slot.instruction).toContain('突出商品主体');
    expect(slot.instruction).toContain('画面文字：俄语短标题');
    expect(slot.instruction).toContain('禁止内容：禁止虚构参数');
  });

  it('uses parsed structured rules before regex fallback and carries SKU, evidence, QA and stop rules into execution', () => {
    const workbench = resolveSmartToolWorkbench({
      id: 'installed-structured-image-skill',
      body: '1. **错误的旧图片位**: 不应覆盖结构化解析结果。',
      skillProfile: {
        installType: 'skill-md',
        apiBindings: [{ id: 'model.image.generate', label: '图片模型', access: 'read' }],
        imageJobs: [
          {
            sourceIndex: 0,
            purpose: '解析后的首图',
            sourceTitle: 'Hero image',
            instructions: '完整展示商品',
          },
        ],
        skuImageRules: ['每个 SKU 使用自己的颜色图'],
        evidenceRules: ['尺寸必须有权威来源'],
        qaRules: ['检查俄语拼写'],
        stopConditions: ['缺少身份图时停止'],
      },
      promptConfig: {
        imagePositionRules: {
          main: [{ sourceIndex: 0, purpose: '解析后的首图', instructions: '完整展示商品' }],
          detail: [],
        },
      },
    });

    expect(workbench.imageJobs).toEqual([
      expect.objectContaining({ position: 0, title: '解析后的首图', instruction: '完整展示商品' }),
    ]);
    expect(workbench.imageExecutionContext).toMatchObject({
      skuImageRules: ['每个 SKU 使用自己的颜色图'],
      evidenceRules: ['尺寸必须有权威来源'],
      qaRules: ['检查俄语拼写'],
      stopConditions: ['缺少身份图时停止'],
    });
  });

  it('keeps non-image Skills in the standard workbench', () => {
    const workbench = resolveSmartToolWorkbench({
      id: 'installed-text-skill',
      body: 'Summarize a report.',
      skillProfile: {
        installType: 'skill-md',
        apiBindings: [{ id: 'model.text.generate', label: '文本模型', access: 'read' }],
      },
    });
    expect(workbench.kind).toBe(SMART_TOOL_WORKBENCH_KIND.STANDARD);
    expect(workbench.supportsImages).toBe(false);
    expect(isSmartToolProductImageWorkbench(workbench)).toBe(false);
  });

  it('never applies the installed-Skill workbench contract to a native image tool', () => {
    const workbench = resolveSmartToolWorkbench({
      id: 'ozon-product-image-generation',
      title: 'Ozon 商品图生成',
      body: '生成商品图片',
      skillProfile: {
        apiBindings: [{ id: 'model.image.generate', label: '图片模型', access: 'read' }],
      },
    });

    expect(workbench.kind).toBe(SMART_TOOL_WORKBENCH_KIND.STANDARD);
    expect(workbench.modules).toEqual([]);
    expect(workbench.supportsImages).toBe(false);
    expect(workbench.imageJobs).toEqual([]);
    expect(isSmartToolProductImageWorkbench(workbench)).toBe(false);
  });

  it('builds the native Ozon image execution context from the complete saved Skill rules', () => {
    const context = createSmartToolImageExecutionContext({
      id: 'ozon-product-image-generation',
      title: 'Ozon 商品图生成',
      body: '按真实商品资料生成 Ozon 商品图。',
      promptConfig: {
        systemPrompt: '完整 Ozon 生图系统规则',
        workflowSteps: ['先锁定商品身份', '再逐图生成'],
        outputRules: ['每张图必须逐项验收'],
        safetyRules: ['禁止复制源图中文广告'],
        imagePositionRules: {
          main: [{ sourceIndex: 0, purpose: '首图', instructions: '只展示真实商品' }],
          detail: [],
        },
      },
      skillProfile: {
        qaRules: ['检查画面不得出现中文'],
        stopConditions: ['商品身份无法确认时停止'],
      },
    });

    expect(context).toMatchObject({
      policyVersion: 'ozon-product-image-rules-2.0.7',
      toolId: 'ozon-product-image-generation',
      systemPrompt: '完整 Ozon 生图系统规则',
      workflowSteps: ['先锁定商品身份', '再逐图生成'],
      outputRules: ['每张图必须逐项验收'],
      safetyRules: ['禁止复制源图中文广告'],
      qaRules: ['检查画面不得出现中文'],
      stopConditions: ['商品身份无法确认时停止'],
    });
    expect(context.imageSlots[0]).toMatchObject({
      sourceIndex: 0,
      title: '首图',
      instruction: '只展示真实商品',
    });
  });
});
