import { getUserModelPresets, updateUserModelPresets } from '../../licensing/services/licenseCenterClient.js';
import { APPROVED_IMAGE_MODEL_ID } from '../../../shared/lib/imageGenerationProviderPolicy.js';

const MODEL_KINDS = Object.freeze(['text', 'image']);
const API_STATUSES = new Set(['available', 'busy', 'cooling', 'unavailable']);
const MANAGEMENT_APPROVED_MODELS = Object.freeze({
  text: new Set(['gpt-5.6-sol', 'gpt-5.6-terra']),
  image: new Set(['gpt-image-2']),
});

function asCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function normalizeModel(item, capabilityKind) {
  const modelCode = String(item?.model_code || '').trim();
  if (!modelCode) return null;
  const apiStatus = API_STATUSES.has(item?.api_status) ? item.api_status : 'unavailable';
  return {
    modelCode,
    displayName: String(item?.display_name || modelCode).trim() || modelCode,
    capabilityKind,
    apiStatus,
    configuredApiCount: asCount(item?.configured_api_count),
    availableApiCount: asCount(item?.available_api_count),
    busyApiCount: asCount(item?.busy_api_count),
    coolingApiCount: asCount(item?.cooling_api_count),
    pricedCapabilityCount: asCount(item?.priced_capability_count),
    totalCapabilityCount: asCount(item?.total_capability_count),
    canEnable: Boolean(item?.can_enable),
    unavailableReason: String(item?.unavailable_reason || '').trim(),
  };
}

function normalizeGroup(group) {
  const capabilityKind = MODEL_KINDS.includes(group?.capability_kind) ? group.capability_kind : '';
  if (!capabilityKind) return null;
  const catalogModels = (Array.isArray(group?.models) ? group.models : [])
    .map((item) => normalizeModel(item, capabilityKind))
    .filter(Boolean)
    .filter((item) => capabilityKind !== 'image' || item.modelCode === APPROVED_IMAGE_MODEL_ID);
  const known = new Set(catalogModels.map((item) => item.modelCode));
  const enabledModels = [...new Set(Array.isArray(group?.enabled_models) ? group.enabled_models : [])]
    .map((item) => String(item || '').trim())
    .filter((item) => known.has(item));
  const approvedModels = MANAGEMENT_APPROVED_MODELS[capabilityKind];
  const models = catalogModels.filter((item) => item.canEnable && approvedModels.has(item.modelCode));
  const visibleModelCodes = new Set(models.map((item) => item.modelCode));
  const visibleEnabledModels = enabledModels.filter((item) => visibleModelCodes.has(item));
  const requestedDefault = String(group?.default_model || '').trim();
  return {
    capabilityKind,
    label: String(group?.label || (capabilityKind === 'text' ? '文本模型' : '图片模型')),
    enabledModels: visibleEnabledModels,
    defaultModel: visibleEnabledModels.includes(requestedDefault) ? requestedDefault : visibleEnabledModels[0] || '',
    models,
    updatedAt: group?.updated_at || null,
  };
}

export function normalizeModelPresetCatalog(payload) {
  const groups = (Array.isArray(payload?.groups) ? payload.groups : []).map(normalizeGroup).filter(Boolean);
  return {
    contract: String(payload?.contract || ''),
    projectCode: String(payload?.project_code || ''),
    groups: MODEL_KINDS.map((kind) => groups.find((item) => item.capabilityKind === kind)).filter(Boolean),
  };
}

export function createModelPresetDraft(catalog) {
  return (catalog?.groups || []).map((group) => ({
    capabilityKind: group.capabilityKind,
    enabledModels: [...group.enabledModels],
    defaultModel: group.defaultModel,
  }));
}

export async function loadPointsModelPresets(runtime) {
  return normalizeModelPresetCatalog(await getUserModelPresets(runtime));
}

export async function savePointsModelPresets(runtime, draft) {
  const groups = draft.map((group) => ({
    capability_kind: group.capabilityKind,
    enabled_models: group.capabilityKind === 'image' ? [APPROVED_IMAGE_MODEL_ID] : group.enabledModels,
    default_model: group.capabilityKind === 'image' ? APPROVED_IMAGE_MODEL_ID : group.defaultModel,
  }));
  return normalizeModelPresetCatalog(await updateUserModelPresets(runtime, groups));
}
