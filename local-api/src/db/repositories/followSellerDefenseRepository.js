import { randomUUID } from 'node:crypto';

function text(value) {
  return String(value ?? '').trim();
}

function isoNow() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return fallback;
  }
}

function compactJson(value, fallback = null) {
  return JSON.stringify(value ?? fallback);
}

function mapProduct(row = {}) {
  return {
    productIdentityId: text(row.product_identity_id),
    shopId: text(row.shop_id),
    productId: text(row.product_id),
    offerId: text(row.offer_id),
    sku: text(row.sku),
    name: text(row.product_name),
    imageUrl: text(row.image_url),
    visibility: text(row.visibility),
  };
}

function mapPatrol(row = {}) {
  return {
    id: text(row.id),
    shopId: text(row.shop_id),
    mode: text(row.mode),
    status: text(row.status),
    stage: text(row.stage),
    totalCount: Number(row.total_count) || 0,
    scannedCount: Number(row.scanned_count) || 0,
    followedCount: Number(row.followed_count) || 0,
    clearCount: Number(row.clear_count) || 0,
    failedCount: Number(row.failed_count) || 0,
    lastErrorCode: text(row.last_error_code),
    lastErrorMessage: text(row.last_error_message),
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapCase(row = {}) {
  return {
    id: text(row.id),
    shopId: text(row.shop_id),
    patrolRunId: text(row.patrol_run_id),
    inputIdentifier: text(row.input_identifier),
    productIdentityId: text(row.product_identity_id),
    productId: text(row.product_id),
    offerId: text(row.offer_id),
    sku: text(row.sku),
    productName: text(row.product_name),
    imageUrl: text(row.image_url),
    status: text(row.status),
    stage: text(row.stage),
    modelBefore: text(row.model_before),
    modelAfter: text(row.model_after),
    groupOfferIds: parseJson(row.group_offer_ids_json, []),
    writePayload: parseJson(row.write_payload_json, null),
    writeResult: parseJson(row.write_result_json, null),
    previewId: text(row.preview_id),
    ozonJobId: text(row.ozon_job_id),
    ozonTaskId: text(row.ozon_task_id),
    followCountBefore: row.follow_count_before === null ? null : Number(row.follow_count_before),
    followCountAfter: row.follow_count_after === null ? null : Number(row.follow_count_after),
    followMinPrice: row.follow_min_price === null ? null : Number(row.follow_min_price),
    followMaxPrice: row.follow_max_price === null ? null : Number(row.follow_max_price),
    sellers: parseJson(row.sellers_json, []),
    retryCount: Number(row.retry_count) || 0,
    lastErrorCode: text(row.last_error_code),
    lastErrorMessage: text(row.last_error_message),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    completedAt: row.completed_at || null,
    isLatest: Number(row.is_latest) !== 0,
  };
}

function mapLoginProfile(row = {}) {
  return {
    id: text(row.id),
    integrationType: text(row.integration_type),
    platformName: text(row.platform_name),
    shopId: text(row.shop_id),
    configStatus: text(row.config_status),
    tokenStatus: text(row.token_status),
    authMode: text(row.auth_mode),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    connected: text(row.config_status) === '连接成功' && text(row.token_status) === 'Cookie 已保存',
  };
}

const PRODUCT_SELECT = `
  SELECT identity.product_identity_id AS product_identity_id,
         product.shop_id,
         product.product_id,
         product.offer_id,
         product.sku,
         COALESCE(detail.name, product.name, '') AS product_name,
         COALESCE(product.primary_image_url,
                  json_extract(CASE WHEN json_valid(product.images_json) THEN product.images_json ELSE '[]' END, '$[0]'), '') AS image_url,
         COALESCE(status.visibility, product.visibility, '') AS visibility
    FROM ozon_products AS product
    LEFT JOIN product_identities AS identity
      ON identity.product_identity_id = product.id AND identity.shop_id = product.shop_id
    LEFT JOIN product_detail_facts AS detail
      ON detail.product_identity_id = product.id AND detail.shop_id = product.shop_id
    LEFT JOIN product_status_facts AS status
      ON status.product_identity_id = product.id AND status.shop_id = product.shop_id
`;

export function createFollowSellerDefenseRepository(db) {
  if (!db) throw new Error('FOLLOW_SELLER_REPOSITORY_DB_REQUIRED');

  function inImmediateTransaction(work) {
    if (db.isTransaction) return work();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const insertCaseStatement = db.prepare(`
    INSERT INTO follow_seller_cases (
      id, shop_id, patrol_run_id, input_identifier, product_identity_id, product_id,
      offer_id, sku, product_name, image_url, status, stage, model_before,
      is_latest, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const demoteLatestCaseStatement = db.prepare(`
    UPDATE follow_seller_cases
       SET is_latest = 0
     WHERE shop_id = ? AND sku = ? AND is_latest = 1
  `);
  const updateCaseStatement = db.prepare(`
    UPDATE follow_seller_cases
       SET status = ?, stage = ?, model_before = ?, model_after = ?, group_offer_ids_json = ?,
           write_payload_json = ?, write_result_json = ?, preview_id = ?, ozon_job_id = ?, ozon_task_id = ?,
           follow_count_before = ?, follow_count_after = ?, follow_min_price = ?, follow_max_price = ?,
           sellers_json = ?, retry_count = ?, last_error_code = ?, last_error_message = ?,
           completed_at = ?, updated_at = ?
     WHERE id = ?
  `);
  const insertAttemptStatement = db.prepare(`
    INSERT INTO follow_seller_action_attempts (id, case_id, shop_id, action, status, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  function listProductCandidates({
    shopId,
    identifier = '',
    limit = 1000,
    offset = 0,
    sellableOnly = true,
  } = {}) {
    const normalizedShopId = text(shopId);
    const normalizedIdentifier = text(identifier);
    if (!normalizedShopId) return [];
    const where = [
      'product.shop_id = ?',
      'COALESCE(status.is_stale, product.is_stale, 0) = 0',
      "trim(COALESCE(product.offer_id, '')) <> ''",
      "trim(COALESCE(product.sku, '')) <> ''",
    ];
    const params = [normalizedShopId];
    if (normalizedIdentifier) {
      where.push('(product.offer_id = ? OR product.sku = ? OR product.product_id = ?)');
      params.push(normalizedIdentifier, normalizedIdentifier, normalizedIdentifier);
    }
    if (sellableOnly) {
      where.push(`upper(COALESCE(status.visibility, product.visibility, '')) NOT IN
        ('ARCHIVED', 'REMOVED_FROM_SALE', 'STATE_FAILED', 'VALIDATION_STATE_FAIL')`);
    }
    // limit 只控制单页传输，offset 负责把整个店铺读完。禁止再用一个
    // 20,000/1,000 的 LIMIT 冒充“全店”。
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 1000, 2_000));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    // 巡查建单只需要 SKU、商品标识和轻量缩略图。这里禁止联查
    // product_image_facts：真实数据库里该表按店铺有数万张图片，SQLite
    // 会为每个商品反复扫描店铺图片索引，曾把 2,263 个商品的建单请求
    // 从不足一秒拖到超过 120 秒。完整图片只在生成投诉材料时按单品读取。
    const rows = db.prepare(`
      ${PRODUCT_SELECT}
      WHERE ${where.join(' AND ')}
      ORDER BY product.sort_index ASC, product.product_id ASC
      LIMIT ? OFFSET ?
    `).all(...params, boundedLimit, boundedOffset);
    return rows.map(mapProduct);
  }

  function getProductComplaintMaterial({ shopId, productId = '', sku = '' } = {}) {
    const normalizedShopId = text(shopId);
    const normalizedProductId = text(productId);
    const normalizedSku = text(sku);
    if (!normalizedShopId || (!normalizedProductId && !normalizedSku)) return null;
    const product = db.prepare(`
      SELECT id AS product_identity_id, shop_id, product_id, offer_id, sku,
             primary_image_url, images_json
        FROM ozon_products
       WHERE shop_id = ?
         AND ((? <> '' AND product_id = ?) OR (? <> '' AND sku = ?))
       ORDER BY CASE WHEN product_id = ? THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1
    `).get(
      normalizedShopId,
      normalizedProductId,
      normalizedProductId,
      normalizedSku,
      normalizedSku,
      normalizedProductId,
    );
    if (!product) return null;
    const factImages = db.prepare(`
      SELECT image_url
        FROM product_image_facts
       WHERE shop_id = ? AND product_identity_id = ?
       ORDER BY is_primary DESC, image_index ASC
    `).all(normalizedShopId, text(product.product_identity_id));
    const imageUrls = [...new Set([
      text(product.primary_image_url),
      ...parseJson(product.images_json, []).map(text),
      ...factImages.map((row) => text(row.image_url)),
    ].filter((value) => /^https:\/\//iu.test(value)))];
    return {
      shopId: normalizedShopId,
      productIdentityId: text(product.product_identity_id),
      productId: text(product.product_id),
      offerId: text(product.offer_id),
      sku: text(product.sku),
      imageUrls,
    };
  }

  function createPatrol({ shopId, mode = 'shop', totalCount = 0 } = {}) {
    const id = randomUUID();
    const now = isoNow();
    db.prepare(`
      INSERT INTO follow_seller_patrol_runs (
        id, shop_id, mode, status, stage, total_count, started_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'running', 'awaiting_capture', ?, ?, ?, ?)
    `).run(id, text(shopId), mode === 'manual' ? 'manual' : 'shop', Math.max(0, Number(totalCount) || 0), now, now, now);
    return getPatrol(id);
  }

  function getPatrol(id) {
    const row = db.prepare('SELECT * FROM follow_seller_patrol_runs WHERE id = ?').get(text(id));
    return row ? mapPatrol(row) : null;
  }

  function updatePatrol(id, patch = {}) {
    const current = getPatrol(id);
    if (!current) return null;
    const next = {
      status: text(patch.status) || current.status,
      stage: text(patch.stage) || current.stage,
      totalCount: patch.totalCount ?? current.totalCount,
      scannedCount: patch.scannedCount ?? current.scannedCount,
      followedCount: patch.followedCount ?? current.followedCount,
      clearCount: patch.clearCount ?? current.clearCount,
      failedCount: patch.failedCount ?? current.failedCount,
      lastErrorCode: patch.lastErrorCode ?? current.lastErrorCode,
      lastErrorMessage: patch.lastErrorMessage ?? current.lastErrorMessage,
      finishedAt: patch.finishedAt ?? current.finishedAt,
    };
    db.prepare(`
      UPDATE follow_seller_patrol_runs
         SET status = ?, stage = ?, total_count = ?, scanned_count = ?, followed_count = ?,
             clear_count = ?, failed_count = ?, last_error_code = ?, last_error_message = ?,
             finished_at = ?, updated_at = ?
       WHERE id = ?
    `).run(next.status, next.stage, next.totalCount, next.scannedCount, next.followedCount,
      next.clearCount, next.failedCount, next.lastErrorCode || null, next.lastErrorMessage || null,
      next.finishedAt || null, isoNow(), text(id));
    return getPatrol(id);
  }

  function createCase({ shopId, patrolRunId = '', inputIdentifier = '', product, status = 'pending_capture', stage = 'awaiting_capture' } = {}) {
    const id = randomUUID();
    const now = isoNow();
    const normalizedShopId = text(shopId);
    const normalizedSku = text(product?.sku);
    return inImmediateTransaction(() => {
      demoteLatestCaseStatement.run(normalizedShopId, normalizedSku);
      insertCaseStatement.run(id, normalizedShopId, text(patrolRunId) || null, text(inputIdentifier) || null,
        text(product?.productIdentityId) || null, text(product?.productId) || null,
        text(product?.offerId), normalizedSku, text(product?.name) || null,
        text(product?.imageUrl) || null, status, stage, null, 1, now, now);
      return getCase(id);
    });
  }

  function insertCasesTransaction(items) {
    return inImmediateTransaction(() => {
    for (const item of items) {
      demoteLatestCaseStatement.run(item.shopId, item.sku);
      insertCaseStatement.run(
        item.id,
        item.shopId,
        item.patrolRunId || null,
        item.inputIdentifier || null,
        item.productIdentityId || null,
        item.productId || null,
        item.offerId,
        item.sku,
        item.productName || null,
        item.imageUrl || null,
        item.status,
        item.stage,
        item.modelBefore || null,
        1,
        item.createdAt,
        item.updatedAt,
      );
    }
    });
  }

  function createCases({ shopId, patrolRunId = '', products = [], status = 'pending_capture', stage = 'awaiting_capture' } = {}) {
    const now = isoNow();
    const uniqueProducts = new Map();
    for (const product of Array.isArray(products) ? products : []) {
      const sku = text(product?.sku);
      if (sku && !uniqueProducts.has(sku)) uniqueProducts.set(sku, product);
    }
    const items = [...uniqueProducts.values()].map((product) => ({
      id: randomUUID(),
      shopId: text(shopId),
      patrolRunId: text(patrolRunId),
      inputIdentifier: '',
      productIdentityId: text(product?.productIdentityId),
      productId: text(product?.productId),
      offerId: text(product?.offerId),
      sku: text(product?.sku),
      productName: text(product?.name),
      imageUrl: text(product?.imageUrl),
      status,
      stage,
      modelBefore: '',
      createdAt: now,
      updatedAt: now,
    })).filter((item) => item.shopId && item.offerId && item.sku);
    if (!items.length) return [];
    insertCasesTransaction(items);
    return items.map((item) => ({
      ...item,
      caseId: item.id,
      followCountBefore: null,
      lastErrorCode: '',
      lastErrorMessage: '',
      isLatest: true,
    }));
  }

  function getCase(id) {
    const row = db.prepare('SELECT * FROM follow_seller_cases WHERE id = ?').get(text(id));
    return row ? mapCase(row) : null;
  }

  function writeCasePatch(id, patch = {}, currentCase = null) {
    const current = currentCase || getCase(id);
    if (!current) return null;
    const value = (key, fallback = '') => patch[key] === undefined ? current[key] : patch[key];
    updateCaseStatement.run(
      text(value('status')),
      text(value('stage')),
      text(value('modelBefore')) || null,
      text(value('modelAfter')) || null,
      compactJson(value('groupOfferIds', []), []),
      value('writePayload', null) === null ? null : compactJson(value('writePayload', null)),
      value('writeResult', null) === null ? null : compactJson(value('writeResult', null)),
      text(value('previewId')) || null,
      text(value('ozonJobId')) || null,
      text(value('ozonTaskId')) || null,
      value('followCountBefore', null),
      value('followCountAfter', null),
      value('followMinPrice', null),
      value('followMaxPrice', null),
      compactJson(value('sellers', []), []),
      Math.max(0, Number(value('retryCount', 0)) || 0),
      text(value('lastErrorCode')) || null,
      text(value('lastErrorMessage')) || null,
      value('completedAt', null) || null,
      isoNow(),
      text(id),
    );
    return text(id);
  }

  function updateCase(id, patch = {}) {
    const updatedId = writeCasePatch(id, patch);
    return updatedId ? getCase(updatedId) : null;
  }

  function updateCasesTransaction(items) {
    return inImmediateTransaction(() => items
      .map((item) => writeCasePatch(item?.id, item?.patch || {}, item?.current || null))
      .filter(Boolean));
  }

  function updateCases(items = []) {
    const updatedIds = updateCasesTransaction(Array.isArray(items) ? items : []);
    return getCasesByIds(updatedIds);
  }

  function listCases({ shopId = '', patrolRunId = '', status = '', limit = 500, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (text(shopId)) { where.push('shop_id = ?'); params.push(text(shopId)); }
    if (text(patrolRunId)) { where.push('patrol_run_id = ?'); params.push(text(patrolRunId)); }
    else where.push('is_latest = 1');
    if (text(status)) { where.push('status = ?'); params.push(text(status)); }
    const rows = db.prepare(`
      SELECT * FROM follow_seller_cases
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, Math.max(1, Math.min(Number(limit) || 500, 20_000)), Math.max(0, Number(offset) || 0));
    return rows.map(mapCase);
  }

  function summarizeCases({ shopId = '', patrolRunId = '', status = '' } = {}) {
    const where = [];
    const params = [];
    if (text(shopId)) { where.push('shop_id = ?'); params.push(text(shopId)); }
    if (text(patrolRunId)) { where.push('patrol_run_id = ?'); params.push(text(patrolRunId)); }
    else where.push('is_latest = 1');
    if (text(status)) { where.push('status = ?'); params.push(text(status)); }
    const rows = db.prepare(`
      SELECT status, COUNT(*) AS count
        FROM follow_seller_cases
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       GROUP BY status
    `).all(...params);
    return rows.reduce((summary, row) => {
      const count = Math.max(0, Number(row.count) || 0);
      summary.total += count;
      summary[text(row.status)] = count;
      return summary;
    }, { total: 0 });
  }

  function listCaptureCases({ patrolRunId, pendingOnly = false } = {}) {
    const normalizedPatrolRunId = text(patrolRunId);
    if (!normalizedPatrolRunId) return [];
    const rows = db.prepare(`
      SELECT id, shop_id, patrol_run_id, product_id, offer_id, sku, product_name, image_url,
             status, stage, follow_count_before, retry_count, last_error_code, last_error_message,
             created_at, updated_at
        FROM follow_seller_cases
       WHERE patrol_run_id = ?
         ${pendingOnly ? "AND status = 'pending_capture'" : ''}
       ORDER BY created_at ASC
    `).all(normalizedPatrolRunId);
    return rows.map((row) => ({
      id: text(row.id),
      caseId: text(row.id),
      shopId: text(row.shop_id),
      patrolRunId: text(row.patrol_run_id),
      productId: text(row.product_id),
      offerId: text(row.offer_id),
      sku: text(row.sku),
      productName: text(row.product_name),
      imageUrl: text(row.image_url),
      status: text(row.status),
      stage: text(row.stage),
      followCountBefore: row.follow_count_before === null ? null : Number(row.follow_count_before),
      retryCount: Number(row.retry_count) || 0,
      lastErrorCode: text(row.last_error_code),
      lastErrorMessage: text(row.last_error_message),
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
    }));
  }

  function getPatrolCaptureCounts(patrolRunId) {
    const row = db.prepare(`
      SELECT COUNT(*) AS total_count,
             SUM(CASE WHEN follow_count_before IS NOT NULL THEN 1 ELSE 0 END) AS scanned_count,
             SUM(CASE WHEN follow_count_before > 0 THEN 1 ELSE 0 END) AS followed_count,
             SUM(CASE WHEN follow_count_before = 0 THEN 1 ELSE 0 END) AS clear_count,
             SUM(CASE WHEN status = 'capture_failed' THEN 1 ELSE 0 END) AS failed_count,
             SUM(CASE WHEN status = 'pending_capture' THEN 1 ELSE 0 END) AS pending_count
        FROM follow_seller_cases
       WHERE patrol_run_id = ?
    `).get(text(patrolRunId)) || {};
    return {
      totalCount: Number(row.total_count) || 0,
      scannedCount: Number(row.scanned_count) || 0,
      followedCount: Number(row.followed_count) || 0,
      clearCount: Number(row.clear_count) || 0,
      failedCount: Number(row.failed_count) || 0,
      pendingCount: Number(row.pending_count) || 0,
    };
  }

  function getCasesByIds(caseIds = []) {
    const ids = [...new Set((Array.isArray(caseIds) ? caseIds : [caseIds]).map(text).filter(Boolean))];
    if (!ids.length) return [];
    return db.prepare(`
      SELECT * FROM follow_seller_cases
      WHERE id IN (${ids.map(() => '?').join(',')})
      ORDER BY created_at ASC
    `).all(...ids).map(mapCase);
  }

  function listCasesByPreview(previewId) {
    const normalized = text(previewId);
    if (!normalized) return [];
    return db.prepare(`
      SELECT * FROM follow_seller_cases
      WHERE preview_id = ?
      ORDER BY created_at ASC
    `).all(normalized).map(mapCase);
  }

  function listPatrols({ shopId = '', limit = 30 } = {}) {
    const rows = text(shopId)
      ? db.prepare('SELECT * FROM follow_seller_patrol_runs WHERE shop_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(text(shopId), Math.max(1, Math.min(Number(limit) || 30, 200)))
      : db.prepare('SELECT * FROM follow_seller_patrol_runs ORDER BY created_at DESC LIMIT ?')
        .all(Math.max(1, Math.min(Number(limit) || 30, 200)));
    return rows.map(mapPatrol);
  }

  function listLoginProfiles() {
    return db.prepare(`
      SELECT id, integration_type, platform_name, shop_id, config_status,
             token_status, auth_mode, created_at, updated_at
        FROM integration_profiles
       WHERE integration_type = 'ozon-follow-seller-session'
       ORDER BY CASE
                  WHEN config_status = '连接成功' AND token_status = 'Cookie 已保存' THEN 0
                  ELSE 1
                END,
                updated_at DESC,
                platform_name ASC,
                id ASC
    `).all().map(mapLoginProfile);
  }

  function getLoginPreference() {
    const row = db.prepare(`
      SELECT preference.preference_key, preference.profile_id,
             preference.created_at, preference.updated_at
        FROM follow_seller_login_preferences AS preference
        JOIN integration_profiles AS profile ON profile.id = preference.profile_id
       WHERE preference.preference_key = 'global'
         AND profile.integration_type = 'ozon-follow-seller-session'
       LIMIT 1
    `).get();
    return row ? {
      preferenceKey: text(row.preference_key),
      profileId: text(row.profile_id),
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
    } : null;
  }

  function saveLoginPreference({ profileId } = {}) {
    const normalizedProfileId = text(profileId);
    const profile = db.prepare(`
      SELECT id
        FROM integration_profiles
       WHERE id = ?
         AND integration_type = 'ozon-follow-seller-session'
       LIMIT 1
    `).get(normalizedProfileId);
    if (!profile) return null;
    const timestamp = isoNow();
    db.prepare(`
      INSERT INTO follow_seller_login_preferences (
        preference_key, profile_id, created_at, updated_at
      ) VALUES ('global', ?, ?, ?)
      ON CONFLICT(preference_key) DO UPDATE SET
        profile_id = excluded.profile_id,
        updated_at = excluded.updated_at
    `).run(normalizedProfileId, timestamp, timestamp);
    return getLoginPreference();
  }

  function recordAttempt({ caseId, shopId, action, status, detail = {} } = {}) {
    insertAttemptStatement.run(randomUUID(), text(caseId), text(shopId), text(action), text(status), compactJson(detail, {}), isoNow());
  }

  function recordAttemptsTransaction(items) {
    return inImmediateTransaction(() => {
      for (const item of items) recordAttempt(item);
    });
  }

  function recordAttempts(items = []) {
    recordAttemptsTransaction(Array.isArray(items) ? items : []);
  }

  return {
    listProductCandidates,
    getProductComplaintMaterial,
    createPatrol,
    getPatrol,
    updatePatrol,
    createCase,
    createCases,
    getCase,
    updateCase,
    updateCases,
    listCases,
    summarizeCases,
    listCaptureCases,
    getPatrolCaptureCounts,
    getCasesByIds,
    listCasesByPreview,
    listPatrols,
    listLoginProfiles,
    getLoginPreference,
    saveLoginPreference,
    recordAttempt,
    recordAttempts,
  };
}
