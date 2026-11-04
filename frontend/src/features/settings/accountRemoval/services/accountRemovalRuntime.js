import {
  countProductListCachesForOwnerIdentifiers,
  fenceProductListCachesForOwnerIdentifiers,
  releaseProductListOwnerFence,
  invalidateProductListCachesForOwnerIdentifiers,
} from '../../../../entities/product/productLocalData.jsx';
import {
  fenceAndDrainMarketingActivityViewStateWrites,
  releaseMarketingActivityOwnerFence,
} from '../../../../entities/order/orderShopScope.jsx';
import {
  countProfitAfterSalesCacheEntriesForOwner,
  countProfitFinanceCacheEntriesForOwner,
  fenceProfitFinanceCachesForOwner,
  releaseProfitFinanceOwnerFence,
  invalidateProfitAfterSalesCacheEntriesForOwner,
  invalidateProfitFinanceCacheEntriesForOwner,
} from '../../../../entities/profit/profitFinanceEvidence.jsx';
import {
  countProfitRatingPenaltyCacheEntriesForOwner,
  fenceProfitRatingPenaltyCacheForOwner,
  releaseProfitRatingPenaltyOwnerFence,
  invalidateProfitRatingPenaltyCacheEntriesForOwner,
} from '../../../../entities/profit/profitLedgerMapping.jsx';
import {
  countModelApiSettingsMemoryReferences,
  removeModelApiSettingsMemoryInterface,
} from '../../lib/modelApiSettings.jsx';
import { readLocalDataFile, writeLocalDataFile } from '../../../../services/localDataFileClient.js';
import {
  countOzonShopSettingsMemoryReferences,
  fenceAndDrainOzonShopSettingsWrites,
  releaseOzonShopSettingsOwnerFence,
  getOzonShopRuntimeIdentifiers,
  getOzonShopRuntimeOwnerScope,
  removeOzonShopSettingsMemorySlice,
} from '../../../../services/ozonShopSettingsStore.js';
import {
  countProductMaterialProfilesForShop,
  fenceAndDrainProductMaterialProfileWrites,
  releaseProductMaterialProfileOwnerFence,
  removeProductMaterialProfilesForShop,
} from '../../../../services/productMaterialProfileStore.js';
import { LOCAL_PRODUCT_MATERIAL_FILE_KEY } from '../../../../services/productMaterialProfileStore.js';
import { fenceAndDrainProductSourceLinkMigration, releaseProductSourceLinkOwnerFence } from '../../../../services/productSourceLinkStore.js';
import {
  countPurchaseOrderOverrideMemoryForShop,
  fenceAndDrainPurchaseOrderOverrideWrites,
  releasePurchaseOrderOverrideOwnerFence,
  removePurchaseOrderOverrideMemoryForShop,
} from '../../../../services/purchaseOrderRuntime.js';
import { fenceAndDrainPurchaseSourceLinkMigration, releasePurchaseSourceLinkOwnerFence } from '../../../../services/purchaseSourceLinkStore.js';
import { fenceAndDrainSalesSourceLinkMigration, releaseSalesSourceLinkOwnerFence } from '../../../../services/salesSourceLinkStore.js';
import {
  countPurchasePluginContextMemoryReferences,
  countPurchasePluginContextMemoryAccountReferences,
  fenceAndDrainPurchasePluginAccountContextWrites,
  fenceAndDrainPurchasePluginContextWrites,
  releasePurchasePluginOwnerFence,
  releasePurchasePluginAccountFence,
  removePurchasePluginContextMemoryForAccount,
  removePurchasePluginContextMemoryForShop,
} from '../../../../services/purchasePluginContextStore.js';
import {
  countCrossBorderSettingsMemoryReferences,
  fenceAndDrainCrossBorderSettingsWrites,
  releaseCrossBorderSettingsWriteFence,
  removeCrossBorderSettingsMemoryAccountSlice,
} from '../../../../shared/ozon/ozonRuntime.jsx';
import {
  LOCAL_OZON_SHOP_SETTINGS_FILE_KEY,
  LOCAL_PRODUCT_SOURCE_FILE_KEY,
  LOCAL_PURCHASE_ORDER_OVERRIDES_FILE_KEY,
  LOCAL_PURCHASE_SOURCE_FILE_KEY,
  LOCAL_SALES_SOURCE_FILE_KEY,
} from '../../../../shared/config/appConfigCore.jsx';
import {
  countOzonSnapshotCachesForOwner,
  fenceAndDrainOzonSnapshotCachesForOwner,
  releaseOzonSnapshotOwnerFence,
  invalidateOzonSnapshotCachesForOwner,
} from '../../../../shared/config/appConfigRuntime.jsx';
import {
  countCollectionListingCategoryTemplateCacheEntriesForShop,
  removeCollectionListingCategoryTemplateCacheForShop,
} from '../../../collectionPricing/services/collectionListingCatalogService.js';
import { ACCOUNT_REMOVAL_SAFETY_BARRIER_VERSION } from './accountRemovalClient.js';
import { createAccountRemovalFenceLeases } from './accountRemovalFenceLeases.js';
import { safeWarn } from '../../../../services/safeLog.js';

