import { listModelApiAccounts } from '../../../api/localApiClient.js';
import {
  readSavedModelApiState,
  setModelApiStateMemory,
  toModelApiStateFromAccounts,
} from '../../settings/lib/modelApiSettings.jsx';
import { isImageGenerationModel } from '../../../shared/lib/modelCapabilityRules.js';
import {
  APPROVED_IMAGE_MODEL_ID,
  isApprovedImageModel,
  isApprovedImageModelAccount,
} from '../../../shared/lib/imageGenerationProviderPolicy.js';

export const SMART_TOOL_AUTO_MODEL_ID = 'auto';
export const SMART_TOOL_IMAGE_MODEL_CAPABILITY = 'image-generation';
export const SMART_TOOL_BUILTIN_MODEL_ACCOUNT_ID = 'builtin-points';

function normalizeModelText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function toModelNamePart(value = '') {
  return String(value || '')
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('-');
}

export function formatSmartToolModelDisplayName(value = '') {
  const rawValue = normalizeModelText(value);
  if (!rawValue || rawValue === '未配置') return '未配置模型';
  const modelId = rawValue.split('/').pop().trim();
  const imageMatch = modelId.match(/^gpt[-_.]?image[-_.]?(\d+(?:\.\d+)?)$/i);
  if (imageMatch) return `Chat-GPT-Image-${imageMatch[1]}`;
  const gptMatch = modelId.match(/^gpt[-_.]?(\d+(?:\.\d+)?)(?:[-_.](.+))?$/i);
  if (gptMatch) {
    const suffix = toModelNamePart(gptMatch[2]);
    return `Chat-GPT-${gptMatch[1]}${suffix ? `-${suffix}` : ''}`;
  }
  return rawValue;
}

function isModelInterfaceConfigured(item = {}, model = '') {
  return Boolean(
    (normalizeModelText(item.apiKey) || item?.hasApiKey === true) &&
    normalizeModelText(item.baseUrl) &&
    normalizeModelText(model) &&
    item?.discoveryVerified === true
  );
}

const SMART_TOOL_TEXT_CAPABILITY = 'text-generation';
const SMART_TOOL_EXCLUDED_INTERFACE_CAPABILITIES = new Set([
  'image-edit',
  'image-generation',
  'video-edit',
  'video-generation',
]);

function normalizeCapabilities(value) {
  return (Array.isArray(value) ? value : []).map((item) => normalizeModelText(item).toLowerCase()).filter(Boolean);
}

function isSmartToolTextInterface(item = {}) {
  const capabilities = normalizeCapabilities(item.capabilities);
  if (capabilities.length === 0) return true;
  return (
    capabilities.includes(SMART_TOOL_TEXT_CAPABILITY) &&
    !capabilities.some((capability) => SMART_TOOL_EXCLUDED_INTERFACE_CAPABILITIES.has(capability))
  );
}

function textModelsFromDiscovery(availableModels = []) {
  const discovered = Array.isArray(availableModels) ? availableModels : [];
  const hasCapabilityMetadata = discovered.some((item) => normalizeCapabilities(item?.capabilities).length > 0);
  if (!hasCapabilityMetadata) return discovered;
  return discovered.filter((item) => normalizeCapabilities(item?.capabilities).includes(SMART_TOOL_TEXT_CAPABILITY));
}

function imageModelsFromDiscovery(availableModels = []) {
  return (Array.isArray(availableModels) ? availableModels : [])
    .filter(isImageGenerationModel)
    .filter((item) => isApprovedImageModel(item?.id || item?.model));
}

function isSmartToolImageInterface(item = {}) {
  if (!isApprovedImageModelAccount(item)) return false;
  const capabilities = normalizeCapabilities(item.capabilities);
  return (
    capabilities.includes('image-generation') ||
    capabilities.includes('image-edit') ||
    imageModelsFromDiscovery(item.availableModels).length > 0 ||
    isImageGenerationModel({ id: item.defaultModel })
  );
}

