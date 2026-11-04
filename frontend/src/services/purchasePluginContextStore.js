import { settleOwnerWriteDrain } from './ownerWriteDrain.js';
import { getProfileSetting, saveProfileSetting } from '../api/localApiClient.js';
import {
  LOCAL_PURCHASE_PLUGIN_SOURCE_CONTEXT_FILE_KEY,
} from '../shared/config/appConfigCore.jsx';
import {
  readRetiredPurchasePluginContextFile,
  writeRetiredPurchasePluginContextMarker,
} from './localDataFileClient.js';
import { safeWarn } from './safeLog';
import {
  isOzonShopGenerationFenced,
  normalizeOzonShopGenerationScope,
  serializeOzonShopGenerationScope,
} from '../shared/ozon/ozonShopGeneration.js';

export const PROFILE_PURCHASE_PLUGIN_CONTEXT_NAMESPACE = 'purchase-plugin-context';

const PURCHASE_PLUGIN_CONTEXT_VERSION = 1;
const PURCHASE_PLUGIN_CONTEXT_TEXT_LIMITS = Object.freeze({
  shopName: 120,
  shopId: 120,
  shopClientId: 120,
  purchaseAccountId: 128,
  shopIncarnation: 180,
  orderId: 160,
  orderKey: 260,
  productKey: 260,
  legacyProductKey: 160,
  offerId: 160,
  sku: 160,
  productName: 260,
  ozonOrderId: 160,
  salesAmount: 80,
  productImageUrl: 2048,
  lockedAt: 80,
  updatedAt: 80,
});
const PURCHASE_PLUGIN_CONTEXT_TEXT_FIELDS = Object.freeze(Object.keys(PURCHASE_PLUGIN_CONTEXT_TEXT_LIMITS));
const PURCHASE_PLUGIN_CONTEXT_FIELDS = new Set([
  ...PURCHASE_PLUGIN_CONTEXT_TEXT_FIELDS,
  'productIndex',
  'credentialRevision',
]);
const PURCHASE_PLUGIN_CONTEXT_ENVELOPE_FIELDS = new Set(['version', 'context', 'updatedAt']);

let getProfileSettingAdapter = getProfileSetting;
let saveProfileSettingAdapter = saveProfileSetting;
let readLegacyFileAdapter = readRetiredPurchasePluginContextFile;
let writeLegacyFileMarkerAdapter = writeRetiredPurchasePluginContextMarker;
let purchasePluginContextWriteQueue = Promise.resolve();
let lastPurchasePluginContextOperation = Promise.resolve();
let activePurchasePluginSourceContextMigration = null;
let purchasePluginContextRevision = 0;

export let purchasePluginSourceContextMemory = null;

function normalizePurchasePluginOwnerId(value) {
  return String(value ?? '').trim();
}

function getPurchasePluginFencedOwnerScopes() {
  return removePurchasePluginContextMemoryForShop.fencedOwnerScopes || [];
}

function getPurchasePluginFencedAccountIds() {
  return removePurchasePluginContextMemoryForAccount.fencedAccountIds || [];
}

