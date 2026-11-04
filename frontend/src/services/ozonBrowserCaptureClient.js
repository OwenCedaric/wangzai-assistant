import { listIntegrationProfiles } from '../api/localApiClient.js';

const DEFAULT_MAX_BATCHES = 20;
const DEFAULT_BATCH_SIZE = 20;
const OZON_BROWSER_SESSION_TYPE = 'ozon-browser-session';
const OZON_SELLER_HOME_URL = 'https://seller.ozon.ru/app/dashboard/main';

function text(value) {
  return String(value ?? '').trim();
}

function responseResult(response) {
  return response?.result && typeof response.result === 'object' ? response.result : response || {};
}

export function isOzonBrowserSessionStaleError(error) {
  const code = text(error?.code || error?.message).toUpperCase();
  return code.includes('PURCHASE_BROWSER_SESSION_STALE')
    || code.includes('PURCHASE_BROWSER_SESSION_CRASHED')
    || code.includes('PURCHASE_BROWSER_CEF_RUNTIME_CLOSED')
    || code.includes('PURCHASE_BROWSER_CEF_PROTOCOL_CLOSED')
    || code.includes('PURCHASE_BROWSER_CEF_HOST_UNHEALTHY');
}

function cannotRecoverByObserverPolling(error) {
  const code = text(error?.code || error?.message).toUpperCase();
  return error?.retryable === false || error?.name === 'AbortError'
    || isOzonBrowserSessionStaleError(error)
    || code.includes('SHOP_LICENSE_')
    || code.includes('UNAUTHORIZED') || code.includes('ACCESS-DENIED') || code.includes('FORBIDDEN')
    || code.includes('PURCHASE_BROWSER_COMMAND_CANCELLED')
    || code.includes('OZON_DATA_OBSERVER_RESTART_REQUIRED')
    || code.includes('OZON_DATA_FRAME_SCOPE_UNVERIFIED')
    || code.includes('PURCHASE_BROWSER_BRIDGE_UNAVAILABLE');
}

export function getOzonBrowserCommand(commandOverride) {
  const command = commandOverride || globalThis.window?.wangzaiDesktop?.purchaseBrowser?.command;
  if (typeof command !== 'function') {
    const error = new Error('当前桌面端没有提供内置浏览器，请重启软件后重试。');
    error.code = 'PURCHASE_BROWSER_BRIDGE_UNAVAILABLE';
    throw error;
  }
  return command;
}

function isOzonTab(tab = {}) {
  try {
    const hostname = new URL(text(tab.url)).hostname.toLowerCase();
    // Host matching is only the first fence. selectOzonTab additionally
    // requires the dedicated market-collector role so a user tab is never
    // navigated by background analytics work.
    return hostname === 'ozon.ru' || hostname.endsWith('.ozon.ru');
  } catch {
    return false;
  }
}

function isCollectorTab(tab = {}) {
  // Product-link parsing also runs hidden, but it is deliberately a different
  // browser role. Never let an Ozon product page replace the seller analytics
  // collector merely because both are background tabs.
  return text(tab?.browserRole) === 'market-collector';
}

export function selectOzonTab(state = {}, { profileId = '', tabId = '', allowInteractive = false } = {}) {
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  const requestedProfileId = text(profileId);
  const requestedTabId = text(tabId);
  const matching = tabs.filter((tab) => (
    isOzonTab(tab)
    && (!requestedTabId || text(tab.tabId) === requestedTabId)
    && (!requestedProfileId || text(tab.accountId) === requestedProfileId)
  ));
  const collector = matching.find(isCollectorTab);
  if (collector) return collector;
  if (!allowInteractive) return null;
  const active = matching.find((tab) => text(tab.tabId) === text(state.activeTabId));
  return active || matching[0] || null;
}

function integrationProfiles(payload = {}) {
  return Array.isArray(payload?.profiles) ? payload.profiles : Array.isArray(payload?.rows) ? payload.rows : [];
}

export function selectOzonBrowserProfiles(payload = {}) {
  return integrationProfiles(payload).filter((profile) => (
    text(profile?.id)
    && text(profile?.integrationType) === OZON_BROWSER_SESSION_TYPE
    && text(profile?.configStatus) === '连接成功'
    && text(profile?.tokenStatus) === 'Cookie 已保存'
  ));
}

