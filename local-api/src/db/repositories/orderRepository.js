import { createStableHash } from '../../utils/stableHash.js';

import {
  buildSalesOrderStatusScopeClause,
  buildSalesOrderStatusSummaryColumns,
  createSalesOrderStatusCountsFromSummaryRow,
  normalizeSalesOrderStatusScope,
} from '../../domain/orders/ordersQueryRules.js';
import {
  ORDER_MERGE_RAW_SQL,
  PRINT_SHIPPING_CARRIAGE_EXPRESSION,
  PRINT_SHIPPING_DEADLINE_EXPRESSION,
  PRINT_SHIPPING_DELIVERY_METHOD_EXPRESSION,
  PRINT_SHIPPING_TRACKING_EXPRESSION,
  PRINT_SHIPPING_WAREHOUSE_EXPRESSION,
  annotateOrdersWithSplitRelations,
  applyCachedProductImages,
  chunkRows,
  chunkValues,
  compactJson,
  getOrderProductIdentity,
  hasOwnField,
  normalizeId,
  normalizeNullableBoolean,
  normalizeOrder,
  normalizePageSize,
  normalizePostingList,
  normalizePostingNumber,
  normalizeQuantity,
  normalizeQuantityRows,
  normalizeText,
  nowIso,
  orderProductHasImage,
  parseJson,
  queryFlagEnabled,
  splitIds,
  toOrderMergeKey,
  toPublicHistoricalOrderFact,
  toPublicOrder,
  toPublicSplitRelation,
} from "./orderRowNormalization.js";

