import { settleOwnerWriteDrain } from './ownerWriteDrain.js';
import {
  getLocalShops,
  getProfileSetting,
  saveLocalShop,
  saveProfileSetting,
} from '../api/localApiClient.js';
import { safeWarn } from './safeLog';
import {
  defaultOzonShops,
} from '../shared/config/appConfigCore.jsx';
import {
  isOzonShopGenerationFenced,
  normalizeOzonShopGenerationScope,
  serializeOzonShopGenerationScope,
} from '../shared/ozon/ozonShopGeneration.js';

export const PROFILE_OZON_SHOP_PREFERENCES_NAMESPACE = 'ozon-shop-preferences';
export let ozonShopSettingsMemory = null;
let ozonShopSettingsWriteQueue = Promise.resolve();
let ozonShopSettingsLastWrite = null;
const ozonShopSettingsFencedOwnerScopes = new Map();
const OZON_SHOP_WRITE_CONCURRENCY = 8;

async function mapWithBoundedConcurrency(values, concurrency, worker) {
  const source = Array.isArray(values) ? values : [];
  const limit = Math.min(Math.max(1, Number(concurrency) || 1), source.length || 1);
  let nextIndex = 0;
  const runWorker = async () => {
    while (nextIndex < source.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await worker(source[currentIndex], currentIndex);
    }
  };
  await Promise.all(Array.from({ length: limit }, runWorker));
}

function normalizeText(value) {
  return String(value || '').trim();
}

function assertOzonShopSettingsWritable(shops = []) {
  const fenced = (Array.isArray(shops) ? shops : [])
    .find((shop) => isOzonShopSettingsOwnerFenced(shop));
  if (!fenced) return;
  const error = new Error('ACCOUNT_REMOVAL_OWNER_QUIESCED');
  error.code = 'ACCOUNT_REMOVAL_OWNER_QUIESCED';
  error.ownerId = normalizeText(fenced?.id || fenced?.shopId);
  throw error;
}

export function isOzonShopSettingsOwnerFenced(shopOrScope = {}) {
  return isOzonShopGenerationFenced(shopOrScope, [...ozonShopSettingsFencedOwnerScopes.values()]);
}

function hasPlainOzonCredentials(shop = {}) {
  return Boolean(normalizeText(shop.clientId || shop.client_id) && normalizeText(shop.apiKey || shop.api_key));
}

function normalizeOzonShopCredentialFlags(shop = {}) {
  return {
    hasClientId: Boolean(shop.hasClientId === true || normalizeText(shop.clientId || shop.client_id)),
    hasApiKey: Boolean(shop.hasApiKey === true || normalizeText(shop.apiKey || shop.api_key)),
  };
}

function toLocalApiShopPayload(shop = {}) {
  const shopId = normalizeText(shop.id || shop.shopId);
  const clientId = normalizeText(shop.clientId || shop.client_id);
  const apiKey = normalizeText(shop.apiKey || shop.api_key);
  if (!shopId) return null;
  const payload = {
    id: shopId,
    name: normalizeText(shop.sellerName || shop.name || shop.shopAlias || shop.alias || shopId),
    alias: normalizeText(shop.shopAlias || shop.alias),
    status: shop.status || 'active',
  };
  // Empty renderer fields mean "not revealed in this session", not "clear the encrypted value".
  if (clientId) payload.clientId = clientId;
  if (apiKey) payload.apiKey = apiKey;
  return payload;
}

async function persistOzonShopsToLocalApi(shops = [], { persistShopIds } = {}) {
  const selectedIds = Array.isArray(persistShopIds)
    ? new Set(persistShopIds.map(normalizeText).filter(Boolean))
    : null;
  const payloads = (Array.isArray(shops) ? shops : [])
    .filter((shop) => !selectedIds || selectedIds.has(normalizeText(shop?.id || shop?.shopId)))
    .map(toLocalApiShopPayload)
    .filter(Boolean);
  await mapWithBoundedConcurrency(
    payloads,
    OZON_SHOP_WRITE_CONCURRENCY,
    (payload) => saveLocalShop(payload, { timeoutMs: 30000 }),
  );
  const readback = await getLocalShops({ timeoutMs: 10000 });
  return readback;
}

