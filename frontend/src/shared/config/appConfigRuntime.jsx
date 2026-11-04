import { createRequestCooldownState } from '../../services/requestCooldown';
import React from 'react';
import AddShoppingCartRounded from '@mui/icons-material/AddShoppingCartRounded';
import CloudSyncRounded from '@mui/icons-material/CloudSyncRounded';
import LocalShippingRounded from '@mui/icons-material/LocalShippingRounded';
import SettingsRounded from '@mui/icons-material/SettingsRounded';
import { PURCHASE_ACCOUNT_ALIAS_OPTIONS, PURCHASE_ACCOUNT_PLATFORM_OPTIONS } from './purchaseAccountPresets.js';
import {
  deserializeOzonShopGenerationScope,
  isOzonCacheKeyBlockedByGenerationFence,
  normalizeOzonShopGenerationScope,
  ozonCacheKeyBelongsToOwner,
  serializeOzonShopGenerationScope,
} from '../ozon/ozonShopGeneration.js';

export const structuredSettingsLayouts = {
  crossBorderBus: {
    id: 'crossBorderBus',
    listTitle: '授权列表',
    countLabel: '共 1 个授权',
    addLabel: '新增',
    removeLabel: '删除当前授权',
    mainTitle: '跨境巴士资料',
    mainSubtitle: '只填写账号和密码完成一次性服务器授权；企业 API 由管理端统一保管',
    badge: '服务器授权',
    showNote: false,
    avatarClass: 'store-warning',
    avatarIcon: <LocalShippingRounded />,
    profileTitle: '跨境巴士主授权',
    profileSubtitle: '管理端统一授权，客户端只保存授权引用',
    profileChip: { label: '待配置', color: 'default' },
    sideTitle: '接口依据',
    sideChip: { label: '连接读取', color: 'success' },
    records: [
      {
        id: 'cross-border-main',
        title: '跨境巴士主授权',
        meta: '等待服务器授权',
        status: '待配置',
        statusColor: 'default',
        values: {
          accountAlias: '跨境巴士主授权',
          userName: '',
          password: '',
          shopIds: [],
          cooperationWarehouse: '',
          packageService: '',
        },
      },
    ],
    sections: [
      {
        title: '账号资料',
        authorizationButtonLabel: '获取授权',
        fields: [
          { id: 'userName', label: '跨境巴士用户名' },
          { id: 'password', label: '密码', type: 'password' },
          { id: 'shopIds', label: '绑定 Ozon 店铺', multiple: true },
        ],
      },
      {
        title: '预报设置',
        buttonLabel: '保存设置',
        fields: [
          {
            id: 'cooperationWarehouse',
            label: '合作仓库',
          },
          {
            id: 'packageService',
            label: '打包服务',
          },
        ],
      },
    ],
    fields: [
      { id: 'userName', label: '跨境巴士用户名' },
      { id: 'password', label: '密码', type: 'password' },
      { id: 'shopIds', label: '绑定 Ozon 店铺', multiple: true },
      { id: 'cooperationWarehouse', label: '合作仓库' },
      { id: 'packageService', label: '打包服务' },
    ],
    profileItems: [
      { label: '服务器授权', value: '未授权' },
      { label: '合作仓库', value: '未选择' },
      { label: '打包服务', value: '未选择' },
      { label: '保存', value: '未保存' },
    ],
    apiChecks: [
      {
        endpoint: '管理端授权',
        title: '服务器授权',
        usage: '账号和密码只用于一次性授权；企业 API 和企业 Token 不下发客户端。',
        risk: '只读准备',
      },
      {
        endpoint: '本地保存',
        title: '预报设置',
        usage: '合作仓库和打包服务先按本地默认值保存。',
        risk: '本地配置',
      },
    ],
    actions: [],
  },
  purchaseAccount: {
    id: 'purchaseAccount',
    listTitle: '账号列表',
    countLabel: '共 1 个账号',
    addLabel: '新增',
    removeLabel: '删除当前账号',
    mainTitle: '拍单账号资料',
    mainSubtitle: '本机加密保存采购平台登录信息与收货资料',
    badge: '本机加密',
    showNote: false,
    avatarClass: 'store-primary',
    avatarIcon: <AddShoppingCartRounded />,
    profileTitle: '1688采购号',
    profileSubtitle: '本机加密保存，未做登录校验',
    profileChip: { label: '待配置', color: 'default' },
    sideTitle: '配置依据',
    sideChip: { label: '本地规则', color: 'primary' },
    records: [
      {
        id: 'purchase-main',
        title: '1688采购号',
        meta: '登录信息待填写',
        status: '待配置',
        statusColor: 'default',
        values: {
          accountAlias: '1688采购号',
          platformName: '1688',
          loginAccount: '',
          loginPassword: '',
          recipientNickname: '',
          recipientPhone: '',
          recipientAddress: '',
        },
      },
    ],
    fields: [
      {
        id: 'platformName',
        label: '采购平台',
        placeholder: '请选择采购平台',
        options: PURCHASE_ACCOUNT_PLATFORM_OPTIONS,
        required: true,
      },
      {
        id: 'accountAlias',
        label: '账号简称',
        placeholder: '请选择账号简称',
        options: PURCHASE_ACCOUNT_ALIAS_OPTIONS,
        required: true,
      },
      { id: 'loginAccount', label: '登录账号', placeholder: '手机号 / 用户名 / 邮箱' },
      { id: 'loginPassword', label: '登录密码', type: 'password', placeholder: '输入后由本机加密保存' },
      { id: 'recipientNickname', label: '收件人昵称', placeholder: '请输入收件人昵称', required: true },
      { id: 'recipientPhone', label: '收货手机号', placeholder: '请输入收货手机号', required: true },
      {
        id: 'recipientAddress',
        label: '收货地址',
        placeholder: '请输入完整收货地址',
        multiline: true,
        minRows: 2,
        className: 'shop-wide-field',
        required: true,
      },
    ],
    profileItems: [
      { label: '采购平台', value: '1688' },
      { label: '收件人昵称', value: '未填写' },
      { label: '收货手机号', value: '未填写' },
      { label: '收货地址', value: '未填写' },
      { label: '登录状态', value: '未校验' },
    ],
    apiChecks: [
      {
        endpoint: '本地账号资料',
        title: '账号保存',
        usage: '加密保存平台、登录资料和收货信息等本机配置。',
        risk: '本机加密',
      },
      {
        endpoint: '后续拍单流程',
        title: '账号选择',
        usage: '拍单时调用对应平台入口、采购账号和收货信息。',
        risk: '不下单',
      },
      {
        endpoint: '登录校验',
        title: '状态检查',
        usage: '后续通过内置采购页面验证登录并复用账号 Cookie。',
        risk: '待确认',
      },
    ],
    actions: ['新增账号', '设为默认', '检查本地资料'],
  },
  modelApi: {
    id: 'modelApi',
    listTitle: '接口列表',
    countLabel: '共 1 个接口',
    addLabel: '新增',
    removeLabel: '删除当前接口',
    mainTitle: '模型接口配置',
    mainSubtitle: '只填写接口地址和 API Key，后台自动识别接口',
    badge: '本地配置',
    noteTitle: '使用说明',
    note: '这里只填写接口地址和 API Key；保存时由本机后台自动识别模型和能力。',
    avatarClass: 'store-primary',
    avatarIcon: <CloudSyncRounded />,
    profileTitle: '模型中转站',
    profileSubtitle: '保存后自动识别模型和能力',
    profileChip: { label: '待配置', color: 'default' },
    sideTitle: '配置依据',
    sideChip: { label: '本地接口', color: 'primary' },
    records: [
      {
        id: 'model-api-main',
        title: '模型中转站',
        meta: '接口地址和 API Key 待填写',
        status: '待配置',
        statusColor: 'default',
        values: {
          apiAlias: '模型中转站',
          provider: '',
          websiteUrl: '',
          apiKey: '',
          defaultModel: '',
          usageScene: '',
          remark: '',
        },
      },
    ],
    fields: [
      { id: 'websiteUrl', label: '接口地址', placeholder: 'https://...' },
      { id: 'apiKey', label: 'API Key', type: 'password', placeholder: '输入 API Key' },
    ],
    profileItems: [
      { label: '识别状态', value: '保存后自动识别' },
      { label: '可用模型', value: '后台返回' },
      { label: '能力', value: '后台返回' },
      { label: '保存', value: '未保存' },
    ],
    apiChecks: [
      {
        endpoint: '接口配置',
        title: '接口凭证',
        usage: '保存接口地址和 API Key。',
        risk: '本机加密',
      },
      {
        endpoint: '自动识别',
        title: '后台寻找接口',
        usage: '根据网址和 API Key 自动查找接口、模型和能力。',
        risk: '保存时执行',
      },
      {
        endpoint: '使用选择',
        title: '固定或随机',
        usage: '实际使用页选择模型，支持多模型随机。',
        risk: '按接口规则',
      },
    ],
    actions: ['新增中转站', '保存并自动识别', '设为默认'],
  },
  platformApi: {
    id: 'platformApi',
    listTitle: '已添加接口',
    countLabel: '共 0 个接口',
    addLabel: '添加接口',
    removeLabel: '删除当前接口',
    mainTitle: '外部接口配置',
    mainSubtitle: '选择服务后，只显示真实调用所需的连接资料',
    badge: '统一接入',
    noteTitle: '接入说明',
    note: '系统已内置 Seerfar、LinkFox、Ozon 网页登录和 Ozon Performance 的连接入口。密码与 API Key 只在 local-api 加密保存；Ozon 登录 Cookie 只保存在独立浏览器 Profile 中。',
    avatarClass: 'store-primary',
    avatarIcon: <SettingsRounded />,
    profileTitle: '接口概览',
    profileSubtitle: '先选择需要接入的外部服务',
    profileChip: { label: '待配置', color: 'default' },
    sideTitle: '用途与规则',
    sideChip: { label: '自动带出', color: 'primary' },
    records: [
      {
        id: 'platform-ozon-performance',
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
          performanceClientId: '',
          performanceClientSecret: '',
          shopId: '',
          tokenStatus: '未获取',
          readScope: '广告计划、统计任务、广告商品',
          writeScope: '创建计划、预算、出价、启停广告需确认',
          remark: '',
        },
      },
    ],
    fields: [
      {
        id: 'integrationType',
        label: '外部服务',
        placeholder: '选择需要接入的服务',
        options: [
          { value: 'seerfar-open-api', label: 'Seerfar Open API' },
          { value: 'linkfox-agent', label: 'LinkFox Agent' },
          { value: 'ozon-browser-session', label: 'Ozon 网页登录' },
          { value: 'ozon-performance', label: 'Ozon Performance API' },
          { value: 'wecom-group-bot', label: '企业微信群机器人' },
        ],
      },
      { id: 'platformName', label: '配置名称', placeholder: '例如 Seerfar 市场数据' },
      {
        id: 'baseUrl',
        label: '接口网址',
        placeholder: '选择服务后自动带出，可核对但不能改成其他域名',
        className: 'shop-wide-field',
        integrationTypes: ['seerfar-open-api', 'linkfox-agent'],
        required: true,
      },
      {
        id: 'apiKey',
        label: 'API Key / Token',
        type: 'password',
        placeholder: '填写平台生成的 API Key 或 Token',
        className: 'shop-wide-field',
        integrationTypes: ['seerfar-open-api', 'linkfox-agent'],
        required: true,
      },
      {
        id: 'wecomWebhook',
        label: '机器人 Webhook 地址',
        type: 'password',
        placeholder: '粘贴企业微信群机器人生成的完整 Webhook 地址',
        className: 'shop-wide-field',
        integrationTypes: ['wecom-group-bot'],
        required: true,
      },
      {
        id: 'shopId',
        label: '绑定 Ozon 店铺',
        placeholder: '选择这个账号所属的店铺',
        className: 'shop-wide-field',
        integrationTypes: ['ozon-browser-session', 'ozon-performance'],
        required: true,
      },
      {
        id: 'performanceClientId',
        label: '账号（Client ID）',
        placeholder: 'xxx@advertising.performance.ozon.ru',
        className: 'shop-wide-field',
        integrationTypes: ['ozon-performance'],
      },
      {
        id: 'performanceClientSecret',
        label: '密码（Client Secret）',
        type: 'password',
        placeholder: '填写 Ozon Performance API Client Secret',
        className: 'shop-wide-field',
        integrationTypes: ['ozon-performance'],
      },
      {
        id: 'remark',
        label: '备注（选填）',
        placeholder: '例如：用于 Ozon 竞品店铺与关键词查询',
        multiline: true,
        minRows: 2,
        className: 'shop-remark-field',
        integrationTypes: ['seerfar-open-api', 'linkfox-agent', 'ozon-performance'],
      },
    ],
    profileItems: [
      { label: '市场数据', value: '按账号配置' },
      { label: 'Performance', value: '待配置' },
      { label: 'Ozon 登录', value: '按店铺配置' },
      { label: '保存', value: '未保存' },
    ],
    apiChecks: [
      {
        endpoint: 'api.seerfar.cn',
        title: 'Seerfar Open API',
        usage: '店铺、竞品、类目、市场热词和关键词数据。使用官方额度接口做真实连接测试。',
        risk: '只读数据',
        integrationTypes: ['seerfar-open-api'],
      },
      {
        endpoint: 'tool-gateway.linkfox.com',
        title: 'LinkFox Agent',
        usage: '通过 LinkFox 网关调用已安装的外部数据 Skill。测试只验证鉴权，不发起付费商品查询。',
        risk: '按次计费',
        integrationTypes: ['linkfox-agent'],
      },
      {
        endpoint: 'sso.ozon.ru/auth',
        title: 'Ozon 网页登录',
        usage: '通过验证码登录独立浏览器，只复用当前用户本来有权访问的 Ozon 页面与 Cookie。',
        risk: '只读登录',
        integrationTypes: ['ozon-browser-session'],
      },
      {
        endpoint: 'Ozon Performance API',
        title: '付费推广接口',
        usage: '支持加密保存 Client ID 和 Client Secret，并执行广告计划与统计任务的只读连接测试。',
        risk: '读写分级',
        integrationTypes: ['ozon-performance'],
      },
      {
        endpoint: 'qyapi.weixin.qq.com',
        title: '企业微信群机器人',
        usage: '粘贴群机器人 Webhook 后可发送测试消息；日报与异常提醒需在后续功能中单独开启。',
        risk: '仅向你指定的企业微信群发送消息',
        integrationTypes: ['wecom-group-bot'],
      },
    ],
    actions: ['测试连接', '保存接口资料', '打开日志'],
  },
};

