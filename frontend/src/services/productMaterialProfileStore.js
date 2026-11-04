import { settleOwnerWriteDrain } from './ownerWriteDrain.js';
import { readEveryCursorPage } from './legacyCursorReadback.js';
import { retryTransientLocalApiWrite } from './localApiTransientWriteRetry.js';

export const LOCAL_PRODUCT_MATERIAL_FILE_KEY = 'product-material-profiles';

export const PRODUCT_MATERIAL_SOURCE_CROSS_BORDER = 'cross-border-bus';
export const PRODUCT_MATERIAL_SOURCE_SUPPLIER = 'supplier-confirmed';
export const PRODUCT_MATERIAL_SOURCE_OZON_INITIAL = 'ozon-initial-read';
export const PRODUCT_MATERIAL_SOURCE_MISSING = 'missing';

export const productMaterialSourceMeta = {
  [PRODUCT_MATERIAL_SOURCE_CROSS_BORDER]: { label: '跨境巴士实测', tone: 'cross-border' },
  [PRODUCT_MATERIAL_SOURCE_SUPPLIER]: { label: '上游提供', tone: 'supplier' },
  [PRODUCT_MATERIAL_SOURCE_OZON_INITIAL]: { label: 'Ozon首次读取', tone: 'ozon-initial' },
  [PRODUCT_MATERIAL_SOURCE_MISSING]: { label: '缺材积', tone: 'missing' },
};

export const editableProductMaterialSourceOptions = [
  PRODUCT_MATERIAL_SOURCE_OZON_INITIAL,
  PRODUCT_MATERIAL_SOURCE_SUPPLIER,
  PRODUCT_MATERIAL_SOURCE_MISSING,
];

let productMaterialProfileMemory = null;
let readLocalDataFileAdapter = async () => ({});
let writeLocalDataFileAdapter = async () => undefined;
let readProfilesFromLocalApiAdapter = async () => ({});
let readProfilesPageFromLocalApiAdapter = async () => ({
  rows: [],
  total: 0,
  hasMore: false,
  nextCursor: '',
});
let saveProfileToLocalApiAdapter = async () => undefined;
let importProfilesToLocalApiAdapter = async () => undefined;
let productMaterialProfileLocalApiWriteQueue = Promise.resolve();
const productMaterialProfileLocalApiHashes = new Map();
const productMaterialProfileFencedShopIds = new Set();
const productMaterialHydrations = new Set();

function normalizeProductMaterialOwnerId(value) {
  return String(value ?? '').trim();
}

function isProductMaterialOwnerFenced(value) {
  const ownerId = normalizeProductMaterialOwnerId(value);
  return Boolean(ownerId && productMaterialProfileFencedShopIds.has(ownerId));
}

function createProductMaterialOwnerFencedError(ownerId) {
  const error = new Error('ACCOUNT_REMOVAL_OWNER_QUIESCED');
  error.code = 'ACCOUNT_REMOVAL_OWNER_QUIESCED';
  error.ownerId = ownerId;
  return error;
}

export function configureProductMaterialProfileStore({
  readLocalDataFile,
  writeLocalDataFile,
  readProfilesFromLocalApi,
  readProfilesPageFromLocalApi,
  saveProfileToLocalApi,
  importProfilesToLocalApi,
} = {}) {
  if (typeof readLocalDataFile === 'function') readLocalDataFileAdapter = readLocalDataFile;
  if (typeof writeLocalDataFile === 'function') writeLocalDataFileAdapter = writeLocalDataFile;
  if (typeof readProfilesFromLocalApi === 'function') readProfilesFromLocalApiAdapter = readProfilesFromLocalApi;
  if (typeof readProfilesPageFromLocalApi === 'function') readProfilesPageFromLocalApiAdapter = readProfilesPageFromLocalApi;
  if (typeof saveProfileToLocalApi === 'function') saveProfileToLocalApiAdapter = saveProfileToLocalApi;
  if (typeof importProfilesToLocalApi === 'function') importProfilesToLocalApiAdapter = importProfilesToLocalApi;
}

