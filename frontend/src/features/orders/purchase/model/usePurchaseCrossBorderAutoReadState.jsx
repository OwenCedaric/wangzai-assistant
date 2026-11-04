import { getPurchaseOrderRecordKey } from '../lib/purchaseMarketingApi.jsx';
import { hasValidPurchaseOrderNumber } from '../lib/purchaseOrderNormalize.jsx';
import React from 'react';

const PURCHASE_CROSS_BORDER_AUTO_READ_INITIAL_DELAY_MS = 15000;
const PURCHASE_CROSS_BORDER_AUTO_READ_INTERVAL_MS = 2 * 60 * 1000;
const PURCHASE_CROSS_BORDER_AUTO_READ_COOLDOWN_MS = PURCHASE_CROSS_BORDER_AUTO_READ_INTERVAL_MS;
const PURCHASE_CROSS_BORDER_AUTO_READ_BATCH_SIZE = 6;
const PURCHASE_CROSS_BORDER_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

function isFilledCrossBorderValue(value) {
  if (value === null || value === undefined) return false;
  const text = String(value).trim();
  if (!text) return false;
  if (/^(?:0|0\.0+|0\s*(?:kg|cm)?|未返回|待确认|null|undefined|nan|-|—)$/i.test(text)) return false;
  return true;
}

function getPositiveNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function hasCompleteVolumeItem(item = {}) {
  const weight = getPositiveNumber(item.grossWeight ?? item.weight ?? item.weightKg ?? item.weightText);
  const length = getPositiveNumber(item.length ?? item.lengthCm ?? item.long ?? item.l);
  const width = getPositiveNumber(item.width ?? item.widthCm ?? item.w);
  const height = getPositiveNumber(item.height ?? item.heightCm ?? item.h);
  return Boolean(weight && length && width && height);
}

export function hasCompleteCrossBorderCoreInfo(order = {}) {
  const sourceOrder = order.sourceOrder ?? {};
  const volumeItems = [
    ...(Array.isArray(order.volumeItems) ? order.volumeItems : []),
    ...(Array.isArray(sourceOrder.volumeItems) ? sourceOrder.volumeItems : []),
  ];
  const hasId = [
    order.packageOrderId,
    order.crossBorderOrderId,
    order.crossBorderOrderNumber,
    sourceOrder.packageOrderId,
    sourceOrder.crossBorderOrderId,
    sourceOrder.crossBorderOrderNumber,
  ].some(isFilledCrossBorderValue);
  if (!hasId) return false;

  if (volumeItems.some(hasCompleteVolumeItem)) return true;

  const weight = [
    order.packageWeight,
    order.packageWeightKg,
    sourceOrder.packageWeight,
    sourceOrder.packageWeightKg,
  ].some((value) => getPositiveNumber(value) !== null);
  const sizeValues = [order.packageSize, sourceOrder.packageSize];
  const size = sizeValues.some((value) => {
    if (!isFilledCrossBorderValue(value)) return false;
    const numbers = String(value).match(/-?\d+(?:\.\d+)?/g) ?? [];
    return numbers.map(Number).filter((number) => Number.isFinite(number) && number > 0).length >= 3;
  });
  const directSize =
    [order.length, order.lengthCm, sourceOrder.length, sourceOrder.lengthCm].some(
      (value) => getPositiveNumber(value) !== null
    ) &&
    [order.width, order.widthCm, sourceOrder.width, sourceOrder.widthCm].some(
      (value) => getPositiveNumber(value) !== null
    ) &&
    [order.height, order.heightCm, sourceOrder.height, sourceOrder.heightCm].some(
      (value) => getPositiveNumber(value) !== null
    );

  return weight && (size || directSize);
}

export function hasUsefulCrossBorderRead(order = {}) {
  return hasCompleteCrossBorderCoreInfo(order);
}

export function shouldAutoReadPurchaseCrossBorder(order = {}) {
  if (!order?.id) return false;
  if (!hasValidPurchaseOrderNumber(order)) return false;
  if (hasUsefulCrossBorderRead(order)) return false;
  const status = String(order.status || order.purchaseRecordStatus || '').trim();
  if (/待拍单|未付款|已退款/.test(status)) return false;
  const sourceOrder = order.sourceOrder ?? {};
  const hasForecastIdentity = [
    order.packageOrderId,
    order.crossBorderOrderId,
    order.crossBorderOrderNumber,
    sourceOrder.packageOrderId,
    sourceOrder.crossBorderOrderId,
    sourceOrder.crossBorderOrderNumber,
  ].some(isFilledCrossBorderValue);
  if (/待预报/.test(status) && !hasForecastIdentity) return false;
  return true;
}

