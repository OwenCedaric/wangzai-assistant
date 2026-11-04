import { settleOwnerWriteDrain } from '../../services/ownerWriteDrain.js';
import { getProfileSetting, requestLocalOzon, saveProfileSetting } from '../../api/localApiClient';
import {
  getCrossBorderLocalApiAccountId,
  hasDirectCrossBorderAuthorization,
  hasLocalApiCrossBorderAuthorization,
} from './crossBorderAuthorization.js';
import { normalizeImageList, safeImageUrl } from '../lib/imageUrlRules.js';
import {
  normalizeProductStatusLabel,
  ozonProductVisibilityStatusMap,
  productStatusTabs,
  productStatusToneMap,
} from './productStatusCatalog.js';
import {
  readCrossBorderAccounts,
  selectCrossBorderAccount,
  toCrossBorderPublicSettings,
} from '../../services/crossBorderAccountClient';
import { assertExternalInterfaceAllowed } from '../../services/externalInterfaceRegistry';
import { isOzonRetryableReadError as isOzonRetryableReadErrorSafe } from '../../services/ozonOrderSafety';
import { classifyOzonRequestError, runOzonControlledRequest } from '../../services/ozonRequestControl';
import { safeInfo, safeWarn } from '../../services/safeLog';
import {
  CROSS_BORDER_LEGACY_EMPTY_TEXT,
  CROSS_BORDER_MAIN_ACCOUNT_ID,
  OZON_READ_TIMEOUT_MS,
  OZON_WRITE_TIMEOUT_MS,
} from '../config/appConfigCore.jsx';
import { getPerformanceNow, ozonApiPerformanceCounter, roundPerformanceMs } from '../config/appConfigRuntime.jsx';
import React from 'react';

export function countRowsImages(rows = []) {
  const urls = new Set();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const products = Array.isArray(row?.products) ? row.products : [row];
    products.forEach((product) => {
      normalizeImageList([
        product?.image,
        product?.skuImage,
        product?.mainImage,
        product?.productMainImage,
        product?.primaryImage,
        product?.primary_image,
        ...(Array.isArray(product?.images) ? product.images : []),
        ...(Array.isArray(product?.skuImages) ? product.skuImages : []),
        ...(Array.isArray(product?.mainImages) ? product.mainImages : []),
      ]).forEach((url) => {
        const safeUrl = safeImageUrl(url);
        if (safeUrl) urls.add(safeUrl);
      });
    });
  });
  return urls.size;
}

export function logPagePerformanceReport(report = {}) {
  if (!import.meta.env.DEV) return;
  const pageName = report.pageName || '未命名页面';
  safeInfo(`[性能] 页面=${pageName}`);
  safeInfo(`[性能] 本地数据=${roundPerformanceMs(report.localMs)}ms`);
  safeInfo(`[性能] Ozon接口=${roundPerformanceMs(report.ozonMs)}ms`);
  safeInfo(`[性能] 数据处理=${roundPerformanceMs(report.processingMs)}ms`);
  safeInfo(`[性能] 表格渲染=${roundPerformanceMs(report.renderMs)}ms`);
  safeInfo(`[性能] 图片URL处理=${roundPerformanceMs(report.imageMs)}ms`);
  safeInfo(`[性能] 图片加载=${report.imageAsync === false ? '同步' : '异步'}`);
  safeInfo(`[性能] 行数=${Number(report.rows) || 0}`);
  safeInfo(`[性能] 图片数=${Number(report.imageCount) || 0}`);
  safeInfo(`[性能] API请求次数=${Number(report.apiCount) || 0}`);
  safeInfo(`[性能] 总耗时=${roundPerformanceMs(report.totalMs)}ms`);
}

