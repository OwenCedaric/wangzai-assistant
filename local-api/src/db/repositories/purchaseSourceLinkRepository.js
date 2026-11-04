import { createStableHash } from '../../utils/stableHash.js';

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeId(value) {
  const text = normalizeText(value);
  return text && !['0', '未返回', '????'].includes(text) ? text : '';
}

function firstFilled(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getSourceLinkMedia(input = {}) {
  const nested = input.raw && typeof input.raw === 'object' ? input.raw : {};
  return {
    previewImageUrl: normalizeText(firstFilled(
      input.previewImageUrl,
      input.preview_image_url,
      input.previewImage,
      input.preview_image,
      input.largePreviewImageUrl,
      input.large_preview_image_url,
      nested.previewImageUrl,
      nested.preview_image_url,
      nested.previewImage,
    )),
    originalImageUrl: normalizeText(firstFilled(
      input.originalImageUrl,
      input.original_image_url,
      input.originalImage,
      input.original_image,
      input.fullImageUrl,
      input.full_image_url,
      input.largeImageUrl,
      input.large_image_url,
      input.highResImageUrl,
      input.high_res_image_url,
      Array.isArray(input.originalImages) ? input.originalImages[0] : '',
      nested.originalImageUrl,
      nested.original_image_url,
      nested.originalImage,
      nested.fullImageUrl,
    )),
  };
}

function resolveOrderKey(input = {}) {
  return normalizeId(firstFilled(input.orderKey, input.order_key, input.postingNumber, input.posting_number, input.ozonOrderId, input.ozon_order_id, input.orderId, input.order_id));
}

function normalizeLink(item = {}, index = 0, context = {}) {
  const shopId = normalizeText(firstFilled(item.shopId, item.shop_id, context.shopId, context.shop_id));
  const orderKey = resolveOrderKey({ ...context, ...item });
  if (!orderKey) throw new Error('orderKey/postingNumber is required for purchase source link.');
  const productKey = normalizeId(firstFilled(item.productKey, item.product_key, item.offerId, item.offer_id, item.sku));
  const slotIndex = Math.max(0, Number(item.slotIndex ?? item.slot_index ?? index) || 0);
  const media = getSourceLinkMedia(item);
  return {
    id: `purchase_source_${createStableHash({ shopId, orderKey, slotIndex }, { length: 32 })}`,
    shopId,
    orderKey,
    productKey,
    offerId: normalizeId(firstFilled(item.offerId, item.offer_id)),
    sku: normalizeId(item.sku),
    slotIndex,
    isPrimary: Boolean(item.isPrimary ?? item.is_primary ?? slotIndex === Number(context.primaryIndex ?? context.primary_index ?? 0)),
    platform: normalizeText(firstFilled(item.platform, item.sourcePlatform, item.source_platform)),
    url: normalizeText(firstFilled(item.url, item.link, item.sourceUrl, item.source_url)),
    sourceProductId: normalizeText(firstFilled(item.sourceProductId, item.source_product_id, item.productId, item.product_id)),
    title: normalizeText(firstFilled(item.title, item.name)),
    imageUrl: normalizeText(firstFilled(item.imageUrl, item.image_url, item.image)),
    previewImageUrl: media.previewImageUrl,
    originalImageUrl: media.originalImageUrl,
    priceValue: toNumberOrNull(item.priceValue ?? item.price_value ?? item.price ?? item.amount),
    currencyCode: normalizeText(firstFilled(item.currencyCode, item.currency_code, item.currency, 'CNY')),
    qty: normalizeText(firstFilled(item.qty, item.quantity, item.count)),
  };
}

function toPublicLink(row = {}) {
  return {
    id: row.id,
    shopId: row.shop_id || '',
    orderKey: row.order_key || '',
    productKey: row.product_key || '',
    offerId: row.offer_id || '',
    offer_id: row.offer_id || '',
    sku: row.sku || '',
    slotIndex: Number(row.slot_index) || 0,
    slot_index: Number(row.slot_index) || 0,
    isPrimary: Boolean(row.is_primary),
    is_primary: Boolean(row.is_primary),
    platform: row.platform || '',
    url: row.url || '',
    sourceProductId: row.source_product_id || '',
    source_product_id: row.source_product_id || '',
    title: row.title || '',
    imageUrl: row.image_url || '',
    image_url: row.image_url || '',
    previewImageUrl: row.preview_image_url || '',
    preview_image_url: row.preview_image_url || '',
    originalImageUrl: row.original_image_url || '',
    original_image_url: row.original_image_url || '',
    priceValue: row.price_value,
    price_value: row.price_value,
    price: row.price_value,
    currencyCode: row.currency_code || '',
    currency_code: row.currency_code || '',
    qty: row.qty || '',
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

function normalizePageSize(value, fallback = 100) {
  return Math.min(Math.max(Number(value) || fallback, 1), 1000);
}

function normalizeLegacyCursorText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function encodePurchaseSourceLinkCursor(row = {}) {
  return Buffer.from(JSON.stringify({
    shopId: normalizeText(row.shop_id),
    orderKey: normalizeText(row.order_key),
    slotIndex: Number(row.slot_index) || 0,
  }), 'utf8').toString('base64url');
}

function decodePurchaseSourceLinkCursor(value) {
  const text = normalizeLegacyCursorText(value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    const shopId = normalizeText(parsed?.shopId);
    const orderKey = normalizeText(parsed?.orderKey);
    const slotIndex = Number(parsed?.slotIndex);
    return shopId && orderKey && Number.isSafeInteger(slotIndex) && slotIndex >= 0
      ? { shopId, orderKey, slotIndex }
      : null;
  } catch {
    return null;
  }
}

function normalizeLegacySourceSlot(value, fallback) {
  const slotIndex = Number(value ?? fallback);
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0) {
    throw new Error('PURCHASE_SOURCE_LEGACY_SLOT_INVALID');
  }
  return slotIndex;
}

function isScopedShopId(value) {
  const shopId = normalizeId(value);
  return shopId && !['all', 'default', '*'].includes(shopId.toLowerCase()) ? shopId : '';
}

export function createPurchaseSourceLinkRepository(db) {
  function repairPurchaseSourceLinkMedia() {
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('purchase_source_links')")
      .all()
      .map((column) => column.name);
    if (!columns.includes('preview_image_url') || !columns.includes('original_image_url')) return;
    const rows = db
      .prepare(
        "SELECT id, raw_json FROM purchase_source_links WHERE raw_json IS NOT NULL",
      )
      .all();
    if (!rows.length) return;
    const update = db.prepare(
      `UPDATE purchase_source_links
       SET preview_image_url = COALESCE(NULLIF(?, ''), preview_image_url),
           original_image_url = COALESCE(NULLIF(?, ''), original_image_url),
           raw_json = NULL
       WHERE id = ?`,
    );
    db.exec('BEGIN;');
    try {
      rows.forEach((row) => {
        const raw = parseJson(row.raw_json, {});
        const media = getSourceLinkMedia(raw);
        update.run(
          media.previewImageUrl || null,
          media.originalImageUrl || null,
          row.id,
        );
      });
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }

  repairPurchaseSourceLinkMedia();

  function prepareLegacyPurchaseSourceLinkGroup(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('PURCHASE_SOURCE_LEGACY_RECORD_INVALID');
    }
    const shopId = isScopedShopId(input.shopId ?? input.shop_id);
    const orderKey = resolveOrderKey(input);
    if (!shopId) throw new Error('PURCHASE_SOURCE_LEGACY_SHOP_SCOPE_REQUIRED');
    if (!orderKey) throw new Error('PURCHASE_SOURCE_LEGACY_ORDER_KEY_REQUIRED');
    const record = input.record && typeof input.record === 'object' && !Array.isArray(input.record)
      ? input.record
      : input;
    const rawLinks = Array.isArray(input.links)
      ? input.links
      : Array.isArray(record.links)
        ? record.links
        : null;
    if (!rawLinks?.length) throw new Error('PURCHASE_SOURCE_LEGACY_LINKS_REQUIRED');

    const slots = new Set();
    const explicitPrimarySlots = [];
    const slotsByPosition = rawLinks.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('PURCHASE_SOURCE_LEGACY_LINK_INVALID');
      }
      const entryShopId = normalizeText(entry.shopId ?? entry.shop_id);
      const entryOrderKey = resolveOrderKey(entry);
      if (entryShopId && entryShopId !== shopId) {
        throw new Error('PURCHASE_SOURCE_LEGACY_SCOPE_MISMATCH');
      }
      if (entryOrderKey && entryOrderKey !== orderKey) {
        throw new Error('PURCHASE_SOURCE_LEGACY_SCOPE_MISMATCH');
      }
      const slotIndex = normalizeLegacySourceSlot(entry.slotIndex ?? entry.slot_index, index);
      if (slots.has(slotIndex)) throw new Error('PURCHASE_SOURCE_LEGACY_SLOT_DUPLICATE');
      slots.add(slotIndex);
      if (entry.isPrimary === true || entry.is_primary === true) explicitPrimarySlots.push(slotIndex);
      return slotIndex;
    });
    if (explicitPrimarySlots.length > 1) throw new Error('PURCHASE_SOURCE_LEGACY_PRIMARY_DUPLICATE');
    const requestedPrimaryIndex = Number(
      record.primaryIndex ?? record.primary_index ?? input.primaryIndex ?? input.primary_index ?? 0,
    );
    if (!Number.isSafeInteger(requestedPrimaryIndex) || requestedPrimaryIndex < 0) {
      throw new Error('PURCHASE_SOURCE_LEGACY_PRIMARY_INVALID');
    }
    const primarySlot = explicitPrimarySlots[0] ?? slotsByPosition[requestedPrimaryIndex];
    if (primarySlot === undefined) throw new Error('PURCHASE_SOURCE_LEGACY_PRIMARY_INVALID');
    const links = rawLinks.map((entry, index) => {
      const slotIndex = slotsByPosition[index];
      const normalized = normalizeLink(
        { ...entry, slotIndex },
        slotIndex,
        { ...input, shopId, orderKey, primaryIndex: primarySlot },
      );
      if (!normalized.url && !normalized.sourceProductId) {
        throw new Error('PURCHASE_SOURCE_LEGACY_LINK_CONTENT_REQUIRED');
      }
      return normalized;
    });
    return { shopId, orderKey, links };
  }

  function importLegacyLinks(inputs = []) {
    if (!Array.isArray(inputs) || !inputs.length) {
      throw new Error('PURCHASE_SOURCE_LEGACY_IMPORT_REQUIRED');
    }
    const groupKeys = new Set();
    const prepared = inputs.map((input) => {
      const group = prepareLegacyPurchaseSourceLinkGroup(input);
      const groupKey = `${group.shopId}\u001f${group.orderKey}`;
      if (groupKeys.has(groupKey)) throw new Error('PURCHASE_SOURCE_LEGACY_RECORD_DUPLICATE');
      groupKeys.add(groupKey);
      return group;
    });
    const timestamp = nowIso();
    const upsert = db.prepare(`
      INSERT INTO purchase_source_links (
        id, shop_id, order_key, product_key, offer_id, sku, slot_index, is_primary,
        platform, url, source_product_id, title, image_url, preview_image_url, original_image_url, price_value, currency_code,
        qty, raw_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, order_key, slot_index) DO UPDATE SET
        product_key = COALESCE(excluded.product_key, purchase_source_links.product_key),
        offer_id = COALESCE(excluded.offer_id, purchase_source_links.offer_id),
        sku = COALESCE(excluded.sku, purchase_source_links.sku),
        is_primary = excluded.is_primary,
        platform = COALESCE(NULLIF(excluded.platform, ''), purchase_source_links.platform),
        url = COALESCE(NULLIF(excluded.url, ''), purchase_source_links.url),
        source_product_id = COALESCE(NULLIF(excluded.source_product_id, ''), purchase_source_links.source_product_id),
        title = COALESCE(NULLIF(excluded.title, ''), purchase_source_links.title),
        image_url = COALESCE(NULLIF(excluded.image_url, ''), purchase_source_links.image_url),
        preview_image_url = COALESCE(NULLIF(excluded.preview_image_url, ''), purchase_source_links.preview_image_url),
        original_image_url = COALESCE(NULLIF(excluded.original_image_url, ''), purchase_source_links.original_image_url),
        price_value = COALESCE(excluded.price_value, purchase_source_links.price_value),
        currency_code = COALESCE(NULLIF(excluded.currency_code, ''), purchase_source_links.currency_code),
        qty = COALESCE(NULLIF(excluded.qty, ''), purchase_source_links.qty),
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      prepared.forEach(({ shopId, orderKey, links }) => {
        links.forEach((link) => {
          upsert.run(
            link.id,
            shopId,
            orderKey,
            link.productKey || null,
            link.offerId || null,
            link.sku || null,
            link.slotIndex,
            link.isPrimary ? 1 : 0,
            link.platform || null,
            link.url || null,
            link.sourceProductId || null,
            link.title || null,
            link.imageUrl || null,
            link.previewImageUrl || null,
            link.originalImageUrl || null,
            link.priceValue,
            link.currencyCode || null,
            link.qty || null,
            null,
            timestamp,
            timestamp,
          );
        });
        const retainedSlots = links.map((link) => link.slotIndex);
        db.prepare(
          `DELETE FROM purchase_source_links
           WHERE shop_id = ? AND order_key = ?
             AND slot_index NOT IN (${retainedSlots.map(() => '?').join(',')})`,
        ).run(shopId, orderKey, ...retainedSlots);
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return {
      ok: true,
      importedCount: prepared.length,
      scopeCount: new Set(prepared.map((group) => group.shopId)).size,
      digest: createStableHash(prepared.map((group) => ({
        shopId: group.shopId,
        orderKey: group.orderKey,
        slots: group.links.map((link) => link.slotIndex).sort((left, right) => left - right),
      }))),
    };
  }

  function saveLinks(input = {}) {
    const links = Array.isArray(input.links) ? input.links : Array.isArray(input.items) ? input.items : Array.isArray(input) ? input : [];
    const timestamp = nowIso();
    const normalized = links.map((item, index) => normalizeLink(item, index, input));
    for (const link of normalized) {
      db.prepare(`
        INSERT INTO purchase_source_links (
          id, shop_id, order_key, product_key, offer_id, sku, slot_index, is_primary,
          platform, url, source_product_id, title, image_url, preview_image_url, original_image_url, price_value, currency_code,
          qty, raw_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(shop_id, order_key, slot_index) DO UPDATE SET
          product_key = COALESCE(excluded.product_key, purchase_source_links.product_key),
          offer_id = COALESCE(excluded.offer_id, purchase_source_links.offer_id),
          sku = COALESCE(excluded.sku, purchase_source_links.sku),
          is_primary = excluded.is_primary,
          platform = COALESCE(NULLIF(excluded.platform, ''), purchase_source_links.platform),
          url = COALESCE(NULLIF(excluded.url, ''), purchase_source_links.url),
          source_product_id = COALESCE(NULLIF(excluded.source_product_id, ''), purchase_source_links.source_product_id),
          title = COALESCE(NULLIF(excluded.title, ''), purchase_source_links.title),
          image_url = COALESCE(NULLIF(excluded.image_url, ''), purchase_source_links.image_url),
          preview_image_url = COALESCE(NULLIF(excluded.preview_image_url, ''), purchase_source_links.preview_image_url),
          original_image_url = COALESCE(NULLIF(excluded.original_image_url, ''), purchase_source_links.original_image_url),
          price_value = COALESCE(excluded.price_value, purchase_source_links.price_value),
          currency_code = COALESCE(NULLIF(excluded.currency_code, ''), purchase_source_links.currency_code),
          qty = COALESCE(NULLIF(excluded.qty, ''), purchase_source_links.qty),
          raw_json = excluded.raw_json,
          updated_at = excluded.updated_at
      `).run(
        link.id,
        link.shopId || '',
        link.orderKey,
        link.productKey || null,
        link.offerId || null,
        link.sku || null,
        link.slotIndex,
        link.isPrimary ? 1 : 0,
        link.platform || null,
        link.url || null,
        link.sourceProductId || null,
        link.title || null,
        link.imageUrl || null,
        link.previewImageUrl || null,
        link.originalImageUrl || null,
        link.priceValue,
        link.currencyCode || null,
        link.qty || null,
        null,
        timestamp,
        timestamp,
      );
    }
    return { ok: true, changed: normalized.length, links: listLinks(input).rows };
  }

  function listLinks(query = {}) {
    const cursorMode = normalizeText(query.cursorMode) === 'legacy-migration';
    const cursor = cursorMode ? decodePurchaseSourceLinkCursor(query.cursor) : null;
    if (cursorMode && normalizeLegacyCursorText(query.cursor) && !cursor) {
      throw new Error('PURCHASE_SOURCE_CURSOR_INVALID');
    }
    const pageSize = normalizePageSize(query.pageSize ?? query.limit, 100);
    const page = Math.max(Number(query.page) || 1, 1);
    const offset = Math.max(Number(query.offset) || (page - 1) * pageSize, 0);
    const shopId = normalizeText(query.shopId ?? query.shop_id);
    const orderKey = resolveOrderKey(query);
    const keyword = normalizeText(query.keyword ?? query.q);
    const where = ['1 = 1'];
    const params = [];
    if (shopId && !['all', '*'].includes(shopId.toLowerCase())) {
      where.push('shop_id = ?');
      params.push(shopId);
    }
    if (orderKey) {
      where.push('order_key = ?');
      params.push(orderKey);
    }
    if (keyword) {
      where.push('(order_key LIKE ? OR offer_id LIKE ? OR sku LIKE ? OR platform LIKE ? OR title LIKE ? OR url LIKE ?)');
      const like = `%${keyword}%`;
      params.push(like, like, like, like, like, like);
    }
    const baseClause = `WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) AS total FROM purchase_source_links ${baseClause}`).get(...params).total;
    if (cursor) {
      where.push('(shop_id > ? OR (shop_id = ? AND order_key > ?) OR (shop_id = ? AND order_key = ? AND slot_index > ?))');
      params.push(
        cursor.shopId,
        cursor.shopId,
        cursor.orderKey,
        cursor.shopId,
        cursor.orderKey,
        cursor.slotIndex,
      );
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    if (cursorMode) {
      const candidates = db.prepare(`
        SELECT * FROM purchase_source_links
        ${clause}
        ORDER BY shop_id ASC, order_key ASC, slot_index ASC
        LIMIT ?
      `).all(...params, pageSize + 1);
      const hasMore = candidates.length > pageSize;
      const rows = candidates.slice(0, pageSize);
      const tail = rows.at(-1);
      return {
        ok: true,
        rows: rows.map(toPublicLink),
        total: Number(total) || 0,
        hasMore,
        nextCursor: hasMore && tail ? encodePurchaseSourceLinkCursor(tail) : '',
      };
    }
    const rows = db.prepare(`
      SELECT * FROM purchase_source_links
      ${clause}
      ORDER BY updated_at DESC, order_key ASC, slot_index ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    return { ok: true, rows: rows.map(toPublicLink), total: Number(total) || 0, page, pageSize, offset };
  }

  function deleteLinks(query = {}) {
    const shopId = normalizeText(query.shopId ?? query.shop_id);
    const orderKey = resolveOrderKey(query);
    if (!orderKey) throw new Error('orderKey/postingNumber is required for deleting purchase source links.');
    const result = db.prepare('DELETE FROM purchase_source_links WHERE shop_id = COALESCE(?, \'\') AND order_key = ?').run(shopId || '', orderKey);
    return { ok: true, deleted: result.changes || 0, orderKey };
  }

  return { saveLinks, importLegacyLinks, listLinks, deleteLinks };
}
