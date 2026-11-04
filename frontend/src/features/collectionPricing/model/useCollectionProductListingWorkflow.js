import React from 'react';

import { resolveSmartToolModelSelection } from '../../promptLibrary/services/smartToolModelService.js';
import { normalizeSmartToolImageGenerationMode } from '../../promptLibrary/services/smartToolImageGenerationMode.js';
import { COLLECTION_BEIXIONG_AUTOFILL_VERSION } from '../constants/collectionBeixiongAutofillRules.js';
import {
  createCollectionProductListingDraft,
  normalizeCollectionProductListingDrafts,
  repairCollectionProductSkuVariantValues,
  requireManualCollectionProductCategorySelection,
  toCollectionListingCommandDraft,
  validateCollectionProductListingStep,
  withListingDraftTimestamp,
} from '../lib/collectionProductListingWorkflow.js';
import {
  countCollectionProductImageHistoryImages,
  mergeCollectionProductGeneratedImageSelection,
  normalizeCollectionProductGeneratedImageSelections,
  normalizeCollectionProductImageHistoryEntry,
  removeCollectionProductGeneratedImageSelection,
  upsertCollectionProductImageHistory,
  withCollectionProductGeneratedImageItemSelection,
  withCollectionProductGeneratedImageSelection,
} from '../lib/collectionProductImageHistory.js';
import {
  applyCollectionProductGeneratedImagesToListingDraft,
  withCollectionProductOriginalImageSelection,
} from '../lib/collectionProductGeneratedImageApplication.js';
import { splitListingAttributeDefinitions } from '../lib/collectionProductAttributeSchema.js';
import { countFilledProductAttributes } from '../lib/collectionProductAttributeMapper.js';
import { applyCollectionProductManagedDefaults } from '../lib/collectionProductManagedDefaults.js';
import { mergeCollectionProductPublicationResult } from '../lib/collectionProductPublication.js';
import {
  loadCollectionListingAttributeSchema,
  loadCollectionListingCategoryOptions,
  loadCollectionListingCategoryTemplate,
  searchCollectionListingAttributeOptions,
} from '../services/collectionListingCatalogService.js';
import {
  applyCollectionAttributeAutofillResult,
  preloadCollectionAttributeAutofillDictionaryOptions,
  runCollectionAttributeAutofill,
} from '../services/collectionAttributeAutofillService.js';
import { matchCollectedProductAttributes } from '../services/collectionAttributeMatchingService.js';
import {
  buildCollectionProductImageSkillFacts,
  runCollectionProductImageSkillBatch,
} from '../services/collectionProductImageSkillService.js';
import {
  hydrateCollectionProductGeneratedImageSelections,
  persistCollectionProductGeneratedImageSelections,
} from '../services/collectionProductGeneratedImageService.js';
import {
  confirmCollectionListing,
  getCollectionListingErrorMessage,
  releaseCollectionListingPreview,
} from '../services/collectionListingService.js';
import {
  continueCollectionListingsReadBackForShops,
  confirmCollectionListingsForShops,
  normalizeCollectionListingTargetShopIds,
  previewCollectionListingsForShops,
  releaseCollectionListingsForShops,
} from '../services/collectionListingMultiShopService.js';

export const COLLECTION_PRODUCT_LISTING_STEPS = Object.freeze([
  { id: 'setup', label: '类目与属性' },
  { id: 'images', label: '图片生成' },
  { id: 'skus', label: 'SKU/价格' },
  { id: 'preview', label: '上架预览' },
  { id: 'readback', label: '上传回读' },
]);

const EMPTY_ASYNC_STATE = Object.freeze({ status: 'idle', error: '' });
const DETERMINISTIC_ATTRIBUTE_SOURCE_PATTERN = /^(source-|managed-default)/u;

function categoryTemplateOptionKey(option = {}) {
  return [option.descriptionCategoryId, option.typeId].map((item) => String(item || '').trim()).join(':');
}

function countDeterministicAttributeValues(values = {}) {
  return countFilledProductAttributes(Object.fromEntries(
    Object.entries(values || {}).filter(([, value]) => DETERMINISTIC_ATTRIBUTE_SOURCE_PATTERN.test(String(value?.source || ''))),
  ));
}

function removePreviousAutofillValues(values = {}) {
  return Object.fromEntries(Object.entries(values || {}).filter(([, value]) => (
    String(value?.source || '') !== 'ai'
  )));
}

function hasLegacyFakeAutofillValue(values = {}) {
  return Object.values(values || {}).some((value) => {
    if (String(value?.source || '') !== 'ai') return false;
    const rows = [value?.value, ...(Array.isArray(value?.values) ? value.values : [])]
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    return rows.some((item) => /^(?:Стандарт|1\s*год|0\s*месяцев)$/iu.test(item));
  });
}

function draftHasLegacyFakeAutofill(draft = {}) {
  return hasLegacyFakeAutofillValue(draft.attributeValues)
    || (Array.isArray(draft.skus) ? draft.skus : []).some((sku) => (
      hasLegacyFakeAutofillValue(sku.attributeValues)
    ));
}

function resetPreviousAutofillDraft(draft = {}) {
  if (draft.attributeAutofillVersion === COLLECTION_BEIXIONG_AUTOFILL_VERSION) return draft;
  if (!draftHasLegacyFakeAutofill(draft)) {
    return { ...draft, attributeAutofillVersion: COLLECTION_BEIXIONG_AUTOFILL_VERSION };
  }
  return {
    ...draft,
    attributeAutofillVersion: COLLECTION_BEIXIONG_AUTOFILL_VERSION,
    attributeValues: removePreviousAutofillValues(draft.attributeValues),
    skus: (Array.isArray(draft.skus) ? draft.skus : []).map((sku) => ({
      ...sku,
      attributeValues: removePreviousAutofillValues(sku.attributeValues),
    })),
  };
}

function createAttributeAutofillState(changes = {}) {
  return {
    ...EMPTY_ASYNC_STATE,
    message: '',
    warning: '',
    appliedCount: 0,
    appliedAttributeCount: 0,
    appliedTextCount: 0,
    unresolvedCount: 0,
    unresolvedItems: [],
    reviewedAttributeCellCount: 0,
    ...changes,
  };
}

function yieldCollectionAnalysisFrame() {
  return new Promise((resolve) => {
    const finish = () => globalThis.setTimeout(resolve, 0);
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(finish);
      return;
    }
    finish();
  });
}

function collectionAttributeAutofillScopeKey(product = {}, draft = {}) {
  return [
    product?.id || product?.sourceProductId || '',
    draft?.shopId || '',
    draft?.descriptionCategoryId || '',
    draft?.typeId || '',
    ...(Array.isArray(draft?.skus) ? draft.skus.map((item) => item?.sourceSkuId || item?.id || '') : []),
  ].map((item) => String(item || '').trim()).join('::');
}

function mergeGeneratedImageItems(currentItems = [], nextItems = []) {
  const bySourceIndex = new Map((Array.isArray(currentItems) ? currentItems : []).map((item) => [item.sourceIndex, item]));
  (Array.isArray(nextItems) ? nextItems : []).forEach((item) => bySourceIndex.set(item.sourceIndex, item));
  return [...bySourceIndex.values()].sort((left, right) => Number(left.sourceIndex) - Number(right.sourceIndex));
}

function mergeGeneratedHistoryItem(current, next) {
  if (!current) return next;
  const currentRank = current.storageScope === 'permanent' ? 5 : current.assetId ? 4 : current.persistenceStatus === 'completed' ? 3 : current.imageUrl ? 2 : 1;
  const nextRank = next?.storageScope === 'permanent' ? 5 : next?.assetId ? 4 : next?.persistenceStatus === 'completed' ? 3 : next?.imageUrl ? 2 : 1;
  const preferred = nextRank >= currentRank ? next : current;
  const fallback = preferred === next ? current : next;
  return {
    ...fallback,
    ...preferred,
    assetId: preferred?.assetId || fallback?.assetId || '',
    taskId: preferred?.taskId || fallback?.taskId || '',
    imageUrl: preferred?.imageUrl || fallback?.imageUrl || '',
    previewUrl: preferred?.previewUrl || fallback?.previewUrl || '',
    thumbnailUrl: preferred?.thumbnailUrl || fallback?.thumbnailUrl || '',
    sourceSkuId: preferred?.sourceSkuId || fallback?.sourceSkuId || '',
    assetShopId: preferred?.assetShopId || fallback?.assetShopId || '',
    storageScope: preferred?.storageScope || fallback?.storageScope || '',
    persistenceStatus: preferred?.persistenceStatus || fallback?.persistenceStatus || 'pending',
  };
}