function selectOzonBrowserProfile(payload = {}, profileId = '') {
  const profiles = selectOzonBrowserProfiles(payload);
  const requestedProfileId = text(profileId);
  return (requestedProfileId
    ? profiles.find((profile) => text(profile?.id) === requestedProfileId)
    : profiles[0]) || null;
}

function normalizeCommandState(response = {}) {
  return response?.state?.tabs ? response.state : response?.tabs ? response : null;
}

async function openBackgroundOzonTab(command, profileLoader, profileId = '') {
  const payload = await profileLoader({ timeoutMs: 5000 });
  const profile = selectOzonBrowserProfile(payload, profileId);
  if (!profile) return { state: null, tab: null };
  const response = await command({
    command: 'open',
    ownerType: 'integration_profile',
    accountId: text(profile.id),
    accountLabel: text(profile.platformName) || 'Ozon 卖家登录',
    platformName: 'Ozon',
    url: OZON_SELLER_HOME_URL,
    waitUntil: 'commit',
    restoreVisible: false,
    browserRole: 'market-collector',
    background: true,
  });
  const state = normalizeCommandState(response);
  return { state, tab: selectOzonTab(state || {}, { profileId: text(profile.id) }) };
}

export async function ensureOzonBrowserTab({
  command: commandOverride,
  state: initialState = null,
  autoOpen = true,
  profileLoader = listIntegrationProfiles,
  profileId = '',
  tabId = '',
} = {}) {
  const command = getOzonBrowserCommand(commandOverride);
  let state = normalizeCommandState(initialState) || initialState;
  if (!state) state = normalizeCommandState(await command({ command: 'state' })) || {};
  let tab = selectOzonTab(state || {}, { profileId, tabId });
  if (!tab?.tabId && autoOpen === true) {
    // Missing profiles are a valid empty result. A failed authorization,
    // cancelled open, or transport error is not: retain its actionable cause.
    const opened = await openBackgroundOzonTab(command, profileLoader, profileId);
    state = opened.state || state;
    tab = opened.tab;
  }
  return { state, tab };
}

export async function recoverOzonBrowserCollectorTab({
  command: commandOverride,
  profileLoader = listIntegrationProfiles,
  profileId = '',
} = {}) {
  const command = getOzonBrowserCommand(commandOverride);
  const state = normalizeCommandState(await command({ command: 'state' })) || {};
  const staleTab = selectOzonTab(state, { profileId });
  if (staleTab?.tabId) {
    await command({ command: 'force-close', tabId: text(staleTab.tabId) }).catch(() => undefined);
  }
  const refreshedState = normalizeCommandState(await command({ command: 'state' })) || {};
  const recovered = await ensureOzonBrowserTab({
    command,
    state: refreshedState,
    autoOpen: true,
    profileLoader,
    profileId,
  });
  if (!recovered.tab?.tabId) {
    const error = new Error('当前没有可恢复的 Ozon 内置浏览器页面。');
    error.code = 'PURCHASE_BROWSER_TAB_NOT_FOUND';
    throw error;
  }
  return recovered;
}

export async function waitForOzonBrowserObserverStatus(command, tabId, timeoutMs = 15_000) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let status;
  let lastError = null;
  do {
    try {
      status = responseResult(await command({ command: 'ozon-data-status', tabId }));
      if (text(status.compatibilityCode)) {
        throw Object.assign(new Error('当前插件不可加载，请查看插件管理中的兼容性或恢复错误。'), {
          code: text(status.compatibilityCode), retryable: false,
        });
      }
      if (Number(status.runtime?.frameCapture?.scopeFailures) > 0) {
        const error = new Error('嵌套页面与主页面的店铺范围无法确认一致，已停止本次采集，避免串店。请确认网页登录店铺并重开采集页面。');
        Object.assign(error, { code: 'OZON_DATA_FRAME_SCOPE_UNVERIFIED', retryable: false });
        throw error;
      }
      const expectedVersion = text(status.extensionVersion);
      const runtimeVersion = text(status.runtime?.version || status.version);
      if (status.restartRequired === true || (status.ready === true && expectedVersion && runtimeVersion && expectedVersion !== runtimeVersion)) {
        const error = new Error('插件已更新，但当前页面仍使用旧版本；请先保存操作，完全退出客户端后重新打开。');
        Object.assign(error, { code: 'OZON_DATA_OBSERVER_RESTART_REQUIRED', retryable: false, expectedVersion, runtimeVersion });
        throw error;
      }
      if (status.installed === true && status.enabled === true && status.ready === true) return status;
    } catch (error) {
      // A stale generation cannot become healthy by polling the same tab for
      // 15 seconds.  Surface it immediately so the collector wrapper can
      // force-close and reopen the hidden session once.
      if (cannotRecoverByObserverPolling(error)) throw error;
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  } while (Date.now() <= deadline);
  if (!status && lastError) throw lastError;
  return status;
}

