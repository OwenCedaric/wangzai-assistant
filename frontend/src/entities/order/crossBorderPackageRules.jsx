import { firstUsableOzonId } from './orderShopScope.jsx';

export function getCrossBorderStoreForPurchaseOrder(settings = {}) {
  const warehouseOptions = Array.isArray(settings.warehouseOptions) ? settings.warehouseOptions : [];
  const selectedWarehouseValue = String(settings.cooperationWarehouse || '').trim();
  const selectedWarehouse =
    warehouseOptions.find((option) => String(option.value || '') === selectedWarehouseValue) ??
    warehouseOptions.find((option) => String(option.sid || '') === selectedWarehouseValue) ??
    null;
  const [sectionFromValue, sidFromValue] = selectedWarehouseValue.includes(':')
    ? selectedWarehouseValue.split(':')
    : ['', ''];

  return {
    sid: firstUsableOzonId(
      selectedWarehouse?.sid,
      selectedWarehouse?.id,
      settings.sid,
      settings.storehouseId,
      settings.storehouse_id,
      sidFromValue
    ),
    sectionId: firstUsableOzonId(
      selectedWarehouse?.sectionId,
      selectedWarehouse?.section_id,
      settings.sectionId,
      settings.section_id,
      sectionFromValue
    ),
  };
}

export function getPurchaseCrossBorderProducts(order = {}) {
  const products = Array.isArray(order.products) ? order.products.filter(Boolean) : [];
  if (products.length) return products;
  return firstUsableOzonId(order.productNo, order.sku)
    ? [
        {
          name: order.product || order.productNo || '未返回',
          offerId: order.productNo,
          sku: order.sku,
          qty: order.items || 1,
          image: '',
        },
      ]
    : [];
}
