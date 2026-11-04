import { getPurchaseAccountPresetByPlatform } from '../../../shared/config/purchaseAccountPresets.js';
import {
  confirmPurchaseBrowserCapture,
  previewPurchaseBrowserCapture,
} from '../../../api/localApiClient.js';

export const PURCHASE_BROWSER_TARGET_PHASES = Object.freeze([
  'idle',
  'target-selecting',
  'target-locked',
  'capturing',
  'capture-preview',
  'confirming',
  'saving',
  'readback',
  'completed',
  'error',
]);

const PURCHASE_BROWSER_ERROR_MESSAGES = Object.freeze({
  PURCHASE_WAIT_PAY_BROWSER_NOT_READY: '浏览器页面尚未加载好，请稍后再读取待付款列表。',
  PURCHASE_WAIT_PAY_SCAN_FAILED: '待付款列表读取失败，请检查当前页面状态后重试读取。',
  PURCHASE_BROWSER_BRIDGE_UNAVAILABLE: '当前桌面端没有提供内置浏览器，请重启软件后重试。',
  PURCHASE_BROWSER_ACCOUNT_ID_REQUIRED: '请先保存当前拍单账号。',
  PURCHASE_BROWSER_PLATFORM_UNSUPPORTED: '当前采购平台暂不支持内置登录。',
  PURCHASE_BROWSER_HOST_WINDOW_REQUIRED: '内置浏览器窗口尚未准备好，请关闭设置后重新打开。',
  PURCHASE_BROWSER_NAVIGATION_FORBIDDEN: '当前网站不在允许的采购平台范围内。',
  PURCHASE_BROWSER_TAB_NOT_FOUND: '当前浏览器页面已经关闭，请重新打开登录。',
  PURCHASE_BROWSER_IPC_SENDER_REJECTED: '当前页面没有权限控制内置浏览器，请重启软件后重试。',
  PURCHASE_BROWSER_CEF_RUNTIME_INVALID: '内置浏览器运行文件校验失败，请重新安装或修复软件。',
  PURCHASE_BROWSER_CEF_RUNTIME_NOT_FOUND: '没有找到内置浏览器运行文件，请重新安装或修复软件。',
  PURCHASE_BROWSER_CEF_LAUNCH_FAILED: '内置浏览器没有成功启动，请重试。',
  PURCHASE_BROWSER_PROXY_RULES_REQUIRED: '代理地址尚未填写，请检查当前账号的代理设置。',
  PURCHASE_BROWSER_PROXY_MODE_INVALID: '当前代理模式无效，请重新选择代理模式。',
  PURCHASE_BROWSER_PROXY_CONFIGURATION_FAILED: '当前账号的代理未能生效，已停止加载页面，请检查代理设置。',
  PURCHASE_BROWSER_PROXY_READBACK_FAILED: '代理设置回读不一致，已停止加载页面，请检查设置后重新打开。',
  PURCHASE_BROWSER_CONTEXT_INITIALIZE_TIMEOUT: '当前账号的浏览器环境准备超时，请关闭该浏览器后重新打开。',
  PURCHASE_BROWSER_CONTEXT_PREFERENCES_FAILED: '当前账号的浏览器环境配置失败，未继续加载页面，请重新打开。',
  PURCHASE_BROWSER_PLUGIN_REGISTRY_INVALID: '浏览器插件登记文件异常，原插件文件已保留，请先修复插件配置。',
  PURCHASE_BROWSER_PLUGIN_RECOVERY_REQUIRED: '上次插件修改尚未恢复完成，原文件已保留，请先完成恢复。',
  PURCHASE_BROWSER_PLUGIN_MV2_UNSUPPORTED: '此插件使用当前浏览器不支持的旧格式，请使用兼容版本；现有插件未被替换。',
  PURCHASE_BROWSER_CEF_TIMEOUT: '内置浏览器启动超时，请确认网络后重试。',
  PURCHASE_BROWSER_COMMAND_TIMEOUT: '内置浏览器操作超时，异常会话已隔离，可以重新打开。',
  PURCHASE_BROWSER_CEF_HOST_UNHEALTHY: '内置浏览器控制进程无响应，已进入恢复状态。',
  PURCHASE_BROWSER_SESSION_STALE: '当前浏览器会话已经失效，请重新打开。',
  PURCHASE_BROWSER_SESSION_CRASHED: '当前浏览器会话已崩溃，请重新打开采购浏览器。',
  PURCHASE_BROWSER_WINDOW_OCCUPIED: '已有一个采购浏览器窗口正在使用，请先恢复或关闭它。',
  PURCHASE_BROWSER_TARGET_REQUIRED: '请先选择并锁定要回填的目标订单。',
  PURCHASE_BROWSER_CAPTURE_EMPTY: '当前页面没有读到可用采购信息，请打开采购订单详情或商品页后重试。',
  PURCHASE_BROWSER_CAPTURE_FIELDS_MISSING: '采购页面缺少采购平台、采购单号、采购价格或货源链接，暂不能保存。',
  PURCHASE_BROWSER_CONFIRMATION_REQUIRED: '确认窗口已失效，请重新生成采购信息预览。',
  PURCHASE_BROWSER_COMMAND_CANCELLED: '当前操作已取消，采购信息没有写入。',
  PURCHASE_BROWSER_WINDOW_INVALID: '内置浏览器窗口状态异常，请重新打开采购窗口。',
  PURCHASE_BROWSER_CAPTURE_CONFLICT_CONFIRMATION_REQUIRED: '当前字段已有值，请确认覆盖后再保存。',
  PURCHASE_BROWSER_READBACK_FAILED: '采购信息保存后的回读校验失败，当前未标记为完成。',
  PURCHASE_BROWSER_CAPTURE_SERVICE_UNAVAILABLE: '采购信息保存服务暂不可用，请稍后重试。',
  PURCHASE_BROWSER_CEF_PROCESS_EXITED: '内置浏览器意外退出，请重新打开登录。',
  PURCHASE_BROWSER_CEF_WINDOW_EMBED_FAILED: '内置浏览器窗口嵌入失败，请重启桌面端后重试。',
  PURCHASE_BROWSER_CEF_WINDOW_SHOW_FAILED: '内置浏览器页面显示失败，请关闭设置后重新打开。',
  PURCHASE_BROWSER_CEF_PARENT_WINDOW_INVALID: '设置窗口状态异常，请关闭设置后重试。',
  PURCHASE_BROWSER_EXTENSION_NOT_VERIFIED: '内置浏览器插件校验未通过，请重启或修复软件。',
  PURCHASE_BROWSER_EXTENSION_TIMEOUT: '内置浏览器插件响应超时，请稍后重试。',
  PURCHASE_BROWSER_BUILTIN_EXTENSION_INVALID: '内置 Ozon 数据观察器安装失败，请修复或重启软件。',
  OZON_DATA_OBSERVER_NOT_INSTALLED: 'Ozon 数据观察器没有安装或已被禁用。',
  OZON_DATA_OBSERVER_NOT_READY: 'Ozon 数据观察器尚未加载完成，请重启内置浏览器。',
  OZON_DATA_OBSERVER_PAGE_REQUIRED: '请先在内置浏览器中打开 Ozon 卖家后台。',
  OZON_DATA_OBSERVER_READ_FAILED: 'Ozon 数据观察器回读失败，请刷新页面后重试。',
  OZON_DATA_OBSERVER_STATUS_FAILED: 'Ozon 数据观察器状态读取失败。',
  OZON_DATA_OBSERVER_CATALOG_FAILED: 'Ozon 数据接口目录读取失败。',
  OZON_DATA_OBSERVER_NORMALIZE_FAILED: 'Ozon 数据标准化失败。',
  OZON_DATA_OBSERVER_PAGINATION_FAILED: 'Ozon 数据自动翻页失败或该接口不支持安全翻页。',
  OZON_DATA_PAGINATION_SOURCE_REQUIRED: '缺少可用于自动翻页的响应序号。',
  PURCHASE_BROWSER_BOUNDS_INVALID: '内置浏览器显示区域暂时不可用，请重新打开登录。',
  PURCHASE_BROWSER_BOUNDS_READBACK_FAILED: '内置浏览器显示区域校验失败，请重新打开登录。',
  PURCHASE_BROWSER_IDEMPOTENCY_KEY_REQUIRED: '保存请求缺少安全校验标识，请重新生成预览。',
  PURCHASE_BROWSER_TARGET_AMBIGUOUS: '当前目标无法唯一匹配，请返回拍单页重新选择订单。',
  PURCHASE_BROWSER_CEF_PAGE_CLOSED: '登录页面已关闭，请重新打开登录。',
  PURCHASE_BROWSER_PAGE_CLOSED: '登录页面已关闭，请重新打开登录。',
  PURCHASE_BROWSER_TAB_CLOSED: '登录页面已关闭，请重新打开登录。',
  PURCHASE_BROWSER_RENDERER_GONE: '内置浏览器页面意外关闭，请重新打开。',
  CROSS_BORDER_LOGIN_REQUIRED: '跨境巴士未登录，请先在当前内置浏览器中登录一次。',
  CROSS_BORDER_NETWORK_FAILED: '跨境巴士网络连接失败，请检查网络或代理后重试。',
  CROSS_BORDER_RESPONSE_TOO_LARGE: '接口单次返回超过8MiB，本次未保存，请缩小筛选范围分批读取。',
  CROSS_BORDER_OPERATION_CANCELLED: '操作已取消。已经发出的写入仍需回读核对，不会自动重复提交。',
  CROSS_BORDER_CHARGE_AMOUNT_INVALID: '消费流水有金额缺失或格式错误，本次未保存，不会把未知金额当成零费用。',
  CROSS_BORDER_SYNC_PREVIEW_REQUIRED: '物流同步预览已失效，请重新读取物流并人工确认。',
  CROSS_BORDER_EXTENSION_COMMAND_INVALID: '跨境巴士同步插件命令无效。',
  CROSS_BORDER_EXTENSION_TIMEOUT: '跨境巴士同步超时，请稍后重试。',
  CROSS_BORDER_REQUEST_TIMEOUT: '\u540c\u6b65\u8bf7\u6c42\u8d85\u65f6\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002',
  CROSS_BORDER_SUPPLIER_REQUEST_FAILED: '\u91c7\u8d2d\u5e73\u53f0\u7269\u6d41\u8bfb\u53d6\u5931\u8d25\uff0c\u8bf7\u786e\u8ba4\u5f53\u524d\u91c7\u8d2d\u8d26\u53f7\u4ecd\u5df2\u767b\u5f55\u3002',
  CROSS_BORDER_SUPPLIER_AUTH_REQUIRED: '\u91c7\u8d2d\u5e73\u53f0\u9700\u8981\u4e00\u6b21\u6388\u6743\uff0c\u5df2\u5728\u5185\u7f6e\u6d4f\u89c8\u5668\u6253\u5f00\u6388\u6743\u9875\u3002',
  CROSS_BORDER_API_FAILED: '跨境巴士接口返回异常，请稍后重试；这不表示账号已退出。',
  CROSS_BORDER_PLATFORM_UNSUPPORTED: '\u5f53\u524d\u91c7\u8d2d\u5e73\u53f0\u6682\u4e0d\u652f\u6301\u7269\u6d41\u540c\u6b65\u3002',
  CROSS_BORDER_PACKAGE_CONTEXT_MISSING: '\u8de8\u5883\u5df4\u58eb\u8ba2\u5355\u7f3a\u5c11\u5305\u88f9\u4fe1\u606f\uff0c\u65e0\u6cd5\u540c\u6b65\u3002',
  CROSS_BORDER_TARGET_AMBIGUOUS: '跨境巴士订单无法与当前目标唯一匹配，请重新选择订单。',
});