export function resetProductMaterialProfileStoreForTest() {
  productMaterialProfileMemory = null;
  readLocalDataFileAdapter = async () => ({});
  writeLocalDataFileAdapter = async () => undefined;
  readProfilesFromLocalApiAdapter = async () => ({});
  readProfilesPageFromLocalApiAdapter = async () => ({ rows: [], total: 0, hasMore: false, nextCursor: '' });
  saveProfileToLocalApiAdapter = async () => undefined;
  importProfilesToLocalApiAdapter = async () => undefined;
  productMaterialProfileLocalApiWriteQueue = Promise.resolve();
  productMaterialProfileLocalApiHashes.clear();
  productMaterialProfileFencedShopIds.clear();
}

export async function fenceAndDrainProductMaterialProfileWrites(shopId) {
  const ownerId = normalizeProductMaterialOwnerId(shopId);
  if (!ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  productMaterialProfileFencedShopIds.add(ownerId);
  const pendingHydrations = [...productMaterialHydrations];
  pendingHydrations.forEach(task => task.excludedOwnerIds.add(ownerId));
  const drain = await settleOwnerWriteDrain([
    productMaterialProfileLocalApiWriteQueue, ...pendingHydrations.map(task => task.promise),
  ]);
  return { ownerId, fenced: true, ...drain };
}

export function releaseProductMaterialProfileOwnerFence(shopId) {
  return productMaterialProfileFencedShopIds.delete(normalizeProductMaterialOwnerId(shopId));
}

export function countProductMaterialProfilesForShop(shopId) {
  const ownerId = normalizeProductMaterialOwnerId(shopId);
  if (!ownerId || !productMaterialProfileMemory || typeof productMaterialProfileMemory !== 'object') return 0;
  return Object.values(productMaterialProfileMemory).filter(
    (profile) => normalizeProductMaterialOwnerId(profile?.shopId ?? profile?.shop_id) === ownerId,
  ).length;
}

export function removeProductMaterialProfilesForShop(shopId) {
  const ownerId = normalizeProductMaterialOwnerId(shopId);
  if (!ownerId) throw new Error('ACCOUNT_REMOVAL_OWNER_ID_REQUIRED');
  const current = productMaterialProfileMemory && typeof productMaterialProfileMemory === 'object'
    ? productMaterialProfileMemory
    : {};
  const removedKeys = [];
  const remaining = Object.fromEntries(Object.entries(current).filter(([key, profile]) => {
    const matches = normalizeProductMaterialOwnerId(profile?.shopId ?? profile?.shop_id) === ownerId;
    if (matches) removedKeys.push(key);
    return !matches;
  }));
  productMaterialProfileMemory = remaining;
  removedKeys.forEach((key) => productMaterialProfileLocalApiHashes.delete(key));
  return { ownerId, removedCount: removedKeys.length, remainingCount: Object.keys(remaining).length };
}

function normalizeOzonId(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  return text && text !== '0' && text !== 'undefined' && text !== 'null' ? text : '';
}

function toFiniteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(
    String(value)
      .replace(/[^\d.,-]/g, '')
      .replace(',', '.')
  );
  return Number.isFinite(number) ? number : null;
}

function cleanDecimal(value) {
  const number = toFiniteNumber(value);
  return number === null ? '' : String(number);
}

function getLocalRecordTimestamp(record) {
  if (!record || typeof record !== 'object') return 0;
  const raw = record.updatedAt || record.savedAt || record.ozonSyncedAt || '';
  const time = Date.parse(raw);
  return Number.isFinite(time) ? time : 0;
}

function mergeLocalRecordMaps(current = {}, incoming = {}) {
  const next = { ...(incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {}) };
  Object.entries(current && typeof current === 'object' && !Array.isArray(current) ? current : {}).forEach(
    ([key, value]) => {
      const existing = next[key];
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        next[key] = value;
        return;
      }
      next[key] = getLocalRecordTimestamp(value) >= getLocalRecordTimestamp(existing) ? value : existing;
    }
  );
  return next;
}

function getCanonicalMaterialProfileKey(profile = {}) {
  const shopId = normalizeOzonId(profile.shopId ?? profile.shop_id);
  let productKey = normalizeOzonId(
    profile.offerId ??
      profile.offer_id ??
      profile.productId ??
      profile.product_id ??
      profile.ozonSku ??
      profile.sku ??
      profile.productKey ??
      profile.product_key ??
      profile.key
  );
  if (shopId && productKey.startsWith(`${shopId}:`)) productKey = productKey.slice(shopId.length + 1);
  return shopId && productKey ? `${shopId}:${productKey}` : '';
}

function mapCanonicalMaterialProfileRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).reduce((profiles, profile) => {
    const key = getCanonicalMaterialProfileKey(profile);
    if (!key) return profiles;
    const current = profiles[key];
    const currentRank = Number(current?.sourceRank ?? current?.source_rank) || 0;
    const nextRank = Number(profile?.sourceRank ?? profile?.source_rank) || 0;
    if (!current || nextRank > currentRank || (nextRank === currentRank && getLocalRecordTimestamp(profile) >= getLocalRecordTimestamp(current))) {
      profiles[key] = { ...profile, key };
    }
    return profiles;
  }, {});
}

async function readEveryProductMaterialProfilePage() {
  const page = await readEveryCursorPage(
    ({ cursor, limit, cursorMode }) =>
      readProfilesPageFromLocalApiAdapter({ cursor, limit, cursorMode }, { timeoutMs: 30000 }),
    { pageSize: 1000, maxPages: 10000 }
  );
  return {
    ...page,
    profiles: page.complete ? mapCanonicalMaterialProfileRows(page.rows) : {},
  };
}

export function readProductMaterialProfiles() {
  if (productMaterialProfileMemory && typeof productMaterialProfileMemory === 'object') {
    return productMaterialProfileMemory;
  }
  return {};
}

export function withReadonlyProductMaterialProfiles(snapshot, work) {
  if (typeof work !== 'function' || Object.prototype.toString.call(work) === '[object AsyncFunction]') throw new Error('MATERIAL_SNAPSHOT_SYNC_REQUIRED');
  const previous = productMaterialProfileMemory;
  productMaterialProfileMemory = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
  try {
    const value = work();
    if (value && typeof value.then === 'function') throw new Error('MATERIAL_SNAPSHOT_SYNC_REQUIRED');
    return value;
  } finally { productMaterialProfileMemory = previous; }
}

export function saveProductMaterialProfiles(profiles) {
  const sourceProfiles = profiles && typeof profiles === 'object' && !Array.isArray(profiles) ? profiles : {};
  const safeProfiles = Object.fromEntries(Object.entries(sourceProfiles).filter(([, profile]) => (
    !isProductMaterialOwnerFenced(profile?.shopId ?? profile?.shop_id)
  )));
  productMaterialProfileMemory = safeProfiles;
  return safeProfiles;
}

function eligibleHydrationProfiles(profiles, task) {
  return Object.fromEntries(Object.entries(profiles || {}).filter(([, profile]) => {
    const ownerId = normalizeProductMaterialOwnerId(profile?.shopId ?? profile?.shop_id);
    return !task.excludedOwnerIds.has(ownerId) && !isProductMaterialOwnerFenced(ownerId);
  }));
}

async function hydrateProductMaterialProfiles(task) {
  const [fileProfiles, sqliteProfiles] = await Promise.all([
    readLocalDataFileAdapter(LOCAL_PRODUCT_MATERIAL_FILE_KEY).catch(() => ({})),
    readProfilesFromLocalApiAdapter().catch(() => ({})),
  ]);
  const mergedProfiles = mergeLocalRecordMaps(fileProfiles, sqliteProfiles);
  // A deletion barrier permanently excludes the old owner's response from this
  // hydration, even after that barrier is released for a newly bound account.
  // Preserve newer local values for excluded owners instead of replacing the
  // whole map with the older global snapshot.
  const preserved = Object.fromEntries(Object.entries(readProductMaterialProfiles()).filter(([, profile]) => (
    task.excludedOwnerIds.has(normalizeProductMaterialOwnerId(profile?.shopId ?? profile?.shop_id))
  )));
  saveProductMaterialProfiles({ ...eligibleHydrationProfiles(mergedProfiles, task), ...preserved });
  const legacyKeys = Object.keys(fileProfiles);
  if (!legacyKeys.length) return eligibleHydrationProfiles(mergedProfiles, task);
  const migrationProfiles = legacyKeys.reduce((next, key) => {
    if (!sqliteProfiles[key] || mergedProfiles[key] === fileProfiles[key]) next[key] = mergedProfiles[key];
    return next;
  }, {});
  const migration = await saveProductMaterialProfilesToLocalApi(eligibleHydrationProfiles(migrationProfiles, task));
  if (migration.failedKeys.length) {
    // Keep an actionable, value-free signal when migration intentionally
    // retains its legacy copy. Profile identifiers and contents stay out of logs.
    console.warn('[商品材积] SQLite 迁移未完成，已保留旧副本', {
      failedCount: migration.failedKeys.length,
      attemptedCount: Object.keys(migrationProfiles).length,
    });
    return eligibleHydrationProfiles(mergedProfiles, task);
  }
  const useCursorReadback = legacyKeys.length > 1;
  const cursorReadback = useCursorReadback
    ? await readEveryProductMaterialProfilePage().catch(() => ({ complete: false, profiles: {} }))
    : null;
  const canonicalReadback = useCursorReadback
    ? cursorReadback.profiles
    : await readProfilesFromLocalApiAdapter().catch(() => ({}));
  const canonicalReadbackMatches = useCursorReadback
    ? hasCompleteProductMaterialCursorReadback(fileProfiles, cursorReadback)
    : legacyKeys.every((key) => materialProfileReadbackMatches(fileProfiles[key], canonicalReadback[key], key));
  if (canonicalReadbackMatches && task.excludedOwnerIds.size === 0) {
    await writeLocalDataFileAdapter(LOCAL_PRODUCT_MATERIAL_FILE_KEY, {}).catch(() => undefined);
  }
  return eligibleHydrationProfiles(mergedProfiles, task);
}