export function usePagePerformanceLog(pageName, performanceInfo, metrics = {}) {
  const eventId = performanceInfo?.eventId || '';
  React.useEffect(() => {
    if (!eventId || metrics.loading) return undefined;
    const queuedAt = getPerformanceNow();
    const render = () => {
      const renderDoneAt = getPerformanceNow();
      logPagePerformanceReport({
        pageName,
        localMs: performanceInfo.localMs,
        ozonMs: performanceInfo.ozonMs,
        processingMs: performanceInfo.processingMs,
        renderMs: renderDoneAt - queuedAt,
        imageMs: performanceInfo.imageMs,
        imageAsync: true,
        rows: metrics.rows ?? performanceInfo.rows,
        imageCount: metrics.imageCount ?? performanceInfo.imageCount,
        apiCount: performanceInfo.apiCount,
        totalMs: renderDoneAt - (performanceInfo.startedAt || queuedAt),
      });
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      const frameId = window.requestAnimationFrame(render);
      return () => window.cancelAnimationFrame(frameId);
    }
    const timer = setTimeout(render, 0);
    return () => clearTimeout(timer);
  }, [
    eventId,
    metrics.imageCount,
    metrics.loading,
    metrics.rows,
    pageName,
    performanceInfo?.apiCount,
    performanceInfo?.imageCount,
    performanceInfo?.imageMs,
    performanceInfo?.localMs,
    performanceInfo?.ozonMs,
    performanceInfo?.processingMs,
    performanceInfo?.rows,
    performanceInfo?.startedAt,
  ]);
}

export function scheduleIdleTask(task, timeout = 2500) {
  if (typeof window === 'undefined') {
    const timer = setTimeout(task, 0);
    return () => clearTimeout(timer);
  }
  if (typeof window.requestIdleCallback === 'function') {
    const idleId = window.requestIdleCallback(task, { timeout });
    return () => window.cancelIdleCallback(idleId);
  }
  const timer = window.setTimeout(task, 0);
  return () => window.clearTimeout(timer);
}

export function stableRequestPayload(value) {
  if (Array.isArray(value)) return value.map(stableRequestPayload);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableRequestPayload(value[key])])
  );
}

export function createOzonReadDedupeKey(endpoint, shop, body = {}, options = {}) {
  if (options.dedupeKey === false) return '';
  if (typeof options.dedupeKey === 'string' && options.dedupeKey.trim()) return options.dedupeKey.trim();
  const method = String(options.method || 'POST').toUpperCase();
  const shopKey = String(shop?.id || shop?.clientId || '').trim();
  return JSON.stringify({
    provider: 'ozon',
    method,
    endpoint,
    shopKey,
    body: stableRequestPayload(body ?? {}),
  });
}

export async function requestOzonSellerApi(endpoint, shop, body = {}, options = {}) {
  const method = options.method || 'POST';
  const shopKey = String(shop?.id || shop?.clientId || '').trim();
  if (!shopKey) throw new Error('Ozon 请求缺少明确的店铺标识。');

  return runOzonControlledRequest({
    endpoint,
    shopKey,
    signal: options.signal,
    maxRetries: options.maxRetries ?? 0,
    dedupeKey: options.dedupeKey,
    execute: async (parentSignal) => {
      const timeoutMs = Number(options.timeoutMs) || 0;
      const timeoutSeconds = Math.round(timeoutMs / 1000);
      const controller =
        typeof AbortController !== 'undefined' && (timeoutMs || parentSignal) ? new AbortController() : null;
      let didTimeout = false;
      let timeoutId = null;
      const abortFromParent = () => {
        if (!controller?.signal.aborted) controller.abort(parentSignal?.reason);
      };

      if (controller && parentSignal) {
        if (parentSignal.aborted) {
          abortFromParent();
        } else {
          parentSignal.addEventListener('abort', abortFromParent, { once: true });
        }
      }
      if (controller && timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          didTimeout = true;
          controller.abort();
        }, timeoutMs);
      }

      ozonApiPerformanceCounter.count += 1;

      try {
        return await requestLocalOzon(
          {
            endpoint,
            method,
            body: body ?? {},
            access: options.access || 'read',
            confirmed: options.confirmed === true,
            realWrite: options.realWrite === true,
            dryRun: options.dryRun === true,
            fastAck: options.fastAck === true,
            asyncWrite: options.asyncWrite === true,
            waitForResult: options.waitForResult !== false,
            shop: {
              id: shop?.id || '',
              name: shop?.name || '',
              shopAlias: shop?.shopAlias || '',
              clientId: shop?.clientId || '',
              apiKey: shop?.apiKey || '',
            },
          },
          {
            timeoutMs: timeoutMs || undefined,
            signal: controller?.signal ?? parentSignal,
            onSyncProgress: options.onSyncProgress,
            endpointLabel: options.endpointLabel,
            shopLabel: options.shopLabel,
            orderSyncTimeoutMs: options.orderSyncTimeoutMs,
            orderSyncPollIntervalMs: options.orderSyncPollIntervalMs,
          }
        );
      } catch (error) {
        if (didTimeout) {
          throw new Error(`${endpoint} 请求超时：超过 ${timeoutSeconds || 0} 秒未返回。`);
        }
        throw error;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (controller && parentSignal) {
          parentSignal.removeEventListener('abort', abortFromParent);
        }
      }
    },
  });
}

