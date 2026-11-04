import React from 'react';

import { createEmptyPricingPreview } from '../lib/pricingCalculator.js';
import {
  applyCollectionActivityPricingMode,
  applyCollectionActivityPricingToGeneratedRow,
} from '../lib/collectionActivityPricing.js';
import { buildCollectionSkuPricingSummary } from '../lib/collectionSkuPricingSummary.js';
import {
  clearAllCollectionSignedSkuPricing,
  clearStaleCollectionSignedSkuPricing,
} from '../lib/collectionSkuPricingIntegrity.js';
import {
  countCollectionPricingFields,
  normalizeCollectionProductLogisticsDraft,
  normalizeCollectionProductPricingDraft,
} from '../lib/collectionProductPricingDraft.js';
import {
  calculateCollectionProductFreight,
  getCollectionPricingQuoteErrorMessage,
  listCollectionLogisticsProviders,
  listCollectionLogisticsRoutes,
} from '../services/collectionProductPricingService.js';
import {
  requestCollectionPricingQuote,
} from '../services/collectionPricingQuoteService.js';
import { generateCollectionSkuPricesWithResolvedFreight } from '../services/collectionSkuPricingWorkflowService.js';
import {
  readSavedLogisticsPricingSettings,
} from '../../../services/logisticsPricingSettingsRuntime.js';
import { resolveLogisticsPricingSelection } from '../../../services/logisticsPricingSettingsStore.js';
import { readCollectionCategoryCommission } from '../services/collectionCategoryCommissionService.js';

const IDLE_QUOTE = Object.freeze({ status: 'idle', error: '', source: '', verification: null });
const IDLE_ACTION = Object.freeze({ status: 'idle', error: '', message: '', result: null });
const IDLE_COMMISSION = Object.freeze({ status: 'idle', error: '', message: '', source: '', evidenceCount: 0 });

