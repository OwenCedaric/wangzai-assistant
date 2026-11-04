import { getInternalBrowserBridge } from '../../../../services/internalBrowserLinkClient.js';

const NAVIGATION_COMMANDS = new Set(['back', 'forward', 'reload']);
const ORDER_OPERATION_COMMANDS = new Set(['read-payment-info', 'refresh-order-status', 'save-payment-info']);
const TOOLBAR_ACTIONS = new Set([
  'pinduoduo-home',
  'pinduoduo-personal',
  'pinduoduo-orders',
  'pinduoduo-addresses',
  'capture-purchase',
  'capture-confirm',
  'target-mode',
  'purchase-login-save',
  'account-status',
  'browser-extensions',
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function normalizePurchaseOrderWorkbenchBounds(value = {}) {
  const numbers = ['x', 'y', 'width', 'height'].map((field) => Number(value?.[field]));
  if (numbers.some((item) => !Number.isFinite(item))) return null;
  return {
    x: Math.max(0, Math.floor(numbers[0])),
    y: Math.max(0, Math.floor(numbers[1])),
    width: Math.max(320, Math.floor(numbers[2])),
    height: Math.max(240, Math.floor(numbers[3])),
    visible: value?.visible !== false,
  };
}

export async function syncPurchaseOrderWorkbenchViewport(value, {
  requestKey = '',
  tabId = '',
  sessionId = '',
  generation = 0,
  bridge = getInternalBrowserBridge(),
} = {}) {
  const bounds = normalizePurchaseOrderWorkbenchBounds(value);
  if (!bounds) throw codedError('PURCHASE_BROWSER_BOUNDS_INVALID');
  if (typeof bridge !== 'function') throw codedError('PURCHASE_BROWSER_BRIDGE_UNAVAILABLE');
  return bridge({
    command: 'embed-bounds',
    bounds,
    requestKey: String(requestKey || '').trim(),
    tabId: String(tabId || '').trim(),
    sessionId: String(sessionId || '').trim(),
    generation: Number(generation) || 0,
  });
}

export async function hidePurchaseOrderWorkbenchViewport({
  requestKey = '',
  tabId = '',
  sessionId = '',
  generation = 0,
  bridge = getInternalBrowserBridge(),
} = {}) {
  if (typeof bridge !== 'function') return null;
  return bridge({
    command: 'embed-hide',
    requestKey: String(requestKey || '').trim(),
    tabId: String(tabId || '').trim(),
    sessionId: String(sessionId || '').trim(),
    generation: Number(generation) || 0,
  });
}

export async function runPurchaseOrderWorkbenchNavigation(command, {
  bridge = getInternalBrowserBridge(),
} = {}) {
  const normalized = String(command || '').trim().toLowerCase();
  if (!NAVIGATION_COMMANDS.has(normalized)) throw codedError('PURCHASE_BROWSER_COMMAND_INVALID');
  if (typeof bridge !== 'function') throw codedError('PURCHASE_BROWSER_BRIDGE_UNAVAILABLE');
  return bridge({ command: normalized });
}

export async function runPurchaseOrderWorkbenchOrderOperation(command, {
  tabId = '',
  bridge = getInternalBrowserBridge(),
} = {}) {
  const normalized = String(command || '').trim().toLowerCase();
  if (!ORDER_OPERATION_COMMANDS.has(normalized)) throw codedError('PURCHASE_BROWSER_COMMAND_INVALID');
  if (typeof bridge !== 'function') throw codedError('PURCHASE_BROWSER_BRIDGE_UNAVAILABLE');
  const normalizedTabId = String(tabId || '').trim();
  if (!normalizedTabId) throw codedError('PURCHASE_BROWSER_TAB_NOT_FOUND');
  return bridge({ command: normalized, tabId: normalizedTabId });
}

export async function runPurchaseOrderWorkbenchToolbarAction(action, payload = {}, {
  tabId = '',
  bridge = getInternalBrowserBridge(),
} = {}) {
  const normalized = String(action || '').trim().toLowerCase();
  if (!TOOLBAR_ACTIONS.has(normalized)) throw codedError('PURCHASE_BROWSER_COMMAND_INVALID');
  if (typeof bridge !== 'function') throw codedError('PURCHASE_BROWSER_BRIDGE_UNAVAILABLE');
  const normalizedTabId = String(tabId || '').trim();
  if (!normalizedTabId) throw codedError('PURCHASE_BROWSER_TAB_NOT_FOUND');
  return bridge({
    command: 'toolbar-action',
    action: normalized,
    tabId: normalizedTabId,
    payload: payload && typeof payload === 'object' ? payload : {},
  });
}

export async function runPurchaseOrderWorkbenchSellerOrderLookup({
  tabId = '',
  postingNumber = '',
  routeKind = 'fbs',
} = {}, {
  bridge = getInternalBrowserBridge(),
} = {}) {
  if (typeof bridge !== 'function') throw codedError('PURCHASE_BROWSER_BRIDGE_UNAVAILABLE');
  const normalizedTabId = String(tabId || '').trim();
  const normalizedPostingNumber = String(postingNumber || '').trim();
  const normalizedRouteKind = String(routeKind || '').trim().toLowerCase();
  if (!normalizedTabId) throw codedError('PURCHASE_BROWSER_TAB_NOT_FOUND');
  if (!normalizedPostingNumber || normalizedPostingNumber.length > 160) {
    throw codedError('PURCHASE_BROWSER_OZON_ORDER_NUMBER_REQUIRED');
  }
  if (!['fbs', 'fbo', 'rfbs'].includes(normalizedRouteKind)) {
    throw codedError('PURCHASE_BROWSER_OZON_ORDER_ROUTE_INVALID');
  }
  return bridge({
    command: 'ozon-open-order',
    tabId: normalizedTabId,
    postingNumber: normalizedPostingNumber,
    routeKind: normalizedRouteKind,
  });
}
