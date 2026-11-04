import { readSavedCrossBorderOrderSettings } from '../../../entities/order/crossBorderOrderApi.jsx';
import {
  buildProductSourceStorageRecord,
  buildSourceEntryForLink,
  getProductSourceLinkKey,
  getProductSourceRecordFromLinks,
  normalizeSalesSourceLinkValue,
  normalizeSavedSalesSourceEntry,
} from '../../../entities/order/orderSourceLinks.jsx';
import { getProductSelectionKey } from '../../../entities/product/productWriteHelpers.jsx';
import { resolveCanonicalProductOwnerShop } from '../../../entities/product/productShopScope.jsx';
import { canUseOzonShop } from '../../../entities/order/orderShopScope.jsx';
import { readAndSaveProductBusMeasurement } from '../../../services/productBusMaterialService';
import {
  applyProductMaterialProfile,
} from '../../../services/productMaterialProfileStore';
import { saveProductSourceLinkRecord } from '../../../services/productSourceLinkStore';
import { SOURCE_LINK_LIMIT } from '../../../shared/config/appConfigCore.jsx';
import React from 'react';

export function useProductSourceMaterialState({
  setSelectedProductKeys,
  pageProductKeys,
  allPageSelected,
  activeShop,
  shops = [],
  setProducts,
  setEditingProduct,
  setSavingProductId,
  setProductNotice,
  productSourceLinks,
  productSourceSlotMap,
  setProductSourceSlotMap,
  setProductSourceLinks,
  shop,
  status,
} = {}) {
  const resolveProductOwnerShop = React.useCallback(
    (product) => resolveCanonicalProductOwnerShop(product, shops),
    [shops]
  );
  const toggleProductSelection = React.useCallback((product) => {
    const key = getProductSelectionKey(product);
    if (!key) return;
    setSelectedProductKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [setSelectedProductKeys]);
  const togglePageSelection = React.useCallback(() => {
    if (pageProductKeys.length === 0) return;
    setSelectedProductKeys((current) => {
      const next = new Set(current);
      if (allPageSelected) {
        pageProductKeys.forEach((key) => next.delete(key));
      } else {
        pageProductKeys.forEach((key) => next.add(key));
      }
      return next;
    });
  }, [allPageSelected, pageProductKeys, setSelectedProductKeys]);
  const resolveWritableOzonProduct = React.useCallback(
    async (product) => {
      const ownerShop = resolveProductOwnerShop(product);
      if (!canUseOzonShop(ownerShop)) {
        throw new Error('店铺未配置 Ozon 权限，不能提交商品操作。');
      }
      if (!product?.productId) {
        throw new Error('SQLite 中缺少 Ozon 商品 ID，请先手动刷新商品后再操作。');
      }
      return product;
    },
    [resolveProductOwnerShop]
  );
  const handleEditProduct = async (product) => {
    if (!product) return;
    // The edit dialog consumes the same SQLite DTO as the list. Missing facets
    // stay visibly unavailable; opening a dialog never performs an Ozon read.
    setEditingProduct(product);
  };
  const getProductSourceRecord = React.useCallback(
    (product) => {
      let ownerShop = activeShop;
      try {
        ownerShop = resolveProductOwnerShop(product);
      } catch {
        // Read-only rendering may expose a quarantined legacy row. The DTO's
        // embedded source record remains visible, but writes below fail closed.
      }
      return getProductSourceRecordFromLinks(productSourceLinks, product, ownerShop);
    },
    [activeShop, productSourceLinks, resolveProductOwnerShop]
  );
  const getProductSourceSelectedSlot = React.useCallback(
    (product) => {
      const ownerShop = resolveProductOwnerShop(product);
      const key = getProductSourceLinkKey(product, ownerShop);
      const record = getProductSourceRecord(product);
      const storedIndex = Number(productSourceSlotMap[key]);
      if (Number.isInteger(storedIndex)) return Math.max(0, Math.min(storedIndex, SOURCE_LINK_LIMIT - 1));
      return record.primaryIndex;
    },
    [getProductSourceRecord, productSourceSlotMap, resolveProductOwnerShop]
  );
  const getProductSourceLinkValue = React.useCallback(
    (product) => {
      const record = getProductSourceRecord(product);
      const selectedSlot = getProductSourceSelectedSlot(product);
      return normalizeSavedSalesSourceEntry(record.links[selectedSlot] ?? record.links[record.primaryIndex]).link;
    },
    [getProductSourceRecord, getProductSourceSelectedSlot]
  );
  const selectProductSourceSlot = React.useCallback(
    (product, index) => {
      const ownerShop = resolveProductOwnerShop(product);
      const key = getProductSourceLinkKey(product, ownerShop);
      if (!key) return;
      setProductSourceSlotMap((current) => ({
        ...current,
        [key]: Math.max(0, Math.min(Number(index) || 0, SOURCE_LINK_LIMIT - 1)),
      }));
    },
    [resolveProductOwnerShop, setProductSourceSlotMap]
  );
  const updateProductSourceLink = React.useCallback(
    (product, value, slotIndex, sourceEntry) => {
      const ownerShop = resolveProductOwnerShop(product);
      const key = getProductSourceLinkKey(product, ownerShop);
      if (!key) return;
      setProductSourceLinks((current) => {
        const currentRecord = getProductSourceRecordFromLinks(current, product, ownerShop);
        const storedIndex = Number(productSourceSlotMap[key]);
        const safeSlotIndex = Number(slotIndex);
        const targetIndex = Number.isInteger(safeSlotIndex)
          ? Math.max(0, Math.min(safeSlotIndex, SOURCE_LINK_LIMIT - 1))
          : Number.isInteger(storedIndex)
            ? storedIndex
            : currentRecord.primaryIndex;
        const nextLinks = [...currentRecord.links];
        nextLinks[targetIndex] = buildSourceEntryForLink(value, nextLinks[targetIndex], sourceEntry);
        return {
          ...current,
          [key]: {
            ...currentRecord,
            links: nextLinks,
            updatedAt: currentRecord.updatedAt,
          },
        };
      });
    },
    [productSourceSlotMap, resolveProductOwnerShop, setProductSourceLinks]
  );
  const saveProductSourceLink = React.useCallback(
    async (product) => {
      const ownerShop = resolveProductOwnerShop(product);
      const key = getProductSourceLinkKey(product, ownerShop);
      if (!key) return;
      const parsed = normalizeSalesSourceLinkValue(getProductSourceLinkValue(product));
      if (!parsed.ok) {
        setProductNotice({
          open: true,
          severity: 'warning',
          message: parsed.error || '未识别到商品ID，请检查链接。',
        });
        return;
      }
      const nextEntry = {
        link: parsed.link,
        productId: parsed.productId,
        platform: parsed.platform,
        savedAt: new Date().toISOString(),
      };
      const currentRecord = getProductSourceRecord(product);
      const selectedSlot = getProductSourceSelectedSlot(product);
      const nextRecordLinks = [...currentRecord.links];
      const duplicateIndex = nextRecordLinks.findIndex((item) => item.link === nextEntry.link);
      const targetIndex = duplicateIndex >= 0 ? duplicateIndex : selectedSlot;
      const currentEntry = nextRecordLinks[targetIndex] ?? {};
      nextRecordLinks[targetIndex] = {
        ...currentEntry,
        ...nextEntry,
        title: currentEntry.title || '',
        imageUrl: currentEntry.imageUrl || '',
        price: currentEntry.price || '',
        priceValue: currentEntry.priceValue,
        qty: currentEntry.qty || '',
      };
      const nextRecord = buildProductSourceStorageRecord({
        ...currentRecord,
        links: nextRecordLinks,
        primaryIndex: currentRecord.links.length ? currentRecord.primaryIndex : targetIndex,
      });
      const nextLinks = { ...productSourceLinks, [key]: nextRecord };
      setProductSourceLinks(nextLinks);
      setProductSourceSlotMap((current) => ({ ...current, [key]: targetIndex }));
      try {
        await saveProductSourceLinkRecord({ key, record: nextRecord, product, timeoutMs: 3000 });
        setProductNotice({
          open: true,
          severity: 'success',
          message: `${parsed.platform}货源链接已保存。`,
        });
      } catch (error) {
        setProductNotice({
          open: true,
          severity: 'warning',
          message: `${parsed.platform}货源未保存：SQLite 写入失败，当前表单不会标记完成。${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
    [
      getProductSourceLinkValue,
      getProductSourceRecord,
      getProductSourceSelectedSlot,
      productSourceLinks,
      resolveProductOwnerShop,
      setProductNotice,
      setProductSourceLinks,
      setProductSourceSlotMap,
    ]
  );
  const refreshProductMaterialViews = React.useCallback(() => {
    setProducts((currentRows) =>
      currentRows.map((product) => {
        try {
          return applyProductMaterialProfile(product, resolveProductOwnerShop(product));
        } catch {
          return product;
        }
      })
    );
    setEditingProduct((currentProduct) =>
      currentProduct
        ? applyProductMaterialProfile(currentProduct, resolveProductOwnerShop(currentProduct))
        : currentProduct
    );
  }, [resolveProductOwnerShop, setEditingProduct, setProducts]);
  const handleReadProductBusMeasurement = React.useCallback(
    async (product) => {
      if (!product) return;
      const ownerShop = resolveProductOwnerShop(product);
      if (!canUseOzonShop(ownerShop)) return;
      const productLabel = product.offerId || product.sku || '当前商品';
      setSavingProductId(`bus-${getProductSelectionKey(product) || productLabel}`);
      try {
        const settings = readSavedCrossBorderOrderSettings();
        const readResult = await readAndSaveProductBusMeasurement({
          shop: ownerShop,
          settings,
          product,
        });
        const result = readResult;
        refreshProductMaterialViews();

        if (result.status === 'no-data') {
          setProductNotice({
            open: true,
            severity: 'warning',
            message: `${productLabel} ${result.reason || '未读取到巴士实测数据。'}`,
          });
          return;
        }

        if (result.status === 'saved-local') {
          setProductNotice({
            open: true,
            severity: 'success',
            message: `${productLabel} 已将巴士实测保存到 SQLite。本次读取不会自动写入 Ozon；如需回传，请在商品编辑页预览并人工确认。`,
          });
          return;
        }

        setProductNotice({
          open: true,
          severity: 'warning',
          message: `${productLabel} 巴士实测读取结果未保存，请按提示核对。`,
        });
      } catch (error) {
        setProductNotice({
          open: true,
          severity: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setSavingProductId('');
      }
    },
    [
      refreshProductMaterialViews,
      resolveProductOwnerShop,
      setProductNotice,
      setSavingProductId,
    ]
  );

  return {
    toggleProductSelection,
    togglePageSelection,
    resolveWritableOzonProduct,
    handleEditProduct,
    getProductSourceRecord,
    getProductSourceSelectedSlot,
    getProductSourceLinkValue,
    selectProductSourceSlot,
    updateProductSourceLink,
    saveProductSourceLink,
    refreshProductMaterialViews,
    handleReadProductBusMeasurement,
  };
}