function purchaseBrowserError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requiredText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw purchaseBrowserError(code);
  return text;
}

function getPurchaseBrowserBridge() {
  return globalThis.window?.wangzaiDesktop?.purchaseBrowser || null;
}

function createPurchaseBrowserAbortError() {
  const error = new Error('The purchase browser request was aborted.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

/**
 * Electron's invoke bridge cannot clone an AbortSignal. Keep cancellation on
 * the renderer side: an unmounted/closed UI stops waiting immediately and
 * late IPC results are ignored. Both handlers are attached so a late native
 * rejection cannot become an unhandled promise.
 */
function withAbortSignal(promise, signal) {
  if (!signal || typeof signal.addEventListener !== 'function') return Promise.resolve(promise);
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => undefined);
    return Promise.reject(createPurchaseBrowserAbortError());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener?.('abort', onAbort);
      reject(createPurchaseBrowserAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener?.('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener?.('abort', onAbort);
        reject(error);
      },
    );
  });
}

function sanitizePurchaseBrowserUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'about:blank') return raw || 'about:blank';
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '已打开采购页面';
  }
}

function sanitizePurchaseCaptureUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'about:blank') return raw || 'about:blank';
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|secret|password|passwd|credential|session|auth)/iu.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeTargetPhase(value, fallback = 'idle') {
  return PURCHASE_BROWSER_TARGET_PHASES.includes(value) ? value : fallback;
}

