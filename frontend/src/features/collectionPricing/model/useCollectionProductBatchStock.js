import React from 'react';

import { setCollectionSkuShopInventories } from '../lib/collectionProductShopInventory.js';
import { loadCollectionListingWarehouses } from '../services/collectionListingCatalogService.js';

function warehouseIdOf(warehouse = {}) {
  return String(warehouse.rawId || warehouse.id || '').trim();
}

function normalizeShopIds(shopIds, fallbackShopId = '') {
  const source = Array.isArray(shopIds) ? shopIds : [fallbackShopId];
  return [...new Set(source.map((item) => String(item || '').trim()).filter(Boolean))];
}

export function useCollectionProductBatchStock({
  shopId = '',
  shopIds,
  skus = [],
  onChangeSku,
} = {}) {
  const normalizedPrimaryShopId = String(shopId || '').trim();
  const selectionKey = normalizeShopIds(shopIds, normalizedPrimaryShopId).join('\u001f');
  const selectedShopIds = React.useMemo(
    () => normalizeShopIds(selectionKey ? selectionKey.split('\u001f') : [], normalizedPrimaryShopId),
    [normalizedPrimaryShopId, selectionKey],
  );
  const [warehousesByShopId, setWarehousesByShopId] = React.useState({});
  const [warehouseStatesByShopId, setWarehouseStatesByShopId] = React.useState({});
  const selectedShopIdsRef = React.useRef(new Set(selectedShopIds));
  const skusRef = React.useRef(skus);
  const onChangeSkuRef = React.useRef(onChangeSku);
  const warehousesByShopIdRef = React.useRef(warehousesByShopId);
  const warehouseStatesByShopIdRef = React.useRef(warehouseStatesByShopId);
  const requestSequenceRef = React.useRef(0);
  const requestIdsByShopIdRef = React.useRef({});
  const abortControllersRef = React.useRef(new Map());
  selectedShopIdsRef.current = new Set(selectedShopIds);
  skusRef.current = skus;
  onChangeSkuRef.current = onChangeSku;
  warehousesByShopIdRef.current = warehousesByShopId;
  warehouseStatesByShopIdRef.current = warehouseStatesByShopId;

  const loadWarehouses = React.useCallback(async (targetShopId, { refresh = false } = {}) => {
    const normalizedShopId = String(targetShopId || '').trim();
    if (!normalizedShopId) return [];
    const requestId = ++requestSequenceRef.current;
    requestIdsByShopIdRef.current[normalizedShopId] = requestId;
    abortControllersRef.current.get(normalizedShopId)?.abort();
    const abortController = new AbortController();
    abortControllersRef.current.set(normalizedShopId, abortController);
    setWarehouseStatesByShopId((current) => ({
      ...current,
      [normalizedShopId]: { status: 'loading', error: '', shopId: normalizedShopId },
    }));
    try {
      const rows = await loadCollectionListingWarehouses(normalizedShopId, {
        refresh,
        signal: abortController.signal,
      });
      if (
        abortController.signal.aborted
        || requestIdsByShopIdRef.current[normalizedShopId] !== requestId
        || !selectedShopIdsRef.current.has(normalizedShopId)
      ) return [];
      setWarehousesByShopId((current) => ({ ...current, [normalizedShopId]: rows }));
      setWarehouseStatesByShopId((current) => ({
        ...current,
        [normalizedShopId]: { status: 'ready', error: '', shopId: normalizedShopId },
      }));
      return rows;
    } catch (error) {
      if (
        abortController.signal.aborted
        || requestIdsByShopIdRef.current[normalizedShopId] !== requestId
        || !selectedShopIdsRef.current.has(normalizedShopId)
      ) return [];
      setWarehousesByShopId((current) => ({ ...current, [normalizedShopId]: [] }));
      setWarehouseStatesByShopId((current) => ({
        ...current,
        [normalizedShopId]: {
          status: 'error',
          error: error instanceof Error ? error.message : 'Ozon 仓库读取失败。',
          shopId: normalizedShopId,
        },
      }));
      return [];
    } finally {
      if (requestIdsByShopIdRef.current[normalizedShopId] === requestId) {
        abortControllersRef.current.delete(normalizedShopId);
      }
    }
  }, []);

  React.useEffect(() => {
    const selected = new Set(selectedShopIds);
    abortControllersRef.current.forEach((controller, targetShopId) => {
      if (!selected.has(targetShopId)) controller.abort();
    });
    setWarehousesByShopId((current) => Object.fromEntries(
      Object.entries(current).filter(([targetShopId]) => selected.has(targetShopId)),
    ));
    setWarehouseStatesByShopId((current) => Object.fromEntries(
      Object.entries(current).filter(([targetShopId]) => selected.has(targetShopId)),
    ));
    selectedShopIds.forEach((targetShopId) => {
      const status = warehouseStatesByShopIdRef.current[targetShopId]?.status;
      if (!status || status === 'idle') void loadWarehouses(targetShopId);
    });
  }, [loadWarehouses, selectionKey, selectedShopIds]);

  React.useEffect(() => () => {
    requestSequenceRef.current += 1;
    abortControllersRef.current.forEach((controller) => controller.abort());
    abortControllersRef.current.clear();
  }, []);

  const reloadWarehouses = React.useCallback((targetShopId = normalizedPrimaryShopId) => (
    loadWarehouses(String(targetShopId || '').trim(), { refresh: true })
  ), [loadWarehouses, normalizedPrimaryShopId]);

  const applyBatchStock = React.useCallback(({ shopInventories, warehouseId, stock } = {}) => {
    const currentSelectedShopIds = [...selectedShopIdsRef.current];
    if (!currentSelectedShopIds.length) return { ok: false, error: '请先选择要上架的 Ozon 店铺。' };
    const rows = Array.isArray(shopInventories)
      ? shopInventories
      : currentSelectedShopIds.length === 1
        ? [{ shopId: currentSelectedShopIds[0], warehouseId, stock }]
        : [];
    const inventoryByShopId = Object.fromEntries(rows.map((item) => [
      String(item?.shopId || '').trim(),
      {
        warehouseId: String(item?.warehouseId || '').trim(),
        stock: item?.stock,
      },
    ]).filter(([targetShopId]) => Boolean(targetShopId)));

    for (const targetShopId of currentSelectedShopIds) {
      const inventory = inventoryByShopId[targetShopId];
      const normalizedStockText = String(inventory?.stock ?? '').trim();
      const normalizedStock = Number(normalizedStockText);
      if (!inventory) return { ok: false, error: `请设置店铺 ${targetShopId} 的仓库和库存。` };
      if (
        warehouseStatesByShopIdRef.current[targetShopId]?.status !== 'ready'
        || !(warehousesByShopIdRef.current[targetShopId] || []).some((item) => warehouseIdOf(item) === inventory.warehouseId)
      ) return { ok: false, error: `请选择店铺 ${targetShopId} 刚刚读取到的 Ozon 仓库。` };
      if (!normalizedStockText || !Number.isSafeInteger(normalizedStock) || normalizedStock < 0) {
        return { ok: false, error: `店铺 ${targetShopId} 的库存必须是大于或等于 0 的整数。` };
      }
      inventoryByShopId[targetShopId] = {
        warehouseId: inventory.warehouseId,
        stock: String(normalizedStock),
      };
    }

    const enabledRows = (Array.isArray(skusRef.current) ? skusRef.current : [])
      .map((sku, index) => ({ sku, index }))
      .filter(({ sku }) => sku?.enabled !== false);
    if (!enabledRows.length) return { ok: false, error: '当前没有已启用的 SKU。' };
    enabledRows.forEach(({ sku, index }) => {
      const nextInventoryByShopId = setCollectionSkuShopInventories(sku, inventoryByShopId);
      onChangeSkuRef.current?.(index, {
        inventoryByShopId: nextInventoryByShopId,
      });
    });
    return {
      ok: true,
      appliedCount: enabledRows.length,
      appliedShopCount: currentSelectedShopIds.length,
    };
  }, []);

  return {
    selectedShopIds,
    warehousesByShopId,
    warehouseStatesByShopId,
    reloadWarehouses,
    applyBatchStock,
  };
}
