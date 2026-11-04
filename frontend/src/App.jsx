import './app/bootstrap/serviceConfiguration.jsx';
import {
  getLocalApiRequestStats,
  listOzonNotifications,
  pollLocalSmartReplyNotifications,
  subscribeLocalApiRequestStats,
  testLocalShopConnection,
} from './api/localApiClient.js';
import {
  appendWorkspaceTabUnique,
  createWorkspaceTab,
  deduplicateWorkspaceTabs,
  Sidebar,
  WorkspaceTabs,
} from './app/shell/AppNavigation.jsx';
import { GlobalCustomerUnreadBadge } from './app/shell/GlobalCustomerUnreadBadge.jsx';
import { OzonPushRealtimeBridge } from './app/shell/OzonPushRealtimeBridge.jsx';
import { OrderSyncRealtimeBridge } from './app/shell/OrderSyncRealtimeBridge.jsx';
import { PurchaseBrowserQuickActions } from './app/shell/PurchaseBrowserQuickActions.jsx';
import { useOrderSidePanelFollow } from './app/shell/useOrderSidePanelFollow.js';
import { useWorkspaceScale } from './app/shell/workspaceScale.js';
import {
  getWorkspacePerformanceSnapshot,
  subscribeWorkspacePerformance,
  workspacePerformanceRuntime,
} from './app/performance/workspacePerformanceRuntime.js';
import { WorkspacePageSlot } from './app/performance/WorkspacePageSlot.jsx';
import {
  getOzonReadableShops,
  migrateLegacyMarketingActivityCacheStore,
} from './entities/order/orderShopScope.jsx';
import {
  hydrateOzonShopSettingsWithRetry,
  loadWatermarkSettingsFromLocalApi,
  readSavedActiveOzonShopId,
  readSavedOzonShops,
  saveOzonShopPreferences,
  saveOzonShopSettings,
} from './features/products/lib/productEditing.jsx';
import { loadFeePlanState } from './features/settings/lib/feeSettings.jsx';
import { loadLogisticsPricingSettings } from './services/logisticsPricingSettingsRuntime.js';
import ProductListPage from './features/products/ProductListPage.jsx';
import { startProductListHotCacheRuntime } from './features/products/services/productListHotCacheRuntime.js';
import PromptLibraryPage from './features/promptLibrary/PromptLibraryPage.jsx';
import { loadPromptLibraryStore } from './features/promptLibrary/lib/promptLibraryStore.jsx';
import { AccountRemovalPreviewDialog } from './features/settings/accountRemoval/components/AccountRemovalPreviewDialog.jsx';
import { CustomerGlobalUnreadBridge } from './features/customerConsultation/components/CustomerGlobalUnreadBridge.jsx';
import { useAccountRemovalFlow } from './features/settings/accountRemoval/model/useAccountRemovalFlow.js';
import { filterCompletedOzonOwner, subscribeAccountRemovalCompletion } from './features/settings/accountRemoval/services/accountRemovalCompletion.js';
import { startDataAnalysisMarketHotCacheRuntime } from './features/dataAnalysis/services/dataAnalysisMarketCacheService.js';
import { publishCollectionBrowserCapture } from './features/collectionPricing/services/collectionBrowserCaptureInbox.js';
import { getOzonRequestControlStats, subscribeOzonRequestStats } from './services/ozonRequestControl';
import { migrateLegacyPurchasePluginSourceContextAtStartup } from './entities/product/productLocalMirror.jsx';
import { hydrateProductMaterialProfilesFromLocalFile } from './services/productMaterialProfileStore';
import { migrateLegacyProductSourceLinksAtStartup } from './services/productSourceLinkStore.js';
import { migrateLegacyPurchaseSourceLinksAtStartup } from './services/purchaseSourceLinkStore.js';
import { migrateLegacyPurchaseOrderOverridesAtStartup } from './services/purchaseOrderRuntime.js';
import { migrateLegacySalesSourceLinksAtStartup } from './services/salesSourceLinkStore.js';
import { ensureOzonSearchCategoryCatalog } from './services/ozonSearch/ozonSearchQueryResolver.js';
import { safeWarn } from './services/safeLog';
import { invalidateOzonOrderSnapshotCachesForOwner } from './shared/config/appConfigRuntime.jsx';
import {
  drainOzonShopSettingsWrites,
  markOzonShopsLicenseChecking,
  persistOzonShopSettings,
  removeOzonShopSettingsMemorySlice,
} from './services/ozonShopSettingsStore.js';
import { hydrateCrossBorderSettingsFromLocalApi } from './shared/ozon/ozonRuntime.jsx';
import CloudSyncRounded from '@mui/icons-material/CloudSyncRounded';
import MenuRounded from '@mui/icons-material/MenuRounded';
import NotificationsRounded from '@mui/icons-material/NotificationsRounded';
import SettingsRounded from '@mui/icons-material/SettingsRounded';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';
import { DesktopAccountMenu } from './features/licensing/components/DesktopAccountMenu.jsx';
import { useDesktopUiUpdateHealth } from './features/licensing/model/useDesktopUiUpdateHealth.js';
import { getLicenseRuntime } from './features/licensing/services/licenseCenterClient.js';
import {
  applyOzonShopLicenseResolution,
  authorizeAdditionalShopSlot,
  authorizeOzonShopSave,
  createOzonShopLicenseIdentityKey,
  getOzonShopLicenseExpiration,
  resolveOzonShopLicenseStates,
  renewOzonShopLicense,
} from './features/licensing/services/shopLicenseEntitlementService.js';
import { MinimizedTaskBar } from './shared/ui/minimizedTasks/MinimizedTaskBar.jsx';
import { MinimizedTaskProvider } from './shared/ui/minimizedTasks/MinimizedTaskProvider.jsx';
import {
  markSettingsInteractionClosed,
  markSettingsInteractionOpen,
} from './shared/lib/settingsInteractionRuntime.js';
import {
  getProfitRefreshProgressSnapshot,
  subscribeProfitRefreshProgress,
} from './features/profit/model/profitRefreshProgressRuntime.js';
import {
  CollectionPricingPage,
  CustomerConsultationPage,
  DashboardPage,
  DataAnalysisPage,
  FollowSellerDefensePage,
  MarketingActivityPage,
  NotificationCenterPopover,
  PaidPromotionPage,
  PointsPackagesPage,
  PrintShippingPage,
  ProfitCalculationPage,
  ProfitReportPage,
  PurchaseOrdersPage,
  PurchaseRehearsalPage,
  SalesOrdersPage,
  SmartReplyPage,
  StatusObservationPopover,
  WarehouseLogisticsPage,
  lazyNamed,
  loadSalesOrdersPage,
} from "./appLazyRoutes.jsx";

