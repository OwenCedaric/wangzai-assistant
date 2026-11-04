import React from 'react';
import {
  getPurchaseBrowserAccountTab,
  getPurchaseBrowserErrorMessage,
  closePurchaseBrowser,
  forceResetPurchaseBrowserLogin,
  hidePurchaseBrowser,
  inspectPurchaseBrowser,
  openCrossBorderBrowserLogin,
  syncCrossBorderBrowser,
  normalizePurchaseBrowserState,
  openPurchaseBrowserLogin,
  reloadPurchaseBrowser,
  restorePurchaseBrowser,
  recoverPurchaseBrowserTarget,
  resolvePurchaseBrowserLoginTarget,
  subscribePurchaseBrowserEvents,
} from '../services/purchaseBrowserLoginClient.js';
import { usePurchaseBrowserTargetMode } from './usePurchaseBrowserTargetMode.js';

const EMPTY_BROWSER_STATE = Object.freeze(normalizePurchaseBrowserState());
const OPEN_BROWSER_STATUSES = Object.freeze(new Set(['opening', 'loading', 'ready', 'checking', 'checked']));

const STATUS_PRESENTATION = Object.freeze({
  idle: { label: '登录未验证', color: 'default' },
  saved: { label: 'Cookie 已保存', color: 'success' },
  unavailable: { label: '请先保存账号', color: 'default' },
  opening: { label: '正在打开独立窗口', color: 'warning' },
  loading: { label: '登录页面加载中', color: 'warning' },
  ready: { label: '独立登录窗口已打开', color: 'primary' },
  checking: { label: '正在读取页面状态', color: 'warning' },
  checked: { label: '页面状态已返回', color: 'success' },
  hidden: { label: '登录窗口已关闭', color: 'default' },
  failed: { label: '浏览器操作失败', color: 'error' },
});

