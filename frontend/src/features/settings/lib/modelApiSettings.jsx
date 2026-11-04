export const emptyModelApiSettings = {
  id: 'model-api-image2-default',
  apiAlias: '接口配置',
  provider: '',
  websiteUrl: '',
  loginAccount: '',
  loginPassword: '',
  baseUrl: '',
  apiKey: '',
  defaultModel: '',
  usageScene: '',
  upscale: '',
  quality: '',
  style: '',
  availableModels: [],
  capabilities: [],
  discoveryVerified: false,
  detectionStatus: '保存后自动识别',
  detectedSource: '',
  detectedAt: '',
  savedAt: '',
};

const OPTION_GROUPS = ['size', 'quality', 'style', 'upscale'];

let modelApiSettingsMemory = null;

function normalizeModelOptions(value) {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set();
  return rows
    .map((item) => {
      const id = String(typeof item === 'string' ? item : item?.id || item?.model || '').trim();
      if (!id || seen.has(id)) return null;
      seen.add(id);
      const normalized = {
        id,
        label: String(typeof item === 'string' ? item : item?.label || item?.displayName || id).trim() || id,
        capabilities: Array.isArray(item?.capabilities) ? item.capabilities.map(String).filter(Boolean) : [],
        modalities: Array.isArray(item?.modalities) ? item.modalities.map(String).filter(Boolean) : [],
      };
      const options = normalizeOptionGroups(item?.options);
      if (Object.keys(options).length) normalized.options = options;
      return normalized;
    })
    .filter(Boolean)
    .slice(0, 100);
}

function normalizeOptionGroups(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const group of OPTION_GROUPS) {
    const rows = Array.isArray(value[group]) ? value[group] : [];
    const seen = new Set();
    const options = rows
      .map((item) => {
        const id = String(typeof item === 'string' ? item : item?.id || item?.value || item?.name || '').trim();
        if (!id || seen.has(id)) return null;
        seen.add(id);
        return {
          id,
          label:
            String(
              typeof item === 'string' ? item : item?.label || item?.displayName || item?.name || item?.value || id
            ).trim() || id,
        };
      })
      .filter(Boolean)
      .slice(0, 32);
    if (options.length) result[group] = options;
  }
  return result;
}

function mergeOptionGroups(target, source) {
  for (const group of OPTION_GROUPS) {
    const existing = Array.isArray(target[group]) ? target[group] : [];
    const seen = new Set(existing.map((item) => item.id));
    for (const option of source?.[group] || []) {
      if (!seen.has(option.id)) {
        existing.push(option);
        seen.add(option.id);
      }
    }
    if (existing.length) target[group] = existing.slice(0, 32);
  }
  return target;
}

export function getModelApiOptionGroups(settings = {}) {
  const models = Array.isArray(settings?.availableModels) ? settings.availableModels : [];
  const selectedModel = models.find(
    (item) => String(item?.id || '').trim() === String(settings?.defaultModel || '').trim()
  );
  const sources = selectedModel?.options ? [selectedModel] : models;
  return sources.reduce((result, model) => mergeOptionGroups(result, normalizeOptionGroups(model?.options)), {});
}

export function normalizeImage2Settings(settings) {
  const nextSettings = { ...emptyModelApiSettings };
  for (const key of Object.keys(emptyModelApiSettings)) {
    if (key === 'availableModels' || key === 'capabilities' || key === 'discoveryVerified') continue;
    nextSettings[key] = String(settings?.[key] ?? emptyModelApiSettings[key] ?? '');
  }
  return {
    ...nextSettings,
    availableModels: normalizeModelOptions(settings?.availableModels),
    capabilities: Array.isArray(settings?.capabilities)
      ? [...new Set(settings.capabilities.map(String).filter(Boolean))].slice(0, 64)
      : [],
    discoveryVerified: Boolean(settings?.discoveryVerified),
    hasLoginPassword: Boolean(settings?.hasLoginPassword),
    hasApiKey: Boolean(settings?.hasApiKey),
    isDefault: Boolean(settings?.isDefault),
  };
}

export function createBlankModelApiSettings(index) {
  return normalizeImage2Settings({
    id: 'model-api-' + Date.now() + '-' + Math.random().toString(16).slice(2),
    apiAlias: '配置 ' + index,
    detectionStatus: '保存后自动识别',
  });
}

