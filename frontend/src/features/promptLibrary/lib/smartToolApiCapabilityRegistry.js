import { listExternalInterfaceRegistrations } from '../../../services/externalInterfaceRegistry.js';

export const SMART_TOOL_API_BINDING_VERSION = 2;

const DOMAIN_LABELS = Object.freeze({
  products: 'Ozon 商品',
  productImages: 'Ozon 商品图片',
  shops: 'Ozon 店铺',
  warehouse: 'Ozon 仓库与配送',
  salesOrders: 'Ozon 销售订单',
  afterSales: 'Ozon 售后',
  finance: 'Ozon 财务',
  marketing: 'Ozon 营销活动',
  analytics: 'Ozon 经营分析',
  crossBorderBus: '跨境巴士物流',
});

const DOMAIN_KEYWORDS = Object.freeze({
  products:
    /\b(?:product|products|listing|listings|sku|offer|category|attribute|stock|price|seo)\b|商品|产品|货号|类目|属性|库存|价格|标题|详情|商品卡/iu,
  productImages: /\b(?:image|images|picture|pictures|photo|visual)\b|图片|主图|详情图|生图|视觉/iu,
  shops: /\b(?:seller|shop|store|role)\b|卖家|店铺|门店/iu,
  warehouse: /\b(?:warehouse|delivery|logistics|fulfillment)\b|仓库|配送|履约|物流/iu,
  salesOrders: /\b(?:order|orders|posting|shipment|tracking)\b|订单|发货|运单|追踪号/iu,
  afterSales: /\b(?:return|refund|cancellation|after.?sales)\b|售后|退货|退款|取消/iu,
  finance: /\b(?:finance|financial|profit|fee|commission|accrual|transaction)\b|财务|利润|费用|佣金|收单费|交易/iu,
  marketing: /\b(?:marketing|promotion|campaign|advertising|advertisement|ad\s)\b|营销|推广|广告|活动/iu,
  analytics: /\b(?:analytics|metric|dashboard|report|insight|analysis)\b|分析|指标|报表|经营|看板/iu,
  crossBorderBus: /cross.?border.?bus|kuajing|跨境巴士|物流同步|物流预报|预报物流/iu,
});

const OZON_ANCHOR = /\bozon\b|俄罗斯电商|俄区平台/iu;
const WRITE_INTENT =
  /\b(?:publish|submit|create|update|modify|delete|remove|cancel|approve|reject|ship|write\s*back)\b|发布|提交|新建|创建|写入|修改|删除|取消|审核|发货|回写/iu;
const NEGATIVE_LINE =
  /\b(?:never|do\s+not|does\s+not|without\s+permission|read\s+only|readonly)\b|禁止|不得|不会|不允许|只读|不自动|未授权/iu;

const BUILT_IN_CAPABILITIES = Object.freeze({
  'ozon-product-search': ['ozon.products.read', 'ozon.browser.read'],
  'ozon-product-selection': [
    'ozon.products.read',
    'ozon.browser.read',
    'seerfar.market.read',
    'purchase-browser.read',
    'model.text.generate',
  ],
  'ozon-ad-analyzer': ['ozon.performance.read', 'model.text.generate'],
  'ozon-product-image-generation': [
    'ozon.products.read',
    'ozon.productImages.read',
    'model.image.generate',
    'product-image-storage',
  ],
  'profit-risk-review': ['local-business-data.read', 'seerfar.market.read', 'model.text.generate'],
  'ozon-skill-1688-product-detail-query': ['purchase-browser.read'],
  'ozon-skill-1688-channel-shopdata-get': ['local-business-data.read'],
  'ozon-skill-1688-channel-shopdata-analyzer': ['local-business-data.read', 'model.text.generate'],
});

function cleanText(value) {
  return String(value ?? '').trim();
}

function cleanList(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
    .map(cleanText)
    .filter(Boolean);
}

