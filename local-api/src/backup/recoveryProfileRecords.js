import { normalizeProfileAssetInput } from "../db/repositories/profileAssetRepository.js";
import { normalizeProfileSettingValue, PROFILE_SETTING_NAMESPACES } from "../db/repositories/profileSettingsRepository.js";
import { buildRecoveryRecordKey } from "./recoveryExporter.js";
import { decryptProfileJson, decryptProfileSecret } from "./recoveryProfileCrypto.js";

export function crossBorderAccountRecords(db, decryptSecret, policy) {
  return db.prepare(`
    SELECT id, name, status, user_name_encrypted, password_encrypted,
      company_secret_encrypted, access_token_encrypted, expires_token_encrypted, app_uid_encrypted,
      default_storehouse, default_section, default_service, note, created_at, updated_at
    FROM cross_border_accounts
    ORDER BY id
  `).all().map((row) => {
    const value = {
      id: row.id,
      name: row.name,
      status: row.status || 'inactive',
      user_name: decryptProfileSecret(decryptSecret, row.user_name_encrypted, policy.domain, row.id, 'user_name'),
      password: decryptProfileSecret(decryptSecret, row.password_encrypted, policy.domain, row.id, 'password'),
      company_secret: decryptProfileSecret(
        decryptSecret,
        row.company_secret_encrypted,
        policy.domain,
        row.id,
        'company_secret',
      ),
      access_token: decryptProfileSecret(
        decryptSecret,
        row.access_token_encrypted,
        policy.domain,
        row.id,
        'access_token',
      ),
      expires_token: decryptProfileSecret(
        decryptSecret,
        row.expires_token_encrypted,
        policy.domain,
        row.id,
        'expires_token',
      ),
      app_uid: decryptProfileSecret(decryptSecret, row.app_uid_encrypted, policy.domain, row.id, 'app_uid'),
      default_storehouse: row.default_storehouse || null,
      default_section: row.default_section || null,
      default_service: row.default_service || null,
      note: row.note || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    return { key: buildRecoveryRecordKey(policy, value), value };
  });
}

export function performanceAccountRecords(db, decryptSecret, policy) {
  return db.prepare(`
    SELECT id, name, status, shop_id, client_id, client_secret_encrypted, last_test_at,
      last_test_message, campaign_count, statistics_task_count, note, created_at, updated_at
    FROM performance_accounts
    ORDER BY id
  `).all().map((row) => {
    const value = {
      id: row.id,
      name: row.name,
      status: row.status || 'inactive',
      shop_id: row.shop_id || null,
      client_id: row.client_id || null,
      client_secret: decryptProfileSecret(
        decryptSecret,
        row.client_secret_encrypted,
        policy.domain,
        row.id,
        'client_secret',
      ),
      last_test_at: row.last_test_at || null,
      last_test_message: row.last_test_message || null,
      campaign_count: row.campaign_count ?? null,
      statistics_task_count: row.statistics_task_count ?? null,
      note: row.note || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    return { key: buildRecoveryRecordKey(policy, value), value };
  });
}

export function purchaseAccountRecords(db, decryptSecret, policy) {
  return db.prepare(`
    SELECT id, name, platform_name, login_account, login_password_encrypted,
      default_usage, risk_note, note, is_default, created_at, updated_at
    FROM purchase_accounts
    ORDER BY id
  `).all().map((row) => {
    const value = {
      id: row.id,
      name: row.name,
      platform_name: row.platform_name || null,
      login_account: row.login_account || null,
      login_password: decryptProfileSecret(
        decryptSecret, row.login_password_encrypted, policy.domain, row.id, 'login_password',
      ),
      default_usage: row.default_usage || null,
      risk_note: row.risk_note || null,
      note: row.note || null,
      is_default: Number(row.is_default) === 1 ? 1 : 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    return { key: buildRecoveryRecordKey(policy, value), value };
  });
}

export function modelApiAccountRecords(db, decryptSecret, policy) {
  return db.prepare(`
    SELECT id, api_alias, provider, website_url, login_account, login_password_encrypted,
      base_url, api_key_encrypted, default_model, usage_scene, upscale, quality, style,
      available_models_json, capabilities_json, discovery_verified,
      detection_status, detected_source, detected_at, is_default, created_at, updated_at
    FROM model_api_accounts
    ORDER BY id
  `).all().map((row) => {
    const value = {
      id: row.id,
      api_alias: row.api_alias,
      provider: row.provider || null,
      website_url: row.website_url || null,
      login_account: row.login_account || null,
      login_password: decryptProfileSecret(
        decryptSecret, row.login_password_encrypted, policy.domain, row.id, 'login_password',
      ),
      base_url: row.base_url || null,
      api_key: decryptProfileSecret(decryptSecret, row.api_key_encrypted, policy.domain, row.id, 'api_key'),
      default_model: row.default_model || null,
      usage_scene: row.usage_scene || null,
      upscale: row.upscale || null,
      quality: row.quality || null,
      style: row.style || null,
      available_models_json: row.available_models_json || null,
      capabilities_json: row.capabilities_json || null,
      discovery_verified: Number(row.discovery_verified) === 1 ? 1 : 0,
      detection_status: row.detection_status || null,
      detected_source: row.detected_source || null,
      detected_at: row.detected_at || null,
      is_default: Number(row.is_default) === 1 ? 1 : 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    return { key: buildRecoveryRecordKey(policy, value), value };
  });
}

export function integrationProfileRecords(db, policy) {
  return db.prepare(`
    SELECT id, integration_type, platform_name, shop_id, api_type, auth_mode, config_status,
      token_status, read_scope, write_scope, note, created_at, updated_at
    FROM integration_profiles
    ORDER BY id
  `).all().map((row) => {
    const value = {
      id: row.id,
      integration_type: row.integration_type,
      platform_name: row.platform_name,
      shop_id: row.shop_id || null,
      api_type: row.api_type || null,
      auth_mode: row.auth_mode || null,
      config_status: row.config_status || null,
      token_status: row.token_status || null,
      read_scope: row.read_scope || null,
      write_scope: row.write_scope || null,
      note: row.note || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    return { key: buildRecoveryRecordKey(policy, value), value };
  });
}

export function integrationCredentialRecords(db, decryptSecret, policy) {
  return db.prepare(`
    SELECT profile_id, base_url, login_account, login_password_encrypted,
      api_key_encrypted, last_test_status, last_test_message, last_test_at,
      last_test_metadata_json, created_at, updated_at
    FROM integration_credentials
    ORDER BY profile_id
  `).all().map((row) => {
    let loginPassword = null;
    let apiKey = null;
    try {
      loginPassword = row.login_password_encrypted ? decryptSecret(row.login_password_encrypted) : null;
      apiKey = row.api_key_encrypted ? decryptSecret(row.api_key_encrypted) : null;
    } catch {
      throw new Error(`BACKUP_SECRET_DECRYPT_FAILED:${row.profile_id}`);
    }
    if (row.login_password_encrypted && !loginPassword) {
      throw new Error(`BACKUP_SECRET_DECRYPT_FAILED:${row.profile_id}`);
    }
    if (row.api_key_encrypted && !apiKey) {
      throw new Error(`BACKUP_SECRET_DECRYPT_FAILED:${row.profile_id}`);
    }
    const value = {
      profile_id: row.profile_id,
      base_url: row.base_url,
      login_account: row.login_account || null,
      login_password: loginPassword,
      api_key: apiKey,
      last_test_status: row.last_test_status || null,
      last_test_message: row.last_test_message || null,
      last_test_at: row.last_test_at || null,
      last_test_metadata_json: row.last_test_metadata_json || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    return { key: buildRecoveryRecordKey(policy, value), value };
  });
}

export function followSellerLoginPreferenceRecords(db, policy) {
  return db.prepare(`
    SELECT preference_key, profile_id, created_at, updated_at
    FROM follow_seller_login_preferences
    ORDER BY preference_key
  `).all().map((row) => {
    const value = {
      preference_key: row.preference_key,
      profile_id: row.profile_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    return { key: buildRecoveryRecordKey(policy, value), value };
  });
}

export function profileSettingRecords(db, policy) {
  const placeholders = PROFILE_SETTING_NAMESPACES.map(() => '?').join(', ');
  return db.prepare(`
    SELECT namespace, value_json, created_at, updated_at
    FROM profile_settings
    WHERE namespace IN (${placeholders})
    ORDER BY namespace
  `).all(...PROFILE_SETTING_NAMESPACES).map((row) => {
    let value;
    try {
      value = normalizeProfileSettingValue(row.namespace, JSON.parse(row.value_json));
    } catch {
      throw new Error(`BACKUP_PROFILE_SETTING_INVALID:${row.namespace}`);
    }
    const record = {
      namespace: row.namespace,
      value,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    return { key: buildRecoveryRecordKey(policy, record), value: record };
  });
}

export function profileAssetRecords(db, policy) {
  return db.prepare(`
    SELECT id, sha256, mime_type, byte_length, data_base64, created_at, updated_at
    FROM profile_assets
    ORDER BY id
  `).all().map((row) => {
    let normalized;
    try {
      normalized = normalizeProfileAssetInput({ mimeType: row.mime_type, dataBase64: row.data_base64 });
    } catch {
      throw new Error(`BACKUP_PROFILE_ASSET_INVALID:${row.id}`);
    }
    if (normalized.sha256 !== row.sha256 || normalized.data.byteLength !== Number(row.byte_length)) {
      throw new Error(`BACKUP_PROFILE_ASSET_INTEGRITY_INVALID:${row.id}`);
    }
    const value = {
      id: row.id,
      sha256: row.sha256,
      mime_type: row.mime_type,
      byte_length: Number(row.byte_length),
      data_base64: row.data_base64,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    return { key: buildRecoveryRecordKey(policy, value), value };
  });
}

export function restoredPurchaseTaskStatus(status) {
  const value = String(status || '');
  if (['confirmed', 'executing', 'receipt_pending'].includes(value)) return 'interrupted';
  if (['previewed', 'completed', 'failed', 'interrupted', 'cancelled'].includes(value)) return value;
  throw new Error('RESTORE_PURCHASE_BROWSER_TASK_STATUS_INVALID');
}

export function purchaseBrowserTaskRecords(db, decryptSecret, policy) {
  return db.prepare(`
    SELECT id, owner_id, owner_incarnation, shop_id, order_key, product_key,
      idempotency_key_hash, request_fingerprint, preview_encrypted,
      preview_fingerprint, status, attempt_count, receipt_id, last_error_code,
      created_at, updated_at, confirmed_at, completed_at
    FROM purchase_browser_tasks
    ORDER BY id
  `).all().map((row) => {
    const value = {
      id: row.id,
      owner_id: row.owner_id,
      owner_incarnation: row.owner_incarnation,
      shop_id: row.shop_id || null,
      order_key: row.order_key,
      product_key: row.product_key,
      idempotency_key_hash: row.idempotency_key_hash,
      request_fingerprint: row.request_fingerprint,
      preview: decryptProfileJson(decryptSecret, row.preview_encrypted, policy.domain, row.id, 'preview'),
      preview_fingerprint: row.preview_fingerprint,
      status: restoredPurchaseTaskStatus(row.status),
      attempt_count: Number(row.attempt_count) || 0,
      receipt_id: row.receipt_id || null,
      last_error_code: ['confirmed', 'executing', 'receipt_pending'].includes(row.status)
        ? 'PURCHASE_BROWSER_PROCESS_INTERRUPTED'
        : row.last_error_code || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      confirmed_at: row.confirmed_at || null,
      completed_at: row.completed_at || null,
    };
    return { key: buildRecoveryRecordKey(policy, value), value };
  });
}

export function purchaseBrowserReceiptRecords(db, decryptSecret, policy) {
  return db.prepare(`
    SELECT id, task_id, owner_id, shop_id, attempt_id, receipt_encrypted,
      receipt_hash, website_readback_hash, created_at
    FROM purchase_browser_receipts
    ORDER BY id
  `).all().map((row) => {
    const value = {
      id: row.id,
      task_id: row.task_id,
      owner_id: row.owner_id,
      shop_id: row.shop_id || null,
      attempt_id: row.attempt_id,
      receipt: decryptProfileJson(decryptSecret, row.receipt_encrypted, policy.domain, row.id, 'receipt'),
      receipt_hash: row.receipt_hash,
      website_readback_hash: row.website_readback_hash,
      created_at: row.created_at,
    };
    return { key: buildRecoveryRecordKey(policy, value), value };
  });
}

export function purchaseCompletionHistoryRecords(db, decryptSecret, policy) {
  return db.prepare(`
    SELECT shop_id, source_task_id, source_receipt_id,
      source_account_ref_hash, order_number_hash, receipt_encrypted,
      receipt_hash, website_readback_hash, order_product_encrypted,
      order_product_hash, source_summary_encrypted, source_summary_hash,
      archive_origin, completed_at, archived_at, created_at, updated_at
    FROM purchase_completion_history
    ORDER BY shop_id, source_receipt_id
  `).all().map((row) => {
    const value = {
      shop_id: row.shop_id,
      source_task_id: row.source_task_id,
      source_receipt_id: row.source_receipt_id,
      source_account_ref_hash: row.source_account_ref_hash,
      order_number_hash: row.order_number_hash,
      receipt: decryptProfileJson(
        decryptSecret,
        row.receipt_encrypted,
        policy.domain,
        row.source_receipt_id,
        'receipt',
      ),
      receipt_hash: row.receipt_hash,
      website_readback_hash: row.website_readback_hash,
      order_product: decryptProfileJson(
        decryptSecret,
        row.order_product_encrypted,
        policy.domain,
        row.source_receipt_id,
        'order_product',
      ),
      order_product_hash: row.order_product_hash,
      source_summary: decryptProfileJson(
        decryptSecret,
        row.source_summary_encrypted,
        policy.domain,
        row.source_receipt_id,
        'source_summary',
      ),
      source_summary_hash: row.source_summary_hash,
      archive_origin: row.archive_origin,
      completed_at: row.completed_at,
      archived_at: row.archived_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    return { key: buildRecoveryRecordKey(policy, value), value };
  });
}
