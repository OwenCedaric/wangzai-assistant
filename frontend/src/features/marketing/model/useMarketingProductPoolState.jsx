import {
  emptyMarketingSummary,
  filterMarketingProductsByScope,
} from '../../../entities/marketing/marketingCacheRules.jsx';
import {
  buildFastMarketingSummary,
  canUseOzonShop,
  buildMarketingProductPoolCacheResult,
  getMarketingActivityCache,
  getMarketingActivityIdentityKey,
  getMarketingProductPoolCacheKey,
  getMarketingProductPoolSnapshotResult,
  mergeMarketingActivityCache,
  normalizeMarketingPercent,
  resolveMarketingActivitySelection,
  saveMarketingActivityCache,
} from '../../../entities/order/orderShopScope.jsx';
import { pollMarketingActivitySyncJob } from '../../../services/marketingActivityClient';
import { safeWarn } from '../../../services/safeLog';
import {
  getFriendlyOzonReadError,
  requestOzonMarketingActivities,
  requestOzonMarketingProductPool,
  requestOzonMarketingSummary,
} from '../../orders/purchase/lib/purchaseMarketingApi.jsx';
import { buildRetainedMarketingProductPoolResult } from '../lib/marketingProductPoolCache.js';
import React from 'react';

export function resolveMarketingReadActivity(activityRows = [], snapshot = null) {
  return resolveMarketingActivitySelection(activityRows, {
    selectedActivityId: snapshot?.selectedActivityId,
    selectedSourceType: snapshot?.selectedSourceType,
  });
}