function modelsForAccount(item = {}, capability = SMART_TOOL_TEXT_CAPABILITY) {
  if (capability === SMART_TOOL_IMAGE_MODEL_CAPABILITY) {
    const discovered = imageModelsFromDiscovery(item.availableModels);
    if (discovered.length > 0) return discovered;
    const fallback = normalizeModelText(item.defaultModel);
    return fallback && isApprovedImageModel(fallback) && isImageGenerationModel({ id: fallback })
      ? [{ id: fallback, label: fallback, capabilities: ['image-generation'], modalities: ['image'] }]
      : [];
  }
  const discovered = textModelsFromDiscovery(item.availableModels);
  if (discovered.length > 0) return discovered;
  const fallback = normalizeModelText(item.defaultModel);
  return fallback ? [{ id: fallback, label: fallback, capabilities: [], modalities: [] }] : [];
}

function createSmartToolModelOption(item = {}, modelEntry = {}, activeId = '', isPrimary = false) {
  const model = normalizeModelText(modelEntry.id || modelEntry.model, '未填写模型');
  const accountId = normalizeModelText(item.id, 'model-account');
  const id = isPrimary ? accountId : accountId + '::' + model;
  const displayName = formatSmartToolModelDisplayName(model);
  const alias = displayName;
  const provider = '智能模型';
  const ready = isModelInterfaceConfigured(item, model);
  return {
    id,
    accountId,
    label: displayName,
    displayName,
    alias,
    provider,
    model,
    usageScene: normalizeModelText(item.usageScene, '未填写用途'),
    capabilities: Array.isArray(modelEntry.capabilities) ? modelEntry.capabilities : [],
    modalities: Array.isArray(modelEntry.modalities) ? modelEntry.modalities : [],
    options: modelEntry.options && typeof modelEntry.options === 'object' ? modelEntry.options : {},
    defaultQuality: normalizeModelText(item.quality),
    ready,
    isActive: accountId === activeId && isPrimary,
    isPrimary,
    statusLabel: ready ? '可用' : '不可用',
  };
}

