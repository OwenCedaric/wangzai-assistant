function text(value, maximum = 600) {
  return String(value ?? '')
    .replace(/[^\x20-\x7E\u4E00-\u9FFF]/gu, '')
    .trim()
    .slice(0, maximum);
}

function quantity(value) {
  const match = String(value ?? '').match(/\d+(?:\.\d+)?/u);
  const number = match ? Number(match[0]) : Number.NaN;
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function buildPurchaseBrowserTarget(context = {}) {
  const shopId = text(context.shopId || context.shopClientId, 180);
  const orderKey = text(context.orderKey || context.orderId, 260);
  const productKey = text(context.productKey || context.offerId || context.sku, 260);
  if (!shopId || !orderKey) return null;
  return {
    targetId: text(`${shopId}:${orderKey}:${productKey || 'order'}`, 180),
    shopId,
    orderKey,
    ozonOrderId: text(context.ozonOrderId || context.orderId, 260),
    sku: text(context.sku, 260),
    offerId: text(context.offerId, 260),
    productTitle: text(context.productName, 600),
    quantity: quantity(context.quantity),
    purchaseRecordId: text(context.orderId, 260),
    requiredFields: ['purchasePlatform', 'purchaseOrderNumber', 'sourceCostCny', 'sourceUrl'],
    selectedAt: text(context.lockedAt, 80) || new Date().toISOString(),
  };
}

function bridge() {
  return globalThis.window?.wangzaiDesktop?.purchaseBrowser;
}

export async function getActivePurchaseBrowserTab() {
  const command = bridge()?.command;
  if (typeof command !== 'function') return null;
  const state = await command({ command: 'state' });
  const tabs = Array.isArray(state?.tabs) ? state.tabs : [];
  return tabs.find((tab) => tab.tabId === state.activeTabId) || tabs[0] || null;
}

/**
 * Bind the order/product that opened an operation workbench to that exact
 * browser tab.  `tabId` is supplied by the native open readback so another
 * hot account tab can never receive the target by accident.
 */
export async function lockPurchaseBrowserTarget(context = {}, options = {}) {
  const target = buildPurchaseBrowserTarget(context);
  if (!target) return { ok: false, skipped: true, code: 'PURCHASE_BROWSER_TARGET_REQUIRED' };
  const command = bridge()?.command;
  if (typeof command !== 'function') return { ok: false, skipped: true, code: 'PURCHASE_BROWSER_BRIDGE_UNAVAILABLE' };
  const requestedTabId = text(options.tabId, 180);
  const tab = requestedTabId ? { tabId: requestedTabId } : await getActivePurchaseBrowserTab();
  if (!tab?.tabId) return { ok: false, skipped: true, code: 'PURCHASE_BROWSER_TAB_NOT_FOUND' };
  return command({ command: 'set-target', tabId: tab.tabId, target });
}

// Kept as a compatibility export for older callers.
export const publishPurchaseBrowserTarget = lockPurchaseBrowserTarget;

export async function clearActivePurchaseBrowserTarget() {
  const command = bridge()?.command;
  if (typeof command !== 'function') return { ok: false, skipped: true };
  const tab = await getActivePurchaseBrowserTab();
  if (!tab?.tabId) return { ok: false, skipped: true };
  return command({ command: 'clear-target', tabId: tab.tabId });
}
