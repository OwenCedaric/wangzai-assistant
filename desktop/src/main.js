import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  Tray,
} from "electron";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerAppProtocol } from "./protocol/appProtocol.js";
import { loadLicenseConfig } from "./licensing/licenseConfig.js";
import { createUiUpdateRuntime, registerUiUpdateIpc } from './updates/uiUpdateRuntime.js';
import { ensureDevelopmentLicenseServer } from "./licensing/licenseServerBootstrap.js";
import { registerDesktopIpcHandlers } from "./runtime/desktopIpc.js";
import { createDesktopPaths } from "./runtime/desktopPaths.js";
import { createLegacyRetirementFault } from "./runtime/legacyRetirementFault.js";
import { createProcessSupervisor } from "./runtime/processSupervisor.js";
import {
  isProfileCacheMaintenanceRequested,
  scheduleProfileCacheMaintenanceRelaunch,
} from "./runtime/profileCacheMaintenanceLauncher.js";
import { runProfileCacheMaintenanceMode } from "./runtime/profileCacheMaintenanceMode.js";
import {
  PROFILE_CACHE_MAINTENANCE_SMOKE_ARGUMENT,
  consumeProfileCacheMaintenanceSmokeCapability,
  revalidateProfileCacheMaintenanceSmokeCapability,
  writeProfileCacheMaintenanceSmokeResult,
} from "./runtime/profileCacheMaintenanceSmokeHarness.js";
import { createRuntimeLifecycleController } from "./runtime/runtimeLifecycleController.js";
import { createRuntimeRetirementBarrier } from "./runtime/runtimeRetirementBarrier.js";
import {
  assertCurrentSourceWorkspace,
  loadCurrentVersionIdentity,
} from "./runtime/currentVersionIdentity.js";
import { activateRecoveryDatabase } from "./runtime/recoveryDatabaseActivator.js";
import { createServiceRuntime } from "./runtime/serviceRuntime.js";
import { createWechatAssistantRuntime } from "./runtime/wechatAssistantRuntime.js";
import { createMainWindowController } from "./window/mainWindow.js";
import {
  closeStartupSplashWindow,
  createStartupSplashWindow,
  focusStartupSplashWindow,
} from "./window/startupSplash.js";
import { createCefPurchaseBrowserController } from './purchaseBrowser/cefPurchaseBrowserController.js';
import { evaluatePurchaseBrowserOpenReadback } from './purchaseBrowser/purchaseBrowserOpenReadback.js';
import { createCefBrowserRuntime, pruneCefTransientCacheInWorker } from './purchaseBrowser/cefBrowserRuntime.js';
import { createPurchaseBrowserAccountPrewarmer } from './purchaseBrowser/purchaseBrowserAccountPrewarmer.js';
import { createPurchaseBrowserBuiltinManager } from './purchaseBrowser/purchaseBrowserBuiltinManager.js';
import { createPurchaseBrowserLocalApiClient } from './purchaseBrowser/purchaseBrowserLocalApiClient.js';
import { createPurchaseBrowserCefWindowController } from './purchaseBrowser/purchaseBrowserCefWindowController.js';
import { createPurchaseBrowserPolicy } from './purchaseBrowser/purchaseBrowserPolicy.js';
import { createPurchaseBrowserExternalLinkRouter } from './purchaseBrowser/purchaseBrowserExternalLinkRouter.js';
import { createPurchaseBrowserToolbarActionHandler } from './purchaseBrowser/purchaseBrowserToolbarActions.js';
import { assertOzonSellerBrowserEntitled } from './purchaseBrowser/ozonSellerLicenseGate.js';
import { createAlipayPaymentWindowController } from './purchaseBrowser/alipayPaymentWindowController.js';
import { createPurchasePaymentCredentialStore } from './purchaseBrowser/purchasePaymentCredentialStore.js';
import {
  createPurchaseBrowserProfileStore,
  createSafeStorageProtector,
} from './purchaseBrowser/purchaseBrowserProfileStore.js';

const APP_HOST = "wangzai";
const APP_ID = "com.wangzai.assistant.desktop";
const CEF_BASE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const IS_SMOKE_TEST = process.argv.includes("--smoke-test");
const IS_PERFORMANCE_TEST = process.argv.includes("--performance-test");
const IS_LEGACY_RETIREMENT_TEST = process.argv.includes(
  "--legacy-retirement-test",
);
const IS_DASHBOARD_VISUAL_TEST = process.argv.includes(
  "--dashboard-visual-test",
);
const IS_ACCOUNT_REMOVAL_SETTINGS_UI_TEST = process.argv.includes(
  "--account-removal-settings-ui-test",
);
const IS_PROFILE_CACHE_MAINTENANCE =
  isProfileCacheMaintenanceRequested(process.argv);
const IS_PROFILE_CACHE_MAINTENANCE_SMOKE = process.argv.includes(
  PROFILE_CACHE_MAINTENANCE_SMOKE_ARGUMENT,
);
const IS_AUTOMATION_TEST =
  IS_SMOKE_TEST ||
  IS_PERFORMANCE_TEST ||
  IS_LEGACY_RETIREMENT_TEST ||
  IS_DASHBOARD_VISUAL_TEST;
const ACCOUNT_REMOVAL_TEST_RECOVERY_REMOTE = (() => {
  if (!IS_ACCOUNT_REMOVAL_SETTINGS_UI_TEST || app.isPackaged) return null;
  const baseUrl = String(process.env.WANGZAI_ACCOUNT_REMOVAL_TEST_RECOVERY_REMOTE_URL || '').trim();
  const accessToken = String(process.env.WANGZAI_ACCOUNT_REMOVAL_TEST_RECOVERY_REMOTE_TOKEN || '').trim();
  if (!baseUrl || !accessToken) return null;
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
    throw new Error('ACCOUNT_REMOVAL_TEST_RECOVERY_REMOTE_MUST_BE_LOOPBACK');
  }
  return { baseUrl: parsed.toString().replace(/\/$/u, ''), accessToken };
})();
const PERFORMANCE_PRODUCT_COUNT = Math.max(
  0,
  Number.parseInt(process.env.WANGZAI_PERFORMANCE_PRODUCT_COUNT || "0", 10) || 0,
);
const PERFORMANCE_SWITCH_STRESS_COUNT = Math.max(
  0,
  Number.parseInt(process.env.WANGZAI_PERFORMANCE_SWITCH_STRESS_COUNT || "0", 10) || 0,
);
const PERFORMANCE_ORDER_COUNT = Math.max(
  0,
  Number.parseInt(process.env.WANGZAI_PERFORMANCE_ORDER_COUNT || "0", 10) || 0,
);
const PERFORMANCE_TARGETS = new Set(["products", "sales-orders", "settings", "all-modules", "purchase-orders"]);
const REQUESTED_PERFORMANCE_TARGET = String(process.env.WANGZAI_PERFORMANCE_TARGET || "products").trim();
const PERFORMANCE_TARGET = PERFORMANCE_TARGETS.has(REQUESTED_PERFORMANCE_TARGET)
  ? REQUESTED_PERFORMANCE_TARGET
  : "products";