export function normalizeOzonDefaultWarehouseIds(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function normalizeSavedOzonShops(value) {
  if (!Array.isArray(value)) return defaultOzonShops;
  if (value.length === 0) return [];
  return value.map((shop, index) => {
    const normalizedShop = {
      ...defaultOzonShops[0],
      ...(shop && typeof shop === 'object' && !Array.isArray(shop) ? shop : {}),
      id: shop?.id || `ozon-shop-${index + 1}`,
    };
    return {
      ...normalizedShop,
      ...normalizeOzonShopCredentialFlags(normalizedShop),
    };
  });
}

export function normalizeOzonShopSettingsStore(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const hasExplicitShops = Array.isArray(value) || Array.isArray(source.shops);
  const shops = normalizeSavedOzonShops(hasExplicitShops ? (Array.isArray(value) ? value : source.shops) : defaultOzonShops);
  const requestedActiveId = String(source.activeShopId || source.activeId || '').trim();
  const activeShopId = shops.some((shop) => shop.id === requestedActiveId) ? requestedActiveId : (shops[0]?.id || '');
  return {
    version: 1,
    shops,
    activeShopId,
    defaultWarehouseIds: normalizeOzonDefaultWarehouseIds(source.defaultWarehouseIds || source.defaultWarehouseByShop),
    updatedAt: String(source.updatedAt || ''),
  };
}

function hasIncompletePlainOzonCredentials(shop = {}) {
  const clientId = normalizeText(shop.clientId || shop.client_id);
  const apiKey = normalizeText(shop.apiKey || shop.api_key);
  const flags = normalizeOzonShopCredentialFlags(shop);
  return Boolean(clientId || apiKey) && !(Boolean(clientId || flags.hasClientId) && Boolean(apiKey || flags.hasApiKey));
}

function toOzonShopPreferenceShop(shop = {}) {
  const preferences = { ...(shop && typeof shop === 'object' ? shop : {}) };
  delete preferences.clientId;
  delete preferences.client_id;
  delete preferences.apiKey;
  delete preferences.api_key;
  delete preferences.hasClientId;
  delete preferences.hasApiKey;
  delete preferences.apiKeyHint;
  delete preferences.shopIncarnation;
  delete preferences.shop_incarnation;
  delete preferences.credentialRevision;
  delete preferences.credential_revision;
  delete preferences.profileId;
  // The license center remains the only authority for shop-card state.  These
  // fields are runtime verification results, not user preferences.  Persisting
  // them both makes authorization stale and is rejected by the profile setting
  // secret-field guard (`licenseAuthorizationStatus` contains authorization).
  delete preferences.licenseAuthorizationStatus;
  delete preferences.licenseAuthorized;
  delete preferences.licenseId;
  delete preferences.licenseExpireAt;
  return preferences;
}

export function toOzonShopPreferences(store = {}) {
  const normalized = normalizeOzonShopSettingsStore(store);
  return {
    version: 1,
    shops: normalized.shops.map(toOzonShopPreferenceShop),
    activeShopId: normalized.activeShopId,
    defaultWarehouseIds: normalized.defaultWarehouseIds,
    updatedAt: normalized.updatedAt,
  };
}

function stableOzonPreferenceValue(value) {
  if (Array.isArray(value)) return value.map(stableOzonPreferenceValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableOzonPreferenceValue(child)]),
  );
}

function toStrictOzonPreferencePayload(value, { normalizeExpected = false } = {}) {
  const source = normalizeExpected ? toOzonShopPreferences(value) : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  if (!Array.isArray(source.shops)) return null;
  if (!Object.prototype.hasOwnProperty.call(source, 'activeShopId')) return null;
  if (!source.defaultWarehouseIds || typeof source.defaultWarehouseIds !== 'object' || Array.isArray(source.defaultWarehouseIds)) return null;
  return {
    version: Number(source.version),
    shops: source.shops.map(toOzonShopPreferenceShop),
    activeShopId: String(source.activeShopId ?? ''),
    defaultWarehouseIds: source.defaultWarehouseIds,
    updatedAt: String(source.updatedAt ?? ''),
  };
}

