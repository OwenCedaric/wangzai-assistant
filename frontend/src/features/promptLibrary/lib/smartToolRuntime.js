import { readSavedModelApiState } from '../../settings/lib/modelApiSettings.jsx';
import { ozonRuntimeProfiles } from './ozonSkillCatalog.js';
import { externalOzonRuntimeProfiles, externalOzonSkillSetupRules } from './externalOzonSkillCatalog.js';
import {
  canUseSmartToolOzonBrowserDataProfile,
  usesActiveOzonProductQueryProfile,
} from './smartToolOzonBrowserDataProfiles.js';
import {
  getSmartToolSkillExecutionState,
  SMART_TOOL_ADAPTER_STATUS,
  SMART_TOOL_GENERIC_RUNTIME_ADAPTER_KEY,
} from './smartToolAdapterRegistry.js';
import { matchSmartToolApiCapabilities } from './smartToolApiCapabilityRegistry.js';
import { compileSmartToolExecutionPlan } from './smartToolExecutionPlan.js';
import { isUserInstalledSmartTool } from './smartToolInstalledSkill.js';

const smartToolStatusProfiles = {
  可用: { availabilityLabel: '能用', availabilityTone: 'success' },
  部分可用: { availabilityLabel: '能用一部分', availabilityTone: 'primary' },
  待配置: { availabilityLabel: '要先设置', availabilityTone: 'warning' },
  待接入: { availabilityLabel: '还没接好', availabilityTone: 'default' },
};

const smartToolSceneProfiles = {
  ozon: {
    toolType: '查 Ozon 用的',
    entryPoints: ['商品列表', '商品详情', '选品分析'],
    dependencies: ['Ozon 或第三方查询账号'],
    riskLabel: '只看不改',
    riskTone: 'success',
    actionMode: '查到结果后给你看',
  },
  1688: {
    toolType: '查 1688 用的',
    entryPoints: ['商品列表', '商品编辑', '拍单管理'],
    dependencies: ['1688 或 AlphaShop 账号'],
    riskLabel: '只看不改',
    riskTone: 'success',
    actionMode: '找出可选货源',
  },
  selection: {
    toolType: '帮你选品',
    entryPoints: ['选品分析', '商品列表'],
    dependencies: ['市场数据账号'],
    riskLabel: '只看不改',
    riskTone: 'success',
    actionMode: '把判断结果列出来',
  },
  product: {
    toolType: '改商品信息',
    entryPoints: ['商品列表', '商品编辑'],
    dependencies: ['AI 设置（可不填）'],
    riskLabel: '先预览',
    riskTone: 'primary',
    actionMode: '先生成建议，你确认后再用',
  },
  image: {
    toolType: '处理图片',
    entryPoints: ['商品编辑', '素材处理'],
    dependencies: ['图片 AI 或翻译功能'],
    riskLabel: '先预览',
    riskTone: 'warning',
    actionMode: '先生成图片方案',
  },
  marketing: {
    toolType: '看推广效果',
    entryPoints: ['营销活动', '付费推广'],
    dependencies: ['活动或广告数据'],
    riskLabel: '只看不改',
    riskTone: 'success',
    actionMode: '按数据给出判断',
  },
  report: {
    toolType: '做报表',
    entryPoints: ['旺崽汇总', '数据报表'],
    dependencies: ['本地经营数据'],
    riskLabel: '只看不改',
    riskTone: 'success',
    actionMode: '整理成报告建议',
  },
  profit: {
    toolType: '看利润问题',
    entryPoints: ['利润核算', '销售订单'],
    dependencies: ['当前订单利润信息'],
    riskLabel: '不改公式',
    riskTone: 'primary',
    actionMode: '整理亏损原因',
  },
  system: {
    toolType: '防止误操作',
    entryPoints: ['工具中心', '系统设置'],
    dependencies: ['允许操作开关'],
    riskLabel: '必须确认',
    riskTone: 'error',
    actionMode: '先让你看一遍，再决定做不做',
  },
};

