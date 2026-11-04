import { canUseOzonShop, normalizeOzonId } from '../../../entities/order/orderShopScope.jsx';
import { clearProductListCacheForShop } from '../../../entities/product/productLocalData.jsx';
import { resolveCanonicalProductOwnerShop } from '../../../entities/product/productShopScope.jsx';
import {
  buildProductArchiveWriteCommand,
  buildProductInfoWriteCommand,
  buildProductPriceWriteCommand,
  buildSingleProductStockWriteCommand,
  cleanDecimal,
  getProductSelectionKey,
  getProductWriteFailureMessage,
  hasDetailImagesChanged,
  hasPriceChanged,
  hasProductDetailsChanged,
  hasStockChanged,
  isProductWriteExecutionNotConnected,
} from '../../../entities/product/productWriteHelpers.jsx';
import { getProductOfferLookupId } from '../../../entities/product/productViewRuntime.jsx';
import {
  isProductWriteReadbackComplete,
  submitProductArchiveWrite,
  submitProductInfoWrite,
  submitProductPriceWrite,
  submitProductStockWrite,
  submitProductUnarchiveWrite,
} from '../../../services/productModuleClient.js';
import {
  readProductRichContent,
  replaceProductRichContentAttribute,
  syncProductRichContentImages,
} from '../../../entities/product/productRichContent.js';
import {
  applyProductMaterialProfiles,
  getProductMaterialSource,
  hasCompleteProductMaterial,
  PRODUCT_MATERIAL_SOURCE_SUPPLIER,
  saveSupplierProductMaterialProfileCanonical,
} from '../../../services/productMaterialProfileStore';
import { prepareProductImagesForOzon } from '../services/productImageAssetService.js';
import React from 'react';

function strictWriteOptions(options = {}) {
  return {
    ...options,
    humanConfirmed: true,
    realWrite: true,
    dryRun: false,
    timeoutMs: Number(options.timeoutMs) > 0 ? options.timeoutMs : 30_000,
  };
}

function pendingReadbackMessage(actionText = '商品写入') {
  return `${actionText}已提交，但 local-api 尚未完成 Ozon 回读与 SQLite 合并，不能标记完成。请稍后执行商品同步并核对。`;
}