function dispatchPurchaseBrowserCommand(input, { signal } = {}) {
  const command = getPurchaseBrowserBridge()?.command;
  if (typeof command !== 'function') {
    return Promise.reject(purchaseBrowserError('PURCHASE_BROWSER_BRIDGE_UNAVAILABLE'));
  }
  if (signal?.aborted) return Promise.reject(createPurchaseBrowserAbortError());
  let request;
  try {
    request = command(input);
  } catch (error) {
    return Promise.reject(error);
  }
  return withAbortSignal(request, signal);
}

function normalizePurchaseBrowserTab(tab = {}) {
  const target = tab.target && typeof tab.target === 'object' ? { ...tab.target } : null;
  return {
    tabId: captureText(tab.tabId, 180),
    accountId: captureText(tab.accountId, 180),
    engine: captureText(tab.engine, 40),
    title: captureText(tab.title || '新标签页', 160),
    url: sanitizePurchaseBrowserUrl(tab.url),
    loading: tab.loading === true,
    crashed: tab.crashed === true,
    canGoBack: tab.canGoBack === true,
    canGoForward: tab.canGoForward === true,
    sessionId: captureText(tab.sessionId, 180),
    generation: Number(tab.generation) || 0,
    phase: captureText(tab.phase || (tab.crashed ? 'crashed' : 'ready'), 40),
    health: captureText(tab.health || (tab.crashed ? 'unhealthy' : 'unknown'), 40),
    target,
    targetPhase: normalizeTargetPhase(
      tab.targetPhase,
      target ? 'target-locked' : 'idle',
    ),
    captureReady: tab.captureReady === true,
    purchaseContextReady: tab.purchaseContextReady === true,
    extension: {
      installState: captureText(tab.extension?.installState, 40),
      extensionVersion: captureText(tab.extension?.extensionVersion, 80),
    },
  };
}

