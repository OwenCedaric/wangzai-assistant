const ADAPTER_VERSION = 3;
export const SMART_TOOL_GENERIC_RUNTIME_ADAPTER_KEY = 'builtin.generic-skill-runtime';
const LEGACY_GENERIC_PREVIEW_ADAPTER_KEY = 'builtin.generic-local-preview';

const BUILT_IN_ADAPTERS = Object.freeze({
  'ozon-product-search': 'builtin.ozon-product-search',
  'ozon-product-selection': 'builtin.ozon-product-selection',
  'ozon-ad-analyzer': 'builtin.ozon-performance-readonly',
  'ozon-product-image-generation': 'builtin.ozon-product-image-generation',
  'profit-risk-review': 'builtin.profit-order-review',
  'ozon-skill-1688-channel-shopdata-get': 'builtin.ozon-operational-report',
  'ozon-skill-1688-channel-shopdata-analyzer': 'builtin.ozon-data-analysis',
  'ozon-skill-1688-product-detail-query': 'builtin.1688-product-detail',
  'linkfox-seerfar-ozon-shop-search': 'builtin.external-ozon-readonly',
  'linkfox-seerfar-ozon-product-detail-search': 'builtin.external-ozon-readonly',
  'linkfox-seerfar-ozon-category-search': 'builtin.external-ozon-readonly',
  'linkfox-seerfar-ozon-product-report-search': 'builtin.external-ozon-readonly',
  'linkfox-seerfar-ozon-keyword-mining': 'builtin.external-ozon-readonly',
  'linkfox-seerfar-ozon-market-keyword-search': 'builtin.external-ozon-readonly',
  'linkfox-seerfar-ozon-keyword-back-search': 'builtin.external-ozon-readonly',
});

export const SMART_TOOL_ADAPTER_STATUS = Object.freeze({
  READY: 'ready',
  PREVIEW_READY: 'preview_ready',
  NEEDS_CONFIGURATION: 'needs_configuration',
  NEEDS_ADAPTER: 'needs_adapter',
  GUARD_REQUIRED: 'guard_required',
});

function cleanText(value) {
  return String(value ?? '').trim();
}

function skillProfileOf(tool = {}) {
  return tool?.skillProfile && typeof tool.skillProfile === 'object' && !Array.isArray(tool.skillProfile)
    ? tool.skillProfile
    : {};
}

function isBuiltInTool(tool = {}) {
  const id = cleanText(tool.id);
  return Boolean(BUILT_IN_ADAPTERS[id]);
}

export function getSmartToolAdapterKey(tool = {}) {
  const profile = skillProfileOf(tool);
  const explicit = cleanText(profile.adapterKey || tool.adapterKey);
  // Existing installations stored the old preview adapter in their profile.
  // Resolve it dynamically so users do not have to delete and reinstall a
  // Skill after the generic runtime is upgraded.
  if (explicit === LEGACY_GENERIC_PREVIEW_ADAPTER_KEY) return SMART_TOOL_GENERIC_RUNTIME_ADAPTER_KEY;
  if (explicit) return explicit;

  const id = cleanText(tool.id);
  if (BUILT_IN_ADAPTERS[id]) return BUILT_IN_ADAPTERS[id];

  const runType = cleanText(profile.runType || tool.runType || tool.actionMode).toLowerCase();
  if (
    !runType ||
    runType === 'local-ai-preview' ||
    runType === 'local-preview' ||
    runType === 'api-assisted-readonly' ||
    runType === 'readonly' ||
    runType === 'read-only' ||
    runType === 'external-readonly' ||
    runType === 'declarative' ||
    runType === 'analysis' ||
    runType === 'model-assisted'
  ) {
    return SMART_TOOL_GENERIC_RUNTIME_ADAPTER_KEY;
  }
  return '';
}

export function getSmartToolAdapterVersion(tool = {}) {
  if (getSmartToolAdapterKey(tool) === SMART_TOOL_GENERIC_RUNTIME_ADAPTER_KEY) return ADAPTER_VERSION;
  const profile = skillProfileOf(tool);
  const version = Number(profile.adapterVersion || tool.adapterVersion || ADAPTER_VERSION);
  return Number.isSafeInteger(version) && version > 0 ? version : ADAPTER_VERSION;
}

