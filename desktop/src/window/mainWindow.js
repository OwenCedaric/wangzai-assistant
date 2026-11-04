import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, Menu, ipcMain, screen } from "electron";
import { collectPurchaseOrderInteractions } from './performancePurchaseInteractions.js';
import {
  AUTH_WINDOW_HEIGHT,
  AUTH_WINDOW_MIN_HEIGHT,
  AUTH_WINDOW_MIN_WIDTH,
  AUTH_WINDOW_WIDTH,
  getAuthenticationWindowOptions,
  getInitialWindowOptions,
} from "./mainWindowOptions.js";
import {
  getRendererTraceCategories,
  readRendererTraceStream,
  summarizeRendererTrace,
} from "./rendererTraceSummary.js";

function isLoopbackHostname(hostname = "") {
  const normalized = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "127.0.0.1"
  );
}

function installDashboardVisualNetworkGuard(webContents, appendLog) {
  const guardedSession = webContents.session;
  guardedSession.webRequest.onBeforeRequest(
    {
      urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"],
    },
    (details, callback) => {
      try {
        const target = new URL(details.url);
        if (isLoopbackHostname(target.hostname)) {
          callback({});
          return;
        }
        appendLog(
          "desktop-main",
          `[dashboard-visual-network] blocked ${JSON.stringify({
            url: details.url,
            resourceType: details.resourceType,
          })}\n`,
        );
        callback({ cancel: true });
      } catch (error) {
        appendLog(
          "desktop-main",
          `[dashboard-visual-network] blocked-invalid-url ${JSON.stringify({
            url: details.url,
            message: error?.message || String(error),
          })}\n`,
        );
        callback({ cancel: true });
      }
    },
  );
  appendLog(
    "desktop-main",
    `[dashboard-visual-network] guard-installed ${JSON.stringify({
      protocols: ["http", "https", "ws", "wss"],
      allowedHosts: ["localhost", "127.0.0.1", "::1"],
    })}\n`,
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPerformanceTraceFilePath() {
  if (process.env.WANGZAI_PERFORMANCE_TRACE !== "1") return null;
  const dataRoot = String(process.env.WANGZAI_DESKTOP_DATA_DIR || "").trim();
  const requestedPath = String(process.env.WANGZAI_PERFORMANCE_TRACE_FILE || "").trim();
  if (!dataRoot || !requestedPath) return null;

  const resolvedDataRoot = path.resolve(dataRoot);
  const resolvedTracePath = path.resolve(requestedPath);
  return resolvedTracePath.startsWith(`${resolvedDataRoot}${path.sep}`) ? resolvedTracePath : null;
}

function waitForRendererTraceStream(debuggerSession, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      debuggerSession.removeListener("message", onMessage);
      clearTimeout(timer);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onMessage = (_event, method, params) => {
      if (method !== "Tracing.tracingComplete") return;
      const stream = String(params?.stream || "").trim();
      if (!stream) {
        settle(reject, new Error("PERFORMANCE_TRACE_STREAM_MISSING"));
        return;
      }
      settle(resolve, stream);
    };
    const timer = setTimeout(
      () => settle(reject, new Error("PERFORMANCE_TRACE_COMPLETE_TIMEOUT")),
      timeoutMs,
    );
    debuggerSession.on("message", onMessage);
  });
}

async function collectRendererPerformanceTrace(webContents, collectPerformance) {
  const traceFilePath = getPerformanceTraceFilePath();
  if (!traceFilePath) return collectPerformance();

  const debuggerSession = webContents.debugger;
  if (debuggerSession.isAttached()) {
    throw new Error("PERFORMANCE_TRACE_DEBUGGER_ALREADY_ATTACHED");
  }

  debuggerSession.attach("1.3");
  let traceError = null;
  let performanceResult = null;
  let performanceError = null;
  try {
    await debuggerSession.sendCommand("Tracing.start", {
      categories: getRendererTraceCategories(),
      transferMode: "ReturnAsStream",
    });
    try {
      performanceResult = await collectPerformance();
    } catch (error) {
      performanceError = error;
    }

    try {
      const traceStream = waitForRendererTraceStream(debuggerSession);
      await debuggerSession.sendCommand("Tracing.end");
      const tracePayload = await readRendererTraceStream(debuggerSession, await traceStream);
      await fs.mkdir(path.dirname(traceFilePath), { recursive: true });
      await fs.writeFile(traceFilePath, tracePayload, "utf8");
      performanceResult = {
        ...performanceResult,
        rendererTrace: {
          fileName: path.basename(traceFilePath),
          bytes: Buffer.byteLength(tracePayload),
          ...summarizeRendererTrace(tracePayload),
        },
      };
    } catch (error) {
      traceError = error;
    }
  } finally {
    if (debuggerSession.isAttached()) debuggerSession.detach();
  }

  if (performanceError) throw performanceError;
  if (traceError) throw traceError;
  return performanceResult;
}

async function waitForRendererSmokeReady(webContents, timeoutMs = 12_000) {
  const rendererTimeoutMs = Math.max(1_000, Number(timeoutMs) || 12_000);
  const inspectScript = `(() => {
        const shell = document.querySelector('.content-shell');
        const root = document.querySelector('#root');
        const recoverySurface = document.querySelector('[data-recovery-startup-ready="true"]');
        const authenticationSurface = document.querySelector('.desktop-access-shell');
        const drawer = document.querySelector('.drawer-paper');
        const mainShell = document.querySelector('.main-shell.sidebar-open');
        const workspaceSurface = document.querySelector('.workspace-scale-surface');
        const drawerRect = drawer?.getBoundingClientRect();
        const mainRect = mainShell?.getBoundingClientRect();
        const workspaceRect = workspaceSurface?.getBoundingClientRect();
        const workspaceScale = Number(workspaceSurface?.dataset.workspaceScale || 0);
        const contentWidth = document.documentElement.clientWidth;
        const scrollbarWidth = Math.max(0, window.innerWidth - contentWidth);
        const pushLayoutReady = Boolean(
          drawerRect &&
          mainRect &&
          Math.abs(mainRect.left - drawerRect.right) <= 1 &&
          Math.abs(mainRect.width + drawerRect.width - contentWidth) <= 2
        );
        const workspaceScaleReady = Boolean(
          workspaceRect &&
          mainRect &&
          workspaceScale > 0 &&
          workspaceSurface.offsetWidth >= 1599 &&
          Math.abs(workspaceRect.width - mainRect.width) <= scrollbarWidth + 2
        );
        const recoveryReady = Boolean(root && root.childElementCount > 0 && recoverySurface);
        const authenticationReady = Boolean(
          root && root.childElementCount > 0 && authenticationSurface
        );
        return {
          ready: Boolean(
            recoveryReady ||
              authenticationReady ||
              (shell &&
                root &&
                root.childElementCount > 0 &&
                pushLayoutReady &&
                workspaceScaleReady)
          ),
          mode: recoveryReady
            ? 'recovery'
            : authenticationReady
              ? 'authentication'
              : 'workspace',
          title: document.title,
          recoveryText: String(recoverySurface?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
          text: String((shell || authenticationSurface)?.textContent || '')
            .replace(/\\s+/g, ' ')
            .trim()
            .slice(0, 120),
          bridge: {
            exposed: Boolean(window.wangzaiDesktop),
            getAppInfo: typeof window.wangzaiDesktop?.getAppInfo,
          },
          scripts: [...document.scripts].map((script) => ({ src: script.src, type: script.type })),
          resources: performance.getEntriesByType('resource').slice(-20).map((entry) => ({
            name: entry.name,
            initiatorType: entry.initiatorType,
            duration: Math.round(entry.duration),
          })),
          sidebarLayout: drawerRect && mainRect ? {
            drawerWidth: Math.round(drawerRect.width),
            mainLeft: Math.round(mainRect.left),
            mainWidth: Math.round(mainRect.width),
            viewportWidth: contentWidth,
            scrollbarWidth
          } : null,
          workspaceLayout: workspaceRect ? {
            designWidth: workspaceSurface.offsetWidth,
            scale: workspaceScale,
            visualWidth: Math.round(workspaceRect.width)
          } : null
        };
      })()`;
  const startedAt = Date.now();
  let lastResult = null;
  while (Date.now() - startedAt < rendererTimeoutMs) {
    lastResult = await webContents.executeJavaScript(inspectScript).catch(() => null);
    if (lastResult?.ready) return lastResult;
    await delay(120);
  }
  throw new Error(
    `桌面页面在烟测时未能完成渲染：${JSON.stringify(lastResult)}`,
  );
}

