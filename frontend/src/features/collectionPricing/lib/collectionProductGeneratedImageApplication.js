import { normalizeCollectionProductGeneratedImageSelections } from './collectionProductImageHistory.js';

const IMAGE_GROUPS = Object.freeze(['main', 'sku', 'detail']);

function text(value, maximum = 4_000) {
  return String(value ?? '').trim().slice(0, maximum);
}

function unique(values = []) {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))];
}

function normalizeSourceIndex(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function groupSourceRows(product = {}, group = '') {
  if (group === 'sku') {
    return (Array.isArray(product.skuImages) ? product.skuImages : []).map((item) => ({
      imageUrl: text(item?.imageUrl),
      skuId: text(item?.skuId),
    }));
  }
  const values = group === 'detail' ? product.detailImages : product.mainImages;
  return (Array.isArray(values) ? values : []).map((imageUrl) => ({ imageUrl: text(imageUrl), skuId: '' }));
}

function normalizeOriginalSelectionItem(item = {}) {
  return {
    sourceIndex: normalizeSourceIndex(item.sourceIndex),
    sourceImageUrl: text(item.sourceImageUrl || item.imageUrl),
    sourceSkuId: text(item.sourceSkuId || item.skuId, 260),
  };
}

function originalSelectionIdentity(item = {}) {
  const normalized = normalizeOriginalSelectionItem(item);
  return normalized.sourceSkuId
    ? `sku:${normalized.sourceSkuId}:${normalized.sourceImageUrl}`
    : `image:${normalized.sourceImageUrl || normalized.sourceIndex}`;
}

export function normalizeCollectionProductOriginalImageSelections(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(IMAGE_GROUPS.flatMap((group) => {
    const groupValue = source[group];
    const sourceItems = Array.isArray(groupValue) ? groupValue : groupValue?.items;
    const byIdentity = new Map();
    (Array.isArray(sourceItems) ? sourceItems : []).forEach((item) => {
      const normalized = normalizeOriginalSelectionItem(item);
      if (!normalized.sourceImageUrl) return;
      byIdentity.set(originalSelectionIdentity(normalized), normalized);
    });
    const items = [...byIdentity.values()].sort((left, right) => left.sourceIndex - right.sourceIndex);
    return items.length ? [[group, { items }]] : [];
  }));
}

export function withCollectionProductOriginalImageSelection(value = {}, input = {}) {
  const current = normalizeCollectionProductOriginalImageSelections(value);
  const group = IMAGE_GROUPS.includes(input.group) ? input.group : 'main';
  const item = normalizeOriginalSelectionItem(input);
  if (!item.sourceImageUrl) return current;
  const identity = originalSelectionIdentity(item);
  const existing = current[group]?.items || [];
  const items = input.selected === false
    ? existing.filter((candidate) => originalSelectionIdentity(candidate) !== identity)
    : [...existing.filter((candidate) => originalSelectionIdentity(candidate) !== identity), item]
      .sort((left, right) => left.sourceIndex - right.sourceIndex);
  const next = { ...current };
  if (items.length) next[group] = { items };
  else delete next[group];
  return next;
}

export function isCollectionProductOriginalImageSelected(value = {}, input = {}) {
  const group = IMAGE_GROUPS.includes(input.group) ? input.group : 'main';
  const identity = originalSelectionIdentity(input);
  return (normalizeCollectionProductOriginalImageSelections(value)[group]?.items || [])
    .some((candidate) => originalSelectionIdentity(candidate) === identity);
}

function resolveOriginalSelectionItems(value = {}, product = {}, group = '') {
  const rows = groupSourceRows(product, group);
  return (normalizeCollectionProductOriginalImageSelections(value)[group]?.items || []).flatMap((item) => {
    let index = -1;
    if (item.sourceSkuId) {
      index = rows.findIndex((row) => row.skuId === item.sourceSkuId && (!item.sourceImageUrl || row.imageUrl === item.sourceImageUrl));
      if (index < 0) index = rows.findIndex((row) => row.skuId === item.sourceSkuId);
    }
    if (index < 0 && item.sourceImageUrl) index = rows.findIndex((row) => row.imageUrl === item.sourceImageUrl);
    if (index < 0 && rows[item.sourceIndex]?.imageUrl === item.sourceImageUrl) index = item.sourceIndex;
    if (index < 0) return [];
    return [{
      sourceIndex: index,
      sourceImageUrl: rows[index].imageUrl,
      sourceSkuId: rows[index].skuId,
    }];
  });
}

function selectedImageUrl(item = {}) {
  return text(item.imageUrl || item.previewUrl);
}

// Ozon receives only two explicit sources:
// 1. every active generated image (generated images are upload-ready by default),
// 2. supplier/source images explicitly checked by the user.
// Raw 1688 images in draft.images and per-SKU imageUrl are never a fallback.
export function applyCollectionProductGeneratedImagesToListingDraft(
  draft = {},
  selections = {},
  product = {},
) {
  const generatedSelections = normalizeCollectionProductGeneratedImageSelections(selections);
  const originalSelections = normalizeCollectionProductOriginalImageSelections(draft.originalImageSelections);
  const generatedUrlsByGroup = { main: [], sku: [], detail: [] };
  const originalUrlsByGroup = { main: [], sku: [], detail: [] };
  const generatedSkuBySourceSkuId = new Map();
  const originalSkuBySourceSkuId = new Map();

  for (const group of IMAGE_GROUPS) {
    const sourceRows = groupSourceRows(product, group);
    for (const item of generatedSelections[group]?.items || []) {
      const generatedUrl = selectedImageUrl(item);
      if (!generatedUrl) continue;
      generatedUrlsByGroup[group].push(generatedUrl);
      if (group === 'sku') {
        const sourceSkuId = text(item.sourceSkuId || sourceRows[Number(item.sourceIndex)]?.skuId, 260);
        if (sourceSkuId) generatedSkuBySourceSkuId.set(sourceSkuId, generatedUrl);
      }
    }
    for (const item of resolveOriginalSelectionItems(originalSelections, product, group)) {
      originalUrlsByGroup[group].push(item.sourceImageUrl);
      if (group === 'sku' && item.sourceSkuId) originalSkuBySourceSkuId.set(item.sourceSkuId, item.sourceImageUrl);
    }
  }

  const images = unique([
    ...generatedUrlsByGroup.main,
    ...originalUrlsByGroup.main,
    ...generatedUrlsByGroup.sku,
    ...originalUrlsByGroup.sku,
    ...generatedUrlsByGroup.detail,
    ...originalUrlsByGroup.detail,
  ]).slice(0, 30);
  const skus = (Array.isArray(draft.skus) ? draft.skus : []).map((sku) => {
    const sourceSkuId = text(sku.sourceSkuId || sku.id, 260);
    return {
      ...sku,
      imageUrl: generatedSkuBySourceSkuId.get(sourceSkuId)
        || originalSkuBySourceSkuId.get(sourceSkuId)
        || '',
    };
  });

  return {
    ...draft,
    images,
    skus,
    originalImageSelections: originalSelections,
    generatedImageSelections: generatedSelections,
  };
}
