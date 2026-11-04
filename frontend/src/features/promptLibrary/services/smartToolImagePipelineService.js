import { assertSmartToolImageNotAborted, runSmartToolImageGenerationBatch, validateSmartToolImageSourceIndexes } from './smartToolImageGenerationService.js';
import {
  assertCompleteSmartToolImagePromptPlan,
  runSmartToolImagePromptPlan,
} from './smartToolImagePromptPlanService.js';
import { normalizeSmartToolImageGenerationMode } from './smartToolImageGenerationMode.js';
import { createSmartToolImageExecutionContext } from '../lib/smartToolWorkbenchRegistry.js';

function text(value) {
  return String(value ?? '').trim();
}

function normalizeCount(value, fallback = 1) {
  const count = Number(value);
  if (!Number.isFinite(count)) return fallback;
  return Math.min(30, Math.max(1, Math.round(count)));
}

function expectedSourceIndexes(input = {}, count = 1) {
  const selected = validateSmartToolImageSourceIndexes(input.sourceImageIndexes || []);
  if (selected.length) return selected.slice(0, count);
  return Array.from({ length: count }, (_, index) => index);
}

function list(value) {
  return (Array.isArray(value) ? value : []).map(text).filter(Boolean);
}

function normalizeImageGroup(input = {}) {
  return input.imageGroup === 'detail' || input.group === 'detail' ? 'detail' : 'main';
}

/**
 * Builds the canonical image input shared by the Smart Tool workbench and all
 * feature entry points that reuse it. The complete Skill remains in the
 * execution context while the duplicate client prompt is removed from the
 * public prompt config, matching the native Smart Tool execution path.
 */
export function createSmartToolImagePipelineInput(input = {}, selectedSkill = null) {
  const skill = selectedSkill || input.skill || null;
  const imageGroup = normalizeImageGroup(input);
  const sourceImageIndexes = validateSmartToolImageSourceIndexes(input.sourceImageIndexes || []);
  const productImageUrls = (Array.isArray(input.productImageUrls) ? input.productImageUrls : [])
    .map(text);
  if (productImageUrls.some(value => !value) || (sourceImageIndexes.length && productImageUrls.length && sourceImageIndexes.length !== productImageUrls.length)) {
    throw new Error('选中图片与来源位置不一一对应，不能过滤后移动图片位置。');
  }
  const count = sourceImageIndexes.length || productImageUrls.length || normalizeCount(input.count);
  const promptConfig = {
    ...((input.promptConfig && typeof input.promptConfig === 'object' ? input.promptConfig : null)
      || skill?.promptConfig
      || {}),
  };
  delete promptConfig.systemPrompt;
  const skillExecutionContext = input.skillExecutionContext
    || (skill ? createSmartToolImageExecutionContext(skill) : null);
  const executionSlots = imageGroup === 'detail'
    ? skillExecutionContext?.detailImageSlots
    : skillExecutionContext?.imageSlots;
  const providedSlotInstructions = Array.isArray(input.imageSlotInstructions)
    ? input.imageSlotInstructions
    : [];
  const imageSlotInstructions = providedSlotInstructions.length
    ? providedSlotInstructions
    : sourceImageIndexes.map((sourceIndex) => {
        const slot = (Array.isArray(executionSlots) ? executionSlots : []).find(
          (item) => Number(item?.sourceIndex) === sourceIndex
        );
        return {
          sourceIndex,
          title: text(slot?.title) || `${imageGroup === 'detail' ? '详情图' : '主图'}位置 ${sourceIndex + 1}`,
          instruction: text(slot?.instruction),
        };
      });

  return {
    ...input,
    ...(skill ? { skill } : {}),
    group: imageGroup,
    imageGroup,
    count,
    promptConfig,
    skillExecutionContext,
    imageSlotInstructions,
    sourceImageIndexes,
    productImageUrls,
    productImageUrl: text(input.productImageUrl) || productImageUrls[0] || '',
  };
}

function selectedPositionRule(input = {}, sourceIndex) {
  const group = input.imageGroup === 'detail' ? 'detail' : 'main';
  const rules = input.promptConfig?.imagePositionRules?.[group];
  return (
    (Array.isArray(rules) ? rules : []).find((item, index) => {
      const explicit = Number(item?.sourceIndex);
      const legacy = Number(item?.position);
      const normalized =
        Number.isInteger(explicit) && explicit >= 0
          ? explicit
          : Number.isInteger(legacy) && legacy > 0
            ? legacy - 1
            : index;
      return normalized === sourceIndex;
    }) || {}
  );
}

