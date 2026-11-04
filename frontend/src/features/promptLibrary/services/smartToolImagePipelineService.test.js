import { describe, expect, it, vi } from 'vitest';

import {
  createSmartToolImagePipelineInput,
  prepareSmartToolImageGenerationPipeline,
} from './smartToolImagePipelineService.js';

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('smartToolImagePipelineService', () => {
  it('builds one canonical Smart Tool input without dropping the private Skill or multiline position rules', () => {
    const skill = {
      id: 'ozon-product-image-generation',
      title: 'Ozon 商品图生成',
      promptConfig: {
        systemPrompt: '完整 Skill 系统规则',
        imagePositionRules: {
          main: [
            {
              sourceIndex: 0,
              purpose: '俄文场景卖点图',
              instructions: '真实汽车雨天使用场景',
              visibleText: '自然俄语标题和短标签',
              mustAvoid: '禁止中文广告字',
            },
          ],
        },
      },
    };

    const input = createSmartToolImagePipelineInput({
      shopId: 'shop-a',
      sourceImageIndexes: [0],
      productImageUrls: ['https://img.example/source.png'],
      imageGroup: 'main',
    }, skill);

    expect(input).toMatchObject({
      skill,
      group: 'main',
      imageGroup: 'main',
      count: 1,
      productImageUrl: 'https://img.example/source.png',
      productImageUrls: ['https://img.example/source.png'],
      skillExecutionContext: {
        toolId: 'ozon-product-image-generation',
        systemPrompt: '完整 Skill 系统规则',
      },
      imageSlotInstructions: [
        {
          sourceIndex: 0,
          title: '俄文场景卖点图',
          instruction: expect.stringMatching(/真实汽车雨天使用场景\n画面文字：自然俄语标题和短标签\n禁止内容：禁止中文广告字/u),
        },
      ],
    });
    expect(input.promptConfig).not.toHaveProperty('systemPrompt');
  });

  it('keeps full rules, Russian copy, scene, size and quality in the compiled fast-start plan', async () => {
    const runPromptPlan = vi.fn();
    const runGenerationBatch = vi.fn().mockResolvedValue({
      count: 1,
      items: [{ sourceIndex: 0, status: 'success', imageUrl: 'https://img.example/generated.png' }],
      successCount: 1,
      failedCount: 0,
    });
    const prepared = await prepareSmartToolImageGenerationPipeline(
      {
        shopId: 'shop-a',
        sourceImageIndexes: [0],
        productImageUrls: ['https://img.example/source.png'],
        imageSize: '1008x1344',
        imageQuality: 'high',
        targetScene: '俄罗斯真实汽车使用场景',
        promptConfig: {
          imagePositionRules: {
            main: [
              {
                sourceIndex: 0,
                purpose: 'SKU 专属主卖点图',
                instructions: '商品位于真实车内脚垫区域',
                visibleText: '使用自然俄语标题和短标签',
                mustAvoid: '不得使用纯白空背景',
              },
            ],
          },
        },
        skillExecutionContext: { safetyRules: ['不得改变商品材质与结构'] },
      },
      1,
      { planStrategy: 'compiled', runPromptPlan, runGenerationBatch }
    );
    await prepared.generationPromise;

    expect(runPromptPlan).not.toHaveBeenCalled();
    expect(runGenerationBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        imageSize: '1008x1344',
        imageQuality: 'high',
        promptPlan: expect.objectContaining({
          version: 'compiled-skill-1.0',
          globalNegativePrompt: '不得改变商品材质与结构',
          items: [
            expect.objectContaining({
              sourceIndex: 0,
              prompt: expect.stringMatching(/真实车内脚垫区域.*自然俄语.*俄罗斯真实汽车使用场景/su),
              negativePrompt: expect.stringMatching(/纯白空背景.*不得改变商品材质与结构/su),
            }),
          ],
        }),
      }),
      1,
      expect.objectContaining({ onItemSettled: expect.any(Function) })
    );
  });

  it('starts each full-rule image request before the remaining position plans finish', async () => {
    const firstGenerationStarted = deferred();
    const events = [];
    const batch = (sourceIndex) => ({
      shopId: 'shop-a',
      sourceImageIndexes: [sourceIndex],
      productImageUrls: [`https://img.example/${sourceIndex}.png`],
      imageSize: '1008x1344',
      imageQuality: 'high',
      skillExecutionContext: { systemPrompt: '完整 Skill，不得删减' },
    });
    const plan = (sourceIndex) => ({
      ok: true,
      items: [{ sourceIndex, prompt: `位置 ${sourceIndex + 1} 的完整俄文场景方案` }],
      plannerFallbackCount: 0,
    });
    const runPromptPlan = vi.fn(async (_input, options) => {
      options.onBatchResolved({ input: batch(0), plan: plan(0), sourceImageIndexes: [0] });
      await firstGenerationStarted.promise;
      events.push('planner-still-running');
      options.onBatchResolved({ input: batch(1), plan: plan(1), sourceImageIndexes: [1] });
      events.push('planner-complete');
      return {
        ok: true,
        items: [...plan(0).items, ...plan(1).items],
        plannerFallbackCount: 0,
      };
    });
    const runGenerationBatch = vi.fn(async (input) => {
      const sourceIndex = input.sourceImageIndexes[0];
      events.push(`generation-${sourceIndex}-start`);
      if (sourceIndex === 0) firstGenerationStarted.resolve();
      return {
        count: 1,
        items: [{ sourceIndex, status: 'success', imageUrl: `https://img.example/generated-${sourceIndex}.png` }],
        successCount: 1,
        failedCount: 0,
      };
    });

    const prepared = await prepareSmartToolImageGenerationPipeline(
      {
        shopId: 'shop-a',
        sourceImageIndexes: [0, 1],
        productImageUrls: ['https://img.example/0.png', 'https://img.example/1.png'],
        imageSize: '1008x1344',
        imageQuality: 'high',
        skillExecutionContext: { systemPrompt: '完整 Skill，不得删减' },
      },
      2,
      { runPromptPlan, runGenerationBatch }
    );
    const result = await prepared.generationPromise;

    expect(events.indexOf('generation-0-start')).toBeLessThan(events.indexOf('planner-complete'));
    expect(runGenerationBatch).toHaveBeenCalledTimes(2);
    expect(runGenerationBatch.mock.calls[0][0]).toMatchObject({
      imageSize: '1008x1344',
      imageQuality: 'high',
      skillExecutionContext: { systemPrompt: '完整 Skill，不得删减' },
      promptPlan: { items: [{ sourceIndex: 0, prompt: expect.stringContaining('完整俄文场景方案') }] },
    });
    expect(result).toMatchObject({ count: 2, successCount: 2, failedCount: 0 });
    expect(result.items.map((item) => item.sourceIndex)).toEqual([0, 1]);
  });
});