const rendererFenceLeases = createAccountRemovalFenceLeases();
const REMOTE_RECOVERY_CODES = new Set(['RECOVERY_REMOTE_AUTH_REQUIRED', 'RECOVERY_REMOTE_LOGIN_REQUIRED',
  'RECOVERY_REMOTE_ACCESS_DENIED', 'RECOVERY_REMOTE_ENDPOINT_UNAVAILABLE', 'RECOVERY_REMOTE_UNAVAILABLE']);

function remoteRecoveryError(value) {
  const code = String(value?.code || value?.data?.error?.code || value?.error?.code || value?.payload?.error?.code || value?.message || '').trim();
  return REMOTE_RECOVERY_CODES.has(code) ? Object.assign(new Error(code), { code }) : null;
}

const OZON_CLIENT_BARRIER_IDS = Object.freeze([
  'runtime:renderer-marketing-view-state-write-queue',
  'runtime:renderer-ozon-shop-settings-write-queue',
  'runtime:renderer-product-material-profile-write-queue',
  'runtime:renderer-product-source-link-migration',
  'runtime:renderer-purchase-plugin-context-write-queue',
  'runtime:renderer-purchase-source-link-migration',
  'runtime:renderer-sales-source-link-migration',
].sort());

const PURCHASE_BROWSER_RESOURCE_IDS = Object.freeze([
  'browser:purchase-cache-storage',
  'browser:purchase-cookies',
  'browser:purchase-downloads',
  'browser:purchase-extension-storage',
  'browser:purchase-http-cache',
  'browser:purchase-indexed-db',
  'browser:purchase-local-storage',
  'browser:purchase-persistent-partition',
  'browser:purchase-plugin-installation-state',
  'browser:purchase-profile-identity',
  'browser:purchase-proxy-auth',
  'browser:purchase-service-workers',
]);

const INTEGRATION_BROWSER_RESOURCE_IDS = Object.freeze([
  'browser:integration-cache-storage',
  'browser:integration-cookies',
  'browser:integration-downloads',
  'browser:integration-extension-storage',
  'browser:integration-http-cache',
  'browser:integration-indexed-db',
  'browser:integration-local-storage',
  'browser:integration-persistent-partition',
  'browser:integration-plugin-installation-state',
  'browser:integration-profile-identity',
  'browser:integration-proxy-auth',
  'browser:integration-service-workers',
]);

function normalizeOwner(owner = {}) {
  const ownerType = String(owner?.ownerType ?? '').trim();
  const ownerId = String(owner?.ownerId ?? '').trim();
  if (!ownerType || !ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  return { ownerType, ownerId };
}

function safeRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const OWNER_RECORD_MAP_FILES = Object.freeze({
  'logical:local-data-product-material-profiles-shop-records': LOCAL_PRODUCT_MATERIAL_FILE_KEY,
  'logical:local-data-purchase-order-overrides-shop-records': LOCAL_PURCHASE_ORDER_OVERRIDES_FILE_KEY,
  'logical:local-data-product-source-links-shop-records': LOCAL_PRODUCT_SOURCE_FILE_KEY,
  'logical:local-data-sales-source-links-shop-records': LOCAL_SALES_SOURCE_FILE_KEY,
  'logical:local-data-purchase-source-links-shop-records': LOCAL_PURCHASE_SOURCE_FILE_KEY,
});

function recordMapOwnerId(value) {
  return String(value?.shopId ?? value?.shop_id ?? '').trim();
}

export function removeOwnerRecordMapValues(recordMap, ownerId) {
  if (!recordMap || typeof recordMap !== 'object' || Array.isArray(recordMap)) {
    throw new Error('ACCOUNT_REMOVAL_CLIENT_RESOURCE_INVALID');
  }
  return Object.fromEntries(Object.entries(recordMap).filter(([, value]) => recordMapOwnerId(value) !== ownerId));
}

export function countOwnerRecordMapValues(recordMap, ownerId) {
  if (!recordMap || typeof recordMap !== 'object' || Array.isArray(recordMap)) {
    throw new Error('ACCOUNT_REMOVAL_CLIENT_RESOURCE_INVALID');
  }
  return Object.values(recordMap).filter((value) => recordMapOwnerId(value) === ownerId).length;
}

async function removeOwnerRecordMapFile(fileKey, ownerId) {
  const current = await readLocalDataFile(fileKey);
  if (current === null || current === undefined) return;
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error('ACCOUNT_REMOVAL_CLIENT_RESOURCE_INVALID');
  }
  const next = removeOwnerRecordMapValues(current, ownerId);
  if (Object.keys(next).length === Object.keys(current).length) return;
  await writeLocalDataFile(fileKey, next);
}

async function countOwnerRecordMapFile(fileKey, ownerId) {
  const current = await readLocalDataFile(fileKey);
  if (current === null || current === undefined) return 0;
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error('ACCOUNT_REMOVAL_CLIENT_RESOURCE_INVALID');
  }
  return countOwnerRecordMapValues(current, ownerId);
}