function getToolSearchText(tool = {}) {
  const profile = tool?.skillProfile && typeof tool.skillProfile === 'object' ? tool.skillProfile : {};
  const promptConfig = tool?.promptConfig && typeof tool.promptConfig === 'object' ? tool.promptConfig : {};
  return [
    tool.title,
    tool.goal,
    tool.body,
    tool.scene,
    ...cleanList(tool.variables),
    ...cleanList(tool.dependencies),
    ...cleanList(profile.capabilities),
    ...cleanList(profile.inputs),
    ...cleanList(profile.outputs),
    ...cleanList(profile.workflowSteps),
    ...cleanList(profile.safetyNotes),
    ...cleanList(promptConfig.capabilities),
    ...cleanList(promptConfig.inputs),
    ...cleanList(promptConfig.outputs),
    ...cleanList(promptConfig.workflowSteps),
  ]
    .filter(Boolean)
    .join('\n');
}

function getActionableText(text = '') {
  return String(text)
    .split(/\r?\n/u)
    .filter((line) => !NEGATIVE_LINE.test(line))
    .join('\n');
}

function groupRegisteredInterfaces() {
  const groups = new Map();
  listExternalInterfaceRegistrations().forEach((entry) => {
    const id = `${entry.provider}.${entry.domain}.${entry.access}`;
    const current = groups.get(id) || [];
    current.push(entry);
    groups.set(id, current);
  });
  return groups;
}

function getReadinessStatus(capability, environment = {}) {
  if (capability.access === 'write') {
    return {
      status: 'business_guard',
      statusLabel: '需安全接入',
      ready: false,
    };
  }
  if (!capability.readinessKey) {
    return { status: 'ready', statusLabel: '已预装', ready: true };
  }
  const ready = Boolean(environment[capability.readinessKey]);
  return {
    status: ready ? 'ready' : 'missing_configuration',
    statusLabel: ready ? '已配置' : '待配置',
    ready,
  };
}

function createRegisteredCapability(provider, domain, access, entries) {
  const isCrossBorder = provider === 'cross-border-bus';
  const labelBase = DOMAIN_LABELS[domain] || domain;
  return {
    id: isCrossBorder ? `cross-border.${access}` : `${provider}.${domain}.${access}`,
    label: `${labelBase}${access === 'write' ? '写入' : '读取'}`,
    provider,
    domain,
    access,
    readinessKey: isCrossBorder ? 'hasCrossBorderAccount' : 'hasOzonShop',
    settingsModule: isCrossBorder ? 'crossBorderLogistics' : 'platformApi',
    executionMode: access === 'write' ? 'business-guard' : 'service',
    endpoints: entries.map(({ endpoint, method }) => ({ endpoint, method })),
    endpointCount: entries.length,
    installedByDefault: true,
  };
}

const VIRTUAL_CAPABILITIES = Object.freeze(
  [
    {
      id: 'ozon.performance.read',
      label: 'Ozon 广告数据读取',
      provider: 'ozon-performance',
      domain: 'marketing',
      access: 'read',
      readinessKey: 'hasPerformanceAccount',
      settingsModule: 'platformApi',
      executionMode: 'dedicated-service',
    },
    {
      id: 'seerfar.market.read',
      label: 'Seerfar 市场数据读取',
      provider: 'seerfar',
      domain: 'market-data',
      access: 'read',
      readinessKey: 'hasThirdPartyToolAccount',
      settingsModule: 'integration',
      executionMode: 'dedicated-service',
    },
    {
      id: 'model.text.generate',
      label: '文本模型',
      provider: 'model-gateway',
      domain: 'text-model',
      access: 'read',
      // The model selector always provides the user's verified API accounts
      // and the built-in points gateway as a safe fallback. Treat the
      // capability as installed; the selected account is validated again at
      // execution time and secrets never enter the renderer.
      readinessKey: '',
      settingsModule: 'modelApi',
      executionMode: 'model-gateway',
    },
    {
      id: 'model.image.generate',
      label: '图片模型',
      provider: 'model-gateway',
      domain: 'image-model',
      access: 'read',
      readinessKey: '',
      settingsModule: 'modelApi',
      executionMode: 'model-gateway',
    },
    {
      id: 'purchase-browser.read',
      label: '国内采购平台读取',
      provider: 'purchase-browser',
      domain: 'purchase',
      access: 'read',
      readinessKey: 'hasPurchaseAccount',
      settingsModule: 'purchaseAccount',
      executionMode: 'browser-service',
    },
    {
      id: 'ozon.browser.read',
      label: 'Ozon 内置浏览器读取',
      provider: 'ozon-browser',
      domain: 'browser',
      access: 'read',
      readinessKey: 'hasOzonBrowser',
      settingsModule: '',
      executionMode: 'browser-service',
    },
    {
      id: 'local-business-data.read',
      label: '本地业务数据读取',
      provider: 'local-api',
      domain: 'local-data',
      access: 'read',
      readinessKey: 'hasLocalBusinessData',
      settingsModule: '',
      executionMode: 'local-service',
    },
    {
      id: 'product-image-storage',
      label: '商品图片安全存储',
      provider: 'product-image-storage',
      domain: 'image-storage',
      access: 'read',
      readinessKey: 'hasProductImageStorage',
      settingsModule: 'productImageStorage',
      executionMode: 'dedicated-service',
    },
  ].map((item) => ({ ...item, endpoints: [], endpointCount: 0, installedByDefault: true }))
);

