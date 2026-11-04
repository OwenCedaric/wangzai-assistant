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
  const originalImageUrl = firstFilled(
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
  );
  return {
    previewImageUrl: firstFilled(
      input.previewImageUrl,
      input.preview_image_url,
      input.previewImage,
      input.preview_image,
      input.largePreviewImageUrl,
      input.large_preview_image_url,
      nested.previewImageUrl,
      nested.preview_image_url,
      nested.previewImage,
    ),
    originalImageUrl,
  };
}

function normalizeLink(item = {}, index = 0, context = {}) {
  const shopId = normalizeId(item.shopId ?? item.shop_id ?? context.shopId ?? context.shop_id);
  const orderKey = normalizeId(
    item.orderKey ?? item.order_key ?? context.orderKey ?? context.order_key ?? item.postingNumber ?? item.posting_number
  );
  if (!shopId) throw new Error('shopId is required for sales source link.');
  if (!orderKey) throw new Error('orderKey/postingNumber is required for sales source link.');
  const slotIndex = Math.max(0, Number(item.slotIndex ?? item.slot_index ?? index) || 0);
  const media = getSourceLinkMedia(item);
  return {
    id: `sales_source_${createStableHash({ shopId, orderKey, slotIndex }, { length: 32 })}`,
    shopId,
    orderKey,
    slotIndex,
    isPrimary: Boolean(item.isPrimary ?? item.is_primary ?? slotIndex === Number(context.primaryIndex ?? context.primary_index ?? 0)),
    platform: normalizeText(item.platform ?? item.sourcePlatform ?? item.source_platform),
    url: normalizeText(item.url ?? item.link ?? item.sourceUrl ?? item.source_url),
    sourceProductId: normalizeText(item.sourceProductId ?? item.source_product_id ?? item.productId ?? item.product_id),
    title: normalizeText(item.title ?? item.name),
    imageUrl: normalizeText(item.imageUrl ?? item.image_url ?? item.image),
    previewImageUrl: media.previewImageUrl,
    originalImageUrl: media.originalImageUrl,
    priceValue: toNumberOrNull(item.priceValue ?? item.price_value ?? item.price ?? item.amount),
    currencyCode: normalizeText(item.currencyCode ?? item.currency_code ?? item.currency ?? 'CNY'),
    qty: normalizeText(item.qty ?? item.quantity ?? item.count),
  };
}