async function readAllNormalizedDatasets(command, tabId, maxBatches, batchSize, initialAfterSequence = 0) {
  const datasets = [];
  let afterSequence = Math.max(0, Number(initialAfterSequence) || 0);
  for (let index = 0; index < maxBatches; index += 1) {
    const response = await command({
      command: 'ozon-data-normalize',
      tabId,
      afterSequence,
      limit: batchSize,
    });
    const batchResult = responseResult(response);
    const batch = Array.isArray(batchResult.datasets) ? batchResult.datasets : [];
    if (!batch.length) break;
    datasets.push(...batch);
    const lastSequence = Math.max(...batch.map((item) => Number(item?.sequence) || 0));
    if (lastSequence <= afterSequence) break;
    afterSequence = lastSequence;
    if (batch.length < batchSize) break;
  }
  return datasets;
}

export function getOzonBrowserCaptureErrorMessage(error) {
  const code = text(error?.code || error?.message);
  const normalized = code.toUpperCase();
  if (normalized.startsWith('PURCHASE_BROWSER_PLUGIN_')) {
    return '当前插件不可加载，请查看插件管理中的兼容性或恢复错误；文件与恢复资料已保留。';
  }
  if (normalized.includes('OZON_DATA_FRAME_SCOPE_UNVERIFIED')) {
    return '嵌套页面与主页面的店铺范围无法确认一致，已停止采集，避免串店。请确认网页登录店铺并重开采集页面。';
  }
  if (normalized.includes('OZON_DATA_OBSERVER_RESTART_REQUIRED')) {
    return '插件已更新，但当前页面仍使用旧版本。请先保存操作，完全退出客户端再打开；仅刷新网页不能替代重启。';
  }
  if (normalized.includes('PURCHASE_BROWSER_PROXY_')) {
    return '内置浏览器代理未能成功应用，已停止加载页面；请检查代理设置后重新打开。';
  }
  if (normalized.includes('PURCHASE_BROWSER_CONTEXT_INITIALIZE_TIMEOUT') || normalized.includes('PURCHASE_BROWSER_CONTEXT_PREFERENCES_FAILED')) {
    return '当前账号的浏览器环境未能准备好，请关闭该浏览器后重新打开。';
  }
  if (normalized.includes('SHOP_LICENSE_CLIENT_ID_REQUIRED')) {
    return '当前 Ozon 网页登录尚未对应到店铺 Client ID，请在设置中检查店铺与网页登录的绑定。';
  }
  if (normalized.includes('SHOP_LICENSE_BROWSER_GATE_UNAVAILABLE')) {
    return '店铺授权校验服务暂未就绪，请稍后重试。';
  }
  if (normalized.includes('SHOP_LICENSE_')) {
    return '当前店铺授权未通过，请在设置中检查店铺授权状态。';
  }
  if (code.includes('PURCHASE_BROWSER_BRIDGE_UNAVAILABLE')) {
    return '当前桌面端没有提供内置浏览器，请重启软件后重试。';
  }
  if (code.includes('PURCHASE_BROWSER_TAB_NOT_FOUND')) {
    return '当前没有可用的 Ozon 内置浏览器页面。';
  }
  if (
    normalized.includes('ACCESS-DENIED')
    || normalized.includes('UNAUTHORIZED')
    || normalized.includes('FORBIDDEN')
    || normalized.includes('OZON_LOGIN')
  ) {
    return 'Ozon 登录会话已失效或当前账号无权读取该数据，请重新登录后再试。';
  }
  if (
    normalized.includes('PURCHASE_BROWSER_COMMAND_CANCELLED')
    || normalized.includes('OZON_DATA_PAGINATION_CANCELLED')
  ) {
    return '后台分页正在切换到本次查询，请稍后重新运行一次。';
  }
  if (
    normalized.includes('OZON_DATA_OBSERVER_PROBE_FAILED')
    || normalized.includes('OZON_PRODUCT_SEARCH_NETWORK_FAILED')
    || normalized.includes('FAILED TO FETCH')
  ) {
    return 'Ozon 商品查询网络请求失败，浏览器插件已正常运行，请检查网络后重新搜索。';
  }
  if (
    normalized.includes('OZON_MARKET_ROUTE_NAVIGATION_TIMEOUT')
    || normalized.includes('PURCHASE_BROWSER_COMMAND_TIMEOUT')
    || normalized.includes('PURCHASE_BROWSER_CEF_FAILED')
    || normalized.includes('NAVIGATION_FAILED')
  ) {
    return 'Ozon 页面网络加载超时，本次查询未读取到目标页面。';
  }
  if (normalized.includes('OZON_DATA_OBSERVER_PAGE_REQUIRED')) {
    return 'Ozon 后台页面正在切换，目标页面尚未完成加载。';
  }
  if (normalized.includes('OZON_DATA_OBSERVER')) {
    return 'Ozon 数据观察器未能注入目标页面，请刷新后台专用浏览器后重试。';
  }
  return text(error?.message) || '读取 Ozon 浏览器数据失败。';
}