export function hydrateProductMaterialProfilesFromLocalFile() {
  const task = { excludedOwnerIds: new Set(productMaterialProfileFencedShopIds), promise: null };
  productMaterialHydrations.add(task);
  task.promise = Promise.resolve().then(() => hydrateProductMaterialProfiles(task))
    .finally(() => productMaterialHydrations.delete(task));
  return task.promise;
}

const MATERIAL_PROFILE_READBACK_FIELD_ALIASES = Object.freeze({
  key: ['key'],
  shopId: ['shopId', 'shop_id'],
  productKey: ['productKey', 'product_key'],
  productId: ['productId', 'product_id'],
  offerId: ['offerId', 'offer_id'],
  ozonSku: ['ozonSku', 'sku', 'sku_id', 'skuId'],
  source: ['source', 'materialSource', 'sourceType'],
  sourceRank: ['sourceRank', 'source_rank'],
  weight: ['weight', 'weightKg', 'weight_kg'],
  length: ['length', 'depthCm', 'depth_cm', 'depth'],
  width: ['width', 'widthCm', 'width_cm'],
  height: ['height', 'heightCm', 'height_cm'],
  applyToProduct: ['applyToProduct', 'apply_to_product'],
  isConfirmed: ['isConfirmed', 'is_confirmed'],
  ozonSyncedAt: ['ozonSyncedAt', 'ozon_synced_at'],
  ozonSyncStatus: ['ozonSyncStatus', 'ozon_sync_status'],
  ozonSyncTaskId: ['ozonSyncTaskId', 'ozon_sync_task_id'],
  sourceOrderId: ['sourceOrderId', 'source_order_id'],
  sourceOrderNumber: ['sourceOrderNumber', 'source_order_number'],
  sourcePurchaseOrderNumber: ['sourcePurchaseOrderNumber', 'source_purchase_order_number'],
});

const MATERIAL_PROFILE_TRANSIENT_FIELDS = new Set(['updatedAt', 'updated_at', 'savedAt']);
const MATERIAL_PROFILE_KNOWN_LEGACY_FIELDS = new Set([
  ...Object.values(MATERIAL_PROFILE_READBACK_FIELD_ALIASES).flat(),
  ...MATERIAL_PROFILE_TRANSIENT_FIELDS,
]);

function hasOwnAny(source = {}, fields = []) {
  return fields.some((field) => Object.prototype.hasOwnProperty.call(source, field));
}

function firstProfileFieldValue(source = {}, fields = []) {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) return source[field];
  }
  return undefined;
}

function normalizeMaterialReadbackValue(field, value, fallbackKey = '') {
  if (field === 'key') return String(value || fallbackKey).trim();
  if (['weight', 'length', 'width', 'height'].includes(field)) return cleanDecimal(value) || '';
  if (field === 'sourceRank') return String(Number(value) || 0);
  if (['applyToProduct', 'isConfirmed'].includes(field)) {
    if (value === undefined || value === null || value === '') return '';
    return value === false || value === 0 || String(value).toLowerCase() === 'false' ? 'false' : 'true';
  }
  return value === undefined || value === null ? '' : String(value).trim();
}

