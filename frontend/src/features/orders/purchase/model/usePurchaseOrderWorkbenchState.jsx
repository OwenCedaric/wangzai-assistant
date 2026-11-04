import React from 'react';
import { useMinimizedTaskRegistration } from '../../../../shared/ui/minimizedTasks/MinimizedTaskProvider.jsx';
import {
  getInternalBrowserLinkErrorMessage,
  openInternalBrowserLink,
} from '../../../../services/internalBrowserLinkClient.js';
import { buildPurchaseOrderWorkbenchPresentation } from '../lib/purchaseOrderWorkbenchPresentation.js';
import { buildPurchaseBrowserTarget } from '../services/purchaseBrowserTargetBridge.js';
import {
  hidePurchaseOrderWorkbenchViewport,
  runPurchaseOrderWorkbenchOrderOperation,
  runPurchaseOrderWorkbenchSellerOrderLookup,
  runPurchaseOrderWorkbenchNavigation,
  runPurchaseOrderWorkbenchToolbarAction,
  syncPurchaseOrderWorkbenchViewport,
} from '../services/purchaseOrderWorkbenchViewportBridge.js';

const EMPTY_PURCHASE_ORDER_WORKBENCH_DIALOG = Object.freeze({
  open: false,
  minimized: false,
  requestKey: '',
  url: '',
  shopId: '',
  requireShopBinding: false,
  sellerOrderLookup: null,
  presentation: null,
  browserTargetContext: null,
  browserTabId: '',
  browserSessionId: '',
  browserGeneration: 0,
  status: 'idle',
  operation: '',
  pendingSave: false,
  error: '',
});
const PURCHASE_ORDER_WORKBENCH_CLOSE_RELEASE_MS = 800;

function normalizedText(value) {
  return String(value ?? '').trim();
}

function viewportOwner(value = {}) {
  return {
    requestKey: normalizedText(value.requestKey),
    tabId: normalizedText(value.browserTabId),
    sessionId: normalizedText(value.browserSessionId),
    generation: Number(value.browserGeneration) || 0,
  };
}

function captureMatchesWorkbenchTarget(target = {}, context = {}) {
  const expectedShopId = normalizedText(context.shopId || context.shopClientId);
  const expectedOrderKey = normalizedText(context.orderKey || context.orderId);
  const expectedProductKeys = new Set([
    context.productKey,
    context.offerId,
    context.sku,
  ].map(normalizedText).filter(Boolean));
  const actualShopId = normalizedText(target.shopId);
  const actualOrderKey = normalizedText(target.orderKey);
  const actualProductKeys = [target.sku, target.offerId].map(normalizedText).filter(Boolean);
  if (!expectedShopId || !expectedOrderKey) return false;
  if (actualShopId !== expectedShopId || actualOrderKey !== expectedOrderKey) return false;
  if (!expectedProductKeys.size || !actualProductKeys.length) return true;
  return actualProductKeys.some((key) => expectedProductKeys.has(key));
}

function formatPurchaseAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? `¥${number.toFixed(2)}` : normalizedText(value);
}

export function applyPurchaseCaptureToWorkbenchPresentation(presentation = {}, payload = {}) {
  const context = payload.purchaseContext || payload.capture || {};
  const platform = normalizedText(context.purchasePlatform || context.platform);
  const orderNumber = normalizedText(context.purchaseOrderNumber || context.orderNumber);
  const status = normalizedText(context.purchaseOrderStatus || context.orderStatus || context.statusText);
  const amount = formatPurchaseAmount(context.sourceCostCny ?? context.purchasePrice ?? context.amount);
  if (!platform && !orderNumber && !status && !amount) return presentation;
  return {
    ...presentation,
    order: {
      ...(presentation.order || {}),
      ...(platform ? { purchasePlatform: platform } : {}),
      ...(orderNumber ? { purchaseOrderNo: orderNumber } : {}),
      ...(status ? { status } : {}),
    },
    source: {
      ...(presentation.source || {}),
      ...(platform ? { platform } : {}),
      ...(amount ? { amount } : {}),
      ...(context.purchaseOrderUrl ? { url: context.purchaseOrderUrl } : {}),
    },
  };
}