const LEGACY_RETIREMENT_FAULT = createLegacyRetirementFault({
  enabled: IS_LEGACY_RETIREMENT_TEST,
  phase: process.env.WANGZAI_LEGACY_RETIREMENT_PHASE,
  fixtureId: process.env.WANGZAI_LEGACY_RETIREMENT_FIXTURE_ID,
  // Only the isolated recovery-failure fixture can read these values. They are
  // supplied by the test runner's loopback opaque remote and never reach the
  // renderer, normal recovery IPC, or structured evidence logs.
  recoveryRemote: {
    baseUrl: process.env.WANGZAI_LEGACY_RETIREMENT_RECOVERY_REMOTE_URL,
    accessToken: process.env.WANGZAI_LEGACY_RETIREMENT_RECOVERY_REMOTE_TOKEN,
  },
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(desktopRoot, "..");
const currentVersionIdentity = loadCurrentVersionIdentity({ desktopRoot });
assertCurrentSourceWorkspace({
  identity: currentVersionIdentity,
  workspaceRoot,
  isPackaged: app.isPackaged,
});

if (process.env.WANGZAI_DESKTOP_DATA_DIR) {
  app.setPath("userData", path.resolve(process.env.WANGZAI_DESKTOP_DATA_DIR));
}

const paths = createDesktopPaths({ app, desktopRoot, workspaceRoot });
const sealedLicenseConfig = loadLicenseConfig({
  app,
  desktopRoot,
  resourcesPath: process.resourcesPath,
});
const supervisor = createProcessSupervisor({
  getLogDirectory: paths.logDirectory,
  selfHostedTlsEnabled: !app.isPackaged && sealedLicenseConfig.localSelfHosting === true,
});
const purchaseBrowserRetirements = createRuntimeRetirementBarrier({
  onFailure: error => supervisor.appendLog('desktop-main',
    `[purchase-browser-retirement] code=${String(error?.code || 'UNVERIFIED').replace(/[^A-Z0-9_]/gu, '').slice(0, 100)}\n`),
});
const services = createServiceRuntime({
  paths,
  supervisor,
  isPackaged: app.isPackaged,
  continuousSyncEnabled: !IS_DASHBOARD_VISUAL_TEST,
  protectedComputeConfig: sealedLicenseConfig.protectedCompute,
  thinClientCore: sealedLicenseConfig.thinClient,
  safeStorage,
});
const wechatAssistantRuntime = createWechatAssistantRuntime({
  app,
  safeStorage,
  paths,
  desktopRoot,
  workspaceRoot,
  appendLog: supervisor.appendLog,
});
const windowIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'tray', 'icon.png')
  : path.join(desktopRoot, 'resources', 'icon.png');
const rendererPreloadPath = app.isPackaged
  ? path.join(process.resourcesPath, 'preload', 'preload.cjs')
  : path.join(__dirname, 'preload.cjs');
const windows = createMainWindowController({
  app,
  appHost: APP_HOST,
  appId: APP_ID,
  preloadPath: rendererPreloadPath,
  windowIconPath,
  windowTitle: currentVersionIdentity.windowTitle,
  isSmokeTest: IS_SMOKE_TEST,
  isPerformanceTest: IS_PERFORMANCE_TEST,
  isLegacyRetirementTest: IS_LEGACY_RETIREMENT_TEST,
  isDashboardVisualTest: IS_DASHBOARD_VISUAL_TEST,
  performanceProductCount: PERFORMANCE_PRODUCT_COUNT,
  performanceSwitchStressCount: PERFORMANCE_SWITCH_STRESS_COUNT,
  performanceOrderCount: PERFORMANCE_ORDER_COUNT,
  performanceTarget: PERFORMANCE_TARGET,
  appendLog: supervisor.appendLog,
  legacyRetirementFault: LEGACY_RETIREMENT_FAULT,
  // All renderer/window external links are routed to the one native CEF
  // window; mainWindow.js never falls back to the OS default browser.
  openInternalUrl: (url) => routeExternalLinkToInternalBrowser(url),
});

let runtimeInfo = null;
let desktopLicenseRuntime = null;
const uiUpdateRuntime = createUiUpdateRuntime({
  config: sealedLicenseConfig.uiUpdate,
  dataRoot: paths.desktopDataRoot(),
  bundledDirectory: paths.frontendDistDirectory(),
  getSession: () => desktopLicenseRuntime?.getSession?.(),
  getToken: input => desktopLicenseRuntime?.getProtectedComputeAccessToken?.(input),
  logger: event => supervisor.appendLog('desktop-main', `[ui-update] ${JSON.stringify(event)}\n`),
});
let startupSplashWindow = null;
let isQuitting = false;
let profileLock = null;
let shutdownPromise = null;
let purchaseBrowserController = null;
let purchaseBrowserNativeRuntime = null;
let purchaseBrowserHostController = null;
let purchaseBrowserLocalApiClient = null;
let purchaseBrowserExternalLinkRouter = null;
let purchaseBrowserAccountPrewarmer = null;
let alipayPaymentWindowController = null;
let purchasePaymentCredentialStore = null;
let purchaseBrowserHostWarmPromise = null;
let purchaseBrowserHostWarmOwner = null;
let purchaseBrowserCacheMaintenancePromise = Promise.resolve({ ok: true, removed: 0 });
const purchaseBrowserExternalOpenChains = new Map();
const purchaseBrowserToolbarActions = createPurchaseBrowserToolbarActionHandler({
  getController: () => purchaseBrowserController,
  getLocalApiClient: () => purchaseBrowserLocalApiClient,
  onCollectionPricingCapture: async ({ capture, tabId, accountId, sourceUrl }) => {
    const mainWindow = windows.getWindow();
    if (!mainWindow || mainWindow.isDestroyed?.()) {
      const error = new Error('PURCHASE_BROWSER_MAIN_WINDOW_UNAVAILABLE');
      error.code = 'PURCHASE_BROWSER_MAIN_WINDOW_UNAVAILABLE';
      throw error;
    }
    mainWindow.webContents.send('desktop:purchase-browser-event', {
      event: 'collection-pricing-captured',
      capture: { ...capture, sourceUrl: capture?.sourceUrl || sourceUrl },
      tabId,
      accountId,
    });
    // Batch collection keeps the native CEF browser in front. The renderer
    // receives and stores the item without stealing focus or hiding the page.
    return { delivered: true };
  },
  onPurchaseLoginSaved: async ({ accountId, tabId, account, verification, state }) => {
    const mainWindow = windows.getWindow();
    if (!mainWindow || mainWindow.isDestroyed?.()) {
      const error = new Error('PURCHASE_BROWSER_MAIN_WINDOW_UNAVAILABLE');
      error.code = 'PURCHASE_BROWSER_MAIN_WINDOW_UNAVAILABLE';
      throw error;
    }
    mainWindow.webContents.send('desktop:purchase-browser-event', {
      event: 'purchase-login-saved',
      accountId,
      tabId,
      account,
      verification: {
        loggedIn: verification?.loggedIn === true,
        cookieSaved: verification?.cookieSaved === true,
        cookieCount: Number(verification?.cookieCount) || 0,
        platformKey: String(verification?.platformKey || ''),
        verifiedAt: String(verification?.verifiedAt || ''),
      },
      state,
    });
    return { delivered: true };
  },
  onCrossBorderChargesCommitted: async ({ tabId, accountId, shopId, committed }) => {
    const mainWindow = windows.getWindow();
    if (!mainWindow || mainWindow.isDestroyed?.()) {
      return { delivered: false };
    }
    mainWindow.webContents.send('desktop:purchase-browser-event', {
      event: 'cross-border-charges-committed',
      tabId,
      accountId,
      shopId,
      summary: {
        savedOrderCount: Number(committed?.savedOrderCount) || 0,
        exactCount: Number(committed?.exactCount) || 0,
        unmatchedCount: Number(committed?.unmatchedCount) || 0,
        actualFeeCny: Number(committed?.exactActualFeeCny) || 0,
        readbackVerified: committed?.readbackVerified === true,
      },
    });
    return { delivered: true };
  },
});

function showStartupSplash() {
  if (IS_AUTOMATION_TEST || startupSplashWindow) return startupSplashWindow;
  startupSplashWindow = createStartupSplashWindow({
    BrowserWindow,
    iconPath: windowIconPath,
    title: currentVersionIdentity.windowTitle,
    message: '正在准备登录和本地服务',
    onError: (error) => {
      supervisor.appendLog(
        'desktop-main',
        `[startup-splash] load failed ${error?.stack || error}\n`,
      );
    },
  });
  startupSplashWindow.on('closed', () => {
    startupSplashWindow = null;
  });
  supervisor.appendLog('desktop-main', '[startup-splash] created\n');
  return startupSplashWindow;
}

function closeStartupSplash() {
  const current = startupSplashWindow;
  startupSplashWindow = null;
  closeStartupSplashWindow(current);
}

function restoreStartupSurface() {
  if (focusStartupSplashWindow(startupSplashWindow)) {
    supervisor.appendLog(
      'desktop-main',
      '[startup-splash] focused after repeat launch\n',
    );
    return;
  }
  void runtimeLifecycle.restoreWindow();
}

function activePurchaseBrowserAccountId() {
  const state = purchaseBrowserController?.snapshot?.();
  const activeTabId = String(state?.activeTabId || '');
  const activeTab = Array.isArray(state?.tabs)
    ? state.tabs.find((tab) => String(tab?.tabId || '') === activeTabId)
    : null;
  return String(activeTab?.accountId || '').trim();
}

/** Open a URL in the single native CEF window. */
async function openPurchaseBrowserUrlNow(url, {
  accountId = '',
  ownerType = 'purchase_account',
  platformName = '',
  accountLabel = '',
  browserRole = 'interactive',
  background = false,
  restoreVisible = true,
  waitUntil = 'commit',
  workbench = null,
  purchaseTarget = null,
  embeddedBounds = null,
  standaloneSize = null,
} = {}) {
  await purchaseBrowserCacheMaintenancePromise.catch(() => undefined);
  const controller = purchaseBrowserController;
  const host = purchaseBrowserHostController;
  if (!controller || !host) {
    const error = new Error('PURCHASE_BROWSER_NOT_READY');
    error.code = 'PURCHASE_BROWSER_NOT_READY';
    throw error;
  }
  const normalizedUrl = String(url || '').trim();
  if (!normalizedUrl) {
    const error = new Error('PURCHASE_BROWSER_EXTERNAL_URL_INVALID');
    error.code = 'PURCHASE_BROWSER_EXTERNAL_URL_INVALID';
    throw error;
  }
  const openStartedAt = Date.now();
  let openStageStartedAt = openStartedAt;
  const logOpenStage = (stage) => {
    const now = Date.now();
    supervisor.appendLog(
      'desktop-main',
      `[purchase-browser] embedded route stage=${stage} durationMs=${Math.max(0, now - openStageStartedAt)} totalMs=${Math.max(0, now - openStartedAt)}\n`,
    );
    openStageStartedAt = now;
  };
  const input = {
    command: 'open',
    accountId: String(accountId || '').trim(),
    ownerType: String(ownerType || 'purchase_account').trim(),
    platformName: String(platformName || '').trim(),
    accountLabel: String(accountLabel || '').trim(),
    browserRole: String(browserRole || 'interactive').trim(),
    background: background === true,
    restoreVisible: restoreVisible !== false,
    waitUntil: String(waitUntil || 'commit').trim(),
    url: normalizedUrl,
    workbench,
    ...(purchaseTarget && typeof purchaseTarget === 'object' && !Array.isArray(purchaseTarget)
      ? { purchaseTarget }
      : {}),
    ...(embeddedBounds && typeof embeddedBounds === 'object' ? { bounds: embeddedBounds } : {}),
  };
  if (!embeddedBounds && standaloneSize && typeof standaloneSize === 'object') {
    const standaloneBounds = host.standaloneBoundsForSize?.({
      width: standaloneSize.width,
      height: standaloneSize.height,
      visible: restoreVisible !== false,
    });
    if (!standaloneBounds) {
      const error = new Error('PURCHASE_BROWSER_BOUNDS_INVALID');
      error.code = 'PURCHASE_BROWSER_BOUNDS_INVALID';
      throw error;
    }
    input.bounds = standaloneBounds;
  }
  await assertOzonSellerBrowserEntitled({
    input,
    snapshot: controller.snapshot?.() || {},
    localApiClient: purchaseBrowserLocalApiClient,
    licenseRuntime: desktopLicenseRuntime,
  });
  const backgroundOpen = input.background === true
    || input.browserRole === 'product-link-parser'
    || input.browserRole === 'follow-seller-collector';
  if (backgroundOpen) {
    // Link inspection owns an invisible CEF browser/session.  It must not
    // show, hide, navigate or resize the market collector or the user's
    // current operation workbench.
    await controller.attachBrowserOwner?.(host.getWindow?.());
    const result = await controller.dispatch({
      ...input,
      background: true,
      restoreVisible: false,
      workbench: null,
    });
    host.setBrowserState?.(result);
    return result;
  }
  // CEF owns the complete visible chrome.  Do not hide an already
  // visible native window merely to navigate or switch an account; that old
  // hide/show cycle caused the noticeable white flash on every link click.
  const currentState = controller.snapshot?.() || {};
  const visibleTab = Array.isArray(currentState.tabs)
    ? currentState.tabs.find((tab) => tab.tabId === currentState.activeTabId)
    : null;
  const keepVisible = currentState.visible === true && visibleTab && visibleTab.crashed !== true;
  const embeddedOpen = workbench?.displayMode === 'embedded' && Boolean(embeddedBounds);
  const leavingEmbeddedMode = !embeddedOpen && visibleTab?.embedding?.requested === true;
  if (leavingEmbeddedMode) {
    // A product title can reuse the same Ozon profile that was just hosted as
    // a WS_CHILD inside an order workbench. The controller still owns that
    // card-sized viewport until it receives a new rectangle. Reset the host
    // locally and carry the standalone rectangle in the same high-priority
    // open command; a superseded resize/hide command can no longer leave the
    // top-level CEF window validating against the old embedded dimensions.
    const standaloneBounds = await host.clearEmbeddedViewport?.({ notify: false });
    if (!standaloneBounds) {
      const error = new Error('PURCHASE_BROWSER_BOUNDS_INVALID');
      error.code = 'PURCHASE_BROWSER_BOUNDS_INVALID';
      throw error;
    }
    input.bounds = { ...standaloneBounds, visible: true };
  }
  if (!keepVisible && !embeddedOpen) {
    await host.showLoading({
      title: platformName || '内置浏览器',
      subtitle: '旺崽助手 · 独立账号安全窗口',
    });
  }
  await controller.attachBrowserOwner?.(host.getWindow?.());
  if (embeddedOpen) logOpenStage('owner');
  try {
    const result = await controller.dispatch(input);
    if (embeddedOpen) logOpenStage('controller');
    host.setBrowserState?.(result);
    if (embeddedOpen) {
      const readback = evaluatePurchaseBrowserOpenReadback({
        state: result,
        accountId: input.accountId,
        requestedUrl: normalizedUrl,
        requestedEmbedded: true,
      });
      if (!readback.ok) {
        const mismatch = new Error(readback.code);
        mismatch.code = readback.code;
        throw mismatch;
      }
      logOpenStage(readback.mode === 'pinduoduo-dedicated' ? 'dedicated-window-verified' : 'target-verified');
      supervisor.appendLog(
        'desktop-main',
        `[purchase-browser] embedded open ready durationMs=${Math.max(0, Date.now() - openStartedAt)}\n`,
      );
      return result;
    }
    // Existing hidden sessions are restored by the controller's one verified
    // visible-bounds command. Calling showReady afterwards publishes the same
    // rectangle again and makes WinForms activate/show the HWND a second time,
    // which is the remaining single flash after closing and reopening a page.
    if (keepVisible || result?.visible === true) return result;
    await host.showReady({
      title: platformName || '内置浏览器',
      subtitle: accountLabel || '旺崽助手 · 独立账号安全窗口',
      embedded: workbench?.displayMode === 'embedded',
    });
    const bounds = host.viewportBounds({ visible: true });
    const visibleResult = await controller.dispatch({ command: 'bounds', bounds });
    host.setBrowserState?.(visibleResult);
    return visibleResult;
  } catch (error) {
    await controller.dispatch({ command: 'hide' }).catch(() => undefined);
    await host.showError({
      title: '内置浏览器',
      subtitle: String(error?.code || error?.message || '打开失败'),
    }).catch(() => undefined);
    throw error;
  }
}

async function openPurchaseBrowserUrl(url, options = {}) {
  const lane = options?.background === true || options?.restoreVisible === false
    ? `background:${String(options?.browserRole || 'background')}:${String(options?.accountId || '')}`
    : 'interactive-visible';
  const previous = purchaseBrowserExternalOpenChains.get(lane) || Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() => openPurchaseBrowserUrlNow(url, options));
  const settled = run.catch(() => undefined).finally(() => {
    if (purchaseBrowserExternalOpenChains.get(lane) === settled) {
      purchaseBrowserExternalOpenChains.delete(lane);
    }
  });
  purchaseBrowserExternalOpenChains.set(lane, settled);
  return run;
}