function hasUnsupportedMaterialProfileData(profile = {}) {
  return Object.entries(profile).some(([field, value]) => {
    if (MATERIAL_PROFILE_KNOWN_LEGACY_FIELDS.has(field)) return false;
    return value !== undefined && value !== null && value !== '';
  });
}

function materialProfileReadbackMatches(legacyProfile = {}, canonicalProfile = {}, fallbackKey = '') {
  if (!legacyProfile || typeof legacyProfile !== 'object' || Array.isArray(legacyProfile)) return false;
  if (!canonicalProfile || typeof canonicalProfile !== 'object' || Array.isArray(canonicalProfile)) return false;
  if (hasUnsupportedMaterialProfileData(legacyProfile)) return false;
  return Object.entries(MATERIAL_PROFILE_READBACK_FIELD_ALIASES).every(([field, aliases]) => {
    if (field !== 'key' && !hasOwnAny(legacyProfile, aliases)) return true;
    const legacyValue = normalizeMaterialReadbackValue(field, firstProfileFieldValue(legacyProfile, aliases), fallbackKey);
    const canonicalValue = normalizeMaterialReadbackValue(field, firstProfileFieldValue(canonicalProfile, aliases), fallbackKey);
    return legacyValue === canonicalValue;
  });
}

function toMaterialProfileReadbackDigestRow(legacyProfile = {}, canonicalProfile = {}, fallbackKey = '') {
  const fields = Object.entries(MATERIAL_PROFILE_READBACK_FIELD_ALIASES).reduce((output, [field, aliases]) => {
    if (field !== 'key' && !hasOwnAny(legacyProfile, aliases)) return output;
    output[field] = normalizeMaterialReadbackValue(
      field,
      firstProfileFieldValue(canonicalProfile, aliases),
      fallbackKey
    );
    return output;
  }, {});
  return { key: fallbackKey, fields };
}

function toLegacyMaterialProfileDigestRow(legacyProfile = {}, fallbackKey = '') {
  const fields = Object.entries(MATERIAL_PROFILE_READBACK_FIELD_ALIASES).reduce((output, [field, aliases]) => {
    if (field !== 'key' && !hasOwnAny(legacyProfile, aliases)) return output;
    output[field] = normalizeMaterialReadbackValue(
      field,
      firstProfileFieldValue(legacyProfile, aliases),
      fallbackKey
    );
    return output;
  }, {});
  return { key: fallbackKey, fields };
}

function hasCompleteProductMaterialCursorReadback(legacyProfiles = {}, page = {}) {
  if (!page?.complete || page?.pageLimitReached || !page?.profiles || typeof page.profiles !== 'object') return false;
  const keys = Object.keys(legacyProfiles).sort();
  if (!Number.isSafeInteger(page.total) || page.total < keys.length) return false;
  if (!keys.every((key) => materialProfileReadbackMatches(legacyProfiles[key], page.profiles[key], key))) return false;
  const expectedRows = keys.map((key) => toLegacyMaterialProfileDigestRow(legacyProfiles[key], key));
  const actualRows = keys.map((key) => toMaterialProfileReadbackDigestRow(legacyProfiles[key], page.profiles[key], key));
  return JSON.stringify(expectedRows) === JSON.stringify(actualRows);
}

function profileHash(profile = {}) {
  return JSON.stringify(profile);
}