const DataBackupPage = lazyNamed(() => import('./features/dataBackup/DataBackupPage.jsx'), 'DataBackupPage');
let shopSettingsDialogLoadPromise = null;

function loadShopSettingsDialog() {
  shopSettingsDialogLoadPromise ??= import('./features/settings/ShopSettingsDialog.jsx');
  return shopSettingsDialogLoadPromise;
}

const ShopSettingsDialog = lazyNamed(loadShopSettingsDialog, 'ShopSettingsDialog', 'settings');

function ShopSettingsController({
  shops,
  activeShopId,
  onSelect,
  onAdd,
  onRemove,
  onChange,
  onSave,
  onRenewLicense,
  onTest,
  onGetLicenseExpiration,
  onConfirmPurchaseBinding,
  onResetPurchaseBinding,
  accountRemovalBusy,
}) {
  const [open, setOpen] = React.useState(false);
  const [initialModule, setInitialModule] = React.useState('ozon');
  const initialModuleRef = React.useRef('ozon');
  const previousFocusRef = React.useRef(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleOpen = (event) => {
      const moduleId = String(event?.detail?.moduleId || 'ozon');
      previousFocusRef.current = document.activeElement;
      if (initialModuleRef.current !== moduleId) {
        initialModuleRef.current = moduleId;
        setInitialModule(moduleId);
      }
      React.startTransition(() => setOpen(true));
    };
    window.addEventListener('wangzai-settings-open', handleOpen);
    return () => window.removeEventListener('wangzai-settings-open', handleOpen);
  }, []);

  const handleClose = React.useCallback(() => {
    if (typeof window === 'undefined') return;
    setOpen(false);
    const restoreFocus = () => {
      const target = previousFocusRef.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
    };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(restoreFocus);
    else globalThis.setTimeout(restoreFocus, 0);
    markSettingsInteractionClosed();
    window.dispatchEvent(new Event('wangzai-settings-closed'));
  }, []);

  return (
    <React.Suspense fallback={null}>
      <ShopSettingsDialog
        open={open}
        onClose={handleClose}
        initialModule={initialModule}
        shops={shops}
        activeShopId={activeShopId}
        onSelect={onSelect}
        onAdd={onAdd}
        onRemove={onRemove}
        onChange={onChange}
        onSave={onSave}
        onRenewLicense={onRenewLicense}
        onTest={onTest}
        onGetLicenseExpiration={onGetLicenseExpiration}
        onConfirmPurchaseBinding={onConfirmPurchaseBinding}
        onResetPurchaseBinding={onResetPurchaseBinding}
        accountRemovalBusy={accountRemovalBusy}
        deferInitialRender
      />
    </React.Suspense>
  );
}

let afterSalesOrdersPageLoadPromise = null;

function loadAfterSalesOrdersPage() {
  afterSalesOrdersPageLoadPromise ??= import('./features/orders/afterSales/AfterSalesOrdersPage.jsx');
  return afterSalesOrdersPageLoadPromise;
}

const AfterSalesOrdersPage = lazyNamed(loadAfterSalesOrdersPage, 'AfterSalesOrdersPage');