async function routeExternalLinkToInternalBrowser(url, options = {}) {
  const router = purchaseBrowserExternalLinkRouter;
  if (!router) {
    const error = new Error('PURCHASE_BROWSER_EXTERNAL_ROUTER_NOT_READY');
    error.code = 'PURCHASE_BROWSER_EXTERNAL_ROUTER_NOT_READY';
    throw error;
  }
  return router.open(url, {
    ...options,
    activeAccountId: activePurchaseBrowserAccountId(),
  });
}

async function withPurchaseBrowserLifecycleLog(operation, task) {
  const startedAt = Date.now();
  try {
    const result = await task();
    supervisor.appendLog(
      'desktop-main',
      `[purchase-browser-lifecycle] operation=${operation} result=ok durationMs=${Math.max(0, Date.now() - startedAt)}\n`,
    );
    return result;
  } catch (error) {
    supervisor.appendLog(
      'desktop-main',
      `[purchase-browser-lifecycle] operation=${operation} result=error code=${String(error?.code || error?.message || 'unknown').replace(/[^A-Z0-9_]/gu, '').slice(0, 100)} durationMs=${Math.max(0, Date.now() - startedAt)}\n`,
    );
    throw error;
  }
}

async function handlePurchaseBrowserShellAction({ action, payload = {} } = {}) {
  const result = await purchaseBrowserToolbarActions.handle({ action, payload });
  purchaseBrowserHostController?.setBrowserState?.(result);
  return result;
}

