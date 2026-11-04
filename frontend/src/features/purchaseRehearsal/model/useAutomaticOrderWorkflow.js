import React from 'react';

import { isOzonAwaitingDeliveryRawStatus } from '../../../entities/order/orderStatusRules.jsx';
import { writePurchaseOrderLocalOverrideUpsert } from '../../../services/purchaseOrderRuntime.js';
import {
  automaticOrderActionLabels,
  automaticOrderErrorMessage,
  automaticOrderSections,
  executeAutomaticOrderAction,
  loadAutomaticOrderWorkspace,
} from '../services/automaticOrderWorkflowService.js';
import { loadPurchaseAutoPaySettings } from '../services/purchaseAutoPaySettingsService.js';
import {
  appendPurchaseAutoPayLog,
  clearPurchaseAutoPayLogs,
  loadPurchaseAutoPayLogs,
} from '../services/purchaseAutoPayLogService.js';
import { resumePurchaseAutoOrder } from '../services/purchasePaymentCredentialClient.js';
import {
  getOzonPushRealtimeShopId,
  isOzonPushDomainRefreshEvent,
  OZON_PUSH_REALTIME_BROWSER_EVENT,
} from '../../../services/ozonPushRealtime.js';

function timeSeconds(value = '') {
  const match = String(value || '').trim().match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/u);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

export function isPurchaseAutoPayScheduleActive(settings = {}, now = new Date()) {
  if (settings.enabled !== true) return false;
  const current = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const start = settings.needAutoStart ? timeSeconds(settings.autoStartTime) : null;
  const end = settings.needAutoEnd ? timeSeconds(settings.autoEndTime) : null;
  if (settings.needAutoStart && start === null) return false;
  if (settings.needAutoEnd && end === null) return false;
  if (start !== null && end !== null) {
    if (start === end) return true;
    return start < end ? current >= start && current < end : current >= start || current < end;
  }
  if (start !== null) return current >= start;
  if (end !== null) return current < end;
  return true;
}

function sourcePlatformForRow(row = {}) {
  return String(row.products?.[0]?.exactBinding?.binding?.sourcePlatform || '').trim();
}

function platformEnabled(settings, platform) {
  if (platform === '拼多多') return settings.allowPinduoduo === true;
  if (platform === '淘宝') return settings.allowTaobao === true;
  if (platform === '天猫') return settings.allowTmall === true;
  if (platform === '1688') return settings.allow1688 === true;
  return false;
}

function platformIntervalMs(settings, platform) {
  const minutes = platform === '拼多多'
    ? settings.pddIntervalMinutes
    : platform === '淘宝' || platform === '天猫'
      ? settings.taobaoIntervalMinutes
      : settings.alibaba1688IntervalMinutes;
  return Math.max(1, Number(minutes) || 1) * 60_000;
}

function playAutoPayAlert() {
  try {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.8);
    oscillator.connect(gain); gain.connect(context.destination);
    oscillator.start(); oscillator.stop(context.currentTime + 0.8);
    oscillator.onended = () => { void context.close(); };
  } catch { /* alert audio cannot break payment state */ }
}

function readFixture() {
  const value = globalThis.__WANGZAI_AUTO_ORDER_E2E__;
  return value && typeof value === 'object' && value.enabled === true ? value : null;
}

function taskKey(action, rowId) {
  return `${action}:${rowId}`;
}

function purchaseFromPatch(current = {}, patch = {}) {
  return {
    platform: String(patch.manualBuyerPlatform || patch.purchasePlatform || current.platform || '').trim(),
    orderNumber: String(patch.manualPurchaseOrderNo || patch.purchaseOrderNumber || current.orderNumber || '').trim(),
    amount: Number.isFinite(Number(patch.manualPurchasePriceValue ?? patch.sourceCostCny))
      ? Number(patch.manualPurchasePriceValue ?? patch.sourceCostCny)
      : current.amount,
    status: String(patch.manualPurchaseOrderStatus || patch.purchaseOrderStatus || current.status || '').trim(),
    url: String(patch.purchaseOrderUrl || current.url || '').trim(),
  };
}

function applyResultToRow(row, action, result) {
  const workflow = { ...row.workflow };
  if (action === automaticOrderSections.autoOrder) {
    workflow[automaticOrderSections.autoOrder] = 'completed';
    workflow.stock = row.rawStatus === 'awaiting_packaging' ? 'ready' : workflow.stock;
  } else if (action === automaticOrderSections.stock) {
    workflow.stock = 'completed';
    workflow.forecast = isOzonAwaitingDeliveryRawStatus(result.rowPatch?.rawStatus) ? 'ready' : 'blocked';
  } else if (action === automaticOrderSections.forecast) {
    workflow.forecast = 'completed';
  }
  return {
    ...row,
    ...(result.rowPatch || {}),
    workflow,
    purchase: purchaseFromPatch(row.purchase, result.patch),
    flow: result.patch?.purchaseForecastFlow || row.flow,
    override: { ...row.override, ...(result.patch || {}) },
  };
}