function selectedSlotInstruction(input = {}, sourceIndex) {
  return (
    (Array.isArray(input.imageSlotInstructions) ? input.imageSlotInstructions : []).find(
      (item) => Number(item?.sourceIndex) === sourceIndex
    ) || {}
  );
}

export function compileSmartToolImagePromptPlan(input = {}, count = 1) {
  const indexes = expectedSourceIndexes(input, normalizeCount(count));
  const skill = input.skillExecutionContext || {};
  const safetyRules = list(skill.safetyRules);
  const stopConditions = list(skill.stopConditions);
  const globalNegativePrompt = [...new Set([...safetyRules, ...stopConditions])].join('\n');
  return {
    ok: true,
    partial: false,
    version: 'compiled-skill-1.0',
    group: input.imageGroup === 'detail' ? 'detail' : 'main',
    globalNegativePrompt,
    items: indexes.map((sourceIndex) => {
      const position = selectedPositionRule(input, sourceIndex);
      const slot = selectedSlotInstruction(input, sourceIndex);
      const purpose = text(slot.title || position.purpose) || `图片位置 ${sourceIndex + 1}`;
      const instruction =
        text(slot.instruction) ||
        [position.instructions, position.visibleText, position.mustAvoid].map(text).filter(Boolean).join('\n');
      const positionAvoid = text(position.mustAvoid);
      return {
        sourceIndex,
        purpose,
        prompt: [
          `严格执行当前 Ozon 商品图 Skill 的“${purpose}”位置规则。`,
          instruction,
          text(input.targetScene) ? `目标场景：${text(input.targetScene)}。` : '',
          '画面允许出现文字时，必须使用自然、简短、清晰可读的俄语；不得把源图中文广告文案复制到成品图。',
          '商品身份、SKU、外形、颜色、材质、结构、数量和配件必须与当前位置绑定的参考图一致。',
        ]
          .filter(Boolean)
          .join('\n'),
        negativePrompt: [positionAvoid, globalNegativePrompt].filter(Boolean).join('\n'),
        mustKeep: [
          '当前位置绑定参考图中的商品身份、外形、颜色、材质、结构、数量、比例和配件',
          text(input.skuFacts),
        ].filter(Boolean),
        mustAvoid: [...new Set([positionAvoid, ...safetyRules, ...stopConditions].filter(Boolean))],
        acceptanceChecks: [
          `画面完成“${purpose}”这一唯一职责`,
          '商品与当前位置参考图一致，没有新增、删除、复制或替换商品及配件',
          '场景符合商品真实用途且商品仍是清晰主体',
          '所有可见营销文字均为自然、清晰、可读的俄语',
        ],
      };
    }),
    raw: { source: 'deterministic-skill-compiler' },
    model: text(input.plannerModelSelection?.model),
    accountId: text(input.plannerModelSelection?.accountId),
    referenceImageCount: 0,
    requestedReferenceImageCount: indexes.length,
    referenceImagePolicy: 'deferred-to-image-model',
    usage: [],
    batchCount: 0,
    plannerFallbackCount: 0,
    failedSourceIndexes: [],
    plannerFailures: [],
    generationMode: normalizeSmartToolImageGenerationMode(input.generationMode),
  };
}

function createGenerationFailureItems(sourceImageIndexes = [], reason) {
  const message = reason instanceof Error ? reason.message : String(reason || '图片生成失败');
  return sourceImageIndexes.map((sourceIndex, index) => ({
    index,
    sourceIndex,
    status: 'error',
    message,
  }));
}

function mergeGenerationBatches(settled = [], descriptors = [], input = {}, count = 1) {
  const indexes = expectedSourceIndexes(input, count);
  const itemsBySourceIndex = new Map();
  let fallbackCount = 0;
  settled.forEach((entry, batchIndex) => {
    const descriptor = descriptors[batchIndex] || {};
    if (entry.status === 'fulfilled') {
      fallbackCount += Number(entry.value?.fallbackCount) || 0;
      (Array.isArray(entry.value?.items) ? entry.value.items : []).forEach((item) => {
        const sourceIndex = Number(item?.sourceIndex);
        if (Number.isInteger(sourceIndex)) itemsBySourceIndex.set(sourceIndex, item);
      });
      return;
    }
    createGenerationFailureItems(descriptor.sourceImageIndexes, entry.reason).forEach((item) => {
      itemsBySourceIndex.set(item.sourceIndex, item);
    });
  });
  const items = indexes.map((sourceIndex, index) => ({
    ...(itemsBySourceIndex.get(sourceIndex) || {
      sourceIndex,
      status: 'error',
      message: '图片生成任务没有返回结果。',
    }),
    index,
    sourceIndex,
  }));
  const successCount = items.filter((item) => item.status === 'success' && text(item.imageUrl)).length;
  return {
    count: indexes.length,
    items,
    successCount,
    failedCount: indexes.length - successCount,
    fallbackCount,
    generationMode: normalizeSmartToolImageGenerationMode(input.generationMode),
  };
}

