import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../../security/secretCrypto.js';
import { createSavedSecretHint } from '../../security/secretPresentation.js';

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return value == null ? '' : String(value).trim();
}

function optionalText(value) {
  return normalizeText(value) || null;
}

const OPTION_GROUPS = ['size', 'quality', 'style', 'upscale'];

function normalizeOptionList(value) {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set();
  return rows
    .map((item) => {
      const id = normalizeText(typeof item === 'string' ? item : item?.id || item?.value || item?.name);
      if (!id || seen.has(id)) return null;
      seen.add(id);
      return {
        id,
        label: normalizeText(typeof item === 'string' ? item : item?.label || item?.displayName || item?.name || item?.value || id) || id,
      };
    })
    .filter(Boolean)
    .slice(0, 32);
}

function normalizeOptionGroups(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const group of OPTION_GROUPS) {
    const options = normalizeOptionList(value[group]);
    if (options.length) result[group] = options;
  }
  return result;
}

function normalizeModelOptions(value) {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set();
  return rows
    .map((item) => {
      const id = normalizeText(typeof item === 'string' ? item : item?.id || item?.model);
      if (!id || seen.has(id)) return null;
      seen.add(id);
      const normalized = {
        id,
        label: normalizeText(typeof item === 'string' ? item : item?.label || item?.displayName || id) || id,
        capabilities: [...new Set((Array.isArray(item?.capabilities) ? item.capabilities : [])
          .map(normalizeText)
          .filter(Boolean))].slice(0, 32),
        modalities: [...new Set((Array.isArray(item?.modalities) ? item.modalities : [])
          .map(normalizeText)
          .filter(Boolean))].slice(0, 16),
      };
      const options = normalizeOptionGroups(item?.options);
      if (Object.keys(options).length) normalized.options = options;
      return normalized;
    })
    .filter(Boolean)
    .slice(0, 100);
}

function readJsonArray(value, normalizer) {
  if (!value) return [];
  try {
    return normalizer(JSON.parse(String(value)));
  } catch {
    return [];
  }
}

function modelOptionsFromRow(row) {
  return readJsonArray(row.available_models_json, normalizeModelOptions);
}

function capabilitiesFromRow(row) {
  return readJsonArray(row.capabilities_json, (value) => (
    [...new Set((Array.isArray(value) ? value : []).map(normalizeText).filter(Boolean))].slice(0, 64)
  ));
}

function encryptOptionalSecret(value) {
  const secret = normalizeText(value);
  if (!secret) return null;
  return isEncryptedSecret(secret) ? secret : encryptSecret(secret);
}

function hasOwn(input, name) {
  return Object.prototype.hasOwnProperty.call(input, name);
}