function addPurchasePluginOwnerFence(shopOrScope) {
  const scope = normalizeOzonShopGenerationScope(shopOrScope);
  if (!scope.ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  const key = serializeOzonShopGenerationScope(scope);
  const current = getPurchasePluginFencedOwnerScopes();
  if (!current.some((entry) => entry.key === key)) {
    removePurchasePluginContextMemoryForShop.fencedOwnerScopes = [...current, { key, scope }];
  }
  return scope;
}

export async function fenceAndDrainPurchasePluginContextWrites(shopOrScope) {
  const scope = addPurchasePluginOwnerFence(shopOrScope);
  const drain = await settleOwnerWriteDrain([purchasePluginContextWriteQueue, activePurchasePluginSourceContextMigration]);
  return { ownerId: scope.ownerId, shopIncarnation: scope.shopIncarnation, credentialRevision: scope.credentialRevision, fenced: true, ...drain };
}

export async function fenceAndDrainPurchasePluginAccountContextWrites(accountId) {
  const ownerId = normalizePurchasePluginOwnerId(accountId);
  if (!ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  const current = getPurchasePluginFencedAccountIds();
  if (!current.includes(ownerId)) {
    removePurchasePluginContextMemoryForAccount.fencedAccountIds = [...current, ownerId];
  }
  const drain = await settleOwnerWriteDrain([purchasePluginContextWriteQueue, activePurchasePluginSourceContextMigration]);
  return { ownerId, fenced: true, ...drain };
}

export function releasePurchasePluginOwnerFence(shopOrScope) {
  const key = serializeOzonShopGenerationScope(normalizeOzonShopGenerationScope(shopOrScope));
  removePurchasePluginContextMemoryForShop.fencedOwnerScopes = getPurchasePluginFencedOwnerScopes().filter(entry => entry.key !== key);
}

export function releasePurchasePluginAccountFence(accountId) {
  const ownerId = normalizePurchasePluginOwnerId(accountId);
  removePurchasePluginContextMemoryForAccount.fencedAccountIds = getPurchasePluginFencedAccountIds().filter(id => id !== ownerId);
}

export function countPurchasePluginContextMemoryReferences(shopId) {
  const ownerId = normalizePurchasePluginOwnerId(shopId);
  return ownerId && normalizePurchasePluginOwnerId(purchasePluginSourceContextMemory?.shopId) === ownerId ? 1 : 0;
}

export function removePurchasePluginContextMemoryForShop(shopOrScope) {
  const scope = addPurchasePluginOwnerFence(shopOrScope);
  const ownerId = scope.ownerId;
  if (normalizePurchasePluginOwnerId(purchasePluginSourceContextMemory?.shopId) === ownerId) {
    purchasePluginContextRevision += 1;
    purchasePluginSourceContextMemory = {};
  }
}

export function countPurchasePluginContextMemoryAccountReferences(accountId) {
  const ownerId = normalizePurchasePluginOwnerId(accountId);
  return ownerId && normalizePurchasePluginOwnerId(purchasePluginSourceContextMemory?.purchaseAccountId) === ownerId ? 1 : 0;
}

export function removePurchasePluginContextMemoryForAccount(accountId) {
  const ownerId = normalizePurchasePluginOwnerId(accountId);
  if (!ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  const current = getPurchasePluginFencedAccountIds();
  if (!current.includes(ownerId)) {
    removePurchasePluginContextMemoryForAccount.fencedAccountIds = [...current, ownerId];
  }
  if (normalizePurchasePluginOwnerId(purchasePluginSourceContextMemory?.purchaseAccountId) === ownerId) {
    purchasePluginContextRevision += 1;
    purchasePluginSourceContextMemory = {};
  }
}

export function configurePurchasePluginContextStore({
  getProfileSetting: nextGetProfileSetting,
  saveProfileSetting: nextSaveProfileSetting,
  readLegacyFile,
  writeLegacyFileMarker,
  writeLegacyFile,
} = {}) {
  if (typeof nextGetProfileSetting === 'function') getProfileSettingAdapter = nextGetProfileSetting;
  if (typeof nextSaveProfileSetting === 'function') saveProfileSettingAdapter = nextSaveProfileSetting;
  if (typeof readLegacyFile === 'function') readLegacyFileAdapter = readLegacyFile;
  if (typeof writeLegacyFileMarker === 'function') writeLegacyFileMarkerAdapter = writeLegacyFileMarker;
  if (typeof writeLegacyFile === 'function') writeLegacyFileMarkerAdapter = writeLegacyFile;
}

export function resetPurchasePluginContextStoreForTest() {
  getProfileSettingAdapter = getProfileSetting;
  saveProfileSettingAdapter = saveProfileSetting;
  readLegacyFileAdapter = readRetiredPurchasePluginContextFile;
  writeLegacyFileMarkerAdapter = writeRetiredPurchasePluginContextMarker;
  purchasePluginContextWriteQueue = Promise.resolve();
  lastPurchasePluginContextOperation = Promise.resolve();
  activePurchasePluginSourceContextMigration = null;
  purchasePluginContextRevision = 0;
  removePurchasePluginContextMemoryForShop.fencedOwnerScopes = [];
  removePurchasePluginContextMemoryForAccount.fencedAccountIds = [];
  purchasePluginSourceContextMemory = null;
}

export function getPlainPurchasePluginSourceContext(value = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Normal runtime input comes from the purchase page, so it may be formatted before persistence. */
export function normalizePurchasePluginSourceContext(value = {}) {
  const source = getPlainPurchasePluginSourceContext(value);
  if (!Object.keys(source).length) return {};
  const context = {};
  PURCHASE_PLUGIN_CONTEXT_TEXT_FIELDS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(source, key)) return;
    context[key] = String(source[key] ?? '').trim().slice(0, PURCHASE_PLUGIN_CONTEXT_TEXT_LIMITS[key]);
  });
  if (Object.prototype.hasOwnProperty.call(source, 'productIndex')) {
    const productIndex = Number(source.productIndex);
    context.productIndex = Number.isSafeInteger(productIndex) && productIndex >= 0 ? productIndex : 0;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'credentialRevision')) {
    const credentialRevision = Number(source.credentialRevision);
    context.credentialRevision = Number.isSafeInteger(credentialRevision) && credentialRevision > 0
      ? credentialRevision
      : 0;
  }
  return context;
}