function hasExactOzonPreferenceReadback(expectedStore, actualPreferences) {
  const expected = toStrictOzonPreferencePayload(expectedStore, { normalizeExpected: true });
  const actual = toStrictOzonPreferencePayload(actualPreferences);
  return expected !== null && actual !== null &&
    JSON.stringify(stableOzonPreferenceValue(expected)) === JSON.stringify(stableOzonPreferenceValue(actual));
}

function hasCompleteOzonShopAccountReadback(expectedStore, localApiPayload) {
  const expected = normalizeOzonShopSettingsStore(expectedStore);
  if (expected.shops.some(hasIncompletePlainOzonCredentials)) return false;
  const actualShops = Array.isArray(localApiPayload?.shops)
    ? localApiPayload.shops
    : Array.isArray(localApiPayload)
      ? localApiPayload
      : [];
  const actualById = new Map(actualShops.map((shop) => [normalizeText(shop?.id), shop]).filter(([id]) => id));
  return expected.shops.every((shop) => {
    const actual = actualById.get(normalizeText(shop.id));
    if (!actual) return false;
    const expectedPayload = toLocalApiShopPayload(shop);
    if (!expectedPayload) return false;
    if (
      normalizeText(actual.name) !== expectedPayload.name ||
      normalizeText(actual.alias) !== expectedPayload.alias ||
      normalizeText(actual.status || 'active') !== expectedPayload.status
    ) return false;
    const expectedFlags = normalizeOzonShopCredentialFlags(shop);
    const flags = normalizeOzonShopCredentialFlags(actual);
    return flags.hasClientId === expectedFlags.hasClientId && flags.hasApiKey === expectedFlags.hasApiKey;
  });
}

export function readSavedOzonShopSettings() {
  if (ozonShopSettingsMemory) return ozonShopSettingsMemory;
  // Shop accounts and all shop preferences are canonical SQLite data.
  const shops = defaultOzonShops;
  return normalizeOzonShopSettingsStore({
    shops,
    defaultWarehouseIds: {},
  });
}

export function readSavedOzonShops() {
  return readSavedOzonShopSettings().shops;
}

export function readSavedActiveOzonShopId(shops) {
  const settings = readSavedOzonShopSettings();
  const source = Array.isArray(shops) ? shops : [];
  return source.some((shop) => shop.id === settings.activeShopId) ? settings.activeShopId : (source[0]?.id || '');
}