export async function requestOzonReadOnly(endpoint, shop, body = {}, options = {}) {
  assertExternalInterfaceAllowed({
    provider: 'ozon',
    endpoint,
    method: options.method || 'POST',
    access: 'read',
  });
  return requestOzonSellerApi(endpoint, shop, body, {
    ...options,
    access: 'read',
    timeoutMs: options.timeoutMs ?? OZON_READ_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? 2,
    dedupeKey: createOzonReadDedupeKey(endpoint, shop, body, options),
  });
}

export async function requestOzonWrite(endpoint, shop, body = {}, options = {}) {
  assertExternalInterfaceAllowed({
    provider: 'ozon',
    endpoint,
    method: options.method || 'POST',
    access: 'write',
    confirmed: options.confirmed === true,
  });
  return requestOzonSellerApi(endpoint, shop, body, {
    ...options,
    access: 'write',
    confirmed: options.confirmed === true,
    realWrite: options.realWrite !== false,
    dryRun: options.dryRun === true,
    waitForResult: options.waitForResult !== false,
    timeoutMs: options.timeoutMs ?? OZON_WRITE_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? 0,
    dedupeKey: false,
  });
}

export function isOzonRetryableReadError(error) {
  return isOzonRetryableReadErrorSafe(error);
}

export function isOzonAbortReadError(error) {
  return error?.name === 'AbortError' || classifyOzonRequestError(error).type === 'abort';
}

export {
  normalizeOzonDefaultWarehouseIds,
  readSavedOzonDefaultWarehouseIds,
  saveOzonDefaultWarehouseIds,
} from '../../services/ozonShopSettingsStore';

export let crossBorderSettingsMemory = null;
export const PROFILE_CROSS_BORDER_PREFERENCES_NAMESPACE = 'cross-border-preferences';
let crossBorderSettingsWriteQueue = Promise.resolve();
let crossBorderSettingsLastWrite = null;
const crossBorderSettingsFencedAccountIds = new Set();
const crossBorderSettingsReads = new Set();

function normalizeCrossBorderAccountOwnerId(value) {
  return String(value ?? '').trim();
}

function assertCrossBorderSettingsWritable(settings = {}) {
  const ownerId = normalizeCrossBorderAccountOwnerId(getCrossBorderLocalApiAccountId(settings));
  if (!ownerId || !crossBorderSettingsFencedAccountIds.has(ownerId)) return;
  const error = new Error('ACCOUNT_REMOVAL_OWNER_QUIESCED');
  error.code = 'ACCOUNT_REMOVAL_OWNER_QUIESCED';
  throw error;
}

