import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestLocalApi } from '../../../api/localApiClient.js';
import {
  createSmartToolImagePromptPlanRequest,
  parseSmartToolFastImagePromptPlan,
  parseSmartToolImagePromptPlan,
  runSmartToolImagePromptPlan,
} from './smartToolImagePromptPlanService.js';

it('builds and parses the compact fast planner contract without sending reference pixels to the text planner', () => {
  const request = createSmartToolImagePromptPlanRequest({
    productTitle: '黑色保温杯',
    skuFacts: '黑色·500ml',
    productImageUrls: ['https://img.example/source.png'],
    sourceImageIndexes: [2],
    imageGroup: 'main',
    generationMode: 'fast',
    skillExecutionContext: { body: '完整 Skill 规则' },
    plannerModelSelection: {
      accountId: 'text-a',
      model: 'vision-model',
      ready: true,
      capabilities: ['vision'],
    },
  });
  expect(request.generationMode).toBe('fast');
  expect(request.templateId).toBe('image-plan.v1');
  expect(request.referenceImages).toEqual([]);
  expect(request.referenceImagePolicy).toBe('deferred-to-image-model');
  expect(request.customRules).toBe('');
  expect(request.templateInput).toMatchObject({
    productTitle: '黑色保温杯',
    skuFacts: '黑色·500ml',
    imageGroup: 'main',
    sourceImageIndexes: [2],
    generationMode: 'fast',
    outputMode: 'single-execution-prompt',
    skillContext: { body: '完整 Skill 规则' },
  });

  const plan = parseSmartToolFastImagePromptPlan('EXECUTION_PROMPT: 商品居中，背景简洁。', {
    group: 'main',
    sourceImageIndexes: [2],
  });
  expect(plan).toMatchObject({
    generationMode: 'fast',
    items: [{ sourceIndex: 2, prompt: '商品居中，背景简洁。' }],
  });
});

