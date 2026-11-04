import { createHash, randomUUID } from 'node:crypto';

const UNBOUND_SHOP_ID = 'shop-unbound';
const VALID_STORAGE_SCOPES = new Set(['temporary', 'permanent']);
const VALID_STATUSES = new Set(['pending', 'stored', 'published', 'failed', 'deleted']);

function text(value) {
  return value == null ? '' : String(value).trim();
}

function positiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function iso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Product image timestamp is invalid.');
  return date.toISOString();
}

function scopeFrom(input = {}, defaults = {}) {
  const tenantId = text(input.tenantId) || text(defaults.tenantId);
  const userId = text(input.userId) || text(defaults.userId);
  const shopId = text(input.shopId) || UNBOUND_SHOP_ID;
  if (!tenantId || !userId) throw new Error('Product image owner scope is required.');
  return { tenantId, userId, shopId };
}

function normalizeStorageScope(value) {
  const result = text(value) || 'temporary';
  if (!VALID_STORAGE_SCOPES.has(result)) throw new Error('Product image storage scope is invalid.');
  return result;
}

function normalizeVariant(value) {
  return text(value).replace(/[^a-zA-Z0-9_-]+/gu, '-').slice(0, 80) || 'original';
}

function assetIdFor(input, scope) {
  const stable = [
    scope.tenantId,
    scope.userId,
    scope.shopId,
    text(input.sha256),
    normalizeStorageScope(input.storageScope),
    normalizeVariant(input.variant),
  ].join('\n');
  return `pimg_${createHash('sha256').update(stable).digest('hex')}`;
}