export function useAutomaticOrderWorkflow({ shops = [], isActive = true } = {}) {
  const [workspace, setWorkspace] = React.useState({
    rows: [], overrides: {}, shops, errors: [], fixture: false, fetchedAt: '',
  });
  const [loading, setLoading] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState('');
  const [selectionBySection, setSelectionBySection] = React.useState({
    [automaticOrderSections.autoOrder]: new Set(),
    [automaticOrderSections.stock]: new Set(),
    [automaticOrderSections.forecast]: new Set(),
  });
  const [taskStates, setTaskStates] = React.useState({});
  const [logs, setLogs] = React.useState([]);
  const runningRef = React.useRef(false);
  const scheduledRunRef = React.useRef(false);
  const lastScheduledPlatformRunRef = React.useRef(new Map());
  const workspaceRef = React.useRef(workspace);
  const selectionRef = React.useRef(selectionBySection);
  const loadedOnceRef = React.useRef(false);
  const pendingOrderCacheReloadRef = React.useRef(false);

  React.useEffect(() => { workspaceRef.current = workspace; }, [workspace]);
  React.useEffect(() => { selectionRef.current = selectionBySection; }, [selectionBySection]);
  React.useEffect(() => {
    if (readFixture()) return;
    let disposed = false;
    loadPurchaseAutoPayLogs().then((value) => { if (!disposed) setLogs(value); }).catch(() => undefined);
    return () => { disposed = true; };
  }, []);

  const refresh = React.useCallback(async ({ forceRefresh = false } = {}) => {
    if (!isActive) return null;
    setLoading(true);
    setErrorMessage('');
    try {
      const next = await loadAutomaticOrderWorkspace({
        shops,
        forceRefresh,
        fixture: readFixture(),
      });
      const fixtureModeChanged = workspaceRef.current.fixture !== next.fixture;
      workspaceRef.current = next;
      loadedOnceRef.current = true;
      setWorkspace(next);
      if (next.fixture || fixtureModeChanged) {
        setTaskStates({});
        setLogs([]);
      }
      const emptySelection = {
        [automaticOrderSections.autoOrder]: new Set(),
        [automaticOrderSections.stock]: new Set(),
        [automaticOrderSections.forecast]: new Set(),
      };
      selectionRef.current = emptySelection;
      setSelectionBySection(emptySelection);
      return next;
    } catch (error) {
      setErrorMessage(automaticOrderErrorMessage(error));
      return null;
    } finally {
      setLoading(false);
    }
  }, [isActive, shops]);

  React.useEffect(() => {
    if (!isActive) return undefined;
    if (!loadedOnceRef.current || pendingOrderCacheReloadRef.current) {
      pendingOrderCacheReloadRef.current = false;
      void refresh();
    }
    const handleFixtureRefresh = () => { void refresh(); };
    const handleBindingSaved = () => { void refresh(); };
    const handlePurchaseOverrideUpdated = () => {
      if (!runningRef.current) void refresh();
    };
    globalThis.addEventListener?.('wangzai:auto-order-e2e-refresh', handleFixtureRefresh);
    globalThis.addEventListener?.('wangzai:auto-order-binding-saved', handleBindingSaved);
    globalThis.addEventListener?.('wangzai:purchase-order-overrides-updated', handlePurchaseOverrideUpdated);
    return () => {
      globalThis.removeEventListener?.('wangzai:auto-order-e2e-refresh', handleFixtureRefresh);
      globalThis.removeEventListener?.('wangzai:auto-order-binding-saved', handleBindingSaved);
      globalThis.removeEventListener?.('wangzai:purchase-order-overrides-updated', handlePurchaseOverrideUpdated);
    };
  }, [isActive, refresh]);

  React.useEffect(() => {
    const readableShopIds = new Set((Array.isArray(shops) ? shops : [])
      .map((shop) => String(shop?.id || '').trim())
      .filter(Boolean));
    let timer = null;
    const handleOrderCacheUpdated = (event) => {
      if (!isOzonPushDomainRefreshEvent(event, 'orders')) return;
      const shopId = getOzonPushRealtimeShopId(event);
      if (!shopId || !readableShopIds.has(shopId)) return;
      if (!isActive || runningRef.current) {
        pendingOrderCacheReloadRef.current = true;
        return;
      }
      globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(() => {
        pendingOrderCacheReloadRef.current = false;
        void refresh();
      }, 100);
    };
    globalThis.addEventListener?.(OZON_PUSH_REALTIME_BROWSER_EVENT, handleOrderCacheUpdated);
    return () => {
      globalThis.clearTimeout(timer);
      globalThis.removeEventListener?.(OZON_PUSH_REALTIME_BROWSER_EVENT, handleOrderCacheUpdated);
    };
  }, [isActive, refresh, shops]);

  const toggleSelection = React.useCallback((section, rowId) => {
    setSelectionBySection((current) => {
      const next = new Set(current[section] || []);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      const value = { ...current, [section]: next };
      selectionRef.current = value;
      return value;
    });
  }, []);

  const selectAllReady = React.useCallback((section) => {
    setSelectionBySection((current) => {
      const readyIds = workspace.rows
        .filter((row) => row.workflow?.[section] === 'ready')
        .map((row) => row.id);
      const selected = current[section] || new Set();
      const allSelected = readyIds.length > 0 && readyIds.every((id) => selected.has(id));
      const value = { ...current, [section]: new Set(allSelected ? [] : readyIds) };
      selectionRef.current = value;
      return value;
    });
  }, [workspace.rows]);

  const appendLog = React.useCallback((entry) => {
    const log = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: new Date().toISOString(),
      ...entry,
    };
    setLogs((current) => [log, ...current].slice(0, 500));
    if (!readFixture()) void appendPurchaseAutoPayLog(log).catch(() => undefined);
  }, []);

  const executeSelected = React.useCallback(async (section) => {
    if (runningRef.current) return { success: 0, failed: 0 };
    const currentWorkspace = workspaceRef.current;
    const selectedIds = selectionRef.current[section] || new Set();
    const targets = currentWorkspace.rows.filter((row) => (
      selectedIds.has(row.id) && row.workflow?.[section] === 'ready'
    ));
    if (!targets.length) {
      setErrorMessage('请先勾选至少一个可以处理的订单。');
      return { success: 0, failed: 0 };
    }
    runningRef.current = true;
    setErrorMessage('');
    let currentOverrides = currentWorkspace.overrides;
    let currentRows = currentWorkspace.rows;
    let success = 0;
    let failed = 0;
    const executeTarget = async (target, delayMs = 0) => {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const key = taskKey(section, target.id);
      setTaskStates((current) => ({
        ...current,
        [key]: { status: 'running', message: `正在执行${automaticOrderActionLabels[section]}` },
      }));
      try {
        const result = await executeAutomaticOrderAction(section, target, { fixture: currentWorkspace.fixture });
        return { target, key, result, error: null };
      } catch (error) {
        return { target, key, result: null, error };
      }
    };
    let outcomes = [];
    const settings = section === automaticOrderSections.autoOrder && !currentWorkspace.fixture
      ? await loadPurchaseAutoPaySettings().catch(() => null)
      : null;
    if (settings?.allowTogetherPay === true && targets.length > 1) {
      outcomes.push(await executeTarget(targets[0]));
      if (!outcomes[0].error) {
        outcomes.push(...await Promise.all(targets.slice(1).map((target, index) => executeTarget(target, index * 10_000))));
      } else {
        for (const target of targets.slice(1)) outcomes.push({ target, key: taskKey(section, target.id), result: null, error: new Error('首单未成功，已停止本轮错峰支付。') });
      }
    } else {
      for (const target of targets) outcomes.push(await executeTarget(target));
    }

    for (const outcome of outcomes) {
      const { target, key, result, error } = outcome;
      if (!error) {
        try {
          if (!currentWorkspace.fixture) {
            const plan = writePurchaseOrderLocalOverrideUpsert(currentOverrides, target.order, target.shop, result.patch || {});
            if (!plan) throw new Error('订单缺少精确店铺或订单身份，采购信息未写入。');
            const persisted = await plan.persistence;
            if (persisted.failedKeys?.length) throw new Error('采购信息写入后回读失败。');
            currentOverrides = plan.overrides;
          }
          currentRows = currentRows.map((row) => row.id === target.id ? applyResultToRow(row, section, result) : row);
          const nextWorkspace = { ...workspaceRef.current, rows: currentRows, overrides: currentOverrides };
          workspaceRef.current = nextWorkspace;
          setWorkspace(nextWorkspace);
          setTaskStates((current) => ({ ...current, [key]: { status: 'completed', message: result.message } }));
          const paymentItem = result.patch?.purchaseOrderItems?.[0] || {};
          appendLog({
            section, rowId: target.id, posting: target.posting, status: 'success', message: result.message,
            platform: paymentItem.platform || result.patch?.manualBuyerPlatform || '',
            orderNumber: paymentItem.orderNumber || result.patch?.manualPurchaseOrderNo || '',
            amount: paymentItem.amount ?? result.patch?.manualPurchasePriceValue,
            transactionNo: paymentItem.transactionNo || '',
          });
          success += 1;
          continue;
        } catch (persistError) {
          outcome.error = persistError;
        }
      }
      const finalError = outcome.error;
      const message = automaticOrderErrorMessage(finalError);
      const paused = Boolean(finalError?.resumeTabId || finalError?.code === 'PURCHASE_AUTO_ORDER_PAYMENT_PAUSED');
      if (paused || /验证码|密码|余额不足|风险|锁定/u.test(message)) playAutoPayAlert();
      setTaskStates((current) => ({
        ...current,
        [key]: { status: paused ? 'paused' : 'failed', message, resumeTabId: String(finalError?.resumeTabId || '') },
      }));
      appendLog({ section, rowId: target.id, posting: target.posting, status: paused ? 'paused' : 'error', message });
      failed += 1;
    }
    const selection = { ...selectionRef.current, [section]: new Set() };
    selectionRef.current = selection;
    setSelectionBySection(selection);
    runningRef.current = false;
    return { success, failed };
  }, [appendLog]);

  const resumeRow = React.useCallback(async (section, rowId) => {
    const state = taskStates[taskKey(section, rowId)];
    if (!state?.resumeTabId) {
      setErrorMessage('当前订单没有可恢复的支付窗口，请重新执行该订单。');
      return { success: 0, failed: 1 };
    }
    setTaskStates((current) => ({
      ...current,
      [taskKey(section, rowId)]: { ...state, status: 'running', message: '正在继续自动付款…' },
    }));
    try {
      const resumed = await resumePurchaseAutoOrder(state.resumeTabId);
      if (resumed?.paused === true) throw new Error(resumed.pauseReason || '自动付款仍需人工处理。');
      const selection = { ...selectionRef.current, [section]: new Set([rowId]) };
      selectionRef.current = selection;
      setSelectionBySection(selection);
      return await executeSelected(section);
    } catch (error) {
      const message = automaticOrderErrorMessage(error);
      setTaskStates((current) => ({
        ...current,
        [taskKey(section, rowId)]: { ...state, status: 'paused', message },
      }));
      appendLog({ section, rowId, posting: workspaceRef.current.rows.find((row) => row.id === rowId)?.posting || rowId, status: 'paused', message });
      return { success: 0, failed: 1 };
    }
  }, [appendLog, executeSelected, taskStates]);

  React.useEffect(() => {
    let disposed = false;
    const runScheduled = async () => {
      if (disposed || runningRef.current || scheduledRunRef.current) return;
      const settings = await loadPurchaseAutoPaySettings().catch(() => null);
      if (!settings || !isPurchaseAutoPayScheduleActive(settings)) return;
      const currentRows = workspaceRef.current.rows || [];
      const now = Date.now();
      const duePlatforms = new Set();
      for (const row of currentRows) {
        if (row.workflow?.[automaticOrderSections.autoOrder] !== 'ready') continue;
        const platform = sourcePlatformForRow(row);
        if (!platformEnabled(settings, platform)) continue;
        const previous = Number(lastScheduledPlatformRunRef.current.get(platform)) || 0;
        if (now - previous >= platformIntervalMs(settings, platform)) duePlatforms.add(platform);
      }
      if (!duePlatforms.size) return;
      const targets = currentRows.filter((row) => (
        row.workflow?.[automaticOrderSections.autoOrder] === 'ready'
        && duePlatforms.has(sourcePlatformForRow(row))
      ));
      if (!targets.length) return;
      for (const platform of duePlatforms) lastScheduledPlatformRunRef.current.set(platform, now);
      const selection = {
        ...selectionRef.current,
        [automaticOrderSections.autoOrder]: new Set(targets.map((row) => row.id)),
      };
      selectionRef.current = selection;
      setSelectionBySection(selection);
      appendLog({
        section: automaticOrderSections.autoOrder,
        rowId: 'scheduled-auto-pay',
        posting: '定时扫描',
        status: 'running',
        message: `自动付款扫描命中 ${targets.length} 笔待拍单订单。`,
      });
      scheduledRunRef.current = true;
      try { await executeSelected(automaticOrderSections.autoOrder); }
      finally { scheduledRunRef.current = false; }
    };
    const initialTimer = setTimeout(() => { void runScheduled(); }, 5_000);
    const timer = setInterval(() => { void runScheduled(); }, 60_000);
    return () => {
      disposed = true;
      clearTimeout(initialTimer);
      clearInterval(timer);
    };
  }, [appendLog, executeSelected]);

  const clearLogs = React.useCallback(() => {
    setLogs([]);
    if (!readFixture()) void clearPurchaseAutoPayLogs().catch(() => undefined);
  }, []);

  return {
    rows: workspace.rows,
    fixture: workspace.fixture,
    fetchedAt: workspace.fetchedAt,
    loading,
    errorMessage,
    selectionBySection,
    taskStates,
    logs,
    refresh,
    toggleSelection,
    selectAllReady,
    executeSelected,
    resumeRow,
    clearLogs,
  };
}
