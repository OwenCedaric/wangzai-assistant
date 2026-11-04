import { createBlankStructuredRecord, normalizeStructuredRecord } from './structuredSettingsRecords.js';

const PLATFORM_INTEGRATION_PRESETS = {
  'seerfar-open-api': {
    title: 'Seerfar Open API',
    meta: 'Ozon 市场数据 / 店铺 / 关键词',
    status: '可选配置',
    statusColor: 'success',
    values: {
      integrationType: 'seerfar-open-api',
      platformName: 'Seerfar Open API',
      apiType: '市场数据',
      authMode: 'Bearer API Key',
      configStatus: '未配置时自动使用内置积分',
      tokenStatus: '可填写自己的 API Key',
      readScope: 'Ozon 店铺、竞品、类目、市场热词和关键词',
      writeScope: '无 Ozon 写入',
      baseUrl: 'https://api.seerfar.cn',
      billingMode: '自有 API 优先；未配置时使用软件积分',
    },
  },
  'linkfox-agent': {
    title: 'LinkFox Agent',
    meta: '外部 Skill / 数据工具网关',
    status: '待接入',
    statusColor: 'warning',
    values: {
      integrationType: 'linkfox-agent',
      platformName: 'LinkFox Agent',
      apiType: 'Skill 网关',
      authMode: 'API Key',
      configStatus: '待配置',
      tokenStatus: '未填写',
      readScope: '已授权 Skill 的查询结果',
      writeScope: '按 Skill 单独限制',
      baseUrl: 'https://tool-gateway.linkfox.com',
      billingMode: '按 LinkFox 积分计费',
    },
  },
  'ozon-performance': {
    title: 'Ozon Performance API',
    meta: '广告计划 / 出价 / 预算',
    status: '待配置',
    statusColor: 'default',
    values: {
      integrationType: 'ozon-performance',
      platformName: 'Ozon Performance API',
      apiType: '广告推广',
      authMode: 'client_id + client_secret',
      configStatus: '待配置',
      tokenStatus: '未获取',
      readScope: '广告计划、统计任务、广告商品',
      writeScope: '创建计划、预算、出价、启停广告需确认',
      baseUrl: 'api-performance.ozon.ru',
      shopId: '',
      billingMode: 'Ozon 官方接口',
    },
  },
  'ozon-browser-session': {
    title: 'Ozon 网页登录',
    meta: '验证码登录 / 独立 Cookie',
    status: '待登录',
    statusColor: 'default',
    values: {
      integrationType: 'ozon-browser-session',
      platformName: 'Ozon 网页登录',
      shopId: '',
      apiType: 'Ozon 市场数据',
      authMode: '验证码登录 + Cookie',
      configStatus: '待登录',
      tokenStatus: 'Cookie 未保存',
      readScope: '当前账号有权访问的商品、类目、搜索词和缺货数据',
      writeScope: '无 Ozon 写入',
      baseUrl: 'https://seller.ozon.ru/app/registration/signin?registration=1&locale=zh-hans',
      billingMode: 'Ozon 官方网页登录',
    },
  },
  'wecom-group-bot': {
    title: '企业微信群机器人',
    meta: '日报 / 异常提醒推送',
    status: '待配置',
    statusColor: 'default',
    values: {
      integrationType: 'wecom-group-bot',
      platformName: '企业微信群机器人',
      apiType: '消息通知',
      authMode: 'Webhook',
      configStatus: '待配置',
      tokenStatus: '未填写',
      readScope: '不读取任何外部数据',
      writeScope: '仅在你点击测试或后续启用的提醒规则触发时向指定群发送消息',
      baseUrl: 'https://qyapi.weixin.qq.com',
      billingMode: '企业微信机器人',
    },
  },
  'ozon-seller': {
    title: 'Ozon Seller API',
    meta: '店铺 / 商品 / 订单',
    status: '本地草稿',
    statusColor: 'default',
    values: {
      integrationType: 'ozon-seller',
      platformName: 'Ozon Seller API',
      apiType: '电商平台',
      authMode: 'Client ID + API Key',
      configStatus: '店铺入口配置',
      tokenStatus: '不适用',
      readScope: '店铺、商品、订单只读',
      writeScope: '库存、价格、发货等需确认',
      baseUrl: 'Ozon Seller API（本机中转）',
      billingMode: 'Ozon 官方接口',
    },
  },
  'cross-border': {
    title: '跨境巴士 API',
    meta: 'Token / 授权 / 仓库 / 订单',
    status: '本地草稿',
    statusColor: 'default',
    values: {
      integrationType: 'cross-border',
      platformName: '跨境巴士 API',
      apiType: '物流平台',
      authMode: 'client_secret + access_token + app_uid',
      configStatus: '物流授权入口',
      tokenStatus: '不适用',
      readScope: '授权查询、仓库、订单状态',
      writeScope: '授权、创建订单、更新订单需确认',
      baseUrl: '跨境巴士企业接口',
      billingMode: '按物流服务规则',
    },
  },
  tool: {
    title: '内部工具接口',
    meta: '模型 / 水印 / 采集',
    status: '本地草稿',
    statusColor: 'default',
    values: {
      integrationType: 'tool',
      platformName: '内部工具接口',
      apiType: '工具服务',
      authMode: '本地配置',
      configStatus: '本地草稿',
      tokenStatus: '不适用',
      readScope: '配置读取',
      writeScope: '批量处理需确认',
      baseUrl: '本机服务',
      billingMode: '本地配置',
    },
  },
  custom: {
    title: '自定义接口',
    meta: '本地草稿待填写',
    status: '本地草稿',
    statusColor: 'default',
    values: {
      integrationType: 'custom',
      platformName: '自定义接口',
      apiType: '自定义',
      authMode: '',
      configStatus: '本地草稿',
      tokenStatus: '未接入',
      readScope: '',
      writeScope: '',
      baseUrl: '接入时填写',
      billingMode: '接入时确认',
    },
  },
};