const smartToolProfilesById = {
  'ozon-product-search': {
    dependencies: ['Ozon 内置浏览器插件'],
    entryPoints: ['商品列表', '商品详情', '选品分析'],
    actionMode: '查 Ozon 同款和竞品',
    riskLabel: '只看不改',
    riskTone: 'success',
    displayGoal: '搜索 Ozon 商品并判断市场机会、竞争强度和运营风险',
    displayBody:
      '输入中文、俄文关键词或 SKU 后，由后台专用浏览器执行只读查询，按七个真实证据维度生成机会评分、可信度、风险和执行动作。',
  },
  'ozon-product-selection': {
    dependencies: ['Ozon 内置浏览器', '文本模型接口', 'Seerfar（可选）'],
    entryPoints: ['选品分析', '商品列表'],
    actionMode: '读取市场数据并生成选品判断',
    riskLabel: '只看不改',
    riskTone: 'success',
    displayGoal: '读取 Ozon 真实市场数据，判断商品值不值得测试',
    displayBody: '程序先完成固定七维评分，再由所选文本模型解释证据；可选 Seerfar 复核和 1688 货源资料核对，全程只读。',
  },
  'ozon-ad-analyzer': {
    dependencies: ['Ozon Performance API 账号'],
    entryPoints: ['付费推广', '营销活动'],
    actionMode: '实时读取并诊断广告计划',
    riskLabel: '只看不改',
    riskTone: 'success',
    displayGoal: '读取真实广告数据，判断计划效率、浪费点和调整顺序',
    displayBody:
      '从 Ozon Performance API 实时读取广告计划和完整统计，计算 CTR、CPC、CVR、CPO、ACOS、ROAS，并输出只读诊断报告。',
  },
  'profit-risk-review': {
    dependencies: ['完整利润账本', 'Seerfar（市场数据可选）', 'AI 设置（可选）'],
    entryPoints: ['利润核算', '销售订单'],
    actionMode: '核算利润并判断是否继续投入',
    riskLabel: '不改金额',
    riskTone: 'primary',
    displayGoal: '输入订单号，核算利润并判断对应商品是否值得继续投入',
    displayBody:
      '自动读取完整利润账本和同 SKU 历史；Seerfar 可用时继续查询近 30 天市场表现，再输出利润优化和投入建议。全程只读，不改订单和金额。',
  },
  ...externalOzonRuntimeProfiles,
  ...ozonRuntimeProfiles,
};

const smartToolFallbackProfile = {
  toolType: '本地小工具',
  entryPoints: ['工具中心'],
  dependencies: ['无'],
  riskLabel: '只在本地',
  riskTone: 'primary',
  actionMode: '复制后使用',
};

const smartToolSetupRulesById = {
  'ozon-product-search': {
    needed: 'browserCapture',
    missingText: '内置浏览器插件数据',
    readyLabel: '能查',
    readyTone: 'success',
  },
  'ozon-product-selection': {
    needed: 'browserCapture',
    missingText: 'Ozon 内置浏览器',
    readyLabel: '能分析',
    readyTone: 'success',
  },
  'ozon-ad-analyzer': {
    needed: 'performance',
    missingText: 'Ozon Performance API 账号',
    settingsModule: 'platformApi',
    readyLabel: '实时可查',
    readyTone: 'success',
  },
  ...externalOzonSkillSetupRules,
};

export function hasUsableOzonShop(shops = []) {
  return (Array.isArray(shops) ? shops : []).some((shop) => {
    const hasClientId = String(shop?.clientId || '').trim() || shop?.hasClientId === true;
    const hasApiKey = String(shop?.apiKey || '').trim() || shop?.hasApiKey === true;
    return Boolean(hasClientId && hasApiKey);
  });
}

export function hasUsableModelApi(state = readSavedModelApiState()) {
  try {
    return (state.interfaces || []).some(
      (item) =>
        (String(item?.apiKey || '').trim() || item?.hasApiKey === true) &&
        String(item?.baseUrl || '').trim() &&
        String(item?.defaultModel || '').trim()
    );
  } catch {
    return false;
  }
}

