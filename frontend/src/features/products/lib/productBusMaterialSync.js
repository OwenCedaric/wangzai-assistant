import {
  buildProductInfoWriteCommand,
  createProductEditForm,
  getProductWriteFailureMessage,
} from '../../../entities/product/productWriteHelpers.jsx';
import { saveCrossBorderProductMaterialProfileCanonical } from '../../../services/productBusMaterialService';
import { submitProductInfoWrite } from '../../../services/productModuleClient.js';
import { PRODUCT_MATERIAL_SOURCE_CROSS_BORDER } from '../../../services/productMaterialProfileStore';

function getProductBusMaterialFromResult(result = {}) {
  const material = result.material || {};
  const nextMaterial = {
    weight: material.weight,
    length: material.length,
    width: material.width,
    height: material.height,
  };
  return ['weight', 'length', 'width', 'height'].every((field) => String(nextMaterial[field] ?? '').trim() !== '')
    ? nextMaterial
    : null;
}

function saveProductBusMaterialSyncProfile(product, shop, result, material, options = {}) {
  return saveCrossBorderProductMaterialProfileCanonical(product, shop, material, {
    orderId: result.orderId || result.material?.sourceOrderId || '',
    orderNumber: result.material?.sourceOrderNumber || '',
    purchaseOrderNumber: result.material?.sourcePurchaseOrderNumber || '',
    ozonSyncedAt: options.ozonSyncedAt || '',
    ozonSyncTaskId: options.ozonSyncTaskId || '',
    ozonSyncStatus: options.ozonSyncStatus,
  });
}

export async function syncSavedProductBusMaterialToOzon({
  shop = {},
  product = {},
  result = {},
  resolveWritableOzonProduct,
  writeOptions = {},
} = {}) {
  if (result.status !== 'saved-local') return result;

  const material = getProductBusMaterialFromResult(result);
  if (!material) {
    return { ...result, status: 'saved-local', warning: '跨境巴士未返回完整长宽高重量，不能回传 Ozon。' };
  }

  let writableProduct = product;
  try {
    if (typeof resolveWritableOzonProduct === 'function') {
      writableProduct = await resolveWritableOzonProduct(product);
    }
    const form = {
      ...createProductEditForm(writableProduct),
      ...material,
      materialSource: PRODUCT_MATERIAL_SOURCE_CROSS_BORDER,
    };
    const command = buildProductInfoWriteCommand(shop, writableProduct, form, {
      requestedBy: writeOptions.requestedBy || 'product-bus-material-sync',
    });
    const previewResult = await submitProductInfoWrite(command, {
      ...writeOptions,
      humanConfirmed: false,
      realWrite: false,
      dryRun: false,
      timeoutMs: Number(writeOptions.timeoutMs) > 0 ? writeOptions.timeoutMs : 10_000,
    });
    const finalProfile = await saveProductBusMaterialSyncProfile(writableProduct, shop, result, material, {
      ozonSyncedAt: '',
      ozonSyncStatus: '跨境巴士实测，已保存本地；等待人工确认是否回传 Ozon。',
    });
    return {
      ...result,
      status: 'preview-ready',
      material: finalProfile,
      verified: false,
      preview: previewResult?.preview || null,
      writeCommand: command,
      warning: '已生成 Ozon 写入预览，尚未人工确认，本次没有写入 Ozon。',
    };
  } catch (error) {
    await saveProductBusMaterialSyncProfile(writableProduct || product, shop, result, material, {
      ozonSyncStatus: '跨境巴士实测，Ozon 回传预览生成失败',
    }).catch(() => undefined);
    return {
      ...result,
      status: 'saved-local',
      warning: getProductWriteFailureMessage(error, '跨境巴士材积回传'),
    };
  }
}
