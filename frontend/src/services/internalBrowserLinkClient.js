const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Normalize a user/application supplied web URL before handing it to the
 * desktop bridge.  The native CEF policy performs the authoritative
 * check again; this client only prevents accidental protocol escapes from
 * the renderer.
 */
export function normalizeInternalBrowserUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return null;
  }
  if (!HTTP_PROTOCOLS.has(url.protocol) || url.username || url.password || !url.hostname) {
    return null;
  }
  return url.toString();
}

export function getInternalBrowserBridge(scope = globalThis) {
  return scope?.window?.wangzaiDesktop?.purchaseBrowser?.command
    || scope?.wangzaiDesktop?.purchaseBrowser?.command
    || null;
}

function normalizeEmbeddedBounds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const numbers = ['x', 'y', 'width', 'height'].map((field) => Number(value[field]));
  if (numbers.some((item) => !Number.isFinite(item))) return null;
  return {
    x: Math.max(0, Math.floor(numbers[0])),
    y: Math.max(0, Math.floor(numbers[1])),
    width: Math.max(320, Math.floor(numbers[2])),
    height: Math.max(240, Math.floor(numbers[3])),
    visible: value.visible !== false,
  };
}

/**
 * Open a normal web link in the single native CEF window.  There is
 * deliberately no window.open/shell fallback: a missing bridge is surfaced
 * as an error so a link can never silently escape to the system browser.
 */
export async function openInternalBrowserLink(value, {
  accountId = '',
  shopId = '',
  requireShopBinding = false,
  platformName = '',
  accountLabel = '',
  workbench = null,
  embeddedBounds = null,
  browserTarget = null,
  workbenchRequestKey = '',
  bridge = getInternalBrowserBridge(),
} = {}) {
  const url = normalizeInternalBrowserUrl(value);
  if (!url) throw fail('PURCHASE_BROWSER_EXTERNAL_URL_INVALID');
  if (typeof bridge !== 'function') throw fail('PURCHASE_BROWSER_BRIDGE_UNAVAILABLE');
  const safeEmbeddedBounds = embeddedBounds == null ? null : normalizeEmbeddedBounds(embeddedBounds);
  if (embeddedBounds != null && !safeEmbeddedBounds) throw fail('PURCHASE_BROWSER_BOUNDS_INVALID');
  return bridge({
    command: 'open-external',
    url,
    ...(String(accountId || '').trim() ? { accountId: String(accountId).trim() } : {}),
    ...(String(shopId || '').trim() ? { shopId: String(shopId).trim() } : {}),
    ...(requireShopBinding === true ? { requireShopBinding: true } : {}),
    ...(String(platformName || '').trim() ? { platformName: String(platformName).trim() } : {}),
    ...(String(accountLabel || '').trim() ? { accountLabel: String(accountLabel).trim() } : {}),
    ...(workbench && typeof workbench === 'object' && !Array.isArray(workbench) ? { workbench } : {}),
    ...(browserTarget && typeof browserTarget === 'object' && !Array.isArray(browserTarget)
      ? { purchaseTarget: browserTarget }
      : {}),
    ...(safeEmbeddedBounds ? { embeddedBounds: safeEmbeddedBounds } : {}),
    ...(String(workbenchRequestKey || '').trim()
      ? { workbenchRequestKey: String(workbenchRequestKey).trim().slice(0, 160) }
      : {}),
  });
}

/**
 * Open an isolated hidden browser used only for one product-link inspection
 * lane.  The desktop controller assigns this role its own CEF session and
 * command queue, so market polling keeps its current page and pagination.
 */
export async function openInternalProductLinkParser(value, {
  accountId = '',
  bridge = getInternalBrowserBridge(),
} = {}) {
  const url = normalizeInternalBrowserUrl(value);
  if (!url) throw fail('PURCHASE_BROWSER_EXTERNAL_URL_INVALID');
  if (typeof bridge !== 'function') throw fail('PURCHASE_BROWSER_BRIDGE_UNAVAILABLE');
  const hostname = new URL(url).hostname.toLowerCase();
  const isPinduoduo = hostname === 'yangkeduo.com'
    || hostname.endsWith('.yangkeduo.com')
    || hostname === 'pinduoduo.com'
    || hostname.endsWith('.pinduoduo.com');
  return bridge({
    command: 'open-external',
    url,
    browserRole: 'product-link-parser',
    background: true,
    restoreVisible: false,
    // Pinduoduo is an SPA: waiting for every lazy resource makes the button
    // look frozen. Commit the document early; the native structured reader
    // then waits only for a complete rawData/SKU snapshot.
    waitUntil: isPinduoduo ? 'commit' : 'load',
    ...(String(accountId || '').trim() ? { accountId: String(accountId).trim() } : {}),
  });
}

