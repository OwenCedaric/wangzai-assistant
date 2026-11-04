import { normalizeId, normalizeText, safeJsonParse } from "./productDtoValues.js";

export const PRODUCT_HYDRATION_FACET_COLUMNS = Object.freeze({
  detail: "detail_synced_at",
  pictures: "pictures_synced_at",
  prices: "prices_synced_at",
  stocks: "stocks_synced_at",
  attributes: "attributes_synced_at",
});

export const PRODUCT_FACET_OBSERVATION_STATUS = Object.freeze({
  pending: "pending",
  returned: "returned",
  returnedEmpty: "returned_empty",
  notApplicable: "not_applicable",
  unavailable: "unavailable",
  notReturned: "not_returned",
  failed: "failed",
  contractInvalid: "contract_invalid",
  stalePrevious: "stale_previous",
});

export const PRODUCT_FULL_HYDRATION_FACETS = Object.freeze(
  Object.keys(PRODUCT_HYDRATION_FACET_COLUMNS),
);

export const PRODUCT_OZON_MATERIAL_SOURCE = "ozon-product-list-read";

export function createProductHydrationCoverage(row = {}) {
  const observations = safeJsonParse(row?.facet_observations_json, {});
  return Object.fromEntries(
    Object.entries(PRODUCT_HYDRATION_FACET_COLUMNS).map(([facet, column]) => [
      facet,
      observations?.[facet]?.status
        ? isProductFacetSuccessStatus(observations[facet].status)
        : Boolean(row?.[column]),
    ]),
  );
}

export function isProductHydrationComplete(row = {}) {
  const coverage = createProductHydrationCoverage(row);
  return PRODUCT_FULL_HYDRATION_FACETS.every((facet) => coverage[facet] === true);
}

export function latestProductHydrationTimestamp(row = {}) {
  return Object.values(PRODUCT_HYDRATION_FACET_COLUMNS)
    .map((column) => normalizeText(row?.[column]))
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

export function chunkProductHydrationValues(values = [], size = 400) {
  const normalized = [...new Set(values.map(normalizeId).filter(Boolean))];
  const chunks = [];
  for (let index = 0; index < normalized.length; index += size) {
    chunks.push(normalized.slice(index, index + size));
  }
  return chunks;
}

export function toPublicProductHydration(row = {}) {
  const hydrationCoverage = createProductHydrationCoverage(row);
  const hydrationComplete = isProductHydrationComplete(row);
  return {
    hydratedAt: hydrationComplete
      ? row.hydrated_at || latestProductHydrationTimestamp(row)
      : null,
    hydrationComplete,
    hydrationCoverage,
  };
}

export function isProductFacetSuccessStatus(status) {
  return (
    status === PRODUCT_FACET_OBSERVATION_STATUS.returned ||
    status === PRODUCT_FACET_OBSERVATION_STATUS.returnedEmpty ||
    status === PRODUCT_FACET_OBSERVATION_STATUS.notApplicable ||
    status === PRODUCT_FACET_OBSERVATION_STATUS.unavailable
  );
}

export function isProductFacetGapStatus(status) {
  return (
    status === PRODUCT_FACET_OBSERVATION_STATUS.notReturned ||
    status === PRODUCT_FACET_OBSERVATION_STATUS.failed ||
    status === PRODUCT_FACET_OBSERVATION_STATUS.contractInvalid
  );
}
