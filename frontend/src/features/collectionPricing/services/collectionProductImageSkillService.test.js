import { describe, expect, it, vi } from 'vitest';

import {
  buildCollectionProductImageSkillFacts,
  getDefaultCollectionProductImageSkill,
  runCollectionProductImageSkillBatch,
} from './collectionProductImageSkillService.js';

describe('collectionProductImageSkillService', () => {
  it('loads the complete default Ozon image skill configuration', () => {
    const skill = getDefaultCollectionProductImageSkill();
    expect(skill).toMatchObject({ id: 'ozon-product-image-generation', title: 'Ozon 商品图生成' });
    expect(skill.promptConfig.systemPrompt).toBe('');
    expect(skill.promptConfig.workflowSteps.length).toBeGreaterThan(0);
    expect(skill.promptConfig.outputRules.length).toBeGreaterThan(0);
    expect(skill.promptConfig.safetyRules.length).toBeGreaterThan(0);
    expect(skill.promptConfig.imagePositionRules.main.length).toBeGreaterThan(5);
    expect(skill.promptConfig.imagePositionRules.detail.length).toBeGreaterThan(5);
  });

  it('reuses the canonical Smart Tool input and passes the complete Skill rules into generation', async () => {
    const defaultSkill = getDefaultCollectionProductImageSkill();
    const skill = {
      ...defaultSkill,
      promptConfig: {
        ...defaultSkill.promptConfig,
        systemPrompt: '完整 Skill 系统规则',
      },
    };
    const publicPromptConfig = { ...skill.promptConfig };
    delete publicPromptConfig.systemPrompt;
    const plan = {
      items: [{ sourceIndex: 2, prompt: '逐图方案' }],
      plannerFallbackCount: 0,
    };
    const runPromptPlan = vi.fn().mockResolvedValue(plan);
    const runGenerationBatch = vi.fn().mockResolvedValue({
      count: 1,
      items: [{ sourceIndex: 2, status: 'success', imageUrl: 'https://img.example/generated.png' }],
      successCount: 1,
      failedCount: 0,
    });
    const phases = [];

    const result = await runCollectionProductImageSkillBatch(
      {
        skill,
        shopId: 'shop-a',
        productTitle: 'Очки',
        productImageUrls: ['https://img.example/source.png'],
        sourceImageIndexes: [2],
        imageGroup: 'main',
        plannerModelSelection: { accountId: 'text-a', model: 'gpt-text', ready: true },
        modelSelection: { accountId: 'image-a', model: 'gpt-image', ready: true },
      },
      {
        runPromptPlan,
        runGenerationBatch,
        planStrategy: 'remote',
        onPhase: (value) => phases.push(value.phase),
      }
    );

    expect(runPromptPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: 'shop-a',
        persistGeneratedAsset: true,
        promptConfig: publicPromptConfig,
        productImageUrl: 'https://img.example/source.png',
        count: 1,
        sourceImageIndexes: [2],
        skillExecutionContext: expect.objectContaining({
          toolId: 'ozon-product-image-generation',
          systemPrompt: '完整 Skill 系统规则',
          safetyRules: expect.any(Array),
          outputRules: expect.any(Array),
        }),
        imageSlotInstructions: expect.arrayContaining([expect.objectContaining({ sourceIndex: 2 })]),
      }),
      expect.objectContaining({ onBatchResolved: expect.any(Function) })
    );
    expect(runGenerationBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: 'shop-a',
        persistGeneratedAsset: true,
        promptConfig: publicPromptConfig,
        promptPlan: plan,
        skillExecutionContext: expect.objectContaining({
          toolId: 'ozon-product-image-generation',
        }),
      }),
      1,
      expect.objectContaining({ onItemSettled: expect.any(Function) })
    );
    expect(phases).toEqual(['planning', 'generating', 'complete']);
    expect(result).toMatchObject({
      skillId: 'ozon-product-image-generation',
      successCount: 1,
      promptPlan: plan,
    });
  });

  it('does not call the image model when the planner did not return every selected position', async () => {
    const skill = getDefaultCollectionProductImageSkill();
    const runPromptPlan = vi.fn().mockResolvedValue({
      ok: false,
      items: [{ sourceIndex: 0, prompt: '第一张方案' }],
      plannerFallbackCount: 1,
      failedSourceIndexes: [1],
    });
    const runGenerationBatch = vi.fn();

    await expect(
      runCollectionProductImageSkillBatch(
        {
          skill,
          shopId: 'shop-a',
          productImageUrls: ['https://img.example/one.png', 'https://img.example/two.png'],
          sourceImageIndexes: [0, 1],
          imageGroup: 'main',
        },
        { runPromptPlan, runGenerationBatch, planStrategy: 'remote' }
      )
    ).rejects.toThrow(/未完整生成.*停止生图.*不会改用默认规则/u);
    expect(runGenerationBatch).not.toHaveBeenCalled();
  });

  it('builds image facts only from the current collected product and selected positions', () => {
    const facts = buildCollectionProductImageSkillFacts({
      product: {
        platform: '1688',
        title: '黑色金属眼镜',
        sourceCategoryPath: '眼镜 > 平光镜',
        attributes: [{ name: '材质', value: '金属' }],
      },
      draft: { skus: [{ enabled: true, sourceSkuName: '黑色-4个' }, { enabled: false }] },
      group: 'main',
      rows: [{ label: '主图 1' }, { label: '主图 2' }],
      selectedIndexes: [1],
    });

    expect(facts).toContain('来源平台：1688');
    expect(facts).toContain('来源商品原始标题：黑色金属眼镜');
    expect(facts).toContain('选中图片：主图 2');
    expect(facts).toContain('可售 SKU 种类数：1');
    expect(facts).toContain('不是任何一张图片应显示的商品件数');
    expect(facts).toContain('不得从 Ozon 标题、SKU 列表或包装文案推断画面数量');
    expect(facts).toContain('材质：金属');
  });
});
