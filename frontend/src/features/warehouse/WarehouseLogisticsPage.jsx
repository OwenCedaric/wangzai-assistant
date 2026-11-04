import {
  canUseOzonShop,
  getActiveOzonShop,
  getOzonRowShopScopeValues,
  getOzonShopClientId,
  getOzonShopLabel,
  getOzonSnapshotSourceKey,
  normalizeOzonId,
} from '../../entities/order/orderShopScope.jsx';
import {
  PRODUCT_PAGE_SIZE_OPTIONS,
  recordLocalMirrorReadLog,
} from '../../entities/product/productLocalData.jsx';
import {
  getDeliveryMethodStatusColor,
  getDeliveryMethodStatusLabel,
  getDefaultOzonWarehouse,
  getOzonApiErrorMessage,
  getOzonDeliveryMethodDisplayName,
  getWarehouseStatusColor,
  getWarehouseStatusLabel,
  requestOzonWarehouseConfigSnapshot,
  requestOzonWarehouseProductsSnapshot,
} from '../../entities/product/productOzonApi.jsx';
import {
  buildRowsIndex,
  paginateRows,
  queryRowsIndex,
  validatePageDatasetConsistency,
} from '../../services/localMirrorDataset';
import { defaultOzonShops } from '../../shared/config/appConfigCore.jsx';
import { readSavedOzonDefaultWarehouseIds, saveOzonDefaultWarehouseIds } from '../../shared/ozon/ozonRuntime.jsx';
import { WarehouseFreightEstimatorCard } from './ui/WarehouseFreightEstimatorCard.jsx';
import { WarehouseOzonCreateDialog } from './ui/WarehouseOzonCreateDialog.jsx';
import { WarehouseOzonManagementDialog } from './ui/WarehouseOzonManagementDialog.jsx';
import { WarehouseProductIdentity } from './ui/WarehouseProductIdentity.jsx';
import AddRounded from '@mui/icons-material/AddRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import LocalShippingRounded from '@mui/icons-material/LocalShippingRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import SearchRounded from '@mui/icons-material/SearchRounded';
import WarehouseRounded from '@mui/icons-material/WarehouseRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Dialog from '../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import InputAdornment from '@mui/material/InputAdornment';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Pagination from '@mui/material/Pagination';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

function createEmptyWarehouseConfigSnapshot() {
  return {
    status: 'idle',
    warehouses: [],
    deliveryMethods: [],
    fetchedAt: '',
    error: '',
    warnings: [],
  };
}

function createEmptyWarehouseProductSnapshot() {
  return {
    status: 'idle',
    rows: [],
    total: 0,
    fetchedAt: '',
    error: '',
    warnings: [],
  };
}

