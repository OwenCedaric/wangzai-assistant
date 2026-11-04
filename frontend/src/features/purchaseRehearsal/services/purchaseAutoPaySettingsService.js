import { getProfileSetting, saveProfileSetting } from '../../../api/localApiClient.js';

export const PURCHASE_AUTO_PAY_SETTINGS_NAMESPACE = 'purchase-auto-pay-settings';

export const DEFAULT_PURCHASE_AUTO_PAY_SETTINGS = Object.freeze({
  enabled: false,
  allowPinduoduo: true,
  allowTaobao: false,
  allowTmall: false,
  allow1688: false,
  allowTogetherPay: false,
  allowCloudPurchase: false,
  showVerificationWindow: true,
  intervalMinutes: 1,
  pddIntervalMinutes: 1,
  taobaoIntervalMinutes: 10,
  alibaba1688IntervalMinutes: 1,
  maxPayPrice: 500,
  minProfit: 1,
  minProfitPercent: 0,
  skipPresale: true,
  autoSubmitOrder: false,
  paymentMode1688: 'password',
  needAutoStart: false,
  autoStartTime: '08:00:00',
  needAutoEnd: false,
  autoEndTime: '23:00:00',
  allowedAccountIds: [],
  allowedPinduoduoAccountIds: [],
  allowedTaobaoAccountIds: [],
  allowed1688AccountIds: [],
  updatedAt: '',
});

function bool(value, fallback = false) {
  return value === undefined ? fallback : value === true || value === 1 || value === 'true';
}

function bounded(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function accountIds(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))].slice(0, 100);
}

export function normalizePurchaseAutoPaySettings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const allowTaotian = bool(source.allowTaobao) || bool(source.allowTmall);
  return {
    ...DEFAULT_PURCHASE_AUTO_PAY_SETTINGS,
    enabled: bool(source.enabled, false),
    allowPinduoduo: bool(source.allowPinduoduo, true),
    // 淘宝与天猫共用同一阿里采购/支付环境。保留两个历史字段用于
    // 兼容旧配置和执行器，但从此统一读写，界面只暴露“淘天”开关。
    allowTaobao: allowTaotian,
    allowTmall: allowTaotian,
    allow1688: bool(source.allow1688),
    allowTogetherPay: bool(source.allowTogetherPay),
    allowCloudPurchase: bool(source.allowCloudPurchase),
    showVerificationWindow: bool(source.showVerificationWindow, true),
    intervalMinutes: bounded(source.intervalMinutes, 1, 1, 60),
    pddIntervalMinutes: bounded(source.pddIntervalMinutes ?? source.intervalMinutes, 1, 1, 60),
    taobaoIntervalMinutes: bounded(source.taobaoIntervalMinutes ?? source.intervalMinutes, 10, 1, 60),
    alibaba1688IntervalMinutes: bounded(source.alibaba1688IntervalMinutes ?? source.intervalMinutes, 1, 1, 60),
    maxPayPrice: bounded(source.maxPayPrice, 500, 0, 100000),
    minProfit: bounded(source.minProfit, 1, -100000, 100000),
    minProfitPercent: bounded(source.minProfitPercent, 0, -100, 100),
    skipPresale: bool(source.skipPresale, true),
    autoSubmitOrder: bool(source.autoSubmitOrder),
    // 1688免密代扣依赖外部签约服务；当前产品只保留支付密码链。
    paymentMode1688: 'password',
    needAutoStart: bool(source.needAutoStart),
    autoStartTime: /^\d{2}:\d{2}(?::\d{2})?$/u.test(String(source.autoStartTime || '')) ? String(source.autoStartTime) : '08:00:00',
    needAutoEnd: bool(source.needAutoEnd),
    autoEndTime: /^\d{2}:\d{2}(?::\d{2})?$/u.test(String(source.autoEndTime || '')) ? String(source.autoEndTime) : '23:00:00',
    allowedAccountIds: accountIds(source.allowedAccountIds),
    allowedPinduoduoAccountIds: accountIds(source.allowedPinduoduoAccountIds ?? source.allowedAccountIds),
    allowedTaobaoAccountIds: accountIds(source.allowedTaobaoAccountIds ?? source.allowedAccountIds),
    allowed1688AccountIds: accountIds(source.allowed1688AccountIds ?? source.allowedAccountIds),
    updatedAt: String(source.updatedAt || '').trim(),
  };
}

export async function loadPurchaseAutoPaySettings(options = {}) {
  const result = await (options.read || getProfileSetting)(PURCHASE_AUTO_PAY_SETTINGS_NAMESPACE, options);
  return normalizePurchaseAutoPaySettings(result?.setting?.value || result?.value || {});
}

export async function savePurchaseAutoPaySettings(value, options = {}) {
  const settings = normalizePurchaseAutoPaySettings({ ...value, updatedAt: new Date().toISOString() });
  await (options.save || saveProfileSetting)(PURCHASE_AUTO_PAY_SETTINGS_NAMESPACE, settings, options);
  return settings;
}