export async function fenceAndDrainCrossBorderSettingsWrites(accountId) {
  const ownerId = normalizeCrossBorderAccountOwnerId(accountId);
  if (!ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  crossBorderSettingsFencedAccountIds.add(ownerId);
  const pendingReads = [...crossBorderSettingsReads];
  pendingReads.forEach(task => task.excludedOwnerIds.add(ownerId));
  const drain = await settleOwnerWriteDrain([crossBorderSettingsWriteQueue, crossBorderSettingsLastWrite, ...pendingReads.map(task => task.promise)]);
  return { ownerId, fenced: true, ...drain };
}

export function releaseCrossBorderSettingsWriteFence(accountId) {
  const ownerId = normalizeCrossBorderAccountOwnerId(accountId);
  if (!ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  return { ownerId, released: crossBorderSettingsFencedAccountIds.delete(ownerId) };
}

export function normalizeCrossBorderSettings(defaultValues = {}, source = {}) {
  const settings = {
    ...(defaultValues && typeof defaultValues === 'object' ? defaultValues : {}),
    ...(source && typeof source === 'object' && !Array.isArray(source) ? source : {}),
  };
  try {
    delete settings.legacyBridge;
    if (CROSS_BORDER_LEGACY_EMPTY_TEXT.has(settings.cooperationWarehouse)) {
      settings.cooperationWarehouse = '';
    }
    if (CROSS_BORDER_LEGACY_EMPTY_TEXT.has(settings.packageService)) {
      settings.packageService = '';
    }
    if (
      settings.companySecret &&
      /真实连接失败|expires_token|token\/refresh|token\/index|app_uid/i.test(String(settings.connectionMessage || ''))
    ) {
      settings.connectionStatus = '企业 API 已保存';
      settings.connectionMessage = '企业 API 已保存到本地。跨境巴士重置 Token 后，再恢复真实连接读取。';
    }
    if (hasLocalApiCrossBorderAuthorization(settings) && !hasDirectCrossBorderAuthorization(settings)) {
      settings.connectionStatus = '本机授权已保存';
      settings.connectionMessage = '已从 local-api 读取到跨境巴士加密授权，真实只读接口可用。';
    }
    if (settings.companySecret?.trim() && settings.accessToken?.trim() && settings.appUid?.trim()) {
      settings.connectionStatus = '真实接口已连接';
      settings.connectionMessage = '已从本机统一配置读取跨境巴士授权，真实接口可读取。';
    }
    if (String(settings.authorizationRef || '').trim()) {
      settings.connectionStatus = '服务器授权已连接';
      settings.connectionMessage = '企业 API 由服务器统一保管，客户端只保存不透明授权。';
    }
    return settings;
  } catch {
    return { ...(defaultValues && typeof defaultValues === 'object' ? defaultValues : {}) };
  }
}

export function mergeCrossBorderSettings(defaultValues = {}, ...sources) {
  const next = { ...(defaultValues && typeof defaultValues === 'object' ? defaultValues : {}) };
  sources.forEach((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    Object.entries(source).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        if (value.length > 0 || key === 'shopIds') next[key] = value;
        return;
      }
      if (value !== undefined && value !== null && value !== '') {
        next[key] = value;
      }
    });
  });
  return normalizeCrossBorderSettings(defaultValues, next);
}

export function readSavedCrossBorderSettings(defaultValues) {
  if (crossBorderSettingsMemory && typeof crossBorderSettingsMemory === 'object') {
    return normalizeCrossBorderSettings(defaultValues, crossBorderSettingsMemory);
  }
  return normalizeCrossBorderSettings(defaultValues, {});
}

export function toCrossBorderSafeLocalSettings(settings = {}) {
  const safeSettings = { ...(settings && typeof settings === 'object' ? settings : {}) };
  [
    'companySecret',
    'accessToken',
    'refreshToken',
    'expiresToken',
    'tokenExpiresIn',
    'appUid',
    'userName',
    'password',
    'hasUserName',
    'hasPassword',
    'hasCompanySecret',
    'hasAccessToken',
    'hasAppUid',
  ].forEach(
    (key) => {
      delete safeSettings[key];
    }
  );
  return safeSettings;
}

export function countCrossBorderSettingsMemoryReferences(accountId) {
  const ownerId = normalizeCrossBorderAccountOwnerId(accountId);
  if (!ownerId || !crossBorderSettingsMemory) return 0;
  return normalizeCrossBorderAccountOwnerId(getCrossBorderLocalApiAccountId(crossBorderSettingsMemory)) === ownerId ? 1 : 0;
}

