import { requestLocalApi } from '../../../api/localApiClient.js';
import {
  SMART_TOOL_IMAGE_GENERATION_MODE_FAST,
  normalizeSmartToolImageGenerationMode,
} from './smartToolImageGenerationMode.js';
import {
  assertSmartToolImageNotAborted,
  readSmartToolImageAssetOwner,
  resolveSmartToolImageAssetReference,
  validateSmartToolImageSourceIndexes,
} from './smartToolImageGenerationService.js';

// The full Skill prompt is intentionally kept intact. One output position per
// request prevents long multi-position responses, while eight independent
// workers let a normal eight-image job finish its planning in one wave.
const IMAGE_PLAN_BATCH_SIZE = 1;
const IMAGE_PLAN_BATCH_CONCURRENCY = 8;

function text(value) {
  return String(value ?? '').trim();
}

function compactText(value, maximum = 1_200) {
  const normalized = text(value).replace(/\s+/gu, ' ');
  return normalized.length > maximum ? `${normalized.slice(0, maximum)}…` : normalized;
}

function list(value) {
  return (Array.isArray(value) ? value : []).map(text).filter(Boolean);
}

function createPlannerCustomRules(skillExecutionContext = null) {
  if (!skillExecutionContext || typeof skillExecutionContext !== 'object') return '';
  const fullSystemPrompt = text(skillExecutionContext.systemPrompt);
  if (fullSystemPrompt) return fullSystemPrompt.slice(0, 12_000);
  return [
    ...list(skillExecutionContext.workflowSteps),
    ...list(skillExecutionContext.safetyRules),
    ...list(skillExecutionContext.skuImageRules),
    ...list(skillExecutionContext.evidenceRules),
    ...list(skillExecutionContext.qaRules),
    ...list(skillExecutionContext.stopConditions),
  ]
    .join('\n')
    .slice(0, 12_000);
}

function normalizedList(value) {
  return list(value).map((item) => item.toLowerCase());
}

function supportsReferenceImageInput(model = {}) {
  const capabilities = normalizedList(model.capabilities);
  const modalities = normalizedList(model.modalities);
  return (
    modalities.includes('image') ||
    capabilities.some((capability) =>
      ['multimodal', 'vision', 'image-input', 'image-understanding'].includes(capability)
    )
  );
}

function isPublicHttpsUrl(value) {
  return /^https:\/\//iu.test(text(value));
}