export function normalizePurchaseBrowserState(value = {}) {
  const tabs = (Array.isArray(value?.tabs) ? value.tabs : []).map(normalizePurchaseBrowserTab);
  const activeTab = tabs.find((tab) => tab.tabId === String(value?.activeTabId || '')) || tabs[0] || null;
  return {
    ok: value?.ok === true,
    engine: String(value?.engine || ''),
    activeTabId: String(value?.activeTabId || ''),
    revision: Number(value?.revision) || 0,
    visible: value?.visible === true,
    windowVisible: value?.visible === true,
    phase: String(value?.phase || activeTab?.phase || (activeTab ? 'ready' : 'idle')),
    targetPhase: normalizeTargetPhase(
      value?.targetPhase,
      activeTab?.targetPhase || (activeTab?.target ? 'target-locked' : 'idle'),
    ),
    sessionId: String(value?.sessionId || activeTab?.sessionId || ''),
    generation: Number(value?.generation || activeTab?.generation) || 0,
    health: String(value?.health || activeTab?.health || 'unknown'),
    lastError: String(value?.lastError || value?.errorCode || ''),
    queue: value?.queue && typeof value.queue === 'object' ? { ...value.queue } : null,
    tabs,
  };
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;
  const match = String(value).replace(/,/gu, '').match(/-?\d+(?:\.\d+)?/u);
  const number = match ? Number(match[0]) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function normalizedConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function captureText(value, maximum = 600) {
  const withoutControls = [...String(value ?? '')]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('');
  return withoutControls
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function capturePlatform(value) {
  const text = captureText(value, 80);
  return [
    '1688', '淘宝', '天猫', '拼多多', 'Ozon买家', '京东',
    'Wildberries', 'Amazon', 'Temu', 'AliExpress', 'unknown',
  ].includes(text) ? text : 'unknown';
}

function captureUrlList(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map(sanitizePurchaseCaptureUrl)
    .filter(Boolean))].slice(0, 30);
}

