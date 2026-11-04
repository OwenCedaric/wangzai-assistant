import React from 'react';

import { emptyCollectorDraft } from '../constants/collectionPricingRules.js';
import { normalizeCollectedProduct } from '../lib/collectionProductNormalizer.js';
import { assertCollectedProductUsable } from '../lib/collectionProductValidation.js';
import {
  captureCurrentCollectionProduct,
  collectCollectionProductFromLink,
  getCollectionBrowserErrorMessage,
  openCollectionSourceInBrowser,
} from '../services/collectionBrowserService.js';
import { subscribeCollectionBrowserCapture } from '../services/collectionBrowserCaptureInbox.js';
import {
  COLLECTION_PRICING_DRAFT_LIMIT,
  loadCollectionPricingDraft,
  saveCollectionPricingDraft,
} from '../services/collectionPricingDraftStore.js';
import {
  backfillCollectionProductPublications,
  collectCollectionProductPublicationCandidates,
} from '../services/collectionProductPublicationBackfillService.js';

const EMPTY_BROWSER_STATE = Object.freeze({ status: 'idle', error: '', message: '', tabId: '' });

function scopeKey(value = '') {
  return String(value || '').trim() || 'local-default';
}

export function useCollectionPricingDraft({ ownerScopeKey = '', shops = [] } = {}) {
  const resolvedOwnerScopeKey = scopeKey(ownerScopeKey);
  const [collectionMode, setCollectionModeState] = React.useState('browser');
  const [collectorDraft, setCollectorDraft] = React.useState(() => ({ ...emptyCollectorDraft }));
  const [collectionItems, setCollectionItems] = React.useState([]);
  const [selectedCollectionId, setSelectedCollectionId] = React.useState('');
  const [browserState, setBrowserState] = React.useState(() => ({ ...EMPTY_BROWSER_STATE }));
  const [copyMessage, setCopyMessage] = React.useState('');
  const [collectionPersistenceError, setCollectionPersistenceError] = React.useState('');
  const collectionItemsRef = React.useRef([]);
  const collectionTouchedRef = React.useRef(false);
  const collectionPersistenceRequestRef = React.useRef(0);
  const ownerScopeRef = React.useRef(resolvedOwnerScopeKey);
  const publicationBackfillSignatureRef = React.useRef('');
  ownerScopeRef.current = resolvedOwnerScopeKey;

  const setCollectionMode = React.useCallback((mode) => {
    setCollectionModeState(mode === 'link' ? 'link' : 'browser');
    setBrowserState({ ...EMPTY_BROWSER_STATE });
  }, []);

  const persistCollectionItems = React.useCallback((items, requestedScope = ownerScopeRef.current) => {
    const requestId = collectionPersistenceRequestRef.current + 1;
    collectionPersistenceRequestRef.current = requestId;
    return saveCollectionPricingDraft(items, requestedScope)
      .then(() => {
        if (
          collectionPersistenceRequestRef.current === requestId
          && ownerScopeRef.current === requestedScope
        ) setCollectionPersistenceError('');
        return true;
      })
      .catch(() => {
        if (
          collectionPersistenceRequestRef.current === requestId
          && ownerScopeRef.current === requestedScope
        ) {
          setCollectionPersistenceError('采集列表保存失败，请不要关闭软件并重试一次采集或编辑。');
        }
        return false;
      });
  }, []);

  const replaceCollectionItems = React.useCallback((updater, { persist = true, touched = true } = {}) => {
    const next = (typeof updater === 'function' ? updater(collectionItemsRef.current) : updater)
      .slice(0, COLLECTION_PRICING_DRAFT_LIMIT);
    collectionItemsRef.current = next;
    if (touched) collectionTouchedRef.current = true;
    setCollectionItems(next);
    if (persist) persistCollectionItems(next);
    return next;
  }, [persistCollectionItems]);

  const updateCollectorDraft = React.useCallback((field) => (event) => {
    setCollectorDraft((current) => ({ ...current, [field]: event.target.value }));
    setCopyMessage('');
  }, []);

  const commitCollectedProduct = React.useCallback((captured) => {
    const product = normalizeCollectedProduct(captured?.product || captured || {});
    assertCollectedProductUsable(product);
    replaceCollectionItems((current) => {
      const existing = current.findIndex((item) => item.id === product.id);
      if (existing < 0) return [product, ...current];
      const next = [...current];
      next[existing] = product;
      return next;
    });
    setSelectedCollectionId(product.id);
    return product;
  }, [replaceCollectionItems]);

  const completeCollectionCapture = React.useCallback((captured, {
    mode,
    messagePrefix,
    tabId = '',
  } = {}) => {
    const product = commitCollectedProduct(captured);
    if (mode) setCollectionModeState(mode);
    setBrowserState({
      status: 'success',
      error: '',
      message: `${messagePrefix || '已加入采集列表'}：${product.title || product.sourceProductId}`,
      tabId: String(tabId || captured?.tabId || ''),
    });
    return product;
  }, [commitCollectedProduct]);

  const openCollectionBrowser = React.useCallback(async (kind = 'source') => {
    setBrowserState({ status: 'opening', error: '', message: '', tabId: '' });
    try {
      const response = await openCollectionSourceInBrowser({
        sourcePlatform: kind === 'competitor' ? 'ozon-buyer' : collectorDraft.sourcePlatform,
        sourceUrl: kind === 'competitor' ? collectorDraft.competitorUrl : collectorDraft.sourceUrl,
      });
      setBrowserState({
        status: 'ready',
        error: '',
        message: '已在内置浏览器打开，进入商品详情后点击“采集当前商品”。',
        tabId: String(response?.state?.activeTabId || response?.activeTabId || ''),
      });
    } catch (error) {
      setBrowserState({ status: 'error', error: getCollectionBrowserErrorMessage(error), message: '', tabId: '' });
    }
  }, [collectorDraft.competitorUrl, collectorDraft.sourcePlatform, collectorDraft.sourceUrl]);

  const captureCollectionProduct = React.useCallback(async () => {
    setBrowserState({ status: 'capturing', error: '', message: '', tabId: '' });
    try {
      const captured = await captureCurrentCollectionProduct();
      completeCollectionCapture(captured, {
        mode: 'browser',
        messagePrefix: '已加入采集列表',
      });
    } catch (error) {
      setBrowserState({ status: 'error', error: getCollectionBrowserErrorMessage(error), message: '', tabId: '' });
    }
  }, [completeCollectionCapture]);

  const collectProductLink = React.useCallback(async () => {
    setBrowserState({ status: 'link-collecting', error: '', message: '正在打开链接并分析商品页…', tabId: '' });
    try {
      const captured = await collectCollectionProductFromLink(collectorDraft.sourceUrl);
      completeCollectionCapture(captured, {
        mode: 'link',
        messagePrefix: '链接采集完成，已加入列表',
      });
    } catch (error) {
      setBrowserState({ status: 'error', error: getCollectionBrowserErrorMessage(error), message: '', tabId: '' });
    }
  }, [collectorDraft.sourceUrl, completeCollectionCapture]);

  const selectCollectionItem = React.useCallback((itemOrId) => {
    const id = typeof itemOrId === 'string' ? itemOrId : itemOrId?.id;
    if (collectionItemsRef.current.some((item) => item.id === id)) setSelectedCollectionId(id);
  }, []);

  const openCollectionItemSource = React.useCallback(async (itemOrId) => {
    const id = typeof itemOrId === 'string' ? itemOrId : itemOrId?.id;
    const product = typeof itemOrId === 'object'
      ? itemOrId
      : collectionItemsRef.current.find((item) => item.id === id);
    if (!product?.sourceUrl) return;
    setBrowserState({ status: 'opening', error: '', message: '', tabId: '' });
    try {
      const response = await openCollectionSourceInBrowser({
        sourcePlatform: product.platformCode,
        sourceUrl: product.sourceUrl,
      });
      setBrowserState({
        status: 'ready',
        error: '',
        message: '已在内置浏览器打开商品来源。',
        tabId: String(response?.state?.activeTabId || response?.activeTabId || ''),
      });
    } catch (error) {
      setBrowserState({ status: 'error', error: getCollectionBrowserErrorMessage(error), message: '', tabId: '' });
    }
  }, []);

  const removeCollectionItem = React.useCallback((id) => {
    replaceCollectionItems((current) => current.filter((item) => item.id !== id));
    setSelectedCollectionId((current) => (current === id ? '' : current));
    setCopyMessage('已删除采集商品，并同步更新当前用户的采集列表。');
  }, [replaceCollectionItems]);

  const editCollectionItem = React.useCallback((id, changes = {}) => {
    const next = replaceCollectionItems((current) => current.map((item) => {
      if (item.id !== id) return item;
      const normalized = normalizeCollectedProduct({ ...item, ...changes });
      assertCollectedProductUsable(normalized);
      return normalized;
    }), { persist: false });
    setSelectedCollectionId(id);
    setCopyMessage('采集商品已更新。');
    return persistCollectionItems(next);
  }, [persistCollectionItems, replaceCollectionItems]);

  const clearDraft = React.useCallback(() => {
    setCollectorDraft({ ...emptyCollectorDraft });
    setCollectionModeState('browser');
    replaceCollectionItems([]);
    setSelectedCollectionId('');
    setBrowserState({ ...EMPTY_BROWSER_STATE });
    setCopyMessage('已清空当前用户的采集列表，未影响其他用户和 Ozon 商品。');
  }, [replaceCollectionItems]);

  React.useEffect(() => {
    const requestedScope = resolvedOwnerScopeKey;
    collectionPersistenceRequestRef.current += 1;
    collectionItemsRef.current = [];
    collectionTouchedRef.current = false;
    publicationBackfillSignatureRef.current = '';
    setCollectionItems([]);
    setSelectedCollectionId('');
    setCollectionPersistenceError('');
    let active = true;
    loadCollectionPricingDraft(requestedScope)
      .then((storedItems) => {
        if (!active || ownerScopeRef.current !== requestedScope) return;
        const restored = storedItems
          .map((item) => normalizeCollectedProduct(item))
          .filter((item) => {
            try {
              assertCollectedProductUsable(item);
              return true;
            } catch {
              return false;
            }
          });
        const migrationNeeded = JSON.stringify(restored) !== JSON.stringify(storedItems);
        if (collectionTouchedRef.current) {
          const currentIds = new Set(collectionItemsRef.current.map((item) => item.id));
          const merged = [
            ...collectionItemsRef.current,
            ...restored.filter((item) => !currentIds.has(item.id)),
          ].slice(0, COLLECTION_PRICING_DRAFT_LIMIT);
          replaceCollectionItems(merged);
          return;
        }
        collectionItemsRef.current = restored;
        setCollectionItems(restored);
        setSelectedCollectionId(restored[0]?.id || '');
        if (migrationNeeded) persistCollectionItems(restored, requestedScope);
      })
      .catch(() => {
        if (active && ownerScopeRef.current === requestedScope) {
          setCollectionPersistenceError('当前用户的本地采集列表读取失败，本次新采集数据仍会继续尝试保存。');
        }
      });
    return () => { active = false; };
  }, [persistCollectionItems, replaceCollectionItems, resolvedOwnerScopeKey]);

  const publicationBackfillSignature = React.useMemo(() => JSON.stringify(
    collectCollectionProductPublicationCandidates(collectionItems, shops).map((candidate) => [
      candidate.productId,
      candidate.shopId,
      candidate.offerIds,
    ]),
  ), [collectionItems, shops]);

  React.useEffect(() => {
    if (publicationBackfillSignature === '[]') return undefined;
    const requestedScope = resolvedOwnerScopeKey;
    const runSignature = `${requestedScope}:${publicationBackfillSignature}`;
    if (publicationBackfillSignatureRef.current === runSignature) return undefined;
    publicationBackfillSignatureRef.current = runSignature;
    const abortController = new AbortController();
    backfillCollectionProductPublications(collectionItemsRef.current, shops, {
      signal: abortController.signal,
    }).then(({ patches }) => {
      if (
        abortController.signal.aborted
        || ownerScopeRef.current !== requestedScope
        || !patches.length
      ) return;
      const patchesByProductId = new Map(patches.map((patch) => [patch.productId, patch.ozonPublication]));
      replaceCollectionItems((current) => current.map((item) => (
        patchesByProductId.has(item.id)
          ? { ...item, ozonPublication: patchesByProductId.get(item.id) }
          : item
      )), { persist: true, touched: false });
    }).catch(() => {
      // The list remains usable when the local Ozon cache is temporarily unavailable.
      // A later page open retries the migration; never guess an uploaded state.
    });
    return () => abortController.abort();
  }, [publicationBackfillSignature, replaceCollectionItems, resolvedOwnerScopeKey, shops]);

  React.useEffect(() => subscribeCollectionBrowserCapture((capture) => {
    try {
      completeCollectionCapture(capture, {
        mode: 'browser',
        messagePrefix: '已从浏览器加入采集列表',
      });
    } catch (error) {
      setBrowserState({ status: 'error', error: getCollectionBrowserErrorMessage(error), message: '', tabId: '' });
    }
  }), [completeCollectionCapture]);

  return {
    collectionMode,
    collectorDraft,
    collectionItems,
    selectedCollectionId,
    browserState,
    copyMessage,
    collectionPersistenceError,
    updateCollectorDraft,
    setCollectionMode,
    openCollectionBrowser,
    captureCollectionProduct,
    collectProductLink,
    selectCollectionItem,
    openCollectionItemSource,
    editCollectionItem,
    removeCollectionItem,
    clearDraft,
  };
}
