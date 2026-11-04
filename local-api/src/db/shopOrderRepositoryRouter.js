import { createOrderRepository } from './repositories/orderRepository.js';

const DIRECT_WRITE_METHODS = Object.freeze([
  'pruneSimulatedTestSplitChildren',
  'reconcileSplitRelationsFromReadback',
  'upsertOrders',
  'upsertSplitRelation',
]);

// Shared by router instances so another facade cannot expose pending writes
// from a database whose savepoint cleanup failed.
const writeRecoveryRequiredDatabases = new WeakSet();

// Construct the locale/numeric comparator once, not during every pairwise
// comparison of a multi-shop page. This is the same ordering as localeCompare
// with these options, without rebuilding the collation configuration per row.
const orderTextCollator = new Intl.Collator(undefined, { numeric: true });

function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function parseIds(value) {
  const source = Array.isArray(value) ? value : normalizeText(value).split(',');
  return [...new Set(source.map(normalizeText).filter(Boolean))];
}

function resolveShopId(input = {}) {
  return normalizeText(input?.shopId ?? input?.shop_id);
}

function targetShopIds(query, listShopIds) {
  const direct = resolveShopId(query);
  if (direct && !['all', '*', 'all-shops'].includes(direct.toLowerCase())) return [direct];
  const requested = parseIds(query?.shopIds ?? query?.shop_ids)
    .filter((shopId) => !['all', '*', 'all-shops'].includes(shopId.toLowerCase()));
  return requested.length ? requested : parseIds(listShopIds());
}

function compareText(left, right) {
  return orderTextCollator.compare(normalizeText(left), normalizeText(right));
}

function orderTimestamp(row = {}) {
  return normalizeText(row.paymentAt ?? row.payment_at ?? row.inProcessAt ?? row.in_process_at ?? row.updatedAt ?? row.updated_at);
}

function compareOrders(left, right) {
  return compareText(orderTimestamp(right), orderTimestamp(left))
    || compareText(left.postingNumber ?? left.posting_number, right.postingNumber ?? right.posting_number)
    || compareText(left.orderId ?? left.order_id, right.orderId ?? right.order_id)
    || compareText(left.id, right.id)
    || compareText(left.shopId ?? left.shop_id, right.shopId ?? right.shop_id);
}

function mergeNumericMap(target, source = {}) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = (Number(target[key]) || 0) + (Number(value) || 0);
  }
}