export function saveProductMaterialProfilesToLocalApi(profiles = {}) {
  const allEntries = Object.entries(profiles && typeof profiles === 'object' ? profiles : {})
    .map(([key, profile]) => ({ key, profile }))
    .filter(
      ({ key, profile }) => key && profile?.shopId && profile && typeof profile === 'object' && !Array.isArray(profile)
    );
  const fencedEntries = allEntries.filter(({ profile }) => isProductMaterialOwnerFenced(profile.shopId));
  const entries = allEntries.filter(({ profile }) => !isProductMaterialOwnerFenced(profile.shopId));
  productMaterialProfileLocalApiWriteQueue = productMaterialProfileLocalApiWriteQueue
    .catch(() => undefined)
    .then(async () => {
      if (entries.length > 1) {
        try {
          const result = await retryTransientLocalApiWrite(() =>
            importProfilesToLocalApiAdapter(
              entries.map(({ profile }) => profile),
              { timeoutMs: 60000 }
            )
          );
          if (result?.ok === false || Number(result?.importedCount) !== entries.length) {
            throw new Error('PRODUCT_MATERIAL_SQLITE_BULK_IMPORT_FAILED');
          }
          entries.forEach(({ key, profile }) => productMaterialProfileLocalApiHashes.set(key, profileHash(profile)));
          return {
            savedKeys: entries.map(({ key }) => key),
            skippedKeys: [],
            failedKeys: fencedEntries.map(({ key }) => key),
            bulk: true,
          };
        } catch (error) {
          return {
            savedKeys: [],
            skippedKeys: [],
            failedKeys: [...entries, ...fencedEntries].map(({ key }) => key),
            bulk: true,
            error,
          };
        }
      }

      const entry = entries[0];
      if (!entry) {
        return {
          savedKeys: [],
          skippedKeys: [],
          failedKeys: fencedEntries.map(({ key }) => key),
          ...(fencedEntries.length ? { error: createProductMaterialOwnerFencedError(fencedEntries[0].profile.shopId) } : {}),
        };
      }
      const hash = profileHash(entry.profile);
      if (productMaterialProfileLocalApiHashes.get(entry.key) === hash) {
        return { savedKeys: [], skippedKeys: [entry.key], failedKeys: fencedEntries.map(({ key }) => key) };
      }
      try {
        const result = await retryTransientLocalApiWrite(() =>
          saveProfileToLocalApiAdapter(entry.profile, { timeoutMs: 3000 })
        );
        if (result?.ok === false) throw new Error('PRODUCT_MATERIAL_SQLITE_SAVE_FAILED');
        productMaterialProfileLocalApiHashes.set(entry.key, hash);
        return { savedKeys: [entry.key], skippedKeys: [], failedKeys: fencedEntries.map(({ key }) => key) };
      } catch (error) {
        return { savedKeys: [], skippedKeys: [], failedKeys: [entry.key, ...fencedEntries.map(({ key }) => key)], error };
      }
    });
  return productMaterialProfileLocalApiWriteQueue;
}

export function getProductMaterialProfileKey(product = {}, shop = {}) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const productShopKey = shop?.id || shop?.clientId || safeProduct.shopId || safeProduct.shop || 'default';
  const offerId = normalizeOzonId(safeProduct.offerId ?? safeProduct.offer_id);
  const productId = normalizeOzonId(safeProduct.productId ?? safeProduct.product_id ?? safeProduct.id);
  const ozonSku = normalizeOzonId(safeProduct.ozonSku ?? safeProduct.sku);
  const productKey = offerId || productId || ozonSku;
  return productKey ? `${productShopKey}:${productKey}` : '';
}

export function saveProductMaterialProfileCanonical(profile = {}) {
  const ownerId = normalizeProductMaterialOwnerId(profile.shopId ?? profile.shop_id);
  if (!ownerId) return Promise.reject(new Error('PRODUCT_MATERIAL_SHOP_ID_REQUIRED'));
  if (isProductMaterialOwnerFenced(ownerId)) {
    return Promise.reject(createProductMaterialOwnerFencedError(ownerId));
  }
  const key = profile.key || getProductMaterialProfileKey(profile, { id: ownerId });
  if (!key) return Promise.reject(new Error('PRODUCT_MATERIAL_PRODUCT_KEY_REQUIRED'));
  const currentProfiles = readProductMaterialProfiles();
  const nextProfile = {
    ...(currentProfiles[key] ?? {}),
    ...profile,
    key,
    shopId: ownerId,
    updatedAt: new Date().toISOString(),
  };
  productMaterialProfileLocalApiWriteQueue = productMaterialProfileLocalApiWriteQueue
    .catch(() => undefined)
    .then(async () => {
      if (isProductMaterialOwnerFenced(ownerId)) throw createProductMaterialOwnerFencedError(ownerId);
      const result = await retryTransientLocalApiWrite(() =>
        saveProfileToLocalApiAdapter(nextProfile, { timeoutMs: 3000 })
      );
      if (result?.ok !== true) {
        throw new Error(result?.error?.message || 'PRODUCT_MATERIAL_SQLITE_SAVE_FAILED');
      }
      productMaterialProfileLocalApiHashes.set(key, profileHash(nextProfile));
      saveProductMaterialProfiles({ ...readProductMaterialProfiles(), [key]: nextProfile });
      return nextProfile;
    });
  return productMaterialProfileLocalApiWriteQueue;
}