export function WarehouseLogisticsPage({ shops, activeShopId, onActiveShopChange, isActive = true }) {
  const activeShop = React.useMemo(() => getActiveOzonShop(shops, activeShopId), [shops, activeShopId]);
  const canReadWarehouseConfig = canUseOzonShop(activeShop);
  const availableShops = Array.isArray(shops) && shops.length ? shops : defaultOzonShops;
  const [snapshot, setSnapshot] = React.useState(createEmptyWarehouseConfigSnapshot);
  const [selectedWarehouseId, setSelectedWarehouseId] = React.useState('');
  const [selectedMethodId, setSelectedMethodId] = React.useState('');
  const [methodKeyword, setMethodKeyword] = React.useState('');
  const [productSnapshot, setProductSnapshot] = React.useState(createEmptyWarehouseProductSnapshot);
  const [productKeyword, setProductKeyword] = React.useState('');
  const [selectedProductId, setSelectedProductId] = React.useState('');
  const [productPage, setProductPage] = React.useState(1);
  const [productPageSize, setProductPageSize] = React.useState(PRODUCT_PAGE_SIZE_OPTIONS[0]);
  const [defaultWarehouseIds, setDefaultWarehouseIds] = React.useState(readSavedOzonDefaultWarehouseIds);
  const [defaultWarehouseDialogOpen, setDefaultWarehouseDialogOpen] = React.useState(false);
  const [warehouseManagementOpen, setWarehouseManagementOpen] = React.useState(false);
  const [warehouseCreateOpen, setWarehouseCreateOpen] = React.useState(false);
  const [managedDeliveryMethod, setManagedDeliveryMethod] = React.useState(null);
  const activeWarehouseShopKey = getOzonSnapshotSourceKey(activeShop);
  const activeWarehouseShopKeyRef = React.useRef(activeWarehouseShopKey);
  const warehousePageActiveRef = React.useRef(isActive);
  const warehouseConfigRequestRef = React.useRef(0);
  const warehouseProductRequestRef = React.useRef(0);

  warehousePageActiveRef.current = isActive;

  if (activeWarehouseShopKeyRef.current !== activeWarehouseShopKey) {
    activeWarehouseShopKeyRef.current = activeWarehouseShopKey;
    warehouseConfigRequestRef.current += 1;
    warehouseProductRequestRef.current += 1;
  }

  React.useEffect(() => {
    if (!isActive) return undefined;
    let cancelled = false;
    const hydrationShopKey = activeWarehouseShopKey;
    const isCurrentHydration = () =>
      !cancelled && warehousePageActiveRef.current && activeWarehouseShopKeyRef.current === hydrationShopKey;

    // A request from the previous shop may still be resolving. Clear its
    // loading/data state before hydrating the newly selected shop so stale
    // requests cannot leave the refresh button permanently disabled or show
    // another shop's warehouses/products while the new cache is empty.
    setSnapshot(createEmptyWarehouseConfigSnapshot());
    setProductSnapshot(createEmptyWarehouseProductSnapshot());

    if (!activeShop) return undefined;

    requestOzonWarehouseConfigSnapshot(activeShop, {
      includeInactive: true,
      forceRefresh: false,
      timeoutMs: 6000,
    })
      .then((cached) => {
        if (!isCurrentHydration() || !cached) return;
        const warehouses = Array.isArray(cached.warehouses) ? cached.warehouses : [];
        const deliveryMethods = Array.isArray(cached.deliveryMethods) ? cached.deliveryMethods : [];
        if (!warehouses.length && !deliveryMethods.length) return;
        setSnapshot({
          status: cached.status === 'partial' ? 'partial' : 'success',
          warehouses,
          deliveryMethods,
          fetchedAt: cached.fetchedAt || cached.localUpdatedAt || '',
          error: '',
          warnings: Array.isArray(cached.warnings) ? cached.warnings : [],
        });
      })
      .catch(() => undefined);

    requestOzonWarehouseProductsSnapshot(activeShop, {
      hydrate: false,
      autoSync: false,
      forceRefresh: false,
      timeoutMs: 6000,
    })
      .then((cached) => {
        if (!isCurrentHydration() || !cached || !Array.isArray(cached.rows) || !cached.rows.length) return;
        setProductSnapshot({
          status: 'success',
          rows: cached.rows,
          total: cached.total || cached.rows.length,
          fetchedAt: cached.fetchedAt || cached.localUpdatedAt || '',
          error: '',
          warnings: Array.isArray(cached.warnings) ? cached.warnings : [],
        });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [activeShop, activeWarehouseShopKey, isActive]);

  const loadWarehouseConfig = React.useCallback(async () => {
    if (!isActive) return;
    const requestShopKey = activeWarehouseShopKey;
    const requestId = warehouseConfigRequestRef.current + 1;
    warehouseConfigRequestRef.current = requestId;
    const isCurrentRequest = () =>
      warehousePageActiveRef.current &&
      warehouseConfigRequestRef.current === requestId &&
      activeWarehouseShopKeyRef.current === requestShopKey;

    if (!canReadWarehouseConfig) {
      setSnapshot({
        status: 'blocked',
        warehouses: [],
        deliveryMethods: [],
        fetchedAt: '',
        error: '当前店铺未配置客户编号或接口密钥，无法读取 Ozon 仓库配置',
        warnings: [],
      });
      return;
    }

    setSnapshot((current) => ({ ...current, status: 'loading', error: '', warnings: [] }));
    try {
      const nextSnapshot = await requestOzonWarehouseConfigSnapshot(activeShop, {
        includeInactive: true,
        forceRefresh: true,
        timeoutMs: 25_000,
        logisticsSyncTimeoutMs: 20_000,
      });
      if (!isCurrentRequest()) return;
      const hasWarehouseConfigRows =
        (Array.isArray(nextSnapshot.warehouses) && nextSnapshot.warehouses.length > 0) ||
        (Array.isArray(nextSnapshot.deliveryMethods) && nextSnapshot.deliveryMethods.length > 0);
      if (!hasWarehouseConfigRows) {
        setSnapshot((current) => {
          if (!isCurrentRequest()) return current;
          const hasCurrentRows =
            (Array.isArray(current.warehouses) && current.warehouses.length > 0) ||
            (Array.isArray(current.deliveryMethods) && current.deliveryMethods.length > 0);
          if (!hasCurrentRows) return { ...nextSnapshot, status: 'success', error: '' };
          return {
            ...current,
            status: 'partial',
            error: '',
            warnings: [
              ...(Array.isArray(current.warnings) ? current.warnings : []),
              '本次仓库接口未返回配置，已保留上次读取结果',
            ],
          };
        });
        return;
      }
      setSnapshot({ ...nextSnapshot, error: '' });
    } catch (error) {
      if (!isCurrentRequest()) return;
      setSnapshot((current) => {
        const hasCurrentRows =
          (Array.isArray(current.warehouses) && current.warehouses.length > 0) ||
          (Array.isArray(current.deliveryMethods) && current.deliveryMethods.length > 0);
        return {
          ...current,
          status: hasCurrentRows ? 'partial' : 'error',
          error: hasCurrentRows ? '' : error instanceof Error ? error.message : String(error),
          warnings: hasCurrentRows
            ? [...(Array.isArray(current.warnings) ? current.warnings : []), '后台刷新未完成，已保留本机仓库和配送方式']
            : (current.warnings ?? []),
        };
      });
    }
  }, [activeShop, activeWarehouseShopKey, canReadWarehouseConfig, isActive]);

  const loadWarehouseProducts = React.useCallback(async () => {
    if (!isActive) return;
    const requestShopKey = activeWarehouseShopKey;
    const requestId = warehouseProductRequestRef.current + 1;
    warehouseProductRequestRef.current = requestId;
    const isCurrentRequest = () =>
      warehousePageActiveRef.current &&
      warehouseProductRequestRef.current === requestId &&
      activeWarehouseShopKeyRef.current === requestShopKey;

    if (!canReadWarehouseConfig) {
      setProductSnapshot({
        status: 'blocked',
        rows: [],
        total: 0,
        fetchedAt: '',
        error: '当前店铺未配置客户编号或接口密钥，无法读取 Ozon 商品',
        warnings: [],
      });
      return;
    }

    setProductSnapshot((current) => ({ ...current, status: 'loading', error: '', warnings: [] }));
    try {
      const nextSnapshot = await requestOzonWarehouseProductsSnapshot(activeShop, {
        hydrate: false,
        autoSync: true,
        forceRefresh: true,
      });
      if (!isCurrentRequest()) return;
      const hasProductRows = Array.isArray(nextSnapshot.rows) && nextSnapshot.rows.length > 0;
      if (!hasProductRows) {
        setProductSnapshot((current) => {
          if (!isCurrentRequest()) return current;
          if (!Array.isArray(current.rows) || current.rows.length === 0) {
            return { ...nextSnapshot, status: 'success', error: '' };
          }
          return {
            ...current,
            status: 'partial',
            error: '',
            warnings: [
              ...(Array.isArray(current.warnings) ? current.warnings : []),
              '本次商品接口未返回商品，已保留上次读取结果',
            ],
          };
        });
        return;
      }
      setProductSnapshot({ ...nextSnapshot, status: 'success', error: '' });
    } catch (error) {
      if (!isCurrentRequest()) return;
      setProductSnapshot((current) => {
        const hasCurrentRows = Array.isArray(current.rows) && current.rows.length > 0;
        return {
          ...current,
          status: hasCurrentRows ? 'partial' : 'error',
          error: hasCurrentRows ? '' : `商品读取失败：${getOzonApiErrorMessage(error)}`,
          warnings: hasCurrentRows
            ? [...(Array.isArray(current.warnings) ? current.warnings : []), '后台刷新未完成，已保留本机商品数据']
            : (current.warnings ?? []),
        };
      });
    }
  }, [activeShop, activeWarehouseShopKey, canReadWarehouseConfig, isActive]);

  const refreshWarehousePage = React.useCallback(() => {
    loadWarehouseConfig();
    loadWarehouseProducts();
  }, [loadWarehouseConfig, loadWarehouseProducts]);

  React.useEffect(() => {
    setSelectedWarehouseId('');
    setSelectedMethodId('');
    setSelectedProductId('');
    setProductPage(1);
    setMethodKeyword('');
    setProductKeyword('');
    setDefaultWarehouseDialogOpen(false);
    setWarehouseManagementOpen(false);
    setWarehouseCreateOpen(false);
    setManagedDeliveryMethod(null);
  }, [activeShop?.id]);

  const shopDefaultWarehouseId = defaultWarehouseIds[activeShop?.id] || '';

  React.useEffect(() => {
    if (!snapshot.warehouses.length) {
      setSelectedWarehouseId('');
      return;
    }
    const hasSelectedWarehouse = snapshot.warehouses.some((warehouse) => warehouse.id === selectedWarehouseId);
    if (!hasSelectedWarehouse) {
      setSelectedWarehouseId(getDefaultOzonWarehouse(snapshot.warehouses, shopDefaultWarehouseId)?.id || '');
    }
  }, [selectedWarehouseId, shopDefaultWarehouseId, snapshot.warehouses]);

  const warehouses = snapshot.warehouses;
  const deliveryMethods = snapshot.deliveryMethods;
  const defaultWarehouse = getDefaultOzonWarehouse(warehouses, shopDefaultWarehouseId);
  const selectedWarehouse = warehouses.find((warehouse) => warehouse.id === selectedWarehouseId) ?? defaultWarehouse;
  const isSelectedWarehouseDefault = Boolean(selectedWarehouse && defaultWarehouse?.id === selectedWarehouse.id);
  const loading = snapshot.status === 'loading';
  const productLoading = productSnapshot.status === 'loading';
  const refreshing = loading || productLoading;
  const hasLoadedWarehouseConfig = snapshot.status === 'success' || snapshot.status === 'partial';

  const getMethodsForWarehouse = React.useCallback(
    (warehouse) => {
      if (!warehouse) return [];
      const warehouseId = normalizeOzonId(warehouse.rawId);
      if (!warehouseId || warehouseId === '未返回') return [];
      return deliveryMethods.filter((method) => method.warehouseId === warehouseId);
    },
    [deliveryMethods]
  );

  const selectedWarehouseMethods = React.useMemo(
    () => getMethodsForWarehouse(selectedWarehouse),
    [getMethodsForWarehouse, selectedWarehouse]
  );
  const warehouseIdSet = React.useMemo(
    () => new Set(warehouses.map((warehouse) => normalizeOzonId(warehouse.rawId)).filter(Boolean)),
    [warehouses]
  );
  const unmatchedMethods = React.useMemo(
    () =>
      deliveryMethods.filter((method) => {
        const warehouseId = normalizeOzonId(method.warehouseId);
        return !warehouseId || !warehouseIdSet.has(warehouseId);
      }),
    [deliveryMethods, warehouseIdSet]
  );
  const isShowingUnmatchedMethods = Boolean(
    hasLoadedWarehouseConfig && deliveryMethods.length && !selectedWarehouseMethods.length && unmatchedMethods.length
  );
  const currentMethodRows = isShowingUnmatchedMethods ? unmatchedMethods : selectedWarehouseMethods;
  const warehouseMethodRowsIndex = React.useMemo(
    () =>
      buildRowsIndex(currentMethodRows, {
        getRowKey: (method) => method.id || method.rawId,
        getSearchValues: (method) => [
          getOzonDeliveryMethodDisplayName(method),
          method.rawId,
          getDeliveryMethodStatusLabel(method.status),
        ],
      }),
    [currentMethodRows]
  );
  const filteredMethods = React.useMemo(() => {
    const keyword = methodKeyword.trim().toLowerCase();
    return queryRowsIndex(warehouseMethodRowsIndex, { keyword }).filter((method) => {
      if (!keyword) return true;
      return [getOzonDeliveryMethodDisplayName(method), method.rawId, getDeliveryMethodStatusLabel(method.status)]
        .join(' ')
        .toLowerCase()
        .includes(keyword);
    });
  }, [methodKeyword, warehouseMethodRowsIndex]);

  React.useEffect(() => {
    if (!filteredMethods.length) {
      setSelectedMethodId('');
      return;
    }
    const hasSelectedMethod = filteredMethods.some((method) => method.id === selectedMethodId);
    if (!hasSelectedMethod) {
      setSelectedMethodId(filteredMethods[0].id);
    }
  }, [filteredMethods, selectedMethodId]);

  React.useEffect(() => {
    if (!productSnapshot.rows.length) {
      setSelectedProductId('');
      return;
    }
    const hasSelectedProduct = productSnapshot.rows.some((product) => product.id === selectedProductId);
    if (!hasSelectedProduct) {
      setSelectedProductId(productSnapshot.rows[0].id);
    }
  }, [productSnapshot.rows, selectedProductId]);

  const selectedMethod = deliveryMethods.find((method) => method.id === selectedMethodId) ?? null;
  const productRows = productSnapshot.rows;
  const warehouseProductRowsIndex = React.useMemo(
    () =>
      buildRowsIndex(productRows, {
        getRowKey: (product) => product.id || product.productId || product.offerId || product.ozonSku,
        getRowShop: () => getOzonRowShopScopeValues(activeShop),
        getRowStatuses: (product) => [product.status, product.warehouseStatus],
        getSearchValues: (product) => [
          product.name,
          product.offerId,
          product.ozonSku,
          product.productId,
          product.status,
          product.warehouseStatus,
        ],
      }),
    [activeShop, productRows]
  );
  const filteredProducts = React.useMemo(() => {
    const keyword = productKeyword.trim().toLowerCase();
    return queryRowsIndex(warehouseProductRowsIndex, { keyword }).filter((product) => {
      if (!keyword) return true;
      return [
        product.name,
        product.offerId,
        product.ozonSku,
        product.productId,
        product.status,
        product.warehouseStatus,
      ]
        .join(' ')
        .toLowerCase()
        .includes(keyword);
    });
  }, [productKeyword, warehouseProductRowsIndex]);
  const warehouseProductPagination = React.useMemo(
    () => paginateRows(filteredProducts, productPage, productPageSize),
    [filteredProducts, productPage, productPageSize]
  );
  const warehouseProductDatasetConsistency = React.useMemo(
    () =>
      validatePageDatasetConsistency(
        {
          countRows: productRows,
          filteredRows: filteredProducts,
          statusCounts: { all: productRows.length },
          pageRows: warehouseProductPagination.rows,
          page: warehouseProductPagination,
          detailRow: productRows.find((product) => product.id === selectedProductId) ?? null,
          detailSourceRows: productRows,
        },
        {
          allStatusValue: 'all',
          getRowKey: (product) => product.id || product.productId || product.offerId || product.ozonSku,
        }
      ),
    [filteredProducts, productRows, selectedProductId, warehouseProductPagination]
  );
  const warehouseConsistencyLogKeyRef = React.useRef('');
  React.useEffect(() => {
    if (!isActive) return;
    const consistencyLogKey = [
      activeWarehouseShopKey,
      snapshot.status,
      productSnapshot.status,
      methodKeyword,
      productKeyword,
      productPage,
      productPageSize,
      productRows.length,
      filteredProducts.length,
      warehouseProductPagination.totalRows,
      warehouseProductDatasetConsistency.ok
        ? 'ok'
        : warehouseProductDatasetConsistency.issues.map((issue) => issue.code).join(','),
    ].join('|');
    if (warehouseConsistencyLogKeyRef.current === consistencyLogKey) return;
    warehouseConsistencyLogKeyRef.current = consistencyLogKey;
    recordLocalMirrorReadLog({
      domain: '12_warehouse_logistics',
      shopScope: activeShop?.id || 'unknown',
      source: refreshing ? 'remote-refresh' : productRows.length || warehouses.length ? 'local-cache' : 'idle',
      status: warehouseProductDatasetConsistency.ok ? 'consistency-ok' : 'consistency-failed',
      rows: productRows.length,
      failures: warehouseProductDatasetConsistency.issues.length,
      partial:
        !warehouseProductDatasetConsistency.ok || snapshot.status === 'partial' || productSnapshot.status === 'partial',
      refreshedAt: productSnapshot.fetchedAt || snapshot.fetchedAt || new Date().toISOString(),
      details: {
        configSnapshotScope: 'ozon-warehouse-config',
        productsSnapshotScope: 'ozon-warehouse-products',
        shopId: activeShop?.id || 'unknown',
        configStatus: snapshot.status,
        productStatus: productSnapshot.status,
        warehouses: warehouses.length,
        deliveryMethods: deliveryMethods.length,
        filteredRows: filteredProducts.length,
        pageRows: warehouseProductPagination.rows.length,
        pageTotalRows: warehouseProductPagination.totalRows,
        methodKeyword,
        productKeyword,
        consistency: warehouseProductDatasetConsistency,
      },
    }).catch(() => undefined);
  }, [
    activeShop,
    activeWarehouseShopKey,
    deliveryMethods.length,
    filteredProducts.length,
    isActive,
    methodKeyword,
    productKeyword,
    productPage,
    productPageSize,
    productRows.length,
    productSnapshot.fetchedAt,
    productSnapshot.status,
    refreshing,
    snapshot.fetchedAt,
    snapshot.status,
    warehouseProductDatasetConsistency,
    warehouseProductPagination.rows.length,
    warehouseProductPagination.totalRows,
    warehouses.length,
  ]);
  const productPageCount = warehouseProductPagination.totalPages;
  const productPageRows = warehouseProductPagination.rows;
  const productPageStart = warehouseProductPagination.rangeStart;
  const productPageEnd = warehouseProductPagination.rangeEnd;
  const selectedProduct = productRows.find((product) => product.id === selectedProductId) ?? null;

  React.useEffect(() => {
    setProductPage(1);
  }, [productKeyword, productPageSize]);

  React.useEffect(() => {
    setProductPage((current) => Math.min(current, productPageCount));
  }, [productPageCount]);

  const unlinkedMethodCount = unmatchedMethods.length;
  const warehouseEmptyTitle =
    snapshot.status === 'blocked'
      ? '未配置店铺密钥'
      : hasLoadedWarehouseConfig
        ? 'Ozon 本次未返回仓库'
        : '尚未读取仓库';
  const warehouseEmptyDescription =
    snapshot.status === 'blocked'
      ? '请先确认当前店铺已配置 Ozon 客户编号和接口密钥，然后重新读取。'
      : hasLoadedWarehouseConfig
        ? '接口已完成读取，但 Ozon 当前没有返回仓库列表。请到 Ozon 后台确认该店铺是否配置卖家配送仓库。'
        : '点击「刷新真实数据」后，会强制同步 Ozon 仓库并等待本地回读。';
  const statCards = [
    {
      title: 'Ozon 仓库',
      value: hasLoadedWarehouseConfig ? warehouses.length : '未返回',
      helper: hasLoadedWarehouseConfig ? '已接入 Ozon 后台读取' : '等待真实读取',
      tone: 'primary',
    },
    {
      title: '配送方式',
      value: hasLoadedWarehouseConfig ? deliveryMethods.length : '未返回',
      helper: hasLoadedWarehouseConfig ? '已接入 Ozon 后台读取' : '等待真实读取',
      tone: 'success',
    },
    {
      title: '当前仓库方式',
      value: hasLoadedWarehouseConfig && selectedWarehouse ? currentMethodRows.length : '未返回',
      helper: isShowingUnmatchedMethods
        ? `未匹配仓库 ${unlinkedMethodCount} 条`
        : selectedWarehouse?.name || '未选择仓库',
      tone: 'warning',
    },
    {
      title: '商品读取',
      value: productRows.length ? productRows.length : '未返回',
      helper: productSnapshot.total ? `Ozon 返回总数 ${productSnapshot.total}` : '商品接口返回数量',
      tone: 'error',
    },
  ];

  const handleShopChange = (event) => {
    onActiveShopChange?.(event.target.value);
  };

  const handleSelectProduct = (product) => {
    if (!product?.id) return;
    setSelectedProductId(product.id);
  };

  const handleSetDefaultWarehouse = () => {
    if (!selectedWarehouse || !activeShop?.id) return;
    const nextDefaultWarehouseIds = {
      ...defaultWarehouseIds,
      [activeShop.id]: selectedWarehouse.id,
    };
    setDefaultWarehouseIds(nextDefaultWarehouseIds);
    saveOzonDefaultWarehouseIds(nextDefaultWarehouseIds);
    setSelectedWarehouseId(selectedWarehouse.id);
    setDefaultWarehouseDialogOpen(true);
  };

  const openWarehouseManagement = () => {
    if (!selectedWarehouse) return;
    setManagedDeliveryMethod(null);
    setWarehouseManagementOpen(true);
  };

  const openDeliveryMethodManagement = (method) => {
    if (!selectedWarehouse || !method) return;
    setSelectedMethodId(method.id);
    setManagedDeliveryMethod(method);
    setWarehouseManagementOpen(true);
  };

  const closeWarehouseManagement = () => {
    setWarehouseManagementOpen(false);
    setManagedDeliveryMethod(null);
  };

  const completeWarehouseManagement = async () => {
    await loadWarehouseConfig();
  };

  return (
    <>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        alignItems={{ xs: 'stretch', md: 'center' }}
        justifyContent="space-between"
        spacing={2}
        mb={3}
      >
        <Box>
          <Typography variant="h4">仓储物流</Typography>
          <Typography color="text.secondary" mt={0.75}>
            读取并管理 Ozon 真实仓库与配送方式，同时按多家物流资费测算运费
          </Typography>
        </Box>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} className="hero-actions">
          <FormControl size="small" className="warehouse-shop-select">
            <Select value={activeShop?.id || ''} displayEmpty onChange={handleShopChange}>
              {availableShops.map((shop) => (
                <MenuItem key={shop.id} value={shop.id}>
                  {getOzonShopLabel(shop)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button
            variant="outlined"
            startIcon={<AddRounded />}
            onClick={() => setWarehouseCreateOpen(true)}
            disabled={!canReadWarehouseConfig || refreshing}
          >
            新建仓库/配送方式
          </Button>
          <Button
            variant="contained"
            startIcon={<RefreshRounded />}
            onClick={refreshWarehousePage}
            disabled={refreshing || !canReadWarehouseConfig}
          >
            刷新真实数据
          </Button>
        </Stack>
      </Stack>

      <Stack spacing={1.5} mb={2}>
        {snapshot.warnings.map((warning) => (
          <Alert key={warning} severity="warning">
            {warning}
          </Alert>
        ))}
        {snapshot.error ? (
          <Alert severity={snapshot.status === 'blocked' ? 'warning' : 'error'}>{snapshot.error}</Alert>
        ) : null}
      </Stack>

      {refreshing ? <LinearProgress sx={{ mb: 2 }} /> : null}

      <Box className="warehouse-logistics-stat-grid">
        {statCards.map((card) => (
          <Card key={card.title} className={`warehouse-logistics-stat preview-${card.tone}`}>
            <CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
                <Box>
                  <Typography color="text.secondary" variant="body2">
                    {card.title}
                  </Typography>
                  <Typography variant="h4" mt={1}>
                    {card.value}
                  </Typography>
                  <Typography color="text.secondary" variant="caption">
                    {card.helper}
                  </Typography>
                </Box>
                <Box className={`metric-icon tone-${card.tone}`}>
                  {card.title === 'Ozon 仓库' ? <WarehouseRounded /> : <LocalShippingRounded />}
                </Box>
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Box>

      <Box className="warehouse-logistics-layout">
        <Stack spacing={2} className="warehouse-left-stack">
          <Card className="warehouse-logistics-card">
            <CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
                <Box>
                  <Typography variant="h6">仓库配置</Typography>
                  <Typography variant="body2" color="text.secondary">
                    查看并管理 Ozon 返回的仓库
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1} alignItems="center" className="warehouse-default-actions">
                  <Chip label={`${warehouses.length} 个仓库`} color="primary" variant="outlined" />
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<EditRounded />}
                    disabled={!selectedWarehouse || refreshing}
                    onClick={openWarehouseManagement}
                  >
                    管理 Ozon 仓库
                  </Button>
                  <Button
                    size="small"
                    variant={isSelectedWarehouseDefault ? 'contained' : 'outlined'}
                    startIcon={<SaveRounded />}
                    disabled={!selectedWarehouse}
                    onClick={handleSetDefaultWarehouse}
                  >
                    {isSelectedWarehouseDefault ? '本系统默认仓' : '设为本系统默认仓'}
                  </Button>
                </Stack>
              </Stack>

              <Stack spacing={1.25}>
                {warehouses.length ? (
                  warehouses.map((warehouse) => {
                    const selected = warehouse.id === selectedWarehouse?.id;
                    return (
                      <Box
                        key={warehouse.id}
                        role="button"
                        tabIndex={0}
                        className={`warehouse-row ${selected ? 'is-selected' : ''}`}
                        onClick={() => setSelectedWarehouseId(warehouse.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') setSelectedWarehouseId(warehouse.id);
                        }}
                      >
                        <Stack
                          direction={{ xs: 'column', md: 'row' }}
                          justifyContent="space-between"
                          alignItems={{ xs: 'flex-start', md: 'center' }}
                          spacing={1}
                        >
                          <Box>
                            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                              <Typography variant="subtitle1">{warehouse.name}</Typography>
                              <Chip
                                size="small"
                                color={getWarehouseStatusColor(warehouse.status)}
                                label={getWarehouseStatusLabel(warehouse.status)}
                                variant={selected ? 'filled' : 'outlined'}
                              />
                              {defaultWarehouse?.id === warehouse.id ? (
                                <Chip size="small" color="primary" label="默认仓" variant="outlined" />
                              ) : null}
                              {warehouse.raw?.is_rfbs === true ? (
                                <Chip size="small" color="info" label="rFBS" variant="outlined" />
                              ) : null}
                            </Stack>
                            <Typography variant="caption" color="text.secondary">
                              仓库编号：{warehouse.rawId}
                            </Typography>
                          </Box>
                        </Stack>
                      </Box>
                    );
                  })
                ) : (
                  <Box className="warehouse-empty-state">
                    <WarehouseRounded />
                    <Typography variant="subtitle1">{warehouseEmptyTitle}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {warehouseEmptyDescription}
                    </Typography>
                  </Box>
                )}
              </Stack>
            </CardContent>
          </Card>

          <Card className="warehouse-logistics-card warehouse-product-card">
            <CardContent>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                justifyContent="space-between"
                spacing={1.5}
                mb={2}
                className="warehouse-product-header"
              >
                <Typography variant="h6">商品选择</Typography>
                <Stack direction="row" spacing={1} className="warehouse-product-header-actions">
                  <FormControl size="small" className="warehouse-product-page-size-select">
                    <Select
                      value={productPageSize}
                      onChange={(event) => setProductPageSize(Number(event.target.value))}
                      renderValue={(value) => `${value}/页`}
                    >
                      {PRODUCT_PAGE_SIZE_OPTIONS.map((option) => (
                        <MenuItem key={option} value={option}>
                          {option} 条
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <Typography variant="body2" color="text.secondary" className="warehouse-product-page-range">
                    {productPageStart}-{productPageEnd} / {filteredProducts.length}
                  </Typography>
                  <Pagination
                    className="warehouse-product-pagination"
                    count={productPageCount}
                    page={productPage}
                    onChange={(_, nextPage) => setProductPage(nextPage)}
                    shape="rounded"
                    size="small"
                    siblingCount={0}
                    boundaryCount={1}
                  />
                </Stack>
              </Stack>
              <TextField
                size="small"
                placeholder="搜索商品、货号、库存编码"
                value={productKeyword}
                onChange={(event) => setProductKeyword(event.target.value)}
                fullWidth
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchRounded />
                    </InputAdornment>
                  ),
                }}
              />
              {productLoading ? <LinearProgress sx={{ mt: 1.5 }} /> : null}
              {productSnapshot.error ? (
                <Alert severity="error" sx={{ mt: 1.5 }}>
                  {productSnapshot.error}
                </Alert>
              ) : null}
              {productSnapshot.warnings.map((warning) => (
                <Alert key={warning} severity="warning" sx={{ mt: 1.5 }}>
                  {warning}
                </Alert>
              ))}
              <TableContainer className="warehouse-product-table-wrap">
                <Table stickyHeader size="small" className="warehouse-product-table">
                  <TableHead>
                    <TableRow>
                      <TableCell>商品</TableCell>
                      <TableCell>商品仓库</TableCell>
                      <TableCell>状态</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredProducts.length ? (
                      productPageRows.map((product) => (
                        <TableRow
                          hover
                          key={product.id}
                          selected={selectedProductId === product.id}
                          onClick={() => handleSelectProduct(product)}
                        >
                          <TableCell>
                            <WarehouseProductIdentity product={product} />
                          </TableCell>
                          <TableCell>
                            <Typography variant="subtitle2">{product.warehouseStatus || '未返回'}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              {product.warehouseId ? product.warehouseSource : 'Ozon 未返回仓库编号'}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Chip size="small" label={product.status} variant="outlined" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={3}>
                          <Box className="warehouse-empty-line">当前店铺未返回商品</Box>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </CardContent>
          </Card>
        </Stack>

        <Stack spacing={2} className="warehouse-right-stack">
          <Card className="warehouse-logistics-card">
            <CardContent>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                justifyContent="space-between"
                alignItems={{ xs: 'stretch', sm: 'center' }}
                spacing={1.25}
                mb={2}
                className="warehouse-method-header"
              >
                <Box>
                  <Typography variant="h6">配送方式</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {isShowingUnmatchedMethods ? '已读取，但未匹配到当前仓库' : selectedWarehouse?.name || '未选择仓库'}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1} alignItems="center" className="warehouse-method-header-actions">
                  <TextField
                    size="small"
                    placeholder="搜索配送方式"
                    value={methodKeyword}
                    onChange={(event) => setMethodKeyword(event.target.value)}
                    className="warehouse-method-search"
                    InputProps={{
                      startAdornment: (
                        <InputAdornment position="start">
                          <SearchRounded />
                        </InputAdornment>
                      ),
                    }}
                  />
                </Stack>
              </Stack>
              {isShowingUnmatchedMethods ? (
                <Alert severity="info" sx={{ mb: 1.5 }}>
                  Ozon
                  返回了配送方式，但没有返回可直接匹配当前仓库的仓库编号。这里先展示已读取到的配送方式，测算时请确认选中正确的仓库和方式。
                </Alert>
              ) : null}
              <TableContainer className="warehouse-method-table-wrap">
                <Table size="small" className="warehouse-method-table">
                  <TableHead>
                    <TableRow>
                      <TableCell>配送方式</TableCell>
                      <TableCell>状态</TableCell>
                      <TableCell align="right">操作</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredMethods.length ? (
                      filteredMethods.map((method) => (
                        <TableRow
                          hover
                          key={method.id}
                          selected={method.id === selectedMethodId}
                          onClick={() => setSelectedMethodId(method.id)}
                        >
                          <TableCell>
                            <Typography variant="subtitle2">{getOzonDeliveryMethodDisplayName(method)}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              方式编号：{method.rawId}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Chip
                              size="small"
                              color={getDeliveryMethodStatusColor(method.status)}
                              label={getDeliveryMethodStatusLabel(method.status)}
                              variant="outlined"
                            />
                          </TableCell>
                          <TableCell align="right">
                            <Button
                              size="small"
                              variant="outlined"
                              startIcon={<EditRounded />}
                              onClick={(event) => {
                                event.stopPropagation();
                                openDeliveryMethodManagement(method);
                              }}
                            >
                              修改
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={3}>
                          <Box className="warehouse-empty-line">
                            {deliveryMethods.length
                              ? '已读取配送方式，但当前仓库未匹配到方式'
                              : '当前仓库未返回配送方式'}
                          </Box>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </CardContent>
          </Card>

          <WarehouseFreightEstimatorCard
            activeShop={activeShop}
            warehouses={warehouses}
            methodRows={currentMethodRows}
            productRows={productRows}
            selectedWarehouse={selectedWarehouse}
            selectedMethod={selectedMethod}
            selectedProduct={selectedProduct}
            onWarehouseChange={setSelectedWarehouseId}
            onMethodChange={setSelectedMethodId}
            onProductChange={setSelectedProductId}
          />
        </Stack>
      </Box>

      <WarehouseOzonManagementDialog
        open={warehouseManagementOpen}
        shopId={activeShop?.id || ''}
        warehouse={selectedWarehouse}
        deliveryMethod={managedDeliveryMethod}
        onClose={closeWarehouseManagement}
        onCompleted={completeWarehouseManagement}
      />
      <WarehouseOzonCreateDialog
        open={warehouseCreateOpen}
        shop={activeShop}
        onClose={() => setWarehouseCreateOpen(false)}
        onCompleted={completeWarehouseManagement}
      />

      <Dialog
        open={defaultWarehouseDialogOpen}
        onClose={() => setDefaultWarehouseDialogOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>默认仓设置</DialogTitle>
        <DialogContent>
          <Stack spacing={1.2}>
            <Alert severity="success">
              已把 {selectedWarehouse?.name || '当前仓库'} 设为旺崽助手本系统默认仓。后续进入仓储物流会优先选中它。
            </Alert>
            <Box className="warehouse-write-summary">
              <Typography variant="caption" color="text.secondary">
                店铺
              </Typography>
              <Typography variant="subtitle2">{getOzonShopLabel(activeShop)}</Typography>
              <Typography variant="caption" color="text.secondary">
                默认仓库
              </Typography>
              <Typography variant="subtitle2">{selectedWarehouse?.name || '未选择'}</Typography>
              <Typography variant="caption" color="text.secondary">
                仓库编号
              </Typography>
              <Typography variant="subtitle2">{selectedWarehouse?.rawId || '未返回'}</Typography>
            </Box>
            <Alert severity="warning">
              这里没有修改 Ozon 后台默认仓。当前接口文档没有明确“设置 Ozon
              默认仓”的接口和字段，所以本页只保存本系统默认仓。
            </Alert>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDefaultWarehouseDialogOpen(false)}>关闭</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
