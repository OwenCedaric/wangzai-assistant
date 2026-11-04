import { defaultOzonShops } from '../../../shared/config/appConfigCore.jsx';
import { emptyMarketingSummary } from '../../../entities/marketing/marketingCacheRules.jsx';
import {
  getMarketingActivityCacheKey,
  getMarketingActivityLocalCache,
  getMarketingProductPoolCacheKey,
  getMarketingProductPoolSnapshotResult,
  resolveMarketingActivitySelection,
} from '../../../entities/order/orderShopScope.jsx';
import { safeWarn } from '../../../services/safeLog';
import { emptyMarketingActivity } from '../../products/lib/productEditing.jsx';
import { useSynchronizedOzonShopSelection } from '../../../entities/order/useSynchronizedOzonShopSelection.jsx';
import React from 'react';

export function resolveMarketingSelectedActivity(activityRows = [], selectedActivityId = '', selectedSourceType = '') {
  return (
    resolveMarketingActivitySelection(activityRows, {
      selectedActivityId,
      selectedSourceType,
    }) ?? emptyMarketingActivity
  );
}

export function useMarketingActivityListState({ shops, activeShopId, isActive } = {}) {
  const safeShops = Array.isArray(shops) && shops.length ? shops : defaultOzonShops;
  const [activityRows, setActivityRows] = React.useState([]);
  const [productPool, setProductPool] = React.useState([]);
  const [marketingSummary, setMarketingSummary] = React.useState(emptyMarketingSummary);
  const [selectedActivityId, setSelectedActivityId] = React.useState('');
  const [selectedSourceType, setSelectedSourceType] = React.useState('');
  const [activityFilter, setActivityFilter] = React.useState('all');
  const [productScope, setProductScope] = React.useState('joined');
  const [pageSize, setPageSize] = React.useState('20');
  const [productPage, setProductPage] = React.useState(1);
  const [keyword, setKeyword] = React.useState('');
  const [discountPercent, setDiscountPercent] = React.useState('50');
  const [appliedDiscountPercent, setAppliedDiscountPercent] = React.useState(50);
  const [hasAppliedDiscount, setHasAppliedDiscount] = React.useState(false);
  const [hasLiveActivityData, setHasLiveActivityData] = React.useState(false);
  const [isShowingCachedMarketingData, setIsShowingCachedMarketingData] = React.useState(false);
  const [isMarketingCacheRestoring, setIsMarketingCacheRestoring] = React.useState(true);
  const [isReadingActivities, setIsReadingActivities] = React.useState(false);
  const [isReadingProducts, setIsReadingProducts] = React.useState(false);
  const [isReadingSummary, setIsReadingSummary] = React.useState(false);
  const [readNotice, setReadNotice] = React.useState('');
  const [readNoticeTone, setReadNoticeTone] = React.useState('info');
  const [selectedProductIds, setSelectedProductIds] = React.useState([]);
  const [showSideProductSearch, setShowSideProductSearch] = React.useState(false);
  const [marketingWriteDialog, setMarketingWriteDialog] = React.useState(null);
  const [isMarketingWriting, setIsMarketingWriting] = React.useState(false);
  const productCardRef = React.useRef(null);
  const marketingReadSeqRef = React.useRef(0);
  const productReadSeqRef = React.useRef(0);
  const productPoolCacheRef = React.useRef(new Map());
  const cacheRestoreKeyRef = React.useRef('');
  const marketingCacheRestoreSeqRef = React.useRef(0);
  const marketingScopeGenerationRef = React.useRef(0);
  const marketingWriteDialogOpenRef = React.useRef(false);
  const resetMarketingShopScope = React.useCallback(() => {
    marketingScopeGenerationRef.current += 1;
    marketingReadSeqRef.current += 1;
    productReadSeqRef.current += 1;
    marketingCacheRestoreSeqRef.current += 1;
    cacheRestoreKeyRef.current = '';
    productPoolCacheRef.current.clear();
    marketingWriteDialogOpenRef.current = false;
    setActivityRows([]);
    setProductPool([]);
    setMarketingSummary(emptyMarketingSummary);
    setSelectedActivityId('');
    setSelectedSourceType('');
    setActivityFilter('all');
    setProductScope('joined');
    setProductPage(1);
    setKeyword('');
    setSelectedProductIds([]);
    setHasLiveActivityData(false);
    setIsShowingCachedMarketingData(false);
    setIsMarketingCacheRestoring(true);
    setIsReadingActivities(false);
    setIsReadingProducts(false);
    setIsReadingSummary(false);
    setReadNotice('');
    setReadNoticeTone('info');
    setMarketingWriteDialog(null);
    setIsMarketingWriting(false);
  }, []);
  const [selectedShopId, setSelectedShopSelection] = useSynchronizedOzonShopSelection({
    shops: safeShops,
    activeShopId,
    allValue: safeShops[0]?.id || '',
    onScopeChange: resetMarketingShopScope,
  });
  const setSelectedShopId = React.useCallback(
    (shopId) => {
      const nextShopId = String(shopId || '').trim();
      if (nextShopId === selectedShopId) return;
      resetMarketingShopScope();
      setSelectedShopSelection(nextShopId);
    },
    [resetMarketingShopScope, selectedShopId, setSelectedShopSelection]
  );
  React.useEffect(() => {
    if (!readNotice) return undefined;
    if (readNoticeTone === 'error') return undefined;
    const timer = window.setTimeout(() => setReadNotice(''), 2600);
    return () => window.clearTimeout(timer);
  }, [readNotice, readNoticeTone]);
  React.useEffect(() => {
    marketingWriteDialogOpenRef.current = Boolean(marketingWriteDialog) || isMarketingWriting;
  }, [isMarketingWriting, marketingWriteDialog]);
  const setMarketingBackgroundNotice = (tone, message) => {
    if (marketingWriteDialogOpenRef.current) {
      if (tone === 'error') safeWarn('营销后台读取提示已降噪', message);
      return;
    }
    setReadNoticeTone(tone);
    setReadNotice(message);
  };
  React.useEffect(() => {
    let frameId = 0;
    const updateSideSearch = () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        const productCard = productCardRef.current;
        if (!productCard) {
          setShowSideProductSearch(false);
          return;
        }
        const rect = productCard.getBoundingClientRect();
        setShowSideProductSearch(rect.top <= 132 && rect.bottom > 180);
      });
    };

    updateSideSearch();
    window.addEventListener('scroll', updateSideSearch, { passive: true });
    window.addEventListener('resize', updateSideSearch);

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      window.removeEventListener('scroll', updateSideSearch);
      window.removeEventListener('resize', updateSideSearch);
    };
  }, [productPool.length, productScope]);
  const selectedActivity = resolveMarketingSelectedActivity(activityRows, selectedActivityId, selectedSourceType);
  const selectedShop = safeShops.find((shop) => shop.id === selectedShopId) ?? null;
  const applyMarketingActivityCache = React.useCallback(
    (cached, shop = selectedShop) => {
      const joinedIds = cached.productPool
        .filter((product) => product.status === '已添加')
        .map((product) => product.id);
      productPoolCacheRef.current.clear();
      const cachedActivity =
        resolveMarketingActivitySelection(cached.activityRows, {
          selectedActivityId: cached.selectedActivityId,
          selectedSourceType: cached.selectedSourceType,
        }) ?? null;
      const cachedPoolResult = getMarketingProductPoolSnapshotResult(cached, cachedActivity, cached.productScope);
      if (cachedPoolResult) {
        productPoolCacheRef.current.set(
          getMarketingProductPoolCacheKey(shop, cachedActivity, cached.productScope),
          cachedPoolResult
        );
      }
      setActivityRows(cached.activityRows);
      setProductPool(cached.productPool);
      setMarketingSummary(cached.marketingSummary);
      setSelectedActivityId(cached.selectedActivityId);
      setSelectedSourceType(cached.selectedSourceType);
      setProductScope(cached.productScope);
      setProductPage(1);
      setSelectedProductIds(cached.selectedProductIds.length ? cached.selectedProductIds : joinedIds);
      setHasLiveActivityData(true);
      setIsShowingCachedMarketingData(true);
      setReadNoticeTone('info');
      setReadNotice('已显示上次读取结果，点击刷新活动读取最新。');
      return true;
    },
    [selectedShop]
  );
  const restoreMarketingActivitySqliteSnapshot = React.useCallback(
    async (shop, canApply = () => true) => {
      const cached = await getMarketingActivityLocalCache(shop, { timeoutMs: 2500 });
      if (!cached || !canApply()) return false;
      return applyMarketingActivityCache(cached, shop);
    },
    [applyMarketingActivityCache]
  );
  React.useEffect(() => {
    if (!isActive || !selectedShop) return undefined;
    const cacheRestoreKey = [
      getMarketingActivityCacheKey(selectedShop),
      selectedShop.clientId || '',
      selectedShop.apiKey ? 'ready' : 'empty',
    ].join('::');
    if (cacheRestoreKeyRef.current === cacheRestoreKey) return undefined;
    cacheRestoreKeyRef.current = cacheRestoreKey;

    const restoreSeq = marketingCacheRestoreSeqRef.current + 1;
    marketingCacheRestoreSeqRef.current = restoreSeq;
    setIsMarketingCacheRestoring(true);
    productReadSeqRef.current += 1;
    productPoolCacheRef.current.clear();
    setActivityRows([]);
    setProductPool([]);
    setMarketingSummary(emptyMarketingSummary);
    setSelectedActivityId('');
    setSelectedSourceType('');
    setSelectedProductIds([]);
    setHasLiveActivityData(false);
    setIsShowingCachedMarketingData(false);
    setReadNoticeTone('info');
    setReadNotice('');

    restoreMarketingActivitySqliteSnapshot(selectedShop, () => marketingCacheRestoreSeqRef.current === restoreSeq)
      .then((localRestored) => {
        if (marketingCacheRestoreSeqRef.current !== restoreSeq || localRestored) return;
        setReadNoticeTone('info');
        setReadNotice('当前店铺暂无本地营销活动数据，点击刷新活动读取。');
      })
      .catch((error) => {
        if (marketingCacheRestoreSeqRef.current !== restoreSeq) return;
        safeWarn('营销活动 SQLite 快照恢复失败', error);
        setReadNoticeTone('error');
        setReadNotice('营销活动本地快照读取失败，请稍后重试。');
      })
      .finally(() => {
        if (marketingCacheRestoreSeqRef.current === restoreSeq) setIsMarketingCacheRestoring(false);
      });

    return undefined;
  }, [
    isActive,
    restoreMarketingActivitySqliteSnapshot,
    selectedShop,
    selectedShopId,
    selectedShop?.clientId,
    selectedShop?.apiKey,
  ]);

  return {
    safeShops,
    selectedShopId,
    setSelectedShopId,
    activityRows,
    setActivityRows,
    productPool,
    setProductPool,
    marketingSummary,
    setMarketingSummary,
    selectedActivityId,
    setSelectedActivityId,
    selectedSourceType,
    setSelectedSourceType,
    activityFilter,
    setActivityFilter,
    productScope,
    setProductScope,
    pageSize,
    setPageSize,
    productPage,
    setProductPage,
    keyword,
    setKeyword,
    discountPercent,
    setDiscountPercent,
    appliedDiscountPercent,
    setAppliedDiscountPercent,
    hasAppliedDiscount,
    setHasAppliedDiscount,
    hasLiveActivityData,
    setHasLiveActivityData,
    isShowingCachedMarketingData,
    setIsShowingCachedMarketingData,
    isMarketingCacheRestoring,
    isReadingActivities,
    setIsReadingActivities,
    isReadingProducts,
    setIsReadingProducts,
    isReadingSummary,
    setIsReadingSummary,
    readNotice,
    setReadNotice,
    readNoticeTone,
    setReadNoticeTone,
    selectedProductIds,
    setSelectedProductIds,
    showSideProductSearch,
    marketingWriteDialog,
    setMarketingWriteDialog,
    isMarketingWriting,
    setIsMarketingWriting,
    productCardRef,
    marketingReadSeqRef,
    productReadSeqRef,
    productPoolCacheRef,
    marketingWriteDialogOpenRef,
    marketingScopeGenerationRef,
    setMarketingBackgroundNotice,
    selectedActivity,
    selectedShop,
  };
}
