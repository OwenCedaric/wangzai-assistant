import {
  getOzonSnapshotSourceKey,
  canUseOzonShop,
  resolveOzonConfiguredShop,
} from '../../../entities/order/orderShopScope.jsx';
import { PRODUCT_PAGE_SIZE_OPTIONS } from '../../../entities/product/productLocalData.jsx';
import { readProductListInitialSnapshot } from '../../../entities/product/productLocalMirror.jsx';
import { applyProductMaterialProfiles } from '../../../services/productMaterialProfileStore';
import { normalizeProductStatusLabel, productStatusToneMap } from '../../../shared/ozon/ozonRuntime.jsx';
import { createProductAdvancedFilterDefaults } from '../../../entities/product/productAdvancedFilters.jsx';
import { useSynchronizedOzonShopSelection } from '../../../entities/order/useSynchronizedOzonShopSelection.jsx';
import React from 'react';

export function useProductBaseState({ shops, activeShopId, isActive } = {}) {
  const activeShop = shops.find((item) => item.id === activeShopId) ?? shops[0];
  // local-api intentionally exposes credential flags rather than encrypted values to the renderer.
  const canReadOzon = canUseOzonShop(activeShop);
  const hasLocalProductScope = Boolean(activeShop?.id);
  const initialProductSnapshot = readProductListInitialSnapshot(activeShop, '全部商品', hasLocalProductScope);
  const initialProductRows = applyProductMaterialProfiles(initialProductSnapshot.rows, activeShop);
  const [status, setStatus] = React.useState('全部商品');
  const [keyword, setKeyword] = React.useState('');
  const [products, setProducts] = React.useState(() => initialProductRows);
  const [loading, setLoading] = React.useState(() => hasLocalProductScope && initialProductSnapshot.rows.length === 0);
  const [productPerformance, setProductPerformance] = React.useState(null);
  const [productLoadError, setProductLoadError] = React.useState('');
  const [editingProduct, setEditingProduct] = React.useState(null);
  const [savingProductId, setSavingProductId] = React.useState('');
  const [productNotice, setProductNotice] = React.useState({ open: false, severity: 'success', message: '' });
  // Canonical source links arrive in each SQLite product DTO. This map only
  // holds unsaved form edits for the current renderer session.
  const [productSourceLinks, setProductSourceLinks] = React.useState({});
  const [productSourceSlotMap, setProductSourceSlotMap] = React.useState({});
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(PRODUCT_PAGE_SIZE_OPTIONS[0]);
  const [selectedProductKeys, setSelectedProductKeys] = React.useState(() => new Set());
  const [batchAnchorEl, setBatchAnchorEl] = React.useState(null);
  const [batchDialog, setBatchDialog] = React.useState({ open: false, action: '', stockValue: '', warehouseId: '' });
  const [archiveConfirmDialog, setArchiveConfirmDialog] = React.useState({
    open: false,
    action: '',
    product: null,
  });
  const [batchSaving, setBatchSaving] = React.useState(false);
  const [batchWarehouseState, setBatchWarehouseState] = React.useState({
    shopId: '',
    loading: false,
    warehouses: [],
    error: '',
  });
  const [advancedFilterAnchorEl, setAdvancedFilterAnchorEl] = React.useState(null);
  const [advancedFilters, setAdvancedFilters] = React.useState(() => createProductAdvancedFilterDefaults());
  const [productSort, setProductSort] = React.useState({ key: '', direction: 'desc' });
  const [productRefreshToken, setProductRefreshToken] = React.useState(0);
  const [productRefreshProgress, setProductRefreshProgress] = React.useState({
    running: false,
    blocking: false,
    total: 0,
    completed: 0,
    errors: 0,
    message: '',
  });
  const [productPageLoading, setProductPageLoading] = React.useState(false);
  const [isProductPageTransitionPending, startProductPageTransition] = React.useTransition();
  const loadRequestRef = React.useRef(0);
  const loadAbortRef = React.useRef(null);
  const productRefreshRunRef = React.useRef(0);
  const batchWarehouseRequestRef = React.useRef(0);
  const productMirrorAvailableShops = React.useMemo(() => (Array.isArray(shops) ? shops.filter(Boolean) : []), [shops]);
  const [shop, setShop] = useSynchronizedOzonShopSelection({
    shops: productMirrorAvailableShops,
    activeShopId,
    onScopeChange: () => {
      loadRequestRef.current += 1;
      loadAbortRef.current?.abort();
      productRefreshRunRef.current += 1;
      batchWarehouseRequestRef.current += 1;
      setProducts([]);
      setProductPerformance(null);
      setProductLoadError('');
      setEditingProduct(null);
      setProductNotice({ open: false, severity: 'success', message: '' });
      setProductSourceLinks({});
      setProductSourceSlotMap({});
      setPage(1);
      setSelectedProductKeys(new Set());
      setBatchAnchorEl(null);
      setBatchDialog({ open: false, action: '', stockValue: '', warehouseId: '' });
      setArchiveConfirmDialog({ open: false, action: '', product: null });
      setBatchWarehouseState({ shopId: '', loading: false, warehouses: [], error: '' });
      setAdvancedFilterAnchorEl(null);
      setProductRefreshProgress({
        running: false,
        blocking: false,
        total: 0,
        completed: 0,
        errors: 0,
        message: '',
      });
      setProductPageLoading(false);
      setLocalProductMirrorStatusCounts({ scopeKey: '', counts: null });
      setLocalProductServerPageMeta({
        scopeKey: '',
        status: '',
        keyword: '',
        page: 1,
        pageSize: PRODUCT_PAGE_SIZE_OPTIONS[0],
        total: 0,
        source: '',
      });
    },
  });
  const productMirrorScopeShops = React.useMemo(() => {
    if (shop === 'all') return productMirrorAvailableShops;
    const selectedShop = resolveOzonConfiguredShop(productMirrorAvailableShops, shop);
    return selectedShop ? [selectedShop] : [];
  }, [productMirrorAvailableShops, shop]);
  const productMirrorScopeKey = React.useMemo(
    () => getOzonSnapshotSourceKey(productMirrorScopeShops),
    [productMirrorScopeShops]
  );
  const [localProductMirrorStatusCounts, setLocalProductMirrorStatusCounts] = React.useState({
    scopeKey: '',
    counts: null,
  });
  const [localProductServerPageMeta, setLocalProductServerPageMeta] = React.useState({
    scopeKey: '',
    status: '',
    keyword: '',
    page: 1,
    pageSize: PRODUCT_PAGE_SIZE_OPTIONS[0],
    total: 0,
    source: '',
  });
  React.useEffect(
    () => () => {
      loadAbortRef.current?.abort();
    },
    []
  );
  React.useEffect(() => {
    const normalizedStatus = normalizeProductStatusLabel(status);
    if (normalizedStatus !== status && productStatusToneMap[normalizedStatus]) {
      setStatus(normalizedStatus);
    }
  }, [status]);

  return {
    activeShop,
    canReadOzon,
    shop,
    setShop,
    status,
    setStatus,
    keyword,
    setKeyword,
    products,
    setProducts,
    loading,
    setLoading,
    productPerformance,
    setProductPerformance,
    productLoadError,
    setProductLoadError,
    editingProduct,
    setEditingProduct,
    savingProductId,
    setSavingProductId,
    productNotice,
    setProductNotice,
    productSourceLinks,
    setProductSourceLinks,
    productSourceSlotMap,
    setProductSourceSlotMap,
    page,
    setPage,
    pageSize,
    setPageSize,
    selectedProductKeys,
    setSelectedProductKeys,
    batchAnchorEl,
    setBatchAnchorEl,
    batchDialog,
    setBatchDialog,
    archiveConfirmDialog,
    setArchiveConfirmDialog,
    batchSaving,
    setBatchSaving,
    batchWarehouseState,
    setBatchWarehouseState,
    advancedFilterAnchorEl,
    setAdvancedFilterAnchorEl,
    advancedFilters,
    setAdvancedFilters,
    productSort,
    setProductSort,
    productRefreshToken,
    setProductRefreshToken,
    productRefreshProgress,
    setProductRefreshProgress,
    productPageLoading,
    setProductPageLoading,
    isProductPageTransitionPending,
    startProductPageTransition,
    loadRequestRef,
    loadAbortRef,
    productRefreshRunRef,
    batchWarehouseRequestRef,
    productMirrorScopeShops,
    productMirrorScopeKey,
    localProductMirrorStatusCounts,
    setLocalProductMirrorStatusCounts,
    localProductServerPageMeta,
    setLocalProductServerPageMeta,
  };
}