export function getInternalBrowserLinkErrorMessage(error) {
  const rawCode = String(error?.code || error?.message || '').trim();
  const messages = {
    PURCHASE_BROWSER_BRIDGE_UNAVAILABLE: '当前窗口未连接内置浏览器，请重启软件后重试。',
    PURCHASE_BROWSER_EXTERNAL_URL_INVALID: '链接格式不正确，无法在内置浏览器中打开。',
    PURCHASE_BROWSER_EXTERNAL_ACCOUNT_REQUIRED: '请先在设置中配置对应采购平台账号。',
    PURCHASE_BROWSER_EXTERNAL_ACCOUNT_PLATFORM_MISMATCH: '当前账号与链接平台不一致，请切换对应采购账号。',
    PURCHASE_BROWSER_OZON_BUYER_ACCOUNT_REQUIRED: '请先在设置中保存 Ozon 买家采购号。',
    PURCHASE_BROWSER_OZON_SELLER_PROFILE_REQUIRED: '请先在设置中完成 Ozon 网页登录并保存 Cookie。',
    PURCHASE_BROWSER_OZON_SELLER_SHOP_PROFILE_REQUIRED: '当前店铺还没有绑定已登录的 Ozon 网页账号，请到设置的“平台账号”中为该店铺新增并登录。',
    PURCHASE_BROWSER_NOT_READY: '内置浏览器正在启动，请稍后重试。',
    PURCHASE_BROWSER_BOUNDS_INVALID: '操作台浏览器区域定位失败，请关闭后重新打开。',
    PURCHASE_BROWSER_TARGET_MISMATCH: '采购网页与目标账号不一致，已停止显示，请重新打开。',
    PURCHASE_BROWSER_TARGET_REQUIRED: '当前操作台没有绑定订单目标，请关闭后从拍单订单重新打开。',
    PURCHASE_BROWSER_TAB_NOT_FOUND: '当前内置浏览器尚未连接，请等待页面打开后重试。',
    PURCHASE_BROWSER_1688_PAGE_REQUIRED: '请先在右侧打开 1688 的已买到货品或订单详情页。',
    PURCHASE_BROWSER_1688_ORDER_NOT_BOUND: '当前订单还没有绑定 1688 采购单，请先点击“读取付款信息”。',
    PURCHASE_BROWSER_1688_ORDER_NOT_FOUND: '当前 1688 页面没有找到与左侧商品精确对应的订单，请打开该订单详情后重试。',
    PURCHASE_BROWSER_1688_ORDER_AMBIGUOUS: '当前页面找到多笔相似 1688 订单，无法确定对应关系，请打开准确订单详情后重试。',
    PURCHASE_BROWSER_1688_ORDER_INCOMPLETE: '1688 页面没有完整返回订单号、实付金额和订单状态，请等待页面加载完成后重试。',
    PURCHASE_BROWSER_1688_PAYMENT_NOT_CONFIRMED: '当前 1688 订单还没有完成付款，暂不写入付款信息。',
    PURCHASE_BROWSER_ORDER_PAGE_REQUIRED: '请先在右侧打开当前采购平台的准确订单详情页。',
    PURCHASE_BROWSER_ORDER_NOT_BOUND: '当前订单还没有绑定采购单，请先打开已付款订单并点击“读取付款信息”。',
    PURCHASE_BROWSER_ORDER_NOT_FOUND: '当前网页没有找到与左侧商品对应的采购订单，请打开准确订单详情后重试。',
    PURCHASE_BROWSER_ORDER_INCOMPLETE: '当前订单页没有完整返回订单号、实付金额和订单状态，请等待页面加载完成后重试。',
    PURCHASE_BROWSER_PAYMENT_NOT_CONFIRMED: '当前采购订单还没有完成付款，暂不写入付款信息。',
    PURCHASE_BROWSER_CAPTURE_FIELDS_MISSING: '付款资料读取不完整，请打开准确订单详情并等待加载完成后重试。',
    PURCHASE_BROWSER_READBACK_FAILED: '付款资料已经提交，但本地回读校验失败，请重新读取。',
    PURCHASE_BROWSER_TARGET_AMBIGUOUS: '当前网页与左侧订单无法唯一对应，已阻止写入。',
    PURCHASE_BROWSER_OZON_ORDER_NUMBER_REQUIRED: '当前记录缺少 Ozon 货件号，无法打开原订单。',
    PURCHASE_BROWSER_OZON_ORDER_ROUTE_INVALID: '当前订单的履约类型无法识别，已停止打开。',
    PURCHASE_BROWSER_OZON_ORDER_PAGE_REQUIRED: '当前页面不是 Ozon Seller 订单页面，已停止查找。',
    PURCHASE_BROWSER_OZON_ORDER_SEARCH_NOT_READY: 'Ozon 订单列表尚未加载完成，请稍后重试。',
    PURCHASE_BROWSER_OZON_ORDER_NOT_FOUND: 'Ozon 后台没有找到当前货件号，请刷新订单数据后重试。',
    PURCHASE_BROWSER_OZON_ORDER_OPEN_FAILED: '已经找到当前货件号，但订单详情没有成功打开，请重试。',
  };
  const code = Object.keys(messages).find((candidate) => rawCode.includes(candidate)) || rawCode;
  return messages[code] || (code ? `内置浏览器打开失败：${code}` : '内置浏览器打开失败，请稍后重试。');
}
export function stopExternalLinkNavigation(event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
}

export function openInternalBrowserLinkFromEvent(event, value, options = {}) {
  stopExternalLinkNavigation(event);
  return openInternalBrowserLink(value, options);
}