export function useProductWriteState({
  editingProduct,
  setSavingProductId,
  shops = [],
  setProducts,
  setEditingProduct,
  setProductNotice,
  loadOzonProducts,
  resolveWritableOzonProduct,
  setArchiveConfirmDialog,
  savingProductId,
  archiveConfirmDialog,
} = {}) {
  const [pendingProductArchiveKeys, setPendingProductArchiveKeys] = React.useState(() => new Set());
  const resolveProductOwnerShop = React.useCallback(
    (product) => resolveCanonicalProductOwnerShop(product, shops),
    [shops]
  );

  const reloadCurrentProductPageFromSqlite = React.useCallback(async (ownerShop) => {
    clearProductListCacheForShop(ownerShop);
    if (typeof loadOzonProducts !== 'function') return false;
    await loadOzonProducts({ localOnly: true, force: true });
    return true;
  }, [loadOzonProducts]);

  const handleSaveProduct = async (form, options = {}) => {
    if (!editingProduct) return;
    if (options.humanConfirmed !== true) {
      setProductNotice({ open: true, severity: 'warning', message: '商品保存必须先查看差异并人工确认。' });
      return;
    }
    setSavingProductId(String(editingProduct.productId || editingProduct.offerId || 'editing'));
    try {
      const ownerShop = resolveProductOwnerShop(editingProduct);
      if (!canUseOzonShop(ownerShop)) throw new Error('商品所属店铺未配置 Ozon 权限，不能提交写入。');
      const detailImagesChanged = hasDetailImagesChanged(editingProduct, form);
      const preparedDetailImages = detailImagesChanged
        ? await prepareProductImagesForOzon(form.detailImages, {
          sourceType: 'product-editor-detail',
          variant: 'detail',
          shopId: ownerShop.id,
          productId: editingProduct.productId,
          offerId: editingProduct.offerId,
        })
        : form.detailImages;
      const preparedForm = {
        ...form,
        images: await prepareProductImagesForOzon(form.images, {
          sourceType: 'product-editor-local',
          variant: 'main',
          shopId: ownerShop.id,
          productId: editingProduct.productId,
          offerId: editingProduct.offerId,
        }),
        detailImages: preparedDetailImages,
      };
      if (detailImagesChanged) {
        preparedForm.attributes = replaceProductRichContentAttribute(
          Array.isArray(form.attributes) ? form.attributes : editingProduct.attributes,
          syncProductRichContentImages(readProductRichContent(editingProduct), preparedDetailImages),
        );
      }
      const changes = {
        product: hasProductDetailsChanged(editingProduct, preparedForm) || detailImagesChanged,
        price: hasPriceChanged(editingProduct, preparedForm),
        stock: hasStockChanged(editingProduct, preparedForm),
      };
      const materialFieldsChanged = ['weight', 'length', 'width', 'height'].some(
        (field) => cleanDecimal(preparedForm[field]) !== cleanDecimal(editingProduct[field]),
      );
      const materialSourceChanged = preparedForm.materialSource !== getProductMaterialSource(editingProduct);
      const isSupplierMaterial = preparedForm.materialSource === PRODUCT_MATERIAL_SOURCE_SUPPLIER;
      if (materialFieldsChanged && !isSupplierMaterial) {
        throw new Error('修改重量尺寸前，请先把材积来源切换为上游提供。');
      }
      if (isSupplierMaterial && !hasCompleteProductMaterial(preparedForm)) {
        throw new Error('上游提供需要填写完整重量、长、宽、高。');
      }
      if (!changes.product && !changes.price && !changes.stock) {
        if (materialSourceChanged && isSupplierMaterial) {
          await saveSupplierProductMaterialProfileCanonical(editingProduct, ownerShop, preparedForm, { ozonSyncStatus: '上游提供' });
          setProducts((rows) =>
            rows.map((row) => {
              try {
                return applyProductMaterialProfiles([row], resolveProductOwnerShop(row))[0];
              } catch {
                return row;
              }
            })
          );
          setProductNotice({ open: true, severity: 'success', message: '上游包材信息已保存。' });
        } else {
          setProductNotice({ open: true, severity: 'info', message: '没有检测到需要同步的变更。' });
        }
        setEditingProduct(null);
        return;
      }

      const writeOptions = strictWriteOptions(options);
      const writeTasks = [];
      if (changes.product) {
        writeTasks.push(submitProductInfoWrite(buildProductInfoWriteCommand(ownerShop, editingProduct, preparedForm), writeOptions));
      }
      if (changes.price) {
        writeTasks.push(submitProductPriceWrite(buildProductPriceWriteCommand(ownerShop, editingProduct, preparedForm), writeOptions));
      }
      if (changes.stock) {
        writeTasks.push(submitProductStockWrite(buildSingleProductStockWriteCommand(ownerShop, editingProduct, preparedForm), writeOptions));
      }
      const writeResults = await Promise.all(writeTasks);
      const notConnected = writeResults.find(isProductWriteExecutionNotConnected);
      if (notConnected) {
        throw new Error(getProductWriteFailureMessage(notConnected, '商品保存'));
      }
      if (!writeResults.every(isProductWriteReadbackComplete)) {
        if (isSupplierMaterial) {
          await saveSupplierProductMaterialProfileCanonical(editingProduct, ownerShop, preparedForm, {
            ozonSyncedAt: '',
            ozonSyncStatus: '上游提供；已提交，等待 Ozon 回读。',
          });
        }
        setProductNotice({ open: true, severity: 'warning', message: pendingReadbackMessage('商品保存') });
        return;
      }

      if (isSupplierMaterial) {
        await saveSupplierProductMaterialProfileCanonical(editingProduct, ownerShop, preparedForm, {
          ozonSyncedAt: new Date().toISOString(),
          ozonSyncStatus: '已从 Ozon 回读确认',
        });
      }
      await reloadCurrentProductPageFromSqlite(ownerShop);
      setEditingProduct(null);
      setProductNotice({
        open: true,
        severity: 'success',
        message: '商品保存已由 Ozon 回读确认，并合并到 SQLite。',
      });
    } catch (error) {
      setProductNotice({ open: true, severity: 'error', message: getProductWriteFailureMessage(error, '商品保存') });
    } finally {
      setSavingProductId('');
    }
  };

  const handleProductArchiveAction = (product, action) => {
    let ownerShop;
    try {
      ownerShop = resolveProductOwnerShop(product);
      if (!canUseOzonShop(ownerShop)) throw new Error('商品所属店铺未配置 Ozon 权限。');
    } catch (error) {
      setProductNotice({ open: true, severity: 'warning', message: String(error?.message || error) });
      return;
    }
    const actionText = action === 'archive' ? '下架' : '上架';
    const productId = normalizeOzonId(product?.productId);
    if (productId) {
      setArchiveConfirmDialog({ open: true, action, product: { ...product, productId } });
      return;
    }
    const savingKey = `resolve-${action}-${getProductOfferLookupId(product) || getProductSelectionKey(product) || 'product'}`;
    setSavingProductId(savingKey);
    resolveWritableOzonProduct(product)
      .then((writableProduct) => {
        if (!writableProduct?.productId) throw new Error(`SQLite 中缺少 Ozon 商品 ID，不能${actionText}。请先执行商品同步。`);
        setArchiveConfirmDialog({ open: true, action, product: writableProduct });
      })
      .catch((error) => setProductNotice({ open: true, severity: 'warning', message: String(error?.message || error) }))
      .finally(() => setSavingProductId((current) => (current === savingKey ? '' : current)));
  };

  const closeArchiveConfirmDialog = () => {
    if (!savingProductId) setArchiveConfirmDialog({ open: false, action: '', product: null });
  };

  const getProductArchiveOperationKey = (product = {}, action = '') =>
    getProductSelectionKey(product) || `${action}:${product.productId || product.offerId || product.sku || product.id || ''}`;

  const handleConfirmProductArchiveAction = async () => {
    const { action, product } = archiveConfirmDialog;
    if (!product?.productId) {
      setArchiveConfirmDialog({ open: false, action: '', product: null });
      return;
    }
    const actionText = action === 'archive' ? '下架' : '上架';
    const operationKey = getProductArchiveOperationKey(product, action);
    if (pendingProductArchiveKeys.has(operationKey)) return;
    setArchiveConfirmDialog({ open: false, action: '', product: null });
    setPendingProductArchiveKeys((keys) => new Set(keys).add(operationKey));
    setSavingProductId(operationKey);
    try {
      const ownerShop = resolveProductOwnerShop(product);
      if (!canUseOzonShop(ownerShop)) throw new Error('商品所属店铺未配置 Ozon 权限。');
      const command = buildProductArchiveWriteCommand(ownerShop, product, action);
      const result = action === 'archive'
        ? await submitProductArchiveWrite(command, strictWriteOptions())
        : await submitProductUnarchiveWrite(command, strictWriteOptions());
      if (isProductWriteExecutionNotConnected(result)) throw new Error(getProductWriteFailureMessage(result, actionText));
      if (!isProductWriteReadbackComplete(result)) {
        setProductNotice({ open: true, severity: 'warning', message: pendingReadbackMessage(actionText) });
        return;
      }
      await reloadCurrentProductPageFromSqlite(ownerShop);
      setProductNotice({ open: true, severity: 'success', message: `${actionText}已由 Ozon 回读确认，并合并到 SQLite。` });
    } catch (error) {
      setProductNotice({ open: true, severity: 'error', message: getProductWriteFailureMessage(error, actionText) });
    } finally {
      setSavingProductId('');
      setPendingProductArchiveKeys((keys) => {
        const next = new Set(keys);
        next.delete(operationKey);
        return next;
      });
    }
  };

  return {
    handleSaveProduct,
    handleProductArchiveAction,
    closeArchiveConfirmDialog,
    getProductArchiveOperationKey,
    pendingProductArchiveKeys,
    handleConfirmProductArchiveAction,
  };
}