function readLocalAssetId(value) {
  const match = text(value).match(/^\/api\/(?:profile-assets|product-images\/preview)\/([^/?#]+)/u);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function buildReferenceImageInputs(productImageUrls = [], sourceImageIndexes = [], assetShopId = '') {
  return (Array.isArray(productImageUrls) ? productImageUrls : []).slice(0, 10).flatMap((value, index) => {
    const sourceIndex = Number.isInteger(sourceImageIndexes[index]) ? sourceImageIndexes[index] : index;
    const normalized = text(value);
    if (isPublicHttpsUrl(normalized)) return [{ sourceIndex, url: normalized }];
    const assetId = readLocalAssetId(normalized);
    if (assetId) {
      const owner = readSmartToolImageAssetOwner(normalized, assetShopId);
      return [{ sourceIndex, assetId, ...(owner ? { assetShopId: owner } : {}) }];
    }
    if (/^data:image\/(?:png|jpeg|webp);base64,/iu.test(normalized)) {
      return [{ sourceIndex, dataUrl: normalized }];
    }
    return [];
  });
}

function normalizeImageSlotInstructions(imageSlotInstructions = [], sourceImageIndexes = []) {
  const selected = new Set(sourceImageIndexes);
  return (Array.isArray(imageSlotInstructions) ? imageSlotInstructions : [])
    .filter((item) => selected.has(Number(item?.sourceIndex)))
    .map((item) => {
      const sourceIndex = Number(item.sourceIndex);
      const title = compactText(item?.title, 120) || `图片位置 ${sourceIndex + 1}`;
      const instruction = compactText(item?.instruction, 800);
      return { sourceIndex, title, instruction };
    });
}

function cleanJsonText(value) {
  const raw = text(value)
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  return first >= 0 && last > first ? raw.slice(first, last + 1) : raw;
}

function readPlanRows(parsed = {}, group = 'main') {
  if (Array.isArray(parsed.plans)) return parsed.plans;
  if (Array.isArray(parsed.items)) return parsed.items;
  if (Array.isArray(parsed.images)) return parsed.images;
  if (parsed.plan && typeof parsed.plan === 'object' && !Array.isArray(parsed.plan)) return [parsed.plan];
  if (parsed.result && typeof parsed.result === 'object') return readPlanRows(parsed.result, group);
  if (parsed.data && typeof parsed.data === 'object') return readPlanRows(parsed.data, group);
  if (group === 'detail' && Array.isArray(parsed.sharedGallery)) return parsed.sharedGallery;
  if (group === 'main' && Array.isArray(parsed.skuPlans)) {
    return parsed.skuPlans.map((item) => item?.hero).filter(Boolean);
  }
  if (text(parsed.prompt || parsed.positivePrompt || parsed.instruction || parsed.executionPrompt)) return [parsed];
  return [];
}

export function parseSmartToolImagePromptPlan(
  value,
  { group = 'main', sourceImageIndexes = [], skillExecutionContext = null } = {}
) {
  let parsed;
  try {
    parsed = JSON.parse(cleanJsonText(value));
  } catch {
    throw new Error('分析模型返回的图片方案不是有效 JSON，请修改提示词后重试。');
  }
  const rows = readPlanRows(parsed, group);
  if (!rows.length) throw new Error('分析模型没有返回可执行的图片方案。');
  const indexes = sourceImageIndexes.length ? sourceImageIndexes : rows.map((_, index) => index);
  const normalized = rows.map((item, index) => {
    const sourceIndex = Number.isInteger(Number(item?.sourceIndex)) ? Number(item.sourceIndex) : indexes[index];
    const prompt = text(item?.prompt || item?.positivePrompt || item?.instruction);
    if (!prompt)
      throw new Error(`分析方案缺少${group === 'detail' ? '详情图' : '主图'}位置 ${sourceIndex + 1} 的提示词。`);
    return {
      sourceIndex,
      purpose: text(item?.purpose || item?.sellingPoint || item?.goal),
      prompt,
      negativePrompt: text(item?.negativePrompt || item?.negative_prompt),
      mustKeep: list(item?.mustKeep || item?.must_keep),
      mustAvoid: list(item?.mustAvoid || item?.must_avoid),
      acceptanceChecks: list(item?.acceptanceChecks || item?.acceptance_checks),
    };
  });
  const expected = new Set(indexes);
  const seen = new Set();
  normalized.forEach((item) => {
    if (!expected.has(item.sourceIndex)) throw new Error(`分析方案返回了未选择的位置 ${item.sourceIndex + 1}。`);
    if (seen.has(item.sourceIndex)) throw new Error(`分析方案重复返回了位置 ${item.sourceIndex + 1}。`);
    seen.add(item.sourceIndex);
  });
  const missing = indexes.filter((index) => !seen.has(index));
  if (missing.length) throw new Error(`分析方案缺少位置 ${missing.map((index) => index + 1).join('、')}。`);
  return {
    version: text(parsed.version) || '1.0',
    group: group === 'detail' ? 'detail' : 'main',
    globalNegativePrompt: text(parsed.globalNegativePrompt || parsed.global_negative_prompt),
    items: normalized.sort((left, right) => left.sourceIndex - right.sourceIndex),
    raw: parsed,
  };
}

export function parseSmartToolFastImagePromptPlan(
  value,
  { group = 'main', sourceImageIndexes = [], skillExecutionContext = null } = {}
) {
  const normalized = text(value)
    .replace(/^```(?:text|json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  if (normalized.startsWith('{')) {
    return {
      ...parseSmartToolImagePromptPlan(normalized, {
        group,
        sourceImageIndexes,
        skillExecutionContext,
      }),
      generationMode: SMART_TOOL_IMAGE_GENERATION_MODE_FAST,
    };
  }
  const prompt = normalized.replace(/^EXECUTION_PROMPT\s*:\s*/iu, '').trim();
  if (!prompt) throw new Error('分析模型没有返回可执行的极速图片方案。');
  const indexes = sourceImageIndexes.length ? sourceImageIndexes : [0];
  if (indexes.length !== 1) throw new Error('极速图片方案必须逐图生成。');
  return {
    version: 'fast-1.0',
    group: group === 'detail' ? 'detail' : 'main',
    generationMode: SMART_TOOL_IMAGE_GENERATION_MODE_FAST,
    globalNegativePrompt: '',
    items: [
      {
        sourceIndex: indexes[0],
        purpose: '',
        prompt: compactText(prompt, 2_400),
        negativePrompt: '',
        mustKeep: [],
        mustAvoid: [],
        acceptanceChecks: [],
      },
    ],
    raw: { executionPrompt: prompt },
  };
}

export function createSmartToolImagePromptPlanRequest({
  shopId,
  assetShopId,
  productTitle,
  productKey,
  offerId,
  productId,
  sku,
  skuFacts,
  targetScene,
  draft,
  productImageUrls = [],
  sourceImageIndexes = [],
  imageSlotInstructions = [],
  skillExecutionContext = null,
  imageGroup = 'main',
  plannerModelSelection,
  generationMode = 'standard',
} = {}) {
  sourceImageIndexes = validateSmartToolImageSourceIndexes(sourceImageIndexes);
  if (!sourceImageIndexes.length && productImageUrls.length) sourceImageIndexes = productImageUrls.map((_, index) => index);
  const model = plannerModelSelection || {};
  const normalizedGenerationMode = normalizeSmartToolImageGenerationMode(generationMode);
  if (!model.accountId || !model.model || model.ready === false) {
    throw new Error('当前没有可用的分析/文案模型，请先在 Skill 设置中选择文本模型。');
  }
  const availableReferenceImages = buildReferenceImageInputs(productImageUrls, sourceImageIndexes, assetShopId);
  if (sourceImageIndexes.length && availableReferenceImages.length !== sourceImageIndexes.length) {
    throw new Error('部分选中图片无法进入图片处理流程，请重新读取商品图片后再试。');
  }
  const plannerReadsReferenceImages =
    normalizedGenerationMode !== SMART_TOOL_IMAGE_GENERATION_MODE_FAST && supportsReferenceImageInput(model);
  const referenceImages = plannerReadsReferenceImages ? availableReferenceImages : [];
  const referenceImageUrls = referenceImages.map((item) => item.url).filter(Boolean);
  const normalizedImageSlots = normalizeImageSlotInstructions(imageSlotInstructions, sourceImageIndexes);
  return {
    ...(text(shopId) ? { shopId: text(shopId) } : {}),
    accountId: text(model.accountId),
    model: text(model.model),
    templateId: 'image-plan.v1',
    imageGroup: imageGroup === 'detail' ? 'detail' : 'main',
    sourceImageIndexes: [...sourceImageIndexes],
    templateInput: {
      productTitle,
      productKey,
      offerId,
      productId,
      sku,
      skuFacts,
      targetScene,
      draft,
      imageGroup,
      sourceImageIndexes,
      productImageUrls: referenceImageUrls,
      referenceImages,
      availableReferenceImages,
      plannerReadsReferenceImages,
      generationMode: normalizedGenerationMode,
      outputMode:
        normalizedGenerationMode === SMART_TOOL_IMAGE_GENERATION_MODE_FAST ? 'single-execution-prompt' : 'plans-json',
      outputContract:
        normalizedGenerationMode === SMART_TOOL_IMAGE_GENERATION_MODE_FAST
          ? '只返回 EXECUTION_PROMPT: 后接一条完整可执行提示词，不要解释。'
          : {
              version: '1.1',
              globalNegativePrompt: '全局禁止项',
              plans: sourceImageIndexes.map((sourceIndex) => ({
                sourceIndex,
                purpose: '当前位置唯一职责',
                prompt: '本位置完整可执行正向提示词',
                negativePrompt: '本位置负向约束',
                mustKeep: ['必须保持的参考图事实'],
                mustAvoid: ['禁止生成的内容'],
                acceptanceChecks: ['生成后逐项检查'],
              })),
            },
      imageSlotInstructions: normalizedImageSlots,
      skillContext:
        skillExecutionContext && typeof skillExecutionContext === 'object' && !Array.isArray(skillExecutionContext)
          ? skillExecutionContext
          : null,
    },
    customRules: createPlannerCustomRules(skillExecutionContext),
    referenceImageUrls,
    referenceImages,
    requestedReferenceImageCount: availableReferenceImages.length,
    referenceImagePolicy: plannerReadsReferenceImages ? 'vision-planner' : 'deferred-to-image-model',
    generationMode: normalizedGenerationMode,
  };
}

async function requestImagePromptPlan(request, input, options = {}) {
  assertSmartToolImageNotAborted(options.signal);
  const referenceImages = await Promise.all(request.referenceImages.map(async reference => reference.assetId
    ? { sourceIndex: reference.sourceIndex, url: await resolveSmartToolImageAssetReference(reference.assetId, reference.assetShopId || request.shopId, options) }
    : reference));
  assertSmartToolImageNotAborted(options.signal);
  const effectiveRequest = {
    ...request, referenceImages, referenceImageUrls: referenceImages.map(reference => reference.url).filter(Boolean),
    templateInput: { ...request.templateInput, referenceImages },
  };
  const response = await requestLocalApi('/api/image-prompt-plans/generate', {
    method: 'POST',
    body: effectiveRequest,
    timeoutMs: options.timeoutMs || 180_000,
    signal: options.signal,
  });
  assertSmartToolImageNotAborted(options.signal);
  if (response?.ok === false) throw new Error(response.error?.message || '图片方案生成失败。');
  const planParser =
    request.generationMode === SMART_TOOL_IMAGE_GENERATION_MODE_FAST
      ? parseSmartToolFastImagePromptPlan
      : parseSmartToolImagePromptPlan;
  const plan = planParser(response?.planText || response?.description, {
    group: request.imageGroup || input.imageGroup,
    sourceImageIndexes: request.sourceImageIndexes,
    skillExecutionContext: input.skillExecutionContext,
  });
  return {
    ...response,
    ...plan,
    model: text(response?.model || request.model),
    accountId: text(response?.accountId || request.accountId),
    requestedReferenceImageCount:
      Number(response?.requestedReferenceImageCount ?? request.requestedReferenceImageCount) || 0,
    referenceImagePolicy: text(response?.referenceImagePolicy || request.referenceImagePolicy),
    generationMode: request.generationMode,
  };
}

function splitImagePlanInput(input = {}) {
  const sourceImageIndexes = validateSmartToolImageSourceIndexes(input.sourceImageIndexes || []);
  const productImageUrls = Array.isArray(input.productImageUrls) ? input.productImageUrls : [];
  if (sourceImageIndexes.length <= IMAGE_PLAN_BATCH_SIZE) return [input];
  const batches = [];
  for (let start = 0; start < sourceImageIndexes.length; start += IMAGE_PLAN_BATCH_SIZE) {
    batches.push({
      ...input,
      sourceImageIndexes: sourceImageIndexes.slice(start, start + IMAGE_PLAN_BATCH_SIZE),
      productImageUrls: productImageUrls.slice(start, start + IMAGE_PLAN_BATCH_SIZE),
    });
  }
  return batches;
}

async function runImagePlanBatches(batches, worker, signal) {
  const results = new Array(batches.length);
  const failures = new Array(batches.length);
  let cursor = 0;
  async function consume() {
    while (cursor < batches.length) {
      assertSmartToolImageNotAborted(signal);
      const batchIndex = cursor;
      cursor += 1;
      try {
        results[batchIndex] = await worker(batches[batchIndex], batchIndex);
      } catch (error) {
        failures[batchIndex] = {
          batchIndex,
          sourceImageIndexes: Array.isArray(batches[batchIndex]?.sourceImageIndexes)
            ? batches[batchIndex].sourceImageIndexes
            : [],
          message: error instanceof Error ? error.message : String(error || '图片方案分析失败'),
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(IMAGE_PLAN_BATCH_CONCURRENCY, batches.length) }, () => consume()));
  return {
    results: results.filter(Boolean),
    failures: failures.filter(Boolean),
  };
}

function mergeImagePromptPlanBatches(results = [], input = {}, failures = []) {
  const parsedGlobalNegativePrompt = [
    ...new Set(results.map((item) => text(item.globalNegativePrompt)).filter(Boolean)),
  ].join('\n');
  const referenceImagePolicies = [...new Set(results.map((item) => text(item.referenceImagePolicy)).filter(Boolean))];
  const failedSourceIndexes = [...new Set(failures.flatMap((item) => item.sourceImageIndexes || []))].sort(
    (left, right) => left - right
  );
  const mergedItems = results
    .flatMap((item) => (Array.isArray(item.items) ? item.items : []))
    .sort((left, right) => left.sourceIndex - right.sourceIndex);
  return {
    ok: failures.length === 0,
    partial: false,
    version: text(results[0]?.version) || '1.0',
    group: input.imageGroup === 'detail' ? 'detail' : 'main',
    globalNegativePrompt: parsedGlobalNegativePrompt,
    items: mergedItems,
    raw: { batches: results.map((item) => item.raw) },
    model: text(results[0]?.model),
    accountId: text(results[0]?.accountId),
    referenceImageCount: results.reduce((sum, item) => sum + (Number(item.referenceImageCount) || 0), 0),
    requestedReferenceImageCount: results.reduce(
      (sum, item) => sum + (Number(item.requestedReferenceImageCount) || 0),
      0
    ),
    referenceImagePolicy:
      referenceImagePolicies.length === 1
        ? referenceImagePolicies[0]
        : referenceImagePolicies.length > 1
          ? 'mixed-planner'
          : 'deferred-to-image-model',
    usage: results.map((item) => item.usage).filter(Boolean),
    batchCount: results.length,
    plannerFallbackCount: failedSourceIndexes.length,
    failedSourceIndexes,
    plannerFailures: failures.map((item) => ({
      sourceImageIndexes: item.sourceImageIndexes,
      message: item.message,
    })),
    generationMode: normalizeSmartToolImageGenerationMode(input.generationMode),
  };
}

export function assertCompleteSmartToolImagePromptPlan(plan = {}, expectedSourceIndexes = []) {
  const plannedIndexes = new Set(
    (Array.isArray(plan?.items) ? plan.items : [])
      .filter((item) => text(item?.prompt))
      .map((item) => Number(item?.sourceIndex))
      .filter(Number.isInteger)
  );
  const missingIndexes = (Array.isArray(expectedSourceIndexes) ? expectedSourceIndexes : []).filter(
    (sourceIndex) => !plannedIndexes.has(sourceIndex)
  );
  if (plan?.ok !== false && !Number(plan?.plannerFallbackCount) && !missingIndexes.length) return plan;
  const failedIndexes = missingIndexes.length
    ? missingIndexes
    : Array.isArray(plan?.failedSourceIndexes)
      ? plan.failedSourceIndexes
      : [];
  const positions = failedIndexes
    .map((index) => Number(index) + 1)
    .filter(Number.isFinite)
    .join('、');
  throw new Error(
    `图片方案未完整生成，已停止生图且不会改用默认规则${positions ? `。请重试位置：${positions}` : '，请重试'}。`
  );
}

export async function runSmartToolImagePromptPlan(input = {}, options = {}) {
  assertSmartToolImageNotAborted(options.signal);
  const indexes = validateSmartToolImageSourceIndexes(input.sourceImageIndexes || []);
  if (indexes.length && (!Array.isArray(input.productImageUrls) || input.productImageUrls.length !== indexes.length)) {
    throw new Error('选中图片与来源位置不一一对应，已停止分析。');
  }
  const batches = splitImagePlanInput(input);
  batches.forEach(batch => createSmartToolImagePromptPlanRequest(batch));
  const settled = await runImagePlanBatches(batches, async (batch, batchIndex) => {
    const request = createSmartToolImagePromptPlanRequest(batch);
    try {
      const plan = await requestImagePromptPlan(request, batch, options);
      assertSmartToolImageNotAborted(options.signal);
      options.onBatchResolved?.({
        batchIndex,
        batchCount: batches.length,
        sourceImageIndexes: request.sourceImageIndexes,
        input: batch,
        plan,
      });
      return plan;
    } catch (error) {
      if (error?.name === 'AbortError' || options.signal?.aborted) throw error;
      const positions = request.sourceImageIndexes.map((index) => index + 1).join('、');
      throw new Error(`图片位置 ${positions} 分析失败：${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    } finally {
      if (!options.signal?.aborted) options.onBatchSettled?.({
        batchIndex,
        batchCount: batches.length,
        sourceImageIndexes: request.sourceImageIndexes,
      });
    }
  }, options.signal);
  assertSmartToolImageNotAborted(options.signal);
  if (settled.failures.length) {
    const failedPositions = [...new Set(settled.failures.flatMap((item) => item.sourceImageIndexes || []))]
      .sort((left, right) => left - right)
      .map((index) => index + 1)
      .join('、');
    const firstFailure = settled.failures[0]?.message || '分析模型没有返回完整方案';
    throw new Error(
      `图片方案未完整生成，已停止生图且不会改用默认规则。失败位置：${failedPositions || '未知'}。${firstFailure}`
    );
  }
  return mergeImagePromptPlanBatches(settled.results, input, settled.failures);
}

export { splitImagePlanInput, supportsReferenceImageInput };