export const ozonApiPerformanceCounter = { count: 0 };

export const ozonSnapshotMemoryCache = new Map();

export const ozonSnapshotInFlight = new Map();

export const ozonSnapshotManualRefreshAt = new Map();

const OZON_SNAPSHOT_OWNER_FENCE_PREFIX = '__account-removal-owner-fence__:';

function snapshotKeyBelongsToOwner(cacheKey, ownerScope = []) {
  return ozonCacheKeyBelongsToOwner(cacheKey, normalizeOzonShopGenerationScope(ownerScope));
}

function getOzonSnapshotOwnerFences() {
  return [...ozonSnapshotManualRefreshAt.keys()]
    .filter((key) => String(key).startsWith(OZON_SNAPSHOT_OWNER_FENCE_PREFIX))
    .map((key) => deserializeOzonShopGenerationScope(String(key).slice(OZON_SNAPSHOT_OWNER_FENCE_PREFIX.length)));
}

export function isOzonSnapshotOwnerFenced(cacheKey) {
  return getOzonSnapshotOwnerFences().some((scope) => isOzonCacheKeyBlockedByGenerationFence(cacheKey, scope));
}

export async function fenceAndDrainOzonSnapshotCachesForOwner(ownerScope = []) {
  const scope = normalizeOzonShopGenerationScope(ownerScope);
  ozonSnapshotManualRefreshAt.set(
    `${OZON_SNAPSHOT_OWNER_FENCE_PREFIX}${serializeOzonShopGenerationScope(scope)}`,
    Number.MAX_SAFE_INTEGER
  );
  const pending = [...ozonSnapshotInFlight.entries()]
    .filter(([key]) => snapshotKeyBelongsToOwner(key, scope))
    .map(([, promise]) => promise);
  await Promise.allSettled(pending);
  invalidateOzonSnapshotCachesForOwner(scope);
  return { fenced: true, drained: true };
}