function publicAccount(row = {}) {
  return {
    id: row.id,
    apiAlias: row.api_alias,
    provider: row.provider || '',
    websiteUrl: row.website_url || '',
    loginAccount: row.login_account || '',
    hasLoginPassword: Boolean(row.login_password_encrypted),
    loginPasswordHint: createSavedSecretHint(row.login_password_encrypted),
    baseUrl: row.base_url || '',
    hasApiKey: Boolean(row.api_key_encrypted),
    apiKeyHint: createSavedSecretHint(row.api_key_encrypted),
    defaultModel: row.default_model || '',
    usageScene: row.usage_scene || '',
    upscale: row.upscale || '',
    quality: row.quality || '',
    style: row.style || '',
    availableModels: modelOptionsFromRow(row),
    capabilities: capabilitiesFromRow(row),
    discoveryVerified: Boolean(row.discovery_verified),
    detectionStatus: row.detection_status || '',
    detectedSource: row.detected_source || '',
    detectedAt: row.detected_at || '',
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createModelApiAccountRepository(db) {
  const selectSql = `
    SELECT id, api_alias, provider, website_url, login_account, login_password_encrypted,
      base_url, api_key_encrypted, default_model, usage_scene, upscale, quality, style,
      available_models_json, capabilities_json, discovery_verified,
      detection_status, detected_source, detected_at, is_default, created_at, updated_at
    FROM model_api_accounts
  `;
  const getRow = (id) => db.prepare(`${selectSql} WHERE id = ?`).get(normalizeText(id)) || null;
  let clearDefaultAccount = null;
  let upsertAccount = null;

  function getClearDefaultAccountStatement() {
    if (!clearDefaultAccount) clearDefaultAccount = db.prepare('UPDATE model_api_accounts SET is_default = 0');
    return clearDefaultAccount;
  }

  function getUpsertAccountStatement() {
    if (upsertAccount) return upsertAccount;
    upsertAccount = db.prepare(`
      INSERT INTO model_api_accounts (
        id, api_alias, provider, website_url, login_account, login_password_encrypted,
        base_url, api_key_encrypted, default_model, usage_scene, upscale, quality, style,
        available_models_json, capabilities_json, discovery_verified,
        detection_status, detected_source, detected_at, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        api_alias = excluded.api_alias, provider = excluded.provider, website_url = excluded.website_url,
        login_account = excluded.login_account, login_password_encrypted = excluded.login_password_encrypted,
        base_url = excluded.base_url, api_key_encrypted = excluded.api_key_encrypted,
        default_model = excluded.default_model, usage_scene = excluded.usage_scene,
        upscale = excluded.upscale, quality = excluded.quality, style = excluded.style,
        available_models_json = excluded.available_models_json,
        capabilities_json = excluded.capabilities_json,
        discovery_verified = excluded.discovery_verified,
        detection_status = excluded.detection_status, detected_source = excluded.detected_source,
        detected_at = excluded.detected_at, is_default = excluded.is_default, updated_at = excluded.updated_at
    `);
    return upsertAccount;
  }

  function toStoredAccount(input = {}, existing = null) {
    const requestedId = normalizeText(input.id ?? input.accountId);
    const apiAlias = normalizeText(input.apiAlias ?? input.api_alias ?? existing?.api_alias);
    if (!apiAlias) throw new Error('Model API account alias is required.');
    const loginPasswordProvided = hasOwn(input, 'loginPassword') || hasOwn(input, 'login_password') || hasOwn(input, 'loginPasswordEncrypted');
    const apiKeyProvided = hasOwn(input, 'apiKey') || hasOwn(input, 'api_key') || hasOwn(input, 'apiKeyEncrypted');
    const requestedDefault = input.isDefault ?? input.is_default ?? existing?.is_default ?? false;
    const availableModelsProvided = hasOwn(input, 'availableModels') || hasOwn(input, 'available_models');
    const capabilitiesProvided = hasOwn(input, 'capabilities') || hasOwn(input, 'capabilities_json');
    const discoveryVerified = input.discoveryVerified
      ?? input.discovery_verified
      ?? existing?.discovery_verified
      ?? false;
    return {
      id: requestedId || `model_api_${randomUUID()}`,
      api_alias: apiAlias,
      provider: optionalText(input.provider ?? existing?.provider),
      website_url: optionalText(input.websiteUrl ?? input.website_url ?? existing?.website_url),
      login_account: optionalText(input.loginAccount ?? input.login_account ?? existing?.login_account),
      login_password_encrypted: loginPasswordProvided
        ? encryptOptionalSecret(input.loginPasswordEncrypted ?? input.loginPassword ?? input.login_password)
        : existing?.login_password_encrypted || null,
      base_url: optionalText(input.baseUrl ?? input.base_url ?? existing?.base_url),
      api_key_encrypted: apiKeyProvided
        ? encryptOptionalSecret(input.apiKeyEncrypted ?? input.apiKey ?? input.api_key)
        : existing?.api_key_encrypted || null,
      default_model: optionalText(input.defaultModel ?? input.default_model ?? existing?.default_model),
      usage_scene: optionalText(input.usageScene ?? input.usage_scene ?? existing?.usage_scene),
      upscale: optionalText(input.upscale ?? existing?.upscale),
      quality: optionalText(input.quality ?? existing?.quality),
      style: optionalText(input.style ?? existing?.style),
      available_models_json: availableModelsProvided
        ? JSON.stringify(normalizeModelOptions(input.availableModels ?? input.available_models))
        : existing?.available_models_json || null,
      capabilities_json: capabilitiesProvided
        ? JSON.stringify([...new Set((Array.isArray(input.capabilities) ? input.capabilities : [])
          .map(normalizeText)
          .filter(Boolean))].slice(0, 64))
        : existing?.capabilities_json || null,
      discovery_verified: discoveryVerified ? 1 : 0,
      detection_status: optionalText(input.detectionStatus ?? input.detection_status ?? existing?.detection_status),
      detected_source: optionalText(input.detectedSource ?? input.detected_source ?? existing?.detected_source),
      detected_at: optionalText(input.detectedAt ?? input.detected_at ?? existing?.detected_at),
      is_default: requestedDefault ? 1 : 0,
    };
  }

  function persistStoredAccount(account, existing, timestamp) {
    if (account.is_default) getClearDefaultAccountStatement().run();
    getUpsertAccountStatement().run(
      account.id, account.api_alias, account.provider, account.website_url, account.login_account,
      account.login_password_encrypted, account.base_url, account.api_key_encrypted, account.default_model,
      account.usage_scene, account.upscale, account.quality, account.style,
      account.available_models_json, account.capabilities_json, account.discovery_verified,
      account.detection_status,
      account.detected_source, account.detected_at, account.is_default, existing?.created_at || timestamp, timestamp,
    );
  }

  function listAccounts() {
    return db.prepare(`${selectSql} ORDER BY is_default DESC, updated_at DESC, api_alias ASC`).all().map(publicAccount);
  }

  function saveAccount(input = {}) {
    const requestedId = normalizeText(input.id ?? input.accountId);
    const existing = requestedId ? getRow(requestedId) : null;
    const account = toStoredAccount(input, existing);
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      persistStoredAccount(account, existing, timestamp);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { ok: true, created: !existing, account: publicAccount(getRow(account.id)) };
  }

  function deleteAccount(accountId) {
    const id = normalizeText(accountId);
    if (!id) throw new Error('Model API account id is required.');
    throw new Error('ACCOUNT_REMOVAL_LEGACY_PRIMITIVE_DISABLED');
  }

  function getCredentialsForInternalUse(accountId) {
    const row = getRow(accountId);
    if (!row) return null;
    return {
      accountId: row.id,
      loginAccount: row.login_account || null,
      loginPassword: decryptSecret(row.login_password_encrypted),
      apiKey: decryptSecret(row.api_key_encrypted),
      hasLoginPassword: Boolean(row.login_password_encrypted),
      hasApiKey: Boolean(row.api_key_encrypted),
    };
  }

  function getAccountForInternalUse(accountId) {
    const requestedId = normalizeText(accountId);
    const row = requestedId
      ? getRow(requestedId)
      : db.prepare(`${selectSql}
          WHERE api_key_encrypted IS NOT NULL
          ORDER BY is_default DESC, updated_at DESC LIMIT 1`).get() || null;
    if (!row) return null;
    return {
      ...publicAssetSafeAccount(row),
      loginPassword: decryptSecret(row.login_password_encrypted),
      apiKey: decryptSecret(row.api_key_encrypted),
    };
  }

  return {
    listAccounts,
    saveAccount,
    deleteAccount,
    getCredentialsForInternalUse,
    getAccountForInternalUse,
  };
}

function publicAssetSafeAccount(row = {}) {
  return {
    id: row.id,
    apiAlias: row.api_alias || '',
    provider: row.provider || '',
    baseUrl: row.base_url || '',
    defaultModel: row.default_model || '',
    quality: row.quality || '',
    style: row.style || '',
    upscale: row.upscale || '',
    availableModels: modelOptionsFromRow(row),
    capabilities: capabilitiesFromRow(row),
    discoveryVerified: Boolean(row.discovery_verified),
    detectionStatus: row.detection_status || '',
    detectedAt: row.detected_at || '',
  };
}
