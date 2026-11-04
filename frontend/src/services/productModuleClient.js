import { requestLocalApi } from '../api/localApiClient.js';

import { getProductSourceLinks, importLegacyProductSourceLinks } from '../api/localApiClient.js';
import { getProductMaterialProfiles, importLegacyProductMaterialProfiles } from '../api/localApiClient.js';
import { readEveryCursorPage } from './legacyCursorReadback.js';

function createQueryString(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export function readProductSupport(query = {}, options = {}) {
  return requestLocalApi(`/api/products/support${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

function normalizeMaterialNumber(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : '';
}

function getMaterialProfileLocalKey(profile = {}) {
  const shopId = String(profile.shopId ?? profile.shop_id ?? '').trim();
  const productKey = String(
    profile.offerId ?? profile.offer_id ?? profile.productId ?? profile.product_id ?? profile.ozonSku ?? profile.sku ?? profile.productKey ?? profile.key ?? ''
  ).trim();
  return shopId && productKey ? `${shopId}:${productKey}` : '';
}

function mapLocalApiMaterialProfiles(rows = []) {
  return (Array.isArray(rows) ? rows : []).reduce((profiles, profile) => {
    const key = getMaterialProfileLocalKey(profile);
    if (!key) return profiles;
    const next = {
      ...profile,
      key,
      shopId: String(profile.shopId ?? profile.shop_id ?? '').trim(),
      weight: normalizeMaterialNumber(profile.weight ?? profile.weightKg ?? profile.weight_kg),
      length: normalizeMaterialNumber(profile.length ?? profile.depthCm ?? profile.depth_cm),
      width: normalizeMaterialNumber(profile.width ?? profile.widthCm ?? profile.width_cm),
      height: normalizeMaterialNumber(profile.height ?? profile.heightCm ?? profile.height_cm),
      updatedAt: profile.updatedAt ?? profile.updated_at ?? '',
    };
    const current = profiles[key];
    const currentRank = Number(current?.sourceRank ?? current?.source_rank) || 0;
    const nextRank = Number(next.sourceRank ?? next.source_rank) || 0;
    const currentTime = Date.parse(current?.updatedAt || '') || 0;
    const nextTime = Date.parse(next.updatedAt || '') || 0;
    if (!current || nextRank > currentRank || (nextRank === currentRank && nextTime >= currentTime)) profiles[key] = next;
    return profiles;
  }, {});
}

function getProductSourceLinkLocalKey(link = {}) {
  const shopId = String(link.shopId ?? link.shop_id ?? '').trim();
  const rawProductKey = String(link.productKey ?? link.product_key ?? link.offerId ?? link.offer_id ?? '').trim();
  const productKey = shopId && rawProductKey.startsWith(`${shopId}:`) ? rawProductKey.slice(shopId.length + 1) : rawProductKey;
  return shopId && productKey ? `${shopId}:${productKey}` : '';
}

function firstProductSourceIdentityValue(links = [], fields = []) {
  for (const link of links) {
    for (const field of fields) {
      const value = String(link?.[field] ?? '').trim();
      if (value) return value;
    }
  }
  return '';
}

function addProductSourceIdentityAlias(aliases, value, prefix = '') {
  const normalized = String(value ?? '').trim();
  if (!normalized) return;
  aliases.add(normalized);
  if (prefix) aliases.add(`${prefix}:${normalized}`);
  const prefixedIdentity = normalized.match(/^(?:product|offer|sku):(.+)$/i)?.[1]?.trim();
  if (prefixedIdentity) aliases.add(prefixedIdentity);
}

function getProductSourceIdentityAliases(record = {}) {
  const aliases = new Set();
  addProductSourceIdentityAlias(aliases, record.productKey);
  addProductSourceIdentityAlias(aliases, record.ozonProductId, 'product');
  addProductSourceIdentityAlias(aliases, record.offerId, 'offer');
  addProductSourceIdentityAlias(aliases, record.sku, 'sku');
  return [...aliases];
}

function shouldReplaceProductSourceAlias(current, next) {
  if (!current) return true;
  const currentTime = Date.parse(current.updatedAt || '') || 0;
  const nextTime = Date.parse(next.updatedAt || '') || 0;
  if (nextTime !== currentTime) return nextTime > currentTime;
  return (next.links?.length || 0) > (current.links?.length || 0);
}

function mapLocalApiProductSourceLinks(rows = []) {
  const grouped = new Map();
  (Array.isArray(rows) ? rows : []).forEach((link) => {
    const key = getProductSourceLinkLocalKey(link);
    if (!key) return;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(link);
  });
  const normalizedRecords = Array.from(grouped.entries()).map(([key, links]) => {
    const sorted = [...links].sort(
      (left, right) => (Number(left.slotIndex ?? left.slot_index) || 0) - (Number(right.slotIndex ?? right.slot_index) || 0)
    );
    const primaryIndex = Math.max(
      0,
      sorted.findIndex((link) => link.isPrimary || link.is_primary)
    );
    const shopId = firstProductSourceIdentityValue(sorted, ['shopId', 'shop_id']);
    const storedProductKey = firstProductSourceIdentityValue(sorted, ['productKey', 'product_key']);
    const productKey = storedProductKey || (shopId && key.startsWith(`${shopId}:`) ? key.slice(shopId.length + 1) : key);
    return {
      shopId,
      productKey: shopId && productKey.startsWith(`${shopId}:`) ? productKey.slice(shopId.length + 1) : productKey,
      ozonProductId: firstProductSourceIdentityValue(sorted, ['ozonProductId', 'ozon_product_id']),
      offerId: firstProductSourceIdentityValue(sorted, ['offerId', 'offer_id']),
      sku: firstProductSourceIdentityValue(sorted, ['sku', 'skuId', 'sku_id']),
      links: sorted.map((link) => ({
        slotIndex: Number(link.slotIndex ?? link.slot_index) || 0,
        link: link.link ?? link.url ?? '',
        productId: link.sourceProductId ?? link.source_product_id ?? link.productId ?? '',
        platform: link.platform ?? '',
        title: link.title ?? '',
        imageUrl:
          link.imageUrl ??
          link.image_url ??
          link.previewImageUrl ??
          link.preview_image_url ??
          link.originalImageUrl ??
          link.original_image_url ??
          '',
        previewImageUrl: link.previewImageUrl ?? link.preview_image_url ?? '',
        originalImageUrl: link.originalImageUrl ?? link.original_image_url ?? '',
        priceValue: link.priceValue ?? link.price_value,
        price: link.priceValue ?? link.price_value ?? '',
        currencyCode: link.currencyCode ?? link.currency_code ?? '',
        qty: link.qty ?? '',
        savedAt: link.updatedAt ?? link.updated_at ?? link.savedAt ?? '',
      })),
      primaryIndex,
      updatedAt: sorted.reduce((latest, link) => {
        const next = link.updatedAt ?? link.updated_at ?? link.savedAt ?? '';
        return (Date.parse(next) || 0) >= (Date.parse(latest) || 0) ? next : latest;
      }, ''),
    };
  });
  return normalizedRecords.reduce((records, record) => {
    getProductSourceIdentityAliases(record).forEach((productIdentity) => {
      const key = record.shopId && productIdentity ? `${record.shopId}:${productIdentity}` : '';
      if (key && shouldReplaceProductSourceAlias(records[key], record)) records[key] = record;
    });
    return records;
  }, {});
}

export function readProductMaterialProfilesPageFromLocalApi(query = {}, options = {}) {
  return getProductMaterialProfiles(
    { ...query, cursorMode: 'legacy-migration' },
    options
  );
}

export async function readProductMaterialProfilesFromLocalApi(query = {}, options = {}) {
  const readback = await readEveryCursorPage(
    ({ cursor, limit, cursorMode }) =>
      readProductMaterialProfilesPageFromLocalApi(
        { ...query, cursor, limit, cursorMode },
        options
      ),
    { pageSize: 1000, maxPages: 10000 }
  );
  if (!readback.complete || readback.pageLimitReached) {
    throw new Error(`PRODUCT_MATERIAL_CURSOR_READBACK_INCOMPLETE:${readback.reason || 'UNKNOWN'}`);
  }
  return mapLocalApiMaterialProfiles(readback.rows);
}

export async function readProductSourceLinksFromLocalApi(query = {}, options = {}) {
  const readback = await readEveryCursorPage(
    (pageQuery) => getProductSourceLinks({ ...query, ...pageQuery }, options),
    { pageSize: 1000 },
  );
  if (!readback.complete) {
    const error = new Error(readback.reason || 'PRODUCT_SOURCE_CURSOR_READBACK_INCOMPLETE');
    error.code = 'PRODUCT_SOURCE_CURSOR_READBACK_INCOMPLETE';
    error.readback = readback;
    throw error;
  }
  return mapLocalApiProductSourceLinks(readback.rows);
}

export function readProductSummary(query = {}, options = {}) {
  return requestLocalApi(`/api/products/summary${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function readProductSkuFamily(query = {}, options = {}) {
  return requestLocalApi(`/api/products/sku-family${createQueryString(query)}`, {
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function saveProductMaterialProfileToLocalApi(profile = {}, options = {}) {
  return requestLocalApi('/api/products/material', {
    method: 'POST',
    body: profile,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function importLegacyProductMaterialProfilesToLocalApi(profiles = [], options = {}) {
  return importLegacyProductMaterialProfiles(profiles, options);
}

export function saveProductSourceLinksToLocalApi(payload = {}, options = {}) {
  return requestLocalApi('/api/products/source-links', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export function importLegacyProductSourceLinkRecords(records = [], options = {}) {
  return importLegacyProductSourceLinks(records, options);
}

export function saveProductImageHealthToLocalApi(payload = {}, options = {}) {
  return requestLocalApi('/api/products/image-health', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

export * from './productWriteClient.js';
export * from './productReadClient.js';