async function inspectRendererBootstrapState(webContents) {
  return webContents.executeJavaScript(`(() => {
    const root = document.querySelector('#root');
    const moduleScripts = [...document.scripts].filter((script) => script.type === 'module' && script.src);
    return {
      readyState: document.readyState,
      rootChildCount: root?.childElementCount || 0,
      moduleScriptCount: moduleScripts.length,
      moduleScripts: moduleScripts.map((script) => script.src),
    };
  })()`);
}

async function collectRendererNavigationPerformance(
  webContents,
  {
    timeoutMs = 16_000,
    expectedProductCount = 0,
    expectedOrderCount = 0,
    switchStressCount = 0,
    performanceTarget = 'products',
    diagnosticWaitMs = 0,
  } = {},
) {
  const supportedPerformanceTargets = new Set(['products', 'sales-orders', 'settings', 'all-modules', 'purchase-orders']);
  const normalizedPerformanceTarget = supportedPerformanceTargets.has(performanceTarget)
    ? performanceTarget
    : 'products';
  return webContents.executeJavaScript(
    `(() => {
      const expectedProductCount = ${Math.max(0, Number(expectedProductCount) || 0)};
      const expectedOrderCount = ${Math.max(0, Number(expectedOrderCount) || 0)};
      const switchStressCount = ${Math.max(0, Number(switchStressCount) || 0)};
      const performanceTarget = ${JSON.stringify(normalizedPerformanceTarget)};
      const waitFor = (predicate, waitMs) => new Promise((resolve, reject) => {
        const startedAt = performance.now();
        const tick = () => {
          if (predicate()) {
            resolve();
            return;
          }
          if (performance.now() - startedAt >= waitMs) {
            reject(new Error('PERFORMANCE_NAVIGATION_RENDER_TIMEOUT'));
            return;
          }
          requestAnimationFrame(tick);
        };
        tick();
      });
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const p95 = (values) => {
        if (!values.length) return 0;
        const ordered = [...values].sort((left, right) => left - right);
        return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * 0.95) - 1))];
      };
      const runContinuousListScroll = async (tableSelector) => {
        const table = document.querySelector('.page-panel:not([hidden]) ' + tableSelector);
        const scrollElement = document.scrollingElement || document.documentElement;
        const maxScrollTop = Math.max(0, scrollElement.scrollHeight - window.innerHeight);
        if (!table || maxScrollTop <= 0) {
          throw new Error('PERFORMANCE_LIST_SCROLL_TARGET_MISSING');
        }

        const durationTargetMs = 5_000;
        const frameSamples = [];
        const readForegroundContext = () => ({
          visibilityState: document.visibilityState,
          documentHidden: document.hidden,
          documentHasFocus: document.hasFocus(),
          recordedAtMs: performance.now(),
        });
        const foregroundContextBeforeScroll = readForegroundContext();
        const originalScrollTop = window.scrollY;
        let scrollEventCount = 0;
        const onScroll = () => {
          scrollEventCount += 1;
        };
        window.addEventListener('scroll', onScroll, { passive: true });

        const startedAt = performance.now();
        let previousFrameAt = startedAt;
        let elapsedMs = 0;
        try {
          while (elapsedMs < durationTargetMs) {
            // Four complete back-and-forth passes make this a real continuous scroll, not a jump test.
            const phase = ((elapsedMs / durationTargetMs) * 4) % 1;
            const progress = phase <= 0.5 ? phase * 2 : 2 - phase * 2;
            window.scrollTo(0, Math.round(maxScrollTop * progress));
            await nextFrame();
            const currentFrameAt = performance.now();
            frameSamples.push(Math.max(0, currentFrameAt - previousFrameAt));
            previousFrameAt = currentFrameAt;
            elapsedMs = currentFrameAt - startedAt;
          }
        } finally {
          window.removeEventListener('scroll', onScroll);
          window.scrollTo(0, originalScrollTop);
          await nextFrame();
          await nextFrame();
        }

        const p95FrameMs = p95(frameSamples);
        return {
          durationMs: elapsedMs,
          frameSamples,
          frameCount: frameSamples.length,
          scrollEventCount,
          p95FrameMs,
          p5Fps: p95FrameMs > 0 ? 1000 / p95FrameMs : 0,
          maxFrameMs: frameSamples.length ? Math.max(...frameSamples) : 0,
          foregroundContextBeforeScroll,
          foregroundContextAfterScroll: readForegroundContext(),
        };
      };
      const pageIsVisible = (title) => [...document.querySelectorAll('.page-panel:not([hidden])')]
        .some((panel) => [...panel.querySelectorAll('h1, h2, h3, h4, h5, h6')]
          .some((heading) => String(heading.textContent || '').trim() === title));
      const primaryPage = performanceTarget === 'sales-orders'
        ? { id: 'sales-orders', title: '销售订单', tableSelector: '.sales-orders-table' }
        : performanceTarget === 'purchase-orders'
          ? { id: 'purchase-orders', title: '拍单管理', tableSelector: '.purchase-orders-table' }
          : { id: 'products', title: '商品列表', tableSelector: '.product-list-table' };
      const expectedPrimaryVisibleRowCount = () => {
        const expectedCount = performanceTarget.endsWith('-orders') ? expectedOrderCount : expectedProductCount;
        return expectedCount > 0 ? Math.min(expectedCount, 20) : 0;
      };
      const visiblePrimaryProductRowCount = (tableSelector) =>
        document.querySelectorAll(
          '.page-panel:not([hidden]) ' + tableSelector + ' tbody tr[data-product-row="true"]',
        ).length;
      const primaryRowsAreComplete = (tableSelector) => {
        if (performanceTarget === 'purchase-orders') {
          return expectedPrimaryVisibleRowCount() > 0 && document.querySelectorAll(
            '.page-panel:not([hidden]) ' + tableSelector + ' tbody tr input[type="checkbox"]',
          ).length === expectedPrimaryVisibleRowCount();
        }
        if (performanceTarget !== 'products') {
          return document.querySelectorAll(
            '.page-panel:not([hidden]) ' + tableSelector + ' tbody tr',
          ).length > 0;
        }
        const expectedRows = expectedPrimaryVisibleRowCount();
        return expectedRows > 0 && visiblePrimaryProductRowCount(tableSelector) === expectedRows;
      };
      const primaryDatasetIsVisible = () => {
        const expectedCount = performanceTarget.endsWith('-orders') ? expectedOrderCount : expectedProductCount;
        if (!expectedCount) return true;
        const totalIsVisible = [...document.querySelectorAll('.page-panel:not([hidden])')]
          .some((panel) => String(panel.textContent || '').replace(/[\\s,，]/g, '').includes(\`共\${expectedCount}条\`));
        return totalIsVisible && primaryRowsAreComplete(primaryPage.tableSelector);
      };
      const findNavigationButton = (title) => [...document.querySelectorAll('button, [role="button"]')]
        .find((button) => String(button.textContent || '').replace(/\\s+/g, ' ').trim() === title);
      const findButtonByText = (root, title) => [...(root || document).querySelectorAll('button, [role="button"]')]
        .find((button) => String(button.textContent || '').replace(/\\s+/g, ' ').trim() === title);
      const findSettingsDialog = () => [...document.querySelectorAll('[role="dialog"]')]
        .find((dialog) => dialog.closest('[data-settings-open="true"]') && [...dialog.querySelectorAll('h1, h2, h3, h4, h5, h6')]
          .some((heading) => String(heading.textContent || '').trim() === '店铺管理'));
      const settingsDialogIsReady = () => {
        const dialog = findSettingsDialog();
        if (dialog?.dataset.settingsRenderReady !== 'true') return false;
        const mainPanel = dialog.querySelector('[data-settings-main-ready]');
        if (!mainPanel || mainPanel.dataset.settingsMainReady !== 'true') return false;
        const apiChecks = dialog.querySelector('[data-api-checks-ready]');
        return !apiChecks || apiChecks.dataset.apiChecksReady === 'true';
      };
      const readResourceTimings = () => performance.getEntriesByType('resource').map((entry) => ({
        name: String(entry.name || ''),
        initiatorType: String(entry.initiatorType || ''),
        startTimeMs: Number(entry.startTime) || 0,
        durationMs: Number(entry.duration) || 0,
        transferSize: Number(entry.transferSize) || 0,
        decodedBodySize: Number(entry.decodedBodySize) || 0,
      }));
      const readRouteModuleLoadMs = (pageId) => {
        const entries = performance.getEntriesByName('wangzai-route-module:' + pageId);
        const entry = entries.at(-1);
        return entry ? Math.max(0, Number(entry.duration) || 0) : null;
      };
      const readRouteRenderCommitTiming = (pageId) => {
        const entries = performance.getEntriesByName('wangzai-route-render:' + pageId);
        const entry = entries.at(-1);
        return entry
          ? {
            durationMs: Math.max(0, Number(entry.duration) || 0),
            startTimeMs: Math.max(0, Number(entry.startTime) || 0),
          }
          : null;
      };
      const readRouteRenderPhaseMs = (pageId, phase) => {
        const timing = readRouteRenderPhaseTiming(pageId, phase);
        return timing?.durationMs ?? null;
      };
      const readRouteRenderPhaseTiming = (pageId, phase) => {
        const entries = performance.getEntriesByName('wangzai-route-phase:' + pageId + ':' + phase);
        const entry = entries.at(-1);
        return entry
          ? {
            durationMs: Math.max(0, Number(entry.duration) || 0),
            startTimeMs: Math.max(0, Number(entry.startTime) || 0),
          }
          : null;
      };
      const readRendererTreeRenderStats = (metric) => {
        const entries = performance.getEntriesByName('wangzai-render-tree:' + metric);
        const durations = entries.map((entry) => Math.max(0, Number(entry.duration) || 0));
        if (!durations.length) return null;
        return {
          count: durations.length,
          firstMs: durations[0],
          lastMs: durations.at(-1),
          maxMs: Math.max(...durations),
        };
      };
      const readActivePageDomMetrics = () => {
        const panel = document.querySelector('.page-panel:not([hidden])');
        if (!panel) return { nodeCount: 0, muiNodeCount: 0, tableRowCount: 0 };
        return {
          nodeCount: panel.querySelectorAll('*').length,
          muiNodeCount: panel.querySelectorAll('[class*="Mui"]').length,
          tableRowCount: panel.querySelectorAll('tbody tr').length,
        };
      };
      return (async () => {
        globalThis.__wangzaiRendererTreeTelemetryEnabled = true;
        if (performanceTarget === 'sales-orders') {
          await waitFor(
            () => document.documentElement.dataset.wangzaiSalesOrdersRoute === 'ready',
            ${timeoutMs},
          );
        }
        const dashboardPage = { id: 'dashboard', title: '旺崽汇总' };
        if (performanceTarget === 'all-modules' && !findNavigationButton(dashboardPage.title)) {
          const rememberedLoginButton = findButtonByText(document, '登录');
          if (!rememberedLoginButton) throw new Error('ALL_MODULES_LOGIN_BUTTON_MISSING');
          rememberedLoginButton.click();
          await waitFor(() => Boolean(findNavigationButton(dashboardPage.title)), 30_000);
        }
        const allModulePages = [
          dashboardPage,
          { id: 'products', title: '商品列表' },
          { id: 'sales-orders', title: '销售订单' },
          { id: 'after-sales-orders', title: '售后订单' },
          { id: 'purchase-orders', title: '拍单管理' },
          { id: 'shipping', title: '利润核算' },
          { id: 'inventory', title: '营销活动' },
          { id: 'paid-promotion', title: '付费推广' },
          { id: 'data-analysis', title: '数据分析' },
          { id: 'customer-consultation', title: '客服咨询' },
          { id: 'prompt-library', title: '智能工具' },
          { id: 'collection-pricing', title: '商品采集', navTitle: '采集核价' },
          { id: 'points-packages', title: '选择积分套餐', navTitle: '积分套餐' },
          { id: 'warehouse-logistics', title: '仓储物流' },
          { id: 'data-backup', title: '数据备份' },
        ];
        const targets = performanceTarget === 'settings'
          ? []
          : performanceTarget === 'all-modules'
            ? Array.from({ length: 3 }, () => allModulePages).flat()
            : Array.from({ length: 10 }, (_item, index) => (index % 2 === 0 ? primaryPage : dashboardPage));
        const completedPages = new Set(['dashboard']);
        const longTasks = [];
        let performancePhase = 'setup';
        const readPerformancePhase = () => {
          const settingsDialog = document.querySelector('[role="dialog"][data-settings-render-stage]');
          const settingsStage = settingsDialog?.dataset.settingsRenderStage;
          const settingsMainStage = settingsDialog?.querySelector('[data-settings-main-stage]')
            ?.dataset.settingsMainStage;
          const settingsSideStage = settingsDialog?.querySelector('[data-settings-side-stage]')
            ?.dataset.settingsSideStage;
          const settingsOpen = settingsDialog?.closest('[data-settings-open]')?.dataset.settingsOpen;
          return performanceTarget === 'settings' && settingsStage
            ? 'navigate:settings:' + (settingsOpen === 'true' ? 'open' : 'closed') + ':stage-' + settingsStage
              + (settingsMainStage ? ':main-' + settingsMainStage : '')
              + (settingsSideStage ? ':side-' + settingsSideStage : '')
            : performancePhase;
        };
        let observer = null;
        try {
          observer = new PerformanceObserver((entries) => {
            entries.getEntries().forEach((entry) => longTasks.push({
              durationMs: Number(entry.duration) || 0,
              startTimeMs: Number(entry.startTime) || 0,
              phase: readPerformancePhase(),
            }));
          });
          observer.observe({ entryTypes: ['longtask'] });
        } catch (_error) {
          observer = null;
        }
        const samples = [];
        let scroll = null;
        let navigationStress = null;
        try {
          if (performanceTarget === 'settings') {
            const settingsButton = document.querySelector('button[aria-label="设置"]');
            if (!settingsButton) throw new Error('PERFORMANCE_SETTINGS_BUTTON_MISSING');
            for (let index = 0; index < 10; index += 1) {
              performancePhase = 'navigate:settings';
              const startedAt = performance.now();
              const resourceNamesBefore = new Set(readResourceTimings().map((entry) => entry.name));
              settingsButton.click();
              await waitFor(() => Boolean(findSettingsDialog()), ${timeoutMs});
              await waitFor(settingsDialogIsReady, ${timeoutMs});
              const shellReadyMs = Math.max(0, performance.now() - startedAt);
              await nextFrame();
              await nextFrame();
              const dialog = findSettingsDialog();
              samples.push({
                pageId: 'settings',
                isColdStart: index === 0,
                shellReadyMs,
                durationMs: Math.max(0, performance.now() - startedAt),
                routeModuleLoadMs: index === 0 ? readRouteModuleLoadMs('settings') : null,
                routeRenderCommitMs: null,
                routeRenderStartDelayMs: null,
                routeModelPrepareMs: null,
                routeReconcileMs: null,
                routeDomCommitMs: null,
                routeViewCommitMs: null,
                routeViewTreeRenderMs: null,
                routeViewTreeFirstRenderMs: null,
                routeViewTreeMaxRenderMs: null,
                routeViewTreeRenderCount: 0,
                routeProductTableRowsTreeRenderMs: null,
                routeProductTableRowsFirstRenderMs: null,
                routeProductTableRowsMaxRenderMs: null,
                routeProductTableRowsRenderCount: 0,
                routeViewStartDelayMs: null,
                routeViewStartDelayFirstMs: null,
                routeDataReadyCommitMs: null,
                routeDataReadyCommitFirstMs: null,
                routeLocalLoadStartDelayMs: null,
                routeLocalApiReadMs: null,
                routeLocalPagePrepMs: null,
                routeDomNodeCount: dialog?.querySelectorAll('*').length ?? null,
                routeMuiNodeCount: dialog?.querySelectorAll('[class*="Mui"]').length ?? null,
                routeTableRowCount: dialog?.querySelectorAll('tbody tr').length ?? null,
                routeWorkspaceTargetSlotMs: null,
                routeWorkspaceDashboardInactiveSlotMs: null,
                routeDashboardTreeRenderMs: null,
                resourceTimings: index === 0
                  ? readResourceTimings().filter((entry) => !resourceNamesBefore.has(entry.name))
                  : [],
              });
              const closeButton = findButtonByText(dialog, '关闭');
              if (!closeButton) throw new Error('PERFORMANCE_SETTINGS_CLOSE_BUTTON_MISSING');
              closeButton.click();
              await waitFor(() => !findSettingsDialog(), ${timeoutMs});
              await nextFrame();
            }
          }
          for (const target of targets) {
            performancePhase = 'navigate:' + target.id;
            const button = findNavigationButton(target.navTitle || target.title);
            if (!button) {
              const labels = [...document.querySelectorAll('button, [role="button"]')]
                .map((item) => String(item.textContent || '').replace(/\\s+/g, ' ').trim())
                .filter(Boolean)
                .slice(0, 30);
              throw new Error(\`PERFORMANCE_NAVIGATION_BUTTON_MISSING:\${target.id}:\${labels.join('|')}\`);
            }
            const startedAt = performance.now();
            const resourceNamesBefore = new Set(readResourceTimings().map((entry) => entry.name));
            let shellReadyMs = 0;
            let firstRowsReadyMs = null;
            button.click();
            try {
              await waitFor(() => pageIsVisible(target.title), ${timeoutMs});
              shellReadyMs = Math.max(0, performance.now() - startedAt);
              if (target.id === primaryPage.id) {
                await waitFor(() => {
                  if (firstRowsReadyMs === null && primaryRowsAreComplete(primaryPage.tableSelector)) {
                    firstRowsReadyMs = Math.max(0, performance.now() - startedAt);
                  }
                  return primaryDatasetIsVisible();
                }, ${Math.max(timeoutMs, Math.min(Number(diagnosticWaitMs) || 0, 120000))});
              }
            } catch (error) {
              const activeText = [...document.querySelectorAll('.page-panel:not([hidden])')]
                .map((panel) => String(panel.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 700))
                .join(' | ');
              throw new Error(\`\${error?.message || 'PERFORMANCE_NAVIGATION_FAILED'}:\${activeText}\`);
            }
            await nextFrame();
            await nextFrame();
            if (performanceTarget === 'all-modules') {
              await new Promise((resolve) => setTimeout(resolve, 900));
              const activeText = [...document.querySelectorAll('.page-panel:not([hidden])')]
                .map((panel) => String(panel.textContent || '').replace(/\s+/g, ' ').trim())
                .join(' | ');
              const transportFailure = activeText.match(
                /无法连接本地 API|本地 API 请求超时|local-api 请求超时/u,
              );
              if (transportFailure) {
                throw new Error(
                  'ALL_MODULES_LOCAL_API_TRANSPORT_FAILURE:' + target.id + ':' + transportFailure[0],
                );
              }
            }
            const routeRenderTiming = completedPages.has(target.id) ? null : readRouteRenderCommitTiming(target.id);
            const pageDomMetrics = target.id === primaryPage.id || !completedPages.has(target.id)
              ? readActivePageDomMetrics()
              : null;
            const routeViewTreeStats = completedPages.has(target.id)
              ? null
              : readRendererTreeRenderStats(target.id + ':page-view');
            const routeProductTableRowsTreeStats = completedPages.has(target.id)
              ? null
              : readRendererTreeRenderStats('products:table-rows');
            const routeViewStartDelayStats = completedPages.has(target.id)
              ? null
              : readRendererTreeRenderStats(target.id + ':view-start-delay');
            const routeDataReadyCommitStats = completedPages.has(target.id)
              ? null
              : readRendererTreeRenderStats('products:data-ready-commit');
            const routeLocalLoadStartTiming = completedPages.has(target.id)
              ? null
              : readRouteRenderPhaseTiming(target.id, 'local-load-start');
            samples.push({
              pageId: target.id,
              isColdStart: !completedPages.has(target.id),
              shellReadyMs,
              firstRowsReadyMs,
              durationMs: Math.max(0, performance.now() - startedAt),
              routeModuleLoadMs: completedPages.has(target.id) ? null : readRouteModuleLoadMs(target.id),
              routeRenderCommitMs: routeRenderTiming?.durationMs ?? null,
              routeRenderStartDelayMs: routeRenderTiming
                ? Math.max(0, routeRenderTiming.startTimeMs - startedAt)
                : null,
              routeModelPrepareMs: completedPages.has(target.id) ? null : readRouteRenderPhaseMs(target.id, 'model'),
              routeReconcileMs: completedPages.has(target.id) ? null : readRouteRenderPhaseMs(target.id, 'reconcile'),
              routeDomCommitMs: completedPages.has(target.id) ? null : readRouteRenderPhaseMs(target.id, 'commit'),
              routeViewCommitMs: completedPages.has(target.id) ? null : readRouteRenderPhaseMs(target.id, 'view'),
              routeViewTreeRenderMs: routeViewTreeStats?.lastMs ?? null,
              routeViewTreeFirstRenderMs: routeViewTreeStats?.firstMs ?? null,
              routeViewTreeMaxRenderMs: routeViewTreeStats?.maxMs ?? null,
              routeViewTreeRenderCount: routeViewTreeStats?.count ?? 0,
              routeProductTableRowsTreeRenderMs: routeProductTableRowsTreeStats?.lastMs ?? null,
              routeProductTableRowsFirstRenderMs: routeProductTableRowsTreeStats?.firstMs ?? null,
              routeProductTableRowsMaxRenderMs: routeProductTableRowsTreeStats?.maxMs ?? null,
              routeProductTableRowsRenderCount: routeProductTableRowsTreeStats?.count ?? 0,
              routeViewStartDelayMs: routeViewStartDelayStats?.lastMs ?? null,
              routeViewStartDelayFirstMs: routeViewStartDelayStats?.firstMs ?? null,
              routeDataReadyCommitMs: routeDataReadyCommitStats?.lastMs ?? null,
              routeDataReadyCommitFirstMs: routeDataReadyCommitStats?.firstMs ?? null,
              routeLocalLoadStartDelayMs: routeLocalLoadStartTiming
                ? Math.max(0, routeLocalLoadStartTiming.startTimeMs - startedAt)
                : null,
              routeLocalApiReadMs: completedPages.has(target.id)
                ? null
                : readRouteRenderPhaseMs(target.id, 'local-api-read'),
              routeLocalPagePrepMs: completedPages.has(target.id)
                ? null
                : readRouteRenderPhaseMs(target.id, 'local-page-prep'),
              routeDomNodeCount: pageDomMetrics?.nodeCount ?? null,
              routeMuiNodeCount: pageDomMetrics?.muiNodeCount ?? null,
              routeTableRowCount: pageDomMetrics?.tableRowCount ?? null,
              routeWorkspaceTargetSlotMs: completedPages.has(target.id)
                ? null
                : readRendererTreeRenderStats('workspace-slot:' + target.id + ':active')?.lastMs ?? null,
              routeWorkspaceDashboardInactiveSlotMs:
                completedPages.has(target.id) || target.id !== primaryPage.id
                  ? null
                  : readRendererTreeRenderStats('workspace-slot:dashboard:inactive')?.lastMs ?? null,
              routeDashboardTreeRenderMs:
                completedPages.has(target.id) || target.id !== primaryPage.id
                  ? null
                  : readRendererTreeRenderStats('dashboard:page-view')?.lastMs ?? null,
              resourceTimings: completedPages.has(target.id)
                ? []
                : readResourceTimings().filter((entry) => !resourceNamesBefore.has(entry.name)),
            });
            completedPages.add(target.id);
          }
          if ((expectedProductCount || expectedOrderCount) && primaryPage.tableSelector) {
            performancePhase = 'scroll:' + primaryPage.id;
            const primaryButton = findNavigationButton(primaryPage.title);
            if (!primaryButton) throw new Error(\`PERFORMANCE_\${primaryPage.id}_SCROLL_BUTTON_MISSING\`);
            primaryButton.click();
            await waitFor(() => pageIsVisible(primaryPage.title), ${timeoutMs});
            await waitFor(primaryDatasetIsVisible, ${timeoutMs});
            await waitFor(() => primaryRowsAreComplete(primaryPage.tableSelector), ${timeoutMs});
            await nextFrame();
            scroll = await runContinuousListScroll(primaryPage.tableSelector);
          }
          if (switchStressCount) {
            const readHeap = () => {
              const memory = performance.memory;
              if (!memory || !Number.isFinite(Number(memory.usedJSHeapSize))) return null;
              return Number(memory.usedJSHeapSize);
            };
            const collectRetainedHeap = async () => {
              if (typeof globalThis.gc !== 'function') return false;
              globalThis.gc();
              await nextFrame();
              globalThis.gc();
              await nextFrame();
              return true;
            };
            const garbageCollectionAvailable = await collectRetainedHeap();
            const heapBeforeBytes = readHeap();
            let completedSwitches = 0;
            const switchDurations = [];
            for (let index = 0; index < switchStressCount; index += 1) {
              const target = index % 2 === 0
                ? { id: 'dashboard', title: '旺崽汇总' }
                : primaryPage;
              performancePhase = 'stress:' + target.id;
              const button = findNavigationButton(target.title);
              if (!button) throw new Error(\`PERFORMANCE_STRESS_BUTTON_MISSING:\${target.id}\`);
              const switchStartedAt = performance.now();
              button.click();
              await waitFor(() => pageIsVisible(target.title), ${timeoutMs});
              if (target.id === primaryPage.id) await waitFor(primaryDatasetIsVisible, ${timeoutMs});
              await nextFrame();
              switchDurations.push(Math.max(0, performance.now() - switchStartedAt));
              completedSwitches += 1;
            }
            await collectRetainedHeap();
            await nextFrame();
            await nextFrame();
            await nextFrame();
            const heapAfterBytes = readHeap();
            navigationStress = {
              requestedSwitches: switchStressCount,
              completedSwitches,
              switchDurations,
              p95SwitchMs: p95(switchDurations),
              maxSwitchMs: switchDurations.length ? Math.max(...switchDurations) : 0,
              garbageCollectionAvailable,
              heapBeforeBytes,
              heapAfterBytes,
              heapDeltaBytes:
                heapBeforeBytes !== null && heapAfterBytes !== null ? heapAfterBytes - heapBeforeBytes : null,
            };
          }
          } finally {
            performancePhase = 'teardown';
            observer?.disconnect();
          }
        const cold = samples.filter((sample) => sample.isColdStart).map((sample) => sample.durationMs);
        const warm = samples.filter((sample) => !sample.isColdStart).map((sample) => sample.durationMs);
        return {
          performanceTarget,
          rendererContext: {
            visibilityState: document.visibilityState,
            documentHidden: document.hidden,
            documentHasFocus: document.hasFocus(),
            recordedAtMs: performance.now(),
          },
          samples,
          purchaseInputChanges: performanceTarget === 'purchase-orders'
            ? performance.getEntriesByName('wangzai-purchase-input-change').map(entry => ({ atMs: entry.startTime, ...entry.detail })) : [],
          coldCount: cold.length,
          coldP95Ms: p95(cold),
          warmCount: warm.length,
          warmP95Ms: p95(warm),
          scroll,
          navigationStress,
          longTaskCount: longTasks.length,
          longTasksOver100ms: longTasks.filter((task) => task.durationMs > 100).length,
          maxLongTaskMs: longTasks.length ? Math.max(...longTasks.map((task) => task.durationMs)) : 0,
          longTaskDetails: longTasks,
        };
      })();
    })()`,
    true,
  );
}