function captureSkuList(values) {
  return (Array.isArray(values) ? values : [])
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => ({
      id: captureText(item.id || item.skuId || item.offerId || `sku-${index + 1}`, 260),
      name: captureText(item.name || item.variant, 500),
      attributes: (Array.isArray(item.attributes) ? item.attributes : [])
        .map((value) => captureText(value, 180))
        .filter(Boolean)
        .slice(0, 20),
      price: finiteNumber(item.price ?? item.purchasePrice),
      imageUrl: sanitizePurchaseCaptureUrl(item.imageUrl || item.image || ''),
    }))
    .slice(0, 200);
}

function capturePageType(value) {
  const text = captureText(value, 80);
  return ['product', 'order-list', 'order-detail', 'logistics-detail', 'unknown'].includes(text)
    ? text
    : 'unknown';
}

export function normalizePurchaseCapture(value = {}) {
  const confidence = value?.fieldConfidence && typeof value.fieldConfidence === 'object'
    ? value.fieldConfidence
    : {};
  const images = captureUrlList([...(Array.isArray(value.images) ? value.images : []), value.imageUrl]);
  return {
    platform: capturePlatform(value.platform || 'unknown'),
    pageType: capturePageType(value.pageType || 'unknown'),
    pageUrl: sanitizePurchaseCaptureUrl(value.pageUrl || value.sourceUrl || ''),
    pageTitle: captureText(value.pageTitle || value.title || '', 300),
    productTitle: captureText(value.productTitle || '', 600),
    description: captureText(value.description || '', 8000),
    variant: captureText(value.variant || '', 260),
    quantity: typeof value.quantity === 'number'
      ? (Number.isFinite(value.quantity) ? value.quantity : null)
      : captureText(value.quantity, 32) || null,
    purchaseOrderNumber: captureText(value.purchaseOrderNumber || value.orderNumber || '', 260),
    purchasePrice: (() => { const amount = finiteNumber(value.purchasePrice ?? value.amount); return amount !== null && amount >= 0 ? amount : null; })(),
    amount: captureText(value.amount ?? value.purchasePrice ?? '', 80),
    orderNumber: captureText(value.orderNumber || value.purchaseOrderNumber || '', 260),
    currency: captureText(value.currency || 'CNY', 12).toUpperCase() || 'CNY',
    trackingNumber: captureText(value.trackingNumber || '', 260),
    carrierName: captureText(value.carrierName || '', 120),
    logisticsStatus: captureText(value.logisticsStatus || value.status || '', 160),
    status: captureText(value.status || value.logisticsStatus || '', 160),
    sourceUrl: sanitizePurchaseCaptureUrl(value.sourceUrl || value.pageUrl || ''),
    sourceProductId: captureText(value.sourceProductId || '', 260),
    imageUrl: images[0] || '',
    images,
    skus: captureSkuList(value.skus),
    brand: captureText(value.brand || '', 180),
    category: captureText(value.category || '', 500),
    lengthCm: finiteNumber(value.lengthCm),
    widthCm: finiteNumber(value.widthCm),
    heightCm: finiteNumber(value.heightCm),
    weightKg: finiteNumber(value.weightKg),
    sourceConfidence: normalizedConfidence(value.sourceConfidence),
    fieldConfidence: {
      platform: normalizedConfidence(confidence.platform),
      productTitle: normalizedConfidence(confidence.productTitle),
      variant: normalizedConfidence(confidence.variant),
      quantity: normalizedConfidence(confidence.quantity),
      purchaseOrderNumber: normalizedConfidence(confidence.purchaseOrderNumber),
      purchasePrice: normalizedConfidence(confidence.purchasePrice),
      trackingNumber: normalizedConfidence(confidence.trackingNumber),
    },
    capturedAt: captureText(value.capturedAt || value.inspectedAt || '', 80),
    extensionVersion: captureText(value.extensionVersion || '', 80),
    fixture: value.fixture === true,
    runtimeKind: captureText(value.runtimeKind || '', 40),
    viewport: value.viewport && typeof value.viewport === 'object' ? { ...value.viewport } : null,
  };
}

export function getPurchaseBrowserAccountTab(state = {}, accountId = '') {
  const ownerId = String(accountId || '').trim();
  return normalizePurchaseBrowserState(state).tabs.find((tab) => tab.accountId === ownerId) || null;
}