export function useMarketingProductPoolState({
  selectedShop,
  isActive,
  isMarketingCacheRestoring,
  isReadingActivities,
  isReadingProducts,
  productScope,
  productPoolCacheRef,
  pageSize,
  setProductPool,
  setSelectedProductIds,
  setProductPage,
  setActivityRows,
  activityRows,
  productPool,
  selectedActivityId,
  selectedSourceType,
  selectedProductIds,
  setMarketingBackgroundNotice,
  hasLiveActivityData,
  setIsShowingCachedMarketingData,
  setReadNoticeTone,
  setReadNotice,
  marketingReadSeqRef,
  productReadSeqRef,
  setIsReadingActivities,
  setIsReadingProducts,
  setIsReadingSummary,
  setKeyword,
  setProductScope,
  setMarketingSummary,
  setSelectedActivityId,
  setSelectedSourceType,
  setHasLiveActivityData,
  setActivityFilter,
  marketingSummary,
  setSelectedShopId,
  filteredProducts,
  selectedActivity,
  discountPercent,
  setDiscountPercent,
  setAppliedDiscountPercent,
  setHasAppliedDiscount,
} = {}) {
  const autoReadShopKeyRef = React.useRef('');
  const autoReadActivitiesRef = React.useRef(null);
  const autoReadProductPoolKeyRef = React.useRef('');
  const autoReadProductPoolRef = React.useRef(null);
  const readCachedMarketingProductPool = (activity, shop = selectedShop, scope = productScope) => {
    const cacheKey = getMarketingProductPoolCacheKey(shop, activity, scope);
    const runtimeResult = productPoolCacheRef.current.get(cacheKey);
    if (runtimeResult) return runtimeResult;
    const snapshotResult = getMarketingProductPoolSnapshotResult(getMarketingActivityCache(shop), activity, scope);
    if (snapshotResult) productPoolCacheRef.current.set(cacheKey, snapshotResult);
    return snapshotResult;
  };
  const rememberMarketingProductPoolResult = (activity, shop = selectedShop, scope = productScope, result) => {
    if (!activity || !shop || !result) return;
    productPoolCacheRef.current.set(getMarketingProductPoolCacheKey(shop, activity, scope), result);
    if (scope === 'all') {
      productPoolCacheRef.current.set(
        getMarketingProductPoolCacheKey(shop, activity, 'joined'),
        buildMarketingProductPoolCacheResult(filterMarketingProductsByScope(result.products, 'joined'), activity)
      );
      productPoolCacheRef.current.set(
        getMarketingProductPoolCacheKey(shop, activity, 'available'),
        buildMarketingProductPoolCacheResult(filterMarketingProductsByScope(result.products, 'available'), activity)
      );
    }
  };
  const loadActivityProductPool = async (activity, shop = selectedShop, scope = productScope, options = {}) => {
    if (!activity || !shop) return;
    const cachedResult =
      options.force || options.cacheOnly ? null : readCachedMarketingProductPool(activity, shop, scope);
    const allowRemote = options.cacheOnly ? false : options.force || Boolean(options.allowRemote);
    if (!cachedResult && !allowRemote && !options.cacheOnly) return null;
    const result =
      cachedResult ||
      (await requestOzonMarketingProductPool(shop, activity, scope, {
        allowRemote,
        cacheOnly: options.cacheOnly,
        cacheResult: options.cacheResult,
        skipCache: options.skipCache,
        forceRefresh: options.forceRefresh,
        pageSize: options.pageSize,
        limit: options.limit,
        maxPages: options.maxPages,
        cacheTimeoutMs: options.cacheTimeoutMs,
        syncTimeoutMs: options.syncTimeoutMs,
        signal: options.signal,
      }));
    if (options.canApply && !options.canApply()) return result;
    if (!cachedResult) {
      rememberMarketingProductPoolResult(activity, shop, scope, result);
    }
    const dedupedProducts = Array.from(
      new Map(result.products.filter((product) => product.id).map((product) => [product.id, product])).values()
    );
    const joinedIds = dedupedProducts.filter((product) => product.status === '已添加').map((product) => product.id);
    setProductPool(dedupedProducts);
    setSelectedProductIds(scope === 'available' ? [] : joinedIds);
    setProductPage(1);
    setActivityRows((current) => {
      const nextRows = current.map((row) =>
        row.id === activity.id && row.sourceType === activity.sourceType
          ? {
              ...row,
              count: result.joinedTotal,
              available: result.availableTotal,
            }
          : row
      );
      mergeMarketingActivityCache(shop, {
        activityRows: nextRows,
        productPool: dedupedProducts,
        selectedActivityId: activity.id,
        selectedSourceType: activity.sourceType || 'official',
        productScope: scope,
        selectedProductIds: scope === 'available' ? [] : joinedIds,
      });
      return nextRows;
    });

    if (result.syncJobId && options.pollRemote !== false) {
      pollMarketingActivitySyncJob(result.syncJobId, { intervalMs: 700, timeoutMs: 90_000 })
        .then((finalResult) => {
          const finalStatus = finalResult?.job?.status || finalResult?.status || '';
          if (['success', 'partial'].includes(finalStatus)) {
            productPoolCacheRef.current.delete(getMarketingProductPoolCacheKey(shop, activity, scope));
            return loadActivityProductPool(activity, shop, scope, {
              cacheOnly: true,
              pollRemote: false,
              canApply: options.canApply,
              cacheTimeoutMs: 15_000,
            });
          }
          if (['failed', 'canceled', 'blocked', 'rate_limited', 'circuit_open'].includes(finalStatus)) {
            setMarketingBackgroundNotice(
              'error',
              finalResult?.job?.lastError || finalResult?.error?.message || '营销商品池后台同步失败，请稍后再试。'
            );
          }
          return null;
        })
        .catch((error) => {
          safeWarn('营销商品池后台同步轮询失败', error);
        });
    }
    return result;
  };
  const readActivitiesForShop = async (shop, options = {}) => {
    const keepExisting = Boolean(options.keepExisting);
    const hadVisibleData = keepExisting && (activityRows.length > 0 || productPool.length > 0 || hasLiveActivityData);
    const hadVisibleProductPool = keepExisting && productPool.length > 0;
    if (!shop?.id) {
      if (hadVisibleData) setIsShowingCachedMarketingData(true);
      setReadNoticeTone('error');
      setReadNotice(hadVisibleData ? '请先选择店铺，当前显示上次读取结果。' : '请先在设置里创建店铺。');
      return;
    }

    const readSeq = marketingReadSeqRef.current + 1;
    marketingReadSeqRef.current = readSeq;
    productReadSeqRef.current += 1;
    productPoolCacheRef.current.clear();
    setIsReadingActivities(true);
    setIsReadingProducts(false);
    setIsReadingSummary(false);
    if (keepExisting) {
      setIsShowingCachedMarketingData(true);
      setReadNoticeTone('info');
      setReadNotice('正在重新读取活动。');
    } else {
      setReadNotice('');
    }
    setKeyword('');
    setProductScope('joined');
    setProductPage(1);
    if (!keepExisting) {
      setActivityRows([]);
      setProductPool([]);
      setMarketingSummary(emptyMarketingSummary);
      setSelectedActivityId('');
      setSelectedSourceType('');
      setSelectedProductIds([]);
      setHasLiveActivityData(false);
      setIsShowingCachedMarketingData(false);
    }

    try {
      const retainedSnapshot = hadVisibleData
        ? {
            activityRows,
            productPool,
            marketingSummary,
            selectedActivityId,
            selectedSourceType,
            productScope,
            selectedProductIds,
            cachedAt: new Date().toISOString(),
          }
        : null;
      const activityReadResult = await requestOzonMarketingActivities(shop, {
        cacheOnly: options.cacheOnly === true,
        allowRemote: options.allowRemote !== false,
        cacheSnapshot: retainedSnapshot,
        skipCache: Boolean(retainedSnapshot),
        cacheTimeoutMs: options.cacheTimeoutMs || 1800,
        syncTimeoutMs: options.syncTimeoutMs || 2500,
      });
      const nextActivities = activityReadResult.activityRows || [];
      if (marketingReadSeqRef.current !== readSeq) return;
      if (nextActivities.length === 0) {
        if (hadVisibleData) {
          setHasLiveActivityData(true);
          setIsShowingCachedMarketingData(true);
          setIsReadingActivities(false);
          setIsReadingProducts(false);
          setIsReadingSummary(false);
          setReadNoticeTone('info');
          setReadNotice(
            activityReadResult.syncJobId
              ? '本地暂未返回新活动，已保留上次结果，Ozon 后台会继续更新。'
              : '本次未读取到活动，已保留上次读取结果。'
          );
          if (activityReadResult.syncJobId) {
            pollMarketingActivitySyncJob(activityReadResult.syncJobId, { intervalMs: 700, timeoutMs: 90_000 })
              .then(() => {
                if (marketingReadSeqRef.current !== readSeq) return null;
                return readActivitiesForShop(shop, { keepExisting: true, cacheOnly: true });
              })
              .catch((error) => safeWarn('营销活动后台读取轮询失败', error));
          }
          return;
        }
        setActivityRows([]);
        setProductPool([]);
        setMarketingSummary(emptyMarketingSummary);
        setSelectedActivityId('');
        setSelectedSourceType('');
        setSelectedProductIds([]);
        setHasLiveActivityData(false);
        setIsShowingCachedMarketingData(false);
        setIsReadingActivities(false);
        setReadNoticeTone('info');
        setReadNotice(
          activityReadResult.syncJobId
            ? '本地暂无活动缓存，Ozon 已在后台读取，完成后会自动刷新。'
            : '当前店铺暂未读取到可处理活动。'
        );
        if (activityReadResult.syncJobId) {
          pollMarketingActivitySyncJob(activityReadResult.syncJobId, { intervalMs: 700, timeoutMs: 90_000 })
            .then(() => {
              if (marketingReadSeqRef.current !== readSeq) return null;
              return readActivitiesForShop(shop, { keepExisting: true, cacheOnly: true });
            })
            .catch((error) => safeWarn('营销活动后台读取轮询失败', error));
        }
        return;
      }

      const fastSummary = buildFastMarketingSummary(nextActivities);
      // The first page read is restored from the SQLite view-state identity.
      // Do not pick the first row: Ozon may expose an official and seller
      // activity with the same numeric id, and an id-only fallback is unsafe.
      const firstActivity = resolveMarketingReadActivity(
        nextActivities,
        activityReadResult.snapshot ?? {
          selectedActivityId,
          selectedSourceType,
        }
      );
      const retainedProductPoolMatchesSelection =
        hadVisibleProductPool &&
        firstActivity?.id === selectedActivityId &&
        (firstActivity?.sourceType || '') === (selectedSourceType || '');
      setActivityRows(nextActivities);
      setMarketingSummary(fastSummary);
      setSelectedActivityId(firstActivity?.id || '');
      setSelectedSourceType(firstActivity?.sourceType || '');
      setActivityFilter('all');
      if (!retainedProductPoolMatchesSelection) {
        setProductPool([]);
        setSelectedProductIds([]);
      }
      setHasLiveActivityData(true);
      setIsShowingCachedMarketingData(false);
      setReadNoticeTone(activityReadResult.pending || activityReadResult.syncStartFailed ? 'info' : 'success');
      setReadNotice(
        activityReadResult.syncStartFailed
          ? `已显示 ${fastSummary.activityTotal} 个本地活动，本次后台更新启动较慢，可继续使用当前数据。`
          : activityReadResult.pending
          ? `已先显示 ${fastSummary.activityTotal} 个本地活动，Ozon 后台正在更新。`
          : `已读取 ${fastSummary.activityTotal} 个活动，正在读取商品池。`
      );
      setIsReadingActivities(false);
      saveMarketingActivityCache(shop, {
        activityRows: nextActivities,
        productPool: retainedProductPoolMatchesSelection ? productPool : [],
        marketingSummary: fastSummary,
        selectedActivityId: firstActivity?.id || '',
        selectedSourceType: firstActivity?.sourceType || '',
        productScope: 'joined',
        selectedProductIds: retainedProductPoolMatchesSelection ? selectedProductIds : [],
      });

      if (activityReadResult.syncJobId) {
        pollMarketingActivitySyncJob(activityReadResult.syncJobId, { intervalMs: 700, timeoutMs: 90_000 })
          .then(async (finalResult) => {
            if (marketingReadSeqRef.current !== readSeq) return;
            const finalStatus = finalResult?.job?.status || finalResult?.status || '';
            if (!['success', 'partial'].includes(finalStatus)) return;
            const latestResult = await requestOzonMarketingActivities(shop, { cacheOnly: true, cacheTimeoutMs: 2500 });
            if (marketingReadSeqRef.current !== readSeq) return;
            const latestActivities = latestResult.activityRows || [];
            if (!latestActivities.length) return;
            const latestSummary = buildFastMarketingSummary(latestActivities);
            const cachedSelection = getMarketingActivityCache(shop);
            const nextSelectedActivity = resolveMarketingReadActivity(
              latestActivities,
              latestResult.snapshot ?? cachedSelection ?? {
                selectedActivityId,
                selectedSourceType,
              }
            );
            setActivityRows(latestActivities);
            setMarketingSummary(latestSummary);
            setSelectedActivityId(nextSelectedActivity?.id || '');
            setSelectedSourceType(nextSelectedActivity?.sourceType || '');
            mergeMarketingActivityCache(shop, {
              activityRows: latestActivities,
              marketingSummary: latestSummary,
              selectedActivityId: nextSelectedActivity?.id || '',
              selectedSourceType: nextSelectedActivity?.sourceType || '',
            });
            setReadNoticeTone('success');
            setReadNotice(`后台已更新 ${latestSummary.activityTotal} 个活动。`);
          })
          .catch((error) => safeWarn('营销活动后台同步轮询失败', error));
      }

      const productReadSeq = productReadSeqRef.current + 1;
      productReadSeqRef.current = productReadSeq;
      if (firstActivity) {
        setIsReadingProducts(true);
        loadActivityProductPool(firstActivity, shop, 'joined', {
          force: true,
          cacheResult: retainedProductPoolMatchesSelection
            ? buildRetainedMarketingProductPoolResult(productPool, firstActivity)
            : null,
          skipCache: retainedProductPoolMatchesSelection,
          canApply: () => marketingReadSeqRef.current === readSeq && productReadSeqRef.current === productReadSeq,
        })
          .then((productResult) => {
            if (marketingReadSeqRef.current !== readSeq || productReadSeqRef.current !== productReadSeq) return;
            setReadNoticeTone(productResult?.pending || productResult?.syncStartFailed ? 'info' : 'success');
            setReadNotice(
              productResult?.syncStartFailed
                ? `已显示 ${fastSummary.activityTotal} 个活动和本地商品池，本次后台更新启动较慢。`
                : productResult?.pending
                ? `已读取本地商品池，Ozon 后台正在复核 ${fastSummary.activityTotal} 个活动。`
                : `已读取 ${fastSummary.activityTotal} 个活动。`
            );
          })
          .catch((error) => {
            if (marketingReadSeqRef.current !== readSeq || productReadSeqRef.current !== productReadSeq) return;
            if (retainedProductPoolMatchesSelection) {
              setReadNoticeTone('info');
              setReadNotice('商品池刷新未完成，已继续显示上次读取结果。');
            } else {
              setProductPool([]);
              setSelectedProductIds([]);
              setMarketingBackgroundNotice('error', getFriendlyOzonReadError(error));
            }
          })
          .finally(() => {
            if (marketingReadSeqRef.current === readSeq && productReadSeqRef.current === productReadSeq) {
              setIsReadingProducts(false);
            }
          });
      } else {
        setIsReadingProducts(false);
        setReadNoticeTone('info');
        setReadNotice('已读取活动，请先选择一个活动后读取商品池。');
      }

      setIsReadingSummary(true);
      requestOzonMarketingSummary(shop, nextActivities, {
        cacheResult: hadVisibleData ? marketingSummary : null,
        // SQLite summary is now a compact aggregate query. Always re-read it
        // so an old view-state total cannot overwrite the current product
        // facts; the in-memory value remains the timeout/error fallback.
        skipCache: false,
        // Activity/product reads already refresh the selected pool.  Starting
        // a second all-activity product hydration here caused large shops to
        // monopolize the local service and made their joined pool time out.
        allowRemote: false,
      })
        .then((summary) => {
          if (marketingReadSeqRef.current !== readSeq) return;
          summary.poolsByActivity?.forEach((pool) => {
            rememberMarketingProductPoolResult(
              pool.activity,
              shop,
              'all',
              buildMarketingProductPoolCacheResult(pool.products, pool.activity)
            );
          });
          const nextSummary = {
            activityTotal: summary.activityTotal,
            joinedActivityTotal: summary.joinedActivityTotal,
            joinedProductTotal: summary.joinedProductTotal,
            issueProductTotal: summary.issueProductTotal,
          };
          setActivityRows((current) => {
            const nextRows = current.map((activity) => {
              const pool = summary.poolsByActivity.get(getMarketingActivityIdentityKey(activity));
              if (!pool) return activity;
              return {
                ...activity,
                count: pool.joinedTotal,
                available: pool.availableTotal,
              };
            });
            mergeMarketingActivityCache(shop, {
              activityRows: nextRows,
              marketingSummary: nextSummary,
            });
            return nextRows;
          });
          setMarketingSummary(nextSummary);
          if (summary.pending && summary.syncJobId) {
            pollMarketingActivitySyncJob(summary.syncJobId, { intervalMs: 1200, timeoutMs: 180_000 })
              .then(async (finalResult) => {
                if (marketingReadSeqRef.current !== readSeq) return null;
                const finalStatus = finalResult?.job?.status || finalResult?.status || '';
                if (!['success', 'partial'].includes(finalStatus)) return null;
                const latestSummary = await requestOzonMarketingSummary(shop, nextActivities, {
                  cacheOnly: true,
                  allowRemote: false,
                  cacheTimeoutMs: 2500,
                });
                if (marketingReadSeqRef.current !== readSeq) return null;
                const finalSummary = {
                  activityTotal: latestSummary.activityTotal,
                  joinedActivityTotal: latestSummary.joinedActivityTotal,
                  joinedProductTotal: latestSummary.joinedProductTotal,
                  issueProductTotal: latestSummary.issueProductTotal,
                };
                setMarketingSummary(finalSummary);
                mergeMarketingActivityCache(shop, { marketingSummary: finalSummary });
                setReadNoticeTone('success');
                setReadNotice('营销全局统计已按全部活动更新。');
                return null;
              })
              .catch((error) => safeWarn('营销活动全局统计后台轮询失败', error));
          }
        })
        .catch((error) => {
          if (marketingReadSeqRef.current !== readSeq) return;
          safeWarn('营销活动全局统计读取失败', error);
          setMarketingBackgroundNotice('info', '部分统计未完成，可继续处理当前活动。');
        })
        .finally(() => {
          if (marketingReadSeqRef.current === readSeq) setIsReadingSummary(false);
        });
    } catch (error) {
      if (marketingReadSeqRef.current !== readSeq) return;
      if (hadVisibleData) {
        setHasLiveActivityData(true);
        setIsShowingCachedMarketingData(true);
        setIsReadingActivities(false);
        setIsReadingProducts(false);
        setIsReadingSummary(false);
        setReadNoticeTone('error');
        setReadNotice('刷新失败，当前显示上次读取结果。');
        return;
      }
      setActivityRows([]);
      setProductPool([]);
      setMarketingSummary(emptyMarketingSummary);
      setSelectedActivityId('');
      setSelectedSourceType('');
      setSelectedProductIds([]);
      setHasLiveActivityData(false);
      setIsShowingCachedMarketingData(false);
      setIsReadingActivities(false);
      setIsReadingProducts(false);
      setIsReadingSummary(false);
      setMarketingBackgroundNotice('error', getFriendlyOzonReadError(error));
    }
  };
  const handleReadActivities = () => {
    readActivitiesForShop(selectedShop, {
      keepExisting: activityRows.length > 0 || productPool.length > 0,
    });
  };
  const handleMarketingShopChange = (shopId) => {
    setSelectedShopId(shopId);
  };

  // A newly bound shop has no SQLite snapshot yet. Restore is always allowed
  // to finish first; afterwards start one normal local-first read so the
  // first visit reaches the same working state as an explicit refresh.
  autoReadActivitiesRef.current = readActivitiesForShop;
  React.useEffect(() => {
    if (!isActive || isMarketingCacheRestoring || hasLiveActivityData || isReadingActivities) return;
    if (!canUseOzonShop(selectedShop)) return;
    const shopKey = `${selectedShop.id || ''}:${selectedShop.clientId || ''}`;
    if (!shopKey || autoReadShopKeyRef.current === shopKey) return;
    autoReadShopKeyRef.current = shopKey;
    autoReadActivitiesRef.current?.(selectedShop, { keepExisting: false });
  }, [hasLiveActivityData, isActive, isMarketingCacheRestoring, isReadingActivities, selectedShop]);

  // The page-entry snapshot deliberately omits the potentially huge product
  // array. Once its selected activity is restored, fetch that activity's
  // paged SQLite pool independently so cold navigation stays fast and the
  // table still fills without contacting Ozon.
  autoReadProductPoolRef.current = loadActivityProductPool;
  React.useEffect(() => {
    if (!isActive || isMarketingCacheRestoring || !hasLiveActivityData || isReadingProducts) return;
    if (!selectedShop?.id || !selectedActivity?.id || productPool.length > 0) return;
    const poolKey = getMarketingProductPoolCacheKey(selectedShop, selectedActivity, productScope);
    if (!poolKey || autoReadProductPoolKeyRef.current === poolKey) return;
    autoReadProductPoolKeyRef.current = poolKey;
    const productReadSeq = productReadSeqRef.current + 1;
    productReadSeqRef.current = productReadSeq;
    setIsReadingProducts(true);
    autoReadProductPoolRef.current?.(selectedActivity, selectedShop, productScope, {
      cacheOnly: true,
      cacheTimeoutMs: 15_000,
      canApply: () => productReadSeqRef.current === productReadSeq,
    })
      .then((result) => {
        if (productReadSeqRef.current !== productReadSeq) return;
        if (!result?.products?.length) {
          setReadNoticeTone('info');
          setReadNotice('已读取活动，当前活动暂无本地商品池，点击读取活动可后台更新。');
        }
      })
      .catch((error) => {
        if (productReadSeqRef.current !== productReadSeq) return;
        safeWarn('营销活动首屏商品池恢复失败', error);
        setReadNoticeTone('info');
        setReadNotice('活动已恢复，商品池读取较慢，可点击读取活动继续后台更新。');
      })
      .finally(() => {
        if (productReadSeqRef.current === productReadSeq) setIsReadingProducts(false);
      });
  }, [
    hasLiveActivityData,
    isActive,
    isMarketingCacheRestoring,
    isReadingProducts,
    productPool.length,
    productScope,
    productReadSeqRef,
    selectedActivity,
    selectedShop,
    setIsReadingProducts,
    setReadNotice,
    setReadNoticeTone,
  ]);

  const handleProductScopeChange = async (nextScope) => {
    if (nextScope === productScope && hasLiveActivityData && filteredProducts.length > 0) return;
    setProductScope(nextScope);
    setKeyword('');
    setProductPage(1);
    if (!hasLiveActivityData) return;

    setIsReadingProducts(true);
    setReadNoticeTone('info');
    setReadNotice(
      nextScope === 'available'
        ? '正在读取可添加商品池。'
        : nextScope === 'joined'
          ? '正在读取已添加商品池。'
          : '正在读取全部商品池。'
    );
    const productReadSeq = productReadSeqRef.current + 1;
    productReadSeqRef.current = productReadSeq;
    try {
      const cachedResult = await loadActivityProductPool(selectedActivity, selectedShop, nextScope, {
        allowRemote: true,
        forceRefresh: true,
        cacheTimeoutMs: 15_000,
        canApply: () => productReadSeqRef.current === productReadSeq,
      });
      if (productReadSeqRef.current !== productReadSeq) return;
      if (!cachedResult) {
        setProductPool([]);
        setSelectedProductIds([]);
        setReadNoticeTone('info');
        setReadNotice('当前商品范围暂未返回商品，已发起 Ozon 读取，稍后会自动刷新。');
        return;
      }
      setReadNoticeTone(cachedResult.pending ? 'info' : 'success');
      setReadNotice(
        cachedResult.pending
          ? nextScope === 'available'
            ? '已先显示可添加商品池，Ozon 后台正在复核。'
            : nextScope === 'joined'
              ? '已先显示已添加商品池，Ozon 后台正在复核。'
              : '已先显示全部商品池，Ozon 后台正在复核。'
          : nextScope === 'available'
            ? '已读取可添加商品。'
            : nextScope === 'joined'
              ? '已读取已添加商品。'
              : '已读取全部商品池。'
      );
    } catch (error) {
      if (productReadSeqRef.current !== productReadSeq) return;
      setMarketingBackgroundNotice('error', getFriendlyOzonReadError(error));
    } finally {
      if (productReadSeqRef.current === productReadSeq) setIsReadingProducts(false);
    }
  };
  const applyDiscountPercent = () => {
    const nextPercent = normalizeMarketingPercent(discountPercent);
    setDiscountPercent(String(nextPercent));
    setAppliedDiscountPercent(nextPercent);
    setHasAppliedDiscount(true);
    return nextPercent;
  };

  return {
    loadActivityProductPool,
    handleReadActivities,
    handleMarketingShopChange,
    handleProductScopeChange,
    applyDiscountPercent,
  };
}