export function validateOzonShopFileStore(value) {
  if (value === null || value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ACCOUNT_REMOVAL_CLIENT_RESOURCE_INVALID');
  }
  if (Object.prototype.hasOwnProperty.call(value, 'shops')) {
    if (!Array.isArray(value.shops) || value.shops.some((shop) => !shop || typeof shop !== 'object' || Array.isArray(shop))) {
      throw new Error('ACCOUNT_REMOVAL_CLIENT_RESOURCE_INVALID');
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(value, 'defaultWarehouseIds')
    && (!value.defaultWarehouseIds || typeof value.defaultWarehouseIds !== 'object' || Array.isArray(value.defaultWarehouseIds))
  ) {
    throw new Error('ACCOUNT_REMOVAL_CLIENT_RESOURCE_INVALID');
  }
  return value;
}

function countOzonShopFileReferences(store, ownerId) {
  const source = safeRecord(store);
  const shops = Array.isArray(source.shops) ? source.shops : [];
  return shops.filter((shop) => String(shop?.id ?? '').trim() === ownerId).length
    + (Object.prototype.hasOwnProperty.call(safeRecord(source.defaultWarehouseIds), ownerId) ? 1 : 0)
    + (String(source.activeShopId ?? '').trim() === ownerId ? 1 : 0);
}

export async function removeOzonShopLocalDataFileSlice(ownerId, {
  readStore = () => readLocalDataFile(LOCAL_OZON_SHOP_SETTINGS_FILE_KEY),
  writeStore = (value) => writeLocalDataFile(LOCAL_OZON_SHOP_SETTINGS_FILE_KEY, value),
} = {}) {
  const current = validateOzonShopFileStore(await readStore());
  if (countOzonShopFileReferences(current, ownerId) === 0) return;
  const shops = (Array.isArray(current.shops) ? current.shops : []).filter(
    (shop) => String(shop?.id ?? '').trim() !== ownerId,
  );
  const defaultWarehouseIds = { ...safeRecord(current.defaultWarehouseIds) };
  delete defaultWarehouseIds[ownerId];
  const next = {
    ...current,
    ...(Object.prototype.hasOwnProperty.call(current, 'shops') ? { shops } : {}),
    ...(Object.prototype.hasOwnProperty.call(current, 'defaultWarehouseIds') ? { defaultWarehouseIds } : {}),
    ...(String(current.activeShopId ?? '').trim() === ownerId
      ? { activeShopId: String(shops[0]?.id ?? '') }
      : {}),
  };
  await writeStore(next);
}

export async function countOzonShopLocalDataFileReferences(ownerId, {
  readStore = () => readLocalDataFile(LOCAL_OZON_SHOP_SETTINGS_FILE_KEY),
} = {}) {
  const readback = validateOzonShopFileStore(await readStore());
  return countOzonShopFileReferences(readback, ownerId);
}

function getOzonIdentifiers(ownerId) {
  const identifiers = getOzonShopRuntimeIdentifiers(ownerId);
  return identifiers.length ? identifiers : [ownerId];
}

function getOzonOwnerScope(ownerId, lifecycle = {}) {
  return getOzonShopRuntimeOwnerScope(ownerId, lifecycle);
}

async function requestDesktopAccountRemovalBarrier(command, previewFingerprint) {
  const fingerprint = String(previewFingerprint || '').trim();
  if (!/^[a-f0-9]{64}$/iu.test(fingerprint)) {
    throw new Error('ACCOUNT_REMOVAL_PREVIEW_FINGERPRINT_REQUIRED');
  }
  const recoveryRequest = globalThis.window?.wangzaiDesktop?.recoveryRequest;
  if (typeof recoveryRequest !== 'function') {
    throw new Error('ACCOUNT_REMOVAL_RECOVERY_BARRIER_UNAVAILABLE');
  }
  let response;
  try {
    response = await recoveryRequest({ command, previewFingerprint: fingerprint });
  } catch {
    throw new Error('ACCOUNT_REMOVAL_RECOVERY_BARRIER_FAILED');
  }
  if (response?.ok !== true || response?.data?.ok !== true) {
    throw new Error('ACCOUNT_REMOVAL_RECOVERY_BARRIER_FAILED');
  }
  return response.data;
}

export async function releaseAccountRemovalBarrier(preview = {}) {
  return requestDesktopAccountRemovalBarrier(
    'end-account-removal-barrier',
    preview?.previewFingerprint || preview,
  );
}

export function releaseAccountRemovalRendererBarrier(preview, proof = {}) {
  return rendererFenceLeases.release(preview, proof, (lease, { completed, protectedIdentifiers }) => {
    const { owner, ownerScope, identifiers = [] } = lease;
    if (owner.ownerType === 'ozon_shop') {
      releaseProductMaterialProfileOwnerFence(owner.ownerId);
      releaseProductSourceLinkOwnerFence(owner.ownerId);
      releasePurchaseSourceLinkOwnerFence(owner.ownerId);
      releaseSalesSourceLinkOwnerFence(owner.ownerId);
      releasePurchaseOrderOverrideOwnerFence(owner.ownerId);
      const unsharedIds = identifiers.filter(identifier => !protectedIdentifiers.has(identifier));
      releaseProfitFinanceOwnerFence(unsharedIds);
      releaseProfitRatingPenaltyOwnerFence(unsharedIds);
      // Keep completed generation tombstones against delayed cache callbacks.
      if (!completed) {
        releaseProductListOwnerFence(ownerScope);
        releaseMarketingActivityOwnerFence(ownerScope);
        releaseOzonShopSettingsOwnerFence(ownerScope);
        releaseOzonSnapshotOwnerFence(ownerScope);
        releasePurchasePluginOwnerFence(ownerScope);
      }
    } else if (owner.ownerType === 'cross_border_bus') releaseCrossBorderSettingsWriteFence(owner.ownerId);
    else if (owner.ownerType === 'purchase_account') releasePurchasePluginAccountFence(owner.ownerId);
  });
}

export function getAccountRemovalRendererBarrierDiagnostics(preview) {
  return rendererFenceLeases.diagnostics(preview);
}

export async function prepareAccountRemovalBarrier(preview = {}) {
  const owner = normalizeOwner(preview.owner);
  if (!preview.previewFingerprint) throw new Error('ACCOUNT_REMOVAL_PREVIEW_FINGERPRINT_REQUIRED');
  await requestDesktopAccountRemovalBarrier('begin-account-removal-barrier', preview.previewFingerprint);
  const ownerScope = owner.ownerType === 'ozon_shop' ? getOzonOwnerScope(owner.ownerId, preview.ownerGeneration || {}) : null;
  const identifiers = ownerScope ? (ownerScope.identifiers.length ? ownerScope.identifiers : getOzonIdentifiers(owner.ownerId)) : [owner.ownerId];
  const diagnostics = { failedWrites: 0, lastWriteFailed: false };
  rendererFenceLeases.register(preview, { ownerScope, identifiers, diagnostics });
  let resourceIds = [];
  let drains = [];
  try {
    if (owner.ownerType === 'ozon_shop') {
      fenceProfitFinanceCachesForOwner(identifiers);
      fenceProfitRatingPenaltyCacheForOwner(identifiers);
      drains = await Promise.all([
        fenceAndDrainMarketingActivityViewStateWrites(ownerScope),
        fenceAndDrainOzonShopSettingsWrites(ownerScope),
        fenceAndDrainProductMaterialProfileWrites(owner.ownerId),
        fenceAndDrainProductSourceLinkMigration(owner.ownerId),
        fenceAndDrainPurchaseSourceLinkMigration(owner.ownerId),
        fenceAndDrainSalesSourceLinkMigration(owner.ownerId),
        fenceAndDrainPurchasePluginContextWrites(ownerScope),
        fenceAndDrainOzonSnapshotCachesForOwner(ownerScope),
        // This extra owner fence protects the renderer override cache even though
        // its queue is not part of the frozen public barrier contract.
        fenceAndDrainPurchaseOrderOverrideWrites(owner.ownerId),
      ]);
      fenceProductListCachesForOwnerIdentifiers(ownerScope);
      resourceIds = [...OZON_CLIENT_BARRIER_IDS];
    } else if (owner.ownerType === 'cross_border_bus') {
      drains = [await fenceAndDrainCrossBorderSettingsWrites(owner.ownerId)];
    } else if (owner.ownerType === 'purchase_account') {
      drains = [await fenceAndDrainPurchasePluginAccountContextWrites(owner.ownerId)];
      resourceIds = ['runtime:renderer-purchase-plugin-context-write-queue'];
    }
  } catch (error) {
    try { await releaseAccountRemovalBarrier(preview); } catch { /* keep the original barrier failure */ }
    throw error;
  }

  diagnostics.failedWrites = drains.reduce((sum, drain) => sum + Math.max(0, Number(drain?.failedWrites) || 0), 0);
  diagnostics.lastWriteFailed = diagnostics.failedWrites > 0;
  if (diagnostics.lastWriteFailed) safeWarn('账号删除前写队列已排空；历史写入失败仍保留为失败', {
    ownerType: owner.ownerType, failedWrites: diagnostics.failedWrites,
  });

  return {
    version: ACCOUNT_REMOVAL_SAFETY_BARRIER_VERSION,
    owner,
    previewFingerprint: preview.previewFingerprint,
    fencedResourceIds: [...resourceIds],
    drainedResourceIds: [...resourceIds],
  };
}

async function purgeRemoteRecoveryOwner(runtimeOwner = {}) {
  const operationId = String(runtimeOwner.operationId || '').trim();
  if (!operationId) throw new Error('ACCOUNT_REMOVAL_OPERATION_ID_REQUIRED');
  const recoveryRequest = globalThis.window?.wangzaiDesktop?.recoveryRequest;
  if (typeof recoveryRequest !== 'function') {
    throw new Error('ACCOUNT_REMOVAL_REMOTE_RECOVERY_BRIDGE_UNAVAILABLE');
  }
  runtimeOwner.remoteRecoveryVerified = false;
  let response;
  try {
    response = await recoveryRequest({ command: 'purge-account-owner', operationId });
  } catch (error) {
    throw remoteRecoveryError(error) || new Error('ACCOUNT_REMOVAL_REMOTE_RECOVERY_PURGE_FAILED');
  }
  if (response?.ok !== true || response?.data?.ok !== true || response?.data?.verified !== true) {
    throw remoteRecoveryError(response) || new Error('ACCOUNT_REMOVAL_REMOTE_RECOVERY_PURGE_FAILED');
  }
  runtimeOwner.remoteRecoveryVerified = true;
}

function countRemoteRecoveryOwner(runtimeOwner = {}) {
  return runtimeOwner.remoteRecoveryVerified === true ? 0 : 1;
}

function remoteRecoveryOwnerAdapter(ownerType) {
  return {
    ownerType,
    remove: purgeRemoteRecoveryOwner,
    count: countRemoteRecoveryOwner,
  };
}

async function purgeRecoveryProtectionOwner(runtimeOwner = {}) {
  const operationId = String(runtimeOwner.operationId || '').trim();
  if (!operationId) throw new Error('ACCOUNT_REMOVAL_OPERATION_ID_REQUIRED');
  const recoveryRequest = globalThis.window?.wangzaiDesktop?.recoveryRequest;
  if (typeof recoveryRequest !== 'function') {
    throw new Error('ACCOUNT_REMOVAL_PROTECTION_BRIDGE_UNAVAILABLE');
  }
  runtimeOwner.recoveryProtectionVerified = false;
  runtimeOwner.diagnosticLogsVerified = false;
  let response;
  try {
    response = await recoveryRequest({ command: 'purge-account-owner-protection', operationId });
  } catch (error) {
    throw remoteRecoveryError(error) || new Error('ACCOUNT_REMOVAL_PROTECTION_PURGE_FAILED');
  }
  if (
    response?.ok !== true
    || response?.data?.ok !== true
    || response?.data?.verified !== true
    || response?.data?.diagnosticLogs?.verified !== true
  ) {
    throw remoteRecoveryError(response) || new Error('ACCOUNT_REMOVAL_PROTECTION_PURGE_FAILED');
  }
  runtimeOwner.recoveryProtectionVerified = true;
  runtimeOwner.diagnosticLogsVerified = true;
}

function recoveryProtectionOwnerAdapter(ownerType) {
  return {
    ownerType,
    remove: (runtimeOwner) => (
      runtimeOwner.recoveryProtectionVerified === true
        ? undefined
        : purgeRecoveryProtectionOwner(runtimeOwner)
    ),
    count: (runtimeOwner) => (runtimeOwner.recoveryProtectionVerified === true ? 0 : 1),
  };
}

function diagnosticLogOwnerAdapter(ownerType) {
  return {
    ownerType,
    remove: (runtimeOwner) => (
      runtimeOwner.diagnosticLogsVerified === true
        ? undefined
        : purgeRecoveryProtectionOwner(runtimeOwner)
    ),
    count: (runtimeOwner) => (runtimeOwner.diagnosticLogsVerified === true ? 0 : 1),
  };
}

async function purgePurchaseBrowserOwner(runtimeOwner = {}) {
  const operationId = String(runtimeOwner.operationId || '').trim();
  if (!operationId) throw new Error('ACCOUNT_REMOVAL_OPERATION_ID_REQUIRED');
  const command = globalThis.window?.wangzaiDesktop?.purchaseBrowser?.command;
  if (typeof command !== 'function') {
    throw new Error('ACCOUNT_REMOVAL_PURCHASE_BROWSER_BRIDGE_UNAVAILABLE');
  }
  runtimeOwner.purchaseBrowserVerified = false;
  let response;
  try {
    response = await command({ command: 'purge-operation', operationId });
  } catch {
    throw new Error('ACCOUNT_REMOVAL_PURCHASE_BROWSER_PURGE_FAILED');
  }
  if (response?.ok === true && response?.inProgress === true && response?.operationId === operationId) {
    const error = new Error('PURCHASE_BROWSER_ACCOUNT_REMOVAL_IN_PROGRESS');
    error.code = 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_IN_PROGRESS';
    error.operationId = operationId;
    error.phase = response.phase;
    throw error;
  }
  if (response?.ok !== true || response?.verified !== true || response?.proof?.verified !== true) {
    throw new Error('ACCOUNT_REMOVAL_PURCHASE_BROWSER_PURGE_FAILED');
  }
  runtimeOwner.purchaseBrowserVerified = true;
}

function purchaseBrowserOwnerAdapter(ownerType = 'purchase_account') {
  return {
    ownerType,
    remove: (runtimeOwner) => (
      runtimeOwner.purchaseBrowserVerified === true
        ? undefined
        : purgePurchaseBrowserOwner(runtimeOwner)
    ),
    count: (runtimeOwner) => (runtimeOwner.purchaseBrowserVerified === true ? 0 : 1),
  };
}

async function purgePurchaseBridgeShopOwner(runtimeOwner = {}) {
  if (runtimeOwner.purchaseBridgeVerified === true) return;
  const request = globalThis.window?.wangzaiDesktop?.purchaseBridgeRequest;
  if (typeof request !== 'function') throw new Error('ACCOUNT_REMOVAL_PURCHASE_BRIDGE_UNAVAILABLE');
  const response = await request({
    method: 'POST',
    path: '/api/purchase/account-removal/ozon-shop',
    body: {
      ownerId: runtimeOwner.ownerId,
      shopIncarnation: runtimeOwner.ownerScope?.shopIncarnation || '',
      credentialRevision: runtimeOwner.ownerScope?.credentialRevision || 0,
    },
  });
  if (response?.ok !== true || response?.data?.verified !== true || Number(response?.data?.remaining || 0) !== 0) {
    throw new Error('ACCOUNT_REMOVAL_PURCHASE_BRIDGE_PURGE_FAILED');
  }
  runtimeOwner.purchaseBridgeVerified = true;
}

function purchaseBridgeShopAdapter() {
  return {
    ownerType: 'ozon_shop',
    remove: purgePurchaseBridgeShopOwner,
    count: (runtimeOwner) => (runtimeOwner.purchaseBridgeVerified === true ? 0 : 1),
  };
}

async function purgePurchaseBridgeAccountOwner(runtimeOwner = {}) {
  if (runtimeOwner.purchaseBridgeAccountVerified === true) return;
  const request = globalThis.window?.wangzaiDesktop?.purchaseBridgeRequest;
  if (typeof request !== 'function') throw new Error('ACCOUNT_REMOVAL_PURCHASE_BRIDGE_UNAVAILABLE');
  const response = await request({
    method: 'POST',
    path: '/api/purchase/account-removal/purchase-account',
    body: { ownerId: runtimeOwner.ownerId },
  });
  if (response?.ok !== true || response?.data?.verified !== true || Number(response?.data?.remaining || 0) !== 0) {
    throw new Error('ACCOUNT_REMOVAL_PURCHASE_BRIDGE_PURGE_FAILED');
  }
  runtimeOwner.purchaseBridgeAccountVerified = true;
}

function purchaseBridgeAccountAdapter() {
  return {
    ownerType: 'purchase_account',
    remove: purgePurchaseBridgeAccountOwner,
    count: (runtimeOwner) => (runtimeOwner.purchaseBridgeAccountVerified === true ? 0 : 1),
  };
}

const OWNER_RECORD_MAP_ADAPTERS = Object.freeze(Object.fromEntries(
  Object.entries(OWNER_RECORD_MAP_FILES).map(([resourceId, fileKey]) => [resourceId, {
    ownerType: 'ozon_shop',
    remove: ({ ownerId }) => removeOwnerRecordMapFile(fileKey, ownerId),
    count: ({ ownerId }) => countOwnerRecordMapFile(fileKey, ownerId),
  }]),
));

const PURCHASE_BROWSER_RESOURCE_ADAPTERS = Object.freeze(Object.fromEntries(
  PURCHASE_BROWSER_RESOURCE_IDS.map((resourceId) => [resourceId, purchaseBrowserOwnerAdapter()]),
));
const INTEGRATION_BROWSER_RESOURCE_ADAPTERS = Object.freeze(Object.fromEntries(
  INTEGRATION_BROWSER_RESOURCE_IDS.map((resourceId) => [resourceId, purchaseBrowserOwnerAdapter('integration_profile')]),
));

const CLIENT_RESOURCE_ADAPTERS = Object.freeze({
  'backup:remote-recovery-owner-ozon-shop': remoteRecoveryOwnerAdapter('ozon_shop'),
  'backup:remote-recovery-owner-cross-border-bus': remoteRecoveryOwnerAdapter('cross_border_bus'),
  'backup:remote-recovery-owner-promotion-account': remoteRecoveryOwnerAdapter('promotion_account'),
  'backup:remote-recovery-owner-purchase-account': remoteRecoveryOwnerAdapter('purchase_account'),
  'backup:remote-recovery-owner-model-api-account': remoteRecoveryOwnerAdapter('model_api_account'),
  'backup:remote-recovery-owner-integration-profile': remoteRecoveryOwnerAdapter('integration_profile'),
  ...PURCHASE_BROWSER_RESOURCE_ADAPTERS,
  ...INTEGRATION_BROWSER_RESOURCE_ADAPTERS,
  ...OWNER_RECORD_MAP_ADAPTERS,
  'memory:purchase-search-bridge-context-unattributed': purchaseBridgeShopAdapter(),
  'memory:purchase-search-bridge-captures-unattributed': purchaseBridgeShopAdapter(),
  'memory:purchase-search-bridge-purchase-account-context': purchaseBridgeAccountAdapter(),
  'memory:purchase-search-bridge-purchase-account-captures': purchaseBridgeAccountAdapter(),
  'filesystem:recovery-protection-owner-ozon-shop': recoveryProtectionOwnerAdapter('ozon_shop'),
  'filesystem:recovery-protection-owner-cross-border-bus': recoveryProtectionOwnerAdapter('cross_border_bus'),
  'filesystem:recovery-protection-owner-promotion-account': recoveryProtectionOwnerAdapter('promotion_account'),
  'filesystem:recovery-protection-owner-purchase-account': recoveryProtectionOwnerAdapter('purchase_account'),
  'filesystem:recovery-protection-owner-model-api-account': recoveryProtectionOwnerAdapter('model_api_account'),
  'filesystem:recovery-protection-owner-integration-profile': recoveryProtectionOwnerAdapter('integration_profile'),
  'filesystem:diagnostic-logs-owner-ozon-shop': diagnosticLogOwnerAdapter('ozon_shop'),
  'filesystem:diagnostic-logs-owner-cross-border-bus': diagnosticLogOwnerAdapter('cross_border_bus'),
  'filesystem:diagnostic-logs-owner-promotion-account': diagnosticLogOwnerAdapter('promotion_account'),
  'filesystem:diagnostic-logs-owner-purchase-account': diagnosticLogOwnerAdapter('purchase_account'),
  'filesystem:diagnostic-logs-owner-model-api-account': diagnosticLogOwnerAdapter('model_api_account'),
  'filesystem:diagnostic-logs-owner-integration-profile': diagnosticLogOwnerAdapter('integration_profile'),
  'logical:local-data-ozon-shop-settings-shop-slices': {
    ownerType: 'ozon_shop',
    remove: ({ ownerId }) => removeOzonShopLocalDataFileSlice(ownerId),
    count: ({ ownerId }) => countOzonShopLocalDataFileReferences(ownerId),
  },
  'logical:renderer-ozon-shop-settings-shop-slices': {
    ownerType: 'ozon_shop',
    remove: ({ ownerId }) => removeOzonShopSettingsMemorySlice(ownerId),
    count: ({ ownerId }) => countOzonShopSettingsMemoryReferences(ownerId),
  },
  'logical:renderer-purchase-order-overrides-shop-records': {
    ownerType: 'ozon_shop',
    remove: ({ ownerId }) => removePurchaseOrderOverrideMemoryForShop(ownerId),
    count: ({ ownerId }) => countPurchaseOrderOverrideMemoryForShop(ownerId),
  },
  'memory:renderer-product-material-profiles': {
    ownerType: 'ozon_shop',
    remove: ({ ownerId }) => removeProductMaterialProfilesForShop(ownerId),
    count: ({ ownerId }) => countProductMaterialProfilesForShop(ownerId),
  },
  'memory:renderer-collection-listing-category-template-cache': {
    ownerType: 'ozon_shop',
    remove: ({ ownerId }) => removeCollectionListingCategoryTemplateCacheForShop(ownerId),
    count: ({ ownerId }) => countCollectionListingCategoryTemplateCacheEntriesForShop(ownerId),
  },
  'memory:renderer-purchase-plugin-source-context-unattributed': {
    ownerType: 'ozon_shop',
    remove: ({ ownerScope, ownerId }) => removePurchasePluginContextMemoryForShop(ownerScope || ownerId),
    count: ({ ownerId }) => countPurchasePluginContextMemoryReferences(ownerId),
  },
  'memory:renderer-product-list-memory-cache-unattributed': {
    ownerType: 'ozon_shop',
    remove: ({ ownerScope, identifiers }) => invalidateProductListCachesForOwnerIdentifiers(ownerScope || identifiers),
    count: ({ ownerScope, identifiers }) => countProductListCachesForOwnerIdentifiers(ownerScope || identifiers),
  },
  'memory:renderer-product-list-page-meta-cache-unattributed': {
    ownerType: 'ozon_shop',
    remove: ({ ownerScope, identifiers }) => invalidateProductListCachesForOwnerIdentifiers(ownerScope || identifiers),
    count: ({ ownerScope, identifiers }) => countProductListCachesForOwnerIdentifiers(ownerScope || identifiers),
  },
  'memory:renderer-product-list-cursor-cache-unattributed': {
    ownerType: 'ozon_shop',
    remove: ({ ownerScope, identifiers }) => invalidateProductListCachesForOwnerIdentifiers(ownerScope || identifiers),
    count: ({ ownerScope, identifiers }) => countProductListCachesForOwnerIdentifiers(ownerScope || identifiers),
  },
  'memory:renderer-ozon-snapshot-memory-cache-unattributed': {
    ownerType: 'ozon_shop',
    remove: ({ ownerScope, identifiers }) => invalidateOzonSnapshotCachesForOwner(ownerScope || identifiers),
    count: ({ ownerScope, identifiers }) => countOzonSnapshotCachesForOwner(ownerScope || identifiers),
  },
  'memory:renderer-ozon-snapshot-inflight-unattributed': {
    ownerType: 'ozon_shop',
    remove: ({ ownerScope, identifiers }) => invalidateOzonSnapshotCachesForOwner(ownerScope || identifiers),
    count: ({ ownerScope, identifiers }) => countOzonSnapshotCachesForOwner(ownerScope || identifiers),
  },
  'memory:renderer-ozon-snapshot-manual-refresh-unattributed': {
    ownerType: 'ozon_shop',
    remove: ({ ownerScope, identifiers }) => invalidateOzonSnapshotCachesForOwner(ownerScope || identifiers),
    count: ({ ownerScope, identifiers }) => countOzonSnapshotCachesForOwner(ownerScope || identifiers),
  },
  'memory:renderer-profit-after-sales-snapshot-cache': {
    ownerType: 'ozon_shop',
    remove: ({ identifiers }) => invalidateProfitAfterSalesCacheEntriesForOwner(identifiers),
    count: ({ identifiers }) => countProfitAfterSalesCacheEntriesForOwner(identifiers),
  },
  'memory:renderer-profit-finance-operation-cache': {
    ownerType: 'ozon_shop',
    remove: ({ identifiers }) => invalidateProfitFinanceCacheEntriesForOwner(identifiers),
    count: ({ identifiers }) => countProfitFinanceCacheEntriesForOwner(identifiers),
  },
  'memory:renderer-profit-rating-penalty-operation-cache': {
    ownerType: 'ozon_shop',
    remove: ({ identifiers }) => invalidateProfitRatingPenaltyCacheEntriesForOwner(identifiers),
    count: ({ identifiers }) => countProfitRatingPenaltyCacheEntriesForOwner(identifiers),
  },
  'logical:renderer-cross-border-settings-account-slice': {
    ownerType: 'cross_border_bus',
    remove: ({ ownerId }) => removeCrossBorderSettingsMemoryAccountSlice(ownerId),
    count: ({ ownerId }) => countCrossBorderSettingsMemoryReferences(ownerId),
  },
  'memory:renderer-model-api-settings': {
    ownerType: 'model_api_account',
    remove: ({ ownerId }) => removeModelApiSettingsMemoryInterface(ownerId),
    count: ({ ownerId }) => countModelApiSettingsMemoryReferences(ownerId),
  },
  'memory:renderer-purchase-plugin-account-context': {
    ownerType: 'purchase_account',
    remove: ({ ownerId }) => removePurchasePluginContextMemoryForAccount(ownerId),
    count: ({ ownerId }) => countPurchasePluginContextMemoryAccountReferences(ownerId),
  },
});

export async function cleanupAndVerifyAccountRemovalClientResources(
  ownerInput,
  resourceIds = [],
  { adapters = CLIENT_RESOURCE_ADAPTERS, operationId = '' } = {},
) {
  const owner = normalizeOwner(ownerInput);
  const runtimeOwner = {
    ...owner,
    operationId: String(operationId || '').trim(),
    ownerScope: owner.ownerType === 'ozon_shop' ? getOzonOwnerScope(owner.ownerId, ownerInput) : null,
    identifiers: owner.ownerType === 'ozon_shop' ? getOzonIdentifiers(owner.ownerId) : [owner.ownerId],
  };
  if (runtimeOwner.ownerScope?.identifiers?.length) runtimeOwner.identifiers = runtimeOwner.ownerScope.identifiers;
  const ids = [...new Set(Array.isArray(resourceIds) ? resourceIds : [])].sort();
  if (ids.length !== (Array.isArray(resourceIds) ? resourceIds.length : 0)) {
    throw new Error('ACCOUNT_REMOVAL_CLIENT_RESOURCE_DUPLICATE');
  }
  const removalOrder = ['purchase_account', 'integration_profile'].includes(owner.ownerType)
    ? [
        ...ids.filter((resourceId) => !resourceId.startsWith('browser:')),
        ...ids.filter((resourceId) => resourceId.startsWith('browser:')),
      ]
    : ids;
  for (const resourceId of removalOrder) {
    const adapter = adapters[resourceId];
    if (!adapter || adapter.ownerType !== owner.ownerType) {
      throw new Error('ACCOUNT_REMOVAL_CLIENT_RESOURCE_UNREGISTERED');
    }
    try { await adapter.remove(runtimeOwner); }
    catch (error) {
      if (error && typeof error === 'object') error.resourceId = resourceId;
      throw error;
    }
  }

  const observations = [];
  for (const resourceId of ids) {
    const remaining = Number(await adapters[resourceId].count(runtimeOwner));
    if (!Number.isSafeInteger(remaining) || remaining !== 0) {
      const error = new Error('ACCOUNT_REMOVAL_CLIENT_VERIFY_FAILED');
      error.resourceId = resourceId;
      error.remaining = remaining;
      throw error;
    }
    observations.push({ resourceId, state: 'absent' });
  }
  return observations;
}

export function getAccountRemovalClientResourceAdapterIds() {
  return Object.keys(CLIENT_RESOURCE_ADAPTERS).sort();
}