function toPublicLink(row = {}) {
  return {
    id: row.id,
    shopId: row.shop_id || '',
    shop_id: row.shop_id || '',
    orderKey: row.order_key || '',
    order_key: row.order_key || '',
    slotIndex: Number(row.slot_index) || 0,
    slot_index: Number(row.slot_index) || 0,
    isPrimary: Boolean(row.is_primary),
    is_primary: Boolean(row.is_primary),
    platform: row.platform || '',
    link: row.url || '',
    url: row.url || '',
    sourceProductId: row.source_product_id || '',
    source_product_id: row.source_product_id || '',
    productId: row.source_product_id || '',
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
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function normalizePageSize(value, fallback = 100) {
  return Math.min(Math.max(Number(value) || fallback, 1), 1000);
}

function normalizeLegacyCursorText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function encodeSalesSourceLinkCursor(row = {}) {
  return Buffer.from(JSON.stringify({
    shopId: normalizeText(row.shop_id),
    orderKey: normalizeText(row.order_key),
    slotIndex: Number(row.slot_index) || 0,
  }), 'utf8').toString('base64url');
}

function decodeSalesSourceLinkCursor(value) {
  const text = normalizeLegacyCursorText(value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    const shopId = normalizeId(parsed?.shopId);
    const orderKey = normalizeId(parsed?.orderKey);
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
    throw new Error('SALES_SOURCE_LEGACY_SLOT_INVALID');
  }
  return slotIndex;
}

function isScopedShopId(value) {
  const shopId = normalizeId(value);
  return shopId && !['all', 'default', '*'].includes(shopId.toLowerCase()) ? shopId : '';
}

export function createSalesSourceLinkRepository(db) {
  function repairSalesSourceLinkMedia() {
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('sales_source_links')")
      .all()
      .map((column) => column.name);
    if (!columns.includes('preview_image_url') || !columns.includes('original_image_url')) return;
    const rows = db
      .prepare(
        "SELECT id, raw_json FROM sales_source_links WHERE raw_json IS NOT NULL",
      )
      .all();
    if (!rows.length) return;
    const update = db.prepare(
      `UPDATE sales_source_links
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

  repairSalesSourceLinkMedia();

  function prepareLegacySalesSourceLinkGroup(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('SALES_SOURCE_LEGACY_RECORD_INVALID');
    }
    const shopId = isScopedShopId(input.shopId ?? input.shop_id);
    const orderKey = normalizeId(input.orderKey ?? input.order_key ?? input.postingNumber ?? input.posting_number);
    if (!shopId) throw new Error('SALES_SOURCE_LEGACY_SHOP_SCOPE_REQUIRED');
    if (!orderKey) throw new Error('SALES_SOURCE_LEGACY_ORDER_KEY_REQUIRED');
    const record = input.record && typeof input.record === 'object' && !Array.isArray(input.record)
      ? input.record
      : input;
    const rawLinks = Array.isArray(input.links)
      ? input.links
      : Array.isArray(record.links)
        ? record.links
        : null;
    if (!rawLinks?.length) throw new Error('SALES_SOURCE_LEGACY_LINKS_REQUIRED');
    const slots = new Set();
    const explicitPrimarySlots = [];
    const slotsByPosition = rawLinks.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('SALES_SOURCE_LEGACY_LINK_INVALID');
      }
      const entryShopId = normalizeText(entry.shopId ?? entry.shop_id);
      const entryOrderKey = normalizeId(entry.orderKey ?? entry.order_key ?? entry.postingNumber ?? entry.posting_number);
      if (entryShopId && entryShopId !== shopId) {
        throw new Error('SALES_SOURCE_LEGACY_SCOPE_MISMATCH');
      }
      if (entryOrderKey && entryOrderKey !== orderKey) {
        throw new Error('SALES_SOURCE_LEGACY_SCOPE_MISMATCH');
      }
      const slotIndex = normalizeLegacySourceSlot(entry.slotIndex ?? entry.slot_index, index);
      if (slots.has(slotIndex)) throw new Error('SALES_SOURCE_LEGACY_SLOT_DUPLICATE');
      slots.add(slotIndex);
      if (entry.isPrimary === true || entry.is_primary === true) explicitPrimarySlots.push(slotIndex);
      return slotIndex;
    });
    if (explicitPrimarySlots.length > 1) throw new Error('SALES_SOURCE_LEGACY_PRIMARY_DUPLICATE');
    const requestedPrimaryIndex = Number(
      record.primaryIndex ?? record.primary_index ?? input.primaryIndex ?? input.primary_index ?? 0,
    );
    if (!Number.isSafeInteger(requestedPrimaryIndex) || requestedPrimaryIndex < 0) {
      throw new Error('SALES_SOURCE_LEGACY_PRIMARY_INVALID');
    }
    const primarySlot = explicitPrimarySlots[0] ?? slotsByPosition[requestedPrimaryIndex];
    if (primarySlot === undefined) throw new Error('SALES_SOURCE_LEGACY_PRIMARY_INVALID');
    const links = rawLinks.map((entry, index) => {
      const slotIndex = slotsByPosition[index];
      const normalized = normalizeLink(
        { ...entry, shopId, orderKey, slotIndex },
        slotIndex,
        { ...input, shopId, orderKey, primaryIndex: primarySlot },
      );
      if (!normalized.url && !normalized.sourceProductId) {
        throw new Error('SALES_SOURCE_LEGACY_LINK_CONTENT_REQUIRED');
      }
      return normalized;
    });
    return { shopId, orderKey, links };
  }

  function importLegacyLinks(inputs = []) {
    if (!Array.isArray(inputs) || !inputs.length) {
      throw new Error('SALES_SOURCE_LEGACY_IMPORT_REQUIRED');
    }
    const groupKeys = new Set();
    const prepared = inputs.map((input) => {
      const group = prepareLegacySalesSourceLinkGroup(input);
      const groupKey = `${group.shopId}\u001f${group.orderKey}`;
      if (groupKeys.has(groupKey)) throw new Error('SALES_SOURCE_LEGACY_RECORD_DUPLICATE');
      groupKeys.add(groupKey);
      return group;
    });
    const timestamp = nowIso();
    const upsert = db.prepare(`
      INSERT INTO sales_source_links (
        id, shop_id, order_key, slot_index, is_primary, platform, url, source_product_id,
        title, image_url, preview_image_url, original_image_url, price_value, currency_code, qty, raw_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, order_key, slot_index) DO UPDATE SET
        is_primary = excluded.is_primary,
        platform = COALESCE(NULLIF(excluded.platform, ''), sales_source_links.platform),
        url = COALESCE(NULLIF(excluded.url, ''), sales_source_links.url),
        source_product_id = COALESCE(NULLIF(excluded.source_product_id, ''), sales_source_links.source_product_id),
        title = COALESCE(NULLIF(excluded.title, ''), sales_source_links.title),
        image_url = COALESCE(NULLIF(excluded.image_url, ''), sales_source_links.image_url),
        preview_image_url = COALESCE(NULLIF(excluded.preview_image_url, ''), sales_source_links.preview_image_url),
        original_image_url = COALESCE(NULLIF(excluded.original_image_url, ''), sales_source_links.original_image_url),
        price_value = COALESCE(excluded.price_value, sales_source_links.price_value),
        currency_code = COALESCE(NULLIF(excluded.currency_code, ''), sales_source_links.currency_code),
        qty = COALESCE(NULLIF(excluded.qty, ''), sales_source_links.qty),
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
          `DELETE FROM sales_source_links
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

  function listLinks(query = {}) {
    const cursorMode = normalizeText(query.cursorMode) === 'legacy-migration';
    const cursor = cursorMode ? decodeSalesSourceLinkCursor(query.cursor) : null;
    if (cursorMode && normalizeLegacyCursorText(query.cursor) && !cursor) {
      throw new Error('SALES_SOURCE_CURSOR_INVALID');
    }
    const pageSize = normalizePageSize(query.pageSize ?? query.limit, 100);
    const page = Math.max(Number(query.page) || 1, 1);
    const offset = Math.max(Number(query.offset) || (page - 1) * pageSize, 0);
    const shopId = normalizeText(query.shopId ?? query.shop_id);
    const orderKey = normalizeText(query.orderKey ?? query.order_key ?? query.postingNumber ?? query.posting_number);
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
    const baseClause = `WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) AS total FROM sales_source_links ${baseClause}`).get(...params).total;
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
      const candidates = db
        .prepare(
          `SELECT * FROM sales_source_links ${clause}
           ORDER BY shop_id ASC, order_key ASC, slot_index ASC LIMIT ?`,
        )
        .all(...params, pageSize + 1);
      const hasMore = candidates.length > pageSize;
      const rows = candidates.slice(0, pageSize);
      const tail = rows.at(-1);
      return {
        ok: true,
        rows: rows.map(toPublicLink),
        total: Number(total) || 0,
        hasMore,
        nextCursor: hasMore && tail ? encodeSalesSourceLinkCursor(tail) : '',
      };
    }
    const rows = db
      .prepare(
        `SELECT * FROM sales_source_links ${clause}
         ORDER BY updated_at DESC, order_key ASC, slot_index ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset);
    return { ok: true, rows: rows.map(toPublicLink), total: Number(total) || 0, page, pageSize, offset };
  }

  function saveLinks(input = {}) {
    const links = Array.isArray(input.links) ? input.links : Array.isArray(input.items) ? input.items : [];
    const normalized = links.map((item, index) => normalizeLink(item, index, input));
    const shopId = normalizeId(input.shopId ?? input.shop_id ?? normalized[0]?.shopId);
    const orderKey = normalizeId(input.orderKey ?? input.order_key ?? normalized[0]?.orderKey);
    if (!shopId || !orderKey) throw new Error('shopId and orderKey are required for sales source links.');
    const timestamp = nowIso();
    db.exec('BEGIN;');
    try {
      normalized.forEach((link) => {
        db.prepare(`
          INSERT INTO sales_source_links (
            id, shop_id, order_key, slot_index, is_primary, platform, url, source_product_id,
            title, image_url, preview_image_url, original_image_url, price_value, currency_code, qty, raw_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(shop_id, order_key, slot_index) DO UPDATE SET
            is_primary = excluded.is_primary,
            platform = COALESCE(NULLIF(excluded.platform, ''), sales_source_links.platform),
            url = COALESCE(NULLIF(excluded.url, ''), sales_source_links.url),
            source_product_id = COALESCE(NULLIF(excluded.source_product_id, ''), sales_source_links.source_product_id),
            title = COALESCE(NULLIF(excluded.title, ''), sales_source_links.title),
            image_url = COALESCE(NULLIF(excluded.image_url, ''), sales_source_links.image_url),
            preview_image_url = COALESCE(NULLIF(excluded.preview_image_url, ''), sales_source_links.preview_image_url),
            original_image_url = COALESCE(NULLIF(excluded.original_image_url, ''), sales_source_links.original_image_url),
            price_value = COALESCE(excluded.price_value, sales_source_links.price_value),
            currency_code = COALESCE(NULLIF(excluded.currency_code, ''), sales_source_links.currency_code),
            qty = COALESCE(NULLIF(excluded.qty, ''), sales_source_links.qty),
            raw_json = excluded.raw_json,
            updated_at = excluded.updated_at
        `).run(
          link.id,
          link.shopId,
          link.orderKey,
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
      const retained = normalized.map((link) => link.slotIndex);
      const staleWhere = retained.length ? ` AND slot_index NOT IN (${retained.map(() => '?').join(',')})` : '';
      db.prepare(`DELETE FROM sales_source_links WHERE shop_id = ? AND order_key = ?${staleWhere}`).run(shopId, orderKey, ...retained);
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
    return { ok: true, changed: normalized.length, ...listLinks({ shopId, orderKey, pageSize: 1000 }) };
  }

  function deleteLinks(query = {}) {
    const shopId = normalizeId(query.shopId ?? query.shop_id);
    const orderKey = normalizeId(query.orderKey ?? query.order_key ?? query.postingNumber ?? query.posting_number);
    if (!shopId || !orderKey) throw new Error('shopId and orderKey are required for deleting sales source links.');
    const result = db.prepare('DELETE FROM sales_source_links WHERE shop_id = ? AND order_key = ?').run(shopId, orderKey);
    return { ok: true, deleted: result.changes || 0, orderKey };
  }

  return { listLinks, saveLinks, importLegacyLinks, deleteLinks };
}
