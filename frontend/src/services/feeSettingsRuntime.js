import { getProfileSetting, saveProfileSetting } from '../api/localApiClient.js';
import {
  getActiveFeeSettingsFromPlanState,
  normalizeFeePlanState,
  snapshotActiveRechargeRate,
} from './feeSettingsStore';
import { safeWarn } from './safeLog';

export const PROFILE_FEE_SETTINGS_NAMESPACE = 'fee-settings';

export const feePlatformOptions = [
  { value: 'crossBorderBus', label: '跨境巴士' },
  { value: 'ozon', label: 'Ozon' },
  { value: 'purchase', label: '拍单平台' },
];

let feePlanStateMemory = null;
let feeSettingsWriteQueue = Promise.resolve();

export function readSavedFeePlanState() {
  return feePlanStateMemory || normalizeFeePlanState(null);
}

export function readSavedFeeSettings() {
  return getActiveFeeSettingsFromPlanState(readSavedFeePlanState());
}

// Pure synchronous calculation scope. No durable writes, requests or cache
// migration; a private worker may evaluate one tenant's supplied fee snapshot.
export function withReadonlyFeePlanState(snapshot, work) {
  if (typeof work !== 'function') throw new Error('FEE_SNAPSHOT_CALLBACK_REQUIRED');
  if (Object.prototype.toString.call(work) === '[object AsyncFunction]') throw new Error('FEE_SNAPSHOT_ASYNC_FORBIDDEN');
  const previous = feePlanStateMemory;
  feePlanStateMemory = normalizeFeePlanState(snapshot);
  try {
    const value = work();
    if (value && typeof value.then === 'function') throw new Error('FEE_SNAPSHOT_ASYNC_FORBIDDEN');
    return value;
  } finally { feePlanStateMemory = previous; }
}

/** Canonical runtime load: the local-api SQLite record is the only durable input. */
export async function loadFeePlanState() {
  const current = await getProfileSetting(PROFILE_FEE_SETTINGS_NAMESPACE, { timeoutMs: 10000 });
  feePlanStateMemory = current?.setting?.value
    ? snapshotActiveRechargeRate(current.setting.value, {
        effectiveAt: current.setting.updatedAt || new Date().toISOString(),
      })
    : normalizeFeePlanState(null);
  return feePlanStateMemory;
}

export function enqueueFeeSettingsWrite(writer) {
  const writePromise = feeSettingsWriteQueue.catch(() => undefined).then(writer);
  feeSettingsWriteQueue = writePromise.catch(() => undefined);
  return writePromise;
}

/** Optimistic UI state is kept in memory; durable persistence is always local-api SQLite. */
export function saveFeePlanState(nextState) {
  const normalizedState = snapshotActiveRechargeRate(nextState);
  feePlanStateMemory = normalizedState;
  enqueueFeeSettingsWrite(async () => {
    const saved = await saveProfileSetting(PROFILE_FEE_SETTINGS_NAMESPACE, normalizedState, { timeoutMs: 30000 });
    if (!saved?.setting?.value) throw new Error('local-api 未返回费用方案。');
    feePlanStateMemory = normalizeFeePlanState(saved.setting.value);
    if (saved?.crossBorderChargeRevaluation && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('wangzai-cross-border-charges-revalued', {
        detail: saved.crossBorderChargeRevaluation,
      }));
    }
  }).catch((error) => {
    safeWarn('[费用设置] local-api 保存失败', error);
  });
  return normalizedState;
}

export function toFiniteFeeNumber(value) {
  if (String(value ?? '').trim() === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

export function formatFeeMetric(value) {
  return value === null || value === '' ? '未填写' : `${Number(value).toFixed(2)} 元/单`;
}