function isSmartToolSetupReady(rule, environment) {
  if (!rule) return true;
  if (rule.needed === 'browserCapture') return true;
  if (rule.needed === 'modelApi') return Boolean(environment.hasModelApi);
  if (rule.needed === 'ozon') return Boolean(environment.hasOzonShop);
  if (rule.needed === 'performance') return Boolean(environment.hasPerformanceAccount);
  if (rule.needed === 'thirdParty') {
    const acceptedTypes = Array.isArray(rule.integrationTypes) ? rule.integrationTypes : [];
    if (acceptedTypes.length) {
      const readyTypes = new Set(Array.isArray(environment.integrationTypes) ? environment.integrationTypes : []);
      return acceptedTypes.some((integrationType) => readyTypes.has(integrationType));
    }
    return Boolean(environment.hasThirdPartyToolAccount);
  }
  return true;
}

function getSmartToolRuntimeState(item, staticMeta, environment, apiCapabilityMatch) {
  const rule = smartToolSetupRulesById[item.id];
  const ready = isSmartToolSetupReady(rule, environment);
  const userInstalledSkill = isUserInstalledSmartTool(item);
  const adapterState = userInstalledSkill ? getSmartToolSkillExecutionState(item) : null;

  if (userInstalledSkill && adapterState.status === SMART_TOOL_ADAPTER_STATUS.NEEDS_ADAPTER) {
    const hasMatchedApis = apiCapabilityMatch.totalCount > 0;
    return {
      availabilityLabel: hasMatchedApis ? '接口已匹配，待接执行' : '等待适配器',
      availabilityTone: 'warning',
      primaryActionLabel: '查看适配要求',
      primaryActionKind: 'info',
      setupNote: hasMatchedApis
        ? `${apiCapabilityMatch.summaryLabel}；仍需补专用执行适配器。`
        : `已安装，但还没有可执行适配器。${adapterState.reason}`,
      actionMessage: '补齐 adapterKey、输入/输出结构和权限后，才能运行这个 Skill。',
      adapterKey: adapterState.adapterKey || '',
      adapterVersion: adapterState.adapterVersion,
      adapterStatus: adapterState.status,
    };
  }

  if (userInstalledSkill && adapterState.status === SMART_TOOL_ADAPTER_STATUS.GUARD_REQUIRED) {
    return {
      availabilityLabel: '需要业务安全接入',
      availabilityTone: 'warning',
      primaryActionLabel: '查看接入要求',
      primaryActionKind: 'info',
      setupNote: adapterState.reason,
      actionMessage: '这个 Skill 涉及真实写入，必须接入对应业务模块的安全闭环。',
      adapterKey: adapterState.adapterKey || '',
      adapterVersion: adapterState.adapterVersion,
      adapterStatus: adapterState.status,
    };
  }

  if (userInstalledSkill && adapterState.status === SMART_TOOL_ADAPTER_STATUS.PREVIEW_READY) {
    const hasMatchedApis = apiCapabilityMatch.totalCount > 0;
    return {
      availabilityLabel: hasMatchedApis
        ? apiCapabilityMatch.missingCount
          ? `接口待配置 ${apiCapabilityMatch.missingCount} 项`
          : `已匹配 ${apiCapabilityMatch.totalCount} 类接口`
        : '本地预览可用',
      availabilityTone: hasMatchedApis && !apiCapabilityMatch.missingCount ? 'success' : 'primary',
      primaryActionLabel: '生成本地预览',
      primaryActionKind: 'info',
      setupNote: hasMatchedApis ? `${apiCapabilityMatch.summaryLabel}。${adapterState.reason}` : adapterState.reason,
      actionMessage: '填写普通使用输入后生成结构化预览；需要真实数据时再绑定专用 adapter。',
      adapterKey: adapterState.adapterKey || '',
      adapterVersion: adapterState.adapterVersion,
      adapterStatus: adapterState.status,
    };
  }

  if (userInstalledSkill && adapterState.adapterKey === SMART_TOOL_GENERIC_RUNTIME_ADAPTER_KEY) {
    const executionPlan =
      apiCapabilityMatch.executionPlan || compileSmartToolExecutionPlan(item, apiCapabilityMatch.bindings);
    if (executionPlan.unsupportedCount) {
      const unsupported = executionPlan.steps.find((step) => step.compileStatus === 'unsupported');
      return {
        availabilityLabel: `缺少 ${executionPlan.unsupportedCount} 个执行器`,
        availabilityTone: 'warning',
        primaryActionLabel: '查看缺少能力',
        primaryActionKind: 'info',
        setupNote: `${executionPlan.summaryLabel}；未执行的能力不会显示成可用。`,
        actionMessage: `当前缺少“${unsupported?.label || '未知能力'}”的安全执行器。`,
        adapterKey: adapterState.adapterKey,
        adapterVersion: adapterState.adapterVersion,
        adapterStatus: SMART_TOOL_ADAPTER_STATUS.NEEDS_ADAPTER,
      };
    }
    const missingBinding = apiCapabilityMatch.bindings.find((binding) => binding.status === 'missing_configuration');
    if (missingBinding) {
      return {
        availabilityLabel: `还差 ${apiCapabilityMatch.missingCount} 项配置`,
        availabilityTone: 'warning',
        primaryActionLabel: '补配置后使用',
        primaryActionKind: missingBinding.settingsModule ? 'settings' : 'info',
        primaryActionModule: missingBinding.settingsModule || '',
        setupNote: `${apiCapabilityMatch.summaryLabel}；缺少的能力不会被伪装成可运行。`,
        actionMessage: `先配置 ${missingBinding.label}，完成后通用运行引擎会自动绑定。`,
        adapterKey: adapterState.adapterKey,
        adapterVersion: adapterState.adapterVersion,
        adapterStatus: SMART_TOOL_ADAPTER_STATUS.NEEDS_CONFIGURATION,
      };
    }
    return {
      availabilityLabel: executionPlan.guardedCount ? '可运行，写入需确认' : '可以直接运行',
      availabilityTone: 'success',
      primaryActionLabel: '运行 Skill',
      primaryActionKind: 'info',
      setupNote: apiCapabilityMatch.totalCount
        ? `${executionPlan.summaryLabel}；运行后会展示每一步真实执行记录。`
        : '通用模型运行引擎已就绪；运行后会展示真实模型调用记录。',
      actionMessage: '填写未自动绑定的输入后即可运行；店铺、商品和已配置接口会自动使用。',
      adapterKey: adapterState.adapterKey,
      adapterVersion: adapterState.adapterVersion,
      adapterStatus: adapterState.status,
    };
  }

  if (canUseSmartToolOzonBrowserDataProfile(item)) {
    const isProductSearch = usesActiveOzonProductQueryProfile(item);
    return {
      availabilityLabel: '插件数据可读',
      availabilityTone: 'success',
      primaryActionLabel: '使用功能',
      primaryActionKind: 'info',
      setupNote: isProductSearch
        ? '输入关键词或 SKU 后，后台专用浏览器自动查询并读取真实响应。'
        : '读取 Ozon 内置浏览器已经捕获的真实响应，无需额外查询账号。',
      actionMessage: isProductSearch
        ? '填写中文/俄文关键词或 SKU，点击运行后等待后台查询返回。'
        : '打开功能后可按 SKU、关键词、品牌或类目筛选插件数据。',
      displayBody: isProductSearch
        ? '后台专用浏览器执行一次只读商品查询，按 SKU 生成统计分析结果；不自动写入 Ozon。'
        : '直接读取 Ozon 内置浏览器插件已经捕获的真实数据；只读筛选，不自动写入 Ozon。',
    };
  }

  if (item.id === 'ozon-ad-analyzer' && ready) {
    return {
      availabilityLabel: rule?.readyLabel ?? '实时可查',
      availabilityTone: rule?.readyTone ?? 'success',
      primaryActionLabel: '使用功能',
      primaryActionKind: 'info',
      setupNote: '已接入 Ozon Performance API；每次运行都实时读取完整广告统计，不使用浏览器快照。',
      actionMessage: '选择账号、计划和统计周期后开始只读广告诊断。',
      displayBody: '从 Ozon Performance API 实时读取广告计划、完整统计和每日趋势，输出指标、问题、趋势及调整建议。',
    };
  }

  if (rule && !ready) {
    return {
      availabilityLabel: '要先设置',
      availabilityTone: 'warning',
      primaryActionLabel: rule.needed === 'modelApi' ? '补 AI 后使用' : '补配置后使用',
      primaryActionKind: 'settings',
      primaryActionModule: rule.settingsModule,
      setupNote: `已安装，差：${rule.missingText}。补好后就能按固定输入使用。`,
      actionMessage: `已打开设置。先补：${rule.missingText}；普通使用区仍可先生成本地草稿。`,
    };
  }

  if (!userInstalledSkill) {
    return {
      availabilityLabel: rule?.readyLabel ?? staticMeta.availabilityLabel,
      availabilityTone: rule?.readyTone ?? staticMeta.availabilityTone,
      primaryActionLabel: '使用功能',
      primaryActionKind: 'info',
      setupNote: staticMeta.displayBody || '使用该工具原有的专用功能。',
      actionMessage: '已打开原有专用功能。',
    };
  }

  if (adapterState.status === SMART_TOOL_ADAPTER_STATUS.READY) {
    return {
      availabilityLabel: rule?.readyLabel ?? '可以使用',
      availabilityTone: rule?.readyTone ?? 'success',
      primaryActionLabel: '使用功能',
      primaryActionKind: 'info',
      setupNote: adapterState.reason,
      actionMessage: '填写普通使用输入后即可运行；高级流程、提示词和安全规则由 Skill 自动带出。',
      adapterKey: adapterState.adapterKey || '',
      adapterVersion: adapterState.adapterVersion,
      adapterStatus: adapterState.status,
    };
  }

  return {
    availabilityLabel: rule?.readyLabel ?? staticMeta.availabilityLabel,
    availabilityTone: rule?.readyTone ?? staticMeta.availabilityTone,
    primaryActionLabel: '高级配置',
    primaryActionKind: 'info',
    setupNote: '已安装到工具库；固定输入、内置流程、提示词和安全规则已经整理好。',
    actionMessage: '已打开高级配置。普通使用只需要在快速使用区填写最少字段。',
    adapterKey: adapterState.adapterKey || '',
    adapterVersion: adapterState.adapterVersion,
    adapterStatus: adapterState.status,
  };
}

