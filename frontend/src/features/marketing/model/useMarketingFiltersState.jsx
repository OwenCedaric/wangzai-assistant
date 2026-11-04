import {
  formatMarketingActivityPrice,
  formatMarketingStatValue,
  getMarketingProductIssue,
  getMarketingProgressValue,
  getMarketingStatResolvedValue,
  isMarketingMissingPrice,
  isMarketingOutOfStock,
} from '../../../entities/order/orderShopScope.jsx';
import { countJoinedMarketingActivities } from '../../../entities/marketing/marketingCacheRules.jsx';
import { recordLocalMirrorReadLog } from '../../../entities/product/productLocalData.jsx';
import {
  buildRowsIndex,
  paginateRows,
  queryRowsIndex,
  validatePageDatasetConsistency,
} from '../../../services/localMirrorDataset';
import React from 'react';

export function useMarketingFiltersState({
  pageSize,
  productPool,
  keyword,
  productScope,
  hasAppliedDiscount,
  appliedDiscountPercent,
  productPage,
  selectedProductIds,
  isActive,
  selectedShop,
  selectedActivity,
  isShowingCachedMarketingData,
  hasLiveActivityData,
  isReadingActivities,
  isReadingProducts,
  isReadingSummary,
  selectedActivityId,
  selectedSourceType,
  activityRows,
  marketingSummary,
  setSelectedProductIds,
} = {}) {
  const rowsPerPage = Number(pageSize) || 20;
  const marketingProductRowsIndex = React.useMemo(
    () =>
      buildRowsIndex(productPool, {
        getRowKey: (product) => product.id || product.offerId || product.ozonSku || product.sku,
        getRowStatuses: (product) => [product.status],
        getSearchValues: (product) => {
          const offerIdText = String(product.offerId || product.sku || '').toLowerCase();
          const ozonSkuText = String(product.ozonSku || '').toLowerCase();
          return [
            offerIdText,
            ozonSkuText,
            String(product.id || '').toLowerCase(),
            offerIdText.replace(/[\s-]/g, ''),
            ozonSkuText.replace(/[\s-]/g, ''),
          ];
        },
      }),
    [productPool]
  );
  const filteredProducts = React.useMemo(() => {
    const rawKeyword = keyword.trim();
    const lowerKeyword = rawKeyword.toLowerCase();
    const normalizedKeyword = lowerKeyword.replace(/[\s-]/g, '');
    const indexedRows = queryRowsIndex(marketingProductRowsIndex, {
      keyword: rawKeyword,
      statusValue: productScope === 'joined' ? '已添加' : productScope === 'available' ? '可添加' : 'all',
      allStatusValue: 'all',
    });
    return indexedRows.filter((product) => {
      const offerIdText = String(product.offerId || product.sku || '').toLowerCase();
      const ozonSkuText = String(product.ozonSku || '').toLowerCase();
      const productIdText = String(product.id || '').toLowerCase();
      const normalizedOfferId = offerIdText.replace(/[\s-]/g, '');
      const normalizedOzonSku = ozonSkuText.replace(/[\s-]/g, '');
      const matchesKeyword =
        !rawKeyword ||
        offerIdText.includes(lowerKeyword) ||
        ozonSkuText.includes(lowerKeyword) ||
        normalizedOfferId.includes(normalizedKeyword) ||
        normalizedOzonSku.includes(normalizedKeyword) ||
        productIdText.includes(normalizedKeyword);
      if (!matchesKeyword) return false;
      if (productScope === 'joined') return product.status === '已添加';
      if (productScope === 'available') return product.status === '可添加';
      return true;
    });
  }, [keyword, marketingProductRowsIndex, productScope]);
  const productRows = React.useMemo(
    () =>
      filteredProducts.map((product) => ({
        ...product,
        activityPrice: (() => {
          if (!hasAppliedDiscount) return product.sourceActivityPrice || product.activityPrice || '-';
          const calculatedPrice = formatMarketingActivityPrice(product.price, appliedDiscountPercent);
          return calculatedPrice === product.price
            ? product.sourceActivityPrice || product.activityPrice || calculatedPrice
            : calculatedPrice;
        })(),
      })),
    [appliedDiscountPercent, filteredProducts, hasAppliedDiscount]
  );
  const marketingProductPagination = React.useMemo(
    () => paginateRows(productRows, productPage, rowsPerPage),
    [productPage, productRows, rowsPerPage]
  );
  const totalProductPages = marketingProductPagination.totalPages;
  const currentProductPage = marketingProductPagination.currentPage;
  const visibleProductRows = marketingProductPagination.rows;
  const allProductIds = productPool.map((product) => product.id).filter(Boolean);
  const currentPageProductIds = visibleProductRows.map((product) => product.id).filter(Boolean);
  const isAllProductsSelected =
    allProductIds.length > 0 && allProductIds.every((productId) => selectedProductIds.includes(productId));
  const isCurrentPageSelected =
    currentPageProductIds.length > 0 &&
    currentPageProductIds.every((productId) => selectedProductIds.includes(productId));
  const selectedProducts = productPool.filter((product) => selectedProductIds.includes(product.id));
  const marketingProductDatasetConsistency = React.useMemo(
    () =>
      validatePageDatasetConsistency(
        {
          countRows: productPool,
          filteredRows: productRows,
          statusCounts: { all: productPool.length },
          pageRows: visibleProductRows,
          page: marketingProductPagination,
          detailRow: selectedProducts[0] ?? null,
          detailSourceRows: productPool,
        },
        {
          allStatusValue: 'all',
          getRowKey: (product) => product.id || product.offerId || product.ozonSku || product.sku,
        }
      ),
    [marketingProductPagination, productPool, productRows, selectedProducts, visibleProductRows]
  );
  const marketingConsistencyLogKeyRef = React.useRef('');
  React.useEffect(() => {
    if (!isActive) return;
    const consistencyLogKey = [
      selectedShop?.id || 'unknown',
      selectedActivity.id || 'none',
      selectedActivity.sourceType || selectedSourceType || 'official',
      productScope,
      keyword,
      pageSize,
      productPage,
      productPool.length,
      productRows.length,
      marketingProductPagination.totalRows,
      isShowingCachedMarketingData ? 'cache' : hasLiveActivityData ? 'remote' : 'idle',
      marketingProductDatasetConsistency.ok
        ? 'ok'
        : marketingProductDatasetConsistency.issues.map((issue) => issue.code).join(','),
    ].join('|');
    if (marketingConsistencyLogKeyRef.current === consistencyLogKey) return;
    marketingConsistencyLogKeyRef.current = consistencyLogKey;
    recordLocalMirrorReadLog({
      domain: '12_marketing_activities',
      shopScope: selectedShop?.id || 'unknown',
      source: isShowingCachedMarketingData ? 'local-cache' : hasLiveActivityData ? 'remote' : 'idle',
      status: marketingProductDatasetConsistency.ok ? 'consistency-ok' : 'consistency-failed',
      rows: productPool.length,
      failures: marketingProductDatasetConsistency.issues.length,
      partial: !marketingProductDatasetConsistency.ok || isReadingActivities || isReadingProducts || isReadingSummary,
      refreshedAt: new Date().toISOString(),
      details: {
        shopId: selectedShop?.id || 'unknown',
        selectedActivityId: selectedActivity.id || '',
        selectedSourceType: selectedActivity.sourceType || selectedSourceType || 'official',
        productScope,
        activityRows: activityRows.length,
        productRows: productPool.length,
        filteredRows: productRows.length,
        pageRows: visibleProductRows.length,
        pageTotalRows: marketingProductPagination.totalRows,
        keyword,
        isShowingCachedMarketingData,
        hasLiveActivityData,
        consistency: marketingProductDatasetConsistency,
      },
    }).catch(() => undefined);
  }, [
    activityRows.length,
    hasLiveActivityData,
    isActive,
    isReadingActivities,
    isReadingProducts,
    isReadingSummary,
    isShowingCachedMarketingData,
    keyword,
    marketingProductDatasetConsistency,
    marketingProductPagination.totalRows,
    pageSize,
    productPage,
    productPool.length,
    productRows.length,
    productScope,
    selectedActivity.id,
    selectedActivity.sourceType,
    selectedSourceType,
    selectedShop?.id,
    visibleProductRows.length,
  ]);
  const selectedCount = selectedProductIds.length;
  const skippedCount = selectedProducts.filter((product) => getMarketingProductIssue(product)).length;
  const planSubmitCount = Math.max(0, selectedCount - skippedCount);
  const loadedJoinedCount = productPool.filter((product) => product.status === '已添加').length;
  const loadedAvailableCount = productPool.filter((product) => product.status === '可添加').length;
  const missingPriceCount = productPool.filter(isMarketingMissingPrice).length;
  const outOfStockCount = productPool.filter(isMarketingOutOfStock).length;
  const reviewIssueCount = productPool.filter((product) => getMarketingProductIssue(product)).length;
  const marketingActivityDisplayTotal = activityRows.length;
  const marketingJoinedActivityDisplayTotal = Math.min(
    marketingActivityDisplayTotal,
    countJoinedMarketingActivities(activityRows)
  );
  const activityRowsJoinedTotal = activityRows.reduce((sum, activity) => sum + (Number(activity.count) || 0), 0);
  const marketingJoinedProductDisplayTotal = getMarketingStatResolvedValue(
    marketingSummary.joinedProductTotal,
    productPool.length ? loadedJoinedCount : null,
    Number(selectedActivity.count) || null,
    activityRows.length ? activityRowsJoinedTotal : null,
    0
  );
  const marketingIssueProductDisplayTotal = getMarketingStatResolvedValue(
    marketingSummary.issueProductTotal,
    productPool.length ? reviewIssueCount : null,
    0
  );
  const productTotalForProgress = Math.max(1, selectedActivity.count + selectedActivity.available);
  const getSummaryHint = (value, readyText) => {
    if (!hasLiveActivityData) return '待读取';
    if (isShowingCachedMarketingData) return value === null || value === undefined ? '更新中' : '上次读取';
    if (value === null || value === undefined) return isReadingSummary ? '统计中' : '未完成';
    return readyText;
  };
  const marketingStats = [
    {
      title: '活动总数',
      value: formatMarketingStatValue(marketingActivityDisplayTotal),
      hint: hasLiveActivityData ? (isShowingCachedMarketingData ? '上次读取' : 'Ozon 全部活动') : '待读取',
      tone: 'primary',
    },
    {
      title: '已参加活动',
      value: formatMarketingStatValue(marketingJoinedActivityDisplayTotal),
      hint: hasLiveActivityData ? (isShowingCachedMarketingData ? '上次读取' : '当前店铺') : '待读取',
      tone: 'success',
    },
    {
      title: '已添加商品',
      value: formatMarketingStatValue(marketingJoinedProductDisplayTotal),
      hint: getSummaryHint(
        marketingJoinedProductDisplayTotal,
        marketingSummary.joinedProductTotal == null ? '当前活动/缓存兜底' : '全部活动去重'
      ),
      tone: 'warning',
    },
    {
      title: '异常商品',
      value: formatMarketingStatValue(marketingIssueProductDisplayTotal),
      hint: getSummaryHint(
        marketingIssueProductDisplayTotal,
        marketingSummary.issueProductTotal == null ? '当前商品池兜底' : '全部活动去重'
      ),
      tone: 'error',
    },
  ];
  const marketingReviewRows = [
    {
      label: '已添加',
      value: selectedActivity.count || loadedJoinedCount,
      progress: getMarketingProgressValue(selectedActivity.count || loadedJoinedCount, productTotalForProgress),
      color: 'success',
    },
    {
      label: '可添加',
      value: selectedActivity.available || loadedAvailableCount,
      progress: getMarketingProgressValue(selectedActivity.available || loadedAvailableCount, productTotalForProgress),
      color: 'warning',
    },
    {
      label: '异常商品',
      value: reviewIssueCount,
      progress: getMarketingProgressValue(reviewIssueCount, Math.max(1, productPool.length)),
      color: 'primary',
    },
  ];
  const marketingReminder =
    reviewIssueCount > 0
      ? `${reviewIssueCount} 个商品需要处理：缺售价 ${missingPriceCount}，库存为 0 ${outOfStockCount}。`
      : hasLiveActivityData
        ? '当前读取商品暂未发现价格或库存异常。'
        : '读取活动后展示商品价格和库存提醒。';
  const toggleProduct = (productId) => {
    setSelectedProductIds((current) =>
      current.includes(productId) ? current.filter((id) => id !== productId) : [...current, productId]
    );
  };

  return {
    filteredProducts,
    productRows,
    totalProductPages,
    currentProductPage,
    visibleProductRows,
    allProductIds,
    currentPageProductIds,
    isAllProductsSelected,
    isCurrentPageSelected,
    selectedProducts,
    selectedCount,
    skippedCount,
    planSubmitCount,
    reviewIssueCount,
    marketingStats,
    marketingReviewRows,
    marketingReminder,
    toggleProduct,
  };
}
