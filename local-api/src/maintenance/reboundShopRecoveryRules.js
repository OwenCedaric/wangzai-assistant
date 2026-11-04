import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_REBOUND_SHOP_RECOVERY_EXPECTED_COUNTS = Object.freeze({
  purchaseOverridePhysical: 21,
  purchaseOverrideCanonical: 20,
  productSourceLinks: 6,
  purchaseSourceLinks: 1,
  crossBorderRecords: 10,
});

export const RECOVERY_VERSION = 'rebound-shop-user-data-recovery-v2';

export const PURCHASE_OVERRIDE_COLUMNS = Object.freeze([
  'id',
  'shop_id',
  'order_key',
  'posting_number',
  'ozon_order_id',
  'offer_id',
  'sku',
  'purchase_platform',
  'purchase_order_number',
  'source_cost_cny',
  'manual_status',
  'material_source_json',
  'note',
  'raw_json',
  'created_at',
  'updated_at',
  'purchase_order_url',
]);

export const PRODUCT_SOURCE_LINK_COLUMNS = Object.freeze([
  'id',
  'shop_id',
  'product_key',
  'product_id',
  'offer_id',
  'sku',
  'slot_index',
  'is_primary',
  'platform',
  'url',
  'source_product_id',
  'title',
  'image_url',
  'price_value',
  'currency_code',
  'qty',
  'raw_json',
  'created_at',
  'updated_at',
  'preview_image_url',
  'original_image_url',
]);

export const PURCHASE_SOURCE_LINK_COLUMNS = Object.freeze([
  'id',
  'shop_id',
  'order_key',
  'product_key',
  'offer_id',
  'sku',
  'slot_index',
  'is_primary',
  'platform',
  'url',
  'source_product_id',
  'title',
  'image_url',
  'price_value',
  'currency_code',
  'qty',
  'raw_json',
  'created_at',
  'updated_at',
  'preview_image_url',
  'original_image_url',
]);

export const CROSS_BORDER_COLUMNS = Object.freeze([
  'id',
  'shop_id',
  'record_key',
  'order_id',
  'platform_order',
  'purchase_order_number',
  'collection_number',
  'tracking_number',
  'logistics_order',
  'sheet_order_sn',
  'offer_id',
  'sku',
  'status',
  'read_status',
  'warehouse',
  'route_name',
  'package_weight_kg',
  'length_cm',
  'width_cm',
  'height_cm',
  'volume_items_json',
  'status_json',
  'out_info_json',
  'raw_json',
  'remote_hash',
  'is_stale',
  'last_seen_at',
  'created_at',
  'updated_at',
]);

export const CROSS_BORDER_FILL_MISSING_COLUMNS = Object.freeze([
  'order_id',
  'platform_order',
  'purchase_order_number',
  'collection_number',
  'tracking_number',
  'logistics_order',
  'sheet_order_sn',
  'offer_id',
  'sku',
  'read_status',
  'warehouse',
  'route_name',
  'package_weight_kg',
  'length_cm',
  'width_cm',
  'height_cm',
  'volume_items_json',
  'status_json',
  'out_info_json',
]);

export const PURCHASE_OVERRIDE_RICHNESS_COLUMNS = Object.freeze([
  'ozon_order_id',
  'offer_id',
  'sku',
  'purchase_platform',
  'purchase_order_number',
  'source_cost_cny',
  'manual_status',
  'material_source_json',
  'note',
  'purchase_order_url',
]);

export class ReboundShopDataRecoveryError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'ReboundShopDataRecoveryError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, details = {}) {
  throw new ReboundShopDataRecoveryError(code, details);
}

export function normalizeText(value) {
  return String(value ?? '').trim();
}

export function requiredText(value, code) {
  const normalized = normalizeText(value);
  if (!normalized) fail(code);
  return normalized;
}

export function normalizePath(value, code) {
  const normalized = requiredText(value, code);
  return resolve(normalized);
}

export function isEmptyValue(value) {
  return value === null || value === undefined || (typeof value === 'string' && !value.trim());
}

export function tableExists(db, tableName) {
  return Boolean(
    db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName),
  );
}

export function assertRequiredSchema(db, role) {
  for (const tableName of [
    'shops',
    'purchase_order_overrides',
    'product_source_links',
    'purchase_source_links',
    'cross_border_order_records',
  ]) {
    if (!tableExists(db, tableName)) fail(`REBOUND_RECOVERY_${role}_SCHEMA_INCOMPLETE`);
  }
  if (role === 'TARGET') {
    for (const tableName of ['shop_identity_tombstones', 'ozon_products', 'ozon_orders']) {
      if (!tableExists(db, tableName)) fail('REBOUND_RECOVERY_TARGET_SCHEMA_INCOMPLETE');
    }
  }
}

export function assertQuickCheck(db, role) {
  const rows = db.prepare('PRAGMA quick_check;').all();
  const values = rows.map((row) => normalizeText(row.quick_check ?? Object.values(row)[0]));
  if (values.length !== 1 || values[0].toLowerCase() !== 'ok') {
    fail(`REBOUND_RECOVERY_${role}_QUICK_CHECK_FAILED`);
  }
  return 'ok';
}

export function assertForeignKeyCheck(db, role) {
  const rows = db.prepare('PRAGMA foreign_key_check;').all();
  if (rows.length) fail(`REBOUND_RECOVERY_${role}_FOREIGN_KEY_CHECK_FAILED`);
  return 'ok';
}

export function openReadOnlyDatabase(databasePath, role) {
  if (!existsSync(databasePath)) fail(`REBOUND_RECOVERY_${role}_DATABASE_MISSING`);
  try {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');
    return db;
  } catch {
    fail(`REBOUND_RECOVERY_${role}_DATABASE_OPEN_FAILED`);
  }
}