export function saveProductMaterialProfile(profile = {}) {
  const ownerId = normalizeProductMaterialOwnerId(profile.shopId ?? profile.shop_id);
  if (isProductMaterialOwnerFenced(ownerId)) throw createProductMaterialOwnerFencedError(ownerId);
  const key = profile.key || getProductMaterialProfileKey(profile, { id: profile.shopId });
  if (!key) return null;
  const profiles = readProductMaterialProfiles();
  const nextProfile = {
    ...(profiles[key] ?? {}),
    ...profile,
    key,
    updatedAt: new Date().toISOString(),
  };
  profiles[key] = nextProfile;
  saveProductMaterialProfiles(profiles);
  if (nextProfile.shopId) {
    saveProductMaterialProfilesToLocalApi({ [key]: nextProfile });
  } else {
    writeLocalDataFileAdapter(LOCAL_PRODUCT_MATERIAL_FILE_KEY, readProductMaterialProfiles()).catch(() => undefined);
  }
  return nextProfile;
}

export function getProductMaterialProfile(product = {}, shop = {}) {
  const key = getProductMaterialProfileKey(product, shop);
  if (!key) return null;
  return readProductMaterialProfiles()[key] ?? null;
}

export function hasCompleteProductMaterial(product = {}) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  return ['weight', 'length', 'width', 'height'].every((field) => cleanDecimal(safeProduct[field]) !== '');
}

export function getProductMaterialSource(product = {}) {
  const profile = product?.materialProfile;
  const source = String(profile?.source || product?.materialSource || '');
  if (source === PRODUCT_MATERIAL_SOURCE_CROSS_BORDER) return PRODUCT_MATERIAL_SOURCE_CROSS_BORDER;
  if (source === PRODUCT_MATERIAL_SOURCE_SUPPLIER || source === 'manual-confirmed') {
    return PRODUCT_MATERIAL_SOURCE_SUPPLIER;
  }
  if (hasCompleteProductMaterial(profile) || hasCompleteProductMaterial(product)) {
    return PRODUCT_MATERIAL_SOURCE_OZON_INITIAL;
  }
  return PRODUCT_MATERIAL_SOURCE_MISSING;
}

export function getProductMaterialSourceMeta(product = {}) {
  const source = getProductMaterialSource(product);
  return productMaterialSourceMeta[source] ?? productMaterialSourceMeta[PRODUCT_MATERIAL_SOURCE_MISSING];
}

export function canEditProductMaterialFields(source) {
  return source === PRODUCT_MATERIAL_SOURCE_SUPPLIER;
}

export function isProtectedProductMaterialSource(source) {
  return (
    source === PRODUCT_MATERIAL_SOURCE_CROSS_BORDER ||
    source === PRODUCT_MATERIAL_SOURCE_SUPPLIER ||
    source === 'manual-confirmed'
  );
}

export function mergeOzonReadbackMaterial(existingProfile = {}, material = {}) {
  if (!isProtectedProductMaterialSource(existingProfile.source)) return material;
  return {
    weight: cleanDecimal(existingProfile.weight) || material.weight,
    length: cleanDecimal(existingProfile.length) || material.length,
    width: cleanDecimal(existingProfile.width) || material.width,
    height: cleanDecimal(existingProfile.height) || material.height,
  };
}

export function applyProductMaterialProfile(product = {}, shop = {}) {
  if (!product || typeof product !== 'object') return product;
  const profile = getProductMaterialProfile(product, shop) || product.materialProfile;
  if (!profile) return product;
  if (profile.applyToProduct === false) return product;
  const material = {
    weight: profile.weight,
    length: profile.length,
    width: profile.width,
    height: profile.height,
  };
  if (!hasCompleteProductMaterial(material)) return product;
  return {
    ...product,
    ...material,
    materialProfile: profile,
  };
}

export function applyProductMaterialProfiles(products = [], shop = {}) {
  return products.map((product) => applyProductMaterialProfile(product, shop));
}

export function getCompleteProductMaterialFromProduct(product = {}) {
  const material = {
    weight: cleanDecimal(product.weight),
    length: cleanDecimal(product.length),
    width: cleanDecimal(product.width),
    height: cleanDecimal(product.height),
  };
  return hasCompleteProductMaterial(material) ? material : null;
}

