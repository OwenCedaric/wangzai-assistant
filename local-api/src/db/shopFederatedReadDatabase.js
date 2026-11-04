import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { materializeShopReadTables } from './shopFederatedMaterialization.js';

const FEDERATED_TABLES = Object.freeze([
  'ozon_products',
  'product_identities',
  'product_status_facts',
  'product_detail_facts',
  'product_dimension_facts',
  'product_price_facts',
  'product_stock_facts',
  'product_warehouse_stock_facts',
  'product_commission_facts',
  'product_acquiring_facts',
  'product_image_facts',
  'product_attribute_facts',
  'product_facet_observations',
  'product_material_profiles',
  'product_source_links',
  'product_image_health',
  'product_manual_cost_profiles',
  'ozon_orders',
  'historical_order_facts',
  'ozon_order_split_relations',
  'ozon_finance_transactions',
  'ozon_returns',
  'ozon_rating_penalties',
  'ozon_finance_statement_reports',
  'ozon_finance_balance_snapshots',
]);

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function quote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function databasePath(db) {
  try {
    return text(db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')?.file);
  } catch {
    return '';
  }
}

export function createShopFederatedReadDatabase({
  canonicalDb,
  shopRepository,
  shopDatabaseRouter,
  profitLedgerDirectShopIds = [],
  requiredShopIds = null,
} = {}) {
  const canonicalPath = databasePath(canonicalDb);
  if (!canonicalPath || !shopRepository?.listShops || !shopDatabaseRouter?.resolve) {
    return Object.freeze({ db: canonicalDb, refresh() { return { ok: true, fallback: true }; }, close() {}, snapshot() { return { fallback: true, shopCount: 0 }; } });
  }
  let current = null;
  let lastShopCount = 0;
  let generation = 0;
  let sourceProbes = [];
  let sourceSignature = '';
  let lastError = null;
  let mode = 'attached-live';
  let attachedSchemas = [];
  const readSuspensions = new Set();

  function assertReadsAvailable() {
    if (readSuspensions.size) throw Object.assign(new Error('账号清理正在释放数据库连接，汇总读取暂时暂停。'), {
      code: 'ACCOUNT_REMOVAL_STORAGE_READ_PAUSED', statusCode: 409,
    });
  }

  function closeReadConnections() {
    try { current?.close(); } finally { current = null; closeProbes(sourceProbes); sourceProbes = []; attachedSchemas = []; }
  }

  function resolveShops() {
    const shops = shopRepository.listShops().filter(shop => shop?.status !== 'disabled')
      .map(shop => ({ shopId: shop.id, path: shopDatabaseRouter.resolve(shop.id).databasePath }))
      .map(shop => ({ ...shop, legacy: !existsSync(shop.path) }));
    const required = requiredShopIds === null ? null : new Set(typeof requiredShopIds === 'function' ? requiredShopIds() : requiredShopIds);
    const missingShopIds = shops.filter(shop => shop.legacy && (!required || required.has(shop.shopId))).map(shop => shop.shopId);
    if (missingShopIds.length) throw Object.assign(new Error('SHOP_FEDERATED_DATABASE_MISSING'), {
      code: 'SHOP_FEDERATED_DATABASE_MISSING', missingShopIds, expectedShopCount: shops.length,
    });
    return shops;
  }

  const signature = shops => JSON.stringify(shops.map(shop => [shop.shopId, shop.path, shop.legacy]));
  const version = db => db.prepare('PRAGMA data_version').get().data_version;
  const closeProbes = probes => probes.forEach(source => { try { source.db.close(); } catch { /* cleanup */ } });

  function refresh() {
    assertReadsAvailable();
    let next = null;
    const probes = [];
    const nextSchemas = [];
    try {
    const shops = resolveShops();
    const independent = shops.filter(shop => !shop.legacy);
    const legacyShopIds = shops.filter(shop => shop.legacy).map(shop => shop.shopId);
    next = new DatabaseSync(canonicalPath, { readOnly: true });
    next.exec('PRAGMA busy_timeout = 10000;');
    // Validate the registered scope metadata where a production router exists.
    for (const shop of independent) shopDatabaseRouter.open?.(shop.shopId, { createIfMissing: false });
    if (independent.length > 10) {
      for (const shop of independent) {
        const source = new DatabaseSync(shop.path, { readOnly: true });
        source.exec('PRAGMA busy_timeout = 10000;');
        probes.push({ ...shop, db: source, version: version(source) });
      }
      // Track central changes too: fallback facts and shared profit partitions
      // must not become permanently stale after materialization.
      const centralProbe = new DatabaseSync(canonicalPath, { readOnly: true });
      const sourceVersions = [...probes, { db: centralProbe, version: version(centralProbe), central: true }];
      probes.push(sourceVersions.at(-1));
      materializeShopReadTables(next, probes.filter(source => !source.central), FEDERATED_TABLES, profitLedgerDirectShopIds, legacyShopIds);
      if (sourceVersions.some(source => version(source.db) !== source.version)) {
        throw Object.assign(new Error('SHOP_FEDERATED_SOURCE_CHANGED'), { code: 'SHOP_FEDERATED_SOURCE_CHANGED' });
      }
    } else {
    const attached = [];
    independent.forEach((shop, index) => {
      const alias = `shop_${index + 1}`;
      next.prepare(`ATTACH DATABASE ? AS ${quote(alias)}`).run(shop.path);
      attached.push({ ...shop, alias });
      nextSchemas.push({ alias, version: next.prepare(`PRAGMA ${quote(alias)}.schema_version`).get().schema_version });
    });
    for (const tableName of FEDERATED_TABLES) {
      const sources = attached.filter(({ alias }) => Boolean(next.prepare(`
        SELECT 1 FROM ${quote(alias)}.sqlite_master
        WHERE type = 'table' AND name = ?
      `).get(tableName)));
      if (!sources.length) {
        if (next.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(tableName)) {
          const scope = shops.map(shop => `'${String(shop.shopId).replaceAll("'", "''")}'`).join(',');
          next.exec(`CREATE TEMP VIEW ${quote(tableName)} AS SELECT * FROM main.${quote(tableName)} WHERE ${scope ? `shop_id IN (${scope})` : '0'};`);
        }
        continue;
      }
      const legacy = [...legacyShopIds, ...attached.filter(source => !sources.includes(source)).map(source => source.shopId)];
      const legacySelect = legacy.length ? ` UNION ALL SELECT * FROM main.${quote(tableName)} WHERE shop_id IN (${legacy.map(id => `'${String(id).replaceAll("'", "''")}'`).join(',')})` : '';
      next.exec(`
        CREATE TEMP VIEW ${quote(tableName)} AS
        ${sources.map(({ alias, shopId }) => `SELECT * FROM ${quote(alias)}.${quote(tableName)} WHERE shop_id='${String(shopId).replaceAll("'", "''")}'`).join(' UNION ALL ')}${legacySelect};
      `);
    }
    const profitSources = attached.filter(({ shopId, alias }) => profitLedgerDirectShopIds.includes(shopId)
      && next.prepare(`SELECT 1 FROM ${quote(alias)}.sqlite_master WHERE type='table' AND name='profit_ledger_snapshots'`).get());
    if (profitSources.length) {
      // Pilot migration removes only the migrated owner's rows from main.
      // Prefix-qualified snapshot keys prevent cross-database chunk collisions.
      next.exec(`CREATE TEMP VIEW profit_ledger_snapshots AS SELECT * FROM main.profit_ledger_snapshots UNION ALL
        ${profitSources.map(({ alias }) => `SELECT * FROM ${quote(alias)}.profit_ledger_snapshots`).join(' UNION ALL ')}`);
    }
    }
    next.exec('PRAGMA query_only = ON;');
    const previous = current;
    current = next;
    closeProbes(sourceProbes);
    sourceProbes = probes;
    attachedSchemas = nextSchemas;
    sourceSignature = signature(shops);
    mode = independent.length > 10 ? 'versioned-temp-projection' : 'attached-live';
    lastError = null;
    lastShopCount = shops.length;
    generation += 1;
    try { previous?.close(); } catch { /* next generation is already active */ }
    return Object.freeze({ ok: true, fallback: false, complete: true, shopCount: shops.length, independentShopCount: independent.length, legacyShopIds, generation, mode });
    } catch (error) {
      lastError = error;
      closeProbes(probes);
      try { next?.close(); } catch { /* original error wins */ }
      throw error;
    }
  }

  function active() {
    assertReadsAvailable();
    try {
    if (!current || lastError || signature(resolveShops()) !== sourceSignature
      || sourceProbes.some(source => version(source.db) !== source.version)
      || attachedSchemas.some(source => current.prepare(`PRAGMA ${quote(source.alias)}.schema_version`).get().schema_version !== source.version)) refresh();
    return current;
    } catch (error) { lastError = error; throw error; }
  }

  const db = Object.freeze({
    prepare(sql) { return active().prepare(sql); },
    exec(sql) { return active().exec(sql); },
  });
  return Object.freeze({
    db,
    refresh,
    close: closeReadConnections,
    suspendReads(key) { readSuspensions.add(String(key)); closeReadConnections(); return { suspended: true }; },
    resumeReads(key) { readSuspensions.delete(String(key)); return { suspended: readSuspensions.size > 0 }; },
    snapshot() { return Object.freeze({ fallback: false, complete: !lastError, readsSuspended: readSuspensions.size > 0, errorCode: lastError?.code || null, shopCount: lastShopCount, generation, mode }); },
  });
}

export const shopFederatedReadDatabaseInternals = Object.freeze({ FEDERATED_TABLES });