export function removeCrossBorderSettingsMemoryAccountSlice(accountId) {
  const ownerId = normalizeCrossBorderAccountOwnerId(accountId);
  if (!ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  if (countCrossBorderSettingsMemoryReferences(ownerId) === 0) return crossBorderSettingsMemory;
  const next = toCrossBorderSafeLocalSettings(crossBorderSettingsMemory || {});
  [
    'crossBorderAccountId',
    'accountId',
    'id',
    'accountAlias',
    'accountSaved',
    'accountSavedAt',
    'apiSaved',
    'apiSavedAt',
    'connectionStatus',
    'connectionMessage',
    'lastConnectedAt',
  ].forEach((key) => delete next[key]);
  crossBorderSettingsMemory = next;
  return crossBorderSettingsMemory;
}

function trackCrossBorderSettingsRead(reader) {
  const task = { excludedOwnerIds: new Set(crossBorderSettingsFencedAccountIds), memoryAtStart: crossBorderSettingsMemory, promise: null };
  crossBorderSettingsReads.add(task);
  task.promise = Promise.resolve().then(() => reader(task)).finally(() => crossBorderSettingsReads.delete(task));
  return task.promise;
}

function crossBorderReadExcludes(task, accountId) {
  const id = normalizeCrossBorderAccountOwnerId(accountId);
  return task.excludedOwnerIds.has(id) || crossBorderSettingsFencedAccountIds.has(id);
}

function assertCrossBorderReadCurrent(task, accountId) {
  if (crossBorderReadExcludes(task, accountId)) {
    const error = new Error('该账号的旧读取已被删除流程取代，请重新读取当前账号。');
    error.code = 'CROSS_BORDER_SETTINGS_READ_SUPERSEDED';
    throw error;
  }
}

async function readCrossBorderSettingsByAccountId(preferredId, task) {
  assertCrossBorderReadCurrent(task, preferredId);
  try {
    const payload = await readCrossBorderAccounts({ timeoutMs: 2500 });
    assertCrossBorderReadCurrent(task, preferredId);
    const rows = (Array.isArray(payload?.rows) ? payload.rows : []).filter(account => !crossBorderReadExcludes(task, account?.id));
    const account = selectCrossBorderAccount(rows, preferredId);
    const settings = toCrossBorderPublicSettings(account);
    assertCrossBorderReadCurrent(task, getCrossBorderLocalApiAccountId(settings));
    return settings;
  } catch (error) {
    if (task.excludedOwnerIds.size || error?.code === 'CROSS_BORDER_SETTINGS_READ_SUPERSEDED') throw error;
    return {};
  }
}

export function saveCrossBorderSettings(settings) {
  assertCrossBorderSettingsWritable(settings);
  const nextSettings = normalizeCrossBorderSettings({}, settings);
  delete nextSettings.legacyBridge;
  crossBorderSettingsMemory = nextSettings;
  const optimisticSettings = nextSettings;
  const writePromise = crossBorderSettingsWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const saved = await saveProfileSetting(
        PROFILE_CROSS_BORDER_PREFERENCES_NAMESPACE,
        toCrossBorderSafeLocalSettings(optimisticSettings),
        { timeoutMs: 30000 }
      );
      if (!saved?.setting?.value) throw new Error('local-api 未返回跨境偏好设置。');
      const [readback, localApiSettings] = await Promise.all([
        getProfileSetting(PROFILE_CROSS_BORDER_PREFERENCES_NAMESPACE, { timeoutMs: 10000 }),
        readCrossBorderSettingsFromLocalApi(optimisticSettings),
      ]);
      if (!readback?.setting?.value) throw new Error('跨境偏好设置回读失败。');
      const canonicalSettings = mergeCrossBorderSettings({}, readback.setting.value, localApiSettings);
      if (crossBorderSettingsMemory === optimisticSettings) crossBorderSettingsMemory = canonicalSettings;
      return canonicalSettings;
    });
  crossBorderSettingsWriteQueue = writePromise.catch(() => undefined);
  crossBorderSettingsLastWrite = writePromise;
  void writePromise.catch((error) => safeWarn('[跨境设置] local-api 保存失败', error));
  return nextSettings;
}