async function restorePurchaseBrowserWindow() {
  return withPurchaseBrowserLifecycleLog('restore', async () => {
    const controller = purchaseBrowserController;
    const host = purchaseBrowserHostController;
    const state = controller?.snapshot?.() || {};
    if (!controller || !host || !state.activeTabId || !Array.isArray(state.tabs) || state.tabs.length === 0) {
      return state;
    }
    const popup = await host.restore?.();
    if (!popup) return state;
    await controller.attachBrowserOwner?.(popup);
    const activated = await controller.dispatch({ command: 'activate', tabId: state.activeTabId });
    host.setBrowserState?.(activated);
    const bounds = host.viewportBounds({ visible: true });
    const restored = await controller.dispatch({ command: 'bounds', bounds });
    host.setBrowserState?.(restored);
    return restored;
  });
}

function hidePurchaseBrowserWindow() {
  const startedAt = Date.now();
  purchaseBrowserHostController?.hide?.();
  const operation = purchaseBrowserController?.dispatch?.({ command: 'hide' });
  if (!operation) return Promise.resolve(null);
  return operation.then((result) => {
    supervisor.appendLog('desktop-main', `[purchase-browser-lifecycle] operation=hide result=ok durationMs=${Math.max(0, Date.now() - startedAt)}\n`);
    return result;
  }).catch((error) => {
    supervisor.appendLog('desktop-main', `[purchase-browser-lifecycle] operation=hide result=error code=${String(error?.code || error?.message || 'unknown').replace(/[^A-Z0-9_]/gu, '').slice(0, 100)} durationMs=${Math.max(0, Date.now() - startedAt)}\n`);
    return undefined;
  });
}

// Destructive shutdown helper. User-facing X/close never calls this; it is
// reserved for app quit so every native process is released before exit.
async function closePurchaseBrowserWindow({ force = false } = {}) {
  return withPurchaseBrowserLifecycleLog('close', async () => {
    const controller = purchaseBrowserController;
    purchaseBrowserHostController?.hide?.();
    const state = controller?.snapshot?.() || {};
    if (!controller) return state;
    const tabId = String(state.activeTabId || '');
    try {
      if (force && typeof controller.forceCloseAll === 'function') {
        return await controller.forceCloseAll();
      }
      // The shell is hidden synchronously by the caller.  The native session
      // cleanup is bounded and keeps the encrypted profile/Cookie directory,
      // so the next open can restore the account without a second login.
      if (typeof controller.shutdown === 'function') {
        return await controller.shutdown({ timeoutMs: 3_000 });
      }
      return tabId ? await controller.dispatch({ command: 'close', tabId }) : state;
    } catch (error) {
      supervisor.appendLog(
        'desktop-main',
        `[purchase-browser] graceful close failed code=${error?.code || error?.message || 'unknown'}; forcing session close\n`,
      );
      try {
        if (typeof controller.forceCloseAll === 'function') return await controller.forceCloseAll();
        return await controller.forceClose?.(tabId);
      } catch {
        return controller.snapshot?.() || {};
      }
    }
  });
}

// User-facing close must never wait for a page navigation, logistics request,
// or a wedged Sidecar. Hide the Electron shell synchronously and start the
// controller's process-tree sweep in the background. App quit still uses the
// bounded graceful close above.
function requestClosePurchaseBrowserWindow() {
  purchaseBrowserHostController?.hide?.();
  const controller = purchaseBrowserController;
  if (!controller) return Promise.resolve(null);
  const startedAt = Date.now();
  let operation;
  try {
    operation = typeof controller.forceCloseAll === 'function'
      ? controller.forceCloseAll()
      : controller.shutdown?.({ timeoutMs: 750 });
  } catch (error) {
    supervisor.appendLog(
      'desktop-main',
      '[purchase-browser-lifecycle] operation=force-close result=error code='
        + String(error?.code || error?.message || 'unknown').replace(/[^A-Z0-9_]/gu, '').slice(0, 100) + '\n',
    );
    return Promise.resolve(null);
  }
  return Promise.resolve(operation).then((result) => {
    supervisor.appendLog(
      'desktop-main',
      '[purchase-browser-lifecycle] operation=force-close result=ok durationMs='
        + Math.max(0, Date.now() - startedAt) + '\n',
    );
    return result;
  }).catch((error) => {
    supervisor.appendLog(
      'desktop-main',
      '[purchase-browser-lifecycle] operation=force-close result=error code='
        + String(error?.code || error?.message || 'unknown').replace(/[^A-Z0-9_]/gu, '').slice(0, 100) + '\n',
    );
    return undefined;
  });
}

function reconcilePurchaseBrowserWindowState() {
  const state = purchaseBrowserController?.snapshot?.();
  if (state) purchaseBrowserHostController?.setBrowserState?.(state);
  return state || null;
}

function disposePurchaseBrowserRuntime() {
  // Keep this receipt even when suspend/recovery clears the public reference.
  // A later runtime must not clean or open the same profile before it settles.
  const retirement = purchaseBrowserRetirements.retire(purchaseBrowserNativeRuntime);
  purchaseBrowserAccountPrewarmer?.dispose?.();
  purchaseBrowserAccountPrewarmer = null;
  purchaseBrowserExternalLinkRouter?.clearCache?.();
  purchaseBrowserExternalLinkRouter = null;
  purchaseBrowserLocalApiClient = null;
  alipayPaymentWindowController?.dispose?.();
  alipayPaymentWindowController = null;
  purchasePaymentCredentialStore = null;
  purchaseBrowserController?.dispose?.();
  purchaseBrowserController = null;
  purchaseBrowserNativeRuntime = null;
  purchaseBrowserHostController?.dispose?.();
  purchaseBrowserHostController = null;
  purchaseBrowserHostWarmPromise = null;
  purchaseBrowserHostWarmOwner = null;
  return retirement;
}

