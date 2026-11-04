import { firstFilled, normalizeOzonId } from '../../../../entities/order/orderShopScope.jsx';
import {
  buildProductSourceStorageRecord,
  detectSourcePlatformFromLink,
  getProductSourceCandidateKeys,
  getProductSourceLinkKey,
  getProductSourceRecordFromLinks,
  normalizeProductSourceRecord,
  normalizeSalesSourceLinkValue,
  normalizeSourcePlatformName,
} from '../../../../entities/order/orderSourceLinks.jsx';
import { readPurchasePluginCaptures } from '../../../../entities/product/productLocalMirror.jsx';
import { firstFiniteNumber } from '../../../../entities/product/productAttributes.jsx';
import { compactObject, safeImageUrl } from '../../../../entities/product/productWriteHelpers.jsx';
import { saveProductSourceLinkRecord } from '../../../../services/productSourceLinkStore';
import { savePurchaseSourceLinkRecord } from '../../../../services/purchaseSourceLinkStore';
import {
  PURCHASE_PLUGIN_CAPTURE_POLL_ACTIVE_MS,
  PURCHASE_PLUGIN_CAPTURE_POLL_IDLE_MS,
  SOURCE_LINK_LIMIT,
} from '../../../../shared/config/appConfigCore.jsx';
import {
  getPurchaseCrossBorderProducts,
  getPurchaseOrderShop,
} from '../../../../services/purchaseCrossBorderRuntime.js';
import { getPurchaseOrderRecordKey } from '../lib/purchaseMarketingApi.jsx';
import {
  buildPurchaseCrossBorderPersistFields,
  getCanonicalPurchaseOrderOverrideKey,
  isConfirmedPurchasePlatformStatus,
  readPurchaseOrderLocalOverrides,
  isFilledPurchasePlatformValue,
  removePurchaseSourceRecordsFromLocalOverride,
  writePurchaseOrderLocalOverrideUpsert,
} from '../lib/purchaseOrderNormalize.jsx';
import React from 'react';

function getPurchasePluginCaptureOrderKeys(order = {}) {
  return [getPurchaseOrderRecordKey(order), order.id, order.salesOrder, order.shipmentNo]
    .map((value) => String(value || '').trim())
    .filter((value, index, values) => value && values.indexOf(value) === index);
}

export function findPurchasePluginCaptureOrder(purchaseOrders = [], context = {}) {
  const orderKey = String(context.orderKey || context.orderId || '').trim();
  if (!orderKey) return null;
  const contextOrderId = String(context.orderId || '').trim();
  const contextShopId = String(context.shopId ?? context.shop_id ?? '').trim();
  const contextShopClientId = String(
    context.shopClientId ?? context.shop_client_id ?? context.clientId ?? ''
  ).trim();
  const keyCandidates = (Array.isArray(purchaseOrders) ? purchaseOrders : []).filter((order) => {
    const orderKeys = getPurchasePluginCaptureOrderKeys(order);
    if (!orderKeys.includes(orderKey)) return false;
    return !contextOrderId || orderKeys.includes(contextOrderId);
  });
  if (!contextShopId && keyCandidates.length > 1) return null;
  const scopedCandidates = keyCandidates.filter((order) => {
    if (contextShopId && String(order.shopId ?? order.shop_id ?? '').trim() !== contextShopId) return false;
    if (
      contextShopClientId &&
      String(order.shopClientId ?? order.shop_client_id ?? order.clientId ?? '').trim() !== contextShopClientId
    ) {
      return false;
    }
    return true;
  });
  return scopedCandidates.length === 1 ? scopedCandidates[0] : null;
}