export async function fenceAndDrainOzonShopSettingsWrites(shopOrScope) {
  const scope = normalizeOzonShopGenerationScope(shopOrScope);
  if (!scope.ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  ozonShopSettingsFencedOwnerScopes.set(serializeOzonShopGenerationScope(scope), scope);
  const drain = await settleOwnerWriteDrain([ozonShopSettingsWriteQueue, ozonShopSettingsLastWrite]);
  return { ownerId: scope.ownerId, shopIncarnation: scope.shopIncarnation, credentialRevision: scope.credentialRevision, fenced: true, ...drain };
}

export function releaseOzonShopSettingsOwnerFence(shopOrScope) {
  return ozonShopSettingsFencedOwnerScopes.delete(serializeOzonShopGenerationScope(normalizeOzonShopGenerationScope(shopOrScope)));
}

export async function drainOzonShopSettingsWrites() {
  return settleOwnerWriteDrain([ozonShopSettingsWriteQueue, ozonShopSettingsLastWrite]);
}

export function getOzonShopRuntimeIdentifiers(shopId) {
  return getOzonShopRuntimeOwnerScope(shopId).identifiers;
}

export function getOzonShopRuntimeOwnerScope(shopId, lifecycle = {}) {
  const ownerId = normalizeText(shopId);
  const shop = ozonShopSettingsMemory?.shops?.find((entry) => normalizeText(entry?.id) === ownerId);
  return normalizeOzonShopGenerationScope({
    ...(shop || {}),
    ...lifecycle,
    ownerId,
    clientId: normalizeText(shop?.clientId || shop?.client_id || lifecycle?.clientId),
    identifiers: [ownerId, normalizeText(shop?.clientId || shop?.client_id || lifecycle?.clientId)].filter(Boolean),
  });
}

export function countOzonShopSettingsMemoryReferences(shopId) {
  const ownerId = normalizeText(shopId);
  if (!ownerId || !ozonShopSettingsMemory) return 0;
  const shopCount = ozonShopSettingsMemory.shops?.filter((shop) => normalizeText(shop?.id) === ownerId).length || 0;
  const warehouseCount = Object.prototype.hasOwnProperty.call(ozonShopSettingsMemory.defaultWarehouseIds || {}, ownerId) ? 1 : 0;
  const activeCount = normalizeText(ozonShopSettingsMemory.activeShopId) === ownerId ? 1 : 0;
  return shopCount + warehouseCount + activeCount;
}

export function removeOzonShopSettingsMemorySlice(shopId) {
  const ownerId = normalizeText(shopId);
  if (!ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  const current = ozonShopSettingsMemory || normalizeOzonShopSettingsStore({ shops: [] });
  const shops = (Array.isArray(current.shops) ? current.shops : []).filter(
    (shop) => normalizeText(shop?.id) !== ownerId,
  );
  const defaultWarehouseIds = { ...(current.defaultWarehouseIds || {}) };
  delete defaultWarehouseIds[ownerId];
  ozonShopSettingsMemory = normalizeOzonShopSettingsStore({
    ...current,
    shops,
    activeShopId: normalizeText(current.activeShopId) === ownerId ? (shops[0]?.id || '') : current.activeShopId,
    defaultWarehouseIds,
  });
  return ozonShopSettingsMemory;
}

function stageOzonShopSettingsWrite(shops, activeShopId, options = {}) {
  assertOzonShopSettingsWritable(shops);
  const nextStore = normalizeOzonShopSettingsStore({
    shops,
    activeShopId,
    defaultWarehouseIds:
      options.defaultWarehouseIds ??
      ozonShopSettingsMemory?.defaultWarehouseIds ??
      {},
    updatedAt: new Date().toISOString(),
  });
  ozonShopSettingsMemory = nextStore;
  if (nextStore.shops.some(hasIncompletePlainOzonCredentials)) {
    safeWarn('[Ozon 店铺] Client ID 和 API Key 必须同时填写，未把不完整凭证持久化。');
    return { nextStore, writePromise: null };
  }
  const optimisticStore = nextStore;
  const writePromise = ozonShopSettingsWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const localApiShops = await persistOzonShopsToLocalApi(optimisticStore.shops, {
        persistShopIds: options.persistShopIds,
      });
      const preferences = toOzonShopPreferences(optimisticStore);
      const saved = await saveProfileSetting(PROFILE_OZON_SHOP_PREFERENCES_NAMESPACE, preferences, { timeoutMs: 30000 });
      if (!saved?.setting?.value) throw new Error('local-api 未返回 Ozon 店铺偏好。');
      const [readback, localReadback] = await Promise.all([
        getProfileSetting(PROFILE_OZON_SHOP_PREFERENCES_NAMESPACE, { timeoutMs: 10000 }),
        getLocalShops({ timeoutMs: 10000 }),
      ]);
      if (!readback?.setting?.value) throw new Error('Ozon 店铺偏好回读失败。');
      if (!hasExactOzonPreferenceReadback(optimisticStore, readback.setting.value)) {
        throw new Error('Ozon 店铺偏好设置回读不一致。');
      }
      if (!hasCompleteOzonShopAccountReadback(optimisticStore, localReadback || localApiShops)) {
        throw new Error('Ozon 店铺账号回读失败。');
      }
      const canonicalStore = mergeLocalApiOzonShopSettings(readback.setting.value, localReadback || localApiShops);
      if (ozonShopSettingsMemory === optimisticStore) ozonShopSettingsMemory = canonicalStore;
      return canonicalStore;
    });
  ozonShopSettingsWriteQueue = writePromise.catch(() => undefined);
  ozonShopSettingsLastWrite = writePromise;
  void writePromise.catch((error) => safeWarn('[Ozon 店铺] local-api 保存失败', error));
  return { nextStore, writePromise };
}