export function listSmartToolApiCapabilities() {
  const registered = [];
  groupRegisteredInterfaces().forEach((entries) => {
    const [{ provider, domain, access }] = entries;
    registered.push(createRegisteredCapability(provider, domain, access, entries));
  });
  return [...registered, ...VIRTUAL_CAPABILITIES].sort((left, right) => left.id.localeCompare(right.id));
}

function getExplicitCapabilityIds(tool = {}) {
  const profile = tool?.skillProfile && typeof tool.skillProfile === 'object' ? tool.skillProfile : {};
  const values =
    Array.isArray(profile.requiredCapabilities) && profile.requiredCapabilities.length
      ? profile.requiredCapabilities
      : Array.isArray(profile.apiBindings)
        ? profile.apiBindings
        : [];
  return values.map((item) => (typeof item === 'string' ? cleanText(item) : cleanText(item?.id))).filter(Boolean);
}

function inferCapabilityIds(tool = {}, capabilities = listSmartToolApiCapabilities()) {
  const knownIds = new Set(capabilities.map((item) => item.id));
  const explicitIds = getExplicitCapabilityIds(tool).filter((id) => knownIds.has(id));
  const profile = tool?.skillProfile && typeof tool.skillProfile === 'object' ? tool.skillProfile : {};
  const runType = cleanText(profile.runType || tool.runType || tool.actionMode).toLowerCase();
  const isInstalledDeclarativeSkill =
    Boolean(
      cleanText(profile.installType) ||
      cleanText(profile.sourceUrl) ||
      cleanText(profile.repository) ||
      cleanText(profile.sourceHash) ||
      (Array.isArray(profile.referenceFiles) && profile.referenceFiles.length)
    ) && !['external-or-script', 'guard-required'].includes(runType);
  if (explicitIds.length) {
    if (isInstalledDeclarativeSkill && knownIds.has('model.text.generate')) {
      explicitIds.push('model.text.generate');
    }
    return [...new Set(explicitIds)];
  }

  const builtInIds = BUILT_IN_CAPABILITIES[cleanText(tool.id)] || [];
  if (builtInIds.length) return builtInIds.filter((id) => knownIds.has(id));

  const text = getToolSearchText(tool);
  const actionableText = getActionableText(text);
  const hasOzon = OZON_ANCHOR.test(text);
  const hasWriteIntent = WRITE_INTENT.test(actionableText);
  const matched = new Set();
  if (isInstalledDeclarativeSkill && knownIds.has('model.text.generate')) matched.add('model.text.generate');

  capabilities.forEach((capability) => {
    if (capability.id === 'ozon.performance.read') {
      if (/performance|广告|推广|campaign|advertis/iu.test(text)) matched.add(capability.id);
      return;
    }
    if (capability.id === 'seerfar.market.read') {
      if (/seerfar|linkfox|领狐|市场数据|竞品数据/iu.test(text)) matched.add(capability.id);
      return;
    }
    if (capability.id === 'model.text.generate') {
      if (
        /\b(?:ai|llm|model|prompt|translate|copywriting|seo)\b|大模型|文本模型|提示词|翻译|文案|标题|描述|内容生成/iu.test(
          text
        )
      ) {
        matched.add(capability.id);
      }
      return;
    }
    if (capability.id === 'model.image.generate') {
      if (/\b(?:image\s*generation|generate\s*images?|image\s*model)\b|生图|图片生成|图像模型/iu.test(text)) {
        matched.add(capability.id);
      }
      return;
    }
    if (capability.id === 'purchase-browser.read') {
      if (/1688|淘宝|天猫|拼多多|京东|采购平台|货源/iu.test(text)) matched.add(capability.id);
      return;
    }
    if (capability.id === 'ozon.browser.read') {
      if (hasOzon && /browser|浏览器|网页|商品搜索|客服|跟卖|页面/iu.test(text)) matched.add(capability.id);
      return;
    }
    if (capability.id === 'local-business-data.read') {
      if (/本地(?:业务)?数据|sqlite|利润账本|历史订单|经营数据/iu.test(text)) matched.add(capability.id);
      return;
    }
    if (capability.id === 'product-image-storage') {
      if (/oss|对象存储|图片存储|图片资产|暗水印|证据图/iu.test(text)) matched.add(capability.id);
      return;
    }

    const domainPattern = DOMAIN_KEYWORDS[capability.domain];
    if (!domainPattern?.test(text)) return;
    if (capability.provider === 'ozon' && !hasOzon) return;
    if (capability.provider === 'cross-border-bus' && capability.access === 'read') {
      matched.add(capability.id);
      return;
    }
    if (capability.access === 'read') matched.add(capability.id);
    if (capability.access === 'write' && hasWriteIntent) matched.add(capability.id);
  });

  return [...matched];
}