export function normalizePurchasePluginSourceContextStore(value = {}) {
  const source = getPlainPurchasePluginSourceContext(value);
  const rawContext = normalizePurchasePluginSourceContext(source.context || source);
  return {
    version: PURCHASE_PLUGIN_CONTEXT_VERSION,
    context: rawContext,
    updatedAt: String(source.updatedAt || rawContext.updatedAt || rawContext.lockedAt || '').slice(0, 80),
  };
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function invalidLegacy(reason) {
  return Object.freeze({ kind: 'invalid', reason });
}

function validLegacy(store, source = 'legacy') {
  return Object.freeze({ kind: 'valid', source, store });
}

function emptyLegacy(source = 'legacy') {
  return Object.freeze({ kind: 'empty', source });
}

function strictContext(value) {
  const source = getPlainPurchasePluginSourceContext(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidLegacy('CONTEXT_NOT_OBJECT');
  const keys = Object.keys(source);
  if (!keys.length) return Object.freeze({ kind: 'valid', context: {} });
  if (keys.some((key) => !PURCHASE_PLUGIN_CONTEXT_FIELDS.has(key))) return invalidLegacy('CONTEXT_UNKNOWN_FIELD');

  const context = {};
  for (const key of PURCHASE_PLUGIN_CONTEXT_TEXT_FIELDS) {
    if (!hasOwn(source, key)) continue;
    if (typeof source[key] !== 'string' || source[key].length > PURCHASE_PLUGIN_CONTEXT_TEXT_LIMITS[key]) {
      return invalidLegacy(`CONTEXT_INVALID_${key}`);
    }
    context[key] = source[key];
  }
  if (hasOwn(source, 'productIndex')) {
    if (!Number.isSafeInteger(source.productIndex) || source.productIndex < 0) {
      return invalidLegacy('CONTEXT_INVALID_PRODUCT_INDEX');
    }
    context.productIndex = source.productIndex;
  }
  if (hasOwn(source, 'credentialRevision')) {
    if (!Number.isSafeInteger(source.credentialRevision) || source.credentialRevision <= 0) {
      return invalidLegacy('CONTEXT_INVALID_CREDENTIAL_REVISION');
    }
    context.credentialRevision = source.credentialRevision;
  }
  return Object.freeze({ kind: 'valid', context });
}

function isLegacyFileMarker(value = {}) {
  const source = getPlainPurchasePluginSourceContext(value);
  return (
    Object.keys(source).length === 3 &&
    source.migration === 'profile-settings' &&
    source.namespace === PROFILE_PURCHASE_PLUGIN_CONTEXT_NAMESPACE &&
    typeof source.migratedAt === 'string' &&
    source.migratedAt.length <= PURCHASE_PLUGIN_CONTEXT_TEXT_LIMITS.updatedAt
  );
}

/**
 * Legacy inputs are parsed strictly and without trimming/coercion/truncation.
 * A malformed or unknown field is retained rather than converted into a value
 * that might accidentally match another retained source.
 */
function parseStrictPurchasePluginLegacyStore(value, { allowRawContext = true, source = 'legacy' } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidLegacy('STORE_NOT_OBJECT');
  const raw = getPlainPurchasePluginSourceContext(value);
  if (!Object.keys(raw).length) return emptyLegacy(source);
  // `updatedAt` is also a legitimate legacy context field, so it alone must
  // not turn a raw browser context into an envelope.
  const isEnvelope = hasOwn(raw, 'version') || hasOwn(raw, 'context');
  if (!isEnvelope && allowRawContext) {
    const parsedContext = strictContext(raw);
    if (parsedContext.kind !== 'valid') return parsedContext;
    return validLegacy(
      {
        version: PURCHASE_PLUGIN_CONTEXT_VERSION,
        context: parsedContext.context,
        updatedAt: parsedContext.context.updatedAt || parsedContext.context.lockedAt || '',
      },
      source
    );
  }
  if (Object.keys(raw).some((key) => !PURCHASE_PLUGIN_CONTEXT_ENVELOPE_FIELDS.has(key))) {
    return invalidLegacy('STORE_UNKNOWN_FIELD');
  }
  if (raw.version !== PURCHASE_PLUGIN_CONTEXT_VERSION) return invalidLegacy('STORE_INVALID_VERSION');
  if (typeof raw.updatedAt !== 'string' || raw.updatedAt.length > PURCHASE_PLUGIN_CONTEXT_TEXT_LIMITS.updatedAt) {
    return invalidLegacy('STORE_INVALID_UPDATED_AT');
  }
  const parsedContext = strictContext(raw.context);
  if (parsedContext.kind !== 'valid') return parsedContext;
  return validLegacy(
    {
      version: PURCHASE_PLUGIN_CONTEXT_VERSION,
      context: parsedContext.context,
      updatedAt: raw.updatedAt,
    },
    source
  );
}

function storesMatch(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasContext(store = {}) {
  return Boolean(store?.context && Object.keys(store.context).length);
}

function legacyFileMarker() {
  return {
    migration: 'profile-settings',
    namespace: PROFILE_PURCHASE_PLUGIN_CONTEXT_NAMESPACE,
    migratedAt: new Date().toISOString(),
  };
}

async function readStrictFileLegacy() {
  let raw;
  try {
    raw = await readLegacyFileAdapter(LOCAL_PURCHASE_PLUGIN_SOURCE_CONTEXT_FILE_KEY);
  } catch {
    return Object.freeze({ kind: 'error', source: 'file', reason: 'FILE_READ_FAILED' });
  }
  if (isLegacyFileMarker(raw)) return emptyLegacy('file-marker');
  return parseStrictPurchasePluginLegacyStore(raw, { source: 'file' });
}

async function readCanonicalPurchasePluginContext() {
  const current = await getProfileSettingAdapter(PROFILE_PURCHASE_PLUGIN_CONTEXT_NAMESPACE, { timeoutMs: 10000 });
  if (!current?.setting?.value) return null;
  const parsed = parseStrictPurchasePluginLegacyStore(current.setting.value, {
    allowRawContext: false,
    source: 'canonical',
  });
  if (parsed.kind !== 'valid') throw new Error('拍单插件 canonical profile 数据不合法。');
  return parsed.store;
}

function enqueuePurchasePluginContextOperation(worker) {
  const operation = purchasePluginContextWriteQueue.catch(() => undefined).then(worker);
  purchasePluginContextWriteQueue = operation.catch(() => undefined);
  lastPurchasePluginContextOperation = operation;
  return operation;
}

async function markMatchingFileLegacy(fileLegacy, canonicalStore) {
  if (fileLegacy.kind !== 'valid' || !storesMatch(fileLegacy.store, canonicalStore)) return false;
  try {
    const marked = await writeLegacyFileMarkerAdapter(LOCAL_PURCHASE_PLUGIN_SOURCE_CONTEXT_FILE_KEY, legacyFileMarker());
    if (marked !== true) throw new Error('LEGACY_FILE_MARKER_NOT_CONFIRMED');
    const readback = await readLegacyFileAdapter(LOCAL_PURCHASE_PLUGIN_SOURCE_CONTEXT_FILE_KEY);
    if (!isLegacyFileMarker(readback)) throw new Error('LEGACY_FILE_MARKER_READBACK_MISMATCH');
    return true;
  } catch (error) {
    safeWarn('[拍单插件上下文] canonical 回读后本地旧副本清理失败', error);
    return false;
  }
}

async function scrubMatchingLegacySources({ fileLegacy, canonicalStore }) {
  await markMatchingFileLegacy(fileLegacy, canonicalStore);
}

/**
 * Canonical runtime load: profile-settings SQLite is the only durable source.
 * The retired local-data JSON is a one-time migration input. Invalid or
 * unreadable legacy data fails closed and is never used as a fallback.
 */
async function hydratePurchasePluginSourceContextFromLocalFileInternal() {
  const migrationRevision = purchasePluginContextRevision;
  const [fileLegacy, current] = await Promise.all([
    readStrictFileLegacy(),
    readCanonicalPurchasePluginContext(),
  ]);
  if (current) {
    return enqueuePurchasePluginContextOperation(async () => {
      if (purchasePluginContextRevision !== migrationRevision) return purchasePluginSourceContextMemory || {};
      purchasePluginSourceContextMemory = current.context;
      await scrubMatchingLegacySources({ fileLegacy, canonicalStore: current });
      return current.context;
    });
  }

  if (fileLegacy.kind === 'error') {
    purchasePluginSourceContextMemory = {};
    return purchasePluginSourceContextMemory;
  }
  if (fileLegacy.kind === 'invalid') {
    purchasePluginSourceContextMemory = {};
    return purchasePluginSourceContextMemory;
  }
  const legacyStore = fileLegacy.kind === 'valid' ? fileLegacy.store : null;
  if (!legacyStore || !hasContext(legacyStore)) {
    purchasePluginSourceContextMemory = {};
    return purchasePluginSourceContextMemory;
  }

  return enqueuePurchasePluginContextOperation(async () => {
    // User selection wins over any startup legacy migration that was still
    // reading disk/browser when the new selection was made.
    if (purchasePluginContextRevision !== migrationRevision) return purchasePluginSourceContextMemory || {};
    const saved = await saveProfileSettingAdapter(PROFILE_PURCHASE_PLUGIN_CONTEXT_NAMESPACE, legacyStore, {
      timeoutMs: 30000,
    });
    if (!saved?.setting?.value) throw new Error('local-api 未返回拍单插件上下文。');

    const canonical = await readCanonicalPurchasePluginContext().catch(() => {
      throw new Error('拍单插件上下文回读失败，已保留旧副本。');
    });
    if (!canonical || !storesMatch(canonical, legacyStore)) {
      throw new Error('拍单插件上下文回读不一致，已保留旧副本。');
    }
    if (purchasePluginContextRevision !== migrationRevision) return purchasePluginSourceContextMemory || {};

    purchasePluginSourceContextMemory = canonical.context;
    await scrubMatchingLegacySources({ fileLegacy, canonicalStore: canonical });
    return canonical.context;
  });
}

export function hydratePurchasePluginSourceContextFromLocalFile() {
  if (!activePurchasePluginSourceContextMigration) {
    activePurchasePluginSourceContextMigration = hydratePurchasePluginSourceContextFromLocalFileInternal().finally(() => {
      activePurchasePluginSourceContextMigration = null;
    });
  }
  return activePurchasePluginSourceContextMigration;
}

export function migrateLegacyPurchasePluginSourceContextAtStartup() {
  return hydratePurchasePluginSourceContextFromLocalFile();
}

/** Optimistic state stays in memory; normal saves never write the retired JSON file. */
export function savePurchasePluginSourceContext(context) {
  const nextStore = normalizePurchasePluginSourceContextStore({
    context,
    updatedAt: context?.updatedAt || context?.lockedAt || new Date().toISOString(),
  });
  const ownerId = normalizePurchasePluginOwnerId(nextStore.context?.shopId);
  if (
    ownerId
    && isOzonShopGenerationFenced(
      nextStore.context,
      getPurchasePluginFencedOwnerScopes().map((entry) => entry.scope),
    )
  ) {
    throw new Error('ACCOUNT_REMOVAL_OWNER_FENCED');
  }
  const purchaseAccountId = normalizePurchasePluginOwnerId(nextStore.context?.purchaseAccountId);
  if (purchaseAccountId && getPurchasePluginFencedAccountIds().includes(purchaseAccountId)) {
    throw new Error('ACCOUNT_REMOVAL_OWNER_FENCED');
  }
  const revision = purchasePluginContextRevision + 1;
  purchasePluginContextRevision = revision;
  purchasePluginSourceContextMemory = nextStore.context;
  const operation = enqueuePurchasePluginContextOperation(async () => {
    const saved = await saveProfileSettingAdapter(PROFILE_PURCHASE_PLUGIN_CONTEXT_NAMESPACE, nextStore, {
      timeoutMs: 30000,
    });
    if (!saved?.setting?.value) throw new Error('local-api 未返回拍单插件上下文。');
    const canonical = await readCanonicalPurchasePluginContext();
    if (!canonical || !storesMatch(canonical, nextStore)) {
      throw new Error('拍单插件上下文常规保存回读不一致。');
    }
    if (purchasePluginContextRevision === revision) purchasePluginSourceContextMemory = canonical.context;
    return canonical.context;
  });
  operation.catch((error) => {
    safeWarn('[拍单插件上下文] local-api 保存失败', error);
  });
  return nextStore.context;
}

/** Returns the real latest operation result; tests can assert failure instead of observing a swallowed queue tail. */
export function flushPurchasePluginContextWritesForTest() {
  return lastPurchasePluginContextOperation;
}