function generatedItemsByGroup(value = {}) {
  const selections = normalizeCollectionProductGeneratedImageSelections(value);
  return Object.fromEntries(Object.entries(selections).map(([group, selection]) => [
    group,
    selection.items.map((item) => ({
      ...item,
      status: 'success',
      restoredFromDraft: true,
    })),
  ]));
}

function generationStateFromDraft(draft = {}) {
  const itemsByGroup = generatedItemsByGroup(draft.generatedImageSelections);
  const hasItems = Object.keys(itemsByGroup).length > 0;
  return {
    ...EMPTY_ASYNC_STATE,
    status: hasItems ? 'success' : 'idle',
    phase: hasItems ? 'complete' : '',
    message: '',
    itemsByGroup,
  };
}

function createConfirmedCategoryDraft(product, options) {
  return requireManualCollectionProductCategorySelection(
    createCollectionProductListingDraft(product, options),
  );
}

function normalizeConfirmedCategoryDrafts(value, product) {
  return Object.fromEntries(Object.entries(
    normalizeCollectionProductListingDrafts(value, product),
  ).map(([shopId, savedDraft]) => [
    shopId,
    requireManualCollectionProductCategorySelection(savedDraft),
  ]));
}

function releaseListingPreview(preview) {
  if (!preview) return Promise.resolve({ ok: true, released: 0 });
  return preview.multiShop
    ? releaseCollectionListingsForShops(preview)
    : releaseCollectionListingPreview(preview);
}

function describeUnresolvedAttributeItems(items = [], definitions = [], draft = {}) {
  const definitionById = new Map(definitions.map((item) => [String(item.id), item]));
  const skuById = new Map((draft.skus || []).map((item, index) => [
    String(item.sourceSkuId || item.id || ''),
    item.sourceSkuName || item.offerId || `SKU ${index + 1}`,
  ]));
  return items.slice(0, 100).map((item) => {
    const attributeId = String(item.attributeId || '');
    const definition = definitionById.get(attributeId);
    const sourceSkuId = String(item.sourceSkuId || '');
    return {
      scope: item.scope === 'sku' || sourceSkuId ? 'sku' : 'global',
      sourceSkuId,
      skuLabel: sourceSkuId ? (skuById.get(sourceSkuId) || sourceSkuId) : '',
      attributeId,
      attributeLabel: definition?.name || `属性 ${attributeId}`,
      required: Boolean(definition?.is_required),
      reason: String(item.reason || '来源资料不足，需要人工确认。'),
    };
  });
}

