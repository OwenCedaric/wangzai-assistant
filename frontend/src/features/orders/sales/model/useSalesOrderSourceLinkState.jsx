import { firstUsableOzonId, getOzonShopForOrder } from '../../../../entities/order/orderShopScope.jsx';
import {
  buildProductSourceStorageRecord,
  buildSourceEntryForLink,
  getProductSourceLinkKey,
  getProductSourceRecordFromLinks,
  normalizeProductSourceRecord,
  normalizeSalesSourceLinkValue,
  normalizeSavedSalesSourceEntry,
} from '../../../../entities/order/orderSourceLinks.jsx';
import { saveProductSourceLinkRecord } from '../../../../services/productSourceLinkStore';
import { removeSalesSourcesForOrder } from '../../../../services/salesSourceLinkClient';
import { SOURCE_LINK_LIMIT } from '../../../../shared/config/appConfigCore.jsx';
import React from 'react';

export function useSalesOrderSourceLinkState({
  shop,
  shops,
  activeShop,
  sourceLinks,
  legacySalesSourceLinks,
  salesSourceSlotMap,
  setSalesSourceSlotMap,
  setSourceLinks,
  setSalesNotice,
  detailOrder,
} = {}) {
  const getSourceOrderProduct = React.useCallback((order = {}) => {
    const firstProduct = order.products?.[0] ?? {};
    return {
      ...firstProduct,
      offerId: firstUsableOzonId(
        firstProduct.offerId,
        firstProduct.offer_id,
        order.productNo,
        order.offerId,
        order.sku
      ),
      productNo: firstUsableOzonId(order.productNo, order.sku),
      sku: firstUsableOzonId(firstProduct.sku, firstProduct.skuId, order.sku),
      productId: firstUsableOzonId(firstProduct.productId, firstProduct.product_id, firstProduct.id),
      shopId: order.shopId,
      shopClientId: order.shopClientId,
      shop: order.shop,
    };
  }, []);
  const getSourceOrderShop = React.useCallback(
    (order = {}) =>
      getOzonShopForOrder(order, shops, activeShop) ?? {
        id: order.shopId || order.shopClientId || order.shop || 'default',
        clientId: order.shopClientId || '',
      },
    [activeShop, shops]
  );
  const getSourceLinkKey = React.useCallback(
    (order) =>
      getProductSourceLinkKey(getSourceOrderProduct(order), getSourceOrderShop(order), {
        productNo: order?.productNo,
        sku: order?.sku,
      }),
    [getSourceOrderProduct, getSourceOrderShop]
  );
  const getLegacySalesSourceLinkKey = React.useCallback((order) => {
    const orderKey = order?.posting || order?.id || '';
    if (!orderKey) return '';
    const owner = getOzonShopForOrder(order, shops, activeShop);
    return [owner?.id || order?.shopId || order?.shopClientId || 'unknown', orderKey].join(':');
  }, [activeShop, shops]);
  const getSupersededSalesSourceIdentity = React.useCallback((order = {}) => {
    const owner = getOzonShopForOrder(order, shops, activeShop);
    const shopId = String(owner?.id || '').trim();
    const orderKey = String(order.posting || order.postingNumber || order.id || '').trim();
    return shopId && orderKey ? { shopId, orderKey } : null;
  }, [activeShop, shops]);
  const getSourceLinkRecord = React.useCallback(
    (order) => {
      const productRecord = getProductSourceRecordFromLinks(
        sourceLinks,
        getSourceOrderProduct(order),
        getSourceOrderShop(order),
        { productNo: order?.productNo, sku: order?.sku }
      );
      if (productRecord.links.length) return productRecord;
      const legacyScopedKey = getLegacySalesSourceLinkKey(order);
      const legacyOrderKey = order?.posting || order?.id || '';
      return normalizeProductSourceRecord(
        legacySalesSourceLinks[legacyScopedKey] ?? legacySalesSourceLinks[legacyOrderKey]
      );
    },
    [getLegacySalesSourceLinkKey, getSourceOrderProduct, getSourceOrderShop, legacySalesSourceLinks, sourceLinks]
  );
  const getSourceSelectedSlot = React.useCallback(
    (order) => {
      const key = getSourceLinkKey(order);
      const record = getSourceLinkRecord(order);
      const storedIndex = Number(salesSourceSlotMap[key]);
      if (Number.isInteger(storedIndex)) return Math.max(0, Math.min(storedIndex, SOURCE_LINK_LIMIT - 1));
      return record.primaryIndex;
    },
    [getSourceLinkKey, getSourceLinkRecord, salesSourceSlotMap]
  );
  const getSourceLinkValue = React.useCallback(
    (order) => {
      const record = getSourceLinkRecord(order);
      const selectedSlot = getSourceSelectedSlot(order);
      return normalizeSavedSalesSourceEntry(record.links[selectedSlot] ?? record.links[record.primaryIndex]).link;
    },
    [getSourceLinkRecord, getSourceSelectedSlot]
  );
  const selectSourceSlot = React.useCallback(
    (order, index) => {
      const key = getSourceLinkKey(order);
      if (!key) return;
      setSalesSourceSlotMap((current) => ({
        ...current,
        [key]: Math.max(0, Math.min(Number(index) || 0, SOURCE_LINK_LIMIT - 1)),
      }));
    },
    [getSourceLinkKey, setSalesSourceSlotMap]
  );
  const updateSourceLink = React.useCallback(
    (order, value, slotIndex, sourceEntry) => {
      const key = getSourceLinkKey(order);
      if (!key) return;
      setSourceLinks((current) => {
        const currentRecord = getProductSourceRecordFromLinks(
          current,
          getSourceOrderProduct(order),
          getSourceOrderShop(order),
          { productNo: order?.productNo, sku: order?.sku }
        );
        const storedIndex = Number(salesSourceSlotMap[key]);
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
    [getSourceLinkKey, getSourceOrderProduct, getSourceOrderShop, salesSourceSlotMap, setSourceLinks]
  );
  const saveSourceLink = React.useCallback(
    async (order) => {
      const key = getSourceLinkKey(order);
      if (!key || typeof window === 'undefined') return;
      const parsed = normalizeSalesSourceLinkValue(getSourceLinkValue(order));
      if (!parsed.ok) {
        setSalesNotice({
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
      const currentRecord = getSourceLinkRecord(order);
      const selectedSlot = getSourceSelectedSlot(order);
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
      const nextLinks = { ...sourceLinks, [key]: nextRecord };
      setSourceLinks(nextLinks);
      setSalesSourceSlotMap((current) => ({ ...current, [key]: targetIndex }));
      try {
        await saveProductSourceLinkRecord({
          key,
          record: nextRecord,
          product: getSourceOrderProduct(order),
          timeoutMs: 3000,
        });
        const supersededIdentity = getSupersededSalesSourceIdentity(order);
        let obsoleteOrderRecordPendingCleanup = false;
        if (supersededIdentity) {
          try {
            await removeSalesSourcesForOrder(supersededIdentity, { timeoutMs: 3000 });
          } catch {
            obsoleteOrderRecordPendingCleanup = true;
          }
        }
        setSalesNotice({
          open: true,
          severity: obsoleteOrderRecordPendingCleanup ? 'warning' : 'success',
          message: obsoleteOrderRecordPendingCleanup
            ? `${parsed.platform}短链接已保存，商品ID ${parsed.productId}；历史订单副本将在下次可用时清理。`
            : `${parsed.platform}短链接已保存，商品ID ${parsed.productId}`,
        });
      } catch (error) {
        setSalesNotice({
          open: true,
          severity: 'warning',
          message: `${parsed.platform}短链接已暂存本机，SQLite 写入失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
    [
      getSourceLinkKey,
      getSourceOrderProduct,
      getSourceLinkRecord,
      getSourceLinkValue,
      getSourceSelectedSlot,
      getSupersededSalesSourceIdentity,
      sourceLinks,
      setSalesNotice,
      setSalesSourceSlotMap,
      setSourceLinks,
    ]
  );
  const detailSourceLink = detailOrder ? getSourceLinkValue(detailOrder) : '';
  const detailSourceRecord = detailOrder ? getSourceLinkRecord(detailOrder) : { link: '', productId: '', platform: '' };
  const detailSourceEntry = normalizeSavedSalesSourceEntry(
    detailSourceRecord.links?.[detailSourceRecord.primaryIndex] ?? detailSourceRecord
  );
  const detailCrossBorderInfo = detailOrder?.crossBorderInfo ?? {
    orderId: '未返回',
    packageWeight: '未返回',
    packageSize: '未返回',
    readStatus: '未返回',
  };

  return {
    getSourceLinkRecord,
    getSourceSelectedSlot,
    getSourceLinkValue,
    selectSourceSlot,
    updateSourceLink,
    saveSourceLink,
    detailSourceLink,
    detailSourceEntry,
    detailCrossBorderInfo,
  };
}