export function applyPurchaseRefundToWorkbenchPresentation(presentation = {}, payload = {}) {
  const readback = payload.readback?.override || {};
  const status = normalizedText(readback.forcePurchaseStatus) || '待拍单';
  return {
    ...presentation,
    order: {
      ...(presentation.order || {}),
      purchasePlatform: '待补录',
      purchaseOrderNo: '待补录',
      status,
    },
    source: {
      ...(presentation.source || {}),
      platform: '待补录',
      amount: '待确认',
    },
  };
}

export function usePurchaseOrderWorkbenchState({
  selectedOrder,
  selectedProduct,
  selectedSourceEntry,
  selectedOrderSourceShop,
  setSourceSearchDialog,
  showPurchaseNotice,
  onBrowserReady,
  onPurchaseCaptured,
  onPurchaseRefundCaptured,
} = {}) {
  const [dialog, setDialog] = React.useState(EMPTY_PURCHASE_ORDER_WORKBENCH_DIALOG);
  const dialogRef = React.useRef(dialog);
  const sequenceRef = React.useRef(0);
  const startedRequestRef = React.useRef('');
  const activeRequestRef = React.useRef('');
  const minimizedRequestRef = React.useRef('');
  const closePromiseRef = React.useRef(null);
  const minimizePromiseRef = React.useRef(null);
  const mountedRef = React.useRef(true);
  const purchaseCapturedRef = React.useRef(onPurchaseCaptured);
  const purchaseRefundCapturedRef = React.useRef(onPurchaseRefundCaptured);
  const purchaseNoticeRef = React.useRef(showPurchaseNotice);
  React.useEffect(() => {
    dialogRef.current = dialog;
  }, [dialog]);
  React.useEffect(() => {
    purchaseCapturedRef.current = onPurchaseCaptured;
  }, [onPurchaseCaptured]);
  React.useEffect(() => {
    purchaseRefundCapturedRef.current = onPurchaseRefundCaptured;
  }, [onPurchaseRefundCaptured]);
  React.useEffect(() => {
    purchaseNoticeRef.current = showPurchaseNotice;
  }, [showPurchaseNotice]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (!activeRequestRef.current) return;
      activeRequestRef.current = '';
      startedRequestRef.current = '';
      minimizedRequestRef.current = '';
      // Route changes and app teardown do not have a visible card whose close
      // handler can be awaited. The desktop embed-hide command is atomic and
      // still fences the child HWND without destroying the hot CEF session.
      void hidePurchaseOrderWorkbenchViewport(viewportOwner(dialogRef.current)).catch(() => undefined);
    };
  }, []);

  const open = React.useCallback((url, {
    browserTargetContext = null,
    presentation: presentationOverride = null,
    shopId = '',
    requireShopBinding = false,
    sellerOrderLookup = null,
  } = {}) => {
    const rawUrl = String(url || '').trim();
    if (!rawUrl) return;
    const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const requestKey = `purchase_workbench_${Date.now()}_${++sequenceRef.current}`;
    const presentation = presentationOverride || buildPurchaseOrderWorkbenchPresentation({
      order: selectedOrder,
      product: selectedProduct,
      sourceEntry: selectedSourceEntry,
      sourceShop: selectedOrderSourceShop,
      sourceLink: normalizedUrl,
    });
    startedRequestRef.current = '';
    minimizedRequestRef.current = '';
    activeRequestRef.current = requestKey;
    setSourceSearchDialog?.((current) => ({ ...current, open: false }));
    setDialog({
      open: true,
      minimized: false,
      requestKey,
      url: normalizedUrl,
      shopId: String(shopId || '').trim(),
      requireShopBinding: requireShopBinding === true,
      sellerOrderLookup,
      presentation,
      browserTargetContext,
      browserTabId: '',
      browserSessionId: '',
      browserGeneration: 0,
      status: 'loading',
      operation: '',
      pendingSave: false,
      error: '',
    });
  }, [
    selectedOrder,
    selectedOrderSourceShop,
    selectedProduct,
    selectedSourceEntry,
    setSourceSearchDialog,
  ]);

  const startBrowser = React.useCallback(async ({
    requestKey,
    url,
    shopId,
    requireShopBinding,
    sellerOrderLookup,
    presentation,
    browserTargetContext,
    bounds,
  } = {}) => {
    const normalizedRequestKey = String(requestKey || '').trim();
    if (
      !normalizedRequestKey
      || !url
      || !presentation
      || activeRequestRef.current !== normalizedRequestKey
    ) return null;

    const shouldOpenBrowser = startedRequestRef.current !== normalizedRequestKey;
    if (minimizedRequestRef.current === normalizedRequestKey) return null;
    if (!shouldOpenBrowser) {
      const current = dialogRef.current;
      return syncPurchaseOrderWorkbenchViewport(bounds, {
        requestKey: normalizedRequestKey,
        tabId: current.browserTabId,
        sessionId: current.browserSessionId,
        generation: current.browserGeneration,
      }).catch(() => null);
    }
    startedRequestRef.current = normalizedRequestKey;
    try {
      const initialTarget = browserTargetContext
        ? buildPurchaseBrowserTarget(browserTargetContext)
        : null;
      if (browserTargetContext && !initialTarget) {
        const error = new Error('PURCHASE_BROWSER_TARGET_REQUIRED');
        error.code = 'PURCHASE_BROWSER_TARGET_REQUIRED';
        throw error;
      }
      // Initial viewport and URL stay atomic. A late open completion is fenced
      // by activeRequestRef and cannot resurrect a workbench that is closing.
      const result = await openInternalBrowserLink(url, {
        shopId,
        requireShopBinding,
        workbench: presentation,
        embeddedBounds: bounds,
        browserTarget: initialTarget,
        workbenchRequestKey: normalizedRequestKey,
      });
      const browserTabId = normalizedText(result?.activeTabId || result?.state?.activeTabId);
      const browserSessionId = normalizedText(result?.sessionId || result?.state?.sessionId);
      const browserGeneration = Number(result?.generation || result?.state?.generation) || 0;
      if (activeRequestRef.current !== normalizedRequestKey) {
        // A superseded open may finish after a newer card has already taken
        // ownership of the same hot CEF window. Hide only when there is no
        // active card (the close path), never underneath the newer request.
        if (!activeRequestRef.current) {
          await hidePurchaseOrderWorkbenchViewport({
            requestKey: normalizedRequestKey,
            tabId: browserTabId,
            sessionId: browserSessionId,
            generation: browserGeneration,
          }).catch(() => undefined);
        }
        return result;
      }
      if (minimizedRequestRef.current === normalizedRequestKey) {
        // The native open may complete after the user minimized the React
        // card. Hide once more after that completion so the CEF child cannot
        // flash above whichever workspace the user opened in the meantime.
        await hidePurchaseOrderWorkbenchViewport({
          requestKey: normalizedRequestKey,
          tabId: browserTabId,
          sessionId: browserSessionId,
          generation: browserGeneration,
        }).catch(() => undefined);
      }
      if (sellerOrderLookup) {
        if (!browserTabId) {
          const error = new Error('PURCHASE_BROWSER_TAB_NOT_FOUND');
          error.code = 'PURCHASE_BROWSER_TAB_NOT_FOUND';
          throw error;
        }
        await runPurchaseOrderWorkbenchSellerOrderLookup({
          tabId: browserTabId,
          ...sellerOrderLookup,
        });
      }
      if (browserTargetContext) {
        await onBrowserReady?.({
          requestKey: normalizedRequestKey,
          browserState: result,
          targetContext: browserTargetContext,
        });
      }
      if (activeRequestRef.current !== normalizedRequestKey) return result;
      setDialog((current) => (
        current.requestKey === normalizedRequestKey && current.open
          ? {
              ...current,
              browserTabId,
              browserSessionId,
              browserGeneration,
              status: 'ready',
              error: '',
            }
          : current
      ));
      return result;
    } catch (error) {
      const message = getInternalBrowserLinkErrorMessage(error);
      if (activeRequestRef.current === normalizedRequestKey) {
        setDialog((current) => (
          current.requestKey === normalizedRequestKey && current.open
            ? { ...current, status: 'error', error: message }
            : current
        ));
        showPurchaseNotice?.(message, 'error');
      }
      return null;
    }
  }, [onBrowserReady, showPurchaseNotice]);

  React.useEffect(() => {
    if (!dialog.open) return undefined;
    const browserOnEvent = globalThis.window?.wangzaiDesktop?.purchaseBrowser?.onEvent;
    if (typeof browserOnEvent !== 'function') return undefined;
    return browserOnEvent((payload = {}) => {
      const alipayNotices = {
        'alipay-payment-opened': ['支付宝付款窗口已打开，请在官方页面完成付款。', 'info'],
        'alipay-payment-verifying': ['支付宝已返回结果，正在核对拼多多订单。', 'info'],
        'alipay-payment-pending': ['拼多多暂未确认付款，付款窗口会继续保留。', 'warning'],
        'alipay-payment-verified': ['拼多多已确认付款，支付宝窗口已自动关闭。', 'success'],
        'alipay-payment-error': ['支付宝付款窗口打开失败，请返回拼多多重试当前订单。', 'error'],
        'purchase-auto-order-paused': ['自动拍单已暂停，请处理页面验证后继续。', 'warning'],
        'purchase-auto-order-stage': ['自动拍单正在执行。', 'info'],
      };
      const alipayNotice = alipayNotices[payload.event];
      if (alipayNotice) purchaseNoticeRef.current?.(...alipayNotice);
      const isPaidCapture = payload.event === 'purchase-order-auto-captured';
      const isRefundCapture = payload.event === 'purchase-order-refund-captured';
      if ((!isPaidCapture && !isRefundCapture) || payload.readbackVerified !== true) return;
      const current = dialogRef.current;
      if (
        !current.open
        || !current.browserTargetContext
        || (current.browserTabId && normalizedText(payload.tabId) !== current.browserTabId)
        || !captureMatchesWorkbenchTarget(payload.target, current.browserTargetContext)
      ) return;
      setDialog((current) => {
        if (
          !current.open
          || !current.browserTargetContext
          || (current.browserTabId && normalizedText(payload.tabId) !== current.browserTabId)
          || !captureMatchesWorkbenchTarget(payload.target, current.browserTargetContext)
        ) return current;
        return {
          ...current,
          pendingSave: false,
          presentation: isRefundCapture
            ? applyPurchaseRefundToWorkbenchPresentation(current.presentation || {}, payload)
            : applyPurchaseCaptureToWorkbenchPresentation(current.presentation || {}, payload),
        };
      });
      if (isRefundCapture) purchaseRefundCapturedRef.current?.(payload);
      else purchaseCapturedRef.current?.(payload);
    });
  }, [dialog.open]);

  const minimize = React.useCallback(() => {
    if (minimizePromiseRef.current) return minimizePromiseRef.current;
    const requestKey = activeRequestRef.current;
    if (!requestKey || closePromiseRef.current) return Promise.resolve(null);
    minimizedRequestRef.current = requestKey;
    const owner = viewportOwner(dialogRef.current);
    setDialog((current) => (
      current.requestKey === requestKey && current.open && current.status !== 'closing'
        ? { ...current, minimized: true }
        : current
    ));

    const operation = (async () => {
      try {
        await hidePurchaseOrderWorkbenchViewport(owner);
      } catch {
        await hidePurchaseOrderWorkbenchViewport(owner).catch(() => undefined);
      }
      return null;
    })();
    minimizePromiseRef.current = operation;
    void operation.finally(() => {
      if (minimizePromiseRef.current === operation) minimizePromiseRef.current = null;
    });
    return operation;
  }, []);

  const restore = React.useCallback(() => {
    const requestKey = activeRequestRef.current;
    if (!requestKey || closePromiseRef.current) return;
    minimizedRequestRef.current = '';
    setDialog((current) => (
      current.requestKey === requestKey && current.open && current.status !== 'closing'
        ? { ...current, minimized: false }
        : current
    ));
  }, []);

  const close = React.useCallback(() => {
    if (closePromiseRef.current) return closePromiseRef.current;
    const closingRequestKey = activeRequestRef.current;
    if (!closingRequestKey) return Promise.resolve(null);
    const owner = viewportOwner(dialogRef.current);

    // Fence ResizeObserver/rAF publications before changing React state. The
    // card remains mounted for the few milliseconds needed for native hide
    // readback, so the card and child HWND disappear as one visual operation.
    activeRequestRef.current = '';
    startedRequestRef.current = '';
    minimizedRequestRef.current = '';
    setDialog((current) => (
      current.requestKey === closingRequestKey && current.open
        ? { ...current, status: 'closing', error: '' }
        : current
    ));

    const operation = (async () => {
      const nativeHide = (async () => {
        try {
          await hidePurchaseOrderWorkbenchViewport(owner);
        } catch {
          // One bounded retry covers a sidecar reconnect without ever destroying
          // the account profile, cookies or hot browser process.
          await hidePurchaseOrderWorkbenchViewport(owner).catch(() => undefined);
        }
      })();
      await Promise.race([
        nativeHide,
        new Promise((resolve) => setTimeout(resolve, PURCHASE_ORDER_WORKBENCH_CLOSE_RELEASE_MS)),
      ]);
      if (!mountedRef.current || activeRequestRef.current) return null;
      setDialog((current) => (
        current.requestKey === closingRequestKey
          ? EMPTY_PURCHASE_ORDER_WORKBENCH_DIALOG
          : current
      ));
      void nativeHide.catch(() => undefined);
      return null;
    })();
    closePromiseRef.current = operation;
    void operation.finally(() => {
      if (closePromiseRef.current === operation) closePromiseRef.current = null;
    });
    return operation;
  }, []);

  const retry = React.useCallback(() => {
    const requestKey = activeRequestRef.current;
    if (!requestKey) return;
    startedRequestRef.current = '';
    setDialog((current) => (
      current.open && current.requestKey === requestKey && current.status !== 'closing'
        ? { ...current, status: 'loading', error: '' }
        : current
    ));
  }, []);

  const navigate = React.useCallback(async (command) => {
    if (!activeRequestRef.current || minimizedRequestRef.current) return null;
    try {
      return await runPurchaseOrderWorkbenchNavigation(command);
    } catch (error) {
      showPurchaseNotice?.(getInternalBrowserLinkErrorMessage(error), 'error');
      return null;
    }
  }, [showPurchaseNotice]);

  const runToolbarAction = React.useCallback(async (action, payload = {}) => {
    const current = dialogRef.current;
    if (
      !activeRequestRef.current
      || minimizedRequestRef.current
      || !current.open
      || current.status !== 'ready'
      || current.operation
      || !current.browserTabId
    ) return null;
    try {
      const result = await runPurchaseOrderWorkbenchToolbarAction(action, payload, {
        tabId: current.browserTabId,
      });
      const tabs = Array.isArray(result?.tabs)
        ? result.tabs
        : Array.isArray(result?.state?.tabs) ? result.state.tabs : [];
      const exactTab = tabs.find((candidate) => (
        normalizedText(candidate?.tabId) === current.browserTabId
      ));
      const nextUrl = normalizedText(exactTab?.url);
      if (nextUrl) {
        setDialog((value) => (
          value.requestKey === current.requestKey && value.open
            ? { ...value, url: nextUrl }
            : value
        ));
      }
      return result;
    } catch (error) {
      const message = getInternalBrowserLinkErrorMessage(error);
      showPurchaseNotice?.(message, 'error');
      return {
        toolbar: {
          dialog: {
            kind: 'toolbar-error',
            title: '操作未完成',
            result: { 提示: message },
          },
        },
      };
    }
  }, [showPurchaseNotice]);

  const runOrderOperation = React.useCallback(async (operation) => {
    const current = dialogRef.current;
    const canRefreshFromLoadedError = operation === 'refresh-order-status'
      && current.status === 'error'
      && Boolean(current.browserTabId);
    if (
      !activeRequestRef.current
      || minimizedRequestRef.current
      || !current.open
      || (current.status !== 'ready' && !canRefreshFromLoadedError)
      || current.operation
      || !current.browserTabId
    ) return null;
    setDialog((value) => (
      value.requestKey === current.requestKey ? { ...value, operation, error: '' } : value
    ));
    try {
      const result = await runPurchaseOrderWorkbenchOrderOperation(operation, {
        tabId: current.browserTabId,
      });
      const staged = result?.captureVerified === true && result?.pendingSave === true;
      const persisted = result?.readbackVerified === true;
      if (
        (!staged && !persisted)
        || !captureMatchesWorkbenchTarget(result.target, current.browserTargetContext || {})
      ) throw Object.assign(new Error('PURCHASE_BROWSER_READBACK_FAILED'), { code: 'PURCHASE_BROWSER_READBACK_FAILED' });
      const refunded = result?.refunded === true;
      setDialog((value) => (
        value.requestKey === current.requestKey && value.open
          ? {
              ...value,
              operation: '',
              status: 'ready',
              error: '',
              pendingSave: staged && !refunded,
              presentation: refunded
                ? applyPurchaseRefundToWorkbenchPresentation(value.presentation || {}, result)
                : applyPurchaseCaptureToWorkbenchPresentation(value.presentation || {}, result),
            }
          : value
      ));
      if (refunded) purchaseRefundCapturedRef.current?.(result);
      else if (persisted) purchaseCapturedRef.current?.(result);
      else showPurchaseNotice?.('付款信息已读取，请点击“保存信息”完成绑定。', 'info');
      return result;
    } catch (error) {
      const message = getInternalBrowserLinkErrorMessage(error);
      setDialog((value) => (
        value.requestKey === current.requestKey ? { ...value, operation: '', error: message } : value
      ));
      showPurchaseNotice?.(message, 'error');
      return null;
    }
  }, [showPurchaseNotice]);

  const readPaymentInfo = React.useCallback(
    () => runOrderOperation('read-payment-info'),
    [runOrderOperation],
  );
  const refreshOrderStatus = React.useCallback(
    () => runOrderOperation('refresh-order-status'),
    [runOrderOperation],
  );
  const savePurchaseInfo = React.useCallback(async () => {
    const current = dialogRef.current;
    if (
      !activeRequestRef.current
      || minimizedRequestRef.current
      || !current.open
      || current.status !== 'ready'
      || current.operation
      || !current.pendingSave
      || !current.browserTabId
    ) return null;
    setDialog((value) => (
      value.requestKey === current.requestKey
        ? { ...value, operation: 'save-payment-info', error: '' }
        : value
    ));
    try {
      const result = await runPurchaseOrderWorkbenchOrderOperation('save-payment-info', {
        tabId: current.browserTabId,
      });
      if (
        result?.readbackVerified !== true
        || result?.pendingSave === true
        || !captureMatchesWorkbenchTarget(result.target, current.browserTargetContext || {})
      ) throw Object.assign(new Error('PURCHASE_BROWSER_READBACK_FAILED'), { code: 'PURCHASE_BROWSER_READBACK_FAILED' });
      await purchaseCapturedRef.current?.(result);
      setDialog((value) => (
        value.requestKey === current.requestKey && value.open
          ? {
              ...value,
              operation: '',
              pendingSave: false,
              presentation: applyPurchaseCaptureToWorkbenchPresentation(value.presentation || {}, result),
            }
          : value
      ));
      return result;
    } catch (error) {
      const message = getInternalBrowserLinkErrorMessage(error);
      setDialog((value) => (
        value.requestKey === current.requestKey ? { ...value, operation: '', error: message } : value
      ));
      showPurchaseNotice?.(message, 'error');
      return null;
    }
  }, [showPurchaseNotice]);

  const minimizedTaskSubtitle = String(
    dialog.presentation?.order?.orderNo
    || dialog.presentation?.order?.ozonOrderId
    || dialog.presentation?.product?.title
    || '',
  ).trim();
  useMinimizedTaskRegistration({
    active: Boolean(dialog.open && dialog.minimized && dialog.status !== 'closing'),
    id: dialog.requestKey,
    kind: `order-workbench-${String(dialog.presentation?.sidebarKind || 'order')}`,
    title: dialog.presentation?.title || '订单操作台',
    subtitle: minimizedTaskSubtitle,
    restore,
    close,
  });

  return Object.freeze({
    dialog,
    open,
    startBrowser,
    minimize,
    restore,
    close,
    retry,
    navigate,
    runToolbarAction,
    readPaymentInfo,
    refreshOrderStatus,
    savePurchaseInfo,
  });
}