/**
 * Starts each image request as soon as that position's complete Skill plan is
 * available. The planner model, full Skill context, source image, size and
 * quality remain unchanged; only the two remote waits are overlapped.
 */
export async function prepareSmartToolImageGenerationPipeline(input = {}, count = 1, options = {}) {
  const runPromptPlan = options.runPromptPlan || runSmartToolImagePromptPlan;
  const runGenerationBatch = options.runGenerationBatch || runSmartToolImageGenerationBatch;
  const planOptions = options.planOptions || {};
  const generationOptions = options.generationOptions || {};
  const signals = [...new Set([options.signal, planOptions.signal, generationOptions.signal].filter(Boolean))];
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  assertSmartToolImageNotAborted(signal);
  const indexes = expectedSourceIndexes(input, normalizeCount(count));
  const globalIndexBySource = new Map(indexes.map((sourceIndex, index) => [sourceIndex, index]));
  const descriptors = [];
  const createGenerationPromise = () => {
    const promise = Promise.allSettled(descriptors.map(item => item.promise)).then(settled => {
      assertSmartToolImageNotAborted(signal);
      return mergeGenerationBatches(settled, descriptors, input, indexes.length);
    });
    void promise.catch(() => undefined);
    return promise;
  };

  const startGeneration = ({ input: batchInput, plan, sourceImageIndexes }) => {
    assertSmartToolImageNotAborted(signal);
    const batchIndexes = Array.isArray(sourceImageIndexes) ? sourceImageIndexes : [];
    if (!batchIndexes.length) return;
    const descriptor = {
      sourceImageIndexes: batchIndexes,
      promise: Promise.resolve().then(() => {
        assertSmartToolImageNotAborted(signal);
        return runGenerationBatch({ ...batchInput, promptPlan: plan }, batchIndexes.length, {
          ...generationOptions,
          signal,
          onItemSettled: (item) => {
            if (signal?.aborted) return;
            const sourceIndex = Number(item?.sourceIndex);
            options.onItemSettled?.({
              ...item,
              index: globalIndexBySource.get(sourceIndex) ?? item?.index ?? 0,
              sourceIndex,
            });
          },
        });
      }),
    };
    // Attach a rejection handler immediately. A later planner failure must not
    // leave an already-started image request as an unhandled promise rejection.
    descriptor.promise.catch(() => undefined);
    descriptors.push(descriptor);
  };

  let promptPlan;
  if (options.planStrategy === 'compiled') {
    promptPlan = compileSmartToolImagePromptPlan(input, indexes.length);
    assertCompleteSmartToolImagePromptPlan(promptPlan, indexes);
    startGeneration({ input, plan: promptPlan, sourceImageIndexes: indexes });
    return {
      promptPlan,
      generationPromise: createGenerationPromise(),
      pipelined: true,
      planStrategy: 'compiled',
    };
  }
  try {
    promptPlan = await runPromptPlan(input, {
      ...planOptions,
      signal,
      onBatchResolved: (payload) => {
        assertSmartToolImageNotAborted(signal);
        planOptions.onBatchResolved?.(payload);
        startGeneration(payload);
      },
    });
    assertSmartToolImageNotAborted(signal);
    assertCompleteSmartToolImagePromptPlan(promptPlan, indexes);
  } catch (error) {
    if (!signal?.aborted) await Promise.allSettled(descriptors.map((item) => item.promise));
    throw error;
  }

  // Test doubles and alternate planners may not expose per-position callbacks.
  // They retain the original full-plan-then-generate behavior.
  if (!descriptors.length) {
    startGeneration({ input, plan: promptPlan, sourceImageIndexes: indexes });
  }

  const generationPromise = createGenerationPromise();
  return {
    promptPlan,
    generationPromise,
    pipelined: descriptors.length > 1,
    planStrategy: 'remote',
  };
}

export { mergeGenerationBatches };
