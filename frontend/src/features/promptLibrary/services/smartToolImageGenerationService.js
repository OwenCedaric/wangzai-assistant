import {
  editProductImage,
  generateProductImage,
  waitForProductImagePersistenceTask,
} from '../../products/services/productImageAssetService.js';
import { requestLocalApi } from '../../../api/localApiClient.js';
import { scheduleGeneratedImageProvenanceShadow } from '../../imageProvenance/services/imageProvenanceShadowService.js';
import {
  SMART_TOOL_IMAGE_GENERATION_MODE_FAST,
  normalizeSmartToolImageGenerationMode,
} from './smartToolImageGenerationMode.js';
import { APPROVED_IMAGE_MODEL_ID, isApprovedImageModel } from '../../../shared/lib/imageGenerationProviderPolicy.js';

export const SMART_TOOL_DEFAULT_IMAGE_SIZE = '1008x1344';
export const SMART_TOOL_DEFAULT_IMAGE_QUALITY = 'high';

const IMAGE_TEMPLATE_ID = 'product-image-generation.v1';

export const SMART_TOOL_IMAGE_SIZE_OPTIONS = Object.freeze([
  { id: SMART_TOOL_DEFAULT_IMAGE_SIZE, label: '3:4 · 1008×1344' },
  { id: '1024x1024', label: '1:1 · 1024×1024' },
  { id: '1024x1536', label: '2:3 · 1024×1536' },
  { id: '1344x1008', label: '4:3 · 1344×1008' },
  { id: '1536x1024', label: '3:2 · 1536×1024' },
  { id: 'auto', label: '自动尺寸' },
]);

export const SMART_TOOL_IMAGE_QUALITY_OPTIONS = Object.freeze([
  { id: SMART_TOOL_DEFAULT_IMAGE_QUALITY, label: '高清' },
  { id: 'medium', label: '标准' },
  { id: 'low', label: '快速预览' },
  { id: 'auto', label: '自动质量' },
]);

function text(value) {
  return String(value ?? '').trim();
}

export function assertSmartToolImageNotAborted(signal) {
  if (signal?.aborted) throw new DOMException('图片任务已取消。', 'AbortError');
}

export function validateSmartToolImageSourceIndexes(value = []) {
  if (!Array.isArray(value) || value.some(index => !Number.isInteger(index) || index < 0)
    || new Set(value).size !== value.length) throw new Error('图片来源位置无效或重复，请重新选择图片。');
  return value;
}

export function readSmartToolImageAssetOwner(value, explicitOwner = '') {
  const explicit = text(explicitOwner);
  if (!text(value).startsWith('/api/')) return explicit;
  const fromUrl = text(new URL(value, 'https://local.invalid').searchParams.get('shopId'));
  if (explicit && fromUrl && explicit !== fromUrl) throw new Error('参考图资产所属店铺不一致，请重新选择原图。');
  return fromUrl || explicit;
}

export async function resolveSmartToolImageAssetReference(assetId, assetShopId, options = {}) {
  assertSmartToolImageNotAborted(options.signal);
  if (!text(assetShopId)) throw new Error('参考图缺少明确资产店铺，不能读取图片。');
  const payload = await requestLocalApi(
    `/api/product-images/assets/${encodeURIComponent(assetId)}/preview?shopId=${encodeURIComponent(assetShopId)}`,
    { method: 'GET', signal: options.signal, timeoutMs: options.previewTimeoutMs || 15_000 },
  );
  assertSmartToolImageNotAborted(options.signal);
  const asset = payload?.asset;
  if (payload?.ok === false || !asset || asset.status === 'deleted'
    || (text(asset.shopId) && text(asset.shopId) !== text(assetShopId)) || !isPublicImageUrl(asset.previewUrl)) {
    throw new Error('参考图没有通过所属店铺的资产回读，或签名预览地址不可用，请重新读取原图。');
  }
  return text(asset.previewUrl);
}