export function usePurchaseAccountLogin({
  enabled = false,
  connected = false,
  accountId = '',
  accountLabel = '',
  platformName = '',
  platformUrl = '',
  onLoginSaved,
} = {}) {
  const target = resolvePurchaseBrowserLoginTarget(platformName, platformUrl);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [status, setStatus] = React.useState(enabled ? (connected ? 'saved' : 'idle') : 'unavailable');
  const statusRef = React.useRef(enabled ? (connected ? 'saved' : 'idle') : 'unavailable');
  const [snapshot, setSnapshot] = React.useState(EMPTY_BROWSER_STATE);
  const snapshotRef = React.useRef(EMPTY_BROWSER_STATE);
  const [inspection, setInspection] = React.useState(null);
  const [errorMessage, setErrorMessage] = React.useState('');
  const [crossBorderBusy, setCrossBorderBusy] = React.useState(false);
  const [crossBorderResult, setCrossBorderResult] = React.useState(null);
  const crossBorderRequestIdRef = React.useRef(0);
  const requestIdRef = React.useRef(0);
  const panelOpenRef = React.useRef(false);
  const connectedRef = React.useRef(Boolean(connected));
  const onLoginSavedRef = React.useRef(onLoginSaved);
  connectedRef.current = Boolean(connected) || connectedRef.current;
  onLoginSavedRef.current = onLoginSaved;
  const accountKey = [String(accountId || ''), String(platformName || ''), String(platformUrl || '')].join('\u0000');
  const previousAccountKeyRef = React.useRef(accountKey);
  const lifecycleRef = React.useRef({ mounted: false, accountKey });
  lifecycleRef.current.accountKey = accountKey;
  const isCurrentRequest = React.useCallback((requestId) => (
    lifecycleRef.current.mounted
    && lifecycleRef.current.accountKey === accountKey
    && requestIdRef.current === requestId
  ), [accountKey]);
  const activeBrowserTab = getPurchaseBrowserAccountTab(snapshot, accountId);
  const targetMode = usePurchaseBrowserTargetMode({
    tabId: activeBrowserTab?.tabId || '',
    target: activeBrowserTab?.target || null,
    targetPhase: activeBrowserTab?.targetPhase || snapshot.targetPhase || '',
  });

  const updateStatus = React.useCallback((value) => {
    if (typeof value === 'function') {
      setStatus((current) => {
        const next = value(current);
        statusRef.current = next;
        return next;
      });
      return;
    }
    statusRef.current = value;
    setStatus(value);
  }, []);

  React.useEffect(() => {
    const lifecycle = lifecycleRef.current;
    lifecycle.mounted = true;
    return () => {
      lifecycle.mounted = false;
      requestIdRef.current += 1;
    };
  }, []);

  const applySnapshot = React.useCallback(
    (value, nextStatus = '') => {
      const nextSnapshot = normalizePurchaseBrowserState(value);
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      const tab = getPurchaseBrowserAccountTab(nextSnapshot, accountId);
      if (nextStatus) updateStatus(nextStatus);
      else if (tab?.crashed) updateStatus('failed');
      else if (tab?.loading) updateStatus('loading');
      else if (tab && nextSnapshot.visible === false) updateStatus(connectedRef.current ? 'saved' : 'hidden');
      else if (tab) updateStatus('ready');
      return nextSnapshot;
    },
    [accountId, updateStatus]
  );

  React.useEffect(() => {
    if (previousAccountKeyRef.current === accountKey) return;
    previousAccountKeyRef.current = accountKey;
    requestIdRef.current += 1;
    crossBorderRequestIdRef.current += 1;
    panelOpenRef.current = false;
    connectedRef.current = Boolean(connected);
    setPanelOpen(false);
    setSnapshot(EMPTY_BROWSER_STATE);
    snapshotRef.current = EMPTY_BROWSER_STATE;
    setInspection(null);
    setErrorMessage('');
    setCrossBorderResult(null);
    setCrossBorderBusy(false);
    updateStatus(enabled ? (connected ? 'saved' : 'idle') : 'unavailable');
  }, [accountKey, connected, enabled, updateStatus]);

  React.useEffect(() => {
    connectedRef.current = Boolean(connected);
    if (!enabled) {
      requestIdRef.current += 1;
      panelOpenRef.current = false;
      setPanelOpen(false);
      updateStatus('unavailable');
      return;
    }
    if (!panelOpenRef.current) updateStatus(connected ? 'saved' : 'idle');
  }, [connected, enabled, updateStatus]);

  React.useEffect(() => {
    let subscribed = true;
    const unsubscribe = subscribePurchaseBrowserEvents((payload = {}) => {
      if (!subscribed || !lifecycleRef.current.mounted || lifecycleRef.current.accountKey !== accountKey) return;
      const eventAccountId = String(payload.accountId || '');
      if (payload.event === 'purchase-login-saved' && eventAccountId === String(accountId || '')) {
        requestIdRef.current += 1;
        if (payload.state) applySnapshot(payload.state, 'saved');
        connectedRef.current = true;
        panelOpenRef.current = false;
        setPanelOpen(false);
        setErrorMessage('');
        updateStatus('saved');
        onLoginSavedRef.current?.(payload.account || null, payload.verification || null);
        return;
      }
      if (!payload.state) return;
      const nextSnapshot = normalizePurchaseBrowserState(payload.state);
      const accountTab = getPurchaseBrowserAccountTab(nextSnapshot, accountId);
      if (!accountTab) return;
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      if (payload.event === 'window-hidden') {
        requestIdRef.current += 1;
        panelOpenRef.current = false;
        setPanelOpen(false);
        updateStatus(connectedRef.current ? 'saved' : 'hidden');
        return;
      }
      if (!panelOpenRef.current) return;
      if (payload.event === 'crashed' && payload.tabId === accountTab.tabId) {
        setErrorMessage('独立登录窗口意外关闭，请重新打开。');
        updateStatus('failed');
        return;
      }
      updateStatus(accountTab.loading ? 'loading' : 'ready');
    });
    return () => {
      subscribed = false;
      unsubscribe();
    };
  }, [accountId, accountKey, applySnapshot, updateStatus]);

  const openLogin = React.useCallback(async ({ force = false } = {}) => {
    if (!enabled) {
      updateStatus('unavailable');
      setErrorMessage('请先保存当前拍单账号。');
      return null;
    }
    if (!target) {
      updateStatus('failed');
      setErrorMessage('当前采购平台暂不支持内置登录。');
      return null;
    }
    if (!force && panelOpenRef.current && OPEN_BROWSER_STATUSES.has(statusRef.current)) {
      return snapshotRef.current;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    panelOpenRef.current = true;
    setPanelOpen(true);
    setInspection(null);
    setErrorMessage('');
    updateStatus('opening');
    try {
      const nextSnapshot = await openPurchaseBrowserLogin({
        accountId,
        accountLabel,
        platformName,
        platformUrl,
      });
      if (!isCurrentRequest(requestId)) return null;
      return applySnapshot(nextSnapshot);
    } catch (error) {
      if (!isCurrentRequest(requestId)) return null;
      panelOpenRef.current = false;
      setPanelOpen(false);
      updateStatus('failed');
      setErrorMessage(getPurchaseBrowserErrorMessage(error));
      return null;
    }
  }, [accountId, accountLabel, applySnapshot, enabled, isCurrentRequest, platformName, platformUrl, target, updateStatus]);

  const restoreLogin = React.useCallback(async () => {
    const requestId = requestIdRef.current;
    setErrorMessage('');
    try {
      const nextSnapshot = await restorePurchaseBrowser();
      if (!isCurrentRequest(requestId)) return null;
      panelOpenRef.current = true;
      setPanelOpen(true);
      return applySnapshot(nextSnapshot);
    } catch (error) {
      if (!isCurrentRequest(requestId)) return null;
      updateStatus('failed');
      setErrorMessage(getPurchaseBrowserErrorMessage(error));
      return null;
    }
  }, [applySnapshot, isCurrentRequest, updateStatus]);

  const openCrossBorderLogin = React.useCallback(async () => {
    if (!enabled) {
      setErrorMessage('请先保存当前拍单账号。');
      return null;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    panelOpenRef.current = true;
    setPanelOpen(true);
    setErrorMessage('');
    updateStatus('opening');
    try {
      const nextSnapshot = await openCrossBorderBrowserLogin({ accountId, platformName, platformUrl });
      if (!isCurrentRequest(requestId)) return null;
      return applySnapshot(nextSnapshot);
    } catch (error) {
      if (!isCurrentRequest(requestId)) return null;
      panelOpenRef.current = false;
      setPanelOpen(false);
      updateStatus('failed');
      setErrorMessage(getPurchaseBrowserErrorMessage(error));
      return null;
    }
  }, [accountId, applySnapshot, enabled, isCurrentRequest, platformName, platformUrl, updateStatus]);

  const syncCrossBorder = React.useCallback(async ({ orderIds = [], commit = false } = {}) => {
    const requestId = requestIdRef.current;
    const currentTab = getPurchaseBrowserAccountTab(snapshotRef.current, accountId);
    if (!currentTab?.tabId) {
      setErrorMessage('请先打开当前采购账号的独立浏览器。');
      return null;
    }
    const crossBorderRequestId = crossBorderRequestIdRef.current + 1;
    crossBorderRequestIdRef.current = crossBorderRequestId;
    setCrossBorderBusy(true);
    setErrorMessage('');
    try {
      const response = await syncCrossBorderBrowser({ tabId: currentTab.tabId, orderIds, commit });
      if (!isCurrentRequest(requestId) || crossBorderRequestIdRef.current !== crossBorderRequestId) return null;
      setCrossBorderResult(response.result);
      snapshotRef.current = response.state;
      setSnapshot(response.state);
      return response.result;
    } catch (error) {
      if (!isCurrentRequest(requestId) || crossBorderRequestIdRef.current !== crossBorderRequestId) return null;
      setErrorMessage(getPurchaseBrowserErrorMessage(error));
      return null;
    } finally {
      if (lifecycleRef.current.mounted && crossBorderRequestIdRef.current === crossBorderRequestId) {
        setCrossBorderBusy(false);
      }
    }
  }, [accountId, isCurrentRequest]);

  const hideLogin = React.useCallback(async () => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    panelOpenRef.current = false;
    setPanelOpen(false);
    updateStatus(connectedRef.current ? 'saved' : 'hidden');
    try {
      const nextSnapshot = await hidePurchaseBrowser();
      if (!isCurrentRequest(requestId)) return null;
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      return nextSnapshot;
    } catch {
      return null;
    }
  }, [isCurrentRequest, updateStatus]);

  const closeLogin = React.useCallback(async () => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    panelOpenRef.current = false;
    setPanelOpen(false);
    updateStatus(connectedRef.current ? 'saved' : 'hidden');
    const currentTab = getPurchaseBrowserAccountTab(snapshotRef.current, accountId);
    try {
      const nextSnapshot = await closePurchaseBrowser(currentTab?.tabId || '');
      if (!isCurrentRequest(requestId)) return null;
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      return nextSnapshot;
    } catch (error) {
      if (!isCurrentRequest(requestId)) return null;
      setErrorMessage(getPurchaseBrowserErrorMessage(error));
      return null;
    }
  }, [accountId, isCurrentRequest, updateStatus]);

  const forceReset = React.useCallback(async () => {
    if (!enabled || !target) {
      updateStatus('unavailable');
      setErrorMessage('请先保存当前拍单账号。');
      return null;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    panelOpenRef.current = true;
    setPanelOpen(true);
    setErrorMessage('');
    updateStatus('opening');
    try {
      const nextSnapshot = await forceResetPurchaseBrowserLogin({
        accountId,
        accountLabel,
        platformName,
        platformUrl,
      });
      if (!isCurrentRequest(requestId)) return null;
      return applySnapshot(nextSnapshot);
    } catch (error) {
      if (!isCurrentRequest(requestId)) return null;
      panelOpenRef.current = false;
      setPanelOpen(false);
      updateStatus('failed');
      setErrorMessage(getPurchaseBrowserErrorMessage(error));
      return null;
    }
  }, [accountId, accountLabel, applySnapshot, enabled, isCurrentRequest, platformName, platformUrl, target, updateStatus]);

  const reload = React.useCallback(async () => {
    const requestId = requestIdRef.current;
    const tab = getPurchaseBrowserAccountTab(snapshot, accountId);
    if (!tab?.tabId) return null;
    setErrorMessage('');
    updateStatus('loading');
    try {
      const nextSnapshot = await reloadPurchaseBrowser(tab.tabId);
      if (!isCurrentRequest(requestId)) return null;
      return applySnapshot(nextSnapshot);
    } catch (error) {
      if (!isCurrentRequest(requestId)) return null;
      updateStatus('failed');
      setErrorMessage(getPurchaseBrowserErrorMessage(error));
      return null;
    }
  }, [accountId, applySnapshot, isCurrentRequest, snapshot, updateStatus]);

  const recoverBrowser = React.useCallback(async () => {
    let requestId = requestIdRef.current;
    try {
      const preservedTarget = targetMode.target;
      const currentTab = getPurchaseBrowserAccountTab(snapshotRef.current, accountId);
      const fenced = await targetMode.recover(currentTab?.tabId || '');
      if (!fenced || !isCurrentRequest(requestId)) return null;
      applySnapshot(fenced, 'opening');
      const reopenRequest = openLogin({ force: true });
      requestId = requestIdRef.current;
      const reopened = await reopenRequest;
      if (!reopened || !isCurrentRequest(requestId)) return null;
      let finalSnapshot = reopened;
      const reopenedTab = getPurchaseBrowserAccountTab(reopened, accountId);
      if (preservedTarget && reopenedTab?.tabId) {
        try {
          const locked = await recoverPurchaseBrowserTarget({
            tabId: reopenedTab.tabId,
            target: preservedTarget,
            sessionId: reopenedTab.sessionId,
            generation: reopenedTab.generation,
          });
          if (!isCurrentRequest(requestId)) return null;
          if (locked?.state) finalSnapshot = applySnapshot(locked.state, 'ready');
        } catch (error) {
          if (!isCurrentRequest(requestId)) return null;
          setErrorMessage(getPurchaseBrowserErrorMessage(error));
        }
      }
      return finalSnapshot;
    } catch (error) {
      if (!isCurrentRequest(requestId)) return null;
      updateStatus('failed');
      setErrorMessage(getPurchaseBrowserErrorMessage(error));
      return null;
    }
  }, [accountId, applySnapshot, isCurrentRequest, openLogin, targetMode, updateStatus]);

  const inspect = React.useCallback(async () => {
    const requestId = requestIdRef.current;
    const tab = getPurchaseBrowserAccountTab(snapshot, accountId);
    if (!tab?.tabId) return null;
    setErrorMessage('');
    updateStatus('checking');
    try {
      const result = await inspectPurchaseBrowser(tab.tabId);
      if (!isCurrentRequest(requestId)) return null;
      setInspection(result.inspection);
      applySnapshot(result.state, 'checked');
      return result;
    } catch (error) {
      if (!isCurrentRequest(requestId)) return null;
      updateStatus('failed');
      setErrorMessage(getPurchaseBrowserErrorMessage(error));
      return null;
    }
  }, [accountId, applySnapshot, isCurrentRequest, snapshot, updateStatus]);

  const tab = getPurchaseBrowserAccountTab(snapshot, accountId);
  const presentation = STATUS_PRESENTATION[status] || STATUS_PRESENTATION.idle;
  const disabledReason = !enabled ? '请先保存当前拍单账号' : !target ? '当前采购平台暂不支持内置登录' : '';

  return {
    enabled: Boolean(enabled && target),
    accountId,
    accountLabel,
    platformName,
    platformUrl,
    target,
    panelOpen,
    busy: ['opening', 'checking'].includes(status),
    status,
    statusLabel: presentation.label,
    statusColor: presentation.color,
    disabledReason,
    snapshot,
    tab,
    inspection,
    errorMessage,
    openLogin,
    restoreLogin,
    openCrossBorderLogin,
    syncCrossBorder,
    crossBorderBusy,
    crossBorderResult,
    hideLogin,
    closeLogin,
    forceReset,
    reload,
    inspect,
    targetMode,
    recoverBrowser,
  };
}