vi.mock('../../../api/localApiClient.js', () => ({ requestLocalApi: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('smartToolImagePromptPlanService', () => {
  it('passes the complete Ozon Skill rules to planning without overriding its position rules', () => {
    const skillExecutionContext = {
      toolId: 'ozon-product-image-generation',
      systemPrompt: '完整 Ozon Skill 规则：源图中文只能作为事实参考，不能进入成图。',
      safetyRules: ['禁止中文广告'],
      qaRules: ['检查俄语拼写'],
    };
    const request = createSmartToolImagePromptPlanRequest({
      productTitle: '汽车脚垫',
      sourceImageIndexes: [0],
      productImageUrls: ['https://img.example/mat.jpg'],
      skillExecutionContext,
      plannerModelSelection: { accountId: 'text-account', model: 'gpt-5.5', ready: true },
    });

    expect(request.customRules).toBe(skillExecutionContext.systemPrompt);
    expect(request.templateInput.skillContext).toEqual(skillExecutionContext);

    const plan = parseSmartToolFastImagePromptPlan('EXECUTION_PROMPT: 保持商品真实，生成干净的 Ozon 主图。', {
      group: 'main',
      sourceImageIndexes: [0],
      skillExecutionContext,
    });
    expect(plan.globalNegativePrompt).toBe('');
    expect(plan.items[0].negativePrompt).toBe('');
    expect(plan.items[0].mustKeep).toEqual([]);
    expect(plan.items[0].mustAvoid).toEqual([]);
    expect(plan.items[0].acceptanceChecks).toEqual([]);
  });

  it('defers original images when the selected planner is text-only', () => {
    const request = createSmartToolImagePromptPlanRequest({
      productTitle: '保温杯',
      offerId: 'BX-500',
      skuFacts: '黑色 · 500ml',
      imageGroup: 'detail',
      sourceImageIndexes: [1, 3],
      imageSlotInstructions: [
        { sourceIndex: 1, title: '结构展示图', instruction: '展示真实结构' },
        { sourceIndex: 3, title: '材质细节图', instruction: '只展示已确认材质' },
      ],
      productImageUrls: ['https://img.example/1.jpg', 'https://img.example/2.jpg'],
      skillExecutionContext: { body: '完整 Skill 规则' },
      plannerModelSelection: { accountId: 'text-account', model: 'gpt-5.5', ready: true },
    });

    expect(request).toMatchObject({
      accountId: 'text-account',
      model: 'gpt-5.5',
      templateId: 'image-plan.v1',
      customRules: '',
    });
    expect(request.templateInput).toMatchObject({
      productTitle: '保温杯',
      offerId: 'BX-500',
      skuFacts: '黑色 · 500ml',
      imageGroup: 'detail',
      sourceImageIndexes: [1, 3],
      plannerReadsReferenceImages: false,
      outputMode: 'plans-json',
      skillContext: { body: '完整 Skill 规则' },
      imageSlotInstructions: [
        { sourceIndex: 1, title: '结构展示图', instruction: '展示真实结构' },
        { sourceIndex: 3, title: '材质细节图', instruction: '只展示已确认材质' },
      ],
    });
    expect(request.templateInput.outputContract.plans).toEqual([
      expect.objectContaining({ sourceIndex: 1 }),
      expect.objectContaining({ sourceIndex: 3 }),
    ]);
    expect(request.templateInput.availableReferenceImages).toEqual([
      { sourceIndex: 1, url: 'https://img.example/1.jpg' },
      { sourceIndex: 3, url: 'https://img.example/2.jpg' },
    ]);
    expect(request.referenceImageUrls).toEqual([]);
    expect(request.referenceImages).toEqual([]);
    expect(request.requestedReferenceImageCount).toBe(2);
    expect(request.referenceImagePolicy).toBe('deferred-to-image-model');
  });

  it('keeps local and inline references mapped for a vision planner', () => {
    const request = createSmartToolImagePromptPlanRequest({
      sourceImageIndexes: [0, 3],
      productImageUrls: ['/api/product-images/preview/asset-main', 'data:image/png;base64,aW1hZ2U='],
      promptConfig: { systemPrompt: '完整 Skill 规则' },
      plannerModelSelection: {
        accountId: 'vision-account',
        model: 'gpt-5.5-vision',
        ready: true,
        capabilities: ['text-generation', 'multimodal'],
        modalities: ['text', 'image'],
      },
    });

    expect(request.referenceImages).toEqual([
      { sourceIndex: 0, assetId: 'asset-main' },
      { sourceIndex: 3, dataUrl: 'data:image/png;base64,aW1hZ2U=' },
    ]);
    expect(request.templateInput.referenceImages).toEqual(request.referenceImages);
    expect(request.templateInput.sourceImageIndexes).toEqual([0, 3]);
    expect(request.templateInput.plannerReadsReferenceImages).toBe(true);
    expect(request.referenceImagePolicy).toBe('vision-planner');
  });

  it('stops before analysis when a selected image cannot be transferred', () => {
    expect(() =>
      createSmartToolImagePromptPlanRequest({
        sourceImageIndexes: [0],
        productImageUrls: ['http://unsafe.example/image.jpg'],
        promptConfig: { systemPrompt: '完整 Skill 规则' },
        plannerModelSelection: { accountId: 'text-account', model: 'gpt-5.5', ready: true },
      })
    ).toThrow('部分选中图片无法进入图片处理流程');
  });

  it('normalizes every plan row and rejects a missing selected position', () => {
    const plan = parseSmartToolImagePromptPlan(
      JSON.stringify({
        version: '1.0',
        plans: [
          {
            sourceIndex: 0,
            prompt: '主图提示词',
            negativePrompt: '不要水印',
            mustKeep: ['颜色'],
            acceptanceChecks: ['商品完整'],
          },
          { sourceIndex: 2, prompt: '第三张提示词' },
        ],
      }),
      { group: 'main', sourceImageIndexes: [0, 2] }
    );

    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]).toMatchObject({ sourceIndex: 0, negativePrompt: '不要水印', mustKeep: ['颜色'] });
    expect(() =>
      parseSmartToolImagePromptPlan('{"plans":[{"sourceIndex":0,"prompt":"only"}]}', {
        sourceImageIndexes: [0, 1],
      })
    ).toThrow('缺少位置 2');
    expect(
      parseSmartToolImagePromptPlan('{"plan":{"sourceIndex":4,"prompt":"第五张高保真改图"}}', {
        sourceImageIndexes: [4],
      }).items
    ).toEqual([expect.objectContaining({ sourceIndex: 4, prompt: '第五张高保真改图' })]);
  });

  it('keeps the protected template contract explicit for the server planner', () => {
    const request = createSmartToolImagePromptPlanRequest({
      sourceImageIndexes: [0],
      productImageUrls: ['https://img.example/source.jpg'],
      imageGroup: 'main',
      plannerModelSelection: { accountId: 'text-account', model: 'gpt-5.5', ready: true },
    });
    expect(request).toMatchObject({ templateId: 'image-plan.v1' });
    expect(request.templateInput).toMatchObject({
      imageGroup: 'main',
      sourceImageIndexes: [0],
      outputMode: 'plans-json',
    });
  });

  it('plans eight positions independently in one eight-worker wave and merges them in source order', async () => {
    let activeRequests = 0;
    let peakActiveRequests = 0;
    requestLocalApi.mockImplementation(async (_path, options) => {
      activeRequests += 1;
      peakActiveRequests = Math.max(peakActiveRequests, activeRequests);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
      activeRequests -= 1;
      return {
        ok: true,
        model: options.body.model,
        accountId: options.body.accountId,
        referenceImageCount: 0,
        requestedReferenceImageCount: options.body.requestedReferenceImageCount,
        referenceImagePolicy: 'deferred-to-image-model',
        planText: JSON.stringify({
          version: '1.0',
          globalNegativePrompt: '不要水印',
          plans: options.body.sourceImageIndexes.map((sourceIndex) => ({
            sourceIndex,
            purpose: `位置 ${sourceIndex + 1}`,
            prompt: `提示词 ${sourceIndex + 1}`,
          })),
        }),
      };
    });

    const sourceImageIndexes = [0, 1, 2, 3, 4, 5, 6, 7];
    const productImageUrls = sourceImageIndexes.map((index) => `https://img.example/${index + 1}.jpg`);
    const result = await runSmartToolImagePromptPlan({
      sourceImageIndexes,
      productImageUrls,
      imageGroup: 'main',
      promptConfig: { systemPrompt: '完整 Skill 规则' },
      plannerModelSelection: { accountId: 'text-account', model: 'gpt-5.5', ready: true },
    });

    expect(requestLocalApi).toHaveBeenCalledTimes(8);
    expect(requestLocalApi.mock.calls.map(([, options]) => options.body.sourceImageIndexes)).toEqual([
      [0],
      [1],
      [2],
      [3],
      [4],
      [5],
      [6],
      [7],
    ]);
    expect(peakActiveRequests).toBe(8);
    expect(requestLocalApi.mock.calls.every(([, options]) => options.body.referenceImages.length === 0)).toBe(true);
    expect(result.items.map((item) => item.sourceIndex)).toEqual(sourceImageIndexes);
    expect(result).toMatchObject({
      batchCount: 8,
      requestedReferenceImageCount: 8,
      referenceImagePolicy: 'deferred-to-image-model',
      globalNegativePrompt: '不要水印',
    });
  });

  it('stops the image job when any selected position is missing instead of using fixed-rule fallback', async () => {
    requestLocalApi.mockImplementation(async (_path, options) => {
      const [sourceIndex] = options.body.sourceImageIndexes;
      if (sourceIndex === 2 || sourceIndex === 3) {
        throw new Error('分析模型响应超时，原图仍然保留，请稍后重试或更换分析模型。');
      }
      return {
        ok: true,
        model: options.body.model,
        accountId: options.body.accountId,
        referenceImageCount: 0,
        requestedReferenceImageCount: 1,
        referenceImagePolicy: 'deferred-to-image-model',
        planText: JSON.stringify({
          version: '1.0',
          plans: [{ sourceIndex, prompt: `提示词 ${sourceIndex + 1}` }],
        }),
      };
    });

    const sourceImageIndexes = [0, 1, 2, 3];
    await expect(
      runSmartToolImagePromptPlan({
        sourceImageIndexes,
        productImageUrls: sourceImageIndexes.map((index) => `https://img.example/${index + 1}.jpg`),
        imageGroup: 'main',
        promptConfig: { systemPrompt: '完整 Skill 规则' },
        plannerModelSelection: { accountId: 'text-account', model: 'gpt-5.5', ready: true },
        imageSlotInstructions: [
          { sourceIndex: 2, title: '材质细节特写图', instruction: '保持真实细节特写' },
          { sourceIndex: 3, title: '真实使用场景图', instruction: '放入真实汽车使用场景' },
        ],
      })
    ).rejects.toThrow(/未完整生成.*停止生图.*不会改用默认规则.*3、4/u);
    expect(requestLocalApi).toHaveBeenCalledTimes(4);
  });
});