function isPublicImageUrl(value) {
  try {
    return new URL(text(value)).protocol === 'https:';
  } catch {
    return false;
  }
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

function resolveImageSource(value) {
  const normalized = text(value);
  if (isPublicImageUrl(normalized)) return { sourceUrl: normalized };
  const assetId = readLocalAssetId(normalized);
  if (assetId) return { assetId };
  if (/^data:image\/(?:png|jpeg|webp);base64,/iu.test(normalized)) return { dataBase64: normalized };
  return {};
}

function resolvePreviewImageUrl(asset = {}) {
  const candidate = text(asset.previewUrl || asset.localUrl || asset.publicUrl || asset.ozonUrl);
  return candidate.replace(/^\/api\/profile-assets\//u, '/api/product-images/preview/');
}

async function readInlinePreviewImage(asset = {}, options = {}) {
  assertSmartToolImageNotAborted(options.signal);
  const existingDataUrl = text(asset.previewDataUrl || asset.dataUrl);
  if (/^data:image\/(?:png|jpeg|webp);base64,/iu.test(existingDataUrl)) return existingDataUrl;
  const assetId = text(asset.profileAssetId || asset.profile_asset_id || asset.id);
  if (!assetId) return '';
  try {
    const payload = await requestLocalApi(`/api/profile-assets/${encodeURIComponent(assetId)}`, {
      timeoutMs: options.previewTimeoutMs || 15_000,
      signal: options.signal,
    });
    assertSmartToolImageNotAborted(options.signal);
    const storedAsset = payload?.asset || {};
    const mimeType = text(storedAsset.mimeType || storedAsset.mime_type).toLowerCase();
    const dataBase64 = text(storedAsset.dataBase64 || storedAsset.data_base64);
    if (!/^image\/(?:png|jpeg|webp)$/iu.test(mimeType) || !dataBase64) return '';
    return `data:${mimeType};base64,${dataBase64}`;
  } catch {
    assertSmartToolImageNotAborted(options.signal);
    return '';
  }
}

export async function readStoredProductImagePreview(imageUrl, options = {}) {
  const match = text(imageUrl).match(/^\/api\/(?:profile-assets|product-images\/preview)\/([^/?#]+)/u);
  if (!match) return '';
  let assetId = match[1];
  try {
    assetId = decodeURIComponent(assetId);
  } catch {
    // Keep the original path segment when it is not URI encoded.
  }
  return readInlinePreviewImage({ id: assetId }, options);
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedList(value, limit = 60) {
  return (Array.isArray(value) ? value : []).map(text).filter(Boolean).slice(0, limit);
}

function createImageSkillPolicyInput(value) {
  const context = safeObject(value);
  if (!text(context.toolId)) return {};
  return {
    policyVersion: text(context.policyVersion),
    toolId: text(context.toolId),
    title: text(context.title),
    goal: text(context.goal),
    workflowSteps: boundedList(context.workflowSteps, 40),
    outputFormat: text(context.outputFormat).slice(0, 4_000),
    outputRules: boundedList(context.outputRules, 40),
    safetyRules: boundedList(context.safetyRules, 60),
    skuImageRules: boundedList(context.skuImageRules, 40),
    evidenceRules: boundedList(context.evidenceRules, 60),
    qaRules: boundedList(context.qaRules, 60),
    stopConditions: boundedList(context.stopConditions, 40),
  };
}

function createImageTemplateInput(input = {}, generationMode = 'standard') {
  const sections = Array.isArray(input.draft?.result?.sections) ? input.draft.result.sections : [];
  const localPlan = sections
    .flatMap((section) => (Array.isArray(section?.rows) ? section.rows : []))
    .filter(Boolean)
    .slice(0, 12);
  return {
    version: 1,
    generationMode,
    product: {
      title: text(input.productTitle),
      productKey: text(input.productKey),
      offerId: text(input.offerId),
      productId: text(input.productId),
      sku: text(input.sku),
      skuFacts: text(input.skuFacts),
      targetScene: text(input.targetScene),
    },
    image: {
      group: input.imageGroup === 'detail' ? 'detail' : 'main',
      sourceIndex: Math.max(0, Number(input.sourceIndex) || 0),
    },
    positionRules: safeObject(input.promptConfig?.imagePositionRules),
    approvedPlan: safeObject(input.promptPlan),
    skillContext: createImageSkillPolicyInput(input.skillExecutionContext),
    localPlan,
  };
}

export function createSmartToolImageGenerationRequest({
  shopId,
  assetShopId,
  productTitle,
  productKey,
  offerId,
  productId,
  sku,
  productImageUrl,
  skuFacts,
  targetScene,
  draft,
  modelSelection,
  imageGroup = 'main',
  sourceIndex = 0,
  promptConfig = {},
  skillExecutionContext = null,
  promptPlan = null,
  imageSize = SMART_TOOL_DEFAULT_IMAGE_SIZE,
  imageQuality = SMART_TOOL_DEFAULT_IMAGE_QUALITY,
  generationMode = 'standard',
  persistGeneratedAsset = false,
} = {}) {
  const selectedModel = modelSelection || {};
  const normalizedGenerationMode = normalizeSmartToolImageGenerationMode(generationMode);
  const modelCandidate = {
    accountId: text(selectedModel.accountId),
    model: text(selectedModel.model),
  };
  if (!modelCandidate.accountId || !isApprovedImageModel(modelCandidate.model) || selectedModel.ready === false) {
    throw new Error(`图片生成已锁定为 images.example.invalid API 的 ${APPROVED_IMAGE_MODEL_ID}，请先完成该接口配置。`);
  }
  const normalizedGroup = imageGroup === 'detail' ? 'detail' : 'main';
  const normalizedSourceIndex = Number(sourceIndex);
  if (!Number.isInteger(normalizedSourceIndex) || normalizedSourceIndex < 0) throw new Error('图片来源位置无效。');
  const source = resolveImageSource(productImageUrl);
  if (text(productImageUrl) && !Object.keys(source).length) throw new Error('当前参考图无法发送给图片中转站，请重新读取商品图片后再试。');
  if (promptPlan) {
    const matching = (Array.isArray(promptPlan.items) ? promptPlan.items : [])
      .filter(item => Number(item?.sourceIndex) === normalizedSourceIndex && text(item?.prompt));
    if (promptPlan.ok === false || promptPlan.partial === true || matching.length !== 1) {
      throw new Error('当前图片位置没有唯一完整的已审核方案，已停止生图。');
    }
  }
  return {
    shopId: text(shopId),
    promptTemplateId: IMAGE_TEMPLATE_ID,
    promptTemplateInput: createImageTemplateInput(
      {
        productTitle,
        productKey,
        offerId,
        productId,
        sku,
        skuFacts,
        targetScene,
        draft,
        imageGroup: normalizedGroup,
        sourceIndex: normalizedSourceIndex,
        promptConfig,
        skillExecutionContext,
        promptPlan,
      },
      normalizedGenerationMode
    ),
    ...source,
    ...(source.assetId ? { assetShopId: readSmartToolImageAssetOwner(productImageUrl, assetShopId) || text(shopId) } : {}),
    modelSelection: { mode: 'fixed', candidates: [modelCandidate] },
    accountId: modelCandidate.accountId,
    model: modelCandidate.model,
    size: text(imageSize) || SMART_TOOL_DEFAULT_IMAGE_SIZE,
    quality: text(imageQuality) || SMART_TOOL_DEFAULT_IMAGE_QUALITY,
    sourceType:
      normalizedGenerationMode === SMART_TOOL_IMAGE_GENERATION_MODE_FAST
        ? `smart-tool-image-generation-${normalizedGroup}-fast-test`
        : `smart-tool-image-generation-${normalizedGroup}-test`,
    generationMode: normalizedGenerationMode,
    persistGeneratedAsset: persistGeneratedAsset === true,
  };
}

export async function runSmartToolImageGeneration(input = {}, options = {}) {
  assertSmartToolImageNotAborted(options.signal);
  const request = createSmartToolImageGenerationRequest(input);
  if (!request.shopId) throw new Error('当前没有有效店铺，不能生成未绑定店铺的商品图。');
  const hasReferenceImage = Boolean(request.sourceUrl || request.assetId || request.dataBase64);
  if (text(input.productImageUrl) && !hasReferenceImage) {
    throw new Error('当前参考图无法发送给图片中转站，请重新读取商品图片后再试。');
  }
  const execute = (candidate) =>
    hasReferenceImage ? editProductImage(candidate, options) : generateProductImage(candidate, options);
  const effectiveRequest = { ...request };
  if (request.assetId) {
    effectiveRequest.sourceUrl = await resolveSmartToolImageAssetReference(request.assetId, request.assetShopId, options);
    delete effectiveRequest.assetId;
  }
  const fallbackUsed = false;
  assertSmartToolImageNotAborted(options.signal);
  const response = await execute(effectiveRequest);
  assertSmartToolImageNotAborted(options.signal);
  if (response?.ok === false) throw new Error(response.error?.message || '图片生成失败。');
  const createResult = async (payload = {}) => {
    assertSmartToolImageNotAborted(options.signal);
    const originalAsset = payload?.asset || {};
    if (text(originalAsset.shopId) && text(originalAsset.shopId) !== request.shopId) throw new Error('生成图片回读店铺与请求店铺不一致。');
    const syntheticId = /^v2-image-/u.test(text(originalAsset.id || originalAsset.assetId));
    const asset = syntheticId ? { ...originalAsset, id: '', assetId: '' } : originalAsset;
    const directPreviewUrl = resolvePreviewImageUrl(asset);
    const inlinePreviewUrl = isPublicImageUrl(directPreviewUrl) ? '' : await readInlinePreviewImage(asset, options);
    assertSmartToolImageNotAborted(options.signal);
    return {
      ...payload,
      mode: hasReferenceImage ? 'reference-edit' : 'text-to-image',
      model: effectiveRequest.model,
      accountId: effectiveRequest.accountId,
      fallbackUsed,
      fallbackReason: fallbackUsed ? 'invalid-api-key' : '',
      sourceUrl: request.sourceUrl || '',
      promptTemplateId: request.promptTemplateId,
      generationMode: request.generationMode,
      imageUrl: inlinePreviewUrl || directPreviewUrl,
      assetId: text(asset.id || asset.assetId),
      assetShopId: request.shopId,
      previewUrl: resolvePreviewImageUrl(asset),
      asset,
    };
  };
  const immediate = await createResult(response);
  const taskId = text(response?.taskId || response?.task?.id);
  const persistenceStatus = taskId || !immediate.assetId || ['pending', 'persisting'].includes(text(response?.persistenceStatus))
    ? 'pending' : ['error', 'failed'].includes(text(response?.persistenceStatus)) ? 'error' : 'completed';
  assertSmartToolImageNotAborted(options.signal);
  if (taskId || persistenceStatus === 'completed') scheduleGeneratedImageProvenanceShadow({
    shopId: request.shopId,
    sourceAssetId: taskId ? '' : immediate.assetId,
    sourceTaskId: taskId,
    sourceType: request.sourceType,
    model: effectiveRequest.model,
    accountId: effectiveRequest.accountId,
    prompt: `server-template:${request.promptTemplateId}`,
    generationMode: request.generationMode,
    productId: input.productId,
    offerId: input.offerId,
  });
  if (taskId && typeof options.onAssetReady === 'function') {
    void waitForProductImagePersistenceTask(taskId, { ...options, shopId: request.shopId })
      .then(createResult)
      .then(value => {
        assertSmartToolImageNotAborted(options.signal);
        if (!value.assetId || !value.imageUrl) throw new Error('图片保存任务未返回有效资产。');
        options.onAssetReady(value);
      })
      .catch((error) => {
        if (options.signal?.aborted || error?.name === 'AbortError') return;
        if (typeof options.onAssetPersistenceError === 'function') options.onAssetPersistenceError(error, immediate);
      });
  }
  return {
    ...immediate,
    taskId,
    persistenceStatus,
  };
}

function normalizeBatchCount(value, fallback = 1) {
  const count = Number(value);
  if (!Number.isFinite(count)) return fallback;
  return Math.min(30, Math.max(1, Math.round(count)));
}

function normalizeSettledBatchItem(entry, index, sourceImageIndexes = []) {
  const sourceIndex = Number.isInteger(sourceImageIndexes[index]) ? sourceImageIndexes[index] : index;
  if (entry.status === 'fulfilled') {
    const imageUrl = text(entry.value?.imageUrl);
    if (!imageUrl)
      return {
        index,
        sourceIndex,
        status: 'error',
        message: '中转站已返回结果，但没有可展示的图片地址。',
        result: entry.value,
      };
    return {
      index,
      sourceIndex,
      status: 'success',
      imageUrl,
      assetId: text(entry.value?.assetId || entry.value?.asset?.id || entry.value?.asset?.assetId),
      assetShopId: text(entry.value?.assetShopId),
      previewUrl: text(entry.value?.previewUrl || entry.value?.asset?.previewUrl || entry.value?.asset?.localUrl),
      taskId: text(entry.value?.taskId || entry.value?.task?.id),
      persistenceStatus: text(entry.value?.persistenceStatus) || (entry.value?.taskId ? 'pending' : 'completed'),
      result: entry.value,
    };
  }
  return {
    index,
    sourceIndex,
    status: 'error',
    message: entry.reason instanceof Error ? entry.reason.message : String(entry.reason || '图片生成失败'),
  };
}

function notifyBatchItemSettled(callback, item) {
  if (typeof callback !== 'function') return;
  try {
    callback(item);
  } catch {
    // A preview callback cannot change the underlying generation result.
  }
}

export async function runSmartToolImageGenerationBatch(input = {}, count = 4, options = {}) {
  assertSmartToolImageNotAborted(options.signal);
  const { onItemSettled, ...generationOptions } = options || {};
  const sourceImageIndexes = validateSmartToolImageSourceIndexes(input.sourceImageIndexes || []);
  const requestedTotal = normalizeBatchCount(count);
  const total = sourceImageIndexes.length ? Math.min(requestedTotal, sourceImageIndexes.length) : requestedTotal;
  const referenceImages = (Array.isArray(input.productImageUrls) ? input.productImageUrls : [input.productImageUrl])
    .map(text);
  if (sourceImageIndexes.length && Array.isArray(input.productImageUrls) && input.productImageUrls.length
    && (referenceImages.length !== sourceImageIndexes.length || referenceImages.some(value => !value))) {
    throw new Error('选中图片与来源位置不一一对应，已停止生图。');
  }
  const candidates = Array.from({ length: total }, (_, index) => ({
    ...input,
    productImageUrl: sourceImageIndexes.length ? referenceImages[index] || '' : referenceImages[index % Math.max(referenceImages.length, 1)] || '',
    batchIndex: index,
    sourceIndex: Number.isInteger(sourceImageIndexes[index]) ? sourceImageIndexes[index] : index,
  }));
  candidates.forEach(candidate => createSmartToolImageGenerationRequest(candidate));
  const notify = item => { if (!options.signal?.aborted) notifyBatchItemSettled(onItemSettled, item); };
  const tasks = Array.from({ length: total }, (_, index) => {
    return runSmartToolImageGeneration(
      candidates[index],
      {
        ...generationOptions,
        onAssetReady: (value) =>
          notify({
            ...normalizeSettledBatchItem({ status: 'fulfilled', value }, index, sourceImageIndexes),
            persistenceStatus: 'completed',
          }),
        onAssetPersistenceError: (error, immediate) =>
          notify({
            ...normalizeSettledBatchItem({ status: 'fulfilled', value: immediate }, index, sourceImageIndexes),
            persistenceStatus: 'error',
            persistenceMessage: error instanceof Error ? error.message : String(error || '图片后台保存失败'),
          }),
      }
    ).then(
      (value) => {
        notify(
          normalizeSettledBatchItem({ status: 'fulfilled', value }, index, sourceImageIndexes)
        );
        return value;
      },
      (reason) => {
        notify(
          normalizeSettledBatchItem({ status: 'rejected', reason }, index, sourceImageIndexes)
        );
        throw reason;
      }
    );
  });
  const settled = await Promise.allSettled(tasks);
  assertSmartToolImageNotAborted(options.signal);
  const items = settled.map((entry, index) => normalizeSettledBatchItem(entry, index, sourceImageIndexes));
  const successCount = items.filter((item) => item.status === 'success' && item.imageUrl).length;
  const fallbackCount = items.filter((item) => item.status === 'success' && item.result?.fallbackUsed === true).length;
  return {
    count: total,
    items,
    successCount,
    failedCount: total - successCount,
    fallbackCount,
    generationMode: normalizeSmartToolImageGenerationMode(input.generationMode),
  };
}