export function useCollectionProductPricing({ product, listingDraft, onChangeListingDraft } = {}) {
  const listingDraftRef = React.useRef(listingDraft);
  listingDraftRef.current = listingDraft;
  const pricingDraft = React.useMemo(
    () => normalizeCollectionProductPricingDraft(listingDraft?.pricingDraft, {
      ...product,
      categoryCommissionPercent: listingDraft?.categoryCommissionPercent
        ?? product?.categoryCommissionPercent,
    }),
    [listingDraft?.categoryCommissionPercent, listingDraft?.pricingDraft, product],
  );
  const logisticsDraft = React.useMemo(
    () => {
      const normalized = normalizeCollectionProductLogisticsDraft(listingDraft?.logisticsDraft);
      if (normalized.providerId) return normalized;
      const saved = resolveLogisticsPricingSelection(readSavedLogisticsPricingSettings(), { shopId: listingDraft?.shopId });
      return {
        ...normalized,
        providerId: saved.providerId === 'auto' ? '' : saved.providerId,
        routeId: saved.routeId || '',
        market: saved.market || normalized.market,
        serviceLevel: saved.serviceLevel || normalized.serviceLevel,
      };
    },
    [listingDraft?.logisticsDraft, listingDraft?.shopId],
  );
  const [pricingPreview, setPricingPreview] = React.useState(() => createEmptyPricingPreview());
  const [pricingQuoteState, setPricingQuoteState] = React.useState(() => ({ ...IDLE_QUOTE }));
  const [freightState, setFreightState] = React.useState(() => ({ ...IDLE_ACTION }));
  const [applyState, setApplyState] = React.useState(() => ({ ...IDLE_ACTION }));
  const [commissionState, setCommissionState] = React.useState(() => ({ ...IDLE_COMMISSION }));
  const quoteAbortRef = React.useRef(null);
  const applyAbortRef = React.useRef(null);
  const commissionAbortRef = React.useRef(null);
  const autoFreightKeyRef = React.useRef('');

  React.useEffect(() => () => {
    quoteAbortRef.current?.abort();
    applyAbortRef.current?.abort();
    commissionAbortRef.current?.abort();
  }, []);

  const staleSignedPricingSignature = React.useMemo(() => JSON.stringify(
    (listingDraft?.skus || []).map((sku) => [
      sku?.sourceSkuId,
      sku?.sourcePriceCny,
      sku?.firstMileCostCny,
      sku?.freightCostCny,
      sku?.pricingSnapshot?.quoteSource,
      sku?.pricingSnapshot?.inputKey,
    ]),
  ), [listingDraft?.skus]);

  React.useEffect(() => {
    const current = listingDraftRef.current || {};
    const cleared = clearStaleCollectionSignedSkuPricing(current.skus, pricingDraft);
    if (cleared.changed) onChangeListingDraft?.({ skus: cleared.skus });
  }, [onChangeListingDraft, pricingDraft, staleSignedPricingSignature]);

  React.useEffect(() => {
    commissionAbortRef.current?.abort();
    const shopId = String(listingDraft?.shopId || '').trim();
    const descriptionCategoryId = String(listingDraft?.descriptionCategoryId || '').trim();
    const typeId = String(listingDraft?.typeId || '').trim();
    const savedSource = String(listingDraft?.categoryCommissionSource || '').trim();
    const savedPercent = Number(listingDraft?.categoryCommissionPercent);
    const pricingPercent = Number(listingDraft?.pricingDraft?.ozonFeePercent);
    if (!shopId || !descriptionCategoryId || !typeId) {
      setCommissionState({ ...IDLE_COMMISSION });
      return undefined;
    }
    if (savedSource === 'manual') {
      setCommissionState({
        status: 'manual', error: '', message: '当前使用手动填写的类目扣点。', source: 'manual', evidenceCount: 0,
      });
      return undefined;
    }
    if (
      savedSource === 'ozon-product-commission-snapshot'
      && Number.isFinite(savedPercent)
      && savedPercent > 0
      && savedPercent === pricingPercent
    ) {
      setCommissionState({
        status: 'ready', error: '', message: '已读取当前店铺同类 Ozon 商品佣金。',
        source: savedSource, evidenceCount: Number(listingDraft?.categoryCommissionEvidenceCount) || 0,
      });
      return undefined;
    }
    const controller = new AbortController();
    commissionAbortRef.current = controller;
    setCommissionState({ status: 'loading', error: '', message: '正在读取类目扣点…', source: '', evidenceCount: 0 });
    readCollectionCategoryCommission({ shopId, descriptionCategoryId, typeId }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.status !== 'ready' || !Number.isFinite(result.percent)) {
          setCommissionState({
            status: result.status, error: '', message: result.message || '类目扣点读取失败，请手动填写。',
            source: result.source || '', evidenceCount: result.evidenceCount || 0,
          });
          return;
        }
        const percent = String(result.percent);
        setCommissionState({
          status: 'ready', error: '', message: result.message, source: result.source,
          evidenceCount: result.evidenceCount || 0,
        });
        const commissionChanged = String(listingDraftRef.current?.pricingDraft?.ozonFeePercent || '') !== percent;
        const cleared = commissionChanged
          ? clearAllCollectionSignedSkuPricing(listingDraftRef.current?.skus)
          : { changed: false, skus: listingDraftRef.current?.skus || [] };
        onChangeListingDraft?.({
          categoryCommissionPercent: percent,
          categoryCommissionSource: result.source,
          categoryCommissionEvidenceCount: result.evidenceCount || 0,
          pricingDraft: { ...listingDraftRef.current?.pricingDraft, ozonFeePercent: percent },
          ...(cleared.changed ? { skus: cleared.skus } : {}),
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setCommissionState({
          status: 'error', error: error instanceof Error ? error.message : '类目扣点读取失败。',
          message: '自动读取失败，请手动填写。', source: '', evidenceCount: 0,
        });
      });
    return () => controller.abort();
  }, [
    listingDraft?.categoryCommissionEvidenceCount,
    listingDraft?.categoryCommissionPercent,
    listingDraft?.categoryCommissionSource,
    listingDraft?.descriptionCategoryId,
    listingDraft?.pricingDraft?.ozonFeePercent,
    listingDraft?.shopId,
    listingDraft?.typeId,
    onChangeListingDraft,
  ]);

  const invalidateQuote = React.useCallback(() => {
    quoteAbortRef.current?.abort();
    setPricingPreview(createEmptyPricingPreview());
    setPricingQuoteState({ ...IDLE_QUOTE });
    setApplyState({ ...IDLE_ACTION });
  }, []);

  const changePricingField = React.useCallback((field) => (event) => {
    const value = event?.target?.value ?? '';
    const next = { ...pricingDraft, [field]: value };
    if (String(value).trim() && field === 'expectedProfitCny') next.targetMarginPercent = '';
    if (String(value).trim() && field === 'targetMarginPercent') next.expectedProfitCny = '';
    const cleared = clearAllCollectionSignedSkuPricing(listingDraftRef.current?.skus);
    onChangeListingDraft?.(field === 'ozonFeePercent' ? {
      pricingDraft: next,
      categoryCommissionPercent: value,
      categoryCommissionSource: String(value).trim() ? 'manual' : '',
      categoryCommissionEvidenceCount: 0,
      ...(cleared.changed ? { skus: cleared.skus } : {}),
    } : { pricingDraft: next, ...(cleared.changed ? { skus: cleared.skus } : {}) });
    invalidateQuote();
  }, [invalidateQuote, onChangeListingDraft, pricingDraft]);

  const changeLogistics = React.useCallback((changes) => {
    const next = { ...logisticsDraft, ...changes };
    if (Object.prototype.hasOwnProperty.call(changes, 'providerId')) next.routeId = '';
    const cleared = clearAllCollectionSignedSkuPricing(listingDraftRef.current?.skus);
    onChangeListingDraft?.({ logisticsDraft: next, ...(cleared.changed ? { skus: cleared.skus } : {}) });
    setFreightState({ ...IDLE_ACTION });
    invalidateQuote();
  }, [invalidateQuote, logisticsDraft, onChangeListingDraft]);

  const toggleActivityPriceUpload = React.useCallback(() => {
    const current = listingDraftRef.current || {};
    const enabled = current.activityPriceUpload !== true;
    onChangeListingDraft?.({
      activityPriceUpload: enabled,
      skus: applyCollectionActivityPricingMode(current.skus, enabled),
    });
    setApplyState({ ...IDLE_ACTION });
    return enabled;
  }, [onChangeListingDraft]);

  const calculateFreight = React.useCallback(() => {
    const result = calculateCollectionProductFreight({ product, listingDraft, pricingDraft, logisticsDraft });
    if (!result.ok) {
      setFreightState({ status: 'error', error: result.reason || '物流费测算失败。', message: '', result });
      return result;
    }
    const nextPricingDraft = { ...pricingDraft, firstMileCost: String(Number(result.amount.toFixed(2))) };
    const freightChanged = String(pricingDraft.firstMileCost || '') !== nextPricingDraft.firstMileCost;
    const cleared = freightChanged
      ? clearAllCollectionSignedSkuPricing(listingDraftRef.current?.skus)
      : { changed: false, skus: listingDraftRef.current?.skus || [] };
    onChangeListingDraft?.({ pricingDraft: nextPricingDraft, ...(cleared.changed ? { skus: cleared.skus } : {}) });
    invalidateQuote();
    setFreightState({
      status: 'success', error: '', result,
      message: '',
    });
    return result;
  }, [invalidateQuote, listingDraft, logisticsDraft, onChangeListingDraft, pricingDraft, product]);

  React.useEffect(() => {
    const providerId = String(logisticsDraft.providerId || '').trim();
    if (!providerId || String(logisticsDraft.routeId || '').trim()) return undefined;
    const activeSku = (listingDraft?.skus || []).find((item) => item?.enabled !== false) || {};
    const weightG = activeSku.weightG || listingDraft?.weightG || product?.weightG;
    const lengthCm = activeSku.packageLengthCm || listingDraft?.packageLengthCm || product?.packageLengthCm;
    const widthCm = activeSku.packageWidthCm || listingDraft?.packageWidthCm || product?.packageWidthCm;
    const heightCm = activeSku.packageHeightCm || listingDraft?.packageHeightCm || product?.packageHeightCm;
    if (![weightG, lengthCm, widthCm, heightCm].every((value) => Number(value) > 0)) return undefined;
    const key = [
      providerId,
      logisticsDraft.market || 'RU',
      logisticsDraft.serviceLevel || 'auto',
      weightG,
      lengthCm,
      widthCm,
      heightCm,
      activeSku.sourcePriceCny || product?.purchasePrice || pricingDraft.purchaseCost || '',
    ].join('|');
    if (autoFreightKeyRef.current === key) return undefined;
    autoFreightKeyRef.current = key;
    const result = calculateCollectionProductFreight({
      product,
      listingDraft,
      pricingDraft,
      logisticsDraft,
      sku: activeSku,
    });
    if (!result?.ok) {
      setFreightState({ status: 'error', error: result?.reason || '物流费测算失败。', message: '', result });
      return undefined;
    }
    const amount = String(Number(result.amount.toFixed(2)));
    setFreightState({
      status: 'success', error: '', result,
      message: '',
    });
    if (String(pricingDraft.firstMileCost || '') !== amount) {
      const cleared = clearAllCollectionSignedSkuPricing(listingDraftRef.current?.skus);
      onChangeListingDraft?.({
        pricingDraft: { ...pricingDraft, firstMileCost: amount },
        ...(cleared.changed ? { skus: cleared.skus } : {}),
      });
      invalidateQuote();
    }
    return undefined;
  }, [
    invalidateQuote,
    listingDraft,
    logisticsDraft,
    onChangeListingDraft,
    pricingDraft,
    product,
  ]);

  const requestQuote = React.useCallback(async () => {
    quoteAbortRef.current?.abort();
    const controller = new AbortController();
    quoteAbortRef.current = controller;
    setPricingQuoteState({ status: 'pending', error: '', source: '', verification: null });
    setPricingPreview(createEmptyPricingPreview());
    try {
      const result = await requestCollectionPricingQuote(pricingDraft, { signal: controller.signal });
      if (controller.signal.aborted) return null;
      setPricingPreview(result.preview);
      setPricingQuoteState({ status: 'success', error: '', source: result.source, verification: result.verification });
      return result;
    } catch (error) {
      if (controller.signal.aborted) return null;
      setPricingPreview(createEmptyPricingPreview());
      setPricingQuoteState({ status: 'error', error: getCollectionPricingQuoteErrorMessage(error), source: '', verification: null });
      return null;
    }
  }, [pricingDraft]);

  const applySuggestedPrice = React.useCallback(async () => {
    applyAbortRef.current?.abort();
    const controller = new AbortController();
    applyAbortRef.current = controller;
    setApplyState({ status: 'pending', error: '', message: '', result: null });
    try {
      const outcome = await generateCollectionSkuPricesWithResolvedFreight({
        product,
        listingDraft,
        pricingDraft,
        logisticsDraft,
        signal: controller.signal,
        concurrency: 4,
      });
      if (controller.signal.aborted || !outcome) return null;
      const { freightRows, generated, skusWithFreight } = outcome;
      const generatedByKey = new Map(generated.rows.map((item) => [
        `${item.sourceSkuId}::${item.offerId}`,
        item,
      ]));
      const skus = skusWithFreight.map((item) => {
        if (item.enabled === false) return item;
        const generatedRow = generatedByKey.get(`${item.sourceSkuId || ''}::${item.offerId || ''}`);
        if (!generatedRow) return item;
        const pricedRow = applyCollectionActivityPricingToGeneratedRow(
          generatedRow,
          listingDraftRef.current?.activityPriceUpload === true,
        );
        return {
          ...item,
          priceCny: String(pricedRow.priceCny),
          oldPriceCny: String(pricedRow.oldPriceCny),
          minPriceCny: String(pricedRow.minPriceCny),
          price: '',
          oldPrice: '',
          minPrice: '',
          pricingSnapshot: pricedRow.pricingSnapshot,
        };
      });
      const freightAmounts = [...new Set(freightRows.map((item) => Number(item.result.amount.toFixed(2))))];
      const nextPricingDraft = freightAmounts.length === 1
        ? { ...pricingDraft, firstMileCost: String(freightAmounts[0]) }
        : pricingDraft;
      onChangeListingDraft?.({ skus, pricingDraft: nextPricingDraft });
      setFreightState({
        status: 'success', error: '', result: freightRows,
        message: '',
      });
      setApplyState({
        status: 'success', error: '', result: generated,
        message: '',
      });
      return generated;
    } catch (error) {
      if (controller.signal.aborted) return null;
      setApplyState({ status: 'error', error: getCollectionPricingQuoteErrorMessage(error), message: '', result: null });
      return null;
    }
  }, [listingDraft, logisticsDraft, onChangeListingDraft, pricingDraft, product]);

  const providers = React.useMemo(() => listCollectionLogisticsProviders(), []);
  const routes = React.useMemo(
    () => listCollectionLogisticsRoutes(logisticsDraft.providerId, logisticsDraft.market, logisticsDraft.serviceLevel),
    [logisticsDraft.market, logisticsDraft.providerId, logisticsDraft.serviceLevel],
  );
  const summary = React.useMemo(() => buildCollectionSkuPricingSummary({
    listingDraft,
    logisticsDraft,
    pricingDraft,
    pricingPreview,
    providers,
    routes,
  }), [listingDraft, logisticsDraft, pricingDraft, pricingPreview, providers, routes]);
  const profitTargetMode = Number(pricingDraft.expectedProfitCny) > 0
    ? 'amount'
    : Number(pricingDraft.targetMarginPercent) > 0 ? 'margin' : 'amount';

  return {
    pricingDraft,
    logisticsDraft,
    pricingPreview,
    pricingQuoteState,
    freightState,
    applyState,
    commissionState,
    providers,
    routes,
    summary,
    filledFieldCount: countCollectionPricingFields(pricingDraft),
    canRequestQuote: Number(pricingDraft.purchaseCost) > 0,
    canGenerateSkuPrices: (Number(pricingDraft.expectedProfitCny) > 0
      || Number(pricingDraft.targetMarginPercent) > 0)
      && (listingDraft?.skus || []).some((item) => item?.enabled !== false && Number(item.sourcePriceCny) > 0),
    profitTargetMode,
    activityPriceUpload: listingDraft?.activityPriceUpload === true,
    changePricingField,
    changeLogistics,
    toggleActivityPriceUpload,
    calculateFreight,
    requestQuote,
    applySuggestedPrice,
  };
}