function getPlatformIntegrationPreset(integrationType) {
  return PLATFORM_INTEGRATION_PRESETS[integrationType] ?? PLATFORM_INTEGRATION_PRESETS.custom;
}

function createBlankPlatformApiRecord(config, index = 1, options = {}) {
  const record = createBlankStructuredRecord(config, index);
  return normalizeStructuredRecord(
    config,
    {
      ...record,
      isTransientDraft: true,
      isPlaceholderDraft: options.placeholder === true,
      title: `外部接口 ${index}`,
      meta: '请选择外部服务',
      status: '待配置',
      statusColor: 'default',
      values: {
        ...record.values,
        integrationType: '',
        platformName: '',
        apiType: '',
        authMode: '',
        configStatus: '',
        performanceClientId: '',
        performanceClientSecret: '',
        shopId: '',
        baseUrl: '',
        loginAccount: '',
        loginPassword: '',
        hasLoginPassword: false,
        apiKey: '',
        hasApiKey: false,
        wecomWebhook: '',
        hasWecomWebhook: false,
        tokenStatus: '',
        readScope: '',
        writeScope: '',
        remark: '',
      },
    },
    index - 1
  );
}

function getPlatformIntegrationType(record) {
  return String(record?.values?.integrationType || '').trim();
}

function getConfiguredPlatformIntegrationTypes(config = {}) {
  const typeField = (config.fields || []).find((field) => field.id === 'integrationType');
  if (!Array.isArray(typeField?.options) || typeField.options.length === 0) return null;
  return new Set(typeField.options.map((option) => String(option?.value || '').trim()).filter(Boolean));
}

function isRetiredPlatformIntegration(record, config = {}) {
  const integrationType = getPlatformIntegrationType(record);
  if (integrationType === 'mpstats-api') return true;
  const configuredTypes = getConfiguredPlatformIntegrationTypes(config);
  return Boolean(integrationType && configuredTypes && !configuredTypes.has(integrationType));
}

function isPlatformSaveAction(action) {
  return action === '保存接口资料' || action === '保存本地配置';
}

function getPerformanceAccountStatusLabel(account = {}) {
  if (account.status === 'active') return '连接成功';
  if (account.status === 'error') return '连接失败';
  if (account.hasClientId || account.hasClientSecret) return '已保存';
  return '待配置';
}