export function resolvePurchaseBrowserLoginTarget(platformName, platformUrl = '') {
  const preset = getPurchaseAccountPresetByPlatform(platformName);
  if (!preset?.platformUrl) return null;
  let url = preset.platformUrl;
  const supplied = String(platformUrl || '').trim();
  if (supplied) {
    try {
      const suppliedUrl = new URL(supplied);
      const presetUrl = new URL(preset.platformUrl);
      const host = suppliedUrl.hostname.toLowerCase();
      const presetHost = presetUrl.hostname.toLowerCase();
      if (suppliedUrl.protocol === 'https:' && (host === presetHost || host.endsWith(`.${presetHost}`))) {
        url = suppliedUrl.toString();
      }
    } catch {
      // Fall back to the controlled preset when the API value is malformed.
    }
  }
  return {
    platformCode: preset.platformCode,
    platformName: preset.platformName,
    accountAlias: preset.accountAlias,
    url,
  };
}

export async function readPurchaseBrowserState() {
  return normalizePurchaseBrowserState(await dispatchPurchaseBrowserCommand({ command: 'state' }));
}

export async function prewarmPurchaseBrowserLogin({ accountId, platformName, platformUrl } = {}) {
  const ownerId = requiredText(accountId, 'PURCHASE_BROWSER_ACCOUNT_ID_REQUIRED');
  const target = resolvePurchaseBrowserLoginTarget(platformName, platformUrl);
  if (!target) throw purchaseBrowserError('PURCHASE_BROWSER_PLATFORM_UNSUPPORTED');
  return normalizePurchaseBrowserState(
    await dispatchPurchaseBrowserCommand({ command: 'prewarm', accountId: ownerId, url: target.url })
  );
}

function normalizeEmbeddedBrowserBounds(bounds) {
  if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)) return null;
  const values = ['x', 'y', 'width', 'height'].map((field) => Number(bounds[field]));
  if (values.some((value) => !Number.isFinite(value))) {
    throw purchaseBrowserError('PURCHASE_BROWSER_BOUNDS_INVALID');
  }
  return {
    x: Math.max(0, Math.floor(values[0])),
    y: Math.max(0, Math.floor(values[1])),
    width: Math.max(320, Math.floor(values[2])),
    height: Math.max(240, Math.floor(values[3])),
    visible: bounds.visible !== false,
  };
}

export async function openPurchaseBrowserLogin({
  accountId,
  accountLabel,
  platformName,
  platformUrl,
} = {}) {
  const ownerId = requiredText(accountId, 'PURCHASE_BROWSER_ACCOUNT_ID_REQUIRED');
  const target = resolvePurchaseBrowserLoginTarget(platformName, platformUrl);
  if (!target) throw purchaseBrowserError('PURCHASE_BROWSER_PLATFORM_UNSUPPORTED');
  return normalizePurchaseBrowserState(
    await dispatchPurchaseBrowserCommand({
      command: 'open',
      accountId: ownerId,
      accountLabel: String(accountLabel || '').trim().slice(0, 120),
      platformName: target.platformName,
      url: target.url,
    })
  );
}

export async function openCrossBorderBrowserLogin({ accountId, platformName, platformUrl } = {}) {
  const ownerId = requiredText(accountId, 'PURCHASE_BROWSER_ACCOUNT_ID_REQUIRED');
  const target = resolvePurchaseBrowserLoginTarget(platformName, platformUrl);
  if (!target) throw purchaseBrowserError('PURCHASE_BROWSER_PLATFORM_UNSUPPORTED');
  // A fresh profile starts on its bound procurement site so both verified
  // content bridges can be attested before navigation reaches Kuajing84.
  await dispatchPurchaseBrowserCommand({
    command: 'open',
    accountId: ownerId,
    url: target.url,
  });
  return normalizePurchaseBrowserState(
    await dispatchPurchaseBrowserCommand({
      command: 'open',
      accountId: ownerId,
      url: 'https://www.kuajing84.com/',
    })
  );
}

export async function getCrossBorderBrowserStatus(tabId) {
  return dispatchPurchaseBrowserCommand({
    command: 'cross-border-status',
    tabId: requiredText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND'),
  });
}

// The renderer-side helper is preview-first.  A caller must explicitly pass
// commit=true from the confirmed workflow; an omitted flag can never perform
// a write by accident.
export async function syncCrossBorderBrowser({ tabId, orderIds = [], commit = false } = {}) {
  const response = await dispatchPurchaseBrowserCommand({
    command: 'cross-border-sync',
    tabId: requiredText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND'),
    payload: {
      orderIds: Array.isArray(orderIds) ? orderIds.map((value) => String(value || '').trim()).filter(Boolean) : [],
      commit: commit !== false,
    },
  });
  return {
    ok: response?.ok === true,
    result: response?.result || null,
    state: normalizePurchaseBrowserState(response?.state || response),
  };
}