export function saveOzonShopSettings(shops, activeShopId, options = {}) {
  return stageOzonShopSettingsWrite(shops, activeShopId, options).nextStore;
}

/**
 * Explicit account-save barrier for actions that must use the credentials the
 * operator just entered. Unlike the background save API, this rejects when the
 * encrypted local-api write or its readback fails.
 */
export async function persistOzonShopSettings(shops, activeShopId, options = {}) {
  const normalizedActiveShopId = normalizeText(activeShopId);
  const { writePromise } = stageOzonShopSettingsWrite(shops, activeShopId, {
    ...options,
    // An explicit Save/Test action edits one selected account. Rewriting every
    // other encrypted account makes an unrelated legacy shop authorization
    // failure block the newly licensed shop before its Ozon test can start.
    persistShopIds: options.persistShopIds ?? [normalizedActiveShopId],
  });
  if (!writePromise) {
    const error = new Error('Client ID 和 API Key 必须同时填写，当前设置尚未保存。');
    error.code = 'OZON_SHOP_CREDENTIALS_INCOMPLETE';
    throw error;
  }
  return writePromise;
}

/**
 * Persists only shop-scoped UI preferences. Switching the active shop must
 * not rewrite every encrypted account record: credentials belong to the
 * account store and are changed only by an explicit account save.
 */
export function saveOzonShopPreferences(shops, activeShopId, options = {}) {
  assertOzonShopSettingsWritable(shops);
  const nextStore = normalizeOzonShopSettingsStore({
    shops,
    activeShopId,
    defaultWarehouseIds:
      options.defaultWarehouseIds ??
      ozonShopSettingsMemory?.defaultWarehouseIds ??
      {},
    updatedAt: new Date().toISOString(),
  });
  ozonShopSettingsMemory = nextStore;
  const optimisticStore = nextStore;
  const writePromise = ozonShopSettingsWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const preferences = toOzonShopPreferences(optimisticStore);
      const saved = await saveProfileSetting(PROFILE_OZON_SHOP_PREFERENCES_NAMESPACE, preferences, { timeoutMs: 30000 });
      if (!saved?.setting?.value) throw new Error('local-api 未返回 Ozon 店铺偏好。');
      const readback = await getProfileSetting(PROFILE_OZON_SHOP_PREFERENCES_NAMESPACE, { timeoutMs: 10000 });
      if (!readback?.setting?.value || !hasExactOzonPreferenceReadback(optimisticStore, readback.setting.value)) {
        throw new Error('Ozon 店铺偏好设置回读不一致。');
      }
      if (ozonShopSettingsMemory === optimisticStore) {
        ozonShopSettingsMemory = normalizeOzonShopSettingsStore({
          ...readback.setting.value,
          shops: optimisticStore.shops,
        });
      }
      return ozonShopSettingsMemory;
    });
  ozonShopSettingsWriteQueue = writePromise.catch(() => undefined);
  ozonShopSettingsLastWrite = writePromise;
  void writePromise.catch((error) => safeWarn('[Ozon 店铺] 偏好保存失败', error));
  return nextStore;
}

