import {
  PRODUCT_MATERIAL_SOURCE_CROSS_BORDER,
  PRODUCT_MATERIAL_SOURCE_MISSING,
  PRODUCT_MATERIAL_SOURCE_OZON_INITIAL,
  PRODUCT_MATERIAL_SOURCE_SUPPLIER,
} from '../../../services/productMaterialProfileStore';
import { productStatusTabs, readSavedOzonDefaultWarehouseIds } from '../../../shared/ozon/ozonRuntime.jsx';
import {
  createProductAdvancedFilterDefaults,
  isProductAdvancedFilterDefault,
  normalizeProductAdvancedFilterValues,
} from '../../../entities/product/productAdvancedFilters.jsx';
import Box from '@mui/material/Box';
import React from 'react';

export function useProductFiltersState({
  activeShop,
  advancedFilterAnchorEl,
  advancedFilters,
  status,
  setAdvancedFilters,
  setProductSort,
  setPage,
  productSort,
  shop,
  keyword,
} = {}) {
  const savedDefaultWarehouseIds = readSavedOzonDefaultWarehouseIds();
  const productDefaultWarehouseId = String(savedDefaultWarehouseIds[activeShop?.id] ?? '').trim();
  const advancedFilterOpen = Boolean(advancedFilterAnchorEl);
  const selectedMaterialSourceFilters = React.useMemo(
    () => normalizeProductAdvancedFilterValues(advancedFilters.materialSource),
    [advancedFilters.materialSource]
  );
  const selectedWarehouseFilters = React.useMemo(
    () => normalizeProductAdvancedFilterValues(advancedFilters.warehouse),
    [advancedFilters.warehouse]
  );
  const selectedStockFilters = React.useMemo(
    () => normalizeProductAdvancedFilterValues(advancedFilters.stock),
    [advancedFilters.stock]
  );
  const selectedProductStatusFilters = React.useMemo(
    () => normalizeProductAdvancedFilterValues(advancedFilters.productStatus),
    [advancedFilters.productStatus]
  );
  const selectedSourceStatusFilters = React.useMemo(
    () => normalizeProductAdvancedFilterValues(advancedFilters.sourceStatus),
    [advancedFilters.sourceStatus]
  );
  const hasAdvancedFilters = !isProductAdvancedFilterDefault(advancedFilters);
  const selectedProductStatusTab = productStatusTabs.find((tab) => tab.label === status) ?? productStatusTabs[0];
  const advancedFilterGroups = [
    {
      id: 'materialSource',
      label: '材积来源',
      options: [
        { value: 'all', label: '全部' },
        { value: PRODUCT_MATERIAL_SOURCE_CROSS_BORDER, label: '跨境巴士读取' },
        { value: PRODUCT_MATERIAL_SOURCE_SUPPLIER, label: '上游/人工确认' },
        { value: PRODUCT_MATERIAL_SOURCE_OZON_INITIAL, label: 'Ozon首次读取' },
        { value: PRODUCT_MATERIAL_SOURCE_MISSING, label: '未确认' },
      ],
    },
    {
      id: 'warehouse',
      label: '绑定仓库',
      options: [
        { value: 'all', label: '全部' },
        { value: 'returned', label: '商品返回仓' },
        { value: 'default', label: '本系统默认仓' },
        { value: 'missing', label: '未返回仓库ID' },
        { value: 'multi', label: '多仓库存' },
      ],
    },
    {
      id: 'stock',
      label: '库存状态',
      options: [
        { value: 'all', label: '全部' },
        { value: 'zero', label: '库存为0' },
        { value: 'positive', label: '库存大于0' },
        { value: 'missing', label: '库存未返回' },
        { value: 'multi', label: '多仓库存' },
      ],
    },
    {
      id: 'productStatus',
      label: '商品状态',
      options: [
        { value: 'all', label: '全部' },
        ...productStatusTabs
          .filter((tab) => tab.label !== '全部商品')
          .map((tab) => ({
            value: tab.label,
            label: tab.label,
          })),
      ],
    },
    {
      id: 'sourceStatus',
      label: '货源状态',
      options: [
        { value: 'all', label: '全部' },
        { value: 'saved', label: '已保存货源' },
        { value: 'missing', label: '未保存货源' },
        { value: 'pdd', label: '拼多多' },
        { value: '1688', label: '1688' },
        { value: 'taobao', label: '淘宝/天猫' },
      ],
    },
  ];
  const toggleAdvancedFilterValue = (key, value) => {
    setAdvancedFilters((current) => {
      if (value === 'all') return { ...current, [key]: [] };
      const currentValues = normalizeProductAdvancedFilterValues(current[key]);
      const nextValues = currentValues.includes(value)
        ? currentValues.filter((item) => item !== value)
        : [...currentValues, value];
      return { ...current, [key]: nextValues };
    });
  };
  const removeAdvancedFilterValue = (key, value) => {
    setAdvancedFilters((current) => ({
      ...current,
      [key]: normalizeProductAdvancedFilterValues(current[key]).filter((item) => item !== value),
    }));
  };
  const resetAdvancedFilters = () => {
    setAdvancedFilters(createProductAdvancedFilterDefaults());
  };
  const getAdvancedFilterLabel = (key, value) => {
    const group = advancedFilterGroups.find((item) => item.id === key);
    const option = group?.options.find((item) => item.value === value);
    return option?.label || value;
  };
  const advancedFilterChips = Object.entries(advancedFilters).flatMap(([key, value]) =>
    normalizeProductAdvancedFilterValues(value).map((item) => ({
      key: `${key}:${item}`,
      filterKey: key,
      value: item,
      label: `${advancedFilterGroups.find((group) => group.id === key)?.label || key}：${getAdvancedFilterLabel(key, item)}`,
    }))
  );
  const handleProductSort = React.useCallback(
    (key) => {
      setProductSort((current) =>
        current.key === key
          ? { key, direction: current.direction === 'desc' ? 'asc' : 'desc' }
          : { key, direction: 'desc' }
      );
      setPage((currentPage) => (currentPage === 1 ? currentPage : 1));
    },
    [setPage, setProductSort]
  );
  const renderHeaderLabel = (label) => (
    <Box component="span" className="product-table-header-label">
      {label}
    </Box>
  );
  const renderSortableHeader = React.useCallback(
    (key, label) => {
      const active = productSort.key === key;
      const direction = active ? productSort.direction : '';
      return (
        <Box
          component="button"
          type="button"
          onClick={() => handleProductSort(key)}
          className={`product-sort-header${active ? ' active' : ''}`}
        >
          <span>{label}</span>
          <Box component="span" className="product-sort-icons">
            <Box component="span" sx={{ color: active && direction === 'desc' ? 'primary.main' : 'inherit' }}>
              ↓
            </Box>
            <Box component="span" sx={{ color: active && direction === 'asc' ? 'primary.main' : 'inherit' }}>
              ↑
            </Box>
          </Box>
        </Box>
      );
    },
    [handleProductSort, productSort.direction, productSort.key]
  );
  React.useEffect(() => {
    setPage(1);
  }, [
    shop,
    status,
    keyword,
    selectedMaterialSourceFilters,
    selectedWarehouseFilters,
    selectedStockFilters,
    selectedProductStatusFilters,
    selectedSourceStatusFilters,
    setPage,
  ]);

  return {
    savedDefaultWarehouseIds,
    productDefaultWarehouseId,
    advancedFilterOpen,
    selectedMaterialSourceFilters,
    selectedWarehouseFilters,
    selectedStockFilters,
    selectedProductStatusFilters,
    selectedSourceStatusFilters,
    hasAdvancedFilters,
    selectedProductStatusTab,
    advancedFilterGroups,
    toggleAdvancedFilterValue,
    removeAdvancedFilterValue,
    resetAdvancedFilters,
    advancedFilterChips,
    renderHeaderLabel,
    renderSortableHeader,
  };
}