function publicRow(row = {}) {
  if (!row?.id) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    shopId: row.shop_id,
    profileAssetId: row.profile_asset_id || '',
    sha256: row.sha256,
    mimeType: row.mime_type,
    byteLength: Number(row.byte_length || 0),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    storageScope: row.storage_scope,
    variant: row.variant,
    sourceType: row.source_type,
    sourceUrl: row.source_url || '',
    objectKey: row.object_key || '',
    objectEtag: row.object_etag || '',
    objectRequestId: row.object_request_id || '',
    status: row.status,
    productId: row.product_id || '',
    offerId: row.offer_id || '',
    referenceCount: Number(row.reference_count || 0),
    uploadAttempts: Number(row.upload_attempts || 0),
    expiresAt: row.expires_at || null,
    publishedAt: row.published_at || null,
    deletedAt: row.deleted_at || null,
    lastError: row.last_error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function objectKeyFromSignedUrl(value) {
  try {
    const url = new URL(text(value));
    return decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    return '';
  }
}

export function createProductImageAssetRepository(db, options = {}) {
  const defaults = { tenantId: text(options.tenantId), userId: text(options.userId) };
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const selectSql = `
    SELECT id, tenant_id, user_id, shop_id, profile_asset_id, sha256, mime_type,
           byte_length, width, height, storage_scope, variant, source_type, source_url,
           object_key, object_etag, object_request_id, status, product_id, offer_id,
           reference_count, upload_attempts, expires_at, published_at, deleted_at,
           last_error, created_at, updated_at
    FROM product_image_assets
  `;

  function assertScope(row, input = {}) {
    const scope = scopeFrom(input, defaults);
    if (!row || row.tenant_id !== scope.tenantId || row.user_id !== scope.userId || row.shop_id !== scope.shopId) {
      const error = new Error('当前用户无权访问该图片资产。');
      error.code = 'PRODUCT_IMAGE_SCOPE_FORBIDDEN';
      throw error;
    }
    return scope;
  }

  function getAsset(id, scopeInput = {}) {
    const row = db.prepare(`${selectSql} WHERE id = ?`).get(text(id));
    if (!row) return null;
    assertScope(row, scopeInput);
    return publicRow(row);
  }

  function findByProfileAssetId(profileAssetId, scopeInput = {}) {
    const scope = scopeFrom(scopeInput, defaults);
    const row = db.prepare(`
      ${selectSql}
      WHERE profile_asset_id = ? AND tenant_id = ? AND user_id = ? AND shop_id = ?
        AND status <> 'deleted' AND reference_count > 0
      ORDER BY CASE storage_scope WHEN 'permanent' THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1
    `).get(text(profileAssetId), scope.tenantId, scope.userId, scope.shopId);
    return publicRow(row);
  }

  function upsertPending(input = {}, scopeInput = {}) {
    const scope = scopeFrom(scopeInput, defaults);
    const storageScope = normalizeStorageScope(input.storageScope);
    const variant = normalizeVariant(input.variant);
    const timestamp = iso(now());
    const id = assetIdFor({ ...input, storageScope, variant }, scope);
    const existing = db.prepare(`${selectSql} WHERE id = ?`).get(id);
    if (existing && existing.status !== 'failed' && existing.status !== 'deleted') {
      db.prepare(`
        UPDATE product_image_assets
        SET reference_count = CASE WHEN reference_count = 0 THEN 1 ELSE reference_count END,
            source_type = ?, source_url = ?, product_id = COALESCE(?, product_id),
            offer_id = COALESCE(?, offer_id), expires_at = ?, deleted_at = NULL,
            last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(
        text(input.sourceType) || existing.source_type,
        text(input.sourceUrl) || existing.source_url || null,
        text(input.productId) || null,
        text(input.offerId) || null,
        input.expiresAt ? iso(input.expiresAt) : null,
        timestamp,
        id,
      );
      return { ok: true, created: false, asset: publicRow(db.prepare(`${selectSql} WHERE id = ?`).get(id)) };
    }
    db.prepare(`
      INSERT INTO product_image_assets (
        id, tenant_id, user_id, shop_id, profile_asset_id, sha256, mime_type,
        byte_length, width, height, storage_scope, variant, source_type, source_url,
        status, product_id, offer_id, reference_count, upload_attempts,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1, 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        profile_asset_id = excluded.profile_asset_id,
        source_type = excluded.source_type,
        source_url = excluded.source_url,
        status = 'pending',
        product_id = COALESCE(excluded.product_id, product_image_assets.product_id),
        offer_id = COALESCE(excluded.offer_id, product_image_assets.offer_id),
        expires_at = excluded.expires_at,
        reference_count = 1,
        deleted_at = NULL,
        last_error = NULL,
        updated_at = excluded.updated_at
    `).run(
      id,
      scope.tenantId,
      scope.userId,
      scope.shopId,
      text(input.profileAssetId) || null,
      text(input.sha256),
      text(input.mimeType),
      positiveInteger(input.byteLength),
      positiveInteger(input.width) || null,
      positiveInteger(input.height) || null,
      storageScope,
      variant,
      text(input.sourceType) || 'unknown',
      text(input.sourceUrl) || null,
      text(input.productId) || null,
      text(input.offerId) || null,
      input.expiresAt ? iso(input.expiresAt) : null,
      existing?.created_at || timestamp,
      timestamp,
    );
    return { ok: true, created: !existing, asset: publicRow(db.prepare(`${selectSql} WHERE id = ?`).get(id)) };
  }

  function markStored(id, input = {}, scopeInput = {}) {
    const current = db.prepare(`${selectSql} WHERE id = ?`).get(text(id));
    assertScope(current, scopeInput);
    const timestamp = iso(now());
    db.prepare(`
      UPDATE product_image_assets
      SET object_key = ?, object_etag = ?, object_request_id = ?, status = 'stored',
          upload_attempts = ?, expires_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      text(input.objectKey),
      text(input.etag) || null,
      text(input.requestId) || null,
      positiveInteger(input.uploadAttempts, current.upload_attempts),
      input.expiresAt ? iso(input.expiresAt) : current.expires_at,
      timestamp,
      text(id),
    );
    return getAsset(id, scopeInput);
  }

  function markFailed(id, error, attempts = 0, scopeInput = {}) {
    const current = db.prepare(`${selectSql} WHERE id = ?`).get(text(id));
    assertScope(current, scopeInput);
    db.prepare(`
      UPDATE product_image_assets
      SET status = 'failed', upload_attempts = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(positiveInteger(attempts), text(error?.message || error).slice(0, 500), iso(now()), text(id));
    return getAsset(id, scopeInput);
  }

  function markPublishedByUrls({ shopId, urls = [], productId = '', offerId = '' } = {}) {
    const scope = scopeFrom({ shopId }, defaults);
    const keys = [...new Set(urls.map(objectKeyFromSignedUrl).filter(Boolean))];
    if (!keys.length) return { ok: true, changed: 0, assetIds: [] };
    const placeholders = keys.map(() => '?').join(', ');
    const rows = db.prepare(`
      ${selectSql}
      WHERE tenant_id = ? AND user_id = ? AND shop_id = ?
        AND object_key IN (${placeholders}) AND status IN ('stored', 'published')
        AND reference_count > 0
    `).all(scope.tenantId, scope.userId, scope.shopId, ...keys);
    const timestamp = iso(now());
    const update = db.prepare(`
      UPDATE product_image_assets
      SET status = 'published', storage_scope = 'permanent', product_id = COALESCE(?, product_id),
          offer_id = COALESCE(?, offer_id), published_at = COALESCE(published_at, ?),
          expires_at = NULL, updated_at = ?
      WHERE id = ?
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) update.run(text(productId) || null, text(offerId) || null, timestamp, timestamp, row.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    for (const row of rows) {
      recordUsage({
        assetId: row.id,
        operation: 'publish',
        byteLength: row.byte_length,
        requestCount: 1,
        status: 'ok',
        detail: { productId: text(productId), offerId: text(offerId) },
      }, scope);
    }
    return { ok: true, changed: rows.length, assetIds: rows.map((row) => row.id) };
  }

  function beginRelease(id, scopeInput = {}, optionsInput = {}) {
    const current = db.prepare(`${selectSql} WHERE id = ?`).get(text(id));
    assertScope(current, scopeInput);
    if (current.status === 'deleted') {
      return { asset: publicRow(current), deleteObject: false, alreadyDeleted: true };
    }
    const nextCount = Math.max(0, Number(current.reference_count || 1) - 1);
    if (nextCount > 0) {
      db.prepare('UPDATE product_image_assets SET reference_count = ?, updated_at = ? WHERE id = ?')
        .run(nextCount, iso(now()), current.id);
      return { asset: getAsset(id, scopeInput), deleteObject: false, queuedForDeletion: false };
    }
    db.prepare(`
      UPDATE product_image_assets
      SET reference_count = 0, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(`DELETE_PENDING:${text(optionsInput.reason) || 'released'}`.slice(0, 500), iso(now()), current.id);
    return { asset: publicRow(current), deleteObject: Boolean(current.object_key), queuedForDeletion: true };
  }

  function markDeleteFailed(id, error, scopeInput = {}) {
    const current = db.prepare(`${selectSql} WHERE id = ?`).get(text(id));
    assertScope(current, scopeInput);
    db.prepare(`
      UPDATE product_image_assets
      SET reference_count = 0, last_error = ?, updated_at = ?
      WHERE id = ? AND status <> 'deleted'
    `).run(`DELETE_FAILED:${text(error?.message || error)}`.slice(0, 500), iso(now()), current.id);
    return getAsset(id, scopeInput);
  }

  function markDeleted(id, scopeInput = {}) {
    const current = db.prepare(`${selectSql} WHERE id = ?`).get(text(id));
    assertScope(current, scopeInput);
    const timestamp = iso(now());
    db.prepare(`
      UPDATE product_image_assets
      SET reference_count = 0, status = 'deleted', profile_asset_id = NULL,
          object_key = NULL, object_etag = NULL, object_request_id = NULL,
          deleted_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(timestamp, timestamp, current.id);
    return { asset: getAsset(id, scopeInput), profileAssetId: current.profile_asset_id || '', objectKey: current.object_key || '' };
  }

  function listDeletionCandidates(optionsInput = {}) {
    const timestamp = optionsInput.now ? iso(optionsInput.now) : iso(now());
    const retryDelaySeconds = Math.max(0, positiveInteger(optionsInput.retryDelaySeconds, 300));
    const retryBefore = new Date(new Date(timestamp).getTime() - retryDelaySeconds * 1000).toISOString();
    const limit = Math.min(Math.max(positiveInteger(optionsInput.limit, 100), 1), 1000);
    return db.prepare(`
      ${selectSql}
      WHERE status IN ('pending', 'stored', 'failed')
        AND (
          (storage_scope = 'temporary' AND expires_at IS NOT NULL AND expires_at <= ?)
          OR (
            reference_count = 0
            AND (last_error LIKE 'DELETE_PENDING:%' OR updated_at <= ?)
          )
        )
      ORDER BY CASE WHEN reference_count = 0 THEN 0 ELSE 1 END,
               COALESCE(expires_at, updated_at) ASC, id ASC
      LIMIT ?
    `).all(timestamp, retryBefore, limit).map(publicRow);
  }

  function findAssetByObjectKey(objectKey, scopeInput = {}) {
    const scope = scopeFrom(scopeInput, defaults);
    const row = db.prepare(`
      ${selectSql}
      WHERE object_key = ? AND tenant_id = ? AND user_id = ? AND shop_id = ?
        AND storage_scope = 'permanent' AND status IN ('stored', 'published')
        AND reference_count > 0
      LIMIT 1
    `).get(text(objectKey), scope.tenantId, scope.userId, scope.shopId);
    return publicRow(row);
  }

  function recordUsage(input = {}, scopeInput = {}) {
    const scope = scopeFrom(scopeInput, defaults);
    const timestamp = input.occurredAt ? iso(input.occurredAt) : iso(now());
    const detail = input.detail && typeof input.detail === 'object' ? JSON.stringify(input.detail) : null;
    db.prepare(`
      INSERT INTO product_image_usage_events (
        id, tenant_id, user_id, shop_id, asset_id, operation, byte_length,
        request_count, status, detail_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `pimg_evt_${randomUUID()}`,
      scope.tenantId,
      scope.userId,
      scope.shopId,
      text(input.assetId) || null,
      text(input.operation) || 'unknown',
      positiveInteger(input.byteLength),
      positiveInteger(input.requestCount, 1),
      text(input.status) || 'ok',
      detail,
      timestamp,
    );
  }

  function getUsageSummary(scopeInput = {}, optionsInput = {}) {
    const scope = scopeFrom(scopeInput, defaults);
    const nowDate = optionsInput.now ? new Date(optionsInput.now) : now();
    const dayStart = new Date(nowDate); dayStart.setUTCHours(0, 0, 0, 0);
    const monthStart = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1));
    const aggregate = (since) => db.prepare(`
      SELECT COUNT(*) AS events,
             COALESCE(SUM(request_count), 0) AS requests,
             COALESCE(SUM(CASE WHEN operation = 'upload' AND status = 'ok' THEN 1 ELSE 0 END), 0) AS uploads,
             COALESCE(SUM(CASE WHEN operation = 'upload' AND status = 'ok' THEN byte_length ELSE 0 END), 0) AS upload_bytes,
             COALESCE(SUM(CASE WHEN operation IN ('signed_preview', 'signed_ozon') AND status = 'ok' THEN byte_length ELSE 0 END), 0) AS estimated_egress_bytes
      FROM product_image_usage_events
      WHERE tenant_id = ? AND user_id = ? AND occurred_at >= ?
    `).get(scope.tenantId, scope.userId, iso(since));
    const retained = db.prepare(`
      SELECT COUNT(*) AS assets, COALESCE(SUM(byte_length), 0) AS bytes
      FROM product_image_assets
      WHERE tenant_id = ? AND user_id = ? AND status IN ('stored', 'published')
        AND reference_count > 0
    `).get(scope.tenantId, scope.userId);
    return {
      scope,
      day: Object.fromEntries(Object.entries(aggregate(dayStart)).map(([key, value]) => [key, Number(value || 0)])),
      month: Object.fromEntries(Object.entries(aggregate(monthStart)).map(([key, value]) => [key, Number(value || 0)])),
      retained: { assets: Number(retained.assets || 0), bytes: Number(retained.bytes || 0) },
    };
  }

  function listAssets(scopeInput = {}, optionsInput = {}) {
    const scope = scopeFrom(scopeInput, defaults);
    const limit = Math.min(Math.max(positiveInteger(optionsInput.limit, 100), 1), 1000);
    return db.prepare(`
      ${selectSql}
      WHERE tenant_id = ? AND user_id = ? AND shop_id = ?
        AND status <> 'deleted' AND reference_count > 0
      ORDER BY updated_at DESC, id ASC LIMIT ?
    `).all(scope.tenantId, scope.userId, scope.shopId, limit).map(publicRow);
  }

  return {
    defaults,
    getAsset,
    findByProfileAssetId,
    upsertPending,
    markStored,
    markFailed,
    markPublishedByUrls,
    beginRelease,
    releaseAsset: beginRelease,
    markDeleteFailed,
    markDeleted,
    listDeletionCandidates,
    findAssetByObjectKey,
    recordUsage,
    getUsageSummary,
    listAssets,
  };
}

export const productImageAssetRepositoryDefaults = Object.freeze({ unboundShopId: UNBOUND_SHOP_ID });
