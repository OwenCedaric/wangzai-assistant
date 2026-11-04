import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLicenseRuntime } from '../../licensing/services/licenseCenterClient.js';
import { IMAGE_COUNTS, POINTS_IMAGE_MODELS, POINTS_PACKAGE_TABS } from '../constants/pointsPackageCatalog.js';
import { estimatePackageLinks, getPointsImageModel, getPointsPerLink } from '../lib/pointsPackagePricing.js';
import {
  beginPointsCheckout,
  completePointsDevelopmentCheckout,
  createPointsOrderIdempotencyKey,
  loadPointPackageCatalog,
  loadPointsAccount,
  pointOrderIsFulfilled,
  queryPointsCheckout,
  readPointsOrder,
} from '../services/pointsPackagePaymentService.js';
import {
  createModelPresetDraft,
  loadPointsModelPresets,
  savePointsModelPresets,
} from '../services/pointsPackageModelPresetService.js';

export const POINT_PACKAGE_CATALOG_REFRESH_MS = 60_000;

function preferredProvider(packageItem) {
  const available = packageItem?.paymentProviders || [];
  return ['alipay', 'wechat', 'development'].find((item) => available.includes(item)) || '';
}

export function usePointsPackagesModel() {
  const [activeTab, setActiveTab] = useState(POINTS_PACKAGE_TABS[0].id);
  const [imageModelId, setImageModelId] = useState(POINTS_IMAGE_MODELS[0].id);
  const [imageCount, setImageCount] = useState(16);
  const [includeRetryReserve, setIncludeRetryReserve] = useState(true);
  const [packageCatalog, setPackageCatalog] = useState([]);
  const [wallet, setWallet] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedPackageId, setSelectedPackageId] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState('');
  const [paymentError, setPaymentError] = useState('');
  const [paymentState, setPaymentState] = useState('idle');
  const [checkout, setCheckout] = useState(null);
  const [expandedFaqIndex, setExpandedFaqIndex] = useState(0);
  const [modelPreset, setModelPreset] = useState(null);
  const [modelPresetDraft, setModelPresetDraft] = useState([]);
  const [modelPresetOpen, setModelPresetOpen] = useState(false);
  const [modelPresetLoading, setModelPresetLoading] = useState(false);
  const [modelPresetSaving, setModelPresetSaving] = useState(false);
  const [modelPresetError, setModelPresetError] = useState('');
  const runtimeRef = useRef(null);
  const paymentSessionRef = useRef(0);
  const paymentRequestPendingRef = useRef(false);

  const imageModel = useMemo(() => getPointsImageModel(imageModelId), [imageModelId]);
  const imageModels = useMemo(() => {
    const imageGroup = modelPreset?.groups?.find((group) => group.capabilityKind === 'image');
    if (!imageGroup) return POINTS_IMAGE_MODELS;
    const enabled = new Set(imageGroup.enabledModels);
    const filtered = POINTS_IMAGE_MODELS.filter((item) => enabled.has(item.model));
    return filtered.length ? filtered : POINTS_IMAGE_MODELS;
  }, [modelPreset]);
  const enabledModelCount = useMemo(
    () => (modelPreset?.groups || []).reduce((sum, group) => sum + group.enabledModels.length, 0),
    [modelPreset]
  );
  const pointsPerLink = useMemo(
    () => getPointsPerLink({ modelId: imageModelId, imageCount, includeRetryReserve }),
    [imageModelId, imageCount, includeRetryReserve]
  );
  const packages = useMemo(
    () =>
      packageCatalog.map((packageItem) => ({
        ...packageItem,
        estimatedLinks: estimatePackageLinks({ packagePoints: packageItem.points, pointsPerLink }),
      })),
    [packageCatalog, pointsPerLink]
  );
  const selectedPackage = useMemo(
    () => packages.find((item) => item.id === selectedPackageId) || null,
    [packages, selectedPackageId]
  );

  const refreshAccount = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    setLoadError('');
    try {
      const runtime = runtimeRef.current || (await getLicenseRuntime());
      runtimeRef.current = runtime;
      const result = await loadPointsAccount(runtime);
      setPackageCatalog(result.packages);
      setWallet(result.wallet);
      setLedger(result.ledger);
      return result;
    } catch (error) {
      setLoadError(error?.message || '积分套餐加载失败，请检查授权服务连接');
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const refreshPackageCatalog = useCallback(async () => {
    try {
      const runtime = runtimeRef.current || (await getLicenseRuntime());
      runtimeRef.current = runtime;
      const nextCatalog = await loadPointPackageCatalog(runtime);
      setPackageCatalog(nextCatalog);
      return nextCatalog;
    } catch {
      // 保留当前已展示目录；完整错误仍由手工刷新统一呈现。
      return null;
    }
  }, []);

  const refreshModelPreset = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setModelPresetLoading(true);
    setModelPresetError('');
    try {
      const runtime = runtimeRef.current || (await getLicenseRuntime());
      runtimeRef.current = runtime;
      const nextPreset = await loadPointsModelPresets(runtime);
      setModelPreset(nextPreset);
      return nextPreset;
    } catch (error) {
      setModelPresetError(error?.message || '模型预设读取失败，请检查授权服务连接');
      return null;
    } finally {
      if (!quiet) setModelPresetLoading(false);
    }
  }, []);

  useEffect(() => {
    if (imageModels.some((item) => item.id === imageModelId)) return;
    const imageGroup = modelPreset?.groups?.find((group) => group.capabilityKind === 'image');
    const preferred = imageModels.find((item) => item.model === imageGroup?.defaultModel) || imageModels[0];
    if (preferred) setImageModelId(preferred.id);
  }, [imageModelId, imageModels, modelPreset]);

  useEffect(() => {
    let active = true;
    const refreshQuietly = () => {
      if (!active || document.visibilityState === 'hidden') return;
      void refreshPackageCatalog();
    };
    (async () => {
      const runtime = await getLicenseRuntime().catch(() => null);
      if (!active) return;
      runtimeRef.current = runtime;
      await Promise.all([refreshAccount(), refreshModelPreset()]);
    })();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshQuietly();
    };
    window.addEventListener('focus', refreshQuietly);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const refreshTimer = window.setInterval(refreshQuietly, POINT_PACKAGE_CATALOG_REFRESH_MS);

    return () => {
      active = false;
      window.clearInterval(refreshTimer);
      window.removeEventListener('focus', refreshQuietly);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshAccount, refreshModelPreset, refreshPackageCatalog]);

  const openModelPreset = useCallback(() => {
    setModelPresetDraft(createModelPresetDraft(modelPreset));
    setModelPresetError('');
    setModelPresetOpen(true);
    if (!modelPreset) void refreshModelPreset();
  }, [modelPreset, refreshModelPreset]);

  useEffect(() => {
    if (!modelPresetOpen || !modelPreset) return;
    setModelPresetDraft(createModelPresetDraft(modelPreset));
  }, [modelPreset, modelPresetOpen]);

  const closeModelPreset = useCallback(() => {
    if (modelPresetSaving) return;
    setModelPresetOpen(false);
    setModelPresetError('');
  }, [modelPresetSaving]);

  const toggleModelPreset = useCallback((capabilityKind, modelCode) => {
    setModelPresetDraft((current) =>
      current.map((group) => {
        if (group.capabilityKind !== capabilityKind) return group;
        const enabled = group.enabledModels.includes(modelCode);
        if (enabled && group.enabledModels.length === 1) return group;
        const enabledModels = enabled
          ? group.enabledModels.filter((item) => item !== modelCode)
          : [...group.enabledModels, modelCode];
        return {
          ...group,
          enabledModels,
          defaultModel: enabledModels.includes(group.defaultModel) ? group.defaultModel : enabledModels[0] || '',
        };
      })
    );
  }, []);

  const setDefaultPresetModel = useCallback((capabilityKind, modelCode) => {
    setModelPresetDraft((current) =>
      current.map((group) =>
        group.capabilityKind === capabilityKind && group.enabledModels.includes(modelCode)
          ? { ...group, defaultModel: modelCode }
          : group
      )
    );
  }, []);

  const saveModelPreset = useCallback(async () => {
    if (modelPresetSaving || modelPresetDraft.length !== 2) return;
    setModelPresetSaving(true);
    setModelPresetError('');
    try {
      const runtime = runtimeRef.current || (await getLicenseRuntime());
      runtimeRef.current = runtime;
      const saved = await savePointsModelPresets(runtime, modelPresetDraft);
      setModelPreset(saved);
      setModelPresetOpen(false);
    } catch (error) {
      setModelPresetError(error?.message || '模型预设保存失败');
    } finally {
      setModelPresetSaving(false);
    }
  }, [modelPresetDraft, modelPresetSaving]);

  const finishCheckout = useCallback(
    async (order) => {
      if (!pointOrderIsFulfilled(order)) return false;
      setPaymentState('succeeded');
      setPaymentError('');
      await refreshAccount({ quiet: true });
      return true;
    },
    [refreshAccount]
  );

  useEffect(() => {
    if (paymentState !== 'awaiting' || !checkout?.order?.id) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const order = await queryPointsCheckout(checkout.order.id);
        if (cancelled) return;
        setCheckout((current) => (current ? { ...current, order } : current));
        if (await finishCheckout(order)) return;
        if (['closed', 'payment_failed', 'refunded'].includes(order?.status)) {
          setPaymentState('failed');
          setPaymentError('订单未完成支付，请重新选择套餐。');
        }
      } catch (error) {
        if (!cancelled) setPaymentError(error?.message || '支付状态查询失败，正在继续重试');
      }
    };
    // Keep the automatic query loop below the server's default 20/minute
    // per-order guard while still reflecting a successful payment quickly.
    const timer = setInterval(poll, 3500);
    poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [checkout?.order?.id, finishCheckout, paymentState]);

  const openPayment = useCallback(
    async (packageId) => {
      if (paymentRequestPendingRef.current) return;
      const packageItem = packages.find((item) => item.id === packageId);
      const provider = preferredProvider(packageItem);
      const paymentSession = paymentSessionRef.current + 1;
      paymentSessionRef.current = paymentSession;
      paymentRequestPendingRef.current = true;
      setSelectedPackageId(packageId);
      setPaymentMethod(provider);
      setPaymentError('');
      setPaymentState('creating');
      setCheckout(null);
      try {
        if (!packageItem?.id || !provider) throw new Error('当前套餐没有可用的支付渠道');
        const runtime = runtimeRef.current || (await getLicenseRuntime());
        runtimeRef.current = runtime;
        const result = await beginPointsCheckout({
          runtime,
          packageItem,
          provider,
          idempotencyKey: createPointsOrderIdempotencyKey(packageId),
        });
        if (paymentSessionRef.current !== paymentSession) return;
        setCheckout(result);
        setPaymentState('awaiting');
      } catch (error) {
        if (paymentSessionRef.current !== paymentSession) return;
        setPaymentState('failed');
        setPaymentError(error?.message || '订单创建失败，请返回后重试');
      } finally {
        if (paymentSessionRef.current === paymentSession) {
          paymentRequestPendingRef.current = false;
        }
      }
    },
    [packages]
  );

  const closePayment = useCallback(() => {
    paymentSessionRef.current += 1;
    paymentRequestPendingRef.current = false;
    setSelectedPackageId(null);
    setPaymentError('');
    setPaymentState('idle');
    setCheckout(null);
  }, []);

  const completeDevelopmentPayment = useCallback(async () => {
    const orderNo = checkout?.order?.order_no;
    if (!orderNo) return;
    setPaymentError('');
    try {
      await completePointsDevelopmentCheckout(orderNo);
      const order = await readPointsOrder(checkout.order.id);
      setCheckout((current) => (current ? { ...current, order } : current));
      await finishCheckout(order);
    } catch (error) {
      setPaymentState('failed');
      setPaymentError(error?.message || '开发支付确认失败');
    }
  }, [checkout?.order?.id, checkout?.order?.order_no, finishCheckout]);

  const toggleFaq = useCallback((index) => {
    setExpandedFaqIndex((current) => (current === index ? -1 : index));
  }, []);

  return {
    activeTab,
    setActiveTab,
    imageModel,
    imageModels,
    imageModelId,
    setImageModelId,
    imageCount,
    imageCounts: IMAGE_COUNTS,
    setImageCount,
    includeRetryReserve,
    setIncludeRetryReserve,
    pointsPerLink,
    packages,
    wallet,
    ledger,
    loading,
    loadError,
    refreshAccount,
    selectedPackage,
    paymentMethod,
    paymentError,
    paymentState,
    checkout,
    expandedFaqIndex,
    enabledModelCount,
    modelPresetOpen,
    modelPresetLoading,
    modelPresetSaving,
    modelPresetError,
    modelPresetGroups: modelPresetDraft.map((draftGroup) => {
      const source = modelPreset?.groups?.find((group) => group.capabilityKind === draftGroup.capabilityKind);
      return { ...source, ...draftGroup, models: source?.models || [] };
    }),
    openModelPreset,
    closeModelPreset,
    toggleModelPreset,
    setDefaultPresetModel,
    saveModelPreset,
    openPayment,
    closePayment,
    toggleFaq,
    completeDevelopmentPayment,
  };
}