export async function showPurchaseBrowserBounds(bounds = {}) {
  const normalized = normalizeEmbeddedBrowserBounds(bounds);
  if (!normalized) throw purchaseBrowserError('PURCHASE_BROWSER_BOUNDS_INVALID');
  return normalizePurchaseBrowserState(
    await dispatchPurchaseBrowserCommand({
      command: 'embed-bounds',
      bounds: normalized,
    })
  );
}

export async function hidePurchaseBrowserViewport() {
  return normalizePurchaseBrowserState(
    await dispatchPurchaseBrowserCommand({ command: 'embed-hide' })
  );
}

export async function hidePurchaseBrowser() {
  return normalizePurchaseBrowserState(await dispatchPurchaseBrowserCommand({ command: 'hide' }));
}

export async function closePurchaseBrowser(tabId = '') {
  const id = String(tabId || '').trim();
  return normalizePurchaseBrowserState(
    await dispatchPurchaseBrowserCommand({ command: 'close', ...(id ? { tabId: id } : {}) }),
  );
}

/**
 * Rebuild the native CEF host without touching the account profile. The
 * desktop close command only fences the running process; cookies, local
 * storage and fingerprint data remain on disk for the account.
 */
export async function forceResetPurchaseBrowserLogin({
  accountId,
  accountLabel,
  platformName,
  platformUrl,
} = {}) {
  await closePurchaseBrowser();
  return openPurchaseBrowserLogin({ accountId, accountLabel, platformName, platformUrl });
}

export async function restorePurchaseBrowser() {
  return normalizePurchaseBrowserState(
    await dispatchPurchaseBrowserCommand({ command: 'restore-window' })
  );
}

export async function reloadPurchaseBrowser(tabId) {
  return normalizePurchaseBrowserState(
    await dispatchPurchaseBrowserCommand({
      command: 'reload',
      tabId: requiredText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND'),
    })
  );
}

export async function inspectPurchaseBrowser(tabId) {
  const response = await dispatchPurchaseBrowserCommand({
    command: 'inspect',
    tabId: requiredText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND'),
  });
  const inspection = response?.inspection || {};
  return {
    ok: response?.ok === true,
    inspection: normalizePurchaseCapture(inspection),
    state: normalizePurchaseBrowserState(response?.state || response),
  };
}

export async function setPurchaseBrowserTarget({ tabId, target } = {}) {
  const response = await dispatchPurchaseBrowserCommand({
    command: 'set-target',
    tabId: requiredText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND'),
    target,
  });
  return {
    ok: response?.ok === true,
    target: response?.target || null,
    targetPhase: normalizeTargetPhase(response?.targetPhase, response?.target ? 'target-locked' : 'idle'),
    state: normalizePurchaseBrowserState(response?.state || response),
  };
}

export async function clearPurchaseBrowserTarget(tabId) {
  const response = await dispatchPurchaseBrowserCommand({
    command: 'clear-target',
    tabId: requiredText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND'),
  });
  return {
    ok: response?.ok === true,
    target: null,
    state: normalizePurchaseBrowserState(response?.state || response),
  };
}

export async function getPurchaseBrowserTarget(tabId, options = {}) {
  const response = await dispatchPurchaseBrowserCommand({
    command: 'get-target',
    tabId: requiredText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND'),
  }, options);
  return {
    ok: response?.ok === true,
    target: response?.target || null,
    targetPhase: normalizeTargetPhase(response?.targetPhase, response?.target ? 'target-locked' : 'idle'),
    state: normalizePurchaseBrowserState(response?.state || response),
  };
}

/**
 * Re-attaches a previously selected business target to a newly-created
 * browser generation.  This is deliberately a separate command from
 * set-target so a stale tab cannot silently overwrite a live target.
 */