export function createSmartToolMeta(item, environment = {}) {
  const sceneProfile = smartToolSceneProfiles[item.scene] ?? smartToolFallbackProfile;
  const idProfile = smartToolProfilesById[item.id] ?? {};
  const statusProfile = smartToolStatusProfiles[item.status] ?? smartToolStatusProfiles['部分可用'];
  const staticMeta = {
    ...sceneProfile,
    ...statusProfile,
    ...idProfile,
    dependencies: canUseSmartToolOzonBrowserDataProfile(item)
      ? ['Ozon 内置浏览器插件']
      : item.dependencies?.length
        ? item.dependencies
        : (idProfile.dependencies ?? sceneProfile.dependencies ?? smartToolFallbackProfile.dependencies),
    entryPoints: item.entryPoints?.length
      ? item.entryPoints
      : (idProfile.entryPoints ?? sceneProfile.entryPoints ?? smartToolFallbackProfile.entryPoints),
    actionMode: idProfile.actionMode ?? sceneProfile.actionMode ?? smartToolFallbackProfile.actionMode,
    riskLabel: idProfile.riskLabel ?? sceneProfile.riskLabel ?? smartToolFallbackProfile.riskLabel,
    riskTone: idProfile.riskTone ?? sceneProfile.riskTone ?? smartToolFallbackProfile.riskTone,
  };
  if (!isUserInstalledSmartTool(item)) {
    return {
      ...staticMeta,
      ...getSmartToolRuntimeState(item, staticMeta, environment, null),
    };
  }

  const matchedCapabilities = matchSmartToolApiCapabilities(item, environment);
  const apiCapabilityMatch = {
    ...matchedCapabilities,
    executionPlan: compileSmartToolExecutionPlan(item, matchedCapabilities.bindings),
  };
  const runtimeMeta = getSmartToolRuntimeState(item, staticMeta, environment, apiCapabilityMatch);

  return {
    ...staticMeta,
    ...runtimeMeta,
    apiCapabilityMatch,
  };
}
