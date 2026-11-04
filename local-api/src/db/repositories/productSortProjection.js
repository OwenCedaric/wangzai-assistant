// Exact raw columns used by buildCanonicalProductOrderBy; no monetary/display conversions.
export const PRODUCT_SORT_COLUMNS = Object.freeze([
  ['id', 'TEXT'], ['shop_id', 'TEXT'], ['product_id', 'TEXT'], ['offer_id', 'TEXT'], ['sku', 'TEXT'],
  ['canonical_product_id', 'TEXT'], ['canonical_offer_id', 'TEXT'], ['canonical_sku', 'TEXT'],
  ['updated_at', 'TEXT'], ['canonical_status_updated_at', 'TEXT'],
  ['canonical_visibility', 'TEXT'], ['canonical_status_label', 'TEXT'], ['canonical_snapshot_visibilities_json', 'TEXT'],
  ['canonical_stock_quantity', 'REAL'], ['canonical_price_minor', 'REAL'], ['canonical_acquiring_fee_minor', 'REAL'],
  ['canonical_commission_rate_ppm', 'REAL'], ['canonical_weight_g', 'REAL'],
]);
