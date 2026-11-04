import { deletePurchaseSourceLinks, getPurchaseSourceLinks, savePurchaseSourceLinks } from '../api/localApiClient.js';

import { importLegacyPurchaseSourceLinks } from '../api/localApiClient.js';

function normalizeText(value) {
  return String(value ?? '').trim();
}

export function toPurchaseSourceLinksPayload(order = {}, links = [], options = {}) {
  const orderKey = normalizeText(
    order.orderKey ?? order.recordKey ?? order.record_key ?? order.id ?? order.postingNumber ?? order.posting_number ?? order.ozonOrderId
  );
  return {
    shopId: normalizeText(options.shopId ?? order.shopId ?? order.shop_id),
    orderKey,
    productKey: normalizeText(options.productKey ?? order.productKey ?? order.product_key),
    postingNumber: normalizeText(order.postingNumber ?? order.posting_number),
    offerId: normalizeText(order.offerId ?? order.offer_id),
    sku: normalizeText(order.sku),
    primaryIndex: Number(options.primaryIndex ?? 0) || 0,
    links: (Array.isArray(links) ? links : []).map((link, index) => ({
      ...link,
      slotIndex: Number(link.slotIndex ?? link.slot_index ?? index) || 0,
      orderKey,
      shopId: normalizeText(options.shopId ?? order.shopId ?? order.shop_id),
      productKey: normalizeText(options.productKey ?? link.productKey ?? link.product_key ?? order.productKey ?? order.product_key),
      offerId: normalizeText(link.offerId ?? link.offer_id ?? order.offerId ?? order.offer_id),
      sku: normalizeText(link.sku ?? order.sku),
    })),
  };
}

export function readPurchaseSourceLinks(query = {}, options = {}) {
  return getPurchaseSourceLinks(query, options);
}

export function savePurchaseSourcesForOrder(order = {}, links = [], options = {}) {
  return savePurchaseSourceLinks(toPurchaseSourceLinksPayload(order, links, options), options);
}

export function importLegacyPurchaseSources(records = [], options = {}) {
  return importLegacyPurchaseSourceLinks(records, options);
}

export function removePurchaseSourcesForOrder(order = {}, options = {}) {
  return deletePurchaseSourceLinks(
    {
      shopId: normalizeText(options.shopId ?? order.shopId ?? order.shop_id),
      orderKey: normalizeText(
        order.orderKey ?? order.recordKey ?? order.record_key ?? order.id ?? order.postingNumber ?? order.posting_number ?? order.ozonOrderId
      ),
    },
    options
  );
}