export function listSmartToolModelOptions(state = readSavedModelApiState(), options = {}) {
  const interfaces = Array.isArray(state?.interfaces) ? state.interfaces : [];
  const activeId = normalizeModelText(state?.activeId);
  const capability =
    options?.capability === SMART_TOOL_IMAGE_MODEL_CAPABILITY
      ? SMART_TOOL_IMAGE_MODEL_CAPABILITY
      : SMART_TOOL_TEXT_CAPABILITY;
  const modelOptions = [];
  for (const item of interfaces) {
    const isCompatibleInterface =
      capability === SMART_TOOL_IMAGE_MODEL_CAPABILITY
        ? isSmartToolImageInterface(item)
        : isSmartToolTextInterface(item);
    if (!isCompatibleInterface) continue;
    const models = modelsForAccount(item, capability);
    const defaultModel = normalizeModelText(item.defaultModel);
    models.forEach((modelEntry, index) => {
      const modelId = normalizeModelText(modelEntry.id || modelEntry.model);
      modelOptions.push(
        createSmartToolModelOption(
          item,
          modelEntry,
          activeId,
          modelId === defaultModel || (index === 0 && !defaultModel)
        )
      );
    });
  }
  const activeOption =
    modelOptions.find((item) => item.isActive) ||
    modelOptions.find((item) => item.isPrimary && item.ready) ||
    modelOptions.find((item) => item.ready) ||
    modelOptions[0];
  const builtinOption = {
    id: 'builtin-points-text',
    accountId: SMART_TOOL_BUILTIN_MODEL_ACCOUNT_ID,
    label: '内置积分文本模型',
    displayName: '内置积分文本模型',
    alias: '内置积分文本模型',
    provider: '官方内置能力',
    model: 'builtin-points-text',
    usageScene: '未接入自有 API 时按实际用量扣除积分',
    capabilities: [capability],
    // The managed text model also accepts reference images for image-plan jobs.
    // Advertising-image planning must see the actual source pixels; otherwise
    // category text can incorrectly turn flat material into a finished item.
    modalities: ['text', 'image'],
    options: {},
    defaultQuality: '',
    ready: true,
    isActive: false,
    isPrimary: false,
    statusLabel: '积分可用',
  };
  const builtinImageOption = {
    id: 'builtin-points-image',
    label: '内置图片生成模型',
    displayName: '内置图片生成模型',
    alias: '内置图片生成模型',
    provider: '已配置的图片服务（服务端）',
    accountId: SMART_TOOL_BUILTIN_MODEL_ACCOUNT_ID,
    model: APPROVED_IMAGE_MODEL_ID,
    usageScene: '由管理服务固定调用 已配置的图片服务，按实际用量扣除积分',
    capabilities: [SMART_TOOL_IMAGE_MODEL_CAPABILITY],
    modalities: ['image'],
    options: {},
    defaultQuality: 'high',
    ready: true,
    isActive: false,
    isPrimary: false,
    statusLabel: '积分可用',
  };
  const resolved = activeOption?.ready
    ? activeOption
    : capability === SMART_TOOL_IMAGE_MODEL_CAPABILITY
      ? builtinImageOption
      : builtinOption;
  const automaticStatusLabel =
    capability === SMART_TOOL_IMAGE_MODEL_CAPABILITY
      ? resolved.statusLabel
      : resolved.accountId === SMART_TOOL_BUILTIN_MODEL_ACCOUNT_ID
        ? '积分模型'
        : '自有优先，积分兜底';
  return [
    {
      id: SMART_TOOL_AUTO_MODEL_ID,
      label: resolved.displayName,
      displayName: resolved.displayName,
      alias: resolved.displayName,
      provider: resolved.provider,
      accountId: resolved.accountId,
      model: resolved.model,
      usageScene: resolved.usageScene,
      capabilities: resolved.capabilities,
      modalities: resolved.modalities,
      options: resolved.options,
      defaultQuality: resolved.defaultQuality,
      ready: resolved.ready,
      isActive: true,
      statusLabel: automaticStatusLabel,
      resolvedModelId: resolved.id,
    },
    ...modelOptions,
    ...(capability === SMART_TOOL_IMAGE_MODEL_CAPABILITY ? [builtinImageOption] : [builtinOption]),
  ];
}

/** Reads public model metadata from local-api; API keys and login passwords never enter this path. */
export async function loadSmartToolModelState(options = {}) {
  const payload = await listModelApiAccounts({ timeoutMs: options.timeoutMs || 10000, signal: options.signal });
  const accounts = payload?.accounts || payload?.rows || [];
  const state = toModelApiStateFromAccounts(accounts);
  setModelApiStateMemory(state);
  return state;
}

export function resolveSmartToolModelSelection(selectedModelId = SMART_TOOL_AUTO_MODEL_ID, modelOptions = []) {
  const options = Array.isArray(modelOptions) ? modelOptions : [];
  const selected = options.find((item) => item.id === selectedModelId) || options[0] || null;
  if (!selected) {
    return {
      id: SMART_TOOL_AUTO_MODEL_ID,
      label: '智能推荐模型',
      displayName: '智能推荐模型',
      alias: '智能推荐模型',
      provider: '智能模型',
      model: '未配置',
      usageScene: '未配置',
      ready: false,
      statusLabel: '不可用',
      resolvedModelId: '',
    };
  }
  return selected;
}

export function formatSmartToolModelSelection(modelSelection = {}) {
  const label = normalizeModelText(modelSelection.label, '未选择模型');
  const status = normalizeModelText(modelSelection.statusLabel, '未配置');
  const provider = normalizeModelText(modelSelection.provider, '未配置渠道');
  return label + '（' + provider + '，' + status + '）';
}
