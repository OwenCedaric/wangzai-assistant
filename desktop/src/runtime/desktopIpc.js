import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { registerLicenseIpcHandlers } from "../licensing/licenseRuntime.js";
import { createRecoveryAutoBackupScheduler } from "../licensing/recoveryAutoBackupScheduler.js";
import { createLocalApiProxy } from "./localApiProxy.js";
import { createProductImageModelSourceStager } from "./productImageModelSourceStager.js";
import { createWechatAssistantModelExecutor } from "./wechatAssistantModelExecutor.js";
import { createWechatAssistantPointsReader } from "./wechatAssistantPoints.js";
import { createPurchaseBridgeProxy } from "./purchaseBridgeProxy.js";
import { createRecoveryIpcBridge } from "./recoveryIpcBridge.js";
import { createDataBackupIpcBridge } from "./dataBackupIpcBridge.js";
import { assertOzonSellerBrowserEntitled } from "../purchaseBrowser/ozonSellerLicenseGate.js";
import {
  saveVerifiedDataBackup,
  saveVerifiedDataBackupBatch,
} from "./dataBackupAtomicWriter.js";
import { removeStagedDataBackup, selectVerifiedDataBackup } from "./dataBackupAtomicReader.js";
import { createOzonPushEndpointRuntime } from './ozonPushEndpointRuntime.js';

const RECOVERY_REMOTE_COMMANDS = new Set([
  "backup-all-shops",
  "backup-shop",
  "list-generations",
  "purge-account-owner",
  "stage-restore",
]);

export function matchesEmbeddedWorkbenchOwner(owner, input = {}) {
  if (!owner) return false;
  if (String(input?.requestKey || '').trim() !== owner.requestKey) return false;
  const checks = [
    ['tabId', String(input?.tabId || '').trim()],
    ['sessionId', String(input?.sessionId || '').trim()],
    ['generation', Number(input?.generation) || 0],
  ];
  return checks.every(([field, value]) => !value || !owner[field] || value === owner[field]);
}