export function mergeLocalApiOzonShopSettings(store = {}, localApiPayload = {}) {
  const baseStore = normalizeOzonShopSettingsStore(store);
  const localApiShops = Array.isArray(localApiPayload?.shops)
    ? localApiPayload.shops
    : Array.isArray(localApiPayload)
      ? localApiPayload
      : [];
  if (!localApiShops.length) return baseStore;

  const localById = new Map(localApiShops.map((shop) => [normalizeText(shop?.id), shop]).filter(([id]) => id));
  const mergedIds = new Set();
  const shops = baseStore.shops.map((shop) => {
    const localShop = localById.get(normalizeText(shop.id));
    if (!localShop) return shop;
    mergedIds.add(normalizeText(shop.id));
    const localFlags = normalizeOzonShopCredentialFlags(localShop);
    const hasEncryptedCredentials = localFlags.hasClientId && localFlags.hasApiKey;
    return {
      ...shop,
      shopAlias: normalizeText(shop.shopAlias) || normalizeText(localShop.alias || localShop.name) || shop.shopAlias,
      sellerName: normalizeText(shop.sellerName) || normalizeText(localShop.name || localShop.alias) || shop.sellerName,
      clientId: normalizeText(localShop.clientId || localShop.client_id) || normalizeText(shop.clientId || shop.client_id),
      hasClientId: shop.hasClientId || localFlags.hasClientId,
      hasApiKey: shop.hasApiKey || localFlags.hasApiKey,
      apiKeyHint: localShop.apiKeyHint || shop.apiKeyHint || '',
      profileId: normalizeText(localShop.profileId || localShop.profile_id) || shop.profileId || '',
      shopIncarnation: normalizeText(localShop.shopIncarnation || localShop.shop_incarnation) || shop.shopIncarnation || '',
      credentialRevision:
        Number(localShop.credentialRevision || localShop.credential_revision)
        || Number(shop.credentialRevision)
        || 0,
      connectionStatus:
        hasEncryptedCredentials && !hasPlainOzonCredentials(shop) && shop.connectionStatus === '未测试'
          ? '本地已保存'
          : shop.connectionStatus,
      connectionMessage:
        hasEncryptedCredentials && !hasPlainOzonCredentials(shop)
          ? '已从 local-api 读取到加密保存的 Ozon API，可直接刷新读取。'
          : shop.connectionMessage,
    };
  });

  localApiShops.forEach((localShop, index) => {
    const id = normalizeText(localShop?.id);
    if (!id || mergedIds.has(id)) return;
    const flags = normalizeOzonShopCredentialFlags(localShop);
    const hasEncryptedCredentials = flags.hasClientId && flags.hasApiKey;
    shops.push({
      ...defaultOzonShops[0],
      id,
      shopAlias: normalizeText(localShop.alias || localShop.name) || `Ozon ${shops.length + index + 1}店`,
      sellerName: normalizeText(localShop.name || localShop.alias),
      clientId: normalizeText(localShop.clientId || localShop.client_id),
      apiKey: '',
      apiKeyHint: localShop.apiKeyHint || '',
      profileId: normalizeText(localShop.profileId || localShop.profile_id),
      shopIncarnation: normalizeText(localShop.shopIncarnation || localShop.shop_incarnation),
      credentialRevision: Number(localShop.credentialRevision || localShop.credential_revision) || 0,
      ...flags,
      connectionStatus: hasEncryptedCredentials ? '本地已保存' : localShop.status || '未测试',
      connectionMessage: hasEncryptedCredentials
        ? '已从 local-api 读取到加密保存的 Ozon API，可直接刷新读取。'
        : 'local-api 有店铺记录，但 Ozon API 凭证不完整。',
    });
  });

  return normalizeOzonShopSettingsStore({
    ...baseStore,
    shops,
    activeShopId: shops.some((shop) => shop.id === baseStore.activeShopId) ? baseStore.activeShopId : shops[0]?.id,
  });
}

export function readSavedOzonDefaultWarehouseIds() {
  if (ozonShopSettingsMemory) return normalizeOzonDefaultWarehouseIds(ozonShopSettingsMemory.defaultWarehouseIds);
  return {};
}

export function saveOzonDefaultWarehouseIds(defaults) {
  const defaultWarehouseIds = normalizeOzonDefaultWarehouseIds(defaults);
  const currentStore = readSavedOzonShopSettings();
  return saveOzonShopSettings(currentStore.shops, currentStore.activeShopId, { defaultWarehouseIds });
}