export function getSmartToolSkillExecutionState(tool = {}) {
  const profile = skillProfileOf(tool);
  const adapterKey = getSmartToolAdapterKey(tool);
  const adapterVersion = getSmartToolAdapterVersion(tool);
  const runType = cleanText(profile.runType || tool.runType || tool.actionMode || 'local-ai-preview').toLowerCase();
  const explicitAdapter = cleanText(profile.adapterKey || tool.adapterKey);
  const executableFiles = Array.isArray(profile.executableFiles)
    ? profile.executableFiles.map(cleanText).filter(Boolean)
    : [];

  if (runType === 'guard-required' || /write|submit|modify|delete|remove|写入|提交|修改|删除/iu.test(runType)) {
    return {
      status: SMART_TOOL_ADAPTER_STATUS.GUARD_REQUIRED,
      statusLabel: '需要业务安全接入',
      adapterKey,
      adapterVersion,
      runType,
      reason: '涉及真实写入，必须接入对应业务模块的预览、确认、提交和回读链路。',
      isBuiltIn: isBuiltInTool(tool),
    };
  }

  if (!isBuiltInTool(tool) && (runType === 'external-or-script' || executableFiles.length)) {
    return {
      status: SMART_TOOL_ADAPTER_STATUS.NEEDS_ADAPTER,
      statusLabel: '等待脚本安全适配',
      adapterKey: explicitAdapter || adapterKey || null,
      adapterVersion,
      runType,
      reason: '安装包包含可执行脚本；通用引擎不会直接运行未审计代码，需要登记受限脚本适配器。',
      isBuiltIn: false,
    };
  }

  if (
    explicitAdapter &&
    !isBuiltInTool(tool) &&
    explicitAdapter !== LEGACY_GENERIC_PREVIEW_ADAPTER_KEY &&
    explicitAdapter !== SMART_TOOL_GENERIC_RUNTIME_ADAPTER_KEY
  ) {
    return {
      status: SMART_TOOL_ADAPTER_STATUS.NEEDS_ADAPTER,
      statusLabel: '等待适配器',
      adapterKey,
      adapterVersion,
      runType,
      reason: `未登记 ${explicitAdapter} 适配器。`,
      isBuiltIn: false,
    };
  }

  if (isBuiltInTool(tool)) {
    return {
      status: SMART_TOOL_ADAPTER_STATUS.READY,
      statusLabel: '已有运行适配器',
      adapterKey,
      adapterVersion,
      runType,
      reason: '',
      isBuiltIn: true,
    };
  }

  if (adapterKey === SMART_TOOL_GENERIC_RUNTIME_ADAPTER_KEY) {
    return {
      status: SMART_TOOL_ADAPTER_STATUS.READY,
      statusLabel: '通用运行引擎可用',
      adapterKey,
      adapterVersion,
      runType,
      reason:
        runType === 'api-assisted-readonly'
          ? '按 Skill 声明自动绑定只读数据和模型；实际执行结果会显示本次真实调用记录。'
          : '按 Skill 的输入、流程、输出和安全规则调用通用模型运行引擎。',
      isBuiltIn: false,
    };
  }

  return {
    status: SMART_TOOL_ADAPTER_STATUS.NEEDS_ADAPTER,
    statusLabel: '等待适配器',
    adapterKey: adapterKey || null,
    adapterVersion,
    runType,
    reason: 'Skill 没有可执行适配器。',
    isBuiltIn: false,
  };
}

export function isSmartToolRunnable(tool = {}) {
  const state = getSmartToolSkillExecutionState(tool);
  return state.status === SMART_TOOL_ADAPTER_STATUS.READY || state.status === SMART_TOOL_ADAPTER_STATUS.PREVIEW_READY;
}

export function getSmartToolAdapterStatusLabel(status) {
  switch (status) {
    case SMART_TOOL_ADAPTER_STATUS.READY:
      return '已有运行适配器';
    case SMART_TOOL_ADAPTER_STATUS.PREVIEW_READY:
      return '可生成本地预览';
    case SMART_TOOL_ADAPTER_STATUS.NEEDS_CONFIGURATION:
      return '等待配置';
    case SMART_TOOL_ADAPTER_STATUS.GUARD_REQUIRED:
      return '需要业务安全接入';
    default:
      return '等待适配器';
  }
}

export const SMART_TOOL_ADAPTER_REGISTRY_VERSION = ADAPTER_VERSION;