// 采购卡片必须在主窗口创建并绑定后再预热。启动时 runtime 先于主窗口
// 初始化，如果在 createPurchaseBrowserRuntime 内直接 ensure，会稳定得到
// PURCHASE_BROWSER_HOST_WINDOW_REQUIRED；下次点击又会重新走冷启动，表现为
// “第一次打开失败/很慢”。这里统一收口所有生命周期入口：先画好隐藏宿主卡片，
// 再让每个平台按规则选出的一个采购账号在后台完成唯一一次冷启动。真正点击
// 时只需激活已有 session、导航并显示窗口，不再把 4～5 秒原生进程启动时间
// 压到用户点击之后。
function warmPurchaseBrowserHost() {
  const host = purchaseBrowserHostController;
  const parent = windows.getWindow();
  if (!host || !parent || parent.isDestroyed?.()) return Promise.resolve(false);
  if (purchaseBrowserHostWarmPromise && purchaseBrowserHostWarmOwner === host) {
    return purchaseBrowserHostWarmPromise;
  }
  purchaseBrowserHostWarmOwner = host;
  purchaseBrowserHostWarmPromise = purchaseBrowserCacheMaintenancePromise
    .catch(() => undefined)
    .then(() => host.showLoading({
      title: '采购平台',
      subtitle: '旺崽助手 · 独立账号安全窗口',
    }))
    .then(async (window) => {
      if (host !== purchaseBrowserHostController || !purchaseBrowserController) return false;
      await purchaseBrowserController.attachBrowserOwner?.(window);
      supervisor.appendLog('desktop-main', '[purchase-browser] hidden host warmup ready\n');
      // The shell warmup is intentionally separate from account prewarming;
      // the latter starts only after the main window is ready and remains
      // fire-and-forget so startup never waits for network or browser work.
      return true;
    })
    .catch((error) => {
      supervisor.appendLog(
        'desktop-main',
        `[purchase-browser] hidden host warmup failed code=${error?.code || error?.message || 'unknown'}\n`,
      );
      if (purchaseBrowserHostWarmOwner === host) {
        purchaseBrowserHostWarmPromise = null;
        purchaseBrowserHostWarmOwner = null;
      }
      return false;
    });
  return purchaseBrowserHostWarmPromise;
}

function startPurchaseBrowserAccountPrewarm() {
  // Source launcher compatibility mode: avoid creating native browser HWNDs
  // during startup. Explicit user browser actions keep their normal path.
  if (!app.isPackaged && process.env.WANGZAI_BROWSER_PREWARM_DISABLED === '1') {
    supervisor.appendLog('desktop-main', '[purchase-browser] startup prewarm disabled; explicit browser actions remain available\n');
    return Promise.resolve(null);
  }
  const prewarmer = purchaseBrowserAccountPrewarmer;
  if (!prewarmer) return Promise.resolve(null);
  return warmPurchaseBrowserHost()
    .then((hostReady) => {
      // Runtime rebinding can replace the controller while the hidden shell
      // is still warming.  Never let an old prewarmer open sessions in the
      // replacement controller.
      if (!hostReady || prewarmer !== purchaseBrowserAccountPrewarmer) return null;
      return prewarmer.start();
    })
    .catch((error) => {
      supervisor.appendLog(
        'desktop-main',
        `[purchase-browser] account prewarm dispatch failed code=${error?.code || error?.message || 'unknown'}\n`,
      );
      return null;
    });
}

let accountRemovalRestartScheduled = false;
let profileCacheMaintenanceRestartScheduled = false;
let desktopTray = null;
let powerLifecycleInstalled = false;
let runtimeSuspended = false;

const runtimeLifecycle = createRuntimeLifecycleController({
  closeToTrayEnabled: !IS_AUTOMATION_TEST,
  isQuitting: () => isQuitting,
  getWindow: () => windows.getWindow(),
  createWindow: async () => {
    if (!runtimeInfo) return null;
      const window = await windows.createIfAbsent(runtimeInfo);
      if (window) {
        purchaseBrowserController?.attachHost(window);
        void startPurchaseBrowserAccountPrewarm();
      }
    return window;
  },
  onSuspend: suspendRuntimeForPowerEvent,
  onResume: resumeRuntimeAfterPowerEvent,
  onWindowHidden: () => {
    purchaseBrowserHostController?.hide?.();
    Promise.resolve(purchaseBrowserController?.dispatch?.({ command: 'hide' })).catch(() => undefined);
    supervisor.appendLog('desktop-main', '[lifecycle] window hidden to tray; services continue\n');
  },
  onWindowRestored: () => {
    reconcilePurchaseBrowserWindowState();
  },
  onRendererRecoveryFailed: (error) => {
    if (isQuitting) return;
    dialog.showErrorBox(
      '界面恢复未完成',
      '请从托盘选择“彻底退出”，然后重新打开旺崽助手。界面恢复不会重新提交采购或付款操作；重新打开后请先核对订单状态。'
        + `\n\n错误代码：${error?.code || 'DESKTOP_RENDERER_RECOVERY_FAILED'}`,
    );
  },
  logger: (event, details) => {
    supervisor.appendLog(
      'desktop-main',
      `[lifecycle] ${event} ${JSON.stringify(details || {})}\n`,
    );
  },
});

const hasSingleInstanceLock =
  IS_AUTOMATION_TEST || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function ensureDesktopTray() {
  if (IS_AUTOMATION_TEST || desktopTray) return desktopTray;
  try {
    const trayIconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'tray', 'icon.png')
      : path.join(desktopRoot, 'resources', 'icon.png');
    desktopTray = new Tray(trayIconPath);
    desktopTray.setToolTip('旺崽助手');
    desktopTray.setContextMenu(Menu.buildFromTemplate([
      {
        label: '显示旺崽助手',
        click: () => runtimeLifecycle.restoreWindow(),
      },
      {
        label: '恢复采购窗口',
        click: () => void restorePurchaseBrowserWindow().catch((error) => {
          supervisor.appendLog(
            'desktop-main',
            `[purchase-browser] tray restore failed code=${error?.code || error?.message || 'unknown'}\n`,
          );
        }),
      },
      {
        label: '隐藏采购窗口',
        click: () => void hidePurchaseBrowserWindow(),
      },
      { type: 'separator' },
      {
        label: '彻底退出',
        click: () => app.quit(),
      },
    ]));
    runtimeLifecycle.attachTray(desktopTray);
    return desktopTray;
  } catch (error) {
    supervisor.appendLog(
      'desktop-main',
      `[lifecycle] tray initialization failed: ${error?.stack || error}\n`,
    );
    desktopTray = null;
    return null;
  }
}

function installPowerLifecycle() {
  if (powerLifecycleInstalled) return;
  powerLifecycleInstalled = true;
  powerMonitor.on('suspend', () => {
    void runtimeLifecycle.handleSuspend();
  });
  powerMonitor.on('resume', () => {
    void runtimeLifecycle.handleResume();
  });
}

async function suspendRuntimeForPowerEvent() {
  if (isQuitting || runtimeSuspended) {
    return { stopped: false, reason: isQuitting ? 'app_quitting' : 'already_suspended' };
  }
  runtimeSuspended = true;
  supervisor.appendLog(
    'desktop-main',
    '[lifecycle] system suspend: draining owned services; profile lock retained\n',
  );
  desktopLicenseRuntime?.recoveryAutoBackupScheduler?.stop?.();
  disposePurchaseBrowserRuntime();
  await services.stopAll();
  runtimeInfo = null;
  supervisor.appendLog(
    'desktop-main',
    '[lifecycle] system suspend checkpoint complete\n',
  );
  return { stopped: true, profileLockRetained: Boolean(profileLock) };
}

async function resumeRuntimeAfterPowerEvent() {
  if (isQuitting) return { restarted: false, reason: 'app_quitting' };
  if (!runtimeSuspended && runtimeInfo) {
    return { restarted: false, reason: 'runtime_already_active' };
  }
  supervisor.appendLog(
    'desktop-main',
    '[lifecycle] system resume: restarting independent shop runtimes with durable reconciliation\n',
  );
  runtimeInfo = await services.startAll();
  await configureRuntimeBindings();
  const mainWindow = windows.getWindow();
  if (mainWindow) {
    purchaseBrowserController?.attachHost(mainWindow);
    void startPurchaseBrowserAccountPrewarm();
  }
  runtimeSuspended = false;
  supervisor.appendLog('desktop-main', '[lifecycle] system resume recovery complete\n');
  return { restarted: true, shopIsolation: true };
}

