import { canUseOzonShop, getOzonShopClientId, normalizeOzonId } from '../../../entities/order/orderShopScope.jsx';
import {
  canUseCrossBorderOrderOutInfoRead,
  readSavedCrossBorderOrderSettings,
} from '../../../entities/order/crossBorderOrderApi.jsx';
import { clearProductListCacheForShop } from '../../../entities/product/productLocalData.jsx';
import { getOzonWarehouseStockQuantity } from '../../../entities/product/productAttributes.jsx';
import { getSingleProductOwnerShop } from '../../../entities/product/productShopScope.jsx';
import {
  buildOzonStockUpdateItem,
  buildProductArchiveWriteCommand,
  buildProductStockWriteCommand,
  cleanInteger,
  getBusinessOzonStockError,
  getProductOperationLabel,
  getProductSelectionKey,
  getProductWriteFailureMessage,
  isProductWriteExecutionNotConnected,
  OZON_STOCK_WRITE_BATCH_SIZE,
} from '../../../entities/product/productWriteHelpers.jsx';
import {
  isProductWriteReadbackComplete,
  readProductWarehouseOptions,
  selectDefaultProductWarehouse,
  submitProductArchiveWrite,
  submitProductStockWrite,
  submitProductUnarchiveWrite,
} from '../../../services/productModuleClient.js';
import {
  getProductBusOfferId,
  readAndSaveProductBusMeasurement,
  readRecentCrossBorderOrdersForProductBus,
} from '../../../services/productBusMaterialService';
import React from 'react';

function strictWriteOptions() {
  return { humanConfirmed: true, realWrite: true, dryRun: false, timeoutMs: 30_000 };
}

const COMPLETE_WAREHOUSE_STOCK_STATUSES = new Set(['returned', 'returned_empty']);

export function getLocalProductStockForWarehouse(product = {}, warehouseId = '') {
  const safeWarehouseId = normalizeOzonId(warehouseId);
  if (!safeWarehouseId) return null;
  const rawStockInfo = product.raw?.stockInfo ?? product.raw?.stock ?? null;
  const stockInfo =
    Array.isArray(rawStockInfo?.warehouse_stocks) || Array.isArray(rawStockInfo?.warehouseStocks)
      ? rawStockInfo
      : Array.isArray(product.warehouseStocks)
        ? { ...(rawStockInfo || {}), warehouse_stocks: product.warehouseStocks }
        : rawStockInfo;
  const observation =
    product.warehouseStockObservation ??
    product.warehouse_stock_observation ??
    stockInfo?.warehouseStockObservation ??
    stockInfo?.warehouse_stock_observation ??
    null;
  const observationStatus = String(observation?.status || '')
    .trim()
    .toLowerCase();
  const complete =
    product.warehouseStockComplete === true ||
    product.warehouse_stock_complete === true ||
    stockInfo?.warehouseStockComplete === true ||
    stockInfo?.warehouse_stock_complete === true;
  if (!complete || !COMPLETE_WAREHOUSE_STOCK_STATUSES.has(observationStatus)) return null;
  // Exact seller-warehouse match only. product.stock/product.stockValue are
  // the v4 all-channel total and must never become an add/subtract base.
  return getOzonWarehouseStockQuantity(stockInfo, safeWarehouseId);
}

function getBatchStockValue(action, rawValue, currentWarehouseStock = null) {
  const amount = Number(cleanInteger(rawValue));
  if (!Number.isFinite(amount) || amount < 0) return '';
  if (action === 'stockSet') return amount;
  if (!Number.isFinite(currentWarehouseStock)) return '';
  if (action === 'stockAdd') return currentWarehouseStock + amount;
  if (action === 'stockSubtract') return Math.max(0, currentWarehouseStock - amount);
  return '';
}