function createPurchaseCrossBorderNotification(order = {}, detail = {}) {
  const orderKey = getPurchaseOrderRecordKey(order) || order.id || detail.matchedKey || detail.orderId;
  const crossBorderOrderId = detail.orderId || detail.packageOrderId || '';
  if (!orderKey || !crossBorderOrderId) return null;
  const createdAt = new Date().toISOString();
  return {
    id: `purchase-cross-border:${orderKey}:${crossBorderOrderId}`,
    domain: 'purchase',
    eventType: 'purchase_order_changed',
    type: 'purchase_cross_border_found',
    title: '跨境巴士已回查',
    message: `${order.id || orderKey} 已抓取跨境巴士订单 ${crossBorderOrderId}`,
    orderKey,
    createdAt,
  };
}

export function usePurchaseCrossBorderAutoReadState({
  enabled = true,
  purchaseOrders = [],
  readCrossBorderForOrder,
  onOrderNotifications,
} = {}) {
  const readStateRef = React.useRef(new Map());
  const runPromiseRef = React.useRef(null);
  const notifyRef = React.useRef(onOrderNotifications);
  React.useEffect(() => {
    notifyRef.current = onOrderNotifications;
  }, [onOrderNotifications]);

  const runBackgroundRead = React.useCallback(() => {
    if (!enabled || typeof readCrossBorderForOrder !== 'function') return Promise.resolve();
    if (runPromiseRef.current) return runPromiseRef.current;
    const operation = (async () => {
    const now = Date.now();
    const candidates = (Array.isArray(purchaseOrders) ? purchaseOrders : [])
      .filter(shouldAutoReadPurchaseCrossBorder)
      .filter((order) => {
        const key = getPurchaseOrderRecordKey(order) || order.id;
        if (!key) return false;
        const state = readStateRef.current.get(key) || {};
        if (state.running) return false;
        return now - Number(state.lastTriedAt || 0) >= PURCHASE_CROSS_BORDER_AUTO_READ_COOLDOWN_MS;
      })
      .slice(0, PURCHASE_CROSS_BORDER_AUTO_READ_BATCH_SIZE);

    for (const order of candidates) {
      const key = getPurchaseOrderRecordKey(order) || order.id;
      readStateRef.current.set(key, { ...(readStateRef.current.get(key) || {}), running: true, lastTriedAt: now });
      try {
        const detail = await readCrossBorderForOrder(order, { force: true, background: true });
        const notification = createPurchaseCrossBorderNotification(order, detail || {});
        if (notification && typeof notifyRef.current === 'function') notifyRef.current([notification]);
        readStateRef.current.set(key, {
          running: false,
          lastTriedAt: Date.now(),
          lastFoundOrderId: detail?.orderId || '',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || '');
        const blockedUntil = /429|too many requests|请求过多|限流/i.test(message)
          ? Date.now() + PURCHASE_CROSS_BORDER_RATE_LIMIT_COOLDOWN_MS
          : /授权|账号|仓库|平台设置|credentials|required/i.test(message)
            ? Date.now() + PURCHASE_CROSS_BORDER_AUTO_READ_COOLDOWN_MS * 4
            : Date.now();
        readStateRef.current.set(key, {
          running: false,
          lastTriedAt: blockedUntil,
          lastError: message,
        });
      }
    }
    })();
    runPromiseRef.current = operation;
    void operation.finally(() => {
      if (runPromiseRef.current === operation) runPromiseRef.current = null;
    });
    return operation;
  }, [enabled, purchaseOrders, readCrossBorderForOrder]);

  React.useEffect(() => {
    if (!enabled) return undefined;
    let intervalId = null;
    const timeoutId = window.setTimeout(() => {
      runBackgroundRead();
      intervalId = window.setInterval(runBackgroundRead, PURCHASE_CROSS_BORDER_AUTO_READ_INTERVAL_MS);
    }, PURCHASE_CROSS_BORDER_AUTO_READ_INITIAL_DELAY_MS);
    return () => {
      window.clearTimeout(timeoutId);
      if (intervalId) window.clearInterval(intervalId);
    };
  }, [enabled, runBackgroundRead]);
}