function smartReplyCacheScope(session = {}, profileId = "") {
  const identity = String(
    session?.user?.id
      || session?.user?.email
      || session?.user?.username
      || profileId
      || "anonymous",
  ).trim();
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

async function parseSmartReplyLocalResponse(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export async function syncSmartReplyShopFromLocalCache({ runtimeInfo, licenseRuntime, input = {} }) {
  const shopId = String(input?.shopId || "").trim();
  const expectedClientId = String(input?.clientId || "").trim();
  if (!shopId || !expectedClientId) {
    return { ok: false, status: 400, error: "请选择已绑定的 Ozon 店铺。" };
  }
  if (runtimeInfo.localApi.localCacheAgent !== true) {
    return {
      ok: false,
      status: 409,
      error: "当前桌面端没有启用本地安全凭证通道，无法同步已绑定店铺。",
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const session = await licenseRuntime.getSession();
    const response = await fetch(
      `${runtimeInfo.localApi.baseUrl}/v1/internal/shop-credentials/get`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-wangzai-cache-agent-token": runtimeInfo.localApi.authToken,
          "x-wangzai-cache-scope": smartReplyCacheScope(
            session,
            runtimeInfo.localApi.profile?.profileId,
          ),
        },
        body: JSON.stringify({ shopId }),
        signal: controller.signal,
      },
    );
    const local = await parseSmartReplyLocalResponse(response);
    const clientId = String(local?.credentials?.clientId || "").trim();
    const apiKey = String(local?.credentials?.apiKey || "").trim();
    if (!response.ok || !clientId || !apiKey) {
      return {
        ok: false,
        status: response.status || 502,
        error: String(local?.message || local?.error || "无法读取该店铺的已绑定授权。"),
      };
    }
    if (clientId !== expectedClientId) {
      return { ok: false, status: 409, error: "当前店铺授权已变化，请刷新店铺后重试。" };
    }
    // The API key stays in the main process: it is read from the encrypted
    // local cache agent and immediately posted to License Center. It is never
    // returned through Electron IPC to the renderer.
    return licenseRuntime.request({
      method: "POST",
      path: "/api/smart-reply/credentials",
      body: { client_id: clientId, api_key: apiKey },
    });
  } catch (error) {
    return {
      ok: false,
      status: error?.name === "AbortError" ? 504 : 502,
      error: error?.name === "AbortError"
        ? "读取本地店铺授权超时，请重试。"
        : "无法读取该店铺的已绑定授权。",
    };
  } finally {
    clearTimeout(timer);
  }
}

export function isBackgroundPurchaseBrowserCommand(input = {}, state = {}) {
  if (
    input?.background === true
    || input?.browserRole === 'market-collector'
    || input?.browserRole === 'follow-seller-collector'
    || input?.browserRole === 'product-link-parser'
    || input?.restoreVisible === false
  ) return true;
  if (String(input?.command || '') !== 'activate') return false;
  const tabs = Array.isArray(state?.tabs) ? state.tabs : [];
  return tabs.some((tab) => (
    String(tab?.tabId || '') === String(input?.tabId || '')
    && (
      tab?.background === true
      || tab?.browserRole === 'market-collector'
      || tab?.browserRole === 'follow-seller-collector'
    )
  ));
}

export function isRendererRecoveryCommandRequest(input = {}) {
  if (String(input?.method || "GET").toUpperCase() !== "POST") return false;
  try {
    return new URL(String(input?.path || ""), "http://wangzai.local").pathname
      === "/api/app/recovery/command";
  } catch {
    return false;
  }
}

export function requiresPurchaseBrowserBusinessEntitlement(command) {
  // Cleanup is authorized by the backend's operationId/resource capability,
  // not by whichever unrelated Seller tab happens to be active in the UI.
  return !['hide', 'close', 'force-close', 'bounds', 'embed-bounds', 'embed-hide', 'purge-operation']
    .includes(String(command || ''));
}

export function createProfileCacheMaintenanceIpcHandler({
  isRecoveryMode = () => false,
  hasPendingAccountRemoval,
  requestProfileCacheMaintenance,
}) {
  if (
    typeof hasPendingAccountRemoval !== "function" ||
    typeof requestProfileCacheMaintenance !== "function"
  ) {
    throw new Error("PROFILE_CACHE_MAINTENANCE_IPC_DEPENDENCY_REQUIRED");
  }
  return async function handleProfileCacheMaintenance() {
    try {
      if (isRecoveryMode()) {
        return {
          ok: false,
          code: "PROFILE_DATABASE_RECOVERY_REQUIRED",
          error: "当前 profile 正在恢复模式，不能执行普通清缓存。",
        };
      }
      if (await hasPendingAccountRemoval()) {
        return {
          ok: false,
          code: "ACCOUNT_REMOVAL_PENDING",
          error: "存在尚未完成的账号永久删除，不能切换到普通清缓存维护模式。",
        };
      }
      return await requestProfileCacheMaintenance();
    } catch (error) {
      return {
        ok: false,
        code: String(error?.code || error?.message || "PROFILE_CACHE_MAINTENANCE_RESTART_FAILED"),
        error: String(error?.message || error || "无法启动普通清缓存维护模式。"),
      };
    }
  };
}

export function registerDesktopIpcHandlers({
  app,
  ipcMain,
  safeStorage,
  desktopRoot,
  resourcesPath,
  paths,
  runtimeInfo,
  existingLicenseRuntime = null,
  buildIdentity = null,
  legacyRetirementFault = null,
  recoveryTestRemote = null,
  purchaseBrowserController = null,
  purchaseBrowserHostController = null,
  purchaseBrowserExternalLinkRouter = null,
  purchaseBrowserLocalApiClient = null,
  purchaseBrowserToolbarActions = null,
  wechatAssistantRuntime = null,
  restorePurchaseBrowserWindow = async () => null,
  activateRecovery = async () => {
    throw new Error("灾难恢复切换不可用。");
  },
  requestProfileCacheMaintenance = async () => {
    throw new Error("PROFILE_CACHE_MAINTENANCE_RESTART_UNAVAILABLE");
  },
  setWindowMode = async () => ({ ok: false, error: "WINDOW_MODE_UNAVAILABLE" }),
  showDataBackupSaveDialog = async () => ({ canceled: true }),
  showDataBackupOpenDialog = async () => ({ canceled: true, filePaths: [] }),
  showDataBackupDirectoryDialog = async () => ({ canceled: true, filePaths: [] }),
  dataBackupDirectory,
  dataBackupStagingDirectory,
}) {
  ipcMain.removeHandler("desktop:get-app-info");
  ipcMain.handle("desktop:get-app-info", () => ({
    appName: app.getName(),
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    userData: app.getPath("userData"),
    localDataRoot: paths.localDataRoot(),
    frontendDist: paths.frontendDistDirectory(),
    localApiBaseUrl: runtimeInfo.localApi.baseUrl,
    purchaseBridgeBaseUrl: runtimeInfo.purchaseBridge.baseUrl,
    profile: runtimeInfo.localApi.profile,
    recoveryMode: runtimeInfo.localApi.recoveryMode === true,
    migrationPreview: runtimeInfo.localApi.migrationPreview,
    buildIdentity,
  }));
  ipcMain.removeHandler("desktop:reload-window");
  ipcMain.handle("desktop:reload-window", (event) => {
    event.sender.reload();
    return { ok: true };
  });
  ipcMain.removeHandler("desktop:set-window-mode");
  ipcMain.handle("desktop:set-window-mode", (event, mode) => setWindowMode(mode, event));
  ipcMain.removeHandler("desktop:wechat-assistant-command");
  ipcMain.handle("desktop:wechat-assistant-command", async (_event, input = {}) => {
    if (!wechatAssistantRuntime?.command) {
      return { ok: false, error: "微信助理运行环境尚未初始化。" };
    }
    try {
      return await wechatAssistantRuntime.command(input);
    } catch {
      return { ok: false, error: "微信助理操作未完成，请重试；如仍失败请查看运行日志。" };
    }
  });

  const licenseRuntime = registerLicenseIpcHandlers({
    ipcMain,
    existingRuntime: existingLicenseRuntime,
    app,
    safeStorage,
    desktopRoot,
    resourcesPath,
    onSessionSnapshot: (snapshot) => {
      const bridgeUpdate = runtimeInfo.purchaseBridge.updateLicenseState(snapshot);
      void Promise.resolve(wechatAssistantRuntime?.handleLicenseSession?.(snapshot)).catch(() => undefined);
      return bridgeUpdate;
    },
  });
  const readWechatAssistantPointsWallet = createWechatAssistantPointsReader({ licenseRuntime });
  const imageModelSourceStager = createProductImageModelSourceStager();
  ipcMain.removeHandler("license:sync-smart-reply-shop");
  ipcMain.handle("license:sync-smart-reply-shop", (_event, input) => (
    syncSmartReplyShopFromLocalCache({ runtimeInfo, licenseRuntime, input })
  ));
  const requestLocalApi = createLocalApiProxy({
    baseUrl: runtimeInfo.localApi.baseUrl,
    authToken: runtimeInfo.localApi.authToken,
    recoveryMode: runtimeInfo.localApi.recoveryMode === true,
    remoteCore: runtimeInfo.localApi.remoteCore === true,
    localCacheAgent: runtimeInfo.localApi.localCacheAgent === true,
    coreServiceUrl: runtimeInfo.localApi.coreServiceUrl,
    cacheDirectory: runtimeInfo.localApi.cacheDirectory,
    profileId: runtimeInfo.localApi.profile?.profileId,
    licenseRuntime,
    stageImageModelSources: imageModelSourceStager.stage,
  });
  const localApiRequest = async (input) => {
    const method = String(input?.method || "GET").toUpperCase();
    const rejected = legacyRetirementFault?.beforeRequest?.({
      surface: "local-api",
      method,
      path: input?.path,
    });
    if (rejected) return rejected;
    const result = await requestLocalApi(input);
    legacyRetirementFault?.recordResult?.({
      surface: "local-api",
      method,
      path: input?.path,
      result,
    });
    return result;
  };
  let ozonPushEndpointRuntime = null;
  try {
    if (runtimeInfo.localApi.secretPath) {
      ozonPushEndpointRuntime = createOzonPushEndpointRuntime({
        runtimeInfo,
        secretPath: runtimeInfo.localApi.secretPath,
        logger: (message) => console.warn(message),
      });
      void ozonPushEndpointRuntime.start().catch((error) => {
        console.warn(`[ozon-push] gateway startup failed: ${error?.message || error}`);
      });
    }
  } catch (error) {
    console.warn(`[ozon-push] runtime unavailable: ${error?.message || error}`);
  }
  ipcMain.removeHandler('desktop:ozon-push-endpoint-command');
  ipcMain.handle('desktop:ozon-push-endpoint-command', (_event, input = {}) => (
    ozonPushEndpointRuntime?.command(input) || {
      ok: false,
      code: 'OZON_PUSH_RUNTIME_NOT_CONFIGURED',
      error: '店铺通知运行环境尚未就绪，请重启旺崽助手。',
    }
  ));
  wechatAssistantRuntime?.configure?.({
    executeModelRequest: createWechatAssistantModelExecutor({
      runtimeInfo,
      licenseRuntime,
      getPointsWallet: readWechatAssistantPointsWallet,
    }),
    executeBusinessRequest: localApiRequest,
    getPointsWallet: readWechatAssistantPointsWallet,
  });
  ipcMain.removeHandler("desktop:local-api-request");
  ipcMain.handle("desktop:local-api-request", (_event, input) => {
    if (isRendererRecoveryCommandRequest(input)) {
      return {
        ok: false,
        status: 403,
        error: "恢复命令仅允许通过桌面端专用恢复桥调用。",
      };
    }
    return localApiRequest(input);
  });
  ipcMain.removeHandler("desktop:local-api-cancel");
  ipcMain.handle("desktop:local-api-cancel", (_event, requestId) => (
    requestLocalApi.cancel?.(requestId) || { ok: true, canceled: false }
  ));
  async function requestRecovery(input = {}, { authContext } = {}) {
    const command = String(input?.command || "").trim();
    // The normal path always resolves its remote from the authenticated desktop
    // session. An isolated legacy-retirement recovery fixture may provide a
    // loopback opaque remote from the main-process-only fault controller; its
    // token is never sent to the renderer or surfaced in recovery results.
    const testRemote = legacyRetirementFault?.getRecoveryTestRemote?.() || recoveryTestRemote || null;
    const remote = RECOVERY_REMOTE_COMMANDS.has(command)
      ? testRemote || await licenseRuntime.getRecoveryRemoteContext()
      : null;
    if (authContext && remote) authContext.accessToken = String(remote.accessToken || '');
    return localApiRequest({
      method: "POST",
      path: "/api/app/recovery/command",
      body: { ...input, ...(remote ? { remote } : {}) },
      timeoutMs: 120_000,
    });
  }
  ipcMain.removeHandler("desktop:recovery-request");
  const hasPendingAccountRemoval = async () => {
    const result = await localApiRequest({
      method: "GET",
      path: "/api/account-removal/pending",
      timeoutMs: 10_000,
    });
    if (!result?.ok || !Array.isArray(result?.data?.operations)) {
      throw new Error("ACCOUNT_REMOVAL_PENDING_STATUS_UNAVAILABLE");
    }
    return result.data.operations.length > 0;
  };
  const dataBackupIpcBridge = createDataBackupIpcBridge({
    requestRecovery,
    requestDataBackupImport: (input) => localApiRequest({
      method: "POST",
      path: "/api/app/data-backup-import",
      body: input,
      timeoutMs: 120_000,
    }),
    saveVerifiedDataBackup: (input) => saveVerifiedDataBackup({
      ...input,
      backupDirectory: dataBackupDirectory,
      stagingDirectory: dataBackupStagingDirectory,
      showSaveDialog: showDataBackupSaveDialog,
    }),
    saveVerifiedDataBackupBatch: (input) => saveVerifiedDataBackupBatch({
      ...input,
      backupDirectory: dataBackupDirectory,
      stagingDirectory: dataBackupStagingDirectory,
      showDirectoryDialog: showDataBackupDirectoryDialog,
    }),
    selectVerifiedDataBackup: () => selectVerifiedDataBackup({
      showOpenDialog: showDataBackupOpenDialog,
      stagingDirectory: dataBackupStagingDirectory,
    }),
    removeStagedDataBackup: (input) => removeStagedDataBackup({
      ...input,
      stagingDirectory: dataBackupStagingDirectory,
    }),
  });
  ipcMain.removeHandler("desktop:data-backup-command");
  ipcMain.handle("desktop:data-backup-command", async (_event, input = {}) => dataBackupIpcBridge(input));
  ipcMain.removeHandler("desktop:profile-cache-maintenance");
  ipcMain.handle(
    "desktop:profile-cache-maintenance",
    createProfileCacheMaintenanceIpcHandler({
      isRecoveryMode: () => runtimeInfo.localApi.recoveryMode === true,
      hasPendingAccountRemoval,
      requestProfileCacheMaintenance,
    }),
  );
  const recoveryIpcBridge = createRecoveryIpcBridge({
    requestRecovery,
    refreshRecoveryAuthorization: ({ rejectedAccessToken }) => licenseRuntime.getRecoveryRemoteContext({
      forceRefresh: true, rejectedAccessToken,
    }),
    activateRecovery,
    hasPendingAccountRemoval,
  });
  ipcMain.handle("desktop:recovery-request", async (_event, input = {}) => {
    return recoveryIpcBridge(input);
  });
  const recoveryAutoBackupScheduler = createRecoveryAutoBackupScheduler({
    runBackup: async () => {
      const status = await localApiRequest({
        method: "POST",
        path: "/api/app/recovery/command",
        body: { command: "status" },
      });
      if (!status.ok || !status.data?.enrolled) return { skipped: "not-enrolled" };
      const result = await requestRecovery({ command: "backup-all-shops" });
      if (!result.ok) throw new Error(result.error || "灾难备份失败。");
      return result.data;
    },
  });
  // The isolated recovery-retirement phase owns its exact generation sequence.
  // Do not race it with the normal startup scheduler after the fixture creates
  // its temporary keyset; every production and non-recovery test still starts
  // the scheduler unchanged.
  if (!legacyRetirementFault?.getRecoveryTestRemote?.() && !recoveryTestRemote) {
    recoveryAutoBackupScheduler.start();
  }
  const purchaseBridgeRequest = createPurchaseBridgeProxy({
    baseUrl: runtimeInfo.purchaseBridge.baseUrl,
    authToken: runtimeInfo.purchaseBridge.authToken,
    licenseRuntime,
  });
  ipcMain.removeHandler("desktop:purchase-bridge-request");
  ipcMain.handle("desktop:purchase-bridge-request", (_event, input) =>
    purchaseBridgeRequest(input),
  );
  function purchaseBrowserPresentation(input = {}) {
    let platform = String(input?.platformName || '').trim().slice(0, 40) || '采购平台';
    try {
      const host = new URL(String(input?.url || '')).hostname.toLowerCase();
      if (host.includes('1688.com')) platform = '1688 采购';
      else if (host.includes('taobao.com')) platform = '淘宝采购';
      else if (host.includes('tmall.com')) platform = '天猫采购';
      else if (host.includes('yangkeduo.com') || host.includes('pinduoduo.com')) platform = '拼多多采购';
      else if (host.includes('kuajing84.com')) platform = '跨境巴士';
      else if (host === 'seller.ozon.ru' || host.endsWith('.seller.ozon.ru')) platform = 'Ozon 卖家登录';
      else if (host === 'ozon.ru' || host.endsWith('.ozon.ru')) platform = 'Ozon 买家采购';
    } catch {
      platform = '采购平台';
    }
    return {
      title: platform,
      subtitle: String(input?.accountLabel || '').trim().slice(0, 120)
        ? `旺崽助手 · ${String(input.accountLabel).trim().slice(0, 120)}`
        : '旺崽助手 · 独立账号安全窗口',
      accountLabel: String(input?.accountLabel || '').trim().slice(0, 120),
      recoveryContext: {
        accountId: String(input?.accountId || '').trim().slice(0, 180),
        url: String(input?.url || '').trim().slice(0, 1800),
      },
      embedded: input?.workbench?.displayMode === 'embedded',
    };
  }

  let purchaseBrowserHostPresentationChain = Promise.resolve();
  let embeddedWorkbenchOwner = null;

  function embeddedOwnerMatches(input = {}) {
    return matchesEmbeddedWorkbenchOwner(embeddedWorkbenchOwner, input);
  }

  async function preparePurchaseBrowserHost({ phase = 'loading', input = {} } = {}) {
    if (!purchaseBrowserHostController) return null;
    const run = purchaseBrowserHostPresentationChain.catch(() => undefined).then(async () => {
      const presentation = purchaseBrowserPresentation(input);
      let popup;
      if (phase === 'ready') popup = await purchaseBrowserHostController.showReady(presentation);
      else if (phase === 'error') popup = await purchaseBrowserHostController.showError(presentation);
      else popup = await purchaseBrowserHostController.showLoading(presentation);
      await purchaseBrowserController.attachBrowserOwner?.(popup);
      return purchaseBrowserHostController.viewportBounds({ visible: phase === 'ready' });
    });
    purchaseBrowserHostPresentationChain = run.catch(() => undefined);
    return run;
  }

  ipcMain.removeHandler('desktop:purchase-browser-command');
  ipcMain.handle('desktop:purchase-browser-command', async (event, input = {}) => {
    const requestId = typeof input?.requestId === 'string' && input.requestId.trim()
      ? input.requestId.trim().slice(0, 120)
      : `desktop_purchase_${randomUUID()}`;
    const command = String(input?.command || '');
    // Payment login owns its independent Electron BrowserWindow and must not
    // enter the native CEF host presentation queue. Otherwise a background CEF
    // prewarm/bounds generation can supersede an unrelated Alipay login click.
    const opensVisiblePurchaseWindow = ['open', 'activate'].includes(command);
    let backgroundRequest = isBackgroundPurchaseBrowserCommand(input);
    try {
      if (!purchaseBrowserController?.acceptsSender?.(event.sender)) {
        throw new Error('PURCHASE_BROWSER_IPC_SENDER_REJECTED');
      }
      if (requiresPurchaseBrowserBusinessEntitlement(command)) {
        await assertOzonSellerBrowserEntitled({
          input,
          snapshot: purchaseBrowserController.snapshot?.() || {},
          localApiClient: purchaseBrowserLocalApiClient,
          licenseRuntime,
        });
      }
      if (command === 'restore-window') {
        const restored = await restorePurchaseBrowserWindow();
        const state = restored?.state?.tabs ? restored.state : restored?.tabs ? restored : purchaseBrowserController.snapshot?.() || {};
        return {
          ...(restored && typeof restored === 'object' ? restored : {}),
          requestId,
          command,
          sessionId: String(restored?.sessionId || state?.sessionId || ''),
          generation: Number(restored?.generation || state?.generation) || 0,
          phase: String(restored?.phase || state?.phase || 'idle'),
        };
      }
      if (command === 'embed-bounds' || command === 'embed-hide') {
        if (!purchaseBrowserHostController) {
          throw new Error('PURCHASE_BROWSER_HOST_WINDOW_REQUIRED');
        }
        if (!embeddedOwnerMatches(input)) {
          return {
            ...(purchaseBrowserController.snapshot?.() || {}),
            requestId,
            command,
            ignoredStaleWorkbench: true,
          };
        }
        const requested = input?.bounds || input;
        const hideEmbedded = command === 'embed-hide' || requested?.visible === false;
        if (hideEmbedded) {
          // Freeze the host viewport without publishing a normal-priority
          // bounds command, then issue one lifecycle hide. This preempts a
          // collector/probe and cannot be superseded by stale ResizeObserver
          // work queued before the card close.
          const frozenBounds = await purchaseBrowserHostController.clearEmbeddedViewport?.({ notify: false });
          const result = await purchaseBrowserController.dispatch({
            command: 'suspend-workbench',
            ...(frozenBounds ? { bounds: frozenBounds } : {}),
          });
          purchaseBrowserHostController.setBrowserState?.(result);
          embeddedWorkbenchOwner = null;
          return {
            ...(result && typeof result === 'object' ? result : {}),
            requestId,
            command,
            embeddedHidden: result?.visible === false,
          };
        }
        const result = await purchaseBrowserHostController.setEmbeddedViewport?.(requested);
        purchaseBrowserHostController.setBrowserState?.(result);
        return {
          ...(result && typeof result === 'object' ? result : {}),
          requestId,
          command,
        };
      }
      if (command === 'toolbar-action') {
        if (typeof purchaseBrowserToolbarActions?.handle !== 'function') {
          throw new Error('PURCHASE_BROWSER_TOOLBAR_UNAVAILABLE');
        }
        const result = await purchaseBrowserToolbarActions.handle({
          action: input?.action,
          payload: input?.payload,
          tabId: input?.tabId,
        });
        return {
          ...(result && typeof result === 'object' ? result : {}),
          requestId,
          command,
        };
      }
      if (command === 'open-external') {
        if (!purchaseBrowserExternalLinkRouter?.open) {
          throw new Error('PURCHASE_BROWSER_EXTERNAL_ROUTER_NOT_READY');
        }
        let embeddedBounds = null;
        if (input?.workbench?.displayMode === 'embedded') {
          const requestKey = String(input?.workbenchRequestKey || '').trim().slice(0, 160);
          if (!requestKey) throw new Error('PURCHASE_BROWSER_WORKBENCH_OWNER_REQUIRED');
          embeddedWorkbenchOwner = {
            requestKey,
            tabId: '',
            sessionId: '',
            generation: 0,
          };
          if (!input?.embeddedBounds || !purchaseBrowserHostController?.setEmbeddedViewport) {
            throw new Error('PURCHASE_BROWSER_BOUNDS_INVALID');
          }
          const primed = await purchaseBrowserHostController.setEmbeddedViewport(
            input.embeddedBounds,
            { notify: false },
          );
          embeddedBounds = primed && typeof primed === 'object'
            ? { ...primed, visible: true }
            : null;
          if (!embeddedBounds) throw new Error('PURCHASE_BROWSER_BOUNDS_INVALID');
        }
        const routed = await purchaseBrowserExternalLinkRouter.open(input?.url, {
          accountId: input?.accountId,
          shopId: input?.shopId,
          requireShopBinding: input?.requireShopBinding === true,
          platformName: input?.platformName,
          accountLabel: input?.accountLabel,
          browserRole: input?.browserRole,
          background: input?.background === true,
          restoreVisible: input?.restoreVisible,
          waitUntil: input?.waitUntil,
          workbench: input?.workbench,
          purchaseTarget: input?.purchaseTarget,
          embeddedBounds,
          standaloneSize: input?.standaloneSize,
        });
        if (embeddedBounds && embeddedWorkbenchOwner?.requestKey === String(input?.workbenchRequestKey || '').trim()) {
          const state = routed?.state?.tabs ? routed.state : routed;
          const tabs = Array.isArray(state?.tabs) ? state.tabs : [];
          const tab = tabs.find((candidate) => candidate?.tabId === state?.activeTabId) || null;
          embeddedWorkbenchOwner = {
            ...embeddedWorkbenchOwner,
            tabId: String(tab?.tabId || state?.activeTabId || ''),
            sessionId: String(tab?.sessionId || state?.sessionId || ''),
            generation: Number(tab?.generation || state?.generation) || 0,
          };
        }
        return {
          ...(routed && typeof routed === 'object' ? routed : {}),
          requestId,
          command,
        };
      }
      if (opensVisiblePurchaseWindow) {
        const currentState = purchaseBrowserController.snapshot?.() || {};
        backgroundRequest = isBackgroundPurchaseBrowserCommand(input, currentState);
        if (backgroundRequest) {
          return purchaseBrowserController.dispatch(input);
        }
        const visibleTab = Array.isArray(currentState.tabs)
          ? currentState.tabs.find((tab) => tab.tabId === currentState.activeTabId)
          : null;
        const keepVisible = currentState.visible === true && visibleTab && visibleTab.crashed !== true;
        if (!keepVisible) {
          const hiddenBounds = await preparePurchaseBrowserHost({ phase: 'loading', input });
          if (hiddenBounds) await purchaseBrowserController.dispatch({ command: 'bounds', bounds: hiddenBounds });
        }
        const result = await purchaseBrowserController.dispatch(input);
        purchaseBrowserHostController?.setBrowserState?.(result);
        if (keepVisible) return result;
        const visibleBounds = await preparePurchaseBrowserHost({ phase: 'ready', input });
        if (!visibleBounds) return result;
        const visibleResult = await purchaseBrowserController.dispatch({ command: 'bounds', bounds: visibleBounds });
        purchaseBrowserHostController?.setBrowserState?.(visibleResult);
        return visibleResult;
      }
      if (command === 'bounds') {
        const requested = input?.bounds || input;
        if (requested?.visible === true) {
          const bounds = await preparePurchaseBrowserHost({ phase: 'ready', input });
          const result = await purchaseBrowserController.dispatch({
            command: 'bounds',
            bounds: bounds || requested,
          });
          purchaseBrowserHostController?.setBrowserState?.(result);
          return result;
        }
        const result = await purchaseBrowserController.dispatch(input);
        // `bounds.visible=false` is also emitted by the card window while it is
        // minimized.  Hiding the host here removes its taskbar button and makes
        // it impossible to restore from the taskbar.  Only an explicit `hide`
        // command (or a caller that opts in with hideHost) may hide the host;
        // the native CEF child is still hidden by the controller above.
        if (requested?.hideHost === true) purchaseBrowserHostController?.hide?.();
        return result;
      }
      if (command === 'hide') {
        const result = await purchaseBrowserController.dispatch(input);
        purchaseBrowserHostController?.hide?.();
        return result;
      }
      if (command === 'close') {
        // Hide first, then wait for the owned native sessions to be fenced.
        // Returning the final empty snapshot prevents an immediate reopen from
        // racing the previous CEF process shutdown. Cookies remain on disk.
        purchaseBrowserHostController?.hide?.();
        embeddedWorkbenchOwner = null;
        const closeOperation = typeof purchaseBrowserController.closeInteractiveTabs === 'function'
          ? purchaseBrowserController.closeInteractiveTabs()
          : typeof purchaseBrowserController.forceCloseAll === 'function'
            ? purchaseBrowserController.forceCloseAll()
          : typeof purchaseBrowserController.shutdown === 'function'
            ? purchaseBrowserController.shutdown({ timeoutMs: 750 })
            : undefined;
        const state = await Promise.resolve(closeOperation)
          .catch(() => purchaseBrowserController.snapshot?.() || {});
        return {
          ...state,
          requestId,
          command,
          sessionId: String(state.sessionId || ''),
          generation: Number(state.generation) || 0,
          phase: Array.isArray(state.tabs) && state.tabs.length > 0 ? 'hidden' : 'idle',
          closing: false,
        };
      }
      if (command === 'force-close') {
        // Explicit recovery/account cleanup remains available for a single
        // tab; ordinary close uses the bounded all-session sweep above.
        purchaseBrowserHostController?.hide?.();
        return purchaseBrowserController.dispatch(input);
      }
      return purchaseBrowserController.dispatch(input);
    } catch (error) {
      const state = purchaseBrowserController?.snapshot?.() || {};
      if (
        command === 'open-external'
        && embeddedWorkbenchOwner?.requestKey === String(input?.workbenchRequestKey || '').trim()
      ) {
        embeddedWorkbenchOwner = null;
        await purchaseBrowserHostController?.clearEmbeddedViewport?.({ notify: false }).catch(() => undefined);
      }
      if (error && typeof error === 'object') {
        error.requestId ||= requestId;
        error.command ||= command;
        error.sessionId ||= String(state.sessionId || '');
        error.generation ||= Number(state.generation) || 0;
        error.phase ||= 'error';
      }
      if (!backgroundRequest && (opensVisiblePurchaseWindow || command === 'open-external')) {
        await Promise.resolve(purchaseBrowserController?.dispatch?.({ command: 'hide' })).catch(() => undefined);
        const hostWindow = purchaseBrowserHostController?.getWindow?.();
        if (!hostWindow || hostWindow.isVisible?.() !== false) {
          await preparePurchaseBrowserHost({ phase: 'error', input }).catch(() => undefined);
        }
      }
      throw error;
    }
  });
  licenseRuntime.getSession().catch(() => undefined);

  licenseRuntime.recoveryAutoBackupScheduler = recoveryAutoBackupScheduler;
  return licenseRuntime;
}