function getPerformanceAccountStatusColor(account = {}) {
  if (account.status === 'active') return 'success';
  if (account.status === 'error') return 'error';
  if (account.hasClientId || account.hasClientSecret) return 'primary';
  return 'default';
}

function mergePerformanceAccountsIntoStructuredRecords(config, records = [], accounts = []) {
  if (config.id !== 'platformApi' || !Array.isArray(accounts) || accounts.length === 0) return records;
  const preset = getPlatformIntegrationPreset('ozon-performance');
  const nextRecords = records
    .filter((record) => record?.isPlaceholderDraft !== true)
    .map((record, index) => normalizeStructuredRecord(config, record, index));
  const indexById = new Map(nextRecords.map((record, index) => [record.id, index]));

  accounts.forEach((account, accountIndex) => {
    let existingIndex = indexById.get(account.id);
    if (existingIndex === undefined || existingIndex < 0) {
      existingIndex = nextRecords.findIndex((record) => {
        const values = record.values ?? {};
        return (
          record?.isTransientDraft !== true &&
          getPlatformIntegrationType(record) === 'ozon-performance' &&
          !String(values.performanceClientId || '').trim() &&
          !values.hasPerformanceClientId &&
          !values.hasPerformanceClientSecret
        );
      });
    }
    const existing =
      existingIndex >= 0 ? nextRecords[existingIndex] : createBlankPlatformApiRecord(config, accountIndex + 1);
    const values = existing.values ?? {};
    const hasClientId = Boolean(account.hasClientId || values.hasPerformanceClientId || values.hasClientId);
    const hasClientSecret = Boolean(
      account.hasClientSecret || values.hasPerformanceClientSecret || values.hasClientSecret
    );
    const merged = normalizeStructuredRecord(
      config,
      {
        ...existing,
        id: account.id || existing.id,
        isTransientDraft: false,
        isPlaceholderDraft: false,
        title: account.title || account.name || existing.title || preset.title,
        meta:
          account.status === 'active'
            ? '只读测试通过'
            : hasClientSecret
              ? 'local-api 加密保存'
              : existing.meta || preset.meta,
        status: getPerformanceAccountStatusLabel(account),
        statusColor: getPerformanceAccountStatusColor(account),
        values: {
          ...values,
          ...preset.values,
          platformName: account.title || account.name || values.platformName || preset.title,
          performanceClientId: account.clientId || values.performanceClientId || '',
          performanceClientSecret: '',
          shopId: account.shopId || values.shopId || '',
          hasPerformanceClientId: hasClientId,
          hasPerformanceClientSecret: hasClientSecret,
          performanceAccountStatus: account.status || values.performanceAccountStatus || 'inactive',
          performanceClientSecretHint: account.clientSecretHint || values.performanceClientSecretHint || '',
          configStatus:
            account.status === 'active'
              ? '连接成功'
              : hasClientSecret
                ? '已加密保存'
                : values.configStatus || preset.values.configStatus,
          tokenStatus: values.tokenStatus || (account.status === 'active' ? '有效' : '未获取'),
          campaignCount: account.campaignCount ?? values.campaignCount,
          statisticsTaskCount: account.statisticsTaskCount ?? values.statisticsTaskCount,
          lastTestAt: account.lastTestAt || values.lastTestAt || '',
          lastTestMessage: account.lastTestMessage || values.lastTestMessage || '',
          remark: account.note || values.remark || '',
        },
      },
      existingIndex >= 0 ? existingIndex : nextRecords.length
    );
    if (existingIndex >= 0) {
      nextRecords[existingIndex] = merged;
      if (account.id) indexById.set(account.id, existingIndex);
      return;
    }
    indexById.set(merged.id, nextRecords.length);
    nextRecords.push(merged);
  });

  return nextRecords;
}