export async function readOzonBrowserCaptureSnapshot({
  command: commandOverride,
  maxBatches = DEFAULT_MAX_BATCHES,
  batchSize = DEFAULT_BATCH_SIZE,
  afterSequence = 0,
  autoOpen = true,
  profileLoader = listIntegrationProfiles,
  profileId = '',
  tabId = '',
} = {}) {
  const command = getOzonBrowserCommand(commandOverride);
  const stateResponse = await command({ command: 'state' });
  const ensured = await ensureOzonBrowserTab({
    command,
    state: stateResponse,
    autoOpen,
    profileLoader,
    profileId,
    tabId,
  });
  const { state, tab } = ensured;
  if (!tab?.tabId) {
    const error = new Error('当前没有已打开的 Ozon 内置浏览器页面。');
    error.code = 'PURCHASE_BROWSER_TAB_NOT_FOUND';
    throw error;
  }
  const selectedTabId = text(tab.tabId);
  const status = await waitForOzonBrowserObserverStatus(command, selectedTabId);
  if (status?.installed !== true || status?.enabled !== true || status?.ready !== true) {
    const error = new Error('Ozon 数据观察器尚未准备好。');
    error.code = 'OZON_DATA_OBSERVER_NOT_READY';
    throw error;
  }
  const catalog = responseResult(await command({ command: 'ozon-data-catalog', tabId: selectedTabId }));
  const boundedBatches = Math.max(1, Math.min(20, Number(maxBatches) || DEFAULT_MAX_BATCHES));
  const boundedBatchSize = Math.max(1, Math.min(20, Number(batchSize) || DEFAULT_BATCH_SIZE));
  const datasets = await readAllNormalizedDatasets(
    command,
    selectedTabId,
    boundedBatches,
    boundedBatchSize,
    afterSequence,
  );
  return {
    tabId: selectedTabId,
    tab: {
      tabId: selectedTabId,
      accountId: text(tab.accountId),
      browserRole: text(tab.browserRole),
      url: text(tab.url),
      title: text(tab.title),
    },
    profileId: text(tab.accountId),
    state,
    status,
    catalog,
    datasets,
    observerVersion: text(
      status.runtime?.version
      || status.version
      || status.extensionVersion
      || catalog.version,
    ),
    capturedAt: datasets
      .map((dataset) => text(dataset?.capturedAt))
      .filter(Boolean)
      .sort()
      .at(-1) || '',
  };
}