export async function recoverPurchaseBrowserTarget({
  tabId,
  target,
  targetHash,
  sessionId,
  generation,
} = {}) {
  const id = requiredText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND');
  const response = await dispatchPurchaseBrowserCommand({
    command: 'target-recovery',
    tabId: id,
    target,
    ...(targetHash ? { targetHash: String(targetHash) } : {}),
    ...(sessionId ? { sessionId: String(sessionId) } : {}),
    ...(generation !== undefined ? { generation: Number(generation) } : {}),
  });
  return {
    ok: response?.ok === true,
    target: response?.target || null,
    targetPhase: normalizeTargetPhase(response?.targetPhase, response?.target ? 'target-locked' : 'idle'),
    state: normalizePurchaseBrowserState(response?.state || response),
  };
}

export async function capturePurchaseBrowser(tabId, options = {}) {
  const response = await dispatchPurchaseBrowserCommand({
    command: 'capture-purchase',
    tabId: requiredText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND'),
  }, options);
  return {
    ok: response?.ok === true,
    capture: normalizePurchaseCapture(response?.capture || response?.inspection || {}),
    target: response?.target || null,
    canCommit: response?.canCommit === true,
    targetPhase: normalizeTargetPhase(
      response?.targetPhase,
      response?.target ? 'target-locked' : 'target-selecting',
    ),
    state: normalizePurchaseBrowserState(response?.state || response),
  };
}

/**
 * Main-process capture pipeline. Keeping preview/confirm on the browser
 * command channel makes target phase and session fencing atomic with the
 * native tab; the local-api helpers remain available for non-desktop callers.
 */
export async function capturePurchaseBrowserPreview(tabId, options = {}) {
  const response = await dispatchPurchaseBrowserCommand({
    command: 'capture-preview',
    tabId: requiredText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND'),
  }, options);
  return {
    ok: response?.ok === true,
    capture: normalizePurchaseCapture(response?.capture || response?.inspection || {}),
    target: response?.target || null,
    preview: response?.preview || null,
    canCommit: response?.canCommit === true,
    targetPhase: normalizeTargetPhase(
      response?.targetPhase,
      response?.preview ? 'capture-preview' : response?.target ? 'target-locked' : 'target-selecting',
    ),
    state: normalizePurchaseBrowserState(response?.state || response),
  };
}

export async function confirmPurchaseBrowserCaptureOnTab({
  tabId,
  confirmationToken,
  acceptConflicts = false,
  signal,
} = {}) {
  const response = await dispatchPurchaseBrowserCommand({
    command: 'capture-confirm',
    tabId: requiredText(tabId, 'PURCHASE_BROWSER_TAB_NOT_FOUND'),
    confirmationToken: String(confirmationToken || ''),
    acceptConflicts: acceptConflicts === true,
  }, { signal });
  return {
    ...response,
    readbackVerified: response?.readbackVerified === true || response?.result?.readbackVerified === true,
    state: normalizePurchaseBrowserState(response?.state || response),
    targetPhase: normalizeTargetPhase(response?.targetPhase, 'completed'),
  };
}

export async function recoverPurchaseBrowser(tabId) {
  const id = String(tabId || '').trim();
  if (!id) return restorePurchaseBrowser();
  // Recovery must return after the dead native session is fenced.  Restoring
  // the old host here is unsafe: the old tab no longer exists, so the caller
  // must reopen it with the saved account binding and receive a new generation.
  return normalizePurchaseBrowserState(
    await dispatchPurchaseBrowserCommand({ command: 'force-close', tabId: id }),
  );
}

export function previewPurchaseCapture(input = {}, options = {}) {
  return previewPurchaseBrowserCapture(input, options);
}

export function confirmPurchaseCapture(input = {}, options = {}) {
  return confirmPurchaseBrowserCapture(input, options);
}

export function subscribePurchaseBrowserEvents(listener) {
  const onEvent = getPurchaseBrowserBridge()?.onEvent;
  if (typeof onEvent !== 'function' || typeof listener !== 'function') {
    return () => undefined;
  }
  const unsubscribe = onEvent(listener);
  return typeof unsubscribe === 'function' ? unsubscribe : () => undefined;
}

export function getPurchaseBrowserErrorMessage(error) {
  const rawCode = String(error?.code || error?.message || '').trim();
  const codeMatch = rawCode.match(/(?:PURCHASE_BROWSER|CROSS_BORDER)_[A-Z0-9_]+/u);
  const code = codeMatch?.[0] || '';
  if (PURCHASE_BROWSER_ERROR_MESSAGES[code]) return PURCHASE_BROWSER_ERROR_MESSAGES[code];
  return '内置浏览器操作失败，请重试；如果仍然失败，请重启桌面端。';
}
