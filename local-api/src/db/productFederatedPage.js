import { DatabaseSync } from 'node:sqlite';
import { buildCanonicalProductOrderBy, normalizeProductSort, normalizePageSize } from './repositories/productCanonicalDto.js';
import { PRODUCT_SORT_COLUMNS } from './repositories/productSortProjection.js';
import { createProductCanonicalQueryRepository } from './repositories/productCanonicalQueryRepository.js';
import { createProductSupportRepository } from './repositories/productSupportRepository.js';

/** Merge lightweight sort keys, then fetch only the selected page with the original mapper. */
export function readProductFederatedPage(sessions, query = {}) {
  const sort = normalizeProductSort(query.sort);
  const pageSize = normalizePageSize(query.pageSize ?? query.limit);
  const page = Math.max(Number(query.page) || 1, 1);
  const offset = Math.max(Number(query.offset) || (page - 1) * pageSize, 0);
  const prefix = offset + pageSize;
  const started = Date.now();
  const sorter = new DatabaseSync(':memory:');
  const readers = new Map();
  const counts = {};
  let total = 0;
  try {
    sorter.exec(`CREATE TABLE product_sort_keys (${PRODUCT_SORT_COLUMNS.map(([name, type]) => `${name} ${type}`).join(', ')})`);
    const insert = sorter.prepare(`INSERT INTO product_sort_keys VALUES (${PRODUCT_SORT_COLUMNS.map(() => '?').join(',')})`);
    sorter.exec('BEGIN');
    for (const { db, shopId } of sessions) {
      const support = createProductSupportRepository(db, { readOnly: true, refreshProductHydratedAt() { throw new Error('READ_ONLY'); } });
      const reader = createProductCanonicalQueryRepository(db, {
        canonicalFactsAvailable: true, allowCompatibilityRepairs: false, attachProductSupport: support.attachProductSupport,
      });
      readers.set(shopId, reader);
      let position = 0;
      let shopTotal = 0;
      do {
        const result = reader.listProductSortKeys({ ...query, shopId, shop_id: shopId, shopIds: [], shop_ids: [],
          page: 1, offset: position, pageSize: prefix - position, sort });
        if (position === 0) {
          shopTotal = result.total;
          total += shopTotal;
          for (const [key, value] of Object.entries(result.counts)) counts[key] = (counts[key] || 0) + value;
        }
        for (const row of result.rows) insert.run(...PRODUCT_SORT_COLUMNS.map(([name]) => row[name] ?? null));
        position += result.rows.length;
        if (!result.rows.length) break;
      } while (position < Math.min(prefix, shopTotal));
    }
    sorter.exec('COMMIT');
    const selected = sorter.prepare(`SELECT * FROM product_sort_keys ORDER BY ${buildCanonicalProductOrderBy(sort)} LIMIT ? OFFSET ?`).all(pageSize, offset);
    const rowsByKey = new Map();
    for (const [shopId, reader] of readers) {
      const keys = selected.filter((key) => key.shop_id === shopId);
      if (!keys.length) continue;
      const productIds = keys.map((key) => key.canonical_product_id || key.product_id).filter(Boolean);
      const offerIds = keys.filter((key) => !(key.canonical_product_id || key.product_id))
        .map((key) => key.canonical_offer_id || key.offer_id).filter(Boolean);
      for (const filter of [productIds.length ? { productIds } : null, offerIds.length ? { offerIds } : null].filter(Boolean)) {
        for (const row of reader.listProducts({ shopId, visibility: 'ALL', ...filter, pageSize: keys.length }).rows) {
          rowsByKey.set(`${shopId}:${row.id}`, row);
        }
      }
    }
    const rows = selected.map((key) => rowsByKey.get(`${key.shop_id}:${key.id}`));
    if (rows.some((row) => !row)) throw new Error('SHOP_PRODUCT_PAGE_CHANGED_RETRY');
    return { ok: true, domain: 'products', source: 'shop-federated', stale: false,
      rows, page, pageSize, offset, total, counts, sort, syncState: null, durationMs: Date.now() - started };
  } finally { sorter.close(); }
}
