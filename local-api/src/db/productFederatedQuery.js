import { DatabaseSync } from 'node:sqlite';
import { shopProductStorageInternals } from './shopProductStorage.js';
import { createProductCanonicalQueryRepository } from './repositories/productCanonicalQueryRepository.js';
import { createProductSupportRepository } from './repositories/productSupportRepository.js';
import { readProductFederatedPage } from './productFederatedPage.js';

const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

/** SQL performs global filtering/counting/sorting before LIMIT; no duplicate JS business rules. */
export function createProductFederatedQuery() {
  let current = null;
  let signature = '';
  let reader = null;
  const readSuspensions = new Set();
  function close() {
    current?.close();
    current = null;
    signature = '';
    reader = null;
  }
  function invoke(method, sessions, query) {
    if (readSuspensions.size) throw Object.assign(new Error('账号清理期间商品汇总读取暂时暂停。'), { code: 'ACCOUNT_REMOVAL_STORAGE_READ_PAUSED' });
    if (method === 'listProducts') return readProductFederatedPage(sessions, query);
    if (method === 'getProductsByIds') return readProductFederatedPage(sessions, { ...query, pageSize: query.pageSize || 100 });
    const nextSignature = JSON.stringify(sessions.map(({ db, route, shopId }) => [
      shopId, route?.scopeDigest, route?.scopeToken,
      db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')?.file,
    ]));
    if (signature !== nextSignature) {
      const next = new DatabaseSync(':memory:');
      try {
        next.exec('PRAGMA busy_timeout = 5000');
        const sources = sessions.map(({ db, shopId }, index) => {
          const path = db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')?.file;
          if (!path) throw new Error('SHOP_PRODUCT_FEDERATION_FILE_REQUIRED');
          const alias = `product_shop_${index}`;
          next.prepare(`ATTACH DATABASE ? AS ${quote(alias)}`).run(path);
          return { alias, shopId };
        });
        for (const table of shopProductStorageInternals.PRODUCT_TABLES) {
          const columns = sessions[0].db.prepare(`PRAGMA table_info(${quote(table)})`).all().map((row) => row.name);
          const names = columns.map(quote).join(', ');
          next.exec(`CREATE TEMP VIEW ${quote(table)} AS ${sources.map(({ alias, shopId }) =>
            `SELECT ${names} FROM ${quote(alias)}.${quote(table)} WHERE shop_id = ${literal(shopId)}`).join(' UNION ALL ')}`);
        }
        const support = createProductSupportRepository(next, { readOnly: true, refreshProductHydratedAt() {
          throw new Error('SHOP_PRODUCT_FEDERATION_READ_ONLY');
        } });
        const canonical = createProductCanonicalQueryRepository(next, {
          canonicalFactsAvailable: true,
          allowCompatibilityRepairs: false,
          attachProductSupport: support.attachProductSupport,
        });
        next.exec('PRAGMA query_only = ON');
        close();
        current = next;
        signature = nextSignature;
        reader = { ...canonical, ...support };
      } catch (error) {
        next.close();
        throw error;
      }
    }
    // Views are bound to already-validated owners; remove conflicting aliases.
    return reader[method]({ ...query, shopId: '', shop_id: '', shopIds: [], shop_ids: [] });
  }
  return Object.freeze({ invoke, close,
    suspend(key) { readSuspensions.add(String(key)); close(); },
    resume(key) { readSuspensions.delete(String(key)); },
  });
}
