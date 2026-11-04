import { getProfileSetting, saveProfileSetting } from '../api/localApiClient.js';
import {
  normalizeLogisticsPricingSettings,
} from './logisticsPricingSettingsStore.js';
import { safeWarn } from './safeLog';

export const PROFILE_LOGISTICS_PRICING_SETTINGS_NAMESPACE = 'logistics-pricing-settings';

let logisticsPricingSettingsMemory = null;
let logisticsPricingSettingsWriteQueue = Promise.resolve();

export function readSavedLogisticsPricingSettings() {
  return logisticsPricingSettingsMemory || normalizeLogisticsPricingSettings(null);
}

export function withReadonlyLogisticsPricingSettings(snapshot, work) {
  if (typeof work !== 'function' || Object.prototype.toString.call(work) === '[object AsyncFunction]') throw new Error('LOGISTICS_SNAPSHOT_SYNC_REQUIRED');
  const previous = logisticsPricingSettingsMemory;
  logisticsPricingSettingsMemory = normalizeLogisticsPricingSettings(snapshot);
  try {
    const value = work();
    if (value && typeof value.then === 'function') throw new Error('LOGISTICS_SNAPSHOT_SYNC_REQUIRED');
    return value;
  } finally { logisticsPricingSettingsMemory = previous; }
}

export function rememberLogisticsPricingSettings(value) {
  logisticsPricingSettingsMemory = normalizeLogisticsPricingSettings(value);
  return logisticsPricingSettingsMemory;
}

export async function loadLogisticsPricingSettings() {
  const current = await getProfileSetting(PROFILE_LOGISTICS_PRICING_SETTINGS_NAMESPACE, { timeoutMs: 10000 });
  return rememberLogisticsPricingSettings(current?.setting?.value);
}

export function enqueueLogisticsPricingSettingsWrite(writer) {
  const writePromise = logisticsPricingSettingsWriteQueue.catch(() => undefined).then(writer);
  logisticsPricingSettingsWriteQueue = writePromise.catch(() => undefined);
  return writePromise;
}

export function saveLogisticsPricingSettings(value) {
  const nextSettings = rememberLogisticsPricingSettings({
    ...value,
    updatedAt: new Date().toISOString(),
  });
  enqueueLogisticsPricingSettingsWrite(async () => {
    const saved = await saveProfileSetting(
      PROFILE_LOGISTICS_PRICING_SETTINGS_NAMESPACE,
      nextSettings,
      { timeoutMs: 30000 }
    );
    if (!saved?.setting?.value) throw new Error('local-api 未返回物流预估设置。');
    rememberLogisticsPricingSettings(saved.setting.value);
  }).catch((error) => {
    safeWarn('[物流预估设置] local-api 保存失败', error);
  });
  return nextSettings;
}