export function normalizeModelApiState(value) {
  const rawInterfaces = Array.isArray(value?.interfaces) && value.interfaces.length > 0 ? value.interfaces : [value];
  const interfaces = rawInterfaces.map((item, index) =>
    normalizeImage2Settings({
      ...(index === 0 ? emptyModelApiSettings : createBlankModelApiSettings(index + 1)),
      ...item,
      id:
        item?.id ||
        (index === 0
          ? emptyModelApiSettings.id
          : 'model-api-' + Date.now() + '-' + index + '-' + Math.random().toString(16).slice(2)),
    })
  );
  const activeId = interfaces.some((item) => item.id === value?.activeId) ? value.activeId : interfaces[0].id;
  return { activeId, interfaces };
}

export function getDefaultModelApiState() {
  const blankInterface = {
    ...createBlankModelApiSettings(1),
    apiAlias: emptyModelApiSettings.apiAlias,
  };
  return normalizeModelApiState({ activeId: blankInterface.id, interfaces: [blankInterface] });
}

export function readSavedModelApiState() {
  if (!modelApiSettingsMemory) modelApiSettingsMemory = getDefaultModelApiState();
  return modelApiSettingsMemory;
}

/** Keeps only public/masked account metadata in renderer memory; persistence belongs to local-api. */
export function setModelApiStateMemory(nextState) {
  const normalizedState = normalizeModelApiState(nextState);
  modelApiSettingsMemory = normalizedState;
  return normalizedState;
}

export function countModelApiSettingsMemoryReferences(accountId) {
  const ownerId = String(accountId ?? '').trim();
  if (!ownerId || !modelApiSettingsMemory) return 0;
  const interfaceCount =
    modelApiSettingsMemory.interfaces?.filter((item) => String(item?.id ?? '').trim() === ownerId).length || 0;
  const activeCount = String(modelApiSettingsMemory.activeId ?? '').trim() === ownerId ? 1 : 0;
  return interfaceCount + activeCount;
}

export function removeModelApiSettingsMemoryInterface(accountId) {
  const ownerId = String(accountId ?? '').trim();
  if (!ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  const current = modelApiSettingsMemory || { activeId: '', interfaces: [] };
  const interfaces = (Array.isArray(current.interfaces) ? current.interfaces : []).filter(
    (item) => String(item?.id ?? '').trim() !== ownerId
  );
  const activeId =
    String(current.activeId ?? '').trim() === ownerId
      ? String(interfaces[0]?.id ?? '')
      : String(current.activeId ?? '');
  modelApiSettingsMemory = { activeId, interfaces };
  return modelApiSettingsMemory;
}

export function toModelApiSettingsFromAccount(account = {}, index = 0) {
  return normalizeImage2Settings({
    ...createBlankModelApiSettings(index + 1),
    id: account.id,
    // Provider and alias are intentionally normalized to a generic label in
    // renderer state; the UI must not reveal which relay supplied the data.
    apiAlias: '配置 ' + (index + 1),
    provider: '',
    websiteUrl: account.websiteUrl || '',
    loginAccount: account.loginAccount || '',
    loginPassword: '',
    hasLoginPassword: Boolean(account.hasLoginPassword),
    loginPasswordHint: account.loginPasswordHint || '',
    baseUrl: account.baseUrl || '',
    apiKey: '',
    hasApiKey: Boolean(account.hasApiKey),
    apiKeyHint: account.apiKeyHint || '',
    defaultModel: account.defaultModel || '',
    usageScene: account.usageScene || '',
    availableModels: account.availableModels || [],
    capabilities: account.capabilities || [],
    discoveryVerified: Boolean(account.discoveryVerified),
    detectionStatus: account.detectionStatus || '',
    detectedSource: account.detectedSource || '',
    detectedAt: account.detectedAt || '',
    isDefault: Boolean(account.isDefault),
    savedAt: account.updatedAt || '',
  });
}

export function toModelApiStateFromAccounts(accounts = []) {
  const interfaces = (Array.isArray(accounts) ? accounts : []).map(toModelApiSettingsFromAccount);
  if (!interfaces.length) return getDefaultModelApiState();
  const activeInterface = interfaces.find((item) => item.isDefault) || interfaces[0];
  return normalizeModelApiState({ activeId: activeInterface.id, interfaces });
}

export function toModelApiAccountPayload(settings = {}, { isDefault = false } = {}) {
  const payload = {
    id: settings.id,
    websiteUrl: String(settings.websiteUrl || '').trim(),
    // Model APIs authenticate with the endpoint and API key. Explicitly clear
    // legacy dashboard credentials when this configuration is saved again.
    loginAccount: '',
    loginPassword: '',
    isDefault,
  };
  for (const field of ['defaultModel', 'quality', 'style', 'upscale']) {
    const value = String(settings[field] || '').trim();
    if (value) payload[field] = value;
  }
  const apiKey = String(settings.apiKey || '').trim();
  if (apiKey) payload.apiKey = apiKey;
  return payload;
}