function App() {
  useDesktopUiUpdateHealth();
  const accountRemoval = useAccountRemovalFlow();
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  const workspaceScale = useWorkspaceScale(sidebarOpen);
  const [currentPage, setCurrentPage] = React.useState('dashboard');
  const [activeWorkspacePage, setActiveWorkspacePage] = React.useState('dashboard');
  const [pendingWorkspacePage, setPendingWorkspacePage] = React.useState(null);
  const [preparingWorkspacePage, setPreparingWorkspacePage] = React.useState(null);
  const [dataAnalysisSkillConfig, setDataAnalysisSkillConfig] = React.useState(null);
  React.useEffect(() => startDataAnalysisMarketHotCacheRuntime({
    onError: (error) => safeWarn('[Ozon 市场热缓存] 后台刷新暂未就绪', error),
  }), []);
  React.useEffect(() => {
    ensureOzonSearchCategoryCatalog().catch((error) => {
      safeWarn('[Ozon 商品搜索] 共享类目目录预热失败，首次搜索时会自动重试', error);
    });
  }, []);
  React.useEffect(() => {
    let disposed = false;
    const prefetchRoute = () => {
      loadSalesOrdersPage()
        .then(() => {
          if (!disposed && typeof document !== 'undefined') {
            document.documentElement.dataset.wangzaiSalesOrdersRoute = 'ready';
          }
        })
        .catch(() => undefined);
      loadAfterSalesOrdersPage()
        .then(() => {
          if (!disposed && typeof document !== 'undefined') {
            document.documentElement.dataset.wangzaiAfterSalesOrdersRoute = 'ready';
          }
        })
        .catch(() => undefined);
    };
    // Route code is prefetched only after the dashboard's first paint. It never mounts the
    // page and therefore cannot start an Ozon or SQLite business read on its own.
    const timer = globalThis.setTimeout(prefetchRoute, 0);
    return () => {
      disposed = true;
      globalThis.clearTimeout(timer);
    };
  }, []);
  useOrderSidePanelFollow(`${currentPage}:${workspaceScale.scale}`);
  const [workspaceTabs, setWorkspaceTabs] = React.useState(() => [createWorkspaceTab('dashboard')]);
  const renderedWorkspaceTabs = React.useMemo(
    () => deduplicateWorkspaceTabs(workspaceTabs),
    [workspaceTabs]
  );
  React.useEffect(() => {
    if (!preparingWorkspacePage) return undefined;
    if (pendingWorkspacePage !== preparingWorkspacePage) return undefined;

    // Activate only after the isolated layout frame. The geometry and active effects
    // therefore cannot monopolize the same renderer task. This final wrapper-only swap
    // stays urgent so a completed local read cannot starve it behind transition work.
    const activate = () => {
      setCurrentPage(preparingWorkspacePage);
      setActiveWorkspacePage(preparingWorkspacePage);
      // Attribute/state cleanup is deliberately a later task; the visibility commit
      // only needs to swap the two `hidden` attributes.
      globalThis.setTimeout(() => {
        setPendingWorkspacePage((current) =>
          current === preparingWorkspacePage ? null : current
        );
        setPreparingWorkspacePage((current) =>
          current === preparingWorkspacePage ? null : current
        );
      }, 0);
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      const frameId = window.requestAnimationFrame(activate);
      return () => window.cancelAnimationFrame(frameId);
    }
    const timer = globalThis.setTimeout(activate, 0);
    return () => globalThis.clearTimeout(timer);
  }, [pendingWorkspacePage, preparingWorkspacePage]);
  React.useEffect(() => {
    // Settings is a primary shell action. Warm only its code chunk after the shell mounts;
    // no settings data is fetched and no modal DOM is created until the user opens it.
    void loadShopSettingsDialog();
  }, []);
  const [ozonShops, setOzonShops] = React.useState(() => (
    markOzonShopsLicenseChecking(readSavedOzonShops())
  ));
  const ozonShopsRef = React.useRef(ozonShops);
  ozonShopsRef.current = ozonShops;
  const readableOzonShops = React.useMemo(
    () => getOzonReadableShops(ozonShops),
    [ozonShops]
  );
  const shopLicenseIdentityKey = React.useMemo(
    () => createOzonShopLicenseIdentityKey(ozonShops),
    [ozonShops]
  );
  React.useEffect(() => {
    let cancelled = false;
    const snapshot = ozonShopsRef.current;
    getLicenseRuntime()
      .then((runtime) => resolveOzonShopLicenseStates(runtime, snapshot))
      .then((resolved) => {
        if (!cancelled) {
          setOzonShops((current) => applyOzonShopLicenseResolution(current, snapshot, resolved));
        }
      })
      .catch(() => {
        if (!cancelled) {
          const unavailable = snapshot.map((shop) => ({
            ...shop,
            licenseAuthorizationStatus: 'unavailable',
            licenseAuthorized: false,
            connectionStatus: '未授权',
            connectionMessage: '暂时无法确认当前店铺卡密，已停止连接 Ozon 和读取店铺数据。',
            connectionDetail: '',
          }));
          setOzonShops((current) => (
            applyOzonShopLicenseResolution(current, snapshot, unavailable)
          ));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [shopLicenseIdentityKey]);
  React.useEffect(() => {
    let disposed = false;
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.wangzaiAfterSalesOrdersCache = 'loading';
    }
    const timer = globalThis.setTimeout(() => {
      loadAfterSalesOrdersPage()
        .then((module) => {
          if (disposed) return null;
          return module.preloadAfterSalesOrdersLocalCache?.(readableOzonShops);
        })
        .then((snapshot) => {
          if (!disposed && typeof document !== 'undefined') {
            document.documentElement.dataset.wangzaiAfterSalesOrdersCache = snapshot ? 'ready' : 'waiting-for-shops';
            document.documentElement.dataset.wangzaiAfterSalesOrdersCacheRows = String(
              snapshot?.rows?.length ?? 0
            );
          }
        })
        .catch(() => undefined);
    }, 0);
    return () => {
      disposed = true;
      globalThis.clearTimeout(timer);
    };
  }, [readableOzonShops]);
  const [activeOzonShopId, setActiveOzonShopId] = React.useState(() =>
    readSavedActiveOzonShopId(readSavedOzonShops())
  );
  React.useEffect(() => subscribeAccountRemovalCompletion((event) => {
    if (event.type !== 'completed' || event.owner?.ownerType !== 'ozon_shop') return;
    setOzonShops((current) => {
      const remaining = filterCompletedOzonOwner(current, event);
      if (remaining === current) return current;
      const next = remaining.length ? remaining : [createEmptyOzonShop(`ozon-shop-${Date.now()}`, 1)];
      setActiveOzonShopId((active) => active === event.owner.ownerId ? next[0].id : active);
      return next;
    });
  }), []);
  const [followSellerShopId, setFollowSellerShopId] = React.useState(() => activeOzonShopId);
  React.useEffect(() => {
    setFollowSellerShopId((current) => {
      if (readableOzonShops.some((shop) => shop.id === current)) return current;
      if (readableOzonShops.some((shop) => shop.id === activeOzonShopId)) return activeOzonShopId;
      return readableOzonShops[0]?.id || '';
    });
  }, [activeOzonShopId, readableOzonShops]);
  React.useEffect(() => startProductListHotCacheRuntime({
    getShops: () => readableOzonShops,
    onError: (error) => safeWarn('[Ozon 商品列表热缓存] SQLite 预热暂未完成', error),
  }), [readableOzonShops]);
  const [syncStatsAnchorEl, setSyncStatsAnchorEl] = React.useState(null);
  const [ozonRequestStats, setOzonRequestStats] = React.useState(() => getOzonRequestControlStats());
  const [localApiRequestStats, setLocalApiRequestStats] = React.useState(() => getLocalApiRequestStats());
  const [workspacePerformanceStats, setWorkspacePerformanceStats] = React.useState(() => getWorkspacePerformanceSnapshot());
  const [profitRefreshProgress, setProfitRefreshProgress] = React.useState(() => getProfitRefreshProgressSnapshot());
  const [notificationAnchorEl, setNotificationAnchorEl] = React.useState(null);
  const [backendNotificationUnreadCount, setBackendNotificationUnreadCount] = React.useState(0);
  const [customerUnreadSummary, setCustomerUnreadSummary] = React.useState({
    unreadCount: 0,
    shopCount: 0,
    latest: null,
  });
  const [customerUnreadRefreshRequest, setCustomerUnreadRefreshRequest] = React.useState(null);
  const [customerConversationOpenTarget, setCustomerConversationOpenTarget] = React.useState(null);
  const customerUnreadRefreshSequenceRef = React.useRef(0);
  const [profitLocalInputsRefreshTick, setProfitLocalInputsRefreshTick] = React.useState(0);
  const [ozonPushRealtimeTick, setOzonPushRealtimeTick] = React.useState(0);
  const [ozonPushOrderRefreshTick, setOzonPushOrderRefreshTick] = React.useState(0);
  const syncStatsOpen = Boolean(syncStatsAnchorEl);

  React.useEffect(() => {
    if (!syncStatsOpen) return undefined;
    return subscribeOzonRequestStats(setOzonRequestStats);
  }, [syncStatsOpen]);
  React.useEffect(() => {
    if (!syncStatsOpen) return undefined;
    return subscribeLocalApiRequestStats(setLocalApiRequestStats);
  }, [syncStatsOpen]);
  React.useEffect(() => subscribeProfitRefreshProgress(setProfitRefreshProgress), []);
  React.useEffect(() => {
    if (!syncStatsOpen) return undefined;
    return subscribeWorkspacePerformance(setWorkspacePerformanceStats);
  }, [syncStatsOpen]);
  React.useEffect(() => workspacePerformanceRuntime.startLongTaskObserver(), []);

  React.useEffect(() => {
    hydrateCrossBorderSettingsFromLocalApi({}).catch((error) => {
      safeWarn('[跨境设置] 本机 SQLite 读取失败', error);
    });
  }, []);

  React.useEffect(() => {
    loadLogisticsPricingSettings().catch((error) => {
      safeWarn('[物流预估设置] 本机 SQLite 读取失败', error);
    });
  }, []);

  React.useEffect(() => {
    migrateLegacyPurchasePluginSourceContextAtStartup().catch((error) => {
      safeWarn('[采购插件上下文] 本地迁移失败，已保留旧副本', error);
    });
  }, []);

  React.useEffect(() => {
    loadWatermarkSettingsFromLocalApi().catch((error) => {
      safeWarn('[水印设置] 本机 SQLite 读取失败', error);
    });
  }, []);

  React.useEffect(() => {
    loadPromptLibraryStore().catch((error) => {
      safeWarn('[智能工具] 本机 SQLite 工具库读取失败', error);
    });
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    hydrateOzonShopSettingsWithRetry({
      signal: controller.signal,
      timeoutMs: 5000,
      maxAttempts: Number.POSITIVE_INFINITY,
      onAttemptFailure: (error, attempt) => {
        if (attempt === 1 || attempt === 3 || attempt % 10 === 0) {
          safeWarn(`[Ozon 店铺] 本机店铺读取第 ${attempt} 次失败，正在自动重试`, error);
        }
      },
    })
      .then((store) => {
        if (cancelled) return;
        setOzonShops(markOzonShopsLicenseChecking(store.shops));
        setActiveOzonShopId(store.activeShopId);
        return Promise.all([
          migrateLegacyMarketingActivityCacheStore({ shops: store.shops }).catch((error) => {
            safeWarn('[营销活动] 本地迁移失败，已保留旧副本', error);
          }),
          hydrateProductMaterialProfilesFromLocalFile().catch((error) => {
            safeWarn('[商品材积] 本地迁移失败，已保留旧副本', error);
          }),
          migrateLegacyProductSourceLinksAtStartup(store.shops).catch((error) => {
            safeWarn('[商品来源链接] 本地迁移失败，已保留旧副本', error);
          }),
          migrateLegacyPurchaseSourceLinksAtStartup(store.shops).catch((error) => {
            safeWarn('[采购来源链接] 本地迁移失败，已保留旧副本', error);
          }),
          migrateLegacyPurchaseOrderOverridesAtStartup().catch((error) => {
            safeWarn('[采购订单手工覆盖] 本地迁移失败，已保留旧副本', error);
          }),
          migrateLegacySalesSourceLinksAtStartup(store.shops).catch((error) => {
            safeWarn('[销售来源链接] 本地迁移失败，已保留旧副本', error);
          }),
        ]);
      })
      .catch((error) => {
        if (error?.name === 'AbortError') return;
        safeWarn('[Ozon 店铺] 本地文件读取失败', error);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  React.useEffect(() => {
    loadFeePlanState().catch((error) => {
      safeWarn('[费用设置] 本机 SQLite 读取失败', error);
    });
  }, []);

  const navigateWorkspacePage = React.useCallback((pageId) => {
    if (currentPage === pageId) {
      setPendingWorkspacePage(null);
      setPreparingWorkspacePage(null);
      return false;
    }
    workspacePerformanceRuntime.beginNavigation(pageId);
    // Existing workspaces are already mounted and laid out. Commit their two `hidden`
    // attribute changes in the click batch instead of queueing a transition that can be
    // repeatedly deferred during rapid tab switching.
    setPendingWorkspacePage(null);
    setPreparingWorkspacePage(null);
    setCurrentPage(pageId);
    React.startTransition(() => setActiveWorkspacePage(pageId));
    return true;
  }, [currentPage]);

  const openWorkspacePage = React.useCallback((pageId) => {
    const nextTab = createWorkspaceTab(pageId);
    if (!nextTab) return;

    if (currentPage === pageId) return;
    if (renderedWorkspaceTabs.some((tab) => tab.id === pageId)) {
      navigateWorkspacePage(pageId);
      return;
    }
    workspacePerformanceRuntime.beginNavigation(pageId);
    // Commit the new tab and its hidden active tree together. The activation effect
    // still waits for the next frame, so hidden construction and visibility layout
    // remain separate without wasting an empty preparation frame.
    React.startTransition(() => {
      // The closure above can be stale while rapid clicks are batched. The
      // functional update is the authoritative duplicate fence.
      setWorkspaceTabs((current) => appendWorkspaceTabUnique(current, nextTab));
      setPendingWorkspacePage(pageId);
      setPreparingWorkspacePage(pageId);
    });
  }, [currentPage, navigateWorkspacePage, renderedWorkspaceTabs]);

  const openDataAnalysisFromSkill = React.useCallback((options = {}) => {
    setDataAnalysisSkillConfig(options || null);
    openWorkspacePage('data-analysis');
  }, [openWorkspacePage]);

  const openShopSettingsModule = React.useCallback((moduleId = 'ozon') => {
    if (typeof window === 'undefined') return;
    markSettingsInteractionOpen();
    window.dispatchEvent(new CustomEvent('wangzai-settings-open', { detail: { moduleId } }));
  }, []);

  const selectWorkspaceTab = React.useCallback(
    (pageId) => {
      if (renderedWorkspaceTabs.some((tab) => tab.id === pageId)) {
        navigateWorkspacePage(pageId);
        return;
      }
      openWorkspacePage(pageId);
    },
    [navigateWorkspacePage, openWorkspacePage, renderedWorkspaceTabs]
  );

  React.useEffect(() => {
    const browserOnEvent = globalThis.window?.wangzaiDesktop?.purchaseBrowser?.onEvent;
    if (typeof browserOnEvent !== 'function') return undefined;
    return browserOnEvent((payload = {}) => {
      if (payload.event === 'cross-border-charges-committed') {
        if (payload?.summary?.readbackVerified === true) {
          setProfitLocalInputsRefreshTick((current) => current + 1);
        }
        return;
      }
      if (payload.event === 'collection-pricing-captured') {
        if (!publishCollectionBrowserCapture(payload.capture)) return;
        selectWorkspaceTab('collection-pricing');
      }
    });
  }, [selectWorkspaceTab]);

  React.useEffect(() => {
    const refreshProfitLocalInputs = () => {
      setProfitLocalInputsRefreshTick((current) => current + 1);
    };
    window.addEventListener('wangzai-cross-border-charges-revalued', refreshProfitLocalInputs);
    return () => {
      window.removeEventListener('wangzai-cross-border-charges-revalued', refreshProfitLocalInputs);
    };
  }, []);

  const closeWorkspaceTab = React.useCallback(
    (pageId) => {
      if (pageId === 'dashboard') return;

      const tabIndex = renderedWorkspaceTabs.findIndex((tab) => tab.id === pageId);
      if (tabIndex === -1) return;

      const nextTabs = renderedWorkspaceTabs.filter((tab) => tab.id !== pageId);

      if (currentPage === pageId) {
        const fallbackTab = nextTabs[Math.min(tabIndex, nextTabs.length - 1)] ?? nextTabs[0];
        const fallbackPageId = fallbackTab?.id ?? 'dashboard';
        workspacePerformanceRuntime.beginNavigation(fallbackPageId);
        React.startTransition(() => {
          setPendingWorkspacePage(null);
          setPreparingWorkspacePage(null);
          setWorkspaceTabs(nextTabs);
          setCurrentPage(fallbackPageId);
          setActiveWorkspacePage(fallbackPageId);
        });
        return;
      }
      setPendingWorkspacePage((current) => (current === pageId ? null : current));
      setPreparingWorkspacePage((current) => (current === pageId ? null : current));
      setWorkspaceTabs(nextTabs);
    },
    [currentPage, renderedWorkspaceTabs]
  );

  const refreshBackendNotificationUnreadCount = React.useCallback(() => {
    const shopIds = readableOzonShops.map((shop) => String(shop?.id || '').trim()).filter(Boolean);
    if (!shopIds.length) {
      setBackendNotificationUnreadCount(0);
      return;
    }
    listOzonNotifications({ read: 'unread', limit: 1, shopIds: shopIds.join(',') }, { timeoutMs: 8000 })
      .then((payload) => {
        if (payload?.ok !== false) {
          setBackendNotificationUnreadCount(Number(payload?.unread) || 0);
          if (Number(payload?.unread) > 0) {
            void pollLocalSmartReplyNotifications({ timeoutMs: 5000 }).catch(() => undefined);
          }
        }
      })
      .catch(() => undefined);
  }, [readableOzonShops]);

  const handleOzonPushRealtimeEvent = React.useCallback((event = {}) => {
    if (event.stage === 'accepted') {
      setOzonPushRealtimeTick((current) => current + 1);
      refreshBackendNotificationUnreadCount();
    }
    if (event.stage === 'refreshed' && ['orders', 'returns'].includes(event.domain)) {
      const shop = readableOzonShops.find((item) => String(item?.id || '').trim() === String(event.shopId || '').trim());
      if (shop) invalidateOzonOrderSnapshotCachesForOwner(shop, event.domain);
      if (event.domain === 'orders') {
        setOzonPushOrderRefreshTick((current) => current + 1);
        setProfitLocalInputsRefreshTick((current) => current + 1);
      }
    }
  }, [readableOzonShops, refreshBackendNotificationUnreadCount]);

  React.useEffect(() => {
    refreshBackendNotificationUnreadCount();
    const timer = window.setInterval(refreshBackendNotificationUnreadCount, 30000);
    return () => window.clearInterval(timer);
  }, [refreshBackendNotificationUnreadCount]);

  const selectActiveOzonShop = React.useCallback((shopId) => {
    setActiveOzonShopId(shopId);
    saveOzonShopPreferences(ozonShops, shopId);
  }, [ozonShops]);

  const handleCustomerUnreadChange = React.useCallback((snapshot = {}) => {
    const { shopId = '' } = snapshot;
    const normalizedShopId = String(shopId || '').trim();
    if (!normalizedShopId) return;
    customerUnreadRefreshSequenceRef.current += 1;
    setCustomerUnreadRefreshRequest({
      ...snapshot,
      shopId: normalizedShopId,
      sequence: customerUnreadRefreshSequenceRef.current,
    });
  }, []);

  const openLatestCustomerMessage = React.useCallback(() => {
    const latest = customerUnreadSummary.latest;
    if (!latest?.shopId || (!latest.chatId && !latest.conversationId)) return;
    if (latest.shopId !== activeOzonShopId) selectActiveOzonShop(latest.shopId);
    setCustomerConversationOpenTarget({
      ...latest,
      requestId: `${Date.now()}-${latest.shopId}-${latest.chatId || latest.conversationId}`,
    });
    selectWorkspaceTab('customer-consultation');
  }, [activeOzonShopId, customerUnreadSummary.latest, selectActiveOzonShop, selectWorkspaceTab]);

  const updateShopSetting = (field, value) => {
    setOzonShops((current) =>
      current.map((shop) => {
        if (shop.id !== activeOzonShopId) return shop;
        const shouldResetConnection = field === 'clientId' || field === 'apiKey';
        return {
              ...shop,
              [field]: value,
              ...(shouldResetConnection
                ? {
                    connectionStatus: '未测试',
                    connectionMessage: '密钥信息已修改，请重新测试连接',
                    connectionDetail: '',
                    lastTestAt: '',
                  }
                : {}),
        };
      })
    );
  };

  const saveShopSettings = async () => {
    const savedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const activeShop = ozonShops.find((shop) => shop.id === activeOzonShopId);
    if (!activeShop) throw new Error('未找到当前 Ozon 店铺。');
    const runtime = await getLicenseRuntime();
    await authorizeOzonShopSave(runtime, activeShop);
    const next = ozonShops.map((shop) => (
      shop.id === activeOzonShopId ? { ...shop, savedAt } : shop
    ));
    const canonical = await persistOzonShopSettings(next, activeOzonShopId);
    const resolved = await resolveOzonShopLicenseStates(runtime, canonical.shops);
    setOzonShops(resolved);
    setActiveOzonShopId(canonical.activeShopId);
  };

  const readOzonShopLicenseExpiration = React.useCallback(async (shop) => {
    const runtime = await getLicenseRuntime();
    return getOzonShopLicenseExpiration(runtime, shop);
  }, []);

  const renewActiveOzonShopLicense = React.useCallback(async ({ cardKey = '', shopId = '' } = {}) => {
    const targetShopId = String(shopId || activeOzonShopId).trim();
    const targetShop = ozonShops.find((shop) => shop.id === targetShopId);
    if (!targetShop) throw new Error('未找到当前 Ozon 店铺。');
    const runtime = await getLicenseRuntime();
    const result = await renewOzonShopLicense(runtime, targetShop, cardKey);
    const resolved = await resolveOzonShopLicenseStates(runtime, ozonShops);
    setOzonShops(resolved);
    return result;
  }, [activeOzonShopId, ozonShops]);

  const confirmPurchaseManagementBinding = () => {
    const startedAt = new Date().toISOString();
    setOzonShops((current) => {
      const next = current.map((shop) =>
        shop.id === activeOzonShopId
          ? {
              ...shop,
              purchaseManagementStartedAt: startedAt,
              purchaseManagementResetAt: '',
            }
          : shop
      );
      saveOzonShopSettings(next, activeOzonShopId);
      return next;
    });
  };

  const resetPurchaseManagementBinding = () => {
    const resetAt = new Date().toISOString();
    setOzonShops((current) => {
      const next = current.map((shop) =>
        shop.id === activeOzonShopId
          ? {
              ...shop,
              purchaseManagementStartedAt: '',
              purchaseManagementResetAt: resetAt,
            }
          : shop
      );
      saveOzonShopSettings(next, activeOzonShopId);
      return next;
    });
  };

  const createEmptyOzonShop = (shopId, index = 1) => ({
    id: shopId,
    shopAlias: `Ozon ${index}店`,
    sellerName: '',
    clientId: '',
    apiKey: '',
    connectionStatus: '未测试',
    connectionMessage: '填写 Client ID 和 API Key 后可以测试连接',
    connectionDetail: '',
    lastTestAt: '',
    savedAt: '',
    purchaseManagementStartedAt: '',
    purchaseManagementResetAt: '',
    remark: '',
    licenseAuthorizationStatus: 'pending-binding',
    licenseAuthorized: false,
  });

  const addOzonShop = async ({ cardKey = '' } = {}) => {
    const incompleteShop = ozonShops.find((shop) => (
      !(shop?.hasClientId || String(shop?.clientId || '').trim())
      || !(shop?.hasApiKey || String(shop?.apiKey || '').trim())
    ));
    if (incompleteShop) {
      const error = new Error('当前已有一个未完成的店铺，请先填写并保存 Client ID 和 API Key，再新增下一个店铺。');
      error.code = 'INCOMPLETE_OZON_SHOP_EXISTS';
      throw error;
    }
    const runtime = await getLicenseRuntime();
    const authorization = await authorizeAdditionalShopSlot(runtime, cardKey);
    const nextId = `ozon-shop-${Date.now()}`;
    setOzonShops((current) => {
      const next = [...current, createEmptyOzonShop(nextId, current.length + 1)];
      saveOzonShopPreferences(next, nextId);
      return next;
    });
    setActiveOzonShopId(nextId);
    return authorization;
  };

  const removeOzonShop = (shopId) => {
    const normalizedShopId = String(shopId || '').trim();
    if (!normalizedShopId) return;
    const removeFromView = () => {
      setOzonShops((current) => {
        const remaining = current.filter((shop) => shop.id !== normalizedShopId);
        const replacementId = `ozon-shop-${Date.now()}`;
        const next = remaining.length > 0 ? remaining : [createEmptyOzonShop(replacementId, 1)];
        setActiveOzonShopId((currentActiveId) => (
          normalizedShopId === currentActiveId || !next.some((shop) => shop.id === currentActiveId)
            ? next[0].id
            : currentActiveId
        ));
        return next;
      });
    };
    return accountRemoval.deleteAccountDirectly({ ownerType: 'ozon_shop', ownerId: normalizedShopId }, {
      beforePreview: () => drainOzonShopSettingsWrites(),
      onCompleted: removeFromView,
      onMissing: () => {
        removeOzonShopSettingsMemorySlice(normalizedShopId);
        removeFromView();
      },
    });
  };

  const testOzonShopConnection = async () => {
    const testedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const activeShop = ozonShops.find((shop) => shop.id === activeOzonShopId);
    if (!activeShop) return;

    const hasClientId = Boolean(String(activeShop?.clientId || '').trim() || activeShop?.hasClientId === true);
    const hasApiKey = Boolean(String(activeShop?.apiKey || '').trim() || activeShop?.hasApiKey === true);
    if (!hasClientId || !hasApiKey) {
      setOzonShops((current) =>
        current.map((shop) =>
          shop.id === activeOzonShopId
            ? {
                ...shop,
                connectionStatus: '缺少信息',
                connectionMessage: '请完整填写 Client ID 和 API Key；测试时会先加密保存，再连接 Ozon。',
                connectionDetail: '',
                lastTestAt: testedAt,
              }
            : shop
        )
      );
      return;
    }

    setOzonShops((current) =>
      current.map((shop) =>
        shop.id === activeOzonShopId
          ? {
              ...shop,
              connectionStatus: '测试中',
              connectionMessage: '正在直连 Ozon 只读接口',
              connectionDetail: '',
              lastTestAt: testedAt,
            }
          : shop
      )
    );

    let authorizedBeforeTest = false;
    let savedBeforeTest = false;
    try {
      // A newly-added shop owns an activated but still-unbound shop card until
      // its Ozon Client ID is known.  Testing is also an explicit persistence
      // action, so bind that pending card before the local encrypted save.
      // Otherwise the local service correctly rejects the credentials as an
      // unlicensed shop and the Ozon request is never reached.
      const runtime = await getLicenseRuntime();
      await authorizeOzonShopSave(runtime, activeShop);
      authorizedBeforeTest = true;
      const savedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const shopsForTest = ozonShops.map((shop) => (
        shop.id === activeShop.id ? { ...shop, savedAt } : shop
      ));
      const canonical = await persistOzonShopSettings(shopsForTest, activeShop.id);
      savedBeforeTest = true;
      const licensedShops = await resolveOzonShopLicenseStates(runtime, canonical.shops);
      setOzonShops(licensedShops);

      const connection = await testLocalShopConnection(activeShop.id, { timeoutMs: 30000 });
      if (!connection?.ok || !connection?.connected) {
        throw new Error(connection?.error?.message || 'Ozon 店铺连接测试失败。');
      }
      const roles = connection.roles;
      const sellerInfo = connection.sellerInfo;
      const rolesCount = Array.isArray(roles?.result?.roles)
        ? roles.result.roles.length
        : Array.isArray(roles?.roles)
          ? roles.roles.length
          : null;
      const sellerName =
        sellerInfo?.result?.name ||
        sellerInfo?.result?.seller_name ||
        sellerInfo?.name ||
        activeShop.sellerName ||
        activeShop.shopAlias;

      setOzonShops((current) =>
        current.map((shop) =>
          shop.id === activeOzonShopId
            ? {
                ...shop,
                sellerName,
                connectionStatus: '连接成功',
                connectionMessage: '已通过 local-api 读取 Ozon 店铺信息',
                connectionDetail:
                  rolesCount === null
                    ? 'roles 和 seller/info 均返回成功'
                    : `roles 和 seller/info 均返回成功；权限数量：${rolesCount}`,
                lastTestAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
              }
            : shop
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedStage = !authorizedBeforeTest ? 'authorize' : !savedBeforeTest ? 'save' : '';
      const isAuthenticationFailure = error?.code === 'OZON_AUTHENTICATION_FAILED';
      const isCorsLike =
        message.includes('Failed to fetch') ||
        message.includes('NetworkError') ||
        message.includes('Load failed');
      setOzonShops((current) =>
        current.map((shop) =>
          shop.id === activeOzonShopId
            ? {
                ...shop,
                connectionStatus: { authorize: '授权未通过', save: '保存失败' }[failedStage]
                  || (isCorsLike ? '浏览器拦截' : isAuthenticationFailure ? '鉴权失败' : '连接失败'),
                connectionMessage: {
                  authorize: '店铺卡密授权未通过，尚未保存，也未向 Ozon 发起测试',
                  save: '本地保存失败，尚未向 Ozon 发起测试',
                }[failedStage] || (isCorsLike
                  ? '浏览器可能拦截了跨域请求'
                  : isAuthenticationFailure ? '请更换有效的 API Key 后重新测试' : 'Ozon 返回了错误'),
                connectionDetail: isCorsLike
                  ? '直连失败：浏览器 CORS 或网络拦截。最快可继续用后端代理解决。'
                  : message,
                lastTestAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
              }
            : shop
        )
      );
    }
  };

  const renderWorkspacePage = React.useCallback((pageId, isActive = false, isVisible = isActive) => {
    if (pageId === 'sales-orders') {
      return (
        <SalesOrdersPage
          shops={readableOzonShops}
          activeShopId={activeOzonShopId}
          isActive={isActive}
          initialStatus="all"
          viewTitle="销售订单"
          viewDescription="查看 Ozon 销售订单、佣金、货源成本和跨境巴士信息"
        />
      );
    }
    if (pageId === 'print-shipping') {
      return (
        <PrintShippingPage
          shops={readableOzonShops}
          activeShopId={activeOzonShopId}
          isActive={isActive}
        />
      );
    }
    if (['pending-orders', 'after-sales-orders'].includes(pageId)) {
      return (
        <AfterSalesOrdersPage
          shops={readableOzonShops}
          activeShopId={activeOzonShopId}
          isActive={isActive}
          pendingOnly={pageId === 'pending-orders'}
        />
      );
    }
    if (pageId === 'purchase-orders') {
      return (
        <PurchaseOrdersPage
          shops={readableOzonShops}
          activeShopId={activeOzonShopId}
          isActive={isActive}
        />
      );
    }
    if (pageId === 'inventory') {
      return (
        <MarketingActivityPage
          shops={readableOzonShops}
          activeShopId={activeOzonShopId}
          isActive={isActive}
          showReadNotice={isActive}
        />
      );
    }
    if (pageId === 'paid-promotion') {
      return (
        <PaidPromotionPage
          shops={readableOzonShops}
          activeShopId={activeOzonShopId}
          isActive={isActive}
          onNotificationsRefresh={refreshBackendNotificationUnreadCount}
        />
      );
    }
    if (pageId === 'data-analysis') {
      return (
        <DataAnalysisPage
          shops={readableOzonShops}
          activeShopId={activeOzonShopId}
          isActive={isActive}
          skillConfig={dataAnalysisSkillConfig}
        />
      );
    }
    if (pageId === 'data-backup') {
      return <DataBackupPage shops={ozonShops} activeShopId={activeOzonShopId} isActive={isActive} />;
    }
    if (pageId === 'customer-consultation') {
      return (
        <CustomerConsultationPage
          shops={readableOzonShops}
          activeShopId={activeOzonShopId}
          isActive={isActive}
          onActiveShopChange={selectActiveOzonShop}
          openTarget={customerConversationOpenTarget}
          onUnreadChange={handleCustomerUnreadChange}
        />
      );
    }
    if (pageId === 'smart-reply') {
      return (
        <SmartReplyPage
          shops={readableOzonShops}
          activeShopId={activeOzonShopId}
          isActive={isActive}
        />
      );
    }
    if (pageId === 'shipping') {
      return (
        <ProfitCalculationPage
          shops={readableOzonShops}
          activeShopId={activeOzonShopId}
          isActive={isActive}
          externalRefreshTick={ozonPushOrderRefreshTick}
          localInputsRefreshTick={profitLocalInputsRefreshTick}
        />
      );
    }
    if (pageId === 'profit-report') {
      return (
        <ProfitReportPage
          shops={readableOzonShops}
          activeShopId={activeOzonShopId}
          isActive={isActive}
        />
      );
    }
    if (pageId === 'warehouse-logistics') {
      return (
        <WarehouseLogisticsPage
          shops={readableOzonShops}
          activeShopId={activeOzonShopId}
          isActive={isActive}
          onActiveShopChange={selectActiveOzonShop}
        />
      );
    }
    if (pageId === 'collection-pricing') {
      return (
        <CollectionPricingPage
          shops={readableOzonShops}
          activeShopId={activeOzonShopId}
          onActiveShopChange={selectActiveOzonShop}
        />
      );
    }
    if (pageId === 'purchase-rehearsal') {
      return <PurchaseRehearsalPage shops={readableOzonShops} isActive={isActive} />;
    }
    if (pageId === 'points-packages') {
      return <PointsPackagesPage />;
    }
    if (pageId === 'prompt-library') {
      return (
        <PromptLibraryPage
          shops={readableOzonShops}
          activeShopId={activeOzonShopId}
          onActiveShopChange={selectActiveOzonShop}
          onOpenSettingsModule={openShopSettingsModule}
          onOpenDataAnalysis={openDataAnalysisFromSkill}
        />
      );
    }
    if (pageId === 'products') {
      return (
        <ProductListPage
          shops={readableOzonShops}
          activeShopId={activeOzonShopId}
          isActive={isActive}
          isVisible={isVisible}
        />
      );
    }
    if (pageId === 'follow-seller-defense') {
      return (
        <FollowSellerDefensePage
          shops={readableOzonShops}
          activeShopId={followSellerShopId}
          isActive={isActive}
          onActiveShopChange={setFollowSellerShopId}
        />
      );
    }

    return <DashboardPage shops={readableOzonShops} sidebarOpen={sidebarOpen} isActive={isActive} />;
  }, [
    activeOzonShopId,
    customerConversationOpenTarget,
    handleCustomerUnreadChange,
    openShopSettingsModule,
    openDataAnalysisFromSkill,
    dataAnalysisSkillConfig,
    followSellerShopId,
    profitLocalInputsRefreshTick,
    ozonPushOrderRefreshTick,
    ozonShops,
    readableOzonShops,
    refreshBackendNotificationUnreadCount,
    selectActiveOzonShop,
    sidebarOpen,
  ]);

  const notificationsOpen = Boolean(notificationAnchorEl);
  const notificationBadgeCount = backendNotificationUnreadCount;
  const appRootClassName = `app-root${currentPage === 'customer-consultation' ? ' customer-consultation-active' : ''}`;

  return (
    <MinimizedTaskProvider>
      <CustomerGlobalUnreadBridge
        shops={readableOzonShops}
        snapshotRequest={customerUnreadRefreshRequest}
        onChange={setCustomerUnreadSummary}
      />
      <OzonPushRealtimeBridge
        shops={readableOzonShops}
        onEvent={handleOzonPushRealtimeEvent}
      />
      <OrderSyncRealtimeBridge
        shops={readableOzonShops}
        onEvent={handleOzonPushRealtimeEvent}
      />
      <Box className={appRootClassName}>
      <Sidebar
        currentPage={currentPage}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNavigate={openWorkspacePage}
      />
      <Box className={`main-shell${sidebarOpen ? ' sidebar-open' : ''}`}>
        <Box className="workspace-scale-viewport">
          <Box
            className="workspace-scale-surface"
            data-workspace-scale={workspaceScale.scale}
            data-workspace-design-width={workspaceScale.designWidth}
            data-workspace-design-height={workspaceScale.designHeight}
            style={{
              width: `${workspaceScale.designWidth}px`,
              minHeight: `${workspaceScale.designHeight}px`,
              '--workspace-design-height': `${workspaceScale.designHeight}px`,
              zoom: workspaceScale.scale,
            }}
          >
            <Toolbar className="topbar">
              {!sidebarOpen ? (
                <IconButton onClick={() => setSidebarOpen(true)} aria-label="展开导航栏">
                  <MenuRounded />
                </IconButton>
              ) : null}
              <WorkspaceTabs
                tabs={renderedWorkspaceTabs}
                currentPage={currentPage}
                onSelect={selectWorkspaceTab}
                onClose={closeWorkspaceTab}
              />
              <Stack direction="row" spacing={1} alignItems="center" ml="auto">
                <PurchaseBrowserQuickActions />
                <Tooltip title="运行状态">
                  <IconButton
                    className="top-icon"
                    aria-label="运行状态"
                    onClick={(event) => setSyncStatsAnchorEl(event.currentTarget)}
                  >
                    <CloudSyncRounded />
                  </IconButton>
                </Tooltip>
                <Tooltip title="通知">
                  <IconButton
                    className="top-icon"
                    aria-label="通知"
                    onClick={(event) => {
                      setNotificationAnchorEl(event.currentTarget);
                      refreshBackendNotificationUnreadCount();
                    }}
                  >
                    <Badge color="error" badgeContent={notificationBadgeCount} max={99}>
                      <NotificationsRounded />
                    </Badge>
                  </IconButton>
                </Tooltip>
                <Tooltip title="设置">
                  <IconButton
                    className="top-icon"
                    aria-label="设置"
                    disableRipple
                    onClick={() => openShopSettingsModule('ozon')}
                  >
                    <SettingsRounded />
                  </IconButton>
                </Tooltip>
                <DesktopAccountMenu />
              </Stack>
            </Toolbar>
            {syncStatsOpen ? (
              <React.Suspense fallback={null}>
                <StatusObservationPopover
                  open={syncStatsOpen}
                  anchorEl={syncStatsAnchorEl}
                  onClose={() => setSyncStatsAnchorEl(null)}
                  ozonRequestStats={ozonRequestStats}
                  localApiRequestStats={localApiRequestStats}
                  workspacePerformanceStats={workspacePerformanceStats}
                  profitRefreshProgress={profitRefreshProgress}
                />
              </React.Suspense>
            ) : null}
            {notificationsOpen ? (
              <React.Suspense fallback={null}>
                <NotificationCenterPopover
                  open={notificationsOpen}
                  anchorEl={notificationAnchorEl}
                  onClose={() => setNotificationAnchorEl(null)}
                  shops={readableOzonShops}
                  activeShopId={activeOzonShopId}
                  onUnreadChange={setBackendNotificationUnreadCount}
                  realtimeTick={ozonPushRealtimeTick}
                />
              </React.Suspense>
            ) : null}

            <Box
              component="main"
              className={`content-shell${currentPage === 'paid-promotion' ? ' paid-promotion-content-shell' : ''}${currentPage === 'purchase-rehearsal' ? ' purchase-rehearsal-content-shell' : ''}${currentPage === 'profit-report' ? ' profit-report-content-shell' : ''}`}
            >
              <Box className="page-stack">
                {renderedWorkspaceTabs.map((tab) => {
                  const isVisible = currentPage === tab.id;
                  const isActive = activeWorkspacePage === tab.id;
                  const isPreparing = preparingWorkspacePage === tab.id;
                  return (
                    <WorkspacePageSlot
                      key={tab.id}
                      pageId={tab.id}
                      isActive={isActive}
                      isVisible={isVisible}
                      isPreparing={isPreparing}
                      renderPage={renderWorkspacePage}
                    />
                  );
                })}
              </Box>
            </Box>
          </Box>
        </Box>
      </Box>
      <ShopSettingsController
        shops={ozonShops}
        activeShopId={activeOzonShopId}
        onSelect={selectActiveOzonShop}
        onAdd={addOzonShop}
        onRemove={removeOzonShop}
        onChange={updateShopSetting}
        onSave={saveShopSettings}
        onRenewLicense={renewActiveOzonShopLicense}
        onTest={testOzonShopConnection}
        onGetLicenseExpiration={readOzonShopLicenseExpiration}
        onConfirmPurchaseBinding={confirmPurchaseManagementBinding}
        onResetPurchaseBinding={resetPurchaseManagementBinding}
        accountRemovalBusy={accountRemoval.flow.open || accountRemoval.busy}
      />
        <AccountRemovalPreviewDialog
          flow={accountRemoval.flow}
          busy={accountRemoval.busy}
          onConfirm={accountRemoval.confirmRemoval}
          onExportBackup={accountRemoval.exportBackupBeforeRemoval}
          onUseRecentBackup={accountRemoval.useRecentBackupBeforeRemoval}
          onSkipBackup={accountRemoval.skipBackupBeforeRemoval}
          onRefresh={accountRemoval.refreshPreview}
          onClose={accountRemoval.closeAccountRemoval}
        />
        <MinimizedTaskBar />
        <GlobalCustomerUnreadBadge
          unreadCount={customerUnreadSummary.unreadCount}
          latest={customerUnreadSummary.latest}
          onClick={openLatestCustomerMessage}
        />
      </Box>
    </MinimizedTaskProvider>
  );
}

export default App;