export async function readCrossBorderSettingsFromLocalApi(defaultValues = {}) {
  const preferredId =
    getCrossBorderLocalApiAccountId(crossBorderSettingsMemory || {}) ||
    getCrossBorderLocalApiAccountId(defaultValues) ||
    CROSS_BORDER_MAIN_ACCOUNT_ID;
  return trackCrossBorderSettingsRead(task => readCrossBorderSettingsByAccountId(preferredId, task));
}

export async function hydrateCrossBorderSettingsFromLocalApi(defaultValues = {}) {
  return trackCrossBorderSettingsRead(async task => {
    const preferences = await getProfileSetting(PROFILE_CROSS_BORDER_PREFERENCES_NAMESPACE, { timeoutMs: 10000 });
    const savedPreferences = preferences?.setting?.value;
    const preferredSettings = savedPreferences
      ? mergeCrossBorderSettings(defaultValues, savedPreferences)
      : normalizeCrossBorderSettings(defaultValues, {});
    const accountId = getCrossBorderLocalApiAccountId(preferredSettings) || CROSS_BORDER_MAIN_ACCOUNT_ID;
    const accountSettings = await readCrossBorderSettingsByAccountId(accountId, task);
    const canonicalSettings = savedPreferences
      ? mergeCrossBorderSettings(defaultValues, savedPreferences, accountSettings)
      : mergeCrossBorderSettings(defaultValues, accountSettings);
    assertCrossBorderReadCurrent(task, accountId);
    assertCrossBorderReadCurrent(task, getCrossBorderLocalApiAccountId(canonicalSettings));
    if (crossBorderSettingsMemory === task.memoryAtStart) crossBorderSettingsMemory = canonicalSettings;
    return canonicalSettings;
  });
}

export function findDeepValue(source, keys) {
  if (!source || typeof source !== 'object') return '';
  for (const key of keys) {
    if (source[key]) return source[key];
  }
  for (const value of Object.values(source)) {
    if (value && typeof value === 'object') {
      const found = findDeepValue(value, keys);
      if (found) return found;
    }
  }
  return '';
}

export function getCrossBorderPayload(data) {
  return data?.data ?? data?.result ?? data?.payload ?? data;
}

export function collectCrossBorderSections(source, seen = new Set()) {
  if (!source || typeof source !== 'object' || seen.has(source)) return [];
  seen.add(source);

  const storehouses = source.storehouse_list ?? source.storehouse ?? source.storehouses;
  const sections =
    !Array.isArray(source) && Array.isArray(storehouses) && (source.section_id || source.id) ? [source] : [];

  const values = Array.isArray(source) ? source : Object.values(source);
  values.forEach((value) => {
    sections.push(...collectCrossBorderSections(value, seen));
  });

  return sections;
}

export function collectCrossBorderServiceItems(source, seen = new Set()) {
  if (!source || typeof source !== 'object' || seen.has(source)) return [];
  seen.add(source);

  const services = [
    ...(Array.isArray(source.core_data)
      ? source.core_data.map((service) => ({ ...service, selectionType: 'required' }))
      : []),
    ...(Array.isArray(source.optional_data)
      ? source.optional_data.map((service) => ({ ...service, selectionType: 'optional' }))
      : []),
  ];

  const values = Array.isArray(source)
    ? source
    : Object.entries(source)
        .filter(([key]) => !['core_data', 'optional_data'].includes(key))
        .map(([, value]) => value);
  values.forEach((value) => {
    services.push(...collectCrossBorderServiceItems(value, seen));
  });

  return services;
}