async function bootstrapDesktop() {
  if (IS_PROFILE_CACHE_MAINTENANCE_SMOKE && !IS_PROFILE_CACHE_MAINTENANCE) {
    throw new Error("PROFILE_CACHE_MAINTENANCE_SMOKE_REQUIRES_MAINTENANCE_MODE");
  }
  if (IS_PROFILE_CACHE_MAINTENANCE) {
    const smokeCapability = consumeProfileCacheMaintenanceSmokeCapability({
      enabled: IS_PROFILE_CACHE_MAINTENANCE_SMOKE,
      isPackaged: app.isPackaged,
      isSmokeTest: IS_SMOKE_TEST,
      dataRoot: paths.desktopDataRoot(),
      databasePath: paths.localApiDatabasePath(),
      token: process.env.WANGZAI_PROFILE_CACHE_MAINTENANCE_SMOKE_TOKEN,
    });
    const maintenanceDataRoot = smokeCapability?.dataRoot
      || paths.desktopDataRoot();
    const maintenanceDatabasePath = smokeCapability?.databasePath
      || paths.localApiDatabasePath();
    const result = await runProfileCacheMaintenanceMode({
      dataRoot: maintenanceDataRoot,
      workspaceRoot,
      databasePath: maintenanceDatabasePath,
      backupDirectory: smokeCapability
        ? path.join(maintenanceDataRoot, "backups")
        : paths.dataLayout().backupDirectory,
      showMessageBox: smokeCapability
        ? async () => ({ response: 0, checkboxChecked: true })
        : (options) => dialog.showMessageBox(options),
      assertBeforeMutation: smokeCapability
        ? () => revalidateProfileCacheMaintenanceSmokeCapability(smokeCapability)
        : undefined,
      isLocalApiStarted: () => Boolean(runtimeInfo?.localApi),
      isBridgeStarted: () => Boolean(runtimeInfo?.purchaseBridge),
    });
    if (result.continueStartup !== false || result.restartRequired !== true) {
      throw new Error("PROFILE_CACHE_MAINTENANCE_RESULT_CONTRACT_INVALID");
    }
    if (smokeCapability) {
      writeProfileCacheMaintenanceSmokeResult(smokeCapability, result);
      app.exit(result.ok && result.completed ? 0 : 1);
      return;
    }
    const completed = result.ok && result.completed;
    const cancelled = result.ok && result.cancelled;
    await dialog.showMessageBox({
      type: completed ? "info" : cancelled ? "info" : "error",
      title: completed
        ? "普通清缓存已完成"
        : cancelled
          ? "普通清缓存已取消"
          : "普通清缓存未完成",
      message: completed
        ? "只清除了登记的瞬时缓存，受保护数据回读一致。"
        : cancelled
          ? "没有修改任何数据。"
          : "维护模式执行失败，本次启动没有继续运行服务。",
      detail: completed
        ? `保护副本和报告：${result.reportPath || "已写入 profile 备份目录"}`
        : cancelled
          ? "应用将正常重启。"
          : [
              result.error?.message || "未知维护错误",
              result.rollbackVerified ? "已验证自动回滚。" : "",
              result.reportPath ? `报告：${result.reportPath}` : "",
            ].filter(Boolean).join("\n"),
      buttons: ["正常重启应用"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    scheduleProfileCacheMaintenanceRelaunch({
      app,
      argv: process.argv,
      maintenance: false,
      quitDelayMs: 50,
    });
    return;
  }

  const frontendDist = paths.frontendDistDirectory();
  if (!fs.existsSync(path.join(frontendDist, "index.html"))) {
    throw new Error(`前端构建文件不存在：${frontendDist}`);
  }

  showStartupSplash();
  if (sealedLicenseConfig.mode !== "off") {
    const licenseServerState = await ensureDevelopmentLicenseServer({
      serverUrl: sealedLicenseConfig.serverUrl,
      workspaceRoot,
      isPackaged: app.isPackaged,
      isAutomationTest: IS_AUTOMATION_TEST,
    });
    supervisor.appendLog(
      "desktop-main",
      `[license-server] ${JSON.stringify(licenseServerState)}\n`,
    );
  }
  const profile = paths.ensureProfile();
  profileLock = paths.acquireCurrentProfileLock(profile);
  try {
    runtimeInfo = await services.startAll();
  } catch (error) {
    profileLock.release();
    profileLock = null;
    throw error;
  }
  const uiBoot = uiUpdateRuntime.prepareBoot({ recoveryMode: runtimeInfo.localApi?.recoveryMode === true });
  await configureRuntimeBindings(uiBoot.directory);
  const mainWindow = await windows.create(runtimeInfo);
  uiUpdateRuntime.bindWindow(mainWindow);
  closeStartupSplash();
  mainWindow.focus();
  purchaseBrowserController?.attachHost(mainWindow);
  void startPurchaseBrowserAccountPrewarm();
  ensureDesktopTray();
  runtimeLifecycle.bindWindow(mainWindow);
  installPowerLifecycle();
}

async function requestAccountRemovalRestart() {
  if (accountRemovalRestartScheduled) return { ok: true, scheduled: true };
  accountRemovalRestartScheduled = true;
  app.relaunch();
  setTimeout(() => app.quit(), 100);
  return { ok: true, scheduled: true };
}

async function requestProfileCacheMaintenanceRestart() {
  if (IS_PROFILE_CACHE_MAINTENANCE) {
    return {
      ok: false,
      code: "PROFILE_CACHE_MAINTENANCE_ALREADY_ACTIVE",
      error: "普通清缓存维护模式已经启动。",
    };
  }
  if (profileCacheMaintenanceRestartScheduled) {
    return { ok: true, scheduled: true, alreadyScheduled: true };
  }
  try {
    const scheduled = scheduleProfileCacheMaintenanceRelaunch({
      app,
      argv: process.argv,
      maintenance: true,
    });
    profileCacheMaintenanceRestartScheduled = true;
    return scheduled;
  } catch (error) {
    profileCacheMaintenanceRestartScheduled = false;
    throw error;
  }
}

async function createPurchaseBrowserRuntime() {
  disposePurchaseBrowserRuntime();
  // Do not start filesystem maintenance while the retired host or its cache
  // worker still owns files in this profile.
  await purchaseBrowserRetirements.wait();
  const dataRoot = paths.desktopDataRoot();
  const browserRoot = paths.ensureDirectory(path.join(dataRoot, 'purchase-browser'));
  const pendingPublishedCefHost = path.join(
    desktopRoot,
    'native',
    'Wangzai.CefBrowserHost',
    'publish-pending',
    'Wangzai.CefBrowserHost.exe',
  );
  const pendingPublishedCefReady = path.join(
    desktopRoot,
    'native',
    'Wangzai.CefBrowserHost',
    'publish-pending',
    'READY.json',
  );
  let pendingPublishedCefVerified = false;
  try {
    const marker = JSON.parse(fs.readFileSync(pendingPublishedCefReady, 'utf8'));
    pendingPublishedCefVerified = marker?.smoke === 'passed'
      && /^[A-F0-9]{64}$/u.test(String(marker?.executableSha256 || '').trim().toUpperCase())
      && createHash('sha256').update(fs.readFileSync(pendingPublishedCefHost)).digest('hex').toUpperCase()
        === String(marker.executableSha256).trim().toUpperCase();
  } catch {
    pendingPublishedCefVerified = false;
  }
  const developmentPublishedCefHost = path.join(
    desktopRoot,
    'native',
    'Wangzai.CefBrowserHost',
    'publish',
    'Wangzai.CefBrowserHost.exe',
  );
  const cefHostExecutable = app.isPackaged
    ? path.join(path.dirname(process.resourcesPath), 'cef-browser-host', 'Wangzai.CefBrowserHost.exe')
    : pendingPublishedCefVerified && fs.existsSync(pendingPublishedCefHost)
      ? pendingPublishedCefHost
      : fs.existsSync(developmentPublishedCefHost)
      ? developmentPublishedCefHost
      : path.join(
          desktopRoot,
          'native',
          'Wangzai.CefBrowserHost',
          'bin',
          'Release',
          'net8.0-windows',
          'win-x64',
          'Wangzai.CefBrowserHost.exe',
        );
  const cefRootCachePath = path.join(browserRoot, 'cef-cache-root');
  // CEF requires every RequestContext CachePath to be inside RootCachePath;
  // keeping profiles as a sibling silently downgraded cookies to memory.
  // Chrome runtime accepts account CachePath values as direct children of
  // RootCachePath. A nested profiles/<owner> directory is rejected.
  const cefProfileRoot = cefRootCachePath;
  const browserExtensionsResourceRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'browser-extensions')
    : path.join(desktopRoot, 'resources', 'browser-extensions');
  const ozonAnalyticsObserverExtension = path.join(
    browserExtensionsResourceRoot,
    'ozon-analytics-observer',
  );
  const builtInExtensionDirectories = fs.existsSync(
    path.join(ozonAnalyticsObserverExtension, 'manifest.json'),
  ) ? [ozonAnalyticsObserverExtension] : [];
  const fixtureOrigins = String(process.env.WANGZAI_PURCHASE_BROWSER_FIXTURE_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const profileStore = createPurchaseBrowserProfileStore({
    filePath: path.join(browserRoot, 'profiles.enc.json'),
    protector: createSafeStorageProtector(safeStorage),
    // Never leak Electron/<version> into a purchase-platform account.
    baseUserAgent: CEF_BASE_USER_AGENT,
  });
  purchasePaymentCredentialStore = createPurchasePaymentCredentialStore({
    filePath: path.join(browserRoot, 'payment-credentials.enc.json'),
    protector: createSafeStorageProtector(safeStorage),
  });
  const cefRuntime = createCefBrowserRuntime({
    executable: cefHostExecutable,
    rootCachePath: cefRootCachePath,
    extensionsRoot: path.join(browserRoot, 'extensions'),
    builtInExtensionDirectories,
    cacheMaintenance: {
      run: ({ signal }) => pruneCefTransientCacheInWorker({
        rootCachePath: cefRootCachePath,
        automatic: true,
        cacheHardLimitBytes: 2 * 1024 * 1024 * 1024,
        cacheTargetBytes: 1280 * 1024 * 1024,
        workerTimeoutMs: 5000,
      }, { signal }),
      onResult: result => supervisor.appendLog('desktop-main',
        `[purchase-browser-cache] status=${result?.ok ? 'checked' : result?.cancelled ? 'deferred-open' : 'deferred'} cacheBytes=${result?.cacheAfterBytes ?? 'unknown'} removed=${result?.removed ?? 'unknown'} targetReached=${result?.targetReached ?? 'unknown'}\n`),
    },
    appendLog: supervisor.appendLog,
    onHostAction: (details) => purchaseBrowserToolbarActions.handle({
      action: details?.action,
      payload: details?.payload || {},
    }),
  });
  purchaseBrowserNativeRuntime = cefRuntime;
  purchaseBrowserCacheMaintenancePromise = cefRuntime.runCacheMaintenance({ force: true, reason: 'startup' });
  // The visible browser is a native CEF window. Electron remains the app
  // shell and IPC endpoint; it no longer paints or hosts a browser surface.
  purchaseBrowserHostController = createPurchaseBrowserCefWindowController({
    screen,
    getParentWindow: () => windows.getWindow(),
    appendLog: supervisor.appendLog,
    onBoundsChanged: (bounds) => (
      purchaseBrowserController?.dispatch?.({ command: 'bounds', bounds })
    ),
  });
  const localApiClient = createPurchaseBrowserLocalApiClient({
    baseUrl: runtimeInfo.localApi.baseUrl,
    authToken: runtimeInfo.localApi.authToken,
    purchaseBrowserToken: runtimeInfo.localApi.purchaseBrowserToken,
    // The persisted profile metadata predates request-scoped ownership and
    // does not carry appId.  Use the same sealed app identity passed to
    // local-api so multi-user charge previews and shop ownership resolve to
    // one canonical tenant instead of falling back to tenant_local_default.
    tenantId: APP_ID,
    userId: runtimeInfo.localApi.profile?.profileId || '',
  });
  purchaseBrowserLocalApiClient = localApiClient;
  alipayPaymentWindowController = createAlipayPaymentWindowController({
    BrowserWindow,
    ipcMain,
    session,
    screen,
    preloadPath: path.join(__dirname, 'purchaseBrowser', 'alipayPaymentPreload.cjs'),
    getParentWindow: () => windows.getWindow(),
    getUserScope: () => runtimeInfo.localApi.profile?.profileId || APP_ID,
    appendLog: supervisor.appendLog,
    onEvent: (payload) => purchaseBrowserController?.publishAlipayPaymentEvent?.(payload),
    onPaymentCandidate: ({ sourceTabId }) => {
      if (!purchaseBrowserController?.dispatch) {
        return Promise.resolve({ paymentVerified: false, readbackVerified: false });
      }
      return purchaseBrowserController.dispatch({
        command: 'verify-alipay-payment',
        tabId: sourceTabId,
      });
    },
  });
  purchaseBrowserExternalLinkRouter = createPurchaseBrowserExternalLinkRouter({
    listAccounts: () => purchaseBrowserLocalApiClient?.listAccounts?.() || Promise.resolve({ accounts: [] }),
    listIntegrationProfiles: () => purchaseBrowserLocalApiClient?.listIntegrationProfiles?.()
      || Promise.resolve({ profiles: [] }),
    getActiveAccountId: activePurchaseBrowserAccountId,
    openInternalUrl: openPurchaseBrowserUrl,
    appendLog: supervisor.appendLog,
  });
  const controller = createCefPurchaseBrowserController({
    cefRuntime,
    profileStore,
    // 保留内置能力的审计和账号删除清理；用户插件由原生 CEF 插件管理器负责。
    addonManager: createPurchaseBrowserBuiltinManager({
      cacheRoot: path.join(browserRoot, 'cef-builtin-state'),
    }),
    policy: createPurchaseBrowserPolicy({ fixtureOrigins, allowHttpNavigation: true }),
    localApiClient,
    dataRoot,
    profileRoot: cefProfileRoot,
    downloadsRoot: path.join(browserRoot, 'downloads'),
    appendLog: supervisor.appendLog,
    onStateChanged: (state) => purchaseBrowserHostController?.setBrowserState?.(state),
    requestRestartForAccountRemoval: requestAccountRemovalRestart,
    alipayPaymentWindowController,
    getPaymentCredential: ({ accountRef }) => purchasePaymentCredentialStore?.get(accountRef),
    savePaymentCredential: (input) => purchasePaymentCredentialStore?.save(input),
    clearPaymentCredential: ({ accountRef }) => purchasePaymentCredentialStore?.clear(accountRef),
    getPaymentCredentialStatus: ({ accountRef }) => purchasePaymentCredentialStore?.status(accountRef),
    getAlipayLoginCredential: () => purchasePaymentCredentialStore?.getAlipayLogin(),
    saveAlipayLoginCredential: (input) => purchasePaymentCredentialStore?.saveAlipayLogin(input),
    clearAlipayLoginCredential: () => purchasePaymentCredentialStore?.clearAlipayLogin(),
    getAlipayLoginCredentialStatus: () => purchasePaymentCredentialStore?.alipayLoginStatus(),
  });
  purchaseBrowserController = controller;
  purchaseBrowserAccountPrewarmer = createPurchaseBrowserAccountPrewarmer({
    localApiClient,
    getController: () => (purchaseBrowserController === controller ? controller : null),
    appendLog: supervisor.appendLog,
  });
  await purchaseBrowserController.recoverPendingPurges().catch((error) => {
    supervisor.appendLog(
      'desktop-main',
      `[purchase-browser] pending account removal recovery failed: ${error?.code || error?.message || 'unknown'}\n`,
    );
  });
}

async function configureRuntimeBindings(frontendDist = uiUpdateRuntime.currentDirectory()) {
  registerAppProtocol({
    protocol,
    appHost: APP_HOST,
    frontendDist,
    readVerifiedStatic: requestUrl => uiUpdateRuntime.readStatic(requestUrl),
    localDataRoot: paths.localDataRoot(),
    purchaseBridge: runtimeInfo.purchaseBridge,
    localApi: runtimeInfo.localApi,
    // The renderer may name its current owner only as an optimistic hint.
    // The protocol resolves the persisted collection owner from the sealed
    // desktop license session so a caller cannot read or overwrite another
    // software user's shared (not shop-bound) collection box.
    getCollectionPricingOwnerSession: () => desktopLicenseRuntime?.getSession?.() || null,
    legacyRetirementFault: LEGACY_RETIREMENT_FAULT,
  });
  desktopLicenseRuntime?.recoveryAutoBackupScheduler?.stop?.();
  await createPurchaseBrowserRuntime();
  const existingWindow = windows.getWindow();
  if (existingWindow) {
    purchaseBrowserController?.attachHost(existingWindow);
    void startPurchaseBrowserAccountPrewarm();
  }
  desktopLicenseRuntime = registerDesktopIpcHandlers({
    app,
    ipcMain,
    safeStorage,
    desktopRoot,
    resourcesPath: process.resourcesPath,
    paths,
    runtimeInfo,
    existingLicenseRuntime: desktopLicenseRuntime,
    buildIdentity: Object.freeze({
      editionId: currentVersionIdentity.editionId,
      displayVersion: currentVersionIdentity.displayVersion,
      windowTitle: currentVersionIdentity.windowTitle,
      runtimeMode: app.isPackaged ? 'packaged' : 'source',
      sourceRoot: app.isPackaged ? '' : workspaceRoot,
      frontendBuildTime: (() => {
        try {
          return fs.statSync(path.join(frontendDist, 'index.html')).mtime.toISOString();
        } catch {
          return '';
        }
      })(),
    }),
    legacyRetirementFault: LEGACY_RETIREMENT_FAULT,
    recoveryTestRemote: ACCOUNT_REMOVAL_TEST_RECOVERY_REMOTE,
    purchaseBrowserController,
    purchaseBrowserHostController,
    purchaseBrowserExternalLinkRouter,
    purchaseBrowserLocalApiClient,
    purchaseBrowserToolbarActions,
    wechatAssistantRuntime,
    restorePurchaseBrowserWindow,
    setWindowMode: (mode, event) => {
      const window = windows.getWindow();
      if (!window || window.webContents !== event?.sender) {
        return { ok: false, error: "WINDOW_MODE_SENDER_REJECTED" };
      }
      return windows.setShellMode(mode);
    },
    activateRecovery: activateStagedRecovery,
    requestProfileCacheMaintenance: requestProfileCacheMaintenanceRestart,
    dataBackupDirectory: paths.dataLayout().backupDirectory,
    dataBackupStagingDirectory: path.join(paths.dataLayout().localApiDataRoot, 'data-backup-staging'),
    showDataBackupSaveDialog: (options) => dialog.showSaveDialog(windows.getWindow(), options),
    showDataBackupOpenDialog: (options) => dialog.showOpenDialog(windows.getWindow(), options),
    showDataBackupDirectoryDialog: (options) => dialog.showOpenDialog(windows.getWindow(), options),
  });
  registerUiUpdateIpc({ ipcMain, getWindow: () => windows.getWindow(), runtime: uiUpdateRuntime, appHost: APP_HOST });
}

async function activateStagedRecovery(descriptor) {
  let restarted = false;
  const wasRecoveryShell = runtimeInfo?.localApi?.recoveryMode === true;
  try {
    return await activateRecoveryDatabase({
      descriptor,
      activeDatabasePath: paths.localApiDatabasePath(),
      stopServices: async () => {
        desktopLicenseRuntime?.recoveryAutoBackupScheduler?.stop?.();
        disposePurchaseBrowserRuntime();
        await services.stopAll();
      },
      prepareActivatedServices: async () => {
        if (wasRecoveryShell) {
          paths.clearCurrentProfileDatabaseRecoveryRequired(
            runtimeInfo?.localApi?.profile,
          );
        }
      },
      prepareRollbackServices: async () => {
        if (wasRecoveryShell) {
          paths.markCurrentProfileDatabaseRecoveryRequired(
            runtimeInfo?.localApi?.profile,
          );
        }
      },
      startServices: async () => {
        const injectedFailure = LEGACY_RETIREMENT_FAULT
          ?.beforeRecoveryActivationStart?.();
        if (injectedFailure) throw new Error(injectedFailure);
        runtimeInfo = await services.startAll();
        restarted = true;
      },
    });
  } finally {
    if (restarted) await configureRuntimeBindings();
  }
}

app.on("before-quit", (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  uiUpdateRuntime.dispose();
  closeStartupSplash();
  runtimeLifecycle.dispose();
  desktopTray?.destroy?.();
  desktopTray = null;
  purchaseBrowserHostController?.hide?.();
  let browserShutdownTimer;
  const browserShutdownDeadline = new Promise((resolve) => {
    browserShutdownTimer = setTimeout(resolve, 3000);
  });
  const browserShutdown = Promise.race([
    Promise.resolve(closePurchaseBrowserWindow({ force: false })).catch((error) => {
      supervisor.appendLog('desktop-main', `[purchase-browser] shutdown failed ${error?.stack || error}\n`);
    }),
    browserShutdownDeadline,
  ]).finally(() => clearTimeout(browserShutdownTimer));
  shutdownPromise ||= Promise.all([
    browserShutdown,
    wechatAssistantRuntime.stop().catch((error) => supervisor.appendLog("desktop-main", `[wechat-assistant] shutdown failed ${error?.stack || error}\n`)),
    services.stopAll().catch((error) => supervisor.appendLog("desktop-main", `[shutdown] ${error?.stack || error}\n`)),
  ]).finally(() => {
      disposePurchaseBrowserRuntime();
      desktopLicenseRuntime?.recoveryAutoBackupScheduler?.stop?.();
      profileLock?.release();
      profileLock = null;
      app.quit();
    });
});

app.on("window-all-closed", () => {
  if (runtimeLifecycle.shouldKeepAliveWithoutWindows()) return;
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", async () => {
  await runtimeLifecycle.restoreWindow();
  reconcilePurchaseBrowserWindowState();
});

if (!IS_AUTOMATION_TEST) {
  app.on("second-instance", restoreStartupSurface);
}

if (hasSingleInstanceLock) {
  app
    .whenReady()
    .then(bootstrapDesktop)
    .catch((error) => {
      closeStartupSplash();
      const details = error?.stack || error?.message || String(error);
      supervisor.appendLog(
        "desktop-main",
        `[bootstrap-failed] ${details}\n`,
      );
      if (IS_AUTOMATION_TEST) {
        process.exitCode = 1;
        app.quit();
        return;
      }
      dialog.showErrorBox(
        "旺崽助手启动失败",
        `${error?.message || error}\n\n日志：${paths.logDirectory()}`,
      );
      app.quit();
    });
}

process.on("uncaughtException", (error) => {
  supervisor.appendLog(
    "desktop-main",
    `[uncaughtException] ${error?.stack || error?.message || String(error)}\n`,
  );
  if (IS_AUTOMATION_TEST) {
    process.exitCode = 1;
    app.quit();
  }
  if (!isQuitting) {
    // 保留主进程，渲染进程仍有独立错误边界和日志。
  }
});

process.on("unhandledRejection", (error) => {
  supervisor.appendLog(
    "desktop-main",
    `[unhandledRejection] ${error?.stack || error?.message || String(error)}\n`,
  );
  if (IS_AUTOMATION_TEST) {
    process.exitCode = 1;
    app.quit();
  }
});



