import {
  confirmPurchaseBrowserCapture,
  previewPurchaseBrowserCapture,
  readPurchaseBrowserCapture,
} from '../../../api/localApiClient.js';
import {
  capturePurchaseBrowserPreview,
  confirmPurchaseBrowserCaptureOnTab,
  capturePurchaseBrowser,
  clearPurchaseBrowserTarget,
  getPurchaseBrowserTarget,
  setPurchaseBrowserTarget,
} from './purchaseBrowserLoginClient.js';

function text(value, maximum = 600) {
  return String(value ?? '')
    .replace(/[^\x20-\x7E\u4E00-\u9FFF]/gu, '')
    .trim()
    .slice(0, maximum);
}

export function normalizePurchaseBrowserTarget(value = {}) {
  return {
    targetId: text(value.targetId, 180),
    shopId: text(value.shopId, 180),
    orderKey: text(value.orderKey, 260),
    ozonOrderId: text(value.ozonOrderId, 260),
    sku: text(value.sku, 260),
    offerId: text(value.offerId, 260),
    productTitle: text(value.productTitle, 600),
    quantity: value.quantity ?? null,
    purchaseRecordId: text(value.purchaseRecordId, 260),
    requiredFields: Array.isArray(value.requiredFields)
      ? value.requiredFields
          .map((field) => text(field, 80))
          .filter(Boolean)
          .slice(0, 20)
      : ['purchasePlatform', 'purchaseOrderNumber', 'sourceCostCny', 'sourceUrl'],
    selectedAt: text(value.selectedAt, 80) || new Date().toISOString(),
  };
}

function assertTarget(target) {
  if (!target.targetId || !target.shopId || !target.orderKey) {
    const error = new Error('PURCHASE_BROWSER_TARGET_REQUIRED');
    error.code = 'PURCHASE_BROWSER_TARGET_REQUIRED';
    throw error;
  }
  return target;
}

function hasDesktopBrowserBridge() {
  return typeof globalThis.window?.wangzaiDesktop?.purchaseBrowser?.command === 'function';
}

function canUseLegacyCaptureFallback(error) {
  return ['PURCHASE_BROWSER_BRIDGE_UNAVAILABLE', 'PURCHASE_BROWSER_COMMAND_INVALID'].includes(
    String(error?.code || '')
  );
}

export async function lockPurchaseBrowserTarget({ tabId, target } = {}) {
  return setPurchaseBrowserTarget({ tabId, target: assertTarget(normalizePurchaseBrowserTarget(target)) });
}

export function unlockPurchaseBrowserTarget(tabId) {
  return clearPurchaseBrowserTarget(tabId);
}

function targetIdentity(value = {}) {
  const target = normalizePurchaseBrowserTarget(value);
  return JSON.stringify([
    target.targetId,
    target.shopId,
    target.orderKey,
    target.ozonOrderId,
    target.sku,
    target.offerId,
    target.productTitle,
    target.quantity,
    target.purchaseRecordId,
    [...(target.requiredFields || [])].sort(),
  ]);
}

async function assertNativeTarget(tabId, expectedTarget, signal) {
  const response = await getPurchaseBrowserTarget(tabId, { signal });
  const stateTarget = response?.state?.tabs?.find((tab) => tab.tabId === tabId)?.target || null;
  const currentTarget = response?.target || stateTarget;
  if (!currentTarget) {
    const error = new Error('PURCHASE_BROWSER_TARGET_REQUIRED');
    error.code = 'PURCHASE_BROWSER_TARGET_REQUIRED';
    throw error;
  }
  if (targetIdentity(currentTarget) !== targetIdentity(expectedTarget)) {
    const error = new Error('PURCHASE_BROWSER_TARGET_AMBIGUOUS');
    error.code = 'PURCHASE_BROWSER_TARGET_AMBIGUOUS';
    throw error;
  }
  return currentTarget;
}

export async function previewPurchaseCapture({ tabId, target, signal } = {}) {
  const normalizedTarget = assertTarget(normalizePurchaseBrowserTarget(target));
  // Capturing is read/preview work. It must never silently replace a target
  // when the order page or browser session changed in the background.
  if (hasDesktopBrowserBridge()) await assertNativeTarget(tabId, normalizedTarget, signal);
  if (signal?.aborted) {
    const error = new Error('The capture request was aborted.');
    error.name = 'AbortError';
    throw error;
  }
  if (hasDesktopBrowserBridge()) {
    try {
      const nativePreview = await capturePurchaseBrowserPreview(tabId, { signal });
      if (signal?.aborted) {
        const error = new Error('The capture request was aborted.');
        error.name = 'AbortError';
        throw error;
      }
      if (nativePreview.preview) return { ...nativePreview, target: normalizedTarget };
    } catch (error) {
      if (!canUseLegacyCaptureFallback(error)) throw error;
    }
  }
  const captured = await capturePurchaseBrowser(tabId, { signal });
  const preview = await previewPurchaseBrowserCapture(
    {
      target: normalizedTarget,
      capture: captured.capture,
    },
    { signal }
  );
  return {
    ok: preview?.ok === true,
    target: normalizedTarget,
    capture: captured.capture,
    preview,
    state: captured.state,
  };
}

export async function confirmPurchaseCapture({ tabId = '', preview, target, acceptConflicts = false, signal } = {}) {
  const normalizedTarget = assertTarget(normalizePurchaseBrowserTarget(target));
  if (signal?.aborted) {
    const error = new Error('The capture request was aborted.');
    error.name = 'AbortError';
    throw error;
  }
  if (hasDesktopBrowserBridge() && tabId && preview?.previewId && preview?.confirmationToken) {
    try {
      const nativeResult = await confirmPurchaseBrowserCaptureOnTab({
        tabId,
        confirmationToken: preview.confirmationToken,
        acceptConflicts,
        signal,
      });
      if (signal?.aborted) {
        const error = new Error('The capture request was aborted.');
        error.name = 'AbortError';
        throw error;
      }
      if (nativeResult.readbackVerified === true) return nativeResult;
      if (nativeResult.result || nativeResult.state?.engine === 'cef') {
        const error = new Error('PURCHASE_BROWSER_READBACK_FAILED');
        error.code = 'PURCHASE_BROWSER_READBACK_FAILED';
        throw error;
      }
    } catch (error) {
      if (!canUseLegacyCaptureFallback(error)) throw error;
    }
  }
  const result = await confirmPurchaseBrowserCapture(
    {
      previewId: preview?.previewId,
      idempotencyKey: preview?.idempotencyKey || preview?.previewId,
      confirmationToken: preview?.confirmationToken,
      captureHash: preview?.captureHash,
      target: normalizedTarget,
      acceptConflicts: acceptConflicts === true,
    },
    { signal }
  );
  if (result?.readbackVerified !== true) {
    const error = new Error('PURCHASE_BROWSER_READBACK_FAILED');
    error.code = 'PURCHASE_BROWSER_READBACK_FAILED';
    throw error;
  }
  return result;
}

export function readPurchaseCapture(target, options = {}) {
  return readPurchaseBrowserCapture(assertTarget(normalizePurchaseBrowserTarget(target)), options);
}

