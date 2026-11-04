import {
  deleteSalesSourceLinks,
  getSalesSourceLinks,
  importLegacySalesSourceLinks,
  saveSalesSourceLinks,
} from '../api/localApiClient.js';

function normalizeText(value) {
  return String(value ?? '').trim();
}

export function toSalesSourceLinksPayload(input = {}, options = {}) {
  const shopId = normalizeText(options.shopId ?? input.shopId ?? input.shop_id);
  const orderKey = normalizeText(
    options.orderKey ?? input.orderKey ?? input.order_key ?? input.postingNumber ?? input.posting_number ?? input.id
  );
  const record = input.record && typeof input.record === 'object' ? input.record : input;
  const links = Array.isArray(input.links) ? input.links : Array.isArray(record.links) ? record.links : [];
  return {
    shopId,
    orderKey,
    primaryIndex: Number(input.primaryIndex ?? record.primaryIndex ?? 0) || 0,
    links: links.map((link, index) => ({
      ...link,
      shopId,
      orderKey,
      slotIndex: Number(link.slotIndex ?? link.slot_index ?? index) || 0,
    })),
  };
}

export function readSalesSourceLinks(query = {}, options = {}) {
  return getSalesSourceLinks(query, options);
}

export function saveSalesSourcesForOrder(input = {}, options = {}) {
  return saveSalesSourceLinks(toSalesSourceLinksPayload(input, options), options);
}

export function importLegacySalesSources(records = [], options = {}) {
  return importLegacySalesSourceLinks(records, options);
}

export function removeSalesSourcesForOrder(input = {}, options = {}) {
  return deleteSalesSourceLinks(
    {
      shopId: normalizeText(options.shopId ?? input.shopId ?? input.shop_id),
      orderKey: normalizeText(options.orderKey ?? input.orderKey ?? input.order_key ?? input.postingNumber ?? input.posting_number ?? input.id),
    },
    options
  );
}
