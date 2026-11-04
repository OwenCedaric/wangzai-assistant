import { readProductListCache } from '../../../services/productListSyncClient.js';

import { mergeCollectionProductPublicationResult } from '../lib/collectionProductPublication.js';
import { getCollectionShopId, getCollectionShopName } from '../lib/collectionShopLabel.js';

const OFFER_QUERY_CHUNK_SIZE = 200;
const OFFER_QUERY_CONCURRENCY = 4;

function text(value) {
  return String(value ?? '').trim();
}

function unique(values = []) {
  return [...new Set(values.map(text).filter(Boolean))];
}

function safeOfferPart(value) {
  return text(value).normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '');
}

function historicalOfferAliases(product = {}, sku = {}, index = 0) {
  const productPart = safeOfferPart(product.sourceProductId || product.id || '');
  const skuPart = safeOfferPart(sku.sourceSkuId || sku.source_sku_id || '');
  if (!productPart || !skuPart) return [];
  const unsuffixed = `SPB-${productPart}-${skuPart}`;
  const suffixed = `${unsuffixed}-${String(index + 1).padStart(2, '0')}`.slice(0, 30).replace(/-+$/u, '');
  return unique([unsuffixed, suffixed]);
}

function enabledOfferMatchers(product, draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return [];
  if (!text(draft.updatedAt)) return [];
  return (Array.isArray(draft.skus) ? draft.skus : []).flatMap((sku, index) => {
    if (sku?.enabled === false) return [];
    const offerId = text(sku?.offerId ?? sku?.offer_id);
    if (!offerId) return [];
    return [{ offerId, aliases: unique([offerId, ...historicalOfferAliases(product, sku, index)]) }];
  });
}

function draftTargetsShop(draft, shopId) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return false;
  const uploadShopIds = unique(Array.isArray(draft.uploadShopIds) ? draft.uploadShopIds : []);
  if (uploadShopIds.length) return uploadShopIds.includes(shopId);
  return text(draft.shopId ?? draft.shop_id) === shopId;
}

function listingDraftForShop(product = {}, shopId = '') {
  const savedByShop = product.ozonListingDrafts;
  const scoped = savedByShop && typeof savedByShop === 'object' && !Array.isArray(savedByShop)
    ? savedByShop[shopId]
    : null;
  if (scoped && draftTargetsShop(scoped, shopId)) return scoped;

  const legacy = product.ozonListingDraft;
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return null;
  if (draftTargetsShop(legacy, shopId)) return legacy;
  return null;
}

function verifiedPublicationShopIds(product = {}) {
  return new Set((Array.isArray(product.ozonPublication?.shops) ? product.ozonPublication.shops : [])
    .filter((shop) => shop?.uploaded === true && shop?.readBackVerified !== false)
    .map((shop) => text(shop?.shopId))
    .filter(Boolean));
}

function persistedUploadShopIds(products = []) {
  const ids = new Set();
  const addDraft = (draft, fallbackShopId = '') => {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft) || !text(draft.updatedAt)) return;
    const uploadShopIds = unique(Array.isArray(draft.uploadShopIds) ? draft.uploadShopIds : []);
    const targets = uploadShopIds.length
      ? uploadShopIds
      : [text(draft.shopId ?? draft.shop_id ?? fallbackShopId)].filter(Boolean);
    targets.forEach((shopId) => ids.add(shopId));
  };
  (Array.isArray(products) ? products : []).forEach((product) => {
    const savedByShop = product?.ozonListingDrafts;
    if (savedByShop && typeof savedByShop === 'object' && !Array.isArray(savedByShop)) {
      Object.entries(savedByShop).forEach(([shopId, draft]) => addDraft(draft, shopId));
    }
    addDraft(product?.ozonListingDraft);
  });
  return [...ids];
}

export function collectCollectionProductPublicationCandidates(products = [], shops = []) {
  const providedShops = (Array.isArray(shops) ? shops : [])
    .map((shop) => ({
      shopId: getCollectionShopId(shop),
      shopLabel: getCollectionShopName(shop) || getCollectionShopId(shop),
    }))
    .filter((shop) => shop.shopId);
  const providedById = new Map(providedShops.map((shop) => [shop.shopId, shop]));
  const validShops = unique([
    ...providedShops.map((shop) => shop.shopId),
    ...persistedUploadShopIds(products),
  ]).map((shopId) => providedById.get(shopId) || { shopId, shopLabel: shopId });

  return (Array.isArray(products) ? products : []).flatMap((product) => {
    const productId = text(product?.id);
    if (!productId) return [];
    const verifiedShopIds = verifiedPublicationShopIds(product);
    return validShops.flatMap((shop) => {
      if (verifiedShopIds.has(shop.shopId)) return [];
      const skuMatchers = enabledOfferMatchers(product, listingDraftForShop(product, shop.shopId));
      if (!skuMatchers.length) return [];
      return [{
        productId,
        ...shop,
        skuMatchers,
        offerIds: unique(skuMatchers.flatMap((matcher) => matcher.aliases)),
      }];
    });
  });
}