export function createOrderRepository(db, options = {}) {
  const shopOrderStorage = options.shopOrderStorage || null;
  const directShopOrderWrites = options.directShopOrderWrites === true;
  const resolveOrderReadDatabase = typeof options.resolveOrderReadDatabase === 'function'
    ? options.resolveOrderReadDatabase
    : () => ({ db, source: 'canonical', shopId: '' });
  const onOrderReadDatabaseError = typeof options.onOrderReadDatabaseError === 'function'
    ? options.onOrderReadDatabaseError
    : () => undefined;
  const onShopOrderStorageError = typeof options.onShopOrderStorageError === 'function'
    ? options.onShopOrderStorageError
    : () => undefined;

  function enqueueShopOrderMirror(shopId, orderKeys) {
    if (!orderKeys.length) return;
    if (directShopOrderWrites && shopOrderStorage?.mirrorCanonicalRows) {
      try {
        shopOrderStorage.mirrorCanonicalRows({ shopId, orderKeys });
        return;
      } catch (error) {
        try { onShopOrderStorageError(error, { shopId, orderKeys: [...orderKeys], mode: 'direct' }); } catch { /* observer only */ }
      }
    }
    if (!shopOrderStorage?.enqueueCanonicalRows) return;
    try {
      shopOrderStorage.enqueueCanonicalRows({ shopId, orderKeys });
    } catch (error) {
      // Independent order storage remains a verified shadow until read cutover.
      // A mirror failure must not alter the established order business result.
      try { onShopOrderStorageError(error, { shopId, orderKeys: [...orderKeys] }); } catch { /* observer only */ }
    }
  }

  function withOrderReadDatabase(query, reader) {
    let selection;
    try {
      selection = resolveOrderReadDatabase(query) || null;
    } catch (error) {
      try { onOrderReadDatabaseError(error, { query, phase: 'resolve', shopId: '' }); } catch { /* observer only */ }
      return reader(db);
    }
    const readDb = selection?.db?.prepare ? selection.db : selection?.prepare ? selection : db;
    if (readDb === db) return reader(db);
    try {
      return reader(readDb);
    } catch (error) {
      try {
        onOrderReadDatabaseError(error, {
          query,
          phase: 'query',
          shopId: normalizeText(selection?.shopId),
        });
      } catch { /* observer only */ }
      return reader(db);
    }
  }

  function attachCachedProductImages(orders = []) {
    const groups = new Map();
    orders.forEach((order) => {
      const shopId = normalizeId(order.shopId || order.shop_id);
      if (!shopId) return;
      if (!groups.has(shopId)) {
        groups.set(shopId, { productIds: new Set(), offerIds: new Set(), skus: new Set() });
      }
      const group = groups.get(shopId);
      (Array.isArray(order.products) ? order.products : []).forEach((product) => {
        if (orderProductHasImage(product)) return;
        const identity = getOrderProductIdentity(product);
        if (identity.productId) group.productIds.add(identity.productId);
        if (identity.offerId) group.offerIds.add(identity.offerId);
        if (identity.sku) group.skus.add(identity.sku);
      });
    });
    if (!groups.size) return orders;

    const imageIndex = new Map();
    for (const [shopId, group] of groups.entries()) {
      for (const [column, values] of [
        ['product_id', [...group.productIds]],
        ['offer_id', [...group.offerIds]],
        ['sku', [...group.skus]],
      ]) {
        const unresolvedValues = values.filter((value) => !imageIndex.has(`${shopId}:${value}`));
        for (const chunk of chunkValues(unresolvedValues)) {
          if (!chunk.length) continue;
          const rows = db.prepare(`
            SELECT shop_id, product_id, offer_id, sku, primary_image_url, images_json
            FROM ozon_products
            WHERE shop_id = ? AND is_stale = 0
              AND ${column} IN (${chunk.map(() => '?').join(',')})
              AND (COALESCE(primary_image_url, '') <> '' OR COALESCE(images_json, '') NOT IN ('', '[]'))
            ORDER BY updated_at DESC, id DESC
          `).all(shopId, ...chunk);
          rows.forEach((row) => {
            [row.product_id, row.offer_id, row.sku].map(normalizeId).filter(Boolean).forEach((value) => {
              const key = `${shopId}:${value}`;
              if (!imageIndex.has(key)) imageIndex.set(key, row);
            });
          });
        }
      }
    }
    if (!imageIndex.size) return orders;

    return orders.map((order) => {
      const shopId = normalizeId(order.shopId || order.shop_id);
      const products = (Array.isArray(order.products) ? order.products : []).map((product) => {
        if (orderProductHasImage(product)) return product;
        const identity = getOrderProductIdentity(product);
        const cachedRow = [identity.productId, identity.offerId, identity.sku]
          .filter(Boolean)
          .map((value) => imageIndex.get(`${shopId}:${value}`))
          .find(Boolean);
        return applyCachedProductImages(product, cachedRow);
      });
      return { ...order, products };
    });
  }

  const historicalOrderFactsAvailable = Boolean(
    db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'historical_order_facts' LIMIT 1").get()?.found,
  );

  function attachHistoricalOrderFacts(orderRows = []) {
    if (!historicalOrderFactsAvailable || !orderRows.length) {
      return orderRows.map((row) => ({ ...row, historicalOrderImport: null }));
    }
    const identities = [...new Map(orderRows
      .filter((row) => normalizeText(row.shopId) && normalizePostingNumber(row))
      .map((row) => [`${row.shopId}\u001f${normalizePostingNumber(row)}`, {
        shopId: row.shopId,
        postingNumber: normalizePostingNumber(row),
      }])).values()];
    if (!identities.length) return orderRows.map((row) => ({ ...row, historicalOrderImport: null }));
    const postingNumbersByShopId = new Map();
    identities.forEach((identity) => {
      if (!postingNumbersByShopId.has(identity.shopId)) postingNumbersByShopId.set(identity.shopId, []);
      postingNumbersByShopId.get(identity.shopId).push(identity.postingNumber);
    });
    const facts = [];
    postingNumbersByShopId.forEach((postingNumbers, shopId) => {
      chunkRows(postingNumbers).forEach((batch) => {
        facts.push(...db.prepare(`
          SELECT * FROM historical_order_facts
          WHERE source_type = 'historical_order_import'
            AND shop_id = ?
            AND posting_number IN (${batch.map(() => '?').join(',')})
        `).all(shopId, ...batch));
      });
    });
    const byOrder = new Map(facts.map((row) => [
      `${row.shop_id}\u001f${row.posting_number}`,
      toPublicHistoricalOrderFact(row),
    ]));
    return orderRows.map((row) => ({
      ...row,
      historicalOrderImport: byOrder.get(`${row.shopId}\u001f${normalizePostingNumber(row)}`) || null,
    }));
  }

  function upsertOrders({ shopId, rows = [], source = 'FBS' } = {}) {
    const normalizedShopId = normalizeId(shopId);
    if (!normalizedShopId) throw new Error('shopId is required for order merge.');
    const timestamp = nowIso();
    const selectExisting = db.prepare('SELECT remote_hash FROM ozon_orders WHERE shop_id = ? AND order_key = ?');
    const insertOrUpdate = db.prepare(`
      INSERT INTO ozon_orders (
        id, shop_id, order_key, posting_number, order_id, source, status, substatus,
        fulfillment, in_process_at, shipment_date, delivering_date, cutoff_at, payment_at, amount_value,
        products_json, analytics_json, financial_json, raw_json, remote_hash,
        is_stale, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(shop_id, order_key) DO UPDATE SET
        posting_number = COALESCE(excluded.posting_number, ozon_orders.posting_number),
        order_id = COALESCE(excluded.order_id, ozon_orders.order_id),
        source = COALESCE(excluded.source, ozon_orders.source),
        status = COALESCE(excluded.status, ozon_orders.status),
        substatus = COALESCE(excluded.substatus, ozon_orders.substatus),
        fulfillment = COALESCE(excluded.fulfillment, ozon_orders.fulfillment),
        in_process_at = COALESCE(excluded.in_process_at, ozon_orders.in_process_at),
        shipment_date = COALESCE(excluded.shipment_date, ozon_orders.shipment_date),
        delivering_date = COALESCE(excluded.delivering_date, ozon_orders.delivering_date),
        cutoff_at = COALESCE(excluded.cutoff_at, ozon_orders.cutoff_at),
        payment_at = COALESCE(excluded.payment_at, ozon_orders.payment_at),
        amount_value = COALESCE(excluded.amount_value, ozon_orders.amount_value),
        products_json = COALESCE(excluded.products_json, ozon_orders.products_json),
        analytics_json = COALESCE(excluded.analytics_json, ozon_orders.analytics_json),
        financial_json = COALESCE(excluded.financial_json, ozon_orders.financial_json),
        raw_json = COALESCE(excluded.raw_json, ozon_orders.raw_json),
        remote_hash = excluded.remote_hash,
        is_stale = 0,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `);
    const touchUnchanged = db.prepare(`
      UPDATE ozon_orders SET last_seen_at = ?, is_stale = 0, updated_at = ?
      WHERE shop_id = ? AND order_key = ?
    `);
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let missing = 0;
    const orderKeysToMirror = new Set();
    const sourceRows = Array.isArray(rows) ? rows : [];
    for (const sourceRow of sourceRows) {
      const row = normalizeOrder(sourceRow, { shopId: normalizedShopId, source });
      if (!row?.orderKey) {
        missing += 1;
        continue;
      }
      orderKeysToMirror.add(row.orderKey);
      const existing = selectExisting.get(normalizedShopId, row.orderKey);
      if (existing?.remote_hash === row.remoteHash) {
        touchUnchanged.run(timestamp, timestamp, normalizedShopId, row.orderKey);
        unchanged += 1;
        continue;
      }
      insertOrUpdate.run(
        row.id,
        normalizedShopId,
        row.orderKey,
        row.postingNumber || null,
        row.orderId || null,
        row.source,
        row.status || null,
        row.substatus || null,
        row.fulfillment || null,
        row.inProcessAt || null,
        row.shipmentDate || null,
        row.deliveringDate || null,
        row.cutoffAt || null,
        row.paymentAt || null,
        row.amountValue,
        compactJson(row.products),
        compactJson(row.analytics),
        compactJson(row.financial),
        compactJson(row.raw),
        row.remoteHash,
        timestamp,
        timestamp,
        timestamp,
      );
      if (existing) updated += 1;
      else inserted += 1;
    }
    enqueueShopOrderMirror(normalizedShopId, [...orderKeysToMirror]);
    return {
      ok: true,
      inserted,
      updated,
      unchanged,
      missing,
      changed: inserted + updated,
      rows: sourceRows.length,
      updatedAt: timestamp,
    };
  }

  function pruneSimulatedTestSplitChildren(input = {}) {
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    const parentPostingNumber = normalizePostingNumber({
      posting_number: input.parentPostingNumber ?? input.parent_posting_number ?? input.posting_number ?? input.postingNumber,
    });
    if (!shopId || !parentPostingNumber || !/^TEST-SPLIT-/i.test(parentPostingNumber)) {
      return { ok: true, skipped: true, deleted: 0 };
    }
    const keepPostingNumbers = new Set(normalizePostingList(input.keepPostingNumbers ?? input.keep_posting_numbers));
    keepPostingNumbers.add(parentPostingNumber);
    const basePostingNumber = parentPostingNumber.replace(/-\d+$/u, '');
    const candidates = db.prepare(`
      SELECT order_key, posting_number, raw_json
      FROM ozon_orders
      WHERE shop_id = ?
        AND posting_number LIKE ?
        AND posting_number <> ?
    `).all(shopId, `${basePostingNumber}-%`, parentPostingNumber);
    const staleRows = candidates
      .filter((row) => {
        const postingNumber = normalizePostingNumber({ posting_number: row.posting_number });
        if (!postingNumber || keepPostingNumbers.has(postingNumber)) return false;
        const raw = parseJson(row.raw_json, {});
        return raw.splitSimulatedChild === true || raw.parent_posting_number === parentPostingNumber || raw.parentPostingNumber === parentPostingNumber;
      });
    const stalePostingNumbers = staleRows.map((row) => row.posting_number);
    if (!stalePostingNumbers.length) return { ok: true, deleted: 0 };
    const result = db.prepare(`
      DELETE FROM ozon_orders
      WHERE shop_id = ?
        AND posting_number IN (${stalePostingNumbers.map(() => '?').join(',')})
    `).run(shopId, ...stalePostingNumbers);
    enqueueShopOrderMirror(shopId, staleRows.map((row) => row.order_key));
    return { ok: true, deleted: result.changes || 0, postingNumbers: stalePostingNumbers };
  }

  function buildOrdersFilter(query = {}) {
    const shopId = normalizeText(query.shopId ?? query.shop_id);
    const shopIds = splitIds(query.shopIds ?? query.shop_ids);
    const postingNumbers = splitIds(query.postingNumbers ?? query.posting_number ?? query.postingNumber);
    const status = normalizeText(query.status);
    const statusScope = normalizeSalesOrderStatusScope(query.statusScope ?? query.salesStatus ?? query.displayStatus);
    const source = normalizeText(query.source ?? query.fulfillment).toUpperCase();
    const keyword = normalizeText(query.keyword ?? query.q);
    const since = normalizeText(query.since ?? query.from ?? query.dateFrom);
    const to = normalizeText(query.to ?? query.dateTo);
    const warehouse = normalizeText(query.warehouse);
    const deliveryMethod = normalizeText(query.deliveryMethod ?? query.delivery_method);
    const deadlineScope = normalizeText(query.deadlineScope ?? query.deadline_scope);
    const trackingState = normalizeText(query.trackingState ?? query.tracking_state);
    const carriageState = normalizeText(query.carriageState ?? query.carriage_state);
    const where = ['is_stale = 0'];
    const params = [];
    if (shopId && !['all', '*'].includes(shopId.toLowerCase())) {
      where.push('shop_id = ?');
      params.push(shopId);
    } else if (shopIds.length) {
      where.push(`shop_id IN (${shopIds.map(() => '?').join(',')})`);
      params.push(...shopIds);
    }
    if (postingNumbers.length) {
      where.push(`posting_number IN (${postingNumbers.map(() => '?').join(',')})`);
      params.push(...postingNumbers);
    }
    if (statusScope) {
      where.push(buildSalesOrderStatusScopeClause(statusScope));
    } else if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (source) {
      where.push('(source = ? OR fulfillment = ?)');
      params.push(source, source);
    }
    if (since) {
      where.push('(COALESCE(payment_at, in_process_at) IS NULL OR COALESCE(payment_at, in_process_at) >= ?)');
      params.push(since);
    }
    if (to) {
      where.push('(COALESCE(payment_at, in_process_at) IS NULL OR COALESCE(payment_at, in_process_at) <= ?)');
      params.push(to);
    }
    if (keyword) {
      where.push(`(
        posting_number LIKE ?
        OR order_id LIKE ?
        OR status LIKE ?
        OR substatus LIKE ?
        OR fulfillment LIKE ?
        OR products_json LIKE ?
        OR raw_json LIKE ?
        OR analytics_json LIKE ?
        OR financial_json LIKE ?
      )`);
      const like = `%${keyword}%`;
      params.push(like, like, like, like, like, like, like, like, like);
    }
    if (warehouse) {
      if (warehouse === '__missing__') {
        where.push(`${PRINT_SHIPPING_WAREHOUSE_EXPRESSION} = ''`);
      } else {
        where.push(`${PRINT_SHIPPING_WAREHOUSE_EXPRESSION} = ?`);
        params.push(warehouse);
      }
    }
    if (deliveryMethod) {
      if (deliveryMethod === '__missing__') {
        where.push(`${PRINT_SHIPPING_DELIVERY_METHOD_EXPRESSION} = ''`);
      } else {
        where.push(`${PRINT_SHIPPING_DELIVERY_METHOD_EXPRESSION} = ?`);
        params.push(deliveryMethod);
      }
    }
    if (deadlineScope === 'overdue') {
      where.push(`${PRINT_SHIPPING_DEADLINE_EXPRESSION} IS NOT NULL AND ${PRINT_SHIPPING_DEADLINE_EXPRESSION} < datetime('now')`);
    } else if (deadlineScope === 'within24h') {
      where.push(`${PRINT_SHIPPING_DEADLINE_EXPRESSION} >= datetime('now') AND ${PRINT_SHIPPING_DEADLINE_EXPRESSION} < datetime('now', '+24 hours')`);
    } else if (deadlineScope === 'later') {
      where.push(`${PRINT_SHIPPING_DEADLINE_EXPRESSION} >= datetime('now', '+24 hours')`);
    } else if (deadlineScope === 'missing') {
      where.push(`${PRINT_SHIPPING_DEADLINE_EXPRESSION} IS NULL`);
    }
    if (trackingState === 'available') {
      where.push(`${PRINT_SHIPPING_TRACKING_EXPRESSION} <> ''`);
    } else if (trackingState === 'missing') {
      where.push(`${PRINT_SHIPPING_TRACKING_EXPRESSION} = ''`);
    }
    if (carriageState === 'assigned') {
      where.push(`${PRINT_SHIPPING_CARRIAGE_EXPRESSION} <> ''`);
    } else if (carriageState === 'unassigned') {
      where.push(`${PRINT_SHIPPING_CARRIAGE_EXPRESSION} = ''`);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    return { clause, params };
  }

  function listOrders(query = {}) {
    const pageSize = normalizePageSize(query.pageSize ?? query.limit, 100);
    const page = Math.max(Number(query.page) || 1, 1);
    const offset = Math.max(Number(query.offset) || (page - 1) * pageSize, 0);
    const { clause, params } = buildOrdersFilter(query);
    const { totalRow, rows } = withOrderReadDatabase(query, (readDb) => ({
      totalRow: readDb.prepare(`SELECT COUNT(*) AS total FROM ozon_orders ${clause}`).get(...params),
      rows: readDb.prepare(`
        SELECT * FROM ozon_orders
        ${clause}
        ORDER BY COALESCE(payment_at, in_process_at, updated_at) DESC, posting_number ASC, order_id ASC, id ASC
        LIMIT ? OFFSET ?
      `).all(...params, pageSize, offset),
    }));
    return {
      ok: true, domain: 'orders', source: 'sqlite',
      rows: presentOrderRows(rows, query), page, pageSize, offset,
      total: Number(totalRow?.total) || 0, durationMs: 0,
    };
  }

  function presentOrderRows(rows, query) {
    if (normalizeText(query.projection) === 'keys') return rows.map((row) => ({
      shopId: row.shop_id, orderKey: row.order_key, postingNumber: row.posting_number, orderId: row.order_id,
    }));
    const publicRows = attachHistoricalOrderFacts(rows.map(toPublicOrder));
    const imageReadyRows = queryFlagEnabled(query.includeProductImages ?? query.include_product_images)
      ? attachCachedProductImages(publicRows)
      : publicRows;
    const relationRows = listSplitRelationRowsForOrders(imageReadyRows);
    const relatedRows = annotateOrdersWithSplitRelations(imageReadyRows, relationRows);
    const responseRows = normalizeText(query.projection) === 'profit'
      ? relatedRows.map(({ raw: _raw, ...row }) => row)
      : relatedRows;
    return responseRows;
  }

  // Internal repository capability, not a new HTTP projection or data source.
  function listOrderMergeKeys(query = {}, { includeTotal = true, prefixLength = 0 } = {}) {
    // Only the in-process multi-shop coordinator supplies prefixLength. Public
    // listOrders retains its 1000-row response cap. Selecting one compact
    // prefix avoids re-sorting the same SQLite table for every 1000-key chunk.
    const pageSize = Number.isSafeInteger(prefixLength) && prefixLength > 0
      ? prefixLength : normalizePageSize(query.pageSize ?? query.limit, 100);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const { clause, params } = buildOrdersFilter(query);
    const { rows, total } = withOrderReadDatabase(query, readDb => ({
      rows: readDb.prepare(`
        SELECT id, shop_id, order_key, posting_number, order_id, in_process_at,
               updated_at, remote_hash, ${normalizeText(query.projection) === 'keys' ? 'NULL' : ORDER_MERGE_RAW_SQL} AS raw_json
        FROM ozon_orders ${clause}
        ORDER BY COALESCE(payment_at, in_process_at, updated_at) DESC, posting_number ASC, order_id ASC, id ASC
        LIMIT ? OFFSET ?
      `).all(...params, pageSize, offset),
      total: includeTotal ? Number(readDb.prepare(`SELECT COUNT(*) AS total FROM ozon_orders ${clause}`).get(...params)?.total) || 0 : undefined,
    }));
    return { rows: rows.map(row => toOrderMergeKey(row, normalizeText(query.projection))), total };
  }

  function hydrateOrderMergeKeys(query = {}, references = []) {
    const shopId = normalizeText(query.shopId ?? query.shop_id);
    const ids = references.map(reference => reference.localId);
    if (!shopId || references.length > 1000 || new Set(ids).size !== ids.length
      || references.some(reference => reference.shopId !== shopId || !normalizeText(reference.localId))) {
      throw Object.assign(new Error('ORDER_PAGE_IDENTITY_INVALID'), { code: 'ORDER_PAGE_IDENTITY_INVALID', statusCode: 400 });
    }
    const { clause, params } = buildOrdersFilter(query);
    const rows = withOrderReadDatabase(query, readDb => chunkValues(ids).flatMap(batch => readDb.prepare(`
      SELECT * FROM ozon_orders ${clause}
      AND id IN (${batch.map(() => '?').join(',')})
    `).all(...params, ...batch)));
    const byId = new Map(rows.map(row => [row.id, row]));
    const ordered = references.map(reference => {
      const row = byId.get(reference.localId);
      if (!row || row.shop_id !== reference.shopId || row.remote_hash !== reference.remoteHash || row.updated_at !== reference.updatedAt) {
        throw Object.assign(new Error('ORDER_PAGE_CHANGED_DURING_READ'), { code: 'ORDER_PAGE_CHANGED_DURING_READ', statusCode: 409 });
      }
      return row;
    });
    return presentOrderRows(ordered, query);
  }

  function summarizeOrders(query = {}) {
    const { clause, params } = buildOrdersFilter(query);
    const { rows, salesStatusSummary } = withOrderReadDatabase(query, (readDb) => ({
      rows: readDb.prepare(`
        SELECT
          COALESCE(status, '') AS status,
          COALESCE(fulfillment, source, '') AS fulfillment,
          SUM(COALESCE(amount_value, 0)) AS amount_total,
          COUNT(*) AS total
        FROM ozon_orders
        ${clause}
        GROUP BY COALESCE(status, ''), COALESCE(fulfillment, source, '')
        ORDER BY status ASC, fulfillment ASC
      `).all(...params),
      salesStatusSummary: readDb.prepare(`
        SELECT COUNT(*) AS total,
          ${buildSalesOrderStatusSummaryColumns()}
        FROM ozon_orders
        ${clause}
      `).get(...params),
    }));
    const statusCounts = {};
    const fulfillmentCounts = {};
    let total = 0;
    let amountTotal = 0;
    rows.forEach((row) => {
      const count = Number(row.total) || 0;
      total += count;
      const status = normalizeText(row.status) || 'unknown';
      const fulfillment = normalizeText(row.fulfillment) || 'unknown';
      statusCounts[status] = (statusCounts[status] || 0) + count;
      fulfillmentCounts[fulfillment] = (fulfillmentCounts[fulfillment] || 0) + count;
      amountTotal += Number(row.amount_total) || 0;
    });
    return {
      total,
      amountTotal,
      statusCounts,
      fulfillmentCounts,
      salesStatusCounts: createSalesOrderStatusCountsFromSummaryRow(salesStatusSummary),
    };
  }

  function listPrintShippingFacets(query = {}) {
    const facetQuery = {
      ...query,
      warehouse: '',
      deliveryMethod: '',
      delivery_method: '',
    };
    const { clause, params } = buildOrdersFilter(facetQuery);
    return withOrderReadDatabase(facetQuery, (readDb) => {
      const readValues = (expression) => readDb.prepare(`
        SELECT value, COUNT(*) AS total
        FROM (
          SELECT ${expression} AS value
          FROM ozon_orders
          ${clause}
        )
        WHERE value <> ''
        GROUP BY value
        ORDER BY total DESC, value ASC
        LIMIT 100
      `).all(...params).map((row) => ({ value: normalizeText(row.value), total: Number(row.total) || 0 }));
      return {
        warehouses: readValues(PRINT_SHIPPING_WAREHOUSE_EXPRESSION),
        deliveryMethods: readValues(PRINT_SHIPPING_DELIVERY_METHOD_EXPRESSION),
      };
    });
  }

  function listSplitRelationRowsForOrders(rows = []) {
    const shopIds = [...new Set(rows.map((row) => normalizeText(row.shopId || row.shop_id)).filter(Boolean))];
    if (!shopIds.length) return [];
    return db.prepare(`
      SELECT * FROM ozon_order_split_relations
      WHERE shop_id IN (${shopIds.map(() => '?').join(',')})
      ORDER BY updated_at DESC, parent_posting_number ASC
    `).all(...shopIds);
  }

  function upsertSplitRelation(input = {}) {
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    const parentPostingNumber = normalizePostingNumber({
      posting_number: input.parentPostingNumber ?? input.parent_posting_number ?? input.posting_number ?? input.postingNumber,
    });
    if (!shopId) throw new Error('shopId is required for order split relation.');
    if (!parentPostingNumber) throw new Error('parentPostingNumber is required for order split relation.');
    const timestamp = nowIso();
    const childPostingNumbers = normalizePostingList(input.childPostingNumbers ?? input.child_posting_numbers);
    const splitQuantities = normalizeQuantityRows(input.splitQuantities ?? input.split_quantities);
    const quantitySum =
      normalizeQuantity(input.quantitySum ?? input.quantity_sum) ||
      splitQuantities.reduce((sum, item) => sum + normalizeQuantity(item.quantity), 0);
    const childrenConfirmed = input.childrenConfirmed === true || input.children_confirmed === true || input.children_confirmed === 1;
    const readbackStatus = normalizeText(input.readbackStatus ?? input.readback_status) || (childrenConfirmed ? 'merged' : 'pending');
    const status =
      normalizeText(input.status) ||
      (readbackStatus === 'merged' ? 'readback_merged' : 'submitted_waiting_readback');
    const shouldReplaceParentOzonVisible =
      hasOwnField(input, 'parentOzonVisible') ||
      hasOwnField(input, 'parent_ozon_visible') ||
      input.forceParentOzonVisibleUpdate === true;
    const parentOzonVisible = normalizeNullableBoolean(input.parentOzonVisible ?? input.parent_ozon_visible);
    const readbackAt =
      normalizeText(input.readbackAt ?? input.readback_at) ||
      (readbackStatus && readbackStatus !== 'pending' ? timestamp : null);
    const id = `order_split_${createStableHash({ shopId, parentPostingNumber }, { length: 32 })}`;
    db.prepare(`
      INSERT INTO ozon_order_split_relations (
        id, shop_id, parent_posting_number, child_posting_numbers_json, split_quantities_json,
        status, readback_status, parent_ozon_visible, children_confirmed, child_count,
        quantity_sum, submitted_payload_json, ozon_response_json, parent_snapshot_json,
        child_snapshots_json, readback_rows_json, mismatch_reason, submitted_at,
        readback_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, parent_posting_number) DO UPDATE SET
        child_posting_numbers_json = COALESCE(excluded.child_posting_numbers_json, ozon_order_split_relations.child_posting_numbers_json),
        split_quantities_json = COALESCE(excluded.split_quantities_json, ozon_order_split_relations.split_quantities_json),
        status = COALESCE(excluded.status, ozon_order_split_relations.status),
        readback_status = COALESCE(excluded.readback_status, ozon_order_split_relations.readback_status),
        parent_ozon_visible = COALESCE(excluded.parent_ozon_visible, ozon_order_split_relations.parent_ozon_visible),
        children_confirmed = excluded.children_confirmed,
        child_count = excluded.child_count,
        quantity_sum = excluded.quantity_sum,
        submitted_payload_json = COALESCE(excluded.submitted_payload_json, ozon_order_split_relations.submitted_payload_json),
        ozon_response_json = COALESCE(excluded.ozon_response_json, ozon_order_split_relations.ozon_response_json),
        parent_snapshot_json = COALESCE(excluded.parent_snapshot_json, ozon_order_split_relations.parent_snapshot_json),
        child_snapshots_json = COALESCE(excluded.child_snapshots_json, ozon_order_split_relations.child_snapshots_json),
        readback_rows_json = COALESCE(excluded.readback_rows_json, ozon_order_split_relations.readback_rows_json),
        mismatch_reason = COALESCE(excluded.mismatch_reason, ozon_order_split_relations.mismatch_reason),
        submitted_at = COALESCE(excluded.submitted_at, ozon_order_split_relations.submitted_at),
        readback_at = COALESCE(excluded.readback_at, ozon_order_split_relations.readback_at),
        updated_at = excluded.updated_at
    `).run(
      id,
      shopId,
      parentPostingNumber,
      compactJson(childPostingNumbers),
      compactJson(splitQuantities),
      status,
      readbackStatus,
      parentOzonVisible,
      childrenConfirmed ? 1 : 0,
      childPostingNumbers.length || Number(input.childCount ?? input.child_count) || 0,
      quantitySum,
      compactJson(input.submittedPayload ?? input.submitted_payload),
      compactJson(input.ozonResponse ?? input.ozon_response),
      compactJson(input.parentSnapshot ?? input.parent_snapshot),
      compactJson(input.childSnapshots ?? input.child_snapshots),
      compactJson(input.readBackRows ?? input.readbackRows ?? input.readback_rows),
      normalizeText(input.mismatchReason ?? input.mismatch_reason) || null,
      normalizeText(input.submittedAt ?? input.submitted_at) || timestamp,
      readbackAt,
      timestamp,
      timestamp,
    );
    if (shouldReplaceParentOzonVisible) {
      db.prepare(`
        UPDATE ozon_order_split_relations
        SET parent_ozon_visible = ?, updated_at = ?
        WHERE shop_id = ? AND parent_posting_number = ?
      `).run(parentOzonVisible, timestamp, shopId, parentPostingNumber);
    }
    const row = db.prepare('SELECT * FROM ozon_order_split_relations WHERE shop_id = ? AND parent_posting_number = ?').get(shopId, parentPostingNumber);
    return { ok: true, relation: toPublicSplitRelation(row) };
  }

  function listSplitRelations(query = {}) {
    const shopId = normalizeText(query.shopId ?? query.shop_id);
    const parentPostingNumber = normalizePostingNumber({
      posting_number: query.parentPostingNumber ?? query.parent_posting_number ?? query.postingNumber ?? query.posting_number,
    });
    const where = [];
    const params = [];
    if (shopId && !['all', '*'].includes(shopId.toLowerCase())) {
      where.push('shop_id = ?');
      params.push(shopId);
    }
    if (parentPostingNumber) {
      where.push('parent_posting_number = ?');
      params.push(parentPostingNumber);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT * FROM ozon_order_split_relations
      ${clause}
      ORDER BY updated_at DESC, parent_posting_number ASC
    `).all(...params);
    return { ok: true, rows: rows.map(toPublicSplitRelation), total: rows.length };
  }

  function listOrdersByPostingNumbers(shopId, postingNumbers = []) {
    const normalizedShopId = normalizeId(shopId);
    const normalizedPostingNumbers = normalizePostingList(postingNumbers);
    if (!normalizedShopId || !normalizedPostingNumbers.length) return [];
    return db.prepare(`
      SELECT * FROM ozon_orders
      WHERE shop_id = ?
        AND is_stale = 0
        AND posting_number IN (${normalizedPostingNumbers.map(() => '?').join(',')})
      ORDER BY COALESCE(in_process_at, updated_at) DESC, posting_number ASC
    `).all(normalizedShopId, ...normalizedPostingNumbers);
  }

  function sumProductsQuantity(orderRows = []) {
    return orderRows
      .flatMap((row) => parseJson(row.products_json, []))
      .reduce((sum, product) => sum + normalizeQuantity(product?.quantity ?? product?.qty ?? product?.count), 0);
  }

  function reconcileSplitRelationsFromReadback(input = {}) {
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    if (!shopId) return { ok: false, error: { code: 'ORDER_SPLIT_RECONCILE_SHOP_ID_REQUIRED', message: 'shopId is required.' } };

    const currentReadbackPostings = new Set(normalizePostingList(input.rows ?? input.readBackRows ?? input.readbackRows));
    const explicitParents = new Set(normalizePostingList(input.parentPostingNumbers ?? input.parentPostingNumber));
    const parentVisibilityChecked = input.parentVisibilityChecked === true || input.visibilityAuthoritative === true;
    if (!currentReadbackPostings.size && !explicitParents.size) {
      return { ok: true, changed: 0, relations: [], skipped: true };
    }

    const relationRows = db.prepare(`
      SELECT * FROM ozon_order_split_relations
      WHERE shop_id = ?
      ORDER BY updated_at DESC, parent_posting_number ASC
    `).all(shopId);
    const touchedRelations = relationRows
      .map(toPublicSplitRelation)
      .filter((relation) => {
        if (explicitParents.has(relation.parentPostingNumber)) return true;
        if (currentReadbackPostings.has(relation.parentPostingNumber)) return true;
        return (relation.childPostingNumbers || []).some((child) => currentReadbackPostings.has(child));
      });

    const reconciled = [];
    for (const relation of touchedRelations) {
      const childPostingNumbers = normalizePostingList(relation.childPostingNumbers);
      if (!childPostingNumbers.length) {
        continue;
      }

      const childRows = listOrdersByPostingNumbers(shopId, childPostingNumbers);
      const parentRows = listOrdersByPostingNumbers(shopId, [relation.parentPostingNumber]);
      const childSnapshots = childRows.map(toPublicOrder);
      const confirmedChildren = childPostingNumbers.filter((child) =>
        childRows.some((row) => normalizePostingNumber({ posting_number: row.posting_number }) === child)
      );
      const childrenConfirmed = confirmedChildren.length === childPostingNumbers.length;
      const parentSeen = currentReadbackPostings.has(relation.parentPostingNumber);
      const parentOzonVisible = parentSeen ? true : parentVisibilityChecked ? false : null;
      const confirmedPostingNumbers = new Set(confirmedChildren);
      if ((parentSeen || relation.parentOzonVisible === true) && parentRows.length) {
        confirmedPostingNumbers.add(relation.parentPostingNumber);
      }
      const splitQuantityPostingNumbers = (relation.splitQuantities || []).map(normalizePostingNumber).filter(Boolean);
      const expectedPostingNumbers = splitQuantityPostingNumbers.length
        ? [...new Set(splitQuantityPostingNumbers)]
        : [];
      const allSubmittedRowsConfirmed = (relation.splitQuantities || []).length
        ? expectedPostingNumbers.length
          ? expectedPostingNumbers.every((postingNumber) => confirmedPostingNumbers.has(postingNumber))
          : confirmedPostingNumbers.size >= relation.splitQuantities.length
        : childrenConfirmed;
      const submittedQuantity =
        normalizeQuantity(relation.quantitySum) ||
        (relation.splitQuantities || []).reduce((sum, item) => sum + normalizeQuantity(item.quantity), 0);
      const quantityRows = expectedPostingNumbers.length
        ? [...parentRows, ...childRows].filter((row) => expectedPostingNumbers.includes(normalizePostingNumber({ posting_number: row.posting_number })))
        : [...parentRows, ...childRows].filter((row) => confirmedPostingNumbers.has(normalizePostingNumber({ posting_number: row.posting_number })));
      const readbackQuantity = sumProductsQuantity(quantityRows);
      const quantityMismatch =
        allSubmittedRowsConfirmed && submittedQuantity > 0 && readbackQuantity > 0 && submittedQuantity !== readbackQuantity;
      const readbackStatus = quantityMismatch ? 'mismatch' : allSubmittedRowsConfirmed ? 'merged' : 'partial';
      const status = quantityMismatch ? 'readback_mismatch' : allSubmittedRowsConfirmed ? 'readback_merged' : 'submitted_waiting_readback';
      const mismatchReason = quantityMismatch
        ? `拆单回读数量不一致：提交 ${submittedQuantity} 件，回读 ${readbackQuantity} 件。`
        : allSubmittedRowsConfirmed
          ? ''
          : '拆单后台回读尚未覆盖全部子单。';

      const saved = upsertSplitRelation({
        shopId,
        parentPostingNumber: relation.parentPostingNumber,
        childPostingNumbers,
        splitQuantities: relation.splitQuantities,
        status,
        readbackStatus,
        parentOzonVisible,
        forceParentOzonVisibleUpdate: true,
        childrenConfirmed,
        childSnapshots,
        readBackRows: childSnapshots,
        mismatchReason,
      });
      reconciled.push(saved.relation);
    }

    return { ok: true, changed: reconciled.length, relations: reconciled };
  }

  return {
    upsertOrders,
    listOrders,
    listOrderMergeKeys,
    hydrateOrderMergeKeys,
    listPrintShippingFacets,
    summarizeOrders,
    pruneSimulatedTestSplitChildren,
    upsertSplitRelation,
    listSplitRelations,
    reconcileSplitRelationsFromReadback,
  };
}