export function useCollectionProductListingWorkflow({
  product,
  shops = [],
  activeShopId = '',
  onPersist,
  textModelOptions = [],
  textModelId = 'auto',
  imageModelOptions = [],
  imageSkill = null,
} = {}) {
  const [draft, setDraft] = React.useState(() => createConfirmedCategoryDraft(product, { shops, activeShopId }));
  const [step, setStepState] = React.useState(() => shops.length ? 'setup' : 'images');
  const [stepError, setStepError] = React.useState('');
  const [categoryOptions, setCategoryOptions] = React.useState([]);
  const [categoryState, setCategoryState] = React.useState({ ...EMPTY_ASYNC_STATE, status: 'loading' });
  const [categoryTemplateState, setCategoryTemplateState] = React.useState({ ...EMPTY_ASYNC_STATE, categoryKey: '', template: null });
  const [definitions, setDefinitions] = React.useState([]);
  const [attributeOptions, setAttributeOptions] = React.useState({});
  const [attributeState, setAttributeState] = React.useState({ ...EMPTY_ASYNC_STATE });
  const [attributeAutofillState, setAttributeAutofillState] = React.useState(() => createAttributeAutofillState());
  const [attributeReloadToken, setAttributeReloadToken] = React.useState(0);
  const [preview, setPreview] = React.useState(null);
  const [listingState, setListingState] = React.useState({ ...EMPTY_ASYNC_STATE, result: null, message: '' });
  const [generationState, setGenerationState] = React.useState(() => generationStateFromDraft(draft));
  const productId = product?.id || '';
  const productRef = React.useRef(product);
  const attributeSearchSequenceRef = React.useRef(new Map());
  const attributeAutofillRunRef = React.useRef(0);
  const attributeAutofillAbortRef = React.useRef(null);
  const attributeAutofillCheckpointRef = React.useRef(null);
  const categoryTemplateAbortRef = React.useRef(null);
  const previewAbortRef = React.useRef(null);
  const previewRunRef = React.useRef(0);
  const previewRef = React.useRef(preview);
  const categoryTemplateRequestRef = React.useRef(0);
  const categoryTemplateStateRef = React.useRef(categoryTemplateState);
  const inlineAttributeSchemaKeyRef = React.useRef('');
  const draftRef = React.useRef(draft);
  const shopsRef = React.useRef(shops);
  const activeShopIdRef = React.useRef(activeShopId);
  const draftsByShopRef = React.useRef(normalizeConfirmedCategoryDrafts(product?.ozonListingDrafts, product));
  productRef.current = product;
  draftRef.current = draft;
  previewRef.current = preview;
  categoryTemplateStateRef.current = categoryTemplateState;
  shopsRef.current = shops;
  activeShopIdRef.current = activeShopId;

  React.useEffect(() => {
    previewRunRef.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    attributeAutofillRunRef.current += 1;
    attributeAutofillAbortRef.current?.abort();
    attributeAutofillAbortRef.current = null;
    attributeAutofillCheckpointRef.current = null;
    categoryTemplateRequestRef.current += 1;
    categoryTemplateAbortRef.current?.abort();
    categoryTemplateAbortRef.current = null;
    categoryTemplateStateRef.current = { ...EMPTY_ASYNC_STATE, categoryKey: '', template: null };
    inlineAttributeSchemaKeyRef.current = '';
    const nextDraft = createConfirmedCategoryDraft(productRef.current, {
      shops: shopsRef.current,
      activeShopId: activeShopIdRef.current,
    });
    const savedDrafts = normalizeConfirmedCategoryDrafts(
      productRef.current?.ozonListingDrafts,
      productRef.current,
    );
    if (nextDraft.shopId) savedDrafts[nextDraft.shopId] = nextDraft;
    draftsByShopRef.current = savedDrafts;
    setDraft(nextDraft);
    setStepState(shopsRef.current.length ? 'setup' : 'images');
    setStepError('');
    setDefinitions([]);
    setCategoryTemplateState({ ...EMPTY_ASYNC_STATE, categoryKey: '', template: null });
    setAttributeOptions({});
    setAttributeAutofillState(createAttributeAutofillState());
    setAttributeReloadToken(0);
    setPreview(null);
    setListingState({ ...EMPTY_ASYNC_STATE, result: null, message: '' });
    setGenerationState(generationStateFromDraft(nextDraft));
  }, [productId]); // Deliberately do not reset while this product's local draft is auto-saved.

  const generatedSelectionHydrationKey = JSON.stringify(Object.entries(draft.generatedImageSelections || {}).map(([group, selection]) => [
    group,
    selection?.historyEntryId || '',
    (selection?.items || []).map((item) => [item.sourceIndex, item.assetId, item.taskId, item.storageScope]),
  ]));

  React.useEffect(() => {
    const activeDraft = draftRef.current;
    const generatedImageSelections = activeDraft.generatedImageSelections || {};
    const shopId = String(activeDraft.shopId || '').trim();
    const activeProduct = productRef.current || {};
    const productKey = String(activeProduct.id || activeProduct.sourceProductId || activeProduct.sourceUrl || '').trim();
    if (!shopId || !productKey || !Object.keys(generatedImageSelections).length) return undefined;
    const abortController = new AbortController();
    hydrateCollectionProductGeneratedImageSelections(generatedImageSelections, {
      shopId,
      signal: abortController.signal,
    }).then((selections) => {
      if (abortController.signal.aborted) return;
      if (String(draftRef.current.shopId || '').trim() !== shopId) return;
      const activeProductKey = String(productRef.current?.id || productRef.current?.sourceProductId || productRef.current?.sourceUrl || '').trim();
      if (activeProductKey !== productKey) return;
      const hydratedItemsByGroup = generatedItemsByGroup(selections);
      setGenerationState((current) => ({
        ...current,
        status: 'success',
        phase: 'complete',
        error: '',
        // Upload checkboxes edit generatedImageSelections, while itemsByGroup
        // is the visible generation result tray.  Merge hydrated private URLs
        // into that tray instead of replacing it, otherwise unchecking one
        // upload image also makes the generated result disappear and changes
        // the unrelated source-image generation scope.
        itemsByGroup: Object.fromEntries([
          ...Object.entries(current.itemsByGroup || {}),
          ...Object.entries(hydratedItemsByGroup).map(([group, items]) => [
            group,
            mergeGeneratedImageItems(current.itemsByGroup?.[group], items),
          ]),
        ]),
      }));
    }).catch((error) => {
      if (error?.name === 'AbortError' || abortController.signal.aborted) return;
      setGenerationState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : '已保存图片读取失败。',
      }));
    });
    return () => abortController.abort();
  }, [draft.shopId, generatedSelectionHydrationKey, productId]);

  React.useEffect(() => () => {
    previewRunRef.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    attributeAutofillRunRef.current += 1;
    attributeAutofillAbortRef.current?.abort();
    attributeAutofillAbortRef.current = null;
    categoryTemplateRequestRef.current += 1;
    categoryTemplateAbortRef.current?.abort();
    categoryTemplateAbortRef.current = null;
  }, []);

  React.useEffect(() => {
    previewRef.current = preview;
    return () => {
      if (preview) void releaseListingPreview(preview);
    };
  }, [preview]);

  React.useEffect(() => {
    if (!productId) return undefined;
    let active = true;
    setCategoryState({ status: 'loading', error: '' });
    loadCollectionListingCategoryOptions()
      .then((items) => {
        if (!active) return;
        setCategoryOptions(items);
        setCategoryState({ status: 'ready', error: '' });
      })
      .catch((error) => {
        if (active) setCategoryState({ status: 'error', error: error instanceof Error ? error.message : 'Ozon 类目读取失败。' });
      });
    return () => { active = false; };
  }, [productId]);

  React.useEffect(() => {
    if (!draft.descriptionCategoryId || !draft.typeId) {
      setDefinitions([]);
      setAttributeOptions({});
      setAttributeState({ ...EMPTY_ASYNC_STATE });
      return undefined;
    }
    const schemaKey = [draft.shopId, draft.descriptionCategoryId, draft.typeId].map((item) => String(item || '')).join('::');
    if (inlineAttributeSchemaKeyRef.current === schemaKey) {
      inlineAttributeSchemaKeyRef.current = '';
      return undefined;
    }
    let active = true;
    const abortController = new AbortController();
    setAttributeState({ status: 'loading', error: '' });
    const loadedTemplate = categoryTemplateStateRef.current?.template;
    const templateMatches = loadedTemplate
      && String(loadedTemplate.shopId) === String(draft.shopId)
      && String(loadedTemplate.descriptionCategoryId) === String(draft.descriptionCategoryId)
      && String(loadedTemplate.typeId) === String(draft.typeId);
    const schemaPromise = templateMatches ? Promise.resolve({
      definitions: loadedTemplate.definitions,
      optionsByAttributeId: loadedTemplate.optionsByAttributeId,
      warning: loadedTemplate.warning,
      source: loadedTemplate.source || 'category-template-cache',
    }) : loadCollectionListingAttributeSchema({
      shopId: draft.shopId,
      descriptionCategoryId: draft.descriptionCategoryId,
      typeId: draft.typeId,
      sourceProduct: productRef.current,
    }, {
      refresh: attributeReloadToken > 0,
      signal: abortController.signal,
    });
    schemaPromise
      .then((result) => {
        if (!active) return;
        const nextDefinitions = result.definitions || [];
        const scopedDefinitions = splitListingAttributeDefinitions(nextDefinitions);
        const nextOptions = result.optionsByAttributeId || {};
        setDefinitions(nextDefinitions);
        setAttributeOptions(nextOptions);
        // Category confirmation only commits the selected Ozon schema. Matching every
        // source fact against every dictionary option belongs to the explicit autofill
        // action; doing it here blocks the close-paint for large SKU matrices.
        const managed = applyCollectionProductManagedDefaults({
          product: productRef.current,
          draft: draftRef.current,
          definitions: scopedDefinitions.global,
          optionsByAttributeId: nextOptions,
          currentValues: draftRef.current.attributeValues,
        });
        if (managed.appliedCount || managed.removedCount) {
          const nextDraft = { ...draftRef.current, attributeValues: managed.values };
          draftRef.current = nextDraft;
          setDraft(nextDraft);
        }
        setAttributeState({
          status: nextDefinitions.length ? 'ready' : 'empty',
          error: '',
          warning: result.warning || '',
          source: result.source || '',
          mappedCount: managed.appliedCount,
          globalCount: scopedDefinitions.global.length,
          skuCount: scopedDefinitions.sku.length,
        });
      })
      .catch((error) => {
        if (!active) return;
        setDefinitions([]);
        setAttributeOptions({});
        setAttributeState({ status: 'error', error: error instanceof Error ? error.message : 'Ozon 属性读取失败。' });
      });
    return () => {
      active = false;
      abortController.abort();
    };
  }, [attributeReloadToken, draft.descriptionCategoryId, draft.shopId, draft.typeId]);

  const reloadAttributes = React.useCallback(() => {
    setAttributeReloadToken((current) => current + 1);
  }, []);

  const searchAttributeOptions = React.useCallback(async (attributeId, search, requestOptions = {}) => {
    const normalizedAttributeId = String(attributeId || '').trim();
    const searchQuery = String(search || '').trim();
    if (!normalizedAttributeId || !draft.shopId || !draft.descriptionCategoryId || !draft.typeId) return [];
    const sequence = (attributeSearchSequenceRef.current.get(normalizedAttributeId) || 0) + 1;
    attributeSearchSequenceRef.current.set(normalizedAttributeId, sequence);
    try {
      const scope = {
        shopId: draft.shopId,
        descriptionCategoryId: draft.descriptionCategoryId,
        typeId: draft.typeId,
        attributeId: normalizedAttributeId,
        search: searchQuery,
      };
      const cachedRows = requestOptions.preferCache
        ? await searchCollectionListingAttributeOptions(scope, {
          signal: requestOptions.signal,
          refresh: false,
        })
        : [];
      const rows = cachedRows.length || requestOptions.cacheOnly
        ? cachedRows
        : await searchCollectionListingAttributeOptions(scope, {
          signal: requestOptions.signal,
          refresh: true,
        });
      if (attributeSearchSequenceRef.current.get(normalizedAttributeId) !== sequence) return rows;
      setAttributeOptions((current) => {
        const merged = new Map((current[normalizedAttributeId] || []).map((item) => [String(item.id), item]));
        rows.forEach((item) => merged.set(String(item.id), item));
        return { ...current, [normalizedAttributeId]: [...merged.values()] };
      });
      return rows;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return [];
    }
  }, [draft.descriptionCategoryId, draft.shopId, draft.typeId]);

  const persistDraft = React.useCallback((candidate) => {
    if (!productId || !candidate?.shopId) return;
    const saved = withListingDraftTimestamp(candidate);
    const nextDrafts = { ...draftsByShopRef.current, [saved.shopId]: saved };
    draftsByShopRef.current = nextDrafts;
    onPersist?.(productId, {
      ozonListingDraft: saved,
      ozonListingDrafts: nextDrafts,
    });
  }, [onPersist, productId]);

  const persistPublicationResult = React.useCallback(async (result) => {
    if (!productId || !result) return null;
    const publication = mergeCollectionProductPublicationResult(
      productRef.current?.ozonPublication,
      result,
    );
    if (!publication) return null;
    productRef.current = { ...productRef.current, ozonPublication: publication };
    await Promise.resolve(onPersist?.(productId, { ozonPublication: publication }));
    return publication;
  }, [onPersist, productId]);

  const getPersistenceSnapshot = React.useCallback((candidate = draftRef.current) => {
    if (!candidate?.shopId) return { ozonListingDraft: candidate, ozonListingDrafts: { ...draftsByShopRef.current } };
    const saved = withListingDraftTimestamp(candidate);
    return {
      ozonListingDraft: saved,
      ozonListingDrafts: { ...draftsByShopRef.current, [saved.shopId]: saved },
    };
  }, []);

  // Image selections are edited from the image workspace while the listing
  // draft is owned by this hook.  Commit through one path so the ref, React
  // state, preview and upload state cannot drift apart during rapid clicks.
  const commitImageDraft = React.useCallback((nextDraft) => {
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    previewRef.current = null;
    setPreview(null);
    setListingState({ ...EMPTY_ASYNC_STATE, result: null, message: '' });
    setStepError('');
    return nextDraft;
  }, []);

  const refreshImageUploadPayload = React.useCallback((sourceProduct = productRef.current) => {
    const current = draftRef.current;
    const next = applyCollectionProductGeneratedImagesToListingDraft(
      { ...current },
      current.generatedImageSelections,
      sourceProduct || productRef.current || {},
    );
    return commitImageDraft(next);
  }, [commitImageDraft]);

  const updateOriginalImageSelection = React.useCallback((input = {}) => {
    const { sourceProduct, ...selectionInput } = input || {};
    const current = draftRef.current;
    const originalImageSelections = withCollectionProductOriginalImageSelection(
      current.originalImageSelections,
      selectionInput,
    );
    const next = applyCollectionProductGeneratedImagesToListingDraft(
      { ...current, originalImageSelections },
      current.generatedImageSelections,
      sourceProduct || productRef.current || {},
    );
    commitImageDraft(next);
    return originalImageSelections;
  }, [commitImageDraft]);

  const removeGeneratedImage = React.useCallback((input = {}) => {
    const current = draftRef.current;
    const generatedImageSelections = removeCollectionProductGeneratedImageSelection(
      current.generatedImageSelections,
      input,
    );
    const next = applyCollectionProductGeneratedImagesToListingDraft(
      { ...current, generatedImageSelections },
      generatedImageSelections,
      input.sourceProduct || productRef.current || {},
    );
    commitImageDraft(next);
    setGenerationState((state) => {
      const group = ['main', 'sku', 'detail'].includes(input.group) ? input.group : 'main';
      const sourceIndex = Number(input.sourceIndex);
      const assetId = String(input.assetId || '').trim();
      const taskId = String(input.taskId || '').trim();
      const imageUrl = String(input.imageUrl || input.previewUrl || '').trim();
      const hasSourceIndex = Number.isInteger(sourceIndex);
      const itemsByGroup = Object.fromEntries(Object.entries(state.itemsByGroup || {}).map(([name, items]) => [
        name,
        name !== group ? items : (Array.isArray(items) ? items.filter((item) => {
          if (hasSourceIndex) return Number(item?.sourceIndex) !== sourceIndex;
          if (assetId) return item?.assetId !== assetId;
          if (taskId) return item?.taskId !== taskId;
          if (imageUrl) return ![item?.imageUrl, item?.previewUrl].includes(imageUrl);
          return true;
        }) : []),
      ]));
      return { ...state, itemsByGroup };
    });
    return { ok: true, draft: next };
  }, [commitImageDraft]);

  const updateGeneratedImageSelection = React.useCallback((input = {}) => {
    const current = draftRef.current;
    const generatedImageSelections = withCollectionProductGeneratedImageItemSelection(
      current.generatedImageSelections,
      input,
    );
    const next = applyCollectionProductGeneratedImagesToListingDraft(
      { ...current, generatedImageSelections },
      generatedImageSelections,
      input.sourceProduct || productRef.current || {},
    );
    commitImageDraft(next);
    return { ok: true, selected: input.selected !== false, draft: next };
  }, [commitImageDraft]);

  const update = React.useCallback((changes) => {
    const current = draftRef.current;
    // shopId is the hidden source/catalog scope for category dictionaries and
    // private image assets. Upload targets are changed only through
    // uploadShopIds on the SKU/price step; never swap the product master draft.
    const { shopId: _ignoredShopId, ...masterChanges } = changes || {};
    const changesAutofillScope = (
      (Object.hasOwn(masterChanges, 'descriptionCategoryId')
        && String(masterChanges.descriptionCategoryId || '') !== String(current.descriptionCategoryId || ''))
      || (Object.hasOwn(masterChanges, 'typeId')
        && String(masterChanges.typeId || '') !== String(current.typeId || ''))
    );
    if (changesAutofillScope) {
      attributeAutofillRunRef.current += 1;
      attributeAutofillAbortRef.current?.abort();
      attributeAutofillAbortRef.current = null;
      attributeAutofillCheckpointRef.current = null;
      inlineAttributeSchemaKeyRef.current = '';
      setAttributeAutofillState(createAttributeAutofillState());
    }
    const optimistic = { ...current, ...masterChanges, shopId: current.shopId };
    draftRef.current = optimistic;
    setDraft((latest) => {
      const next = { ...latest, ...masterChanges, shopId: latest.shopId };
      draftRef.current = next;
      return next;
    });
    previewRef.current = null;
    setPreview(null);
    setListingState({ ...EMPTY_ASYNC_STATE, result: null, message: '' });
    setStepError('');
  }, []);

  const updateUploadShopIds = React.useCallback((shopIds) => {
    const normalized = normalizeCollectionListingTargetShopIds(shopIds, shopsRef.current);
    update({ uploadShopIds: normalized });
    return normalized;
  }, [update]);

  const previewCategoryTemplate = React.useCallback(async (option, { force = false } = {}) => {
    const categoryKey = categoryTemplateOptionKey(option);
    if (!categoryKey || !draftRef.current.shopId) return null;
    categoryTemplateRequestRef.current += 1;
    const requestId = categoryTemplateRequestRef.current;
    categoryTemplateAbortRef.current?.abort();
    const abortController = new AbortController();
    categoryTemplateAbortRef.current = abortController;
    const loadingState = { status: 'loading', error: '', categoryKey, template: null, progress: { current: 0, total: 0 } };
    categoryTemplateStateRef.current = loadingState;
    setCategoryTemplateState(loadingState);
    try {
      const template = await loadCollectionListingCategoryTemplate({
        shopId: draftRef.current.shopId,
        descriptionCategoryId: option.descriptionCategoryId,
        typeId: option.typeId,
        categoryName: option.name,
        categoryPath: option.pathText,
      }, {
        force,
        signal: abortController.signal,
        onProgress: (progress) => {
          if (categoryTemplateRequestRef.current !== requestId) return;
          setCategoryTemplateState((current) => ({ ...current, progress }));
        },
      });
      if (categoryTemplateRequestRef.current !== requestId) return null;
      const readyState = { status: 'ready', error: '', categoryKey, template, progress: null };
      categoryTemplateStateRef.current = readyState;
      setCategoryTemplateState(readyState);
      return template;
    } catch (error) {
      if (error?.name === 'AbortError' || categoryTemplateRequestRef.current !== requestId) return null;
      const errorState = {
        status: 'error',
        error: error instanceof Error ? error.message : 'Ozon 类目模板读取失败。',
        categoryKey,
        template: null,
        progress: null,
      };
      categoryTemplateStateRef.current = errorState;
      setCategoryTemplateState(errorState);
      return null;
    }
  }, []);

  const selectCategory = React.useCallback((option) => {
    update({
      descriptionCategoryId: option?.descriptionCategoryId || '',
      typeId: option?.typeId || '',
      categorySelectionSource: 'manual',
      categoryName: option?.name || '',
      categoryPath: option?.pathText || '',
      categoryCommissionPercent: '',
      categoryCommissionSource: '',
      categoryCommissionEvidenceCount: 0,
      pricingDraft: { ...draftRef.current.pricingDraft, ozonFeePercent: '' },
      attributeValues: {},
      skus: draftRef.current.skus.map((item) => ({ ...item, attributeValues: {} })),
      attributes: [],
    });
  }, [update]);

  const updateAttribute = React.useCallback((id, value) => {
    setDraft((current) => ({
      ...current,
      attributeValues: { ...current.attributeValues, [String(id)]: { ...value, source: 'manual' } },
    }));
    setPreview(null);
    setStepError('');
  }, []);

  const updateSkuAttribute = React.useCallback((index, id, value) => {
    setDraft((current) => ({
      ...current,
      skus: current.skus.map((item, rowIndex) => rowIndex === index ? {
        ...item,
        attributeValues: {
          ...(item.attributeValues || {}),
          [String(id)]: { ...value, source: 'manual' },
        },
      } : item),
    }));
    setPreview(null);
    setStepError('');
  }, []);

  const updateSku = React.useCallback((index, changes) => {
    setDraft((current) => ({
      ...current,
      skus: current.skus.map((item, rowIndex) => rowIndex === index ? { ...item, ...changes } : item),
    }));
    setPreview(null);
    setStepError('');
  }, []);

  const applyPriceToEnabledSkus = React.useCallback((price) => {
    const normalizedPrice = Number(price);
    if (!Number.isFinite(normalizedPrice) || normalizedPrice <= 0) return false;
    const value = String(Number(normalizedPrice.toFixed(2)));
    setDraft((current) => ({
      ...current,
      skus: current.skus.map((item) => item.enabled === false ? item : { ...item, price: value }),
    }));
    setPreview(null);
    setListingState({ ...EMPTY_ASYNC_STATE, result: null, message: '' });
    setStepError('');
    return true;
  }, []);

  const analyzeAndFillAttributes = React.useCallback(async () => {
    attributeAutofillAbortRef.current?.abort();
    const abortController = new AbortController();
    attributeAutofillAbortRef.current = abortController;
    const runId = attributeAutofillRunRef.current + 1;
    attributeAutofillRunRef.current = runId;
    let currentDraft = draftRef.current;
    let activeDefinitions = definitions;
    let activeOptions = attributeOptions;
    let deterministicAppliedCount = 0;
    let deterministicFilledCount = 0;
    let runScopeKey = collectionAttributeAutofillScopeKey(productRef.current, currentDraft);
    const isCurrentRun = () => (
      attributeAutofillRunRef.current === runId
      && collectionAttributeAutofillScopeKey(productRef.current, draftRef.current) === runScopeKey
    );
    setAttributeAutofillState(createAttributeAutofillState({
      status: 'running',
      message: '正在核对 Ozon 类目和商品资料…',
    }));
    try {
      if (
        currentDraft.categorySelectionSource !== 'manual'
        || !activeDefinitions.length
        || !currentDraft.descriptionCategoryId
        || !currentDraft.typeId
      ) {
        setAttributeAutofillState(createAttributeAutofillState({
          status: 'error',
          error: '请先通过完整类目库选择并确认 Ozon 类目，再进行一键分析填充。',
        }));
        return null;
      }
      currentDraft = resetPreviousAutofillDraft(currentDraft);
      draftRef.current = currentDraft;
      setDraft(currentDraft);
      setAttributeAutofillState(createAttributeAutofillState({
        status: 'running',
        message: '正在读取 Ozon 标准选项并直接匹配来源资料…',
      }));
      await yieldCollectionAnalysisFrame();
      if (!isCurrentRun()) return null;
      const preloaded = await preloadCollectionAttributeAutofillDictionaryOptions({
        definitions: activeDefinitions,
        optionsByAttributeId: activeOptions,
        searchAttributeOptions,
        signal: abortController.signal,
        onProgress: ({ current = 0, total = 0 }) => {
          if (!isCurrentRun()) return;
          setAttributeAutofillState(createAttributeAutofillState({
            status: 'running',
            message: `正在分组读取完整 Ozon 标准选项 ${Math.min(current, total || 1)}/${total || 1}…`,
          }));
        },
      });
      if (!isCurrentRun()) return null;
      activeOptions = preloaded.optionsByAttributeId;
      const directDefinitions = splitListingAttributeDefinitions(activeDefinitions);
      setAttributeAutofillState(createAttributeAutofillState({
        status: 'running',
        message: `正在核对 ${currentDraft.skus.length} 个 SKU 的来源规格…`,
      }));
      await yieldCollectionAnalysisFrame();
      if (!isCurrentRun()) return null;
      const deterministic = await matchCollectedProductAttributes({
        product: productRef.current,
        draft: currentDraft,
        definitions: activeDefinitions,
        optionsByAttributeId: activeOptions,
        searchAttributeOptions,
        signal: abortController.signal,
        onProgress: ({ phase, current = 0, total = 0 }) => {
          if (!isCurrentRun() || phase !== 'dictionary-source') return;
          setAttributeAutofillState(createAttributeAutofillState({
            status: 'running',
            message: `正在匹配来源资料与 Ozon 标准选项 ${Math.min(current, total || 1)}/${total || 1}…`,
          }));
        },
      });
      if (!isCurrentRun()) return null;
      activeOptions = deterministic.optionsByAttributeId;
      const directManaged = applyCollectionProductManagedDefaults({
        product: productRef.current,
        draft: currentDraft,
        definitions: directDefinitions.global,
        optionsByAttributeId: activeOptions,
        currentValues: deterministic.attributeValues,
      });
      deterministicAppliedCount = deterministic.mappedCount + directManaged.appliedCount;
      deterministicFilledCount = countDeterministicAttributeValues(directManaged.values)
        + deterministic.skus.reduce((total, sku) => total + countDeterministicAttributeValues(sku.attributeValues), 0);
      currentDraft = {
        ...currentDraft,
        attributeValues: directManaged.values,
        skus: deterministic.skus,
      };
      draftRef.current = currentDraft;
      setDraft(currentDraft);
      setAttributeOptions(activeOptions);
      setAttributeState((currentState) => ({
        ...currentState,
        mappedCount: Number(currentState.mappedCount || 0) + deterministicAppliedCount,
      }));
      const startedDraft = currentDraft;
      runScopeKey = collectionAttributeAutofillScopeKey(productRef.current, startedDraft);
      setAttributeAutofillState(createAttributeAutofillState({
        status: 'running',
        message: '正在分析商品资料和全部类目字段…',
      }));
      const result = await runCollectionAttributeAutofill({
        product: productRef.current,
        draft: startedDraft,
        definitions: activeDefinitions,
        optionsByAttributeId: activeOptions,
        modelOptions: textModelOptions,
        selectedModelId: textModelId,
        checkpointKey: runScopeKey,
        checkpoint: attributeAutofillCheckpointRef.current?.key === runScopeKey
          ? attributeAutofillCheckpointRef.current
          : null,
      }, {
        searchAttributeOptions,
        signal: abortController.signal,
        // 当前一键填充优先使用已经采集到的标题、来源属性和全部 SKU，
        // 避免先串行执行一次付费图片识别后才开始文本任务。
        // 服务仍保留显式 enableVision: true 的独立图片核对能力。
        enableVision: false,
        // 109 SKU 真实压测：11 个 SKU/批、全局字段每 5 个一批，
        // 15 路单轮并行在完整核对 237 个属性单元时稳定完成于 35 秒内。
        skuBatchSize: 11,
        splitGlobalJobs: true,
        globalAttributeBatchSize: 5,
        sharedSkuTitle: true,
        modelConcurrency: 15,
        modelRequestsPerWindow: 30,
        onCheckpoint: (checkpoint) => {
          if (isCurrentRun()) attributeAutofillCheckpointRef.current = checkpoint;
        },
        onPhaseResult: async ({ suggestions }) => {
          if (!isCurrentRun() || !suggestions) return;
          const phaseApplied = applyCollectionAttributeAutofillResult(
            draftRef.current,
            suggestions,
            startedDraft,
          );
          draftRef.current = phaseApplied.draft;
          setDraft(phaseApplied.draft);
        },
        onProgress: ({ phase, stageLabel = '', current = 0, total = 0 }) => {
          if (!isCurrentRun()) return;
          const phaseText = {
            vision: '正在识别商品图片中的可见信息…',
            model: stageLabel
              ? `正在执行智能填充：${stageLabel} ${Math.min(current, total || 1)}/${total || 1}…`
              : `正在执行五阶段智能填充 ${Math.min(current, total || 1)}/${total || 1}…`,
            dictionary: `正在本地核对 Ozon 标准选项 ${Math.min(current, total || 1)}/${total || 1}…`,
            complete: '正在核对填写结果…',
          }[phase];
          if (!phaseText) return;
          setAttributeAutofillState((currentState) => ({
            ...currentState,
            status: 'running',
            error: '',
            message: phaseText,
          }));
        },
      });
      if (!isCurrentRun()) return null;
      attributeAutofillCheckpointRef.current = result.checkpoint || null;
      if (result.optionsByAttributeId) setAttributeOptions(result.optionsByAttributeId);
      const applied = applyCollectionAttributeAutofillResult(
        draftRef.current,
        result.suggestions,
        startedDraft,
      );
      const repairedDraft = repairCollectionProductSkuVariantValues(
        applied.draft,
        productRef.current,
        activeDefinitions,
      );
      const completed = applyCollectionProductManagedDefaults({
        product: productRef.current,
        draft: repairedDraft,
        definitions: splitListingAttributeDefinitions(activeDefinitions).global,
        optionsByAttributeId: result.optionsByAttributeId || activeOptions,
        currentValues: repairedDraft.attributeValues,
        fillProductName: true,
      });
      const completedDraft = { ...repairedDraft, attributeValues: completed.values };
      const completedApplied = {
        ...applied,
        draft: completedDraft,
        appliedAttributeCount: applied.appliedAttributeCount + completed.appliedCount,
        appliedCount: applied.appliedCount + completed.appliedCount,
      };
      setDraft(completedDraft);
      draftRef.current = completedDraft;
      setPreview(null);
      setListingState({ ...EMPTY_ASYNC_STATE, result: null, message: '' });
      setStepError('');
      const unresolvedCount = result.suggestions.unresolved.length;
      const reviewedCellCount = Number(result.pipeline?.reviewedAttributeCellCount || result.pipeline?.schemaCellCount || activeDefinitions.length || 0);
      const attributeSummary = `${completedApplied.appliedAttributeCount} 个属性${completedApplied.appliedTextCount ? `、${completedApplied.appliedTextCount} 段文案` : ''}`;
      const message = completedApplied.appliedCount
        ? `智能填充已完成：核对 ${reviewedCellCount} 个属性单元格，自动填入 ${attributeSummary}。`
        : `智能填充已完成：${reviewedCellCount} 个属性单元格原本已经填好。`;
      setAttributeAutofillState(createAttributeAutofillState({
        status: completedApplied.appliedCount ? 'success' : 'empty',
        message,
        warning: [
          result.pipeline?.visionWarning
            ? `图片识别未完成，本次已改用标题、来源属性和 SKU 资料继续填写：${result.pipeline.visionWarning}`
            : '',
          result.pipeline?.modelWarning || '',
        ].filter(Boolean).join('；'),
        appliedCount: completedApplied.appliedCount,
        appliedAttributeCount: completedApplied.appliedAttributeCount,
        appliedTextCount: completedApplied.appliedTextCount,
        unresolvedCount,
        unresolvedItems: describeUnresolvedAttributeItems(result.suggestions.unresolved, activeDefinitions, completedDraft),
        reviewedAttributeCellCount: reviewedCellCount,
        modelLabel: result.modelLabel,
      }));
      return { ...result, ...completedApplied };
    } catch (error) {
      if (error?.name === 'AbortError' || attributeAutofillRunRef.current !== runId) return null;
      if (error?.checkpoint?.key === runScopeKey) attributeAutofillCheckpointRef.current = error.checkpoint;
      const message = error instanceof Error ? error.message : '商品属性分析失败，请稍后重试。';
      if (deterministicFilledCount > 0) {
        setAttributeAutofillState(createAttributeAutofillState({
          status: 'success',
          message: `已先按来源资料和 Ozon 标准选项直接填入 ${deterministicFilledCount} 个属性。`,
          warning: message,
          appliedCount: deterministicFilledCount,
          appliedAttributeCount: deterministicFilledCount,
        }));
        return { draft: draftRef.current, appliedAttributeCount: deterministicFilledCount, partial: true };
      }
      setAttributeAutofillState(createAttributeAutofillState({
        status: 'error',
        error: message,
      }));
      return null;
    } finally {
      if (attributeAutofillRunRef.current === runId) attributeAutofillAbortRef.current = null;
    }
  }, [attributeOptions, definitions, searchAttributeOptions, textModelId, textModelOptions]);

  const persist = React.useCallback((candidate = draft) => {
    persistDraft(candidate);
  }, [draft, persistDraft]);

  const validate = React.useCallback((stepId) => {
    if (stepId !== 'setup') return validateCollectionProductListingStep(stepId, draft, definitions);
    const category = validateCollectionProductListingStep('category', draft, definitions);
    const details = validateCollectionProductListingStep('details', draft, definitions);
    return { ok: category.ok && details.ok, errors: [...category.errors, ...details.errors] };
  }, [definitions, draft]);

  const setStep = React.useCallback((nextStep) => {
    const currentIndex = COLLECTION_PRODUCT_LISTING_STEPS.findIndex((item) => item.id === step);
    const nextIndex = COLLECTION_PRODUCT_LISTING_STEPS.findIndex((item) => item.id === nextStep);
    if (nextIndex < 0) return false;
    if (nextStep === 'readback' && !listingState.result && listingState.status !== 'submitting') {
      setStepError('请先生成上架预览并确认上传。');
      return false;
    }
    if (!shops.length || nextIndex <= currentIndex) {
      setStepState(nextStep);
      setStepError('');
      return true;
    }
    for (let index = currentIndex; index < nextIndex; index += 1) {
      const candidateStep = COLLECTION_PRODUCT_LISTING_STEPS[index]?.id;
      if (!['setup', 'images', 'skus'].includes(candidateStep)) continue;
      if (candidateStep === 'setup' && attributeState.status === 'loading') {
        setStepError('Ozon 类目属性仍在读取，请稍等。');
        return false;
      }
      const result = validate(candidateStep);
      if (!result.ok) {
        setStepError(result.errors[0]);
        return false;
      }
    }
    persist();
    setStepState(nextStep);
    setStepError('');
    return true;
  }, [attributeState.status, listingState.result, listingState.status, persist, shops.length, step, validate]);

  const move = React.useCallback((offset) => {
    const index = COLLECTION_PRODUCT_LISTING_STEPS.findIndex((item) => item.id === step);
    const target = COLLECTION_PRODUCT_LISTING_STEPS[index + offset];
    return target ? setStep(target.id) : false;
  }, [setStep, step]);

  const requestPreview = React.useCallback(async ({ beforePreview } = {}) => {
    // Entering the preview step can be triggered by the tab, the footer button
    // and React StrictMode. Keep one in-flight preview so those entry paths do
    // not duplicate image persistence, preview requests or temporary assets.
    if (previewAbortRef.current) return null;
    let currentDraft = draftRef.current;
    for (const stepId of ['category', 'details', 'images', 'skus']) {
      const validation = validateCollectionProductListingStep(stepId, currentDraft, definitions);
      if (!validation.ok) {
        setStepError(validation.errors[0]);
        setStepState(['category', 'details'].includes(stepId) ? 'setup' : stepId);
        return null;
      }
    }
    previewRunRef.current += 1;
    const runId = previewRunRef.current;
    previewAbortRef.current?.abort();
    const abortController = new AbortController();
    previewAbortRef.current = abortController;
    previewRef.current = null;
    setPreview(null);
    setStepState('preview');
    setStepError('');
    setListingState({
      status: 'previewing',
      error: '',
      result: null,
      message: beforePreview ? '正在保存图片和商品草稿…' : '正在按实际数据大小拆分上架预览…',
      progress: { phase: beforePreview ? 'preparing' : 'chunking', current: 0, total: null },
    });
    try {
      if (typeof beforePreview === 'function') {
        const prepared = await beforePreview({ signal: abortController.signal });
        if (previewRunRef.current !== runId || abortController.signal.aborted) return null;
        if (prepared === false) throw new Error('采集商品保存失败，请重试。');
        currentDraft = draftRef.current;
        for (const stepId of ['category', 'details', 'images', 'skus']) {
          const validation = validateCollectionProductListingStep(stepId, currentDraft, definitions);
          if (!validation.ok) {
            setStepError(validation.errors[0]);
            setStepState(['category', 'details'].includes(stepId) ? 'setup' : stepId);
            setListingState({ ...EMPTY_ASYNC_STATE, result: null, message: '' });
            return null;
          }
        }
        setListingState({
          status: 'previewing',
          error: '',
          result: null,
          message: '正在按实际数据大小拆分上架预览…',
          progress: { phase: 'chunking', current: 0, total: null },
        });
      }
      const commandDraft = toCollectionListingCommandDraft(currentDraft, definitions);
      const nextPreview = await previewCollectionListingsForShops({
        baseDraft: commandDraft,
        sourceShopId: currentDraft.shopId,
        targetShopIds: currentDraft.uploadShopIds,
        shops: shopsRef.current,
        savedDraftsByShop: draftsByShopRef.current,
        productId,
      }, {
        signal: abortController.signal,
        onProgress(progress) {
          if (previewRunRef.current !== runId || abortController.signal.aborted) return;
          setListingState({
            status: 'previewing',
            error: '',
            result: null,
            message: progress.message || '正在生成上架预览…',
            progress,
          });
        },
      });
      if (previewRunRef.current !== runId || abortController.signal.aborted) {
        await releaseListingPreview(nextPreview);
        return null;
      }
      previewRef.current = nextPreview;
      setPreview(nextPreview);
      setListingState({
        status: nextPreview.readyCount > 0 ? 'preview-ready' : 'error',
        error: '',
        result: null,
        message: nextPreview.readyCount > 0
          ? `${nextPreview.readyCount} 个店铺预览已就绪${nextPreview.failedCount ? `，${nextPreview.failedCount} 个店铺需要处理` : ''}，请复核后提交。`
          : '所选店铺均未生成可上传预览，请查看店铺错误。',
        progress: null,
      });
      persist(currentDraft);
      setStepState('preview');
      return nextPreview;
    } catch (error) {
      if (previewRunRef.current !== runId) return null;
      setPreview(null);
      previewRef.current = null;
      if (error?.name === 'AbortError') {
        setListingState({ status: 'cancelled', error: '', result: null, message: '已取消生成上架预览。', progress: null });
      } else {
        setListingState({ status: 'error', error: getCollectionListingErrorMessage(error), result: null, message: '', progress: null });
      }
      return null;
    } finally {
      if (previewRunRef.current === runId) previewAbortRef.current = null;
    }
  }, [definitions, persist, productId]);

  const cancelPreview = React.useCallback(() => {
    if (!previewAbortRef.current) return false;
    previewRunRef.current += 1;
    previewAbortRef.current.abort();
    previewAbortRef.current = null;
    setListingState({ status: 'cancelled', error: '', result: null, message: '已取消生成上架预览。', progress: null });
    return true;
  }, []);

  const submit = React.useCallback(async () => {
    if (!preview) return null;
    setListingState({ status: 'submitting', error: '', result: null, message: '正在上传并等待 Ozon 回读…' });
    setStepState('readback');
    try {
      const result = preview.multiShop
        ? await confirmCollectionListingsForShops(preview, {
            realWrite: true,
            onProgress(progress) {
              setListingState({
                status: 'submitting',
                error: '',
                result: null,
                message: progress.message || '正在上传并等待 Ozon 回读…',
                progress,
              });
            },
          })
        : await confirmCollectionListing(preview, {
            realWrite: true,
            onProgress(progress) {
              setListingState({
                status: 'submitting',
                error: '',
                result: null,
                message: progress.message || '正在上传并等待 Ozon 回读…',
                progress,
              });
            },
          });
      await persistPublicationResult(result);
      setListingState({
        status: result.completed ? 'completed' : result.status,
        error: result.status === 'failed' ? result.message : '',
        result,
        message: result.message,
        progress: null,
      });
      return result;
    } catch (error) {
      setListingState({ status: 'error', error: getCollectionListingErrorMessage(error), result: null, message: '', progress: null });
      return null;
    }
  }, [persistPublicationResult, preview]);

  const resumeReadBack = React.useCallback(async () => {
    const priorResult = listingState?.result;
    if (!preview?.multiShop || !priorResult) return null;
    setListingState({ status: 'submitting', error: '', result: priorResult, message: '正在继续 Ozon 回读，不会重复上传商品…' });
    setStepState('readback');
    try {
      const result = await continueCollectionListingsReadBackForShops(preview, priorResult, {
        realWrite: true,
        onProgress(progress) {
          setListingState({
            status: 'submitting',
            error: '',
            result: priorResult,
            message: progress.message || '正在继续 Ozon 回读，不会重复上传商品…',
            progress,
          });
        },
      });
      await persistPublicationResult(result);
      setListingState({
        status: result.completed ? 'completed' : result.status,
        error: result.status === 'failed' ? result.message : '',
        result,
        message: result.message,
        progress: null,
      });
      return result;
    } catch (error) {
      setListingState({
        status: 'error',
        error: getCollectionListingErrorMessage(error),
        result: priorResult,
        message: '',
        progress: null,
      });
      return null;
    }
  }, [listingState?.result, persistPublicationResult, preview]);

  const generateImages = React.useCallback(async ({
    group = 'main',
    rows = [],
    selectedIndexes = [],
    editorSettings = {},
    sourceProduct = null,
    generationMode = 'standard',
  } = {}) => {
    const selectedRows = selectedIndexes.map((index) => rows[index]).filter((item) => item?.imageUrl);
    const currentDraft = draftRef.current;
    const currentProduct = sourceProduct || productRef.current || {};
    const promptConfig = imageSkill?.promptConfig || {};
    const normalizedGenerationMode = normalizeSmartToolImageGenerationMode(generationMode);
    const selectedImageModelId = editorSettings.imageModelId && editorSettings.imageModelId !== 'auto'
      ? editorSettings.imageModelId
      : promptConfig.imageModelId || promptConfig.defaultModelId || 'auto';
    const selectedPlannerModelId = textModelId && textModelId !== 'auto'
      ? textModelId
      : promptConfig.plannerModelId || 'auto';
    const modelSelection = resolveSmartToolModelSelection(selectedImageModelId, imageModelOptions);
    const plannerModelSelection = resolveSmartToolModelSelection(selectedPlannerModelId, textModelOptions);
    const historyEntryId = `collection-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const historyCreatedAt = new Date().toISOString();
    const historyShopId = String(currentDraft.shopId || '').trim();
    const historyProductKey = String(currentProduct.id || currentProduct.sourceProductId || currentProduct.sourceUrl || '').trim();
    const historyItemsBySourceIndex = new Map();
    let historyEntryPersisted = false;
    const persistHistoryItems = (items = []) => {
      const successfulItems = items.filter((item) => item?.status === 'success' && (item.imageUrl || item.previewUrl || item.assetId));
      if (!successfulItems.length) return;
      const current = draftRef.current;
      const activeProductKey = String(productRef.current?.id || productRef.current?.sourceProductId || productRef.current?.sourceUrl || '').trim();
      if (String(current.shopId || '').trim() !== historyShopId || activeProductKey !== historyProductKey) return;
      const actualImageModel = successfulItems.find((item) => item?.result?.model)?.result?.model || modelSelection.model;
      const historyEntry = {
        id: historyEntryId,
        shopId: historyShopId,
        productKey: historyProductKey,
        sourceProductId: currentProduct.sourceProductId,
        sourcePlatform: currentProduct.platform || currentProduct.sourcePlatform,
        sourceUrl: currentProduct.sourceUrl,
        productTitle: currentDraft.title || currentProduct.title,
        sourceProductTitle: currentProduct.title,
        group,
        createdAt: historyCreatedAt,
        plannerModel: plannerModelSelection.model,
        model: actualImageModel,
        replaceSourceIndexes: selectedIndexes,
        items: successfulItems,
      };
      const imageGenerationHistory = upsertCollectionProductImageHistory(current.imageGenerationHistory, historyEntry);
      const activeSelection = current.generatedImageSelections?.[group];
      const generatedImageSelections = !activeSelection?.historyEntryId || activeSelection.historyEntryId === historyEntryId
        ? mergeCollectionProductGeneratedImageSelection(current.generatedImageSelections, historyEntry)
        : current.generatedImageSelections;
      const next = { ...current, imageGenerationHistory, generatedImageSelections };
      draftRef.current = next;
      setDraft(next);
      persistDraft(next);
    };
    if (!selectedRows.length) {
      setGenerationState((current) => ({ ...current, status: 'error', error: '请先选择要生成的来源图片。' }));
      return null;
    }
    const pendingItems = selectedIndexes.map((sourceIndex) => ({ sourceIndex, status: 'planning' }));
    setGenerationState((current) => ({
      ...current,
      status: 'running',
      phase: 'planning',
      error: '',
      message: `正在读取并完整编译 ${selectedRows.length} 个 Skill 图片位置…`,
      itemsByGroup: {
        ...current.itemsByGroup,
        [group]: mergeGeneratedImageItems(current.itemsByGroup[group], pendingItems),
      },
    }));
    try {
      const result = await runCollectionProductImageSkillBatch({
        skill: imageSkill,
        shopId: currentDraft.shopId,
        productTitle: currentDraft.title || currentProduct.title,
        productKey: currentProduct.sourceProductId || currentProduct.id,
        sourceUrl: currentProduct.sourceUrl,
        offerId: currentProduct.offerId || currentProduct.offer_id,
        productId: currentProduct.productId || currentProduct.product_id,
        skuFacts: buildCollectionProductImageSkillFacts({
          product: currentProduct,
          draft: currentDraft,
          group,
          rows,
          selectedIndexes,
        }),
        draft: currentDraft,
        productImageUrl: selectedRows[0]?.imageUrl || '',
        productImageUrls: selectedRows.map((item) => item.imageUrl),
        sourceImageIndexes: selectedIndexes,
        count: selectedRows.length,
        plannerModelSelection,
        modelSelection,
        allowPaidFallback: selectedImageModelId === 'auto',
        imageGroup: group === 'detail' ? 'detail' : 'main',
        targetScene: group === 'detail' ? '商品详情展示' : group === 'sku' ? 'SKU 专属商品主图' : 'Ozon 商品主图',
        imageSize: editorSettings.imageSize || currentProduct.editorSettings?.imageSize,
        imageQuality: editorSettings.imageQuality || currentProduct.editorSettings?.imageQuality,
        generationMode: normalizedGenerationMode,
      }, {
        onPhase: ({ phase, message }) => {
          setGenerationState((current) => ({
            ...current,
            status: phase === 'complete' ? current.status : 'running',
            phase,
            message,
            itemsByGroup: phase === 'generating'
              ? {
                  ...current.itemsByGroup,
                  [group]: (current.itemsByGroup[group] || []).map((item) => (
                    item.status === 'planning' ? { ...item, status: 'loading' } : item
                  )),
                }
              : current.itemsByGroup,
          }));
        },
        onItemSettled: (item) => {
          historyItemsBySourceIndex.set(
            item.sourceIndex,
            mergeGeneratedHistoryItem(historyItemsBySourceIndex.get(item.sourceIndex), {
              ...item,
              assetShopId: historyShopId,
              sourceImageUrl: rows[item.sourceIndex]?.imageUrl || '',
              sourceSkuId: rows[item.sourceIndex]?.sourceSkuId || rows[item.sourceIndex]?.skuId || '',
            }),
          );
          if (historyEntryPersisted) persistHistoryItems([...historyItemsBySourceIndex.values()]);
          setGenerationState((current) => ({
            ...current,
            itemsByGroup: {
              ...current.itemsByGroup,
              [group]: mergeGeneratedImageItems(current.itemsByGroup[group], [item]),
            },
          }));
        },
      });
      const firstFailure = result.items.find((item) => item.status === 'error' && item.message)?.message || '';
      const failureSummary = result.failedCount
        ? `${result.failedCount} 张生成失败${firstFailure ? `：${firstFailure}` : '，可单独重试。'}`
        : '';
      (result.items || []).forEach((item) => {
        historyItemsBySourceIndex.set(
          item.sourceIndex,
            mergeGeneratedHistoryItem(historyItemsBySourceIndex.get(item.sourceIndex), {
              ...item,
              assetShopId: historyShopId,
              sourceImageUrl: rows[item.sourceIndex]?.imageUrl || '',
              sourceSkuId: rows[item.sourceIndex]?.sourceSkuId || rows[item.sourceIndex]?.skuId || '',
            }),
        );
      });
      const generatedSelections = mergeCollectionProductGeneratedImageSelection(
        draftRef.current.generatedImageSelections,
        {
          id: historyEntryId,
          shopId: historyShopId,
          productKey: historyProductKey,
          group,
          createdAt: historyCreatedAt,
          replaceSourceIndexes: selectedIndexes,
          items: [...historyItemsBySourceIndex.values()],
        },
      );
      const generatedDraft = applyCollectionProductGeneratedImagesToListingDraft(
        { ...draftRef.current, generatedImageSelections: generatedSelections },
        generatedSelections,
        currentProduct,
      );
      draftRef.current = generatedDraft;
      setDraft(generatedDraft);
      historyEntryPersisted = true;
      persistHistoryItems([...historyItemsBySourceIndex.values()]);
      setGenerationState((current) => ({
        status: result.failedCount ? 'partial' : 'success',
        phase: 'complete',
        error: failureSummary,
        message: result.failedCount
          ? `Skill 已完成：成功 ${result.successCount}/${result.count} 张。`
          : `Skill 已完成：成功生成 ${result.successCount} 张图片。`,
        itemsByGroup: {
          ...current.itemsByGroup,
          [group]: mergeGeneratedImageItems(current.itemsByGroup[group], result.items),
        },
      }));
      return result;
    } catch (error) {
      setGenerationState((current) => ({
        ...current,
        status: 'error',
        phase: 'error',
        message: '',
        error: error instanceof Error ? error.message : '图片生成失败。',
      }));
      return null;
    }
  }, [imageModelOptions, imageSkill, persistDraft, textModelId, textModelOptions]);

  const restoreImageHistoryBatch = React.useCallback((entry = {}) => {
    const currentDraft = draftRef.current;
    const currentProduct = productRef.current || {};
    const currentShopId = String(currentDraft.shopId || '').trim();
    const currentProductKey = String(currentProduct.id || currentProduct.sourceProductId || currentProduct.sourceUrl || '').trim();
    const normalized = normalizeCollectionProductImageHistoryEntry(entry);
    if (!currentShopId || normalized.productKey !== currentProductKey) {
      const error = '这批图片不属于当前采集商品，不能应用。';
      setGenerationState((current) => ({ ...current, status: 'error', phase: 'error', message: '', error }));
      return { ok: false, error };
    }
    const items = normalized.items
      .map((item) => {
        const imageUrl = String(item.previewUrl || item.imageUrl || '').trim();
        return imageUrl ? { ...item, status: 'success', imageUrl, previewUrl: imageUrl, restoredFromHistory: true } : null;
      })
      .filter(Boolean)
      .sort((left, right) => left.sourceIndex - right.sourceIndex);
    if (!items.length) {
      const error = '这批历史图片当前无法读取，请稍后重试。';
      setGenerationState((current) => ({ ...current, status: 'error', phase: 'error', message: '', error }));
      return { ok: false, error };
    }
    const nextDraft = applyCollectionProductGeneratedImagesToListingDraft({
      ...currentDraft,
      generatedImageSelections: withCollectionProductGeneratedImageSelection(
        currentDraft.generatedImageSelections,
        { ...normalized, items },
      ),
    }, withCollectionProductGeneratedImageSelection(
      currentDraft.generatedImageSelections,
      { ...normalized, items },
    ), currentProduct);
    commitImageDraft(nextDraft);
    setGenerationState((current) => ({
      ...current,
      status: 'success',
      phase: 'complete',
      message: '',
      error: '',
      itemsByGroup: { ...current.itemsByGroup, [normalized.group]: items },
    }));
    return { ok: true, group: normalized.group, sourceIndexes: items.map((item) => item.sourceIndex), count: items.length };
  }, [commitImageDraft]);

  const prepareGeneratedImagesForSave = React.useCallback(async (sourceProduct = productRef.current) => {
    const current = draftRef.current;
    const currentProduct = sourceProduct || productRef.current || {};
    const shopId = String(current.shopId || '').trim();
    const productKey = String(currentProduct.id || currentProduct.sourceProductId || currentProduct.sourceUrl || '').trim();
    const prepared = await persistCollectionProductGeneratedImageSelections(
      current.generatedImageSelections,
      {
        shopId,
        productId: productKey,
        offerId: currentProduct.offerId || currentProduct.offer_id,
      },
    );
    const activeProductKey = String(productRef.current?.id || productRef.current?.sourceProductId || productRef.current?.sourceUrl || '').trim();
    if (String(draftRef.current.shopId || '').trim() !== shopId || activeProductKey !== productKey) {
      throw new Error('保存期间店铺或商品已切换，本次图片没有写入其他商品。');
    }
    const latest = draftRef.current;
    let imageGenerationHistory = latest.imageGenerationHistory;
    Object.entries(prepared.selections).forEach(([group, selection]) => {
      const entry = imageGenerationHistory.find((item) => item.id === selection.historyEntryId && item.group === group);
      if (!entry) return;
      imageGenerationHistory = upsertCollectionProductImageHistory(imageGenerationHistory, {
        ...entry,
        items: selection.items,
      });
    });
    const replacedLatest = {
      ...latest,
      images: (latest.images || []).map((url) => prepared.replacements.get(url) || url),
      skus: (latest.skus || []).map((sku) => ({
        ...sku,
        imageUrl: prepared.replacements.get(sku.imageUrl) || sku.imageUrl,
      })),
    };
    const applied = applyCollectionProductGeneratedImagesToListingDraft(
      replacedLatest,
      prepared.selections,
      currentProduct,
    );
    const next = {
      ...applied,
      imageGenerationHistory,
      generatedImageSelections: prepared.selections,
    };
    commitImageDraft(next);
    setGenerationState((state) => ({
      ...state,
      status: 'success',
      phase: 'complete',
      error: '',
      itemsByGroup: generatedItemsByGroup(prepared.selections),
    }));
    return next;
  }, [commitImageDraft]);

  const imageHistoryEntries = Array.isArray(draft.imageGenerationHistory) ? draft.imageGenerationHistory : [];
  const imageHistory = {
    status: 'ready',
    entries: imageHistoryEntries,
    imageCount: countCollectionProductImageHistoryImages(imageHistoryEntries),
    batchCount: imageHistoryEntries.length,
    shopId: draft.shopId,
    productKey: product?.id || product?.sourceProductId || product?.sourceUrl || '',
    sourceProductId: product?.sourceProductId || '',
    sourceUrl: product?.sourceUrl || '',
    productTitle: product?.title || draft.title || '',
  };

  return {
    draft,
    step,
    steps: COLLECTION_PRODUCT_LISTING_STEPS,
    stepError,
    categoryOptions,
    categoryState,
    categoryTemplateState,
    definitions,
    attributeOptions,
    attributeState,
    attributeAutofillState,
    preview,
    listingState,
    generationState,
    imageHistory,
    update,
    updateUploadShopIds,
    selectCategory,
    previewCategoryTemplate,
    updateAttribute,
    reloadAttributes,
    searchAttributeOptions,
    updateSku,
    applyPriceToEnabledSkus,
    updateSkuAttribute,
    analyzeAndFillAttributes,
    setStep,
    move,
    persist,
    getPersistenceSnapshot,
    requestPreview,
    cancelPreview,
    submit,
    resumeReadBack,
    generateImages,
    restoreImageHistoryBatch,
    updateOriginalImageSelection,
    updateGeneratedImageSelection,
    refreshImageUploadPayload,
    removeGeneratedImage,
    prepareGeneratedImagesForSave,
  };
}
