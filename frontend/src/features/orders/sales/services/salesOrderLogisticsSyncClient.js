const CROSS_BORDER_LOGISTICS_PROFILE_ACCOUNT_ID = 'builtin-cross-border-logistics';
const BUILTIN_CROSS_BORDER_PROFILE_OWNER_TYPE = 'builtin_cross_border_profile';
const CROSS_BORDER_HOME_URL = 'https://www.kuajing84.com/';

function logisticsError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getBridge() {
  return globalThis.window?.wangzaiDesktop?.purchaseBrowser || null;
}

function errorCode(error) {
  const direct = String(error?.code || '').trim();
  if (direct) return direct;
  const message = String(error?.message || error || '');
  const match = message.match(/(?:CROSS_BORDER|PURCHASE_BROWSER)_[A-Z0-9_]+/u);
  return match?.[0] || 'CROSS_BORDER_LOGISTICS_SYNC_FAILED';
}

export async function openCrossBorderLogisticsLogin() {
  const bridge = getBridge();
  if (!bridge?.command) throw logisticsError('PURCHASE_BROWSER_BRIDGE_UNAVAILABLE', '桌面浏览器服务未启动。');
  return bridge.command({
    command: 'open',
    accountId: CROSS_BORDER_LOGISTICS_PROFILE_ACCOUNT_ID,
    ownerType: BUILTIN_CROSS_BORDER_PROFILE_OWNER_TYPE,
    url: CROSS_BORDER_HOME_URL,
  });
}

export async function syncSalesOrderPurchaseLogistics(purchaseOrders = [], options = {}) {
  try {
    const result = await syncUnifiedPurchaseLogistics(purchaseOrders, options);
    if (result.busErrorCode === 'CROSS_BORDER_LOGIN_REQUIRED') {
      await openCrossBorderLogisticsLogin();
    }
    return result;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'CROSS_BORDER_LOGIN_REQUIRED') {
      await openCrossBorderLogisticsLogin();
      return {
        ok: false,
        busErrorCode: code,
        total: 0,
        matched: 0,
        failed: 0,
        results: [],
      };
    }
    const messages = {
      CROSS_BORDER_PURCHASE_ACCOUNT_MISSING: '缺少对应采购平台账号，本次没有写入。',
      CROSS_BORDER_PURCHASE_ACCOUNT_AMBIGUOUS: '同一采购平台存在多个可用账号，无法唯一确认，本次没有写入。',
      CROSS_BORDER_PURCHASE_LOGIN_REQUIRED: '采购平台登录已失效，请重新登录对应采购账号。',
      CROSS_BORDER_PURCHASE_ACCOUNT_MISMATCH: '采购订单与采购账号平台不一致，本次没有写入。',
      CROSS_BORDER_LOGISTICS_EVIDENCE_INVALID: '读取到的快递公司或单号不完整，本次没有写入。',
      PURCHASE_BROWSER_BRIDGE_UNAVAILABLE: '桌面浏览器服务未启动，请重启软件。',
    };
    throw logisticsError(code, messages[code] || '物流同步失败，未确认的订单没有写入。');
  }
}

export function subscribeSalesOrderLogisticsProgress(listener) {
  const bridge = getBridge();
  if (typeof bridge?.onEvent !== 'function' || typeof listener !== 'function') return () => undefined;
  const unsubscribe = bridge.onEvent((payload) => {
    if (payload?.event === 'cross-border-logistics-progress') listener(payload);
  });
  return typeof unsubscribe === 'function' ? unsubscribe : () => undefined;
}
import { syncUnifiedPurchaseLogistics } from '../../../../services/purchaseLogisticsUnifiedSync.js';