function buildPlatformApiProfileItems(record) {
  const values = record?.values ?? {};
  const integrationType = getPlatformIntegrationType(record);
  const clientId = String(values.performanceClientId || '').trim();
  const clientSecret = String(values.performanceClientSecret || '').trim();
  const hasClientId = Boolean(clientId || values.hasPerformanceClientId || values.hasClientId);
  const hasClientSecret = Boolean(clientSecret || values.hasPerformanceClientSecret || values.hasClientSecret);
  if (integrationType === 'ozon-browser-session') {
    const connected = values.configStatus === '连接成功' && values.tokenStatus === 'Cookie 已保存';
    return [
      { label: '服务类别', value: 'Ozon 市场数据' },
      { label: '绑定店铺', value: String(values.shopId || '').trim() || '未绑定' },
      { label: '登录方式', value: '验证码登录' },
      { label: 'Cookie', value: connected ? '已保存' : '未保存' },
      { label: '连接状态', value: connected ? '已连接' : '待登录' },
      { label: '最后验证', value: String(values.lastTestAt || '').trim() || '未验证' },
      { label: '写入权限', value: '无 Ozon 写入' },
    ];
  }
  if (integrationType === 'ozon-performance') {
    return [
      { label: '服务类别', value: String(values.apiType || '').trim() || '广告推广' },
      { label: '绑定店铺', value: String(values.shopId || '').trim() || '未绑定' },
      { label: '鉴权方式', value: String(values.authMode || '').trim() || 'client_id + client_secret' },
      { label: 'Client ID', value: clientId || (hasClientId ? '已保存' : '未填写') },
      {
        label: 'Client Secret',
        value: clientSecret ? '••••••••••' : values.performanceClientSecretHint || (hasClientSecret ? '••••••••••' : '未填写'),
      },
      { label: '连接状态', value: String(values.configStatus || '').trim() || '待配置' },
      { label: '最后测试', value: values.lastTestAt || '未测试' },
    ];
  }
  const hasApiKey = integrationType === 'wecom-group-bot'
    ? Boolean(String(values.wecomWebhook || '').trim() || values.hasWecomWebhook)
    : Boolean(String(values.apiKey || '').trim() || values.hasApiKey);
  const lastTestStatus = String(values.lastTestStatus || '').trim();
  const credentialStatus = lastTestStatus === 'connected'
    ? '有效'
    : lastTestStatus === 'limited'
      ? '有效，额度不足'
      : lastTestStatus === 'error'
        ? '测试失败'
        : hasApiKey
          ? '已加密保存，待测试'
          : '未填写';
  return [
    { label: '服务类别', value: String(values.apiType || '').trim() || '待选择' },
    {
      label: '接口地址',
      value: integrationType === 'wecom-group-bot'
        ? 'https://qyapi.weixin.qq.com'
        : String(values.baseUrl || '').trim() || '选择后自动带出',
    },
    { label: '鉴权方式', value: String(values.authMode || '').trim() || '选择后自动带出' },
    { label: 'API 凭证', value: credentialStatus },
    { label: '连接状态', value: String(values.configStatus || '').trim() || '待测试' },
    { label: '最后测试', value: String(values.lastTestAt || '').trim() || '未测试' },
  ];
}

function getPlatformApiErrorMessage(error) {
  const message = (
    error?.payload?.error?.message ||
    error?.payload?.message ||
    (error instanceof Error ? error.message : String(error || '连接测试失败。'))
  );
  const friendly = {
    OZON_BROWSER_SHOP_REQUIRED: '请先选择这个网页登录所属的 Ozon 店铺。',
    OZON_BROWSER_SHOP_NOT_FOUND: '绑定的 Ozon 店铺已不存在，请重新选择。',
    OZON_BROWSER_SHOP_ALREADY_BOUND: '这个店铺已经绑定了另一个 Ozon 网页登录，请直接编辑原配置。',
  };
  return friendly[String(message || '').trim()] || message;
}

export {
  PLATFORM_INTEGRATION_PRESETS,
  getPlatformIntegrationPreset,
  createBlankPlatformApiRecord,
  getPlatformIntegrationType,
  getConfiguredPlatformIntegrationTypes,
  isRetiredPlatformIntegration,
  isPlatformSaveAction,
  getPerformanceAccountStatusLabel,
  getPerformanceAccountStatusColor,
  mergePerformanceAccountsIntoStructuredRecords,
  buildPlatformApiProfileItems,
  getPlatformApiErrorMessage,
};