export function useProductBatchState({
  batchDialog,
  batchWarehouseState,
  shops = [],
  loading,
  archiveConfirmDialog,
  savingProductId,
  savedDefaultWarehouseIds,
  batchWarehouseRequestRef,
  setBatchWarehouseState,
  selectedProducts,
  setProductNotice,
  setBatchAnchorEl,
  setBatchDialog,
  setBatchSaving,
  setSavingProductId,
  refreshProductMaterialViews,
  setSelectedProductKeys,
  loadOzonProducts,
  productRefreshProgress = {},
  productPageLoading,
  isProductPageTransitionPending,
  isProductPageRenderPending,
  isWaitingForLocalApiServerPage,
  page,
  setProductPageLoading,
  startProductPageTransition,
  setPage,
} = {}) {
  const batchActionMeta = {
    unarchive: { title: '批量上架', confirmLabel: '确认上架', type: 'archive' },
    archive: { title: '批量下架', confirmLabel: '确认下架', type: 'archive' },
    stockAdd: { title: '批量加库存', confirmLabel: '确认加库存', type: 'stock', inputLabel: '每个商品增加数量' },
    stockSubtract: { title: '批量减库存', confirmLabel: '确认减库存', type: 'stock', inputLabel: '每个商品减少数量' },
    busRead: { title: '批量读取巴士', confirmLabel: '确认读取', type: 'busRead' },
    stockSet: { title: '批量设置统一库存', confirmLabel: '确认设置库存', type: 'stock', inputLabel: '统一库存数量' },
  };
  const activeBatchMeta = batchActionMeta[batchDialog.action];
  const batchOwnerResolution = React.useMemo(() => {
    if (!selectedProducts.length) return { shop: null, error: '' };
    try {
      return { shop: getSingleProductOwnerShop(selectedProducts, shops), error: '' };
    } catch (error) {
      return {
        shop: null,
        error:
          error?.code === 'PRODUCT_BATCH_SINGLE_SHOP_REQUIRED'
            ? '批量操作只能选择同一个 Ozon 店铺的商品，请按店铺分别操作。'
            : '商品缺少规范 shop_id 或所属店铺已解绑，不能执行批量操作。',
      };
    }
  }, [selectedProducts, shops]);
  const batchOwnerShop = batchOwnerResolution.shop;
  const batchOwnerShopId = String(batchOwnerShop?.id || '').trim();
  const batchOwnerShopIdRef = React.useRef(batchOwnerShopId);
  batchOwnerShopIdRef.current = batchOwnerShopId;
  const batchWarehouseOptions = batchWarehouseState.shopId === batchOwnerShopId ? batchWarehouseState.warehouses : [];
  const batchWarehouseLoading = batchWarehouseState.shopId === batchOwnerShopId && batchWarehouseState.loading;
  const batchWarehouseError =
    batchOwnerResolution.error || (batchWarehouseState.shopId === batchOwnerShopId ? batchWarehouseState.error : '');
  const archiveConfirmActionText = archiveConfirmDialog.action === 'archive' ? '下架' : '上架';
  const archiveConfirmProduct = archiveConfirmDialog.product || {};
  const archiveConfirmProductLabel = getProductOperationLabel(archiveConfirmProduct);
  const archiveConfirmSaving = Boolean(archiveConfirmDialog.open && savingProductId);

  const getBatchDefaultWarehouseId = React.useCallback(
    (warehouses = []) => {
      const preferredId = String(savedDefaultWarehouseIds?.[batchOwnerShopId] ?? '').trim();
      return normalizeOzonId(selectDefaultProductWarehouse(warehouses, preferredId)?.rawId) || '';
    },
    [batchOwnerShopId, savedDefaultWarehouseIds]
  );

  const loadBatchWarehouses = React.useCallback(async () => {
    if (!batchOwnerShopId) return [];
    const requestId = batchWarehouseRequestRef.current + 1;
    batchWarehouseRequestRef.current = requestId;
    const isCurrentBatchWarehouseRequest = () =>
      batchWarehouseRequestRef.current === requestId && batchOwnerShopIdRef.current === batchOwnerShopId;
    setBatchWarehouseState((current) => ({ ...current, shopId: batchOwnerShopId, loading: true, error: '' }));
    try {
      const warehouses = await readProductWarehouseOptions(batchOwnerShopId);
      if (!isCurrentBatchWarehouseRequest()) return [];
      setBatchWarehouseState({
        shopId: batchOwnerShopId,
        loading: false,
        warehouses,
        error: warehouses.length ? '' : 'SQLite 中没有仓库缓存，请先在仓储物流页手动同步仓库。',
      });
      return warehouses;
    } catch (error) {
      if (!isCurrentBatchWarehouseRequest()) return [];
      setBatchWarehouseState({
        shopId: batchOwnerShopId,
        loading: false,
        warehouses: [],
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }, [batchOwnerShopId, batchWarehouseRequestRef, setBatchWarehouseState]);

  const openBatchDialog = (action) => {
    if (selectedProducts.length === 0) {
      setProductNotice({ open: true, severity: 'warning', message: '请先选择商品。' });
      return;
    }
    if (!batchOwnerShop) {
      setProductNotice({ open: true, severity: 'warning', message: batchOwnerResolution.error });
      return;
    }
    setBatchAnchorEl(null);
    const stockAction = batchActionMeta[action]?.type === 'stock';
    setBatchDialog({
      open: true,
      action,
      stockValue: '',
      warehouseId: stockAction ? getBatchDefaultWarehouseId(batchWarehouseOptions) : '',
    });
    if (stockAction && batchWarehouseOptions.length === 0) {
      void loadBatchWarehouses().then((warehouses) => {
        const warehouseId = getBatchDefaultWarehouseId(warehouses);
        if (!warehouseId) return;
        setBatchDialog((current) =>
          current.open && current.action === action && !current.warehouseId ? { ...current, warehouseId } : current
        );
      });
    }
  };

  const reloadCurrentProductPageFromSqlite = React.useCallback(
    async (ownerShop) => {
      clearProductListCacheForShop(ownerShop);
      if (typeof loadOzonProducts === 'function') await loadOzonProducts({ localOnly: true, force: true });
    },
    [loadOzonProducts]
  );

  const executeBatchArchiveWrite = async (action, products) => {
    const ownerShop = getSingleProductOwnerShop(products, shops);
    if (!canUseOzonShop(ownerShop)) throw new Error('商品所属店铺未配置 Ozon 权限。');
    const actionText = action === 'archive' ? '批量下架' : '批量上架';
    const command = buildProductArchiveWriteCommand(ownerShop, products, action, {
      requestedBy: 'product-batch-archive',
    });
    const result =
      action === 'archive'
        ? await submitProductArchiveWrite(command, strictWriteOptions())
        : await submitProductUnarchiveWrite(command, strictWriteOptions());
    if (isProductWriteExecutionNotConnected(result)) throw new Error(getProductWriteFailureMessage(result, actionText));
    if (!isProductWriteReadbackComplete(result)) {
      throw new Error(`${actionText}已提交，但尚未完成 Ozon 回读与 SQLite 合并，不能标记完成。`);
    }
    await reloadCurrentProductPageFromSqlite(ownerShop);
    return products.length;
  };

  const executeBatchStockWrite = async (action, products, stockValue, warehouseId) => {
    const ownerShop = getSingleProductOwnerShop(products, shops);
    if (!canUseOzonShop(ownerShop)) throw new Error('商品所属店铺未配置 Ozon 权限。');
    const rows = products.map((product) => {
      const current = ['stockAdd', 'stockSubtract'].includes(action)
        ? getLocalProductStockForWarehouse(product, warehouseId)
        : null;
      const next = getBatchStockValue(action, stockValue, current);
      if (next === '') {
        throw new Error(
          `${getProductOperationLabel(product)} 的精确分仓库存未完成、已过期或未返回所选仓库，不能用商品总库存计算加减库存。请先重新同步商品分仓库存。`
        );
      }
      return buildOzonStockUpdateItem({ ...product, warehouseId }, next);
    });
    let completed = 0;
    for (let index = 0; index < rows.length; index += OZON_STOCK_WRITE_BATCH_SIZE) {
      const chunk = rows.slice(index, index + OZON_STOCK_WRITE_BATCH_SIZE);
      const command = buildProductStockWriteCommand(ownerShop, chunk, { requestedBy: 'product-batch-stock' });
      const result = await submitProductStockWrite(command, strictWriteOptions());
      if (isProductWriteExecutionNotConnected(result))
        throw new Error(getProductWriteFailureMessage(result, '批量库存设置'));
      if (!isProductWriteReadbackComplete(result)) {
        throw new Error('批量库存已提交，但尚未完成 Ozon 回读与 SQLite 合并，不能标记完成。');
      }
      completed += chunk.length;
    }
    await reloadCurrentProductPageFromSqlite(ownerShop);
    return completed;
  };

  const executeBatchBusRead = async (products) => {
    const ownerShop = getSingleProductOwnerShop(products, shops);
    const settings = readSavedCrossBorderOrderSettings();
    if (!canUseCrossBorderOrderOutInfoRead(settings)) {
      throw new Error('请先在设置里保存跨境巴士企业接口和账号授权。');
    }
    const recentOrders = await readRecentCrossBorderOrdersForProductBus(settings, getOzonShopClientId(ownerShop));
    const results = [];
    for (const product of products) {
      try {
        const readResult = await readAndSaveProductBusMeasurement({ shop: ownerShop, settings, product, recentOrders });
        results.push(readResult);
      } catch (error) {
        results.push({
          status: 'failed',
          offerId: getProductBusOfferId(product),
          reason: String(error?.message || error),
        });
      }
    }
    refreshProductMaterialViews();
    const localOnlyCount = results.filter((item) => item.status === 'saved-local').length;
    const noDataCount = results.filter((item) => item.status === 'no-data').length;
    const failedCount = results.filter((item) => item.status === 'failed').length;
    const firstIssue = results.find((item) => item.warning || item.reason);
    setProductNotice({
      open: true,
      severity: noDataCount || failedCount ? 'warning' : 'success',
      message: `批量读取完成：SQLite 已保存 ${localOnlyCount} 个，无数据 ${noDataCount} 个，失败 ${failedCount} 个。本次读取未自动写入 Ozon。${firstIssue ? ` ${firstIssue.warning || firstIssue.reason}` : ''}`,
    });
  };

  const handleConfirmBatchAction = async () => {
    if (!activeBatchMeta || selectedProducts.length === 0) return;
    if (!batchOwnerShop) {
      setProductNotice({ open: true, severity: 'warning', message: batchOwnerResolution.error });
      return;
    }
    const needsStockValue = Boolean(activeBatchMeta.inputLabel);
    if (needsStockValue && cleanInteger(batchDialog.stockValue) === '') {
      setProductNotice({ open: true, severity: 'warning', message: '请先填写库存数量。' });
      return;
    }
    const warehouseId = normalizeOzonId(batchDialog.warehouseId);
    if (activeBatchMeta.type === 'stock' && (!warehouseId || !Number.isFinite(Number(warehouseId)))) {
      setProductNotice({ open: true, severity: 'warning', message: '请先选择有效的 Ozon 仓库。' });
      return;
    }
    const action = batchDialog.action;
    const products = [...selectedProducts];
    setBatchSaving(true);
    setSavingProductId(`batch-${action}`);
    try {
      if (activeBatchMeta.type === 'busRead') {
        await executeBatchBusRead(products);
      } else if (activeBatchMeta.type === 'archive') {
        const count = await executeBatchArchiveWrite(action, products);
        setProductNotice({
          open: true,
          severity: 'success',
          message: `${activeBatchMeta.title} ${count} 个商品已由 Ozon 回读确认并合并到 SQLite。`,
        });
      } else {
        const count = await executeBatchStockWrite(action, products, batchDialog.stockValue, warehouseId);
        setProductNotice({
          open: true,
          severity: 'success',
          message: `${count} 个商品库存已由 Ozon 回读确认并合并到 SQLite。`,
        });
      }
      setSelectedProductKeys(new Set());
      setBatchDialog({ open: false, action: '', stockValue: '', warehouseId: '' });
    } catch (error) {
      setSelectedProductKeys(new Set(products.map(getProductSelectionKey).filter(Boolean)));
      setProductNotice({
        open: true,
        severity: 'error',
        message:
          activeBatchMeta.type === 'stock'
            ? getBusinessOzonStockError(error)
            : getProductWriteFailureMessage(error, activeBatchMeta.title),
      });
    } finally {
      setBatchSaving(false);
      setSavingProductId('');
    }
  };

  const total = Number(productRefreshProgress.total) || 0;
  const completed = Number(productRefreshProgress.completed) || 0;
  const productRefreshPercent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const productThinProgressVisible = Boolean(
    productRefreshProgress.running || productPageLoading || isProductPageTransitionPending || isProductPageRenderPending
  );
  const productThinProgressTitle = productRefreshProgress.running
    ? `${productRefreshProgress.message || '正在同步商品'} ${completed}/${total} · ${productRefreshPercent}%`
    : productThinProgressVisible
      ? '正在切换商品分页，读取 SQLite 并低优先级渲染。'
      : '';
  const productTablePageBusy = Boolean(
    loading ||
    productPageLoading ||
    isWaitingForLocalApiServerPage ||
    isProductPageTransitionPending ||
    isProductPageRenderPending
  );
  const handleProductPageChange = React.useCallback(
    (_, nextPage) => {
      if (Number(page) === Number(nextPage)) return;
      setProductPageLoading(true);
      startProductPageTransition(() => setPage(nextPage));
    },
    [page, setPage, setProductPageLoading, startProductPageTransition]
  );

  return {
    activeBatchMeta,
    batchWarehouseOptions,
    batchWarehouseLoading,
    batchWarehouseError,
    archiveConfirmActionText,
    archiveConfirmProduct,
    archiveConfirmProductLabel,
    archiveConfirmSaving,
    openBatchDialog,
    handleConfirmBatchAction,
    productRefreshPercent,
    productThinProgressVisible,
    productThinProgressTitle,
    productTablePageBusy,
    handleProductPageChange,
  };
}