export function createShopOrderRepositoryRouter({
  canonicalRepository,
  shopOrderStorage,
  listShopIds = () => [],
} = {}) {
  if (!canonicalRepository) throw new Error('SHOP_ORDER_REPOSITORY_CANONICAL_REQUIRED');
  if (!shopOrderStorage?.resolveDirectWriteSession) throw new Error('SHOP_ORDER_REPOSITORY_STORAGE_REQUIRED');
  const repositories = new WeakMap();
  const counters = { directWrites: 0, canonicalWrites: 0, failures: 0, lastShopId: '', lastMethod: '', lastErrorCode: '' };
  let transactionSequence = 0;

  function repositoryForSession(session) {
    let repository = repositories.get(session.db);
    if (!repository) {
      repository = createOrderRepository(session.db);
      repositories.set(session.db, repository);
    }
    return repository;
  }

  function directRepository(shopId) {
    const session = shopOrderStorage.resolveDirectWriteSession({ shopId });
    if (writeRecoveryRequiredDatabases.has(session.db)) {
      let transactionEnded = false;
      try { transactionEnded = session.db.isTransaction === false; } catch { /* recovery remains unconfirmed */ }
      if (!transactionEnded) {
        const error = new Error('SHOP_ORDER_WRITE_RECOVERY_REQUIRED');
        error.code = 'SHOP_ORDER_WRITE_RECOVERY_REQUIRED';
        throw error;
      }
      writeRecoveryRequiredDatabases.delete(session.db);
    }
    return { session, repository: repositoryForSession(session) };
  }

  function readRepository(shopId) {
    if (!shopOrderStorage.isDirectWriteShop(shopId)) return canonicalRepository;
    try {
      return directRepository(shopId).repository;
    } catch (error) {
      // Once writes are independent, the shared database is no longer current.
      // Expose the read failure so callers retain their last good data instead
      // of treating stale/empty shared rows as the latest business facts.
      counters.failures += 1;
      counters.lastShopId = shopId;
      counters.lastErrorCode = normalizeText(error?.code || error?.message) || 'SHOP_ORDER_DIRECT_READ_FAILED';
      throw error;
    }
  }

  function invokeWrite(method, args) {
    const shopId = resolveShopId(args[0]);
    counters.lastShopId = shopId;
    counters.lastMethod = method;
    if (!shopId && shopOrderStorage.snapshot?.().directWriteAllShops === true) {
      const error = new Error('SHOP_ORDER_DIRECT_WRITE_SHOP_ID_REQUIRED');
      error.code = 'SHOP_ORDER_DIRECT_WRITE_SHOP_ID_REQUIRED';
      throw error;
    }
    if (!shopOrderStorage.isDirectWriteShop(shopId)) {
      counters.canonicalWrites += 1;
      return canonicalRepository[method](...args);
    }
    try {
      const { session, repository } = directRepository(shopId);
      const savepoint = 'order_write_' + (++transactionSequence);
      // Keep the whole batch and its ownership receipt atomic, while leaving
      // any transaction opened by the caller in control of the final commit.
      session.db.exec('SAVEPOINT ' + savepoint);
      let result;
      try {
        result = repository[method](...args);
        shopOrderStorage.recordDirectWrite({ shopId, expectedScopeToken: session.route?.scopeToken });
        session.db.exec('RELEASE SAVEPOINT ' + savepoint);
      } catch (error) {
        try {
          session.db.exec('ROLLBACK TO SAVEPOINT ' + savepoint);
          session.db.exec('RELEASE SAVEPOINT ' + savepoint);
        } catch {
          // Do not release after a failed rollback or end a caller transaction.
          // Block reads and writes until its owner explicitly ends it instead.
          writeRecoveryRequiredDatabases.add(session.db);
        }
        throw error;
      }
      counters.directWrites += 1;
      counters.lastErrorCode = '';
      return result;
    } catch (error) {
      counters.failures += 1;
      counters.lastErrorCode = normalizeText(error?.code || error?.message) || 'SHOP_ORDER_DIRECT_WRITE_FAILED';
      throw error;
    }
  }

  function listOrders(query = {}) {
    const shops = targetShopIds(query, listShopIds);
    if (shops.length <= 1) {
      const shopId = shops[0] || resolveShopId(query);
      return readRepository(shopId).listOrders({ ...query, ...(shopId ? { shopId, shopIds: [] } : {}) });
    }
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? query.limit) || 100, 1), 1000);
    const page = Math.max(Number(query.page) || 1, 1);
    const offset = Math.max(Number(query.offset) || (page - 1) * pageSize, 0);
    const requiredPrefix = offset + pageSize;
    const rows = [];
    const selectedRepositories = new Map(shops.map(shopId => [shopId, readRepository(shopId)]));
    const useMergeKeys = [...selectedRepositories.values()].every(repository =>
      typeof repository.listOrderMergeKeys === 'function' && typeof repository.hydrateOrderMergeKeys === 'function');
    let total = 0;
    const startedAt = Date.now();
    for (const shopId of shops) {
      if (useMergeKeys) {
        const result = selectedRepositories.get(shopId).listOrderMergeKeys({
          ...query, shopId, shopIds: [], offset: 0,
        }, { prefixLength: requiredPrefix });
        total += Math.max(0, Number(result?.total) || 0);
        // No spread call: deep pages can legitimately select more keys than
        // the JS argument-count limit while still returning one small page.
        for (const row of result.rows) rows.push(row);
        continue;
      }
      let shopOffset = 0;
      let shopTotal = 0;
      do {
        const batchSize = Math.min(1000, Math.max(requiredPrefix - shopOffset, 1));
        const shopQuery = {
          ...query,
          shopId,
          shopIds: [],
          page: 1,
          pageSize: batchSize,
          offset: shopOffset,
        };
        const repository = selectedRepositories.get(shopId);
        const result = repository.listOrders(shopQuery);
        if (shopOffset === 0) {
          shopTotal = Math.max(0, Number(result?.total) || 0);
          total += shopTotal;
        }
        const batchRows = Array.isArray(result?.rows) ? result.rows : [];
        rows.push(...batchRows);
        shopOffset += batchRows.length;
        if (!batchRows.length || batchRows.length < batchSize) break;
      } while (shopOffset < Math.min(requiredPrefix, shopTotal));
    }
    rows.sort(useMergeKeys ? (left, right) => compareOrders(left.sortKey, right.sortKey) : compareOrders);
    const pageRows = rows.slice(offset, offset + pageSize);
    let responseRows = pageRows;
    if (useMergeKeys) {
      const hydrated = new Map();
      for (const shopId of shops) {
        const references = pageRows.filter(row => row.shopId === shopId);
        if (!references.length) continue;
        const repository = readRepository(shopId);
        if (repository !== selectedRepositories.get(shopId)) {
          throw Object.assign(new Error('ORDER_PAGE_SHOP_SCOPE_CHANGED'), { code: 'ORDER_PAGE_SHOP_SCOPE_CHANGED', statusCode: 409 });
        }
        const values = repository.hydrateOrderMergeKeys({ ...query, shopId, shopIds: [] }, references);
        references.forEach((reference, index) => hydrated.set(reference, values[index]));
      }
      responseRows = pageRows.map(reference => hydrated.get(reference));
    }
    return {
      ok: true,
      domain: 'orders',
      source: 'shop-federated',
      orderSortLocale: orderTextCollator.resolvedOptions().locale,
      rows: responseRows,
      page,
      pageSize,
      offset,
      total,
      durationMs: Date.now() - startedAt,
    };
  }

  function summarizeOrders(query = {}) {
    const summary = { total: 0, amountTotal: 0, statusCounts: {}, fulfillmentCounts: {}, salesStatusCounts: {} };
    for (const shopId of targetShopIds(query, listShopIds)) {
      const current = readRepository(shopId).summarizeOrders({ ...query, shopId, shopIds: [] });
      summary.total += Number(current?.total) || 0;
      summary.amountTotal += Number(current?.amountTotal) || 0;
      mergeNumericMap(summary.statusCounts, current?.statusCounts);
      mergeNumericMap(summary.fulfillmentCounts, current?.fulfillmentCounts);
      mergeNumericMap(summary.salesStatusCounts, current?.salesStatusCounts);
    }
    return summary;
  }

  function listPrintShippingFacets(query = {}) {
    const warehouses = new Map();
    const deliveryMethods = new Map();
    const merge = (target, values = []) => values.forEach((item) => {
      const value = normalizeText(item?.value);
      if (value) target.set(value, (target.get(value) || 0) + (Number(item?.total) || 0));
    });
    for (const shopId of targetShopIds(query, listShopIds)) {
      const current = readRepository(shopId).listPrintShippingFacets({ ...query, shopId, shopIds: [] });
      merge(warehouses, current?.warehouses);
      merge(deliveryMethods, current?.deliveryMethods);
    }
    const rows = (map) => [...map.entries()]
      .map(([value, total]) => ({ value, total }))
      .sort((left, right) => right.total - left.total || compareText(left.value, right.value))
      .slice(0, 100);
    return { warehouses: rows(warehouses), deliveryMethods: rows(deliveryMethods) };
  }

  function listSplitRelations(query = {}) {
    const rows = [];
    for (const shopId of targetShopIds(query, listShopIds)) {
      const current = readRepository(shopId).listSplitRelations({ ...query, shopId, shopIds: [] });
      rows.push(...(Array.isArray(current?.rows) ? current.rows : []));
    }
    rows.sort((left, right) => compareText(right.updatedAt, left.updatedAt)
      || compareText(left.parentPostingNumber, right.parentPostingNumber));
    return { ok: true, rows, total: rows.length, source: 'shop-federated' };
  }

  const routed = { ...canonicalRepository, listOrders, summarizeOrders, listPrintShippingFacets, listSplitRelations };
  // These are capabilities of one already-routed store, not public methods
  // that callers may accidentally inherit bound to the shared database.
  delete routed.listOrderMergeKeys;
  delete routed.hydrateOrderMergeKeys;
  for (const method of DIRECT_WRITE_METHODS) {
    if (typeof canonicalRepository[method] !== 'function') throw new Error(`SHOP_ORDER_REPOSITORY_METHOD_MISSING:${method}`);
    routed[method] = (...args) => invokeWrite(method, args);
  }
  routed.snapshotDirectWrites = () => Object.freeze({ ...counters });
  return Object.freeze(routed);
}

export const shopOrderRepositoryRouterInternals = Object.freeze({ DIRECT_WRITE_METHODS, compareOrders });