export function releaseOzonSnapshotOwnerFence(ownerScope) {
  return ozonSnapshotManualRefreshAt.delete(`${OZON_SNAPSHOT_OWNER_FENCE_PREFIX}${serializeOzonShopGenerationScope(normalizeOzonShopGenerationScope(ownerScope))}`);
}

export function invalidateOzonSnapshotCachesForOwner(ownerScope = []) {
  for (const cache of [ozonSnapshotMemoryCache, ozonSnapshotInFlight, ozonSnapshotManualRefreshAt]) {
    for (const key of cache.keys()) {
      if (!String(key).startsWith(OZON_SNAPSHOT_OWNER_FENCE_PREFIX) && snapshotKeyBelongsToOwner(key, ownerScope))
        cache.delete(key);
    }
  }
}

export function invalidateOzonOrderSnapshotCachesForOwner(ownerScope = [], domain = 'orders') {
  const normalizedDomain = String(domain || '').trim().toLowerCase();
  const prefixes = normalizedDomain === 'returns'
    ? ['ozon-after-sales:']
    : ['ozon-sales-orders:', 'ozon-orders-shared:', 'ozon-purchase-orders:', 'ozon-after-sales:'];
  for (const cache of [ozonSnapshotMemoryCache, ozonSnapshotInFlight, ozonSnapshotManualRefreshAt]) {
    for (const key of cache.keys()) {
      const text = String(key);
      if (text.startsWith(OZON_SNAPSHOT_OWNER_FENCE_PREFIX)) continue;
      if (!prefixes.some((prefix) => text.startsWith(prefix))) continue;
      if (snapshotKeyBelongsToOwner(text, ownerScope)) cache.delete(key);
    }
  }
}

export function countOzonSnapshotCachesForOwner(ownerScope = []) {
  let count = 0;
  for (const cache of [ozonSnapshotMemoryCache, ozonSnapshotInFlight, ozonSnapshotManualRefreshAt]) {
    for (const key of cache.keys()) {
      if (!String(key).startsWith(OZON_SNAPSHOT_OWNER_FENCE_PREFIX) && snapshotKeyBelongsToOwner(key, ownerScope))
        count += 1;
    }
  }
  return count;
}

export const salesSupplementCooldown = createRequestCooldownState({
  baseCooldownMs: 45_000,
  maxCooldownMs: 5 * 60_000,
});

export const purchaseSupplementCooldown = createRequestCooldownState({
  baseCooldownMs: 45_000,
  maxCooldownMs: 5 * 60_000,
});

export const profitFinanceCooldown = createRequestCooldownState({ baseCooldownMs: 60_000, maxCooldownMs: 10 * 60_000 });

export function getPerformanceNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

export function getOzonApiRequestCount() {
  return ozonApiPerformanceCounter.count;
}

export function roundPerformanceMs(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}