export function saveProductMaterialProfileFromOzonSnapshot(product = {}, shop = {}, options = {}) {
  if (!product || typeof product !== 'object') return null;
  const material = getCompleteProductMaterialFromProduct(product);
  if (!material) return null;
  const key = getProductMaterialProfileKey(product, shop);
  if (!key) return null;
  const existingProfile = readProductMaterialProfiles()[key] ?? {};
  const protectedSource = isProtectedProductMaterialSource(existingProfile.source);
  const nextMaterial = mergeOzonReadbackMaterial(existingProfile, material);
  return saveProductMaterialProfile({
    ...existingProfile,
    key,
    shopId: shop.id,
    offerId: product.offerId || existingProfile.offerId || '',
    productId: product.productId || existingProfile.productId || '',
    ozonSku: product.ozonSku || existingProfile.ozonSku || '',
    ...nextMaterial,
    source: protectedSource ? existingProfile.source : options.source || existingProfile.source || 'ozon-readback',
    applyToProduct: true,
    ozonSyncedAt: protectedSource
      ? existingProfile.ozonSyncedAt || options.ozonSyncedAt || ''
      : options.ozonSyncedAt || existingProfile.ozonSyncedAt || '',
    ozonSyncTaskId: protectedSource
      ? existingProfile.ozonSyncTaskId || options.ozonSyncTaskId || ''
      : options.ozonSyncTaskId || existingProfile.ozonSyncTaskId || '',
    ozonSyncStatus: protectedSource
      ? existingProfile.ozonSyncStatus || options.ozonSyncStatus || '已确认来源，Ozon 回读不覆盖'
      : options.ozonSyncStatus || existingProfile.ozonSyncStatus || '已从 Ozon 读取',
  });
}

export function saveProductMaterialProfilesFromOzonRows(products = [], shop = {}, options = {}) {
  return products.map((product) => saveProductMaterialProfileFromOzonSnapshot(product, shop, options)).filter(Boolean);
}

export function saveSupplierProductMaterialProfile(product = {}, shop = {}, form = {}, options = {}) {
  const material = getCompleteProductMaterialFromProduct(form);
  if (!material) return null;
  const key = getProductMaterialProfileKey(product, shop);
  if (!key) return null;
  const existingProfile = readProductMaterialProfiles()[key] ?? {};
  return saveProductMaterialProfile({
    ...existingProfile,
    key,
    shopId: shop.id,
    offerId: product.offerId || existingProfile.offerId || '',
    productId: product.productId || existingProfile.productId || '',
    ozonSku: product.ozonSku || product.sku || existingProfile.ozonSku || '',
    ...material,
    source: PRODUCT_MATERIAL_SOURCE_SUPPLIER,
    applyToProduct: true,
    ozonSyncedAt: options.ozonSyncedAt || existingProfile.ozonSyncedAt || '',
    ozonSyncTaskId: options.ozonSyncTaskId || existingProfile.ozonSyncTaskId || '',
    ozonSyncStatus: options.ozonSyncStatus || existingProfile.ozonSyncStatus || '上游提供',
  });
}

export function saveSupplierProductMaterialProfileCanonical(product = {}, shop = {}, form = {}, options = {}) {
  const material = getCompleteProductMaterialFromProduct(form);
  if (!material) return Promise.reject(new Error('PRODUCT_MATERIAL_FIELDS_REQUIRED'));
  const key = getProductMaterialProfileKey(product, shop);
  if (!key) return Promise.reject(new Error('PRODUCT_MATERIAL_PRODUCT_KEY_REQUIRED'));
  const existingProfile = readProductMaterialProfiles()[key] ?? {};
  return saveProductMaterialProfileCanonical({
    ...existingProfile,
    key,
    shopId: shop.id,
    offerId: product.offerId || existingProfile.offerId || '',
    productId: product.productId || existingProfile.productId || '',
    ozonSku: product.ozonSku || product.sku || existingProfile.ozonSku || '',
    ...material,
    source: PRODUCT_MATERIAL_SOURCE_SUPPLIER,
    applyToProduct: true,
    ozonSyncedAt: options.ozonSyncedAt || existingProfile.ozonSyncedAt || '',
    ozonSyncTaskId: options.ozonSyncTaskId || existingProfile.ozonSyncTaskId || '',
    ozonSyncStatus: options.ozonSyncStatus || existingProfile.ozonSyncStatus || '上游提供',
  });
}