export function usePurchasePluginCaptureState({
  setPurchaseLocalOverrides,
  setSelectedOrderId,
  showPurchaseNotice,
  purchaseOrders,
  shops,
  activeShop,
  shop,
  productSourceLinks,
  setProductSourceLinks,
  isActive,
  purchasePluginLastCaptureAtRef,
  handledPurchasePluginCaptureIdsRef,
  setManualPurchaseDraft,
  setManualPurchaseAnchorEl,
  hasSelectedOrder,
  selectedOrder,
  manualPurchaseDraft,
  setSelectedPurchaseSearchImage,
} = {}) {
  const writeCanonicalPurchaseOverride = React.useCallback(
    (current, order, update, resolvedShop = null) => {
      const orderShop = resolvedShop ?? getPurchaseOrderShop(shops, order, activeShop);
      return writePurchaseOrderLocalOverrideUpsert(current, order, orderShop, update);
    },
    [activeShop, shops]
  );
  // Applies the write outside the React updater and reports the real persistence
  // result. Callers that show their own message pass no successMessage.
  const persistCanonicalPurchaseOverride = React.useCallback(
    async (order, update, { successMessage, failureLabel, resolvedShop = null } = {}) => {
      const plan = writeCanonicalPurchaseOverride(
        readPurchaseOrderLocalOverrides(), order, update, resolvedShop
      );
      if (!plan?.overrides) {
        showPurchaseNotice(`${failureLabel || ''}保存失败，请重试。`, 'warning');
        return false;
      }
      setPurchaseLocalOverrides(plan.overrides);
      const result = await Promise.resolve(plan.persistence).catch(() => null);
      if (!result || (Array.isArray(result.failedKeys) && result.failedKeys.length > 0)) {
        showPurchaseNotice(`${failureLabel || ''}本地保存失败，重新打开页面后会丢失，请重试。`, 'warning');
        return false;
      }
      if (successMessage) showPurchaseNotice(successMessage, 'success');
      return true;
    },
    [showPurchaseNotice, setPurchaseLocalOverrides, writeCanonicalPurchaseOverride]
  );
  const getCanonicalPurchaseOverrideTarget = React.useCallback(
    (order, resolvedShop = null) => {
      const orderShop = resolvedShop ?? getPurchaseOrderShop(shops, order, activeShop);
      return getCanonicalPurchaseOrderOverrideKey(order, orderShop);
    },
    [activeShop, shops]
  );
  const persistPurchaseCrossBorderDetail = React.useCallback(
    (order, detail = {}, fallback = {}) => {
      const key = getPurchaseOrderRecordKey(order);
      if (!key) return;
      if (!getCanonicalPurchaseOverrideTarget(order)) {
        showPurchaseNotice('当前订单缺少可核验的店铺身份，本次巴士信息未写入本地缓存。', 'warning');
        return;
      }
      const persistFields = buildPurchaseCrossBorderPersistFields(detail, fallback);
      if (
        !persistFields.crossBorderOrderFound &&
        !persistFields.packageOrderId &&
        !persistFields.crossBorderOrderNumber
      )
        return;

      setPurchaseLocalOverrides((current) => {
        return writeCanonicalPurchaseOverride(current, order, (existing) => {
          const nextOverride = compactObject({ ...existing, ...persistFields });
          if (persistFields.crossBorderOrderFound && !nextOverride.manualClassifiedAt) {
            delete nextOverride.forcePurchaseStatus;
            delete nextOverride.ozonAwaitingDeliveryPendingAt;
            delete nextOverride.ozonAwaitingDeliveryRawStatus;
            delete nextOverride.ozonAwaitingDeliveryReason;
          }
          return nextOverride;
        });
      });
    },
    [getCanonicalPurchaseOverrideTarget, setPurchaseLocalOverrides, showPurchaseNotice, writeCanonicalPurchaseOverride]
  );
  const persistPurchaseForecastFlow = React.useCallback(
    (order, flow = {}) => {
      const key = getPurchaseOrderRecordKey(order);
      if (!key || !flow || typeof flow !== 'object' || Array.isArray(flow)) return;
      if (!getCanonicalPurchaseOverrideTarget(order)) {
        showPurchaseNotice('当前订单缺少可核验的店铺身份，预报进度未保存。', 'warning');
        return;
      }
      setPurchaseLocalOverrides((current) => {
        return writeCanonicalPurchaseOverride(current, order, (existing) =>
          compactObject({
            ...existing,
            purchaseForecastFlow: {
              ...(existing.purchaseForecastFlow && typeof existing.purchaseForecastFlow === 'object'
                ? existing.purchaseForecastFlow
                : {}),
              ...flow,
            },
          })
        );
      });
    },
    [getCanonicalPurchaseOverrideTarget, setPurchaseLocalOverrides, showPurchaseNotice, writeCanonicalPurchaseOverride]
  );
  const markPurchaseOrderAwaitingDeliveryPending = React.useCallback(
    (order, error = null) => {
      const key = getPurchaseOrderRecordKey(order);
      if (!key) return;
      if (!getCanonicalPurchaseOverrideTarget(order)) {
        showPurchaseNotice('当前订单缺少可核验的店铺身份，未保存待配送标记。', 'warning');
        return;
      }
      const rawStatus = error?.rawStatus || 'awaiting_deliver';
      const reason = 'Ozon 正在等待配送，面单暂未生成，请稍后再预报。';
      setPurchaseLocalOverrides((current) => {
        return writeCanonicalPurchaseOverride(current, order, (existing) => {
          const nextOverride = compactObject({
            ...existing,
            readStatus: 'Ozon 面单暂未生成，稍后再预报',
            ozonAwaitingDeliveryPendingAt: new Date().toISOString(),
            ozonAwaitingDeliveryRawStatus: rawStatus,
            ozonAwaitingDeliveryReason: reason,
          });
          if (!nextOverride.manualClassifiedAt) delete nextOverride.forcePurchaseStatus;
          return nextOverride;
        });
      });
      setSelectedOrderId(order.id);
      showPurchaseNotice(reason, 'warning');
    },
    [
      getCanonicalPurchaseOverrideTarget,
      showPurchaseNotice,
      setPurchaseLocalOverrides,
      setSelectedOrderId,
      writeCanonicalPurchaseOverride,
    ]
  );
  const resolvePurchasePluginCaptureTarget = React.useCallback(
    (context = {}) => {
      const sourceKey = String(context.productKey || context.sourceKey || '').trim();
      const orderKey = String(context.orderKey || context.orderId || '').trim();
      if (!sourceKey || !orderKey) return null;
      const matchedOrder = findPurchasePluginCaptureOrder(purchaseOrders, context);
      if (!matchedOrder) return null;

      const orderShop = getPurchaseOrderShop(shops, matchedOrder, activeShop) ?? {
        id: matchedOrder.shopId || matchedOrder.shopClientId || matchedOrder.shop || 'default',
        clientId: matchedOrder.shopClientId,
      };
      if (!getCanonicalPurchaseOverrideTarget(matchedOrder, orderShop)) return null;
      const products =
        Array.isArray(matchedOrder.products) && matchedOrder.products.length
          ? matchedOrder.products
          : getPurchaseCrossBorderProducts(matchedOrder);
      const requestedProductIndex = Number(context.productIndex);
      let fallbackProduct = null;
      let fallbackIndex = 0;

      for (let index = 0; index < products.length; index += 1) {
        const product = products[index];
        const fallback = { productNo: matchedOrder.productNo, sku: matchedOrder.sku };
        const candidateKeys = getProductSourceCandidateKeys(product, orderShop, fallback);
        const legacyProductKey = normalizeOzonId(
          product.offerId ||
            product.sku ||
            product.productId ||
            product.id ||
            matchedOrder.productNo ||
            matchedOrder.sku
        );
        if (Number.isFinite(requestedProductIndex) && requestedProductIndex === index) {
          fallbackProduct = {
            product,
            index,
            candidateKeys,
            legacyProductKey,
            fallback,
          };
        }
        if (candidateKeys.includes(sourceKey) || legacyProductKey === sourceKey) {
          return {
            order: matchedOrder,
            orderKey: getPurchaseOrderRecordKey(matchedOrder),
            product,
            productIndex: index,
            shop: orderShop,
            sourceKey: getProductSourceLinkKey(product, orderShop, fallback) || sourceKey,
            sourceKeys: [...new Set([...candidateKeys, legacyProductKey, sourceKey].filter(Boolean))],
            legacyProductKey,
            fallback,
            orderSourceRecord: normalizeProductSourceRecord(
              matchedOrder.manualSourceRecords?.[sourceKey] ??
                matchedOrder.manualSourceRecords?.[legacyProductKey] ??
                matchedOrder.manualSourceRecord ??
                {}
            ),
          };
        }
      }

      if (fallbackProduct) {
        return {
          order: matchedOrder,
          orderKey: getPurchaseOrderRecordKey(matchedOrder),
          product: fallbackProduct.product,
          productIndex: fallbackProduct.index,
          shop: orderShop,
          sourceKey: getProductSourceLinkKey(fallbackProduct.product, orderShop, fallbackProduct.fallback) || sourceKey,
          sourceKeys: [
            ...new Set([...fallbackProduct.candidateKeys, fallbackProduct.legacyProductKey, sourceKey].filter(Boolean)),
          ],
          legacyProductKey: fallbackProduct.legacyProductKey,
          fallback: fallbackProduct.fallback,
          orderSourceRecord: normalizeProductSourceRecord(
            matchedOrder.manualSourceRecords?.[sourceKey] ??
              matchedOrder.manualSourceRecords?.[fallbackProduct.legacyProductKey] ??
              matchedOrder.manualSourceRecord ??
              {}
          ),
        };
      }

      return null;
    },
    [activeShop, getCanonicalPurchaseOverrideTarget, purchaseOrders, shops]
  );
  const applyPurchasePluginCapture = React.useCallback(
    async (capture = {}) => {
      const context = capture.context && typeof capture.context === 'object' ? capture.context : {};
      const captureType = String(capture.type || '').toLowerCase();
      const isSilentCapture = Boolean(capture.silent || capture.autoFill);
      const sourceKey = String(context.productKey || context.sourceKey || '').trim();
      const orderKey = String(context.orderKey || context.orderId || '').trim();
      const rawLink = String(capture.shortLink || capture.link || '').trim();
      const captureTarget = resolvePurchasePluginCaptureTarget(context);

      if (!captureTarget) {
        if (!isSilentCapture)
          showPurchaseNotice('插件锁定订单或商品不匹配，请回到拍单管理重新选择订单后再保存。', 'warning');
        return;
      }

      if ((captureType === 'source' || (captureType === 'order' && rawLink)) && sourceKey && orderKey) {
        const parsed = normalizeSalesSourceLinkValue(rawLink);
        if (!parsed.ok) {
          showPurchaseNotice(parsed.error || '插件返回的货源链接无法识别。', 'warning');
        } else {
          let savedMessage = '';
          let blockedMessage = '';
          let sourceStorageChanged = false;
          let sourcePersistFailed = false;
          const sharedRecord = getProductSourceRecordFromLinks(
            productSourceLinks,
            captureTarget.product,
            captureTarget.shop,
            captureTarget.fallback
          );
          const usesSharedRecord = sharedRecord.links.length > 0;
          const currentRecord = usesSharedRecord ? sharedRecord : captureTarget.orderSourceRecord;
          const nextLinks = [...currentRecord.links];
          const duplicateIndex = nextLinks.findIndex((item) => item.link === parsed.link);
          const safeTargetIndex = duplicateIndex >= 0 ? duplicateIndex : nextLinks.length;

          if (duplicateIndex >= 0 && usesSharedRecord) {
            savedMessage = '该货源已存在，不重复保存。';
          } else if (duplicateIndex < 0 && nextLinks.length >= SOURCE_LINK_LIMIT) {
            blockedMessage = '当前商品货源已满 5 条，请先人工清出一个位置再保存。';
          } else {
            const currentEntry = nextLinks[safeTargetIndex] ?? {};
            if (duplicateIndex < 0) {
              nextLinks[safeTargetIndex] = {
                ...currentEntry,
                link: parsed.link,
                productId: String(firstFilled(capture.productId, parsed.productId, currentEntry.productId) || '').trim(),
                platform: normalizeSourcePlatformName(capture.platform || parsed.platform),
                title: String(capture.title || currentEntry.title || '').trim(),
                imageUrl: String(capture.imageUrl || currentEntry.imageUrl || '').trim(),
                previewImageUrl: String(
                  firstFilled(
                    capture.previewImageUrl,
                    capture.previewImage,
                    capture.largeImageUrl,
                    capture.largeImage,
                    capture.originalImageUrl,
                    capture.originalImage,
                    currentEntry.previewImageUrl,
                    currentEntry.originalImageUrl
                  ) || ''
                ).trim(),
                originalImageUrl: String(
                  firstFilled(
                    capture.originalImageUrl,
                    capture.originalImage,
                    capture.fullImageUrl,
                    capture.fullImage,
                    capture.highResImageUrl,
                    capture.highResImage,
                    currentEntry.originalImageUrl
                  ) || ''
                ).trim(),
                price: String(capture.amount || currentEntry.price || '').trim(),
                savedAt: capture.receivedAt || new Date().toISOString(),
              };
            }
            const nextRecord = buildProductSourceStorageRecord({
              ...currentRecord,
              links: nextLinks.filter((item) => item?.link).slice(0, SOURCE_LINK_LIMIT),
              primaryIndex: currentRecord.links.length ? currentRecord.primaryIndex : 0,
            });
            setProductSourceLinks({ ...productSourceLinks, [captureTarget.sourceKey]: nextRecord });
            sourceStorageChanged = true;
            try {
              await Promise.all([
                saveProductSourceLinkRecord({
                  key: captureTarget.sourceKey,
                  record: nextRecord,
                  product: captureTarget.product,
                  timeoutMs: 3000,
                }),
                savePurchaseSourceLinkRecord({
                  order: captureTarget.order,
                  record: nextRecord,
                  shopId: captureTarget.shop?.id || captureTarget.order?.shopId || captureTarget.order?.shop_id,
                  productKey: captureTarget.sourceKey,
                  timeoutMs: 3000,
                }),
              ]);
              savedMessage =
                duplicateIndex >= 0
                  ? '该货源已存在，已同步到商品货源库。'
                  : `插件货源已保存到商品货源第 ${safeTargetIndex + 1} 条。`;
            } catch (error) {
              sourcePersistFailed = true;
              savedMessage = `插件货源已暂存本机，SQLite 写入失败：${error instanceof Error ? error.message : String(error)}`;
            }
          }
          if (sourceStorageChanged) {
            setPurchaseLocalOverrides((current) => {
              return writeCanonicalPurchaseOverride(current, captureTarget.order, (existing) => {
                const cleaned = removePurchaseSourceRecordsFromLocalOverride(existing, captureTarget.sourceKeys);
                return cleaned.changed ? cleaned.override : null;
              }, captureTarget.shop);
            });
          }
          if (!isSilentCapture) {
            showPurchaseNotice(
              blockedMessage || savedMessage || '插件货源已保存到商品货源库。',
              blockedMessage || sourcePersistFailed ? 'warning' : 'success'
            );
          }
        }
      }

      const purchaseOrderNo = String(
        firstFilled(capture.purchaseOrderNumber, capture.orderNumber, capture.orderNo, capture.orderId) || ''
      ).trim();
      const platform = normalizeSourcePlatformName(capture.platform || detectSourcePlatformFromLink(rawLink));
      const amountText = String(firstFilled(capture.amount, capture.payAmount, capture.totalAmount) || '').trim();
      const amountValue = firstFiniteNumber(amountText);
      const purchaseOrderStatus = String(
        firstFilled(capture.purchaseOrderStatus, capture.orderStatus, capture.statusText, capture.purchaseStatus) || ''
      ).trim();
      const purchaseOrderUrl = String(
        firstFilled(capture.purchaseOrderUrl, capture.orderUrl, capture.orderLink, capture.url, capture.link) || ''
      ).trim();

      if (captureType === 'order' && orderKey) {
        setPurchaseLocalOverrides((current) => {
          return writeCanonicalPurchaseOverride(current, captureTarget.order, (existing) => {
            const nextOverride = { ...existing };
            if (isFilledPurchasePlatformValue(platform)) nextOverride.manualBuyerPlatform = platform;
            if (purchaseOrderNo) nextOverride.manualPurchaseOrderNo = purchaseOrderNo;
            if (purchaseOrderStatus) nextOverride.manualPurchaseOrderStatus = purchaseOrderStatus;
            if (purchaseOrderUrl) nextOverride.purchaseOrderUrl = purchaseOrderUrl;
            if (amountText) {
              nextOverride.manualPurchasePrice = amountText;
              nextOverride.manualPurchasePriceValue = amountValue;
            }
            if (
              isFilledPurchasePlatformValue(platform) &&
              purchaseOrderNo &&
              amountText &&
              isConfirmedPurchasePlatformStatus(purchaseOrderStatus)
            ) {
              if (nextOverride.forcePurchaseStatus === '待拍单') delete nextOverride.forcePurchaseStatus;
              delete nextOverride.transferPendingAt;
              delete nextOverride.transferPendingReason;
            }
            nextOverride.manualPurchaseUpdatedAt = capture.receivedAt || new Date().toISOString();
            return nextOverride;
          }, captureTarget.shop);
        });
        if (!isSilentCapture) showPurchaseNotice('插件订单信息已回填。', 'success');
      }
    },
    [
      productSourceLinks,
      resolvePurchasePluginCaptureTarget,
      showPurchaseNotice,
      setProductSourceLinks,
      setPurchaseLocalOverrides,
      writeCanonicalPurchaseOverride,
    ]
  );
  const purchasePluginCaptureHandlerRef = React.useRef(applyPurchasePluginCapture);
  React.useEffect(() => {
    purchasePluginCaptureHandlerRef.current = applyPurchasePluginCapture;
  }, [applyPurchasePluginCapture]);
  React.useEffect(() => {
    if (!isActive) return undefined;
    let stopped = false;
    let timer = null;

    const poll = async () => {
      let handledNewCaptures = false;
      try {
        const payload = await readPurchasePluginCaptures(purchasePluginLastCaptureAtRef.current);
        const captures = Array.isArray(payload?.captures) ? payload.captures : [];
        captures
          .slice()
          .sort((left, right) => Date.parse(left.receivedAt || '') - Date.parse(right.receivedAt || ''))
          .forEach((capture) => {
            const id = String(capture?.id || '');
            if (!id || handledPurchasePluginCaptureIdsRef.current.has(id)) return;
            handledNewCaptures = true;
            handledPurchasePluginCaptureIdsRef.current.add(id);
            const receivedAt = Date.parse(capture.receivedAt || '');
            if (Number.isFinite(receivedAt)) {
              purchasePluginLastCaptureAtRef.current = Math.max(purchasePluginLastCaptureAtRef.current, receivedAt);
            }
            purchasePluginCaptureHandlerRef.current(capture);
          });
      } catch {
        // 本地插件服务未启动时不打扰业务页面。
      }

      if (!stopped) {
        timer = window.setTimeout(
          poll,
          handledNewCaptures ? PURCHASE_PLUGIN_CAPTURE_POLL_ACTIVE_MS : PURCHASE_PLUGIN_CAPTURE_POLL_IDLE_MS
        );
      }
    };

    poll();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [isActive, handledPurchasePluginCaptureIdsRef, purchasePluginLastCaptureAtRef]);
  const updateManualPurchaseDraftField = (field) => (event) => {
    setManualPurchaseDraft((current) => ({
      ...current,
      [field]: event.target.value,
    }));
  };
  const openManualPurchaseEditor = (event) => {
    setManualPurchaseAnchorEl(event.currentTarget);
  };
  const closeManualPurchaseEditor = () => {
    setManualPurchaseAnchorEl(null);
  };
  const handleSaveManualPurchaseInfo = () => {
    if (!hasSelectedOrder) return;
    const key = getPurchaseOrderRecordKey(selectedOrder);
    if (!key) {
      showPurchaseNotice('当前订单缺少本地记录键，无法保存补录。', 'warning');
      return;
    }
    if (!getCanonicalPurchaseOverrideTarget(selectedOrder)) {
      showPurchaseNotice('当前订单缺少可核验的店铺身份，补录未保存。', 'warning');
      return;
    }

    const manualBuyerPlatform = manualPurchaseDraft.manualBuyerPlatform.trim();
    const manualPurchaseOrderNo = manualPurchaseDraft.manualPurchaseOrderNo.trim();
    const manualPurchasePrice = manualPurchaseDraft.manualPurchasePrice.trim();
    const manualPurchasePriceValue = firstFiniteNumber(manualPurchasePrice);
    if (manualPurchasePrice && manualPurchasePriceValue === null) {
      showPurchaseNotice('货源成本请填写数字。', 'warning');
      return;
    }

    void persistCanonicalPurchaseOverride(selectedOrder, (existing) => {
      const nextOverride = { ...existing };
      delete nextOverride.manualBuyerPlatform;
      delete nextOverride.manualPurchaseOrderNo;
      delete nextOverride.manualPurchasePrice;
      delete nextOverride.manualPurchasePriceValue;
      delete nextOverride.manualPurchaseUpdatedAt;

      if (manualBuyerPlatform) nextOverride.manualBuyerPlatform = manualBuyerPlatform;
      if (manualPurchaseOrderNo) nextOverride.manualPurchaseOrderNo = manualPurchaseOrderNo;
      if (manualPurchasePrice) {
        nextOverride.manualPurchasePrice = manualPurchasePrice;
        nextOverride.manualPurchasePriceValue = manualPurchasePriceValue;
      }
      const clearFields = new Set(Array.isArray(nextOverride.clearFields) ? nextOverride.clearFields : []);
      [
        ['purchasePlatform', Boolean(manualBuyerPlatform)],
        ['purchaseOrderNumber', Boolean(manualPurchaseOrderNo)],
        ['sourceCostCny', Boolean(manualPurchasePrice)],
      ].forEach(([field, hasValue]) => {
        if (hasValue) clearFields.delete(field);
        else clearFields.add(field);
      });
      nextOverride.clearFields = [...clearFields];
      if (manualBuyerPlatform || manualPurchaseOrderNo || manualPurchasePrice) {
        nextOverride.manualPurchaseUpdatedAt = new Date().toISOString();
      }
      return nextOverride;
    }, { failureLabel: '补录' }).then((saved) => {
      if (saved) showPurchaseNotice('补录已保存。', 'success');
    });

    setManualPurchaseAnchorEl(null);
  };
  const selectPurchaseSearchImage = (order, preview, slot) => {
    if (!order?.id) return;
    setSelectedOrderId(order.id);
    setSelectedPurchaseSearchImage({
      orderId: order.id,
      imageUrl: safeImageUrl(preview?.image),
      slot,
    });
  };

  return {
    persistPurchaseCrossBorderDetail,
    persistPurchaseForecastFlow,
    markPurchaseOrderAwaitingDeliveryPending,
    updateManualPurchaseDraftField,
    openManualPurchaseEditor,
    closeManualPurchaseEditor,
    handleSaveManualPurchaseInfo,
    selectPurchaseSearchImage,
  };
}