function chunk(values = [], size = OFFER_QUERY_CHUNK_SIZE) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function runWithConcurrency(tasks = [], concurrency = OFFER_QUERY_CONCURRENCY) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { ok: true, value: await tasks[index]() };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

function shopOfferQueryPlan(candidates = []) {
  const offersByShop = new Map();
  candidates.forEach((candidate) => {
    const offers = offersByShop.get(candidate.shopId) || new Set();
    candidate.offerIds.forEach((offerId) => offers.add(offerId));
    offersByShop.set(candidate.shopId, offers);
  });
  return [...offersByShop.entries()].flatMap(([shopId, offers]) => (
    chunk([...offers]).map((offerIds) => ({ shopId, offerIds }))
  ));
}

function responseOfferIds(response = {}) {
  if (response?.ok === false) throw new Error(text(response?.error?.message) || '商品缓存查询失败');
  return unique((Array.isArray(response?.rows) ? response.rows : [])
    .filter((row) => row?.isStale !== true)
    .map((row) => row?.offerId ?? row?.offer_id));
}

export async function backfillCollectionProductPublications(products = [], shops = [], {
  readProducts = readProductListCache,
  signal,
  now = () => new Date().toISOString(),
} = {}) {
  const candidates = collectCollectionProductPublicationCandidates(products, shops);
  if (!candidates.length) return { patches: [], queryCount: 0 };

  const plan = shopOfferQueryPlan(candidates);
  const results = await runWithConcurrency(plan.map(({ shopId, offerIds }) => async () => {
    const response = await readProducts({
      shopId,
      offerIds: offerIds.join(','),
      pageSize: offerIds.length,
      scope: 'software_all',
      sort: 'stable',
    }, { signal, timeoutMs: 8_000, observe: false });
    return { shopId, offerIds: responseOfferIds(response) };
  }));

  const matchedByShop = new Map();
  const incompleteShops = new Set();
  results.forEach((result, index) => {
    const shopId = plan[index].shopId;
    if (!result?.ok) {
      incompleteShops.add(shopId);
      return;
    }
    const matched = matchedByShop.get(shopId) || new Set();
    result.value.offerIds.forEach((offerId) => matched.add(offerId));
    matchedByShop.set(shopId, matched);
  });

  const candidatesByProduct = new Map();
  candidates.forEach((candidate) => {
    const entries = candidatesByProduct.get(candidate.productId) || [];
    entries.push(candidate);
    candidatesByProduct.set(candidate.productId, entries);
  });

  const updatedAt = now();
  const patches = (Array.isArray(products) ? products : []).flatMap((product) => {
    const entries = candidatesByProduct.get(text(product?.id)) || [];
    const verified = entries.flatMap((candidate) => {
      if (incompleteShops.has(candidate.shopId)) return [];
      const matched = matchedByShop.get(candidate.shopId) || new Set();
      const matchedSkuCount = candidate.skuMatchers.filter((matcher) => (
        matcher.aliases.some((offerId) => matched.has(offerId))
      )).length;
      if (!matchedSkuCount) return [];
      const expectedSkuCount = candidate.skuMatchers.length;
      return [{ ...candidate, matchedSkuCount, expectedSkuCount, completed: matchedSkuCount === expectedSkuCount }];
    });
    if (!verified.length) return [];
    const ozonPublication = mergeCollectionProductPublicationResult(product.ozonPublication, {
      status: verified.length === entries.length && verified.every((candidate) => candidate.completed)
        ? 'completed'
        : 'partial',
      operationId: 'legacy-product-cache-backfill',
      shopResults: verified.map((candidate) => ({
        shopId: candidate.shopId,
        shopLabel: candidate.shopLabel,
        status: candidate.completed ? 'completed' : 'partial',
        completed: candidate.completed,
        matchedSkuCount: candidate.matchedSkuCount,
        expectedSkuCount: candidate.expectedSkuCount,
      })),
    }, updatedAt);
    if (JSON.stringify(ozonPublication) === JSON.stringify(product.ozonPublication)) return [];
    return [{ productId: text(product.id), ozonPublication }];
  });

  return { patches, queryCount: plan.length };
}