export function createSmartToolApiBindingManifest(tool = {}) {
  const capabilities = listSmartToolApiCapabilities();
  const capabilityMap = new Map(capabilities.map((item) => [item.id, item]));
  return inferCapabilityIds(tool, capabilities)
    .map((id) => capabilityMap.get(id))
    .filter(Boolean)
    .map((item) => ({
      id: item.id,
      label: item.label,
      provider: item.provider,
      domain: item.domain,
      access: item.access,
      endpointCount: item.endpointCount,
      executionMode: item.executionMode,
    }));
}

export function matchSmartToolApiCapabilities(tool = {}, environment = {}) {
  const capabilities = listSmartToolApiCapabilities();
  const capabilityMap = new Map(capabilities.map((item) => [item.id, item]));
  const ids = inferCapabilityIds(tool, capabilities);
  const bindings = ids
    .map((id) => capabilityMap.get(id))
    .filter(Boolean)
    .map((capability) => ({
      ...capability,
      ...getReadinessStatus(capability, environment),
    }));
  const readyCount = bindings.filter((item) => item.status === 'ready').length;
  const missingCount = bindings.filter((item) => item.status === 'missing_configuration').length;
  const guardedCount = bindings.filter((item) => item.status === 'business_guard').length;
  const endpointCount = bindings.reduce((total, item) => total + item.endpointCount, 0);

  return {
    version: SMART_TOOL_API_BINDING_VERSION,
    bindings,
    totalCount: bindings.length,
    readyCount,
    missingCount,
    guardedCount,
    endpointCount,
    registryEndpointCount: listExternalInterfaceRegistrations().length,
    summaryLabel: bindings.length
      ? missingCount
        ? `已匹配 ${bindings.length} 类接口，${missingCount} 项待配置`
        : guardedCount
          ? `已匹配 ${bindings.length} 类接口，${guardedCount} 项需安全接入`
          : `已匹配 ${bindings.length} 类接口`
      : '未识别到外部接口需求',
  };
}