export function assertCrossBorderSuccess(endpoint, data) {
  if (data && typeof data === 'object' && 'code' in data && Number(data.code) !== 1) {
    throw new Error(`${endpoint} 返回失败：${data.message || data.msg || JSON.stringify(data)}`);
  }
}

export function normalizeCrossBorderFormScalar(value) {
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const scalarValue = normalizeCrossBorderFormScalar(item);
      if (scalarValue !== '') return scalarValue;
    }
    return '';
  }
  if (typeof value === 'object') return '';
  return String(value).trim();
}

export function hashRequestText(value = '') {
  const text = String(value ?? '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

export function createCrossBorderReadDedupeKey(endpoint, options = {}) {
  if (options.access === 'write') return '';
  if (options.dedupeKey === false) return '';
  if (typeof options.dedupeKey === 'string' && options.dedupeKey.trim()) return options.dedupeKey.trim();
  return JSON.stringify({
    provider: 'cross-border-bus',
    endpoint,
    bodyFormat: options.bodyFormat || 'json',
    bodyHash: hashRequestText(JSON.stringify(stableRequestPayload(options.body ?? {}))),
    authHash: hashRequestText(
      [options.clientSecret, options.accessToken, options.appUid].map((value) => value || '').join('|')
    ),
  });
}

export function normalizeCrossBorderWarehouses(data) {
  const payload = getCrossBorderPayload(data);
  const sections = collectCrossBorderSections(payload);
  const options = [];
  const optionKeys = new Set();

  sections.forEach((section) => {
    const sectionId = section.section_id ?? section.id ?? '';
    const sectionName = section.section_name ?? section.name ?? '默认平台';
    const storehouses = section.storehouse_list ?? section.storehouse ?? section.storehouses ?? [];
    if (!Array.isArray(storehouses)) return;
    storehouses.forEach((warehouse) => {
      const sid = warehouse.id ?? warehouse.sid ?? '';
      const warehouseCode = warehouse.code ?? warehouse.storehouse_code ?? warehouse.storehouseCode ?? '';
      const warehouseName = warehouse.name ?? warehouse.storehouse_name ?? warehouseCode ?? '未命名仓库';
      if (!sid || !sectionId) return;
      const optionKey = `${sectionId}:${sid}`;
      if (optionKeys.has(optionKey)) return;
      optionKeys.add(optionKey);
      const displayCode = String(warehouseCode || '').trim();
      const displayName = String(warehouseName || '未命名仓库').trim();
      const displayLabel =
        displayCode && displayName && !displayName.startsWith(displayCode)
          ? `${displayCode}${displayName}`
          : displayName;
      options.push({
        value: optionKey,
        label: `${displayLabel} / ${sectionName}`,
        sectionId: String(sectionId),
        sid: String(sid),
        code: displayCode,
        sectionName,
        warehouseName: displayName,
      });
    });
  });

  return options;
}

export function formatCrossBorderServiceLabel(name, gold) {
  if (gold === '' || gold === undefined || gold === null) return name;
  if (/^【[^】]*】/.test(name) || /元|免费/.test(name.slice(0, 20))) return name;
  return `【${gold}元】${name}`;
}

export function normalizeCrossBorderServices(data) {
  const payload = getCrossBorderPayload(data);
  const serviceGroups = collectCrossBorderServiceItems(payload);
  const serviceKeys = new Set();

  return serviceGroups
    .map((service) => {
      const id = service.id ?? service.service_id ?? service.code ?? '';
      const name = service.name ?? service.service_name ?? '未命名服务';
      const gold = service.gold ?? service.price ?? service.fee ?? '';
      return {
        value: String(id || name),
        label: formatCrossBorderServiceLabel(name, gold),
        id: String(id || name),
        name,
        gold,
        selectionType: service.selectionType === 'optional' ? 'optional' : 'required',
      };
    })
    .filter((service) => {
      if (!service.value || serviceKeys.has(service.value)) return false;
      serviceKeys.add(service.value);
      return true;
    });
}

export { normalizeProductStatusLabel, ozonProductVisibilityStatusMap, productStatusTabs, productStatusToneMap };