/** Canonical runtime load: encrypted shop accounts plus profile preferences. */
export async function hydrateOzonShopSettingsFromLocalFile(options = {}) {
  // Shop accounts are canonical.  A temporary preference read failure must not
  // hide accounts that are still present in SQLite, so preference loading is a
  // best-effort companion read instead of sharing one fail-fast Promise.all.
  const preferencesPromise = getProfileSetting(PROFILE_OZON_SHOP_PREFERENCES_NAMESPACE, {
    timeoutMs: options.timeoutMs || 10000,
    signal: options.signal,
    transportRetry: false,
  }).then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error }),
  );
  const localApiShops = await getLocalShops({
    timeoutMs: options.timeoutMs || 10000,
    signal: options.signal,
    transportRetry: false,
  });
  const preferencesResult = await preferencesPromise;
  if (options.signal?.aborted) {
    throw preferencesResult.error || createOzonShopHydrationAbortError();
  }
  if (preferencesResult.error) {
    safeWarn('[Ozon 店铺] 偏好读取暂时失败，已直接使用本机店铺账号', preferencesResult.error);
  }

  const localShops = Array.isArray(localApiShops?.shops) ? localApiShops.shops : [];
  const preferenceValue = preferencesResult.value?.setting?.value;
  const baseStore = preferenceValue && typeof preferenceValue === 'object'
    ? preferenceValue
    : {
        shops: [],
        activeShopId: '',
        defaultWarehouseIds: {},
      };
  const canonicalStore = localShops.length
    ? mergeLocalApiOzonShopSettings(baseStore, localApiShops)
    : normalizeOzonShopSettingsStore({ shops: [] });
  ozonShopSettingsMemory = canonicalStore;
  return canonicalStore;
}

const DEFAULT_OZON_SHOP_HYDRATION_RETRY_DELAYS_MS = Object.freeze([
  500,
  1500,
  3000,
  10000,
  30000,
]);

function createOzonShopHydrationAbortError() {
  if (typeof DOMException === 'function') return new DOMException('请求已取消', 'AbortError');
  const error = new Error('请求已取消');
  error.name = 'AbortError';
  return error;
}

function waitForOzonShopHydrationRetry(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(createOzonShopHydrationAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timerId);
      reject(createOzonShopHydrationAbortError());
    };
    const timerId = globalThis.setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, Math.max(0, Number(delayMs) || 0));
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * Keeps retrying the canonical SQLite shop read after transient local-api
 * startup/lock failures.  Authorization is deliberately resolved afterwards
 * by License Center; this function never manufactures an authorized shop.
 */
export async function hydrateOzonShopSettingsWithRetry(options = {}) {
  const retryDelaysMs = Array.isArray(options.retryDelaysMs) && options.retryDelaysMs.length
    ? options.retryDelaysMs
    : DEFAULT_OZON_SHOP_HYDRATION_RETRY_DELAYS_MS;
  const requestedMaxAttempts = options.maxAttempts;
  const maxAttempts = requestedMaxAttempts === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Number(requestedMaxAttempts) || retryDelaysMs.length + 1);
  let attempt = 0;
  let lastError = null;
  while (!options.signal?.aborted && attempt < maxAttempts) {
    attempt += 1;
    try {
      return await hydrateOzonShopSettingsFromLocalFile(options);
    } catch (error) {
      if (error?.name === 'AbortError' || options.signal?.aborted) throw error;
      lastError = error;
      options.onAttemptFailure?.(error, attempt);
      if (attempt >= maxAttempts) break;
      const delayMs = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)];
      await waitForOzonShopHydrationRetry(delayMs, options.signal);
    }
  }
  if (options.signal?.aborted) throw createOzonShopHydrationAbortError();
  throw lastError || new Error('Ozon 店铺读取失败。');
}

export function markOzonShopsLicenseChecking(shops = []) {
  return (Array.isArray(shops) ? shops : []).map((shop) => ({
    ...shop,
    licenseAuthorizationStatus: 'checking',
    licenseAuthorized: false,
  }));
}
