import {
  createEmptyProductStatusCounts,
  getProductListServerSort,
} from '../../../entities/product/productLocalData.jsx';
import { getProductSelectionKey } from '../../../entities/product/productWriteHelpers.jsx';
import { countRowsImages, usePagePerformanceLog } from '../../../shared/ozon/ozonRuntime.jsx';
import React from 'react';

/**
 * Presentation-only pagination state. Search, filters, sorting and slicing have
 * already been executed by the canonical SQLite query; this hook must never
 * rebuild a full renderer-side product mirror.
 */
export function useProductPaginationState({
  productSort,
  productListQueryFilterSignature = '',
  localProductServerPageMeta,
  productMirrorScopeKey,
  status,
  keyword,
  pageSize,
  page,
  products,
  localProductMirrorStatusCounts,
  productPerformance,
  loading,
  selectedProductKeys,
  batchAnchorEl,
  setPage,
  setSelectedProductKeys,
} = {}) {
  const serverSort = getProductListServerSort(productSort);
  const hasLocalApiServerPageScope =
    localProductServerPageMeta?.scopeKey === productMirrorScopeKey &&
    localProductServerPageMeta?.status === status &&
    localProductServerPageMeta?.keyword === keyword.trim() &&
    (localProductServerPageMeta?.sort || 'stable') === serverSort &&
    (localProductServerPageMeta?.filterSignature || '') === productListQueryFilterSignature &&
    Number(localProductServerPageMeta?.pageSize) === Number(pageSize) &&
    Number.isFinite(Number(localProductServerPageMeta?.total)) &&
    Number(localProductServerPageMeta?.total) >= 0;
  const hasLocalApiServerRowsForCurrentPage =
    hasLocalApiServerPageScope &&
    Number(localProductServerPageMeta?.page) === Number(page) &&
    Number(localProductServerPageMeta?.total) >= products.length;
  const isWaitingForLocalApiServerPage =
    !hasLocalApiServerRowsForCurrentPage && (loading || hasLocalApiServerPageScope);
  const productPagePresentationScopeKey = React.useMemo(
    () =>
      [productMirrorScopeKey, status, keyword.trim(), productListQueryFilterSignature, pageSize, serverSort].join('|'),
    [keyword, pageSize, productListQueryFilterSignature, productMirrorScopeKey, serverSort, status]
  );
  const lastResolvedProductPageRef = React.useRef({
    scopeKey: '',
    pagination: null,
  });

  const serverPageRows = React.useMemo(
    () => (hasLocalApiServerRowsForCurrentPage ? products : []),
    [hasLocalApiServerRowsForCurrentPage, products]
  );
  const scopedStatusCounts =
    localProductMirrorStatusCounts?.scopeKey === productMirrorScopeKey &&
    localProductMirrorStatusCounts?.counts &&
    typeof localProductMirrorStatusCounts.counts === 'object'
      ? localProductMirrorStatusCounts.counts
      : createEmptyProductStatusCounts();
  const visibleProductStatusCounts = scopedStatusCounts;
  const filteredProducts = serverPageRows;

  const productPagination = React.useMemo(() => {
    if (!hasLocalApiServerRowsForCurrentPage) {
      const lastResolvedPagination =
        lastResolvedProductPageRef.current.scopeKey === productPagePresentationScopeKey
          ? lastResolvedProductPageRef.current.pagination
          : null;
      const totalRows = Math.max(0, Number(lastResolvedPagination?.totalRows) || 0);
      const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
      const currentPage = Math.min(Math.max(Number(page) || 1, 1), totalPages);
      return {
        rows: [],
        totalRows,
        totalPages,
        currentPage,
        rangeStart: 0,
        rangeEnd: 0,
      };
    }
    const totalRows = Math.max(0, Number(localProductServerPageMeta.total) || 0);
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const currentPage = Math.min(Math.max(Number(page) || 1, 1), totalPages);
    const startIndex = (currentPage - 1) * pageSize;
    return {
      rows: serverPageRows,
      totalRows,
      totalPages,
      currentPage,
      rangeStart: totalRows ? startIndex + 1 : 0,
      rangeEnd: Math.min(totalRows, startIndex + serverPageRows.length),
    };
  }, [
    hasLocalApiServerRowsForCurrentPage,
    localProductServerPageMeta?.total,
    page,
    pageSize,
    productPagePresentationScopeKey,
    serverPageRows,
  ]);
  React.useEffect(() => {
    if (!hasLocalApiServerRowsForCurrentPage) return;
    lastResolvedProductPageRef.current = {
      scopeKey: productPagePresentationScopeKey,
      pagination: productPagination,
    };
  }, [hasLocalApiServerRowsForCurrentPage, productPagePresentationScopeKey, productPagination]);
  const totalPages = productPagination.totalPages;
  const pageProducts = productPagination.rows;
  const pageProductsIdentityKey = React.useMemo(
    () =>
      `${productMirrorScopeKey}|${status}|${keyword.trim()}|${productListQueryFilterSignature}|${pageSize}|${page}|${pageProducts
        .map((product) => getProductSelectionKey(product))
        .join('|')}`,
    [keyword, page, pageProducts, pageSize, productListQueryFilterSignature, productMirrorScopeKey, status]
  );
  const deferredPageProducts = React.useDeferredValue(pageProducts);
  const deferredPageProductsIdentityKey = React.useDeferredValue(pageProductsIdentityKey);
  const isProductPageRenderPending = deferredPageProductsIdentityKey !== pageProductsIdentityKey;
  const renderedPageProducts = isProductPageRenderPending ? pageProducts : deferredPageProducts;
  const pageProductImageCount = React.useMemo(() => countRowsImages(renderedPageProducts), [renderedPageProducts]);
  usePagePerformanceLog('商品列表', productPerformance, {
    loading,
    rows: renderedPageProducts.length,
    imageCount: pageProductImageCount,
  });
  const pageProductKeys = React.useMemo(
    () => serverPageRows.map(getProductSelectionKey).filter(Boolean),
    [serverPageRows]
  );
  const selectedProducts = React.useMemo(
    () => serverPageRows.filter((product) => selectedProductKeys.has(getProductSelectionKey(product))),
    [selectedProductKeys, serverPageRows]
  );
  const selectedPageCount = pageProductKeys.filter((key) => selectedProductKeys.has(key)).length;
  const allPageSelected = pageProductKeys.length > 0 && selectedPageCount === pageProductKeys.length;
  const pageSelectionIndeterminate = selectedPageCount > 0 && selectedPageCount < pageProductKeys.length;
  const batchPopoverOpen = Boolean(batchAnchorEl);

  React.useEffect(() => {
    setPage(1);
  }, [keyword, pageSize, productListQueryFilterSignature, productMirrorScopeKey, setPage, status]);
  React.useEffect(() => {
    if (loading || !hasLocalApiServerRowsForCurrentPage || page <= totalPages) return;
    setPage(totalPages);
  }, [hasLocalApiServerRowsForCurrentPage, loading, page, setPage, totalPages]);
  React.useEffect(() => {
    const availableKeys = new Set(serverPageRows.map(getProductSelectionKey).filter(Boolean));
    setSelectedProductKeys((current) => {
      const next = new Set([...current].filter((key) => availableKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [serverPageRows, setSelectedProductKeys]);

  return {
    isWaitingForLocalApiServerPage,
    visibleProductStatusCounts,
    filteredProducts,
    productPagination,
    totalPages,
    isProductPageRenderPending,
    renderedPageProducts,
    pageProductKeys,
    selectedProducts,
    allPageSelected,
    pageSelectionIndeterminate,
    batchPopoverOpen,
  };
}
