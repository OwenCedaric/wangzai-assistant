import { shopProductStorageInternals } from './shopProductStorage.js';
import { SHOP_OPERATIONAL_TABLES } from './shopOperationalStorage.js';

const productTables = new Set(shopProductStorageInternals.PRODUCT_TABLES);
const orderTables = new Set(['ozon_orders', 'historical_order_facts', 'ozon_order_split_relations']);
const operationalTables = new Set(SHOP_OPERATIONAL_TABLES);

/** Shared authority for backup/import and cross-domain consumers. No silent fallback after cutover. */
export function createShopDomainStorageResolver({ canonicalDb, shopProductStorage, shopOrderStorage, shopOperationalStorage } = {}) {
  return function resolveShopDomainDatabase({ shopId, policy, canonicalTable, domain } = {}) {
    const table = canonicalTable || policy?.canonicalTable || '';
    const storage = productTables.has(table) ? shopProductStorage
      : orderTables.has(table) ? shopOrderStorage
        : operationalTables.has(table) ? shopOperationalStorage : null;
    if (!storage || !storage.isDirectWriteShop(shopId)) return { db: canonicalDb, route: null, domain, canonicalTable: table };
    const session = storage.resolveDirectWriteSession({ shopId });
    return { db: session.db, route: session.route, domain, canonicalTable: table };
  };
}