export function createMainWindowController({
  app,
  appHost,
  appId,
  preloadPath,
  windowIconPath,
  windowTitle = "旺崽助手",
  isSmokeTest,
  isPerformanceTest = false,
  isLegacyRetirementTest = false,
  isDashboardVisualTest = false,
  performanceProductCount = 0,
  performanceSwitchStressCount = 0,
  performanceOrderCount = 0,
  performanceTarget = 'products',
  appendLog,
  legacyRetirementFault = null,
  openInternalUrl = async () => undefined,
}) {
  let mainWindow = null;
  const isAutomationTest =
    isSmokeTest ||
    isPerformanceTest ||
    isLegacyRetirementTest ||
    isDashboardVisualTest;

  async function create(runtimeInfo) {
    const legacyRetirementHarness = isLegacyRetirementTest
      ? await import("../../test-support/legacyRetirementHarness.js")
      : {};
    const {
      RETIRED_OZON_SHOP_BROWSER_KEY,
      getLegacyRetirementFixture,
      seedLegacyRetirementCanonicalShops,
      writeLegacyRetirementSeedFile,
      readLegacyRetirementSeedFile,
      seedLegacyRetirementMarketingFile,
      createLegacyRetirementMarketingFileEvidence,
      waitForLegacyRetirementFixture,
      runLegacyRetirementRecoveryFixture,
      waitForLegacyRetirementRecoveryReadbackFault,
      waitForLegacyRetirementFailureEvidence,
    } = legacyRetirementHarness;
    const legacyRetirementPhase = isLegacyRetirementTest
      ? String(process.env.WANGZAI_LEGACY_RETIREMENT_PHASE || "").trim()
      : "";
    const legacyRetirementFixtureId = isLegacyRetirementTest
      ? String(process.env.WANGZAI_LEGACY_RETIREMENT_FIXTURE_ID || "").trim()
      : "";
    const legacyRetirementUsesMaximumFixture =
      legacyRetirementPhase === "max" || legacyRetirementPhase === "max-restart";
    const legacyRetirementFixture = isLegacyRetirementTest
      ? getLegacyRetirementFixture(
        legacyRetirementFixtureId,
        legacyRetirementUsesMaximumFixture ? "maximum" : "minimum",
      )
      : null;
    const legacyRetirementBootstrapEntries = isLegacyRetirementTest
      ? Array.isArray(legacyRetirementFixture?.bootstrapLegacyEntries)
        ? legacyRetirementFixture.bootstrapLegacyEntries
        : []
      : [];
    const legacyRetirementSeedEntries = isLegacyRetirementTest
      ? [
        // Some scoped migrations (marketing) need pre-existing, legal local
        // shop mappings.  Keep setup values outside `legacyEntries`: failure
        // assertions must track only the target browser key, not bootstrap
        // state that is independently canonicalized before the target runs.
        ...legacyRetirementBootstrapEntries,
        ...(legacyRetirementPhase === "bad"
          ? legacyRetirementFixture.legacyEntries
            .filter((entry) => entry?.key !== RETIRED_OZON_SHOP_BROWSER_KEY)
            .map((entry) => ({
            key: entry.key,
            // Browser JSON parsing must fail closed: the old bytes remain for retry and
            // no canonical record may be manufactured from a malformed legacy input.
            value: "{legacy-retirement-malformed-json",
            raw: true,
          }))
          : legacyRetirementFixture.legacyEntries
            .filter((entry) => entry?.key !== RETIRED_OZON_SHOP_BROWSER_KEY)
            ),
      ]
      : [];
    const shouldSeedLegacyRetirementFixture =
      ["seed", "bad", "write-error", "readback-error", "max", "recovery-failure"].includes(legacyRetirementPhase);
    if (isLegacyRetirementTest && shouldSeedLegacyRetirementFixture) {
      await seedLegacyRetirementCanonicalShops(
        runtimeInfo.localApi.baseUrl,
        runtimeInfo.localApi.authToken,
        [...legacyRetirementBootstrapEntries, ...(legacyRetirementFixture?.legacyEntries || [])],
      );
    }
    const legacyRetirementSeedPayload = shouldSeedLegacyRetirementFixture
      ? JSON.stringify(legacyRetirementSeedEntries)
      : "";
    const legacyRetirementSeedFile =
      shouldSeedLegacyRetirementFixture && Buffer.byteLength(legacyRetirementSeedPayload, "utf8") > 8 * 1024
        ? writeLegacyRetirementSeedFile({
          fixtureId: legacyRetirementFixtureId,
          entries: legacyRetirementSeedEntries,
        })
        : "";
    const legacyRetirementSeedArgument = shouldSeedLegacyRetirementFixture
      ? legacyRetirementSeedFile
        ? `--wangzai-legacy-retirement-seed-file=${legacyRetirementSeedFile}`
        : `--wangzai-legacy-retirement-seed=${encodeURIComponent(legacyRetirementSeedPayload)}`
      : "";
    const legacyRetirementMarketingFileSeed = isLegacyRetirementTest
      ? seedLegacyRetirementMarketingFile({
        fixture: legacyRetirementFixture,
        phase: legacyRetirementPhase,
      })
      : null;
    const legacyRetirementMarketingFileEvidence = isLegacyRetirementTest
      ? createLegacyRetirementMarketingFileEvidence(
        legacyRetirementFixture,
        legacyRetirementMarketingFileSeed,
      )
      : null;
    const legacyRetirementFileWaitOptions = Object.freeze({
      legacyMarketingFileEvidence: legacyRetirementMarketingFileEvidence,
      expectLegacyMarketingFileRetention: [
        "bad",
        "write-error",
        "readback-error",
        "recovery-failure",
      ].includes(legacyRetirementPhase),
    });
    // A write/readback fault belongs to the fixture's final canonical target.
    // Some fixtures seed prerequisite shop/account keys so that target can be
    // migrated. Those prerequisites may correctly finish and clear before the
    // final target fails, so only the declared recovery target is mandatory in
    // these failure phases. Fixtures without that declaration retain the safer
    // legacy behaviour: `[]` makes waitForLegacyRetirementFixture require every
    // seeded legacy key.
    const legacyRetirementFailureRetainedKeys =
      ["write-error", "readback-error"].includes(legacyRetirementPhase) &&
      Array.isArray(legacyRetirementFixture?.recoveryRetainedKeys) &&
      legacyRetirementFixture.recoveryRetainedKeys.length > 0
        ? legacyRetirementFixture.recoveryRetainedKeys
        : [];
    // Recovery failure deliberately leaves its browser copy intact. Before the
    // isolated recovery-restart phase bootstraps, remove only this fixture's
    // old keys so an empty local-data directory cannot be repopulated from
    // Chromium storage and mistaken for restored canonical data.
    const legacyRetirementClearBrowserKeys =
      legacyRetirementPhase === "recovery-restart"
        ? [...new Set(
          (legacyRetirementFixture?.legacyEntries || [])
            .map((entry) => String(entry?.key || "").trim())
            .filter(Boolean),
        )]
        : [];
    const legacyRetirementClearBrowserKeysArgument = legacyRetirementClearBrowserKeys.length
      ? `--wangzai-legacy-retirement-clear-browser-keys=${legacyRetirementClearBrowserKeys.join(",")}`
      : "";
    if (legacyRetirementSeedFile) {
      // The sandboxed preload can run during BrowserWindow construction, before this
      // controller has a webContents id. Register the one-shot test-only responder
      // first; the exact file path is still checked and the caller cannot request
      // arbitrary files.
      ipcMain.once("desktop:legacy-retirement-read-seed", (event, requestedPath) => {
        event.returnValue =
          requestedPath === legacyRetirementSeedFile
            ? readLegacyRetirementSeedFile(legacyRetirementSeedFile)
            : "";
      });
    }
    app.setAppUserModelId(appId);
    Menu.setApplicationMenu(null);

    const startsWithAuthenticationGate =
      !isAutomationTest && runtimeInfo.localApi.recoveryMode !== true;
    const window = new BrowserWindow({
      ...(startsWithAuthenticationGate
        ? getAuthenticationWindowOptions()
        : getInitialWindowOptions()),
      title: windowTitle,
      ...(windowIconPath ? { icon: windowIconPath } : {}),
      backgroundColor: "#f5f7fb",
      autoHideMenuBar: true,
      // Chromium does not execute the first app:// module reliably while a
      // packaged smoke window has never been mapped. Map only that automation
      // window as an almost-transparent, non-focusable surface so it paints
      // without flashing or stealing focus from the operator.
      show: isSmokeTest,
      ...(isSmokeTest
        ? {
            skipTaskbar: true,
            paintWhenInitiallyHidden: true,
            opacity: 0.01,
            focusable: false,
          }
        : isPerformanceTest || isDashboardVisualTest
          ? { skipTaskbar: true, paintWhenInitiallyHidden: true }
        : {}),
      webPreferences: {
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        offscreen: isPerformanceTest,
        // The real CEF purchase browser is a cross-process WS_CHILD layered
        // over one rectangle of this renderer. Native Windows occlusion may
        // classify the Electron surface as hidden even though the fixed order
        // rail is still visible. Keep React/rAF/ResizeObserver active so the
        // card can commit "已连接" and resize the child without a white stall.
        backgroundThrottling: false,
        additionalArguments: [
          `--wangzai-local-api-base-url=${runtimeInfo.localApi.baseUrl}`,
          `--wangzai-purchase-bridge-base-url=${runtimeInfo.purchaseBridge.baseUrl}`,
          ...(legacyRetirementSeedArgument ? [legacyRetirementSeedArgument] : []),
          ...(legacyRetirementClearBrowserKeysArgument ? [legacyRetirementClearBrowserKeysArgument] : []),
          ...(isDashboardVisualTest ? ["--wangzai-dashboard-visual-test=1"] : []),
        ],
      },
    });
    mainWindow = window;
    if (isPerformanceTest) {
      // Offscreen rendering is not display-vsync driven; a higher ceiling avoids the hidden
      // compositor itself becoming the bottleneck while the enforced FPS threshold stays intact.
      window.webContents.setFrameRate(120);
      // A paint listener keeps Electron's offscreen compositor active without exposing a window.
      window.webContents.on("paint", () => undefined);
    }
    window.removeMenu();
    window.setMenuBarVisibility(false);
    if (isDashboardVisualTest) {
      installDashboardVisualNetworkGuard(window.webContents, appendLog);
      ipcMain.removeHandler("desktop:dashboard-visual-capture");
      ipcMain.handle("desktop:dashboard-visual-capture", async (event, input = {}) => {
        if (event.sender !== window.webContents || window.isDestroyed()) {
          throw new Error("DASHBOARD_VISUAL_CAPTURE_SENDER_REJECTED");
        }
        const requested = input?.rect && typeof input.rect === "object"
          ? input.rect
          : null;
        const rect = requested
          ? (() => {
              const x = Math.max(0, Math.floor(Number(requested.x) || 0));
              const y = Math.max(0, Math.floor(Number(requested.y) || 0));
              return {
                x,
                y,
                width: Math.max(1, Math.ceil(Number(requested.width) || 1)),
                height: Math.max(1, Math.ceil(Number(requested.height) || 1)),
              };
            })()
          : undefined;
        const image = rect
          ? await window.webContents.capturePage(rect)
          : await window.webContents.capturePage();
        const png = image.toPNG();
        appendLog(
          "desktop-main",
          `[dashboard-visual] captured ${JSON.stringify({
            visible: window.isVisible(),
            focused: window.isFocused(),
            rect: rect || null,
            bytes: png.length,
          })}\n`,
        );
        return {
          ok: true,
          pngBase64: png.toString("base64"),
          size: image.getSize(),
          visible: window.isVisible(),
          focused: window.isFocused(),
          rect: rect || null,
        };
      });
      appendLog(
        "desktop-main",
        `[dashboard-visual] window-created ${JSON.stringify({
          pid: process.pid,
          visible: window.isVisible(),
          focused: window.isFocused(),
        })}\n`,
      );
    }

    window.once("ready-to-show", () => {
      if (isPerformanceTest) {
        appendLog(
          "desktop-main",
          `[performance] ready-hidden ${JSON.stringify({
            visible: window.isVisible(),
            focused: window.isFocused(),
          })}\n`,
        );
      } else if (
        !isSmokeTest &&
        !isLegacyRetirementTest &&
        !isDashboardVisualTest
      ) {
        window.show();
      } else if (isDashboardVisualTest) {
        appendLog(
          "desktop-main",
          `[dashboard-visual] ready-hidden ${JSON.stringify({
            visible: window.isVisible(),
            focused: window.isFocused(),
          })}\n`,
        );
      }
    });

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        if (isDashboardVisualTest) {
          appendLog(
            "desktop-main",
            `[dashboard-visual-network] blocked-window-open ${JSON.stringify({ url })}\n`,
          );
        } else {
          Promise.resolve(openInternalUrl(url)).catch((error) => appendLog(
            "desktop-main",
            `[external-link] internal browser route failed code=${error?.code || error?.message || "unknown"}\n`,
          ));
        }
      }
      return { action: "deny" };
    });

    window.webContents.on("will-navigate", (event, url) => {
      if (url.startsWith(`app://${appHost}/`)) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) {
        if (isDashboardVisualTest) {
          appendLog(
            "desktop-main",
            `[dashboard-visual-network] blocked-navigation ${JSON.stringify({ url })}\n`,
          );
        } else {
          Promise.resolve(openInternalUrl(url)).catch((error) => appendLog(
            "desktop-main",
            `[external-link] internal browser route failed code=${error?.code || error?.message || "unknown"}\n`,
          ));
        }
      }
    });

    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL) => {
        appendLog(
          "desktop-renderer",
          `[did-fail-load] code=${errorCode} url=${validatedURL} message=${errorDescription}\n`,
        );
        if (isAutomationTest && errorCode !== -3) {
          process.exitCode = 1;
          app.quit();
        }
      },
    );

    window.webContents.on("render-process-gone", (_event, details) => {
      appendLog(
        "desktop-renderer",
        `[render-process-gone] ${JSON.stringify(details)}\n`,
      );
      if (isAutomationTest) {
        process.exitCode = 1;
        app.quit();
      }
    });

    window.webContents.on("console-message", (details) => {
      const level = String(details.level || "info");
      const message = String(details.message || "");
      const allowedInfo = ["[profit-hydration-ready] ", "[profit-calculation-lane-ready] "]
        .some((prefix) => message.startsWith(prefix));
      if (level !== "warning" && level !== "error" && !allowedInfo) return;
      appendLog(
        "desktop-renderer",
        `[console:${level}] ${message} (${details.sourceId}:${details.lineNumber})\n`,
      );
    });

    if (isSmokeTest || isPerformanceTest) {
      let automationCompleted = false;
      let automationLoadHandlerActive = false;
      let rendererBootstrapReloadAttempted = false;
      window.webContents.on("did-finish-load", async () => {
        if (automationCompleted || automationLoadHandlerActive) return;
        automationLoadHandlerActive = true;
        try {
          // A packaged Chromium renderer can finish its first custom-scheme
          // navigation before the module loader starts. One controlled reload
          // restores the normal module/preload lifecycle; the guard is bounded
          // so a genuine renderer failure still fails closed below.
          await delay(120);
          let result = null;
          if (!rendererBootstrapReloadAttempted) {
            try {
              result = await waitForRendererSmokeReady(window.webContents, 1_200);
            } catch (_initialBootstrapError) {
              const bootstrapState = await inspectRendererBootstrapState(window.webContents)
                .catch(() => ({ readyState: "unknown", rootChildCount: 0, moduleScriptCount: 0 }));
              rendererBootstrapReloadAttempted = true;
              automationLoadHandlerActive = false;
              appendLog(
                "desktop-main",
                `[renderer-bootstrap] controlled-reload ${JSON.stringify(bootstrapState)}\n`,
              );
              window.webContents.reloadIgnoringCache();
              return;
            }
          }
          if (!result) result = await waitForRendererSmokeReady(window.webContents);
          automationCompleted = true;
          if (isPerformanceTest) {
            const windowContextBeforeMeasurement = {
              isVisible: window.isVisible(),
              isFocused: window.isFocused(),
            };
            const performance = await collectRendererPerformanceTrace(
            window.webContents,
              () => collectRendererNavigationPerformance(window.webContents, {
                expectedProductCount: performanceProductCount,
                expectedOrderCount: performanceOrderCount,
                switchStressCount: performanceSwitchStressCount,
                performanceTarget,
                diagnosticWaitMs: process.env.WANGZAI_PERFORMANCE_DIAGNOSTIC_WAIT === '1' ? 120000 : 0,
              }),
            );
            if (performanceTarget === 'purchase-orders' && process.env.WANGZAI_PERFORMANCE_PURCHASE_FIXTURE) {
              appendLog('desktop-main', `[performance] purchase-navigation-before-interactions ${JSON.stringify(performance)}\n`);
              performance.purchaseInteractions = await collectPurchaseOrderInteractions(window,
                JSON.parse(process.env.WANGZAI_PERFORMANCE_PURCHASE_FIXTURE),
                sample => appendLog('desktop-main', `[performance] purchase-interaction ${JSON.stringify(sample)}\n`));
            }
            performance.windowContext = {
              beforeMeasurement: windowContextBeforeMeasurement,
              afterMeasurement: {
                isVisible: window.isVisible(),
                isFocused: window.isFocused(),
              },
            };
            performance.automationVisibility = "hidden";
            appendLog(
              "desktop-main",
              `[performance] renderer-navigation ${JSON.stringify({ rendererReady: result, ...performance })}\n`,
            );
          } else {
            appendLog(
              "desktop-main",
              `[smoke] renderer-ready ${JSON.stringify(result)}\n`,
            );
          }
          process.exitCode = 0;
          app.quit();
        } catch (error) {
          automationCompleted = true;
          if (isPerformanceTest) {
            const errors = await window.webContents.executeJavaScript("performance.getEntriesByName('wangzai-snapshot-read-error').slice(-4).map(entry => entry.detail)").catch(() => []);
            appendLog('desktop-main', `[performance] snapshot-read-errors ${JSON.stringify(errors)}\n`);
          }
          appendLog(
            "desktop-main",
            `[smoke] failed ${error?.stack || error}\n`,
          );
          process.exitCode = 1;
          app.quit();
        } finally {
          automationLoadHandlerActive = false;
        }
      });
    }

    if (isLegacyRetirementTest) {
      const phase = legacyRetirementPhase;
      const fixtureId = legacyRetirementFixtureId;
      const fixture = {
        ...legacyRetirementFixture,
        legacyEntries: (legacyRetirementFixture?.legacyEntries || [])
          .filter((entry) => entry?.key !== RETIRED_OZON_SHOP_BROWSER_KEY),
        recoveryRetainedKeys: (legacyRetirementFixture?.recoveryRetainedKeys || [])
          .filter((key) => key !== RETIRED_OZON_SHOP_BROWSER_KEY),
      };
      let loadCount = 0;
      let completed = false;
      window.webContents.on("did-finish-load", async () => {
        if (completed) return;
        loadCount += 1;
        try {
          await waitForRendererSmokeReady(window.webContents);
          if (["seed", "bad", "write-error", "readback-error", "max"].includes(phase) && loadCount === 1) {
            completed = true;
            if (["write-error", "readback-error"].includes(phase)) {
              await waitForLegacyRetirementFailureEvidence(legacyRetirementFault, phase, 20_000);
            }
            const result = await waitForLegacyRetirementFixture(
              window.webContents,
              fixture,
              phase === "max" ? 90_000 : 20_000,
              ["bad", "write-error", "readback-error"].includes(phase),
              false,
              legacyRetirementFailureRetainedKeys,
              legacyRetirementFileWaitOptions,
            );
            const record = {
              fixtureId,
              phase,
              loadCount,
              ...result,
              fault: legacyRetirementFault?.snapshot?.() || null,
            };
            appendLog("desktop-main", `[legacy-retirement] ${JSON.stringify(record)}\n`);
            console.log(`[legacy-retirement] ${JSON.stringify(record)}`);
            process.exitCode = 0;
            app.quit();
            return;
          }
          if (phase === "recovery-failure" && loadCount === 1) {
            completed = true;
            await waitForLegacyRetirementRecoveryReadbackFault(
              legacyRetirementFault,
              20_000,
            );
            const result = await waitForLegacyRetirementFixture(
              window.webContents,
              fixture,
              20_000,
              true,
              false,
              fixture.recoveryRetainedKeys,
              legacyRetirementFileWaitOptions,
            );
            // The readback failure has already retained the browser key. Verify
            // the source canonical row before exporting so recovery evidence
            // cannot confuse a missing migration write with a restore defect.
            legacyRetirementFault?.completeRecoveryActivation?.();
            const canonicalBeforeRecovery = await waitForLegacyRetirementFixture(
              window.webContents,
              fixture,
              20_000,
              false,
              true,
              fixture.recoveryRetainedKeys,
              legacyRetirementFileWaitOptions,
            );
            const recovery = await runLegacyRetirementRecoveryFixture(
              window.webContents,
              fixture,
              90_000,
            );
            // The successful atomic switch is now complete. Enable only the
            // recovery fixture's canonical readback, while its browser copy is
            // still retained, so a restart cannot hide a missing backup domain
            // by importing the old key again.
            const canonicalAfterActivation = await waitForLegacyRetirementFixture(
              window.webContents,
              fixture,
              20_000,
              false,
              true,
              fixture.recoveryRetainedKeys,
              legacyRetirementFileWaitOptions,
            );
            const record = {
              fixtureId,
              phase,
              loadCount,
              ...result,
              recovery: {
                ...recovery,
                canonicalAfterActivation: {
                  canonicalPresent: canonicalAfterActivation.canonicalPresent === true,
                  legacyRetainedCount: canonicalAfterActivation.requiredLegacyRetainedCount,
                },
                canonicalBeforeRecovery: {
                  canonicalPresent: canonicalBeforeRecovery.canonicalPresent === true,
                  legacyRetainedCount: canonicalBeforeRecovery.requiredLegacyRetainedCount,
                },
              },
              fault: legacyRetirementFault?.snapshot?.() || null,
            };
            appendLog("desktop-main", `[legacy-retirement] ${JSON.stringify(record)}\n`);
            console.log(`[legacy-retirement] ${JSON.stringify(record)}`);
            process.exitCode = 0;
            app.quit();
            return;
          }
          if (
            ((phase === "restart" || phase === "max-restart" || phase === "recovery-restart") && loadCount === 1)
          ) {
            completed = true;
            const result = await waitForLegacyRetirementFixture(
              window.webContents,
              fixture,
              phase === "max-restart" ? 90_000 : 20_000,
              false,
              false,
              [],
              legacyRetirementFileWaitOptions,
            );
            const record = {
              fixtureId,
              phase,
              loadCount,
              ...result,
              fault: legacyRetirementFault?.snapshot?.() || null,
            };
            appendLog(
              "desktop-main",
              `[legacy-retirement] ${JSON.stringify(record)}\n`,
            );
            console.log(`[legacy-retirement] ${JSON.stringify(record)}`);
            process.exitCode = 0;
            app.quit();
            return;
          }
          throw new Error(
            `旧浏览器副本退役夹具收到异常页面加载：fixture=${fixtureId || "missing"} phase=${phase || "missing"} loadCount=${loadCount}`,
          );
        } catch (error) {
          completed = true;
          appendLog(
            "desktop-main",
            `[legacy-retirement] failed ${error?.stack || error} fault=${JSON.stringify(legacyRetirementFault?.snapshot?.() || null)}\n`,
          );
          console.error(`[legacy-retirement] failed ${error?.stack || error}`);
          process.exitCode = 1;
          app.quit();
        }
      });
    }

    await window.loadURL(`app://${appHost}/index.html`);

    // `ready-to-show` is the preferred no-flash path, but Chromium can omit
    // that event after a GPU/process recovery. Never leave a successfully
    // loaded production window permanently hidden behind the tray.
    if (!isAutomationTest && !window.isDestroyed() && !window.isVisible()) {
      window.show();
      window.focus();
      appendLog(
        "desktop-main",
        "[window] initial show recovered after did-finish-load\n",
      );
    }

    if (!app.isPackaged && process.env.WANGZAI_DESKTOP_OPEN_DEVTOOLS === "1") {
      window.webContents.openDevTools({ mode: "detach" });
    }

    window.on("closed", () => {
      if (isDashboardVisualTest) {
        ipcMain.removeHandler("desktop:dashboard-visual-capture");
      }
      if (mainWindow === window) mainWindow = null;
    });
    return window;
  }

  function createIfAbsent(runtimeInfo) {
    if (BrowserWindow.getAllWindows().length === 0) return create(runtimeInfo);
    return getWindow();
  }

  function focus() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function getWindow() {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  }

  function setShellMode(mode) {
    const window = getWindow();
    if (!window || isAutomationTest) return { ok: false, mode: "automation" };
    const requestedMode = String(mode || "").trim().toLowerCase();
    const setCenteredBounds = (width, height) => {
      const display = screen.getDisplayMatching(window.getBounds());
      const workArea = display.workArea;
      const nextWidth = Math.min(width, workArea.width);
      const nextHeight = Math.min(height, workArea.height);
      window.setBounds({
        x: workArea.x + Math.max(0, Math.floor((workArea.width - nextWidth) / 2)),
        y: workArea.y + Math.max(0, Math.floor((workArea.height - nextHeight) / 2)),
        width: nextWidth,
        height: nextHeight,
      }, false);
    };
    if (requestedMode === "login") {
      if (window.isFullScreen()) window.setFullScreen(false);
      const wasMaximized = window.isMaximized();
      if (wasMaximized) window.unmaximize();
      const display = screen.getDisplayMatching(window.getBounds());
      window.setMinimumSize(
        Math.min(AUTH_WINDOW_MIN_WIDTH, display.workArea.width),
        Math.min(AUTH_WINDOW_MIN_HEIGHT, display.workArea.height),
      );
      window.setMaximizable(false);
      if (wasMaximized) {
        window.once("unmaximize", () => setCenteredBounds(AUTH_WINDOW_WIDTH, AUTH_WINDOW_HEIGHT));
        setTimeout(() => setCenteredBounds(AUTH_WINDOW_WIDTH, AUTH_WINDOW_HEIGHT), 80).unref?.();
      } else {
        setCenteredBounds(AUTH_WINDOW_WIDTH, AUTH_WINDOW_HEIGHT);
      }
      return { ok: true, mode: "login" };
    }
    if (requestedMode === "workspace") {
      const options = getInitialWindowOptions();
      window.setMinimumSize(options.minWidth, options.minHeight);
      window.setMaximizable(true);
      setCenteredBounds(options.width, options.height);
      return { ok: true, mode: "workspace" };
    }
    return { ok: false, mode: requestedMode, error: "WINDOW_MODE_INVALID" };
  }

  return Object.freeze({ create, createIfAbsent, focus, getWindow, setShellMode });
}
